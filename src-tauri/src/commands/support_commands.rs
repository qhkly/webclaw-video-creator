//! Customer-support ticket relay for the shared support widget (support.qhkly.com).
//!
//! The app never signs anything and never holds a signing key or client secret. At login
//! (`account_commands::complete_login`) auth.qhkly.com hands this public client a per-user,
//! revocable, *rotating* `support_grant` (`sg1_…`). Here it is traded at
//! `POST {auth}/api/support/ticket` for a ≤15-minute ES256 ticket that only the support Worker
//! (offline JWKS check) accepts. Contract: auth `docs/SUPPORT-TICKET.md`.
//!
//! Invariants:
//! - Serial: the whole load → request → persist runs under `account_commands::io_lock`, because a
//!   rotated-out grant that shows up again is treated by Auth as stolen and its family is revoked.
//! - The rotated grant is persisted *before* the ticket is returned.
//! - A 429 from Auth also carries the rotated grant; it is persisted too.
//! - A network failure is not an answer: the grant is kept (Auth may or may not have rotated it).
//! - The UI only receives `{ticket, uid, expiresAt}` or a structured `SupportError`; never the grant.
//!
//! Until Auth registers `video-creator` with `support: { app: "video-creator" }` and the support
//! Worker lists the tenant, Auth answers 403/404 and the UI shows "not available yet"
//! (see docs/support-widget.md for the cross-repo checklist).
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::{Mutex, OnceLock};
use tauri::AppHandle;

use super::account_commands::{auth_origin, http_client, io_lock, load, now_secs, save, AUTH_CLIENT_ID};

/// Tenant name registered on both Auth (`SUPPORT_APPS`) and the Worker (`products.js`).
pub const SUPPORT_APP: &str = "video-creator";
/// Reuse a cached ticket only while it has at least this long to live.
const TICKET_MIN_REMAINING_SECS: u64 = 60;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SupportTicket {
    pub ticket: String,
    pub uid: String,
    /// Unix seconds.
    pub expires_at: u64,
}

/// `code`: login_required | reauth_required | not_enabled | rate_limited | unavailable | rejected | storage_failed
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SupportError {
    pub code: &'static str,
    pub message: String,
    pub retry_after: Option<u64>,
}

fn err(code: &'static str, message: &str) -> SupportError {
    SupportError { code, message: message.to_string(), retry_after: None }
}

pub fn is_grant(value: &str) -> bool {
    value.starts_with("sg1_") && value.len() > 8 && value.len() <= 256 && value.bytes().all(|b| b.is_ascii_graphic())
}

/// Request body: only the grant and the pinned client/tenant. Never a uid, email or plan.
pub fn ticket_request_body(grant: &str) -> Value {
    json!({
        "client_id": AUTH_CLIENT_ID,
        "subject_token_type": "support_grant",
        "subject_token": grant,
        "app": SUPPORT_APP,
    })
}

/// Map an Auth error response to what the UI should do.
pub fn classify_error(status: u16, error: &str) -> (&'static str, bool) {
    // (code, grant_is_dead)
    match (status, error) {
        (401, "invalid_grant") => ("reauth_required", true),
        (403, _) | (404, "support_not_configured") | (401, "invalid_client") | (400, "app_mismatch") => ("not_enabled", false),
        (429, _) => ("rate_limited", false),
        (500..=599, _) => ("unavailable", false),
        _ => ("rejected", false),
    }
}

pub fn parse_ticket(body: &Value) -> Result<SupportTicket, SupportError> {
    let ticket = body.get("ticket").and_then(Value::as_str).unwrap_or_default();
    let uid = body.get("uid").and_then(Value::as_str).unwrap_or_default();
    let expires_at = body.get("expiresAt").and_then(Value::as_u64).unwrap_or_default();
    let app_ok = body.get("app").and_then(Value::as_str).is_none_or(|app| app == SUPPORT_APP);
    if ticket.split('.').count() != 3 || !uid.starts_with("u_") || expires_at == 0 || !app_ok {
        return Err(err("rejected", "客服服务返回的票据无效"));
    }
    Ok(SupportTicket { ticket: ticket.to_string(), uid: uid.to_string(), expires_at })
}

pub fn cache_usable(ticket: &SupportTicket, now: u64) -> bool {
    ticket.expires_at > now + TICKET_MIN_REMAINING_SECS
}

fn cache() -> &'static Mutex<Option<(String, SupportTicket)>> {
    static CACHE: OnceLock<Mutex<Option<(String, SupportTicket)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

pub fn clear_ticket_cache() {
    if let Ok(mut guard) = cache().lock() {
        *guard = None;
    }
}

fn cached_for(user_id: &str, now: u64) -> Option<SupportTicket> {
    let guard = cache().lock().ok()?;
    guard.as_ref().filter(|(id, ticket)| id == user_id && cache_usable(ticket, now)).map(|(_, ticket)| ticket.clone())
}

/// Best effort on logout: stop the grant family from being usable anywhere else.
pub fn revoke_in_background(grant: Option<String>) {
    let Some(grant) = grant.filter(|g| is_grant(g)) else {
        return;
    };
    tauri::async_runtime::spawn(async move {
        if let Ok(client) = http_client() {
            let _ = client
                .post(format!("{}/api/support/grant/revoke", auth_origin()))
                .json(&json!({ "client_id": AUTH_CLIENT_ID, "support_grant": grant }))
                .send()
                .await;
        }
    });
}

#[tauri::command]
pub async fn support_ticket(app: AppHandle) -> Result<SupportTicket, SupportError> {
    let _guard = io_lock().lock().await;
    let mut account = load(&app).await;
    let Some(user_id) = account.user.as_ref().map(|user| user.auth_user_id.clone()) else {
        return Err(err("login_required", "登录后才能联系客服"));
    };
    let now = now_secs();
    if let Some(ticket) = cached_for(&user_id, now) {
        return Ok(ticket);
    }
    let Some(grant) = account.support_grant.clone() else {
        // Signed in before the grant existed (or Auth had no registration at that login).
        return Err(err("reauth_required", "请重新登录一次以启用客服"));
    };

    let client = http_client().map_err(|message| SupportError { code: "unavailable", message, retry_after: None })?;
    let response = client
        .post(format!("{}/api/support/ticket", auth_origin()))
        .json(&ticket_request_body(&grant))
        .send()
        .await
        .map_err(|_| err("unavailable", "暂时无法连接客服服务"))?;
    let status = response.status().as_u16();
    let retry_after = response.headers().get("retry-after").and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<u64>().ok());
    let body: Value = response.json().await.unwrap_or(Value::Null);

    // Persist the rotated grant first, whatever the status (Auth also returns it on 429).
    let rotated = body.get("supportGrant").and_then(Value::as_str).filter(|g| is_grant(g)).map(str::to_string);
    let (code, dead) = if status == 200 {
        ("ok", false)
    } else {
        classify_error(status, body.get("error").and_then(Value::as_str).unwrap_or(""))
    };
    let mut changed = false;
    if let Some(next) = rotated {
        account.support_grant = Some(next);
        changed = true;
    } else if dead {
        account.support_grant = None;
        changed = true;
    }
    if changed && save(&app, &account).await.is_err() {
        return Err(err("storage_failed", "无法保存客服授权，请重试"));
    }
    if status != 200 {
        let mut error = err(code, "客服服务暂不可用");
        error.retry_after = retry_after;
        return Err(error);
    }
    let ticket = parse_ticket(&body)?;
    if let Ok(mut guard) = cache().lock() {
        *guard = Some((user_id, ticket.clone()));
    }
    Ok(ticket)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_carries_only_grant_and_pinned_identity() {
        let body = ticket_request_body("sg1_abcdefgh");
        let keys: Vec<_> = body.as_object().unwrap().keys().cloned().collect();
        for key in ["client_id", "subject_token_type", "subject_token", "app"] {
            assert!(keys.contains(&key.to_string()), "{key}");
        }
        assert_eq!(keys.len(), 4, "no identity, plan or credential fields: {keys:?}");
        assert_eq!(body["client_id"], "video-creator");
        assert_eq!(body["app"], "video-creator");
    }

    #[test]
    fn grant_shape() {
        assert!(is_grant("sg1_AbC-123_xyz"));
        for bad in ["", "sg1_", "abc", "sg2_abcdefgh", "sg1_a b c d e"] {
            assert!(!is_grant(bad), "{bad}");
        }
    }

    #[test]
    fn errors_are_classified_and_only_invalid_grant_kills_the_grant() {
        assert_eq!(classify_error(401, "invalid_grant"), ("reauth_required", true));
        assert_eq!(classify_error(403, "support_not_enabled"), ("not_enabled", false));
        assert_eq!(classify_error(404, "support_not_configured"), ("not_enabled", false));
        assert_eq!(classify_error(401, "invalid_client"), ("not_enabled", false));
        assert_eq!(classify_error(429, "rate_limited"), ("rate_limited", false));
        assert_eq!(classify_error(503, ""), ("unavailable", false));
        assert_eq!(classify_error(400, "invalid_request"), ("rejected", false));
    }

    #[test]
    fn ticket_response_is_validated() {
        let good = json!({"ticket":"a.b.c","uid":"u_AAAAAAAAAAAAAAAAAAAAAA","expiresAt":1800000600u64,"app":"video-creator"});
        assert_eq!(parse_ticket(&good).unwrap().uid, "u_AAAAAAAAAAAAAAAAAAAAAA");
        for bad in [
            json!({"ticket":"a.b","uid":"u_x","expiresAt":1}),
            json!({"ticket":"a.b.c","uid":"a_x","expiresAt":1}),
            json!({"ticket":"a.b.c","uid":"u_x","expiresAt":0}),
            json!({"ticket":"a.b.c","uid":"u_x","expiresAt":1,"app":"ccdub"}),
        ] {
            assert!(parse_ticket(&bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn cache_respects_user_and_remaining_life() {
        let t = SupportTicket { ticket: "a.b.c".into(), uid: "u_x".into(), expires_at: 1000 };
        assert!(cache_usable(&t, 900));
        assert!(!cache_usable(&t, 950));
        clear_ticket_cache();
        *cache().lock().unwrap() = Some(("usr_1".into(), t));
        assert!(cached_for("usr_1", 900).is_some());
        assert!(cached_for("usr_2", 900).is_none());
        clear_ticket_cache();
        assert!(cached_for("usr_1", 900).is_none());
    }
}
