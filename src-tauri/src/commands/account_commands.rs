//! Account & membership.
//!
//! Login is the unified auth.qhkly.com login as a *public client* (no secret can
//! live in a desktop app): authorize with PKCE S256, the browser redirects to a
//! loopback listener here, and the one-time code is exchanged for the user's
//! identity. Same contract as the Voice Master extension, with a loopback
//! redirect instead of chromiumapp.org.
//!
//! Membership comes from the Video Creator account service, never from
//! webclaw-store directly: the store only answers callers holding a
//! `BILLING_CLIENTS_*` secret, which must not ship in the app. The service turns
//! the short-lived (15 min) idToken into an app session and proxies
//! `/api/v1/membership?product=webclaw-video-creator`. Payment is entirely the
//! store's: the app only opens its checkout page.
//!
//! Storage: <app data dir>/account.json (0600, holds the app session token).
//! The UI only ever receives `AccountView` (no tokens).
//! Contract, registration TODOs and open product decisions: docs/account-membership.md.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, Runtime as TauriRuntime};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use super::chatgpt_commands::launch_browser;

// ---- Central config: every external endpoint and rule the app relies on. ----

const AUTH_ORIGIN: &str = "https://auth.qhkly.com";
/// TODO(register): needs `AUTH_CLIENTS_VIDEO_CREATOR` on auth.qhkly.com, a public
/// client with one exact redirect URI per loopback port (docs/account-membership.md).
const AUTH_CLIENT_ID: &str = "video-creator";
/// Auth matches redirect URIs exactly, so the ports are fixed and each one is
/// registered. Kept clear of AI Studio (18811-18830) and the launcher API (18791).
pub const LOOPBACK_PORTS: [u16; 3] = [18861, 18862, 18863];
const CALLBACK_PATH: &str = "/auth/callback";
const STORE_ORIGIN: &str = "https://store.qhkly.com";
/// The store's product slug (webclaw-store lib/payment-products.ts).
pub const PRODUCT_SLUG: &str = "webclaw-video-creator";
/// Plans sold by the store (webclaw-store VIDEO_CREATOR_PRICES). The early placeholder
/// plans (trial / yearly / lifetime) are retired; entitlements already granted on them
/// still count as membership.
pub const CHECKOUT_PLANS: [&str; 2] = ["pro-monthly", "pro-yearly"];
/// Account service (account-service/, planned at https://video-api.qhkly.com). Release
/// builds take its https base URL at compile time and only once it is actually live;
/// without it membership shows "not available" and nothing is gated.
const ACCOUNT_API_URL: Option<&str> = option_env!("VIDEO_CREATOR_ACCOUNT_API_URL");
/// How long a cached "member" answer survives when the service cannot be reached.
/// The store contract is fail closed with at most ~60 s reuse of a positive answer
/// (webclaw-store docs/billing-api.md); a longer offline grace is a product decision.
pub const OFFLINE_GRACE_SECS: u64 = 60;
const LOGIN_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// Focus events arrive in bursts; the store asks for positive answers to be cached ≤ 60 s.
const REFRESH_MIN_INTERVAL_SECS: u64 = 60;
const RENEW_BEFORE_SECS: u64 = 24 * 3600;
const HTTP_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_REQUEST_HEAD: usize = 8 * 1024;

pub const ACCOUNT_CHANGED_EVENT: &str = "account_changed";
/// The entitlement file lives this long; the background refresh rewrites it well before.
const ENTITLEMENT_FILE_TTL: Duration = Duration::from_secs(15 * 60);
const BACKGROUND_REFRESH: Duration = Duration::from_secs(5 * 60);

/// Debug builds may point at local servers; release builds are pinned, because
/// login and paid status hang off these URLs.
fn debug_override(name: &str) -> Option<String> {
    if !cfg!(debug_assertions) {
        return None;
    }
    std::env::var(name).ok().and_then(|value| clean_base_url(&value))
}

fn clean_base_url(value: &str) -> Option<String> {
    let value = value.trim().trim_end_matches('/');
    (!value.is_empty()).then(|| value.to_string())
}

fn auth_origin() -> String {
    debug_override("VIDEO_CREATOR_AUTH_ORIGIN").unwrap_or_else(|| AUTH_ORIGIN.to_string())
}

fn store_origin() -> String {
    debug_override("VIDEO_CREATOR_STORE_ORIGIN").unwrap_or_else(|| STORE_ORIGIN.to_string())
}

fn account_api_url() -> Option<String> {
    if let Some(url) = debug_override("VIDEO_CREATOR_ACCOUNT_API_URL") {
        return Some(url);
    }
    release_api_url(ACCOUNT_API_URL)
}

/// A plain-http service would carry the session token in clear text.
fn release_api_url(raw: Option<&str>) -> Option<String> {
    raw.and_then(clean_base_url).filter(|url| url.starts_with("https://"))
}

// ---- Data ----

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AccountUser {
    pub auth_user_id: String,
    pub email: Option<String>,
    pub name: Option<String>,
    pub image: Option<String>,
}

/// The store's `/api/v1/membership` answer, passed through by the account service.
/// Only `member` decides access; the rest is for display.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Membership {
    pub member: bool,
    pub known: bool,
    pub plan_slug: Option<String>,
    pub status: Option<String>,
    pub renewal: Option<String>,
    pub expires_at: Option<String>,
    pub current_period_end: Option<String>,
    /// Machine-readable member benefits (webclaw-store VIDEO_CREATOR_BENEFITS); null for non-members.
    pub benefits: Option<Value>,
}

/// What this install may do right now. Derived only from the store's machine-readable
/// `benefits` of an entitled membership; anything missing or malformed falls back to the
/// free value (fail closed). Applied by the export/render/agent commands and handed to the
/// Node side (sidecar args, entitlement file). Mirrors scripts/lib/plan.mjs.
///
/// Only what WebClaw pays for or premium output is a plan limit. Capabilities the user pays
/// for themselves (their own agent CLI / ChatGPT login and quota, their own API keys, this
/// machine) are not: AI Director, AI cleanup and ChatGPT-OAuth image generation are free.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlanLimits {
    /// Short side of the exported frame in pixels (the app's 720p / 1080p / 4K presets).
    pub max_export_height: u32,
    pub watermark: bool,
    /// Licensing only: shown in the UI, nothing technical depends on it.
    pub commercial_use: bool,
}

pub const FREE_LIMITS: PlanLimits = PlanLimits {
    max_export_height: 720,
    watermark: true,
    commercial_use: false,
};

const MIN_EXPORT_HEIGHT: u64 = 720;
const MAX_EXPORT_HEIGHT: u64 = 2160;

pub fn limits_for(entitled: bool, membership: Option<&Membership>) -> PlanLimits {
    if !entitled {
        return FREE_LIMITS;
    }
    let Some(benefits) = membership.and_then(|m| m.benefits.as_ref()).and_then(Value::as_object) else {
        return FREE_LIMITS;
    };
    let granted = |key: &str| benefits.get(key).and_then(Value::as_bool) == Some(true);
    PlanLimits {
        max_export_height: benefits
            .get("maxExportHeight")
            .and_then(Value::as_u64)
            .map(|height| height.clamp(MIN_EXPORT_HEIGHT, MAX_EXPORT_HEIGHT) as u32)
            .unwrap_or(FREE_LIMITS.max_export_height),
        watermark: !granted("watermarkFree"),
        commercial_use: granted("commercialUse"),
    }
}

/// Render presets and their short side. Unknown requests are treated as 1080p.
const RESOLUTION_PRESETS: [(&str, u32); 3] = [("720p", 720), ("1080p", 1080), ("4K", 2160)];

/// Highest preset that is ≤ both the request and the plan limit.
pub fn clamp_resolution(requested: &str, max_height: u32) -> &'static str {
    let want = RESOLUTION_PRESETS.iter().find(|(name, _)| *name == requested).map_or(1080, |(_, h)| *h);
    let limit = want.min(max_height);
    RESOLUTION_PRESETS.iter().rev().find(|(_, h)| *h <= limit).map_or("720p", |(name, _)| *name)
}

/// Sidecar arguments understood by scripts/render.mjs and scripts/cut-export.mjs.
pub fn limit_args(limits: &PlanLimits) -> Vec<String> {
    vec![
        "--maxHeight".to_string(),
        limits.max_export_height.to_string(),
        "--watermark".to_string(),
        if limits.watermark { "1" } else { "0" }.to_string(),
    ]
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppSession {
    token: String,
    /// Unix seconds.
    expires_at: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct StoredAccount {
    user: Option<AccountUser>,
    session: Option<AppSession>,
    membership: Option<Membership>,
    membership_checked_at: Option<u64>,
    signed_in_at: u64,
}

/// Where the membership answer currently comes from.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MembershipPhase {
    SignedOut,
    /// No account service configured in this build.
    Unconfigured,
    /// Signed in, but there is no valid app session (expired or never opened).
    SessionExpired,
    /// Loaded from disk, not re-checked since the app started.
    Cached,
    /// Confirmed by the service in this run.
    Fresh,
    /// Last check could not reach the service; the cached answer applies within the grace window.
    Offline,
    /// The service gave an unexpected answer; fail closed.
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountView {
    /// idle | pending | error
    login_status: &'static str,
    login_error: Option<String>,
    /// The authorize URL while a login is pending, for "the browser didn't open".
    login_url: Option<String>,
    user: Option<AccountUser>,
    membership: Option<Membership>,
    membership_checked_at: Option<u64>,
    phase: MembershipPhase,
    /// The single answer feature gates should use.
    entitled: bool,
    /// Plan limits derived from `entitled` + the store benefits; what the commands enforce.
    limits: PlanLimits,
    service_configured: bool,
    last_error: Option<String>,
    product_slug: &'static str,
    plans: Vec<&'static str>,
}

struct Runtime {
    login_status: &'static str,
    login_error: Option<String>,
    login_url: Option<String>,
    login_task: Option<tauri::async_runtime::JoinHandle<()>>,
    /// None until the first check of this run.
    phase: Option<MembershipPhase>,
    last_error: Option<String>,
    last_attempt_at: u64,
}

fn runtime() -> &'static Mutex<Runtime> {
    static RUNTIME: OnceLock<Mutex<Runtime>> = OnceLock::new();
    RUNTIME.get_or_init(|| {
        Mutex::new(Runtime {
            login_status: "idle",
            login_error: None,
            login_url: None,
            login_task: None,
            phase: None,
            last_error: None,
            last_attempt_at: 0,
        })
    })
}

fn with_runtime<T>(f: impl FnOnce(&mut Runtime) -> T) -> T {
    let mut guard = runtime().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    f(&mut guard)
}

/// Serializes every read-modify-write of account.json (login, refresh, logout).
fn io_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

// ---- Pure rules (unit-tested) ----

pub fn phase_for(user: bool, configured: bool, session: bool, checked: Option<MembershipPhase>) -> MembershipPhase {
    if !user {
        MembershipPhase::SignedOut
    } else if !configured {
        MembershipPhase::Unconfigured
    } else if !session {
        MembershipPhase::SessionExpired
    } else {
        checked.unwrap_or(MembershipPhase::Cached)
    }
}

/// A fresh answer is taken as is. A cached one only counts while it is younger
/// than the grace window. Everything else fails closed.
pub fn is_entitled(phase: MembershipPhase, membership: Option<&Membership>, checked_at: Option<u64>, now: u64) -> bool {
    let member = membership.is_some_and(|m| m.member);
    match phase {
        MembershipPhase::Fresh => member,
        MembershipPhase::Cached | MembershipPhase::Offline => {
            member && checked_at.is_some_and(|at| at <= now && now - at <= OFFLINE_GRACE_SECS)
        }
        _ => false,
    }
}

struct Pkce {
    verifier: String,
    challenge: String,
}

fn random_token(bytes: usize) -> Result<String, String> {
    let mut buf = vec![0u8; bytes];
    getrandom::getrandom(&mut buf).map_err(|error| format!("无法生成随机数: {error}"))?;
    Ok(URL_SAFE_NO_PAD.encode(buf))
}

fn pkce_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

impl Pkce {
    fn generate() -> Result<Self, String> {
        // 32 bytes → 43 base64url chars, the minimum auth accepts.
        let verifier = random_token(32)?;
        let challenge = pkce_challenge(&verifier);
        Ok(Self { verifier, challenge })
    }
}

fn redirect_uri(port: u16) -> String {
    format!("http://127.0.0.1:{port}{CALLBACK_PATH}")
}

fn authorize_url(origin: &str, redirect_uri: &str, state: &str, challenge: &str, lang: Option<&str>) -> String {
    let mut url = url::Url::parse(&format!("{origin}/api/auth/authorize")).expect("static auth origin is a valid URL");
    {
        let mut query = url.query_pairs_mut();
        query
            .append_pair("client_id", AUTH_CLIENT_ID)
            .append_pair("redirect_uri", redirect_uri)
            .append_pair("state", state)
            .append_pair("code_challenge", challenge)
            .append_pair("code_challenge_method", "S256")
            .append_pair("brand", AUTH_CLIENT_ID);
        if let Some(lang) = lang.filter(|value| !value.is_empty() && value.len() <= 16) {
            query.append_pair("lang", lang);
        }
    }
    url.into()
}

pub fn checkout_url(origin: &str, plan: &str) -> Option<String> {
    if !CHECKOUT_PLANS.contains(&plan) {
        return None;
    }
    let mut url = url::Url::parse(&format!("{origin}/checkout")).ok()?;
    url.query_pairs_mut().append_pair("product", PRODUCT_SLUG).append_pair("plan", plan);
    Some(url.into())
}

#[derive(Debug, PartialEq)]
enum Callback {
    Code(String),
    /// Auth sent the user back with an error for *this* login.
    Denied(String),
    /// Not our callback (wrong path, stale state, favicon…): answer and keep waiting.
    Ignore(u16),
}

/// Classify one HTTP request head received on the loopback port.
fn parse_callback(head: &str, expected_state: &str) -> Callback {
    let Some(line) = head.lines().next() else {
        return Callback::Ignore(400);
    };
    let mut parts = line.split(' ');
    let (Some("GET"), Some(target)) = (parts.next(), parts.next()) else {
        return Callback::Ignore(405);
    };
    let Ok(url) = url::Url::parse(&format!("http://127.0.0.1{target}")) else {
        return Callback::Ignore(400);
    };
    if url.path() != CALLBACK_PATH {
        return Callback::Ignore(404);
    }
    let param = |key: &str| url.query_pairs().find(|(k, _)| k == key).map(|(_, v)| v.into_owned());
    // A stale tab from an earlier attempt must not end the current one.
    if param("state").as_deref() != Some(expected_state) {
        return Callback::Ignore(400);
    }
    if let Some(error) = param("error") {
        return Callback::Denied(param("error_description").unwrap_or(error));
    }
    match param("code") {
        Some(code) if !code.is_empty() => Callback::Code(code),
        _ => Callback::Ignore(400),
    }
}

fn build_view(stored: &StoredAccount, rt: &Runtime, configured: bool, now: u64) -> AccountView {
    let phase = phase_for(stored.user.is_some(), configured, stored.session.is_some(), rt.phase);
    let entitled = is_entitled(phase, stored.membership.as_ref(), stored.membership_checked_at, now);
    AccountView {
        login_status: rt.login_status,
        login_error: rt.login_error.clone(),
        login_url: rt.login_url.clone(),
        user: stored.user.clone(),
        membership: stored.membership.clone(),
        membership_checked_at: stored.membership_checked_at,
        phase,
        entitled,
        limits: limits_for(entitled, stored.membership.as_ref()),
        service_configured: configured,
        last_error: rt.last_error.clone(),
        product_slug: PRODUCT_SLUG,
        plans: CHECKOUT_PLANS.to_vec(),
    }
}

// ---- Storage ----

fn account_path<R: TauriRuntime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("account.json"))
        .map_err(|error| format!("无法定位应用数据目录: {error}"))
}

async fn load<R: TauriRuntime>(app: &AppHandle<R>) -> StoredAccount {
    let Ok(path) = account_path(app) else {
        return StoredAccount::default();
    };
    match tokio::fs::read_to_string(&path).await {
        Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
        Err(_) => StoredAccount::default(),
    }
}

async fn save(app: &AppHandle, account: &StoredAccount) -> Result<(), String> {
    let path = account_path(app)?;
    if let Some(dir) = path.parent() {
        tokio::fs::create_dir_all(dir).await.map_err(|error| format!("无法创建数据目录: {error}"))?;
    }
    let text = serde_json::to_string_pretty(account).map_err(|error| error.to_string())?;
    let tmp = path.with_extension("json.tmp");
    tokio::fs::write(&tmp, text).await.map_err(|error| format!("无法保存登录状态: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = tokio::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600)).await;
    }
    tokio::fs::rename(&tmp, &path).await.map_err(|error| format!("无法保存登录状态: {error}"))
}

async fn current_view<R: TauriRuntime>(app: &AppHandle<R>) -> AccountView {
    let stored = load(app).await;
    let configured = account_api_url().is_some();
    with_runtime(|rt| build_view(&stored, rt, configured, now_secs()))
}

/// The limits commands must enforce, computed from local state only (never from the UI).
pub async fn current_limits<R: TauriRuntime>(app: &AppHandle<R>) -> PlanLimits {
    current_view(app).await.limits
}

async fn emit_changed(app: &AppHandle) -> AccountView {
    let view = current_view(app).await;
    write_entitlement_file(app, &view.limits).await;
    let _ = app.emit(ACCOUNT_CHANGED_EVENT, &view);
    view
}

/// <app config dir>/entitlement.json — read by the MCP servers (agent CLIs, ChatGPT bridge)
/// on every tool call via VIDEO_CREATOR_ENTITLEMENT_FILE. Outside the video workspace on
/// purpose: agents write in the workspace, not here.
pub fn entitlement_file_path<R: TauriRuntime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join("entitlement.json"))
        .map_err(|error| format!("无法定位应用配置目录: {error}"))
}

fn entitlement_document(limits: &PlanLimits, now_ms: u128) -> Value {
    json!({
        "version": 1,
        "limits": limits,
        "issuedAt": now_ms,
        "expiresAt": now_ms + ENTITLEMENT_FILE_TTL.as_millis(),
    })
}

async fn write_entitlement_file<R: TauriRuntime>(app: &AppHandle<R>, limits: &PlanLimits) {
    let Ok(path) = entitlement_file_path(app) else {
        return;
    };
    if let Some(dir) = path.parent() {
        let _ = tokio::fs::create_dir_all(dir).await;
    }
    let now_ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let tmp = path.with_extension("json.tmp");
    if tokio::fs::write(&tmp, entitlement_document(limits, now_ms).to_string()).await.is_ok() {
        let _ = tokio::fs::rename(&tmp, &path).await;
    }
}

/// At startup and every few minutes: re-check membership and rewrite the entitlement file,
/// so long-running MCP servers never act on a stale plan and a lapsed membership is noticed
/// even while the window is in the background.
pub fn start_background_sync(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        // The file left by the previous run must not outlive it.
        emit_changed(&app).await;
        loop {
            tokio::time::sleep(BACKGROUND_REFRESH).await;
            refresh_membership(&app, false).await;
            emit_changed(&app).await;
        }
    });
}

// ---- HTTP ----

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .user_agent(concat!("webclaw-video-creator/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| format!("无法初始化网络: {error}"))
}

#[derive(Debug)]
enum ApiError {
    /// 401: the app session is gone; the user has to sign in again.
    Unauthorized,
    /// Network failure, 429 or 5xx: keep the cached answer within the grace window.
    Unavailable(String),
    /// Anything else: fail closed.
    Rejected(String),
}

impl ApiError {
    fn message(&self) -> String {
        match self {
            ApiError::Unauthorized => "登录已过期，请重新登录".to_string(),
            ApiError::Unavailable(message) | ApiError::Rejected(message) => message.clone(),
        }
    }
}

async fn send_json(request: reqwest::RequestBuilder) -> Result<Value, ApiError> {
    let response = request
        .send()
        .await
        .map_err(|error| ApiError::Unavailable(format!("会员服务暂时无法连接: {error}")))?;
    let status = response.status();
    let body: Value = response.json().await.unwrap_or(Value::Null);
    if status.is_success() {
        return Ok(body);
    }
    let detail = body.get("error").and_then(Value::as_str).unwrap_or("").to_string();
    let message = format!("会员服务返回 {}{}", status.as_u16(), if detail.is_empty() { String::new() } else { format!("：{detail}") });
    Err(match status.as_u16() {
        401 => ApiError::Unauthorized,
        429 | 500..=599 => ApiError::Unavailable(message),
        _ => ApiError::Rejected(message),
    })
}

fn parse_session(body: &Value) -> Result<AppSession, ApiError> {
    let token = body.get("token").and_then(Value::as_str).unwrap_or_default();
    let expires_at = body.get("expiresAt").and_then(Value::as_u64).unwrap_or_default();
    if token.is_empty() || expires_at == 0 {
        return Err(ApiError::Rejected("会员服务返回的会话无效".to_string()));
    }
    Ok(AppSession { token: token.to_string(), expires_at })
}

fn parse_membership(body: &Value) -> Result<Membership, ApiError> {
    // `member` must be an explicit boolean; a shape we do not understand is not a yes.
    if !body.get("member").is_some_and(Value::is_boolean) {
        return Err(ApiError::Rejected("会员服务返回的会员信息无法识别".to_string()));
    }
    serde_json::from_value(body.clone()).map_err(|error| ApiError::Rejected(format!("会员信息无法解析: {error}")))
}

/// POST {api}/v1/session — trade the idToken for an app session (+ membership).
async fn open_session(client: &reqwest::Client, api: &str, id_token: &str) -> Result<(AppSession, Option<Membership>), ApiError> {
    let body = send_json(client.post(format!("{api}/v1/session")).json(&json!({ "idToken": id_token, "product": PRODUCT_SLUG }))).await?;
    let session = parse_session(&body)?;
    let membership = body.get("membership").map(parse_membership).transpose()?;
    Ok((session, membership))
}

async fn renew_session(client: &reqwest::Client, api: &str, token: &str) -> Result<AppSession, ApiError> {
    let body = send_json(client.post(format!("{api}/v1/session/renew")).bearer_auth(token)).await?;
    parse_session(&body)
}

/// `fresh` bypasses the service's short membership cache (manual refresh, after checkout).
async fn fetch_membership(client: &reqwest::Client, api: &str, token: &str, fresh: bool) -> Result<Membership, ApiError> {
    let fresh = if fresh { "&fresh=1" } else { "" };
    let body = send_json(
        client
            .get(format!("{api}/v1/membership?product={PRODUCT_SLUG}{fresh}"))
            .bearer_auth(token),
    )
    .await?;
    parse_membership(&body)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExchangeResponse {
    auth_user_id: String,
    email: Option<String>,
    name: Option<String>,
    image: Option<String>,
    id_token: Option<String>,
}

// ---- Login ----

async fn bind_loopback() -> Result<(TcpListener, u16), String> {
    for port in LOOPBACK_PORTS {
        if let Ok(listener) = TcpListener::bind(("127.0.0.1", port)).await {
            return Ok((listener, port));
        }
    }
    Err(format!(
        "本地登录回调端口 {}-{} 都被占用，请关闭占用程序后重试",
        LOOPBACK_PORTS[0],
        LOOPBACK_PORTS[LOOPBACK_PORTS.len() - 1]
    ))
}

async fn read_request_head(stream: &mut TcpStream) -> String {
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    let read = async {
        while buf.len() < MAX_REQUEST_HEAD && !buf.windows(4).any(|w| w == b"\r\n\r\n") {
            match stream.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(n) => buf.extend_from_slice(&chunk[..n]),
            }
        }
    };
    let _ = tokio::time::timeout(Duration::from_secs(5), read).await;
    String::from_utf8_lossy(&buf).into_owned()
}

fn result_page(ok: bool, detail: &str) -> String {
    let (title, body) = if ok {
        ("登录成功 · Signed in", "可以关闭此页面，回到 WebClaw Video Creator。<br>You can close this tab and return to the app.")
    } else {
        ("登录未完成 · Sign-in failed", "请回到 WebClaw Video Creator 重试。<br>Please return to the app and try again.")
    };
    let detail = detail.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>{title}</title></head>\
         <body style=\"font-family:system-ui,sans-serif;background:#0f1115;color:#e7e9ee;display:grid;place-items:center;height:100vh;margin:0\">\
         <div style=\"text-align:center;max-width:420px\"><h2>{title}</h2><p style=\"line-height:1.7;color:#a7adba\">{body}</p>\
         <p style=\"color:#f87171;font-size:13px\">{detail}</p></div></body></html>"
    )
}

async fn respond(stream: &mut TcpStream, status: u16, body: &str) {
    let reason = match status {
        200 => "OK",
        404 => "Not Found",
        405 => "Method Not Allowed",
        _ => "Bad Request",
    };
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
}

async fn wait_for_code(listener: TcpListener, state: &str) -> Result<String, String> {
    loop {
        let (mut stream, _) = listener.accept().await.map_err(|error| format!("登录回调失败: {error}"))?;
        let head = read_request_head(&mut stream).await;
        match parse_callback(&head, state) {
            Callback::Code(code) => {
                respond(&mut stream, 200, &result_page(true, "")).await;
                return Ok(code);
            }
            Callback::Denied(reason) => {
                respond(&mut stream, 200, &result_page(false, &reason)).await;
                return Err(format!("登录被取消或拒绝：{reason}"));
            }
            Callback::Ignore(status) => respond(&mut stream, status, "").await,
        }
    }
}

async fn complete_login(app: &AppHandle, code: &str, redirect_uri: &str, verifier: &str) -> Result<(), String> {
    let client = http_client()?;
    let exchange = client
        .post(format!("{}/api/auth/exchange", auth_origin()))
        .json(&json!({
            "code": code,
            "client_id": AUTH_CLIENT_ID,
            "redirect_uri": redirect_uri,
            "code_verifier": verifier,
        }));
    let body = send_json(exchange).await.map_err(|error| match error {
        ApiError::Unauthorized => "登录服务拒绝了本应用（client 未登记）".to_string(),
        other => other.message().replace("会员服务", "登录服务"),
    })?;
    let identity: ExchangeResponse = serde_json::from_value(body).map_err(|error| format!("登录服务返回的身份无法识别: {error}"))?;
    if identity.auth_user_id.is_empty() {
        return Err("登录服务返回的身份无效".to_string());
    }

    let now = now_secs();
    let mut account = StoredAccount {
        user: Some(AccountUser {
            auth_user_id: identity.auth_user_id,
            email: identity.email,
            name: identity.name,
            image: identity.image,
        }),
        signed_in_at: now,
        ..StoredAccount::default()
    };
    let mut phase = None;
    let mut last_error = None;
    if let Some(api) = account_api_url() {
        match identity.id_token.as_deref().filter(|token| !token.is_empty()) {
            None => last_error = Some("登录服务没有返回身份令牌，暂时无法查询会员".to_string()),
            Some(id_token) => match open_session(&client, &api, id_token).await {
                Ok((session, membership)) => {
                    account.session = Some(session);
                    if let Some(membership) = membership {
                        account.membership = Some(membership);
                        account.membership_checked_at = Some(now);
                        phase = Some(MembershipPhase::Fresh);
                    }
                }
                Err(error) => last_error = Some(error.message()),
            },
        }
    }

    let _guard = io_lock().lock().await;
    save(app, &account).await?;
    with_runtime(|rt| {
        rt.phase = phase;
        rt.last_error = last_error;
        rt.last_attempt_at = if phase.is_some() { now } else { 0 };
    });
    Ok(())
}

fn cancel_login_task() {
    let task = with_runtime(|rt| {
        rt.login_status = "idle";
        rt.login_error = None;
        rt.login_url = None;
        rt.login_task.take()
    });
    if let Some(task) = task {
        task.abort();
    }
}

#[tauri::command]
pub async fn account_get(app: AppHandle) -> Result<AccountView, String> {
    Ok(current_view(&app).await)
}

#[tauri::command]
pub async fn account_start_login(app: AppHandle, lang: Option<String>) -> Result<AccountView, String> {
    cancel_login_task();
    let (listener, port) = bind_loopback().await?;
    let pkce = Pkce::generate()?;
    let state = random_token(16)?;
    let redirect = redirect_uri(port);
    let url = authorize_url(&auth_origin(), &redirect, &state, &pkce.challenge, lang.as_deref());
    launch_browser(&url)?;

    let task_app = app.clone();
    let task = tauri::async_runtime::spawn(async move {
        let outcome = match tokio::time::timeout(LOGIN_TIMEOUT, wait_for_code(listener, &state)).await {
            Err(_) => Err("登录超时，请重试".to_string()),
            Ok(Err(error)) => Err(error),
            Ok(Ok(code)) => complete_login(&task_app, &code, &redirect, &pkce.verifier).await,
        };
        with_runtime(|rt| {
            rt.login_task = None;
            rt.login_url = None;
            match outcome {
                Ok(()) => {
                    rt.login_status = "idle";
                    rt.login_error = None;
                }
                Err(error) => {
                    rt.login_status = "error";
                    rt.login_error = Some(error);
                }
            }
        });
        emit_changed(&task_app).await;
    });
    with_runtime(|rt| {
        rt.login_status = "pending";
        rt.login_error = None;
        rt.login_url = Some(url);
        rt.login_task = Some(task);
    });
    Ok(emit_changed(&app).await)
}

#[tauri::command]
pub async fn account_cancel_login(app: AppHandle) -> Result<AccountView, String> {
    cancel_login_task();
    Ok(emit_changed(&app).await)
}

#[tauri::command]
pub async fn account_logout(app: AppHandle) -> Result<AccountView, String> {
    cancel_login_task();
    let session = {
        let _guard = io_lock().lock().await;
        let stored = load(&app).await;
        let path = account_path(&app)?;
        match tokio::fs::remove_file(&path).await {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("无法清除登录状态: {error}")),
        }
        stored.session
    };
    with_runtime(|rt| {
        rt.phase = None;
        rt.last_error = None;
        rt.last_attempt_at = 0;
    });
    // Best effort: the local session is already gone either way.
    if let (Some(api), Some(session)) = (account_api_url(), session) {
        tauri::async_runtime::spawn(async move {
            if let Ok(client) = http_client() {
                let _ = client.post(format!("{api}/v1/session/revoke")).bearer_auth(session.token).send().await;
            }
        });
    }
    Ok(emit_changed(&app).await)
}

/// Re-check membership. `force` skips the 60 s throttle (manual refresh, after checkout).
#[tauri::command]
pub async fn account_refresh(app: AppHandle, force: bool) -> Result<AccountView, String> {
    refresh_membership(&app, force).await;
    Ok(emit_changed(&app).await)
}

async fn refresh_membership(app: &AppHandle, force: bool) {
    let Some(api) = account_api_url() else {
        return;
    };
    let _guard = io_lock().lock().await;
    let mut account = load(app).await;
    let (Some(_), Some(mut session)) = (account.user.as_ref(), account.session.clone()) else {
        return;
    };
    let now = now_secs();
    let throttled = with_runtime(|rt| {
        let recent = now.saturating_sub(rt.last_attempt_at) < REFRESH_MIN_INTERVAL_SECS;
        if !(recent && !force) {
            rt.last_attempt_at = now;
        }
        recent && !force
    });
    if throttled {
        return;
    }

    let outcome = async {
        if session.expires_at <= now {
            return Err(ApiError::Unauthorized);
        }
        let client = http_client().map_err(ApiError::Unavailable)?;
        if session.expires_at - now < RENEW_BEFORE_SECS {
            match renew_session(&client, &api, &session.token).await {
                Ok(renewed) => session = renewed,
                Err(ApiError::Unauthorized) => return Err(ApiError::Unauthorized),
                // Renewal is an optimization; the current token is still valid.
                Err(_) => {}
            }
        }
        fetch_membership(&client, &api, &session.token, force).await
    }
    .await;

    let (phase, error) = match outcome {
        Ok(membership) => {
            account.session = Some(session);
            account.membership = Some(membership);
            account.membership_checked_at = Some(now);
            (MembershipPhase::Fresh, None)
        }
        Err(ApiError::Unauthorized) => {
            account.session = None;
            (MembershipPhase::SessionExpired, Some(ApiError::Unauthorized.message()))
        }
        Err(error @ ApiError::Unavailable(_)) => {
            account.session = Some(session);
            (MembershipPhase::Offline, Some(error.message()))
        }
        Err(error @ ApiError::Rejected(_)) => {
            account.session = Some(session);
            (MembershipPhase::Error, Some(error.message()))
        }
    };
    let saved = save(app, &account).await;
    with_runtime(|rt| {
        rt.phase = Some(phase);
        rt.last_error = error.or(saved.err());
    });
}

#[tauri::command]
pub async fn account_open_checkout(plan: String) -> Result<(), String> {
    let url = checkout_url(&store_origin(), &plan).ok_or_else(|| format!("不支持的套餐: {plan}"))?;
    launch_browser(&url)
}

/// The store's account page: orders, renewal, cancellation.
#[tauri::command]
pub async fn account_open_store_account() -> Result<(), String> {
    launch_browser(&format!("{}/account", store_origin()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn member(member: bool) -> Membership {
        Membership { member, known: true, plan_slug: Some("pro-yearly".into()), ..Membership::default() }
    }

    #[test]
    fn pkce_matches_rfc7636_vector() {
        assert_eq!(pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
        let pkce = Pkce::generate().unwrap();
        // auth.qhkly.com: verifier /^[A-Za-z0-9._~-]{43,128}$/, challenge /^[A-Za-z0-9_-]{43}$/
        assert_eq!(pkce.verifier.len(), 43);
        assert_eq!(pkce.challenge.len(), 43);
        assert!(pkce.verifier.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'));
    }

    #[test]
    fn authorize_url_carries_pkce_and_exact_redirect() {
        let url = authorize_url(AUTH_ORIGIN, &redirect_uri(18861), "st", "ch", Some("zh-CN"));
        let parsed = url::Url::parse(&url).unwrap();
        assert_eq!(parsed.host_str(), Some("auth.qhkly.com"));
        assert_eq!(parsed.path(), "/api/auth/authorize");
        let q: std::collections::HashMap<_, _> = parsed.query_pairs().into_owned().collect();
        assert_eq!(q["client_id"], "video-creator");
        assert_eq!(q["redirect_uri"], "http://127.0.0.1:18861/auth/callback");
        assert_eq!(q["state"], "st");
        assert_eq!(q["code_challenge"], "ch");
        assert_eq!(q["code_challenge_method"], "S256");
        assert_eq!(q["lang"], "zh-CN");
    }

    #[test]
    fn checkout_url_only_for_offered_plans() {
        assert_eq!(
            checkout_url(STORE_ORIGIN, "pro-yearly").as_deref(),
            Some("https://store.qhkly.com/checkout?product=webclaw-video-creator&plan=pro-yearly")
        );
        assert!(checkout_url(STORE_ORIGIN, "pro-monthly").is_some());
        // Retired placeholder plans are no longer sold.
        for plan in ["trial", "yearly", "lifetime", "", "pro-yearly&product=other", "../admin"] {
            assert_eq!(checkout_url(STORE_ORIGIN, plan), None, "{plan}");
        }
    }

    #[test]
    fn callback_parsing() {
        let get = |target: &str| format!("GET {target} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
        assert_eq!(parse_callback(&get("/auth/callback?code=abc&state=s1"), "s1"), Callback::Code("abc".into()));
        assert_eq!(parse_callback(&get("/auth/callback?code=abc&state=other"), "s1"), Callback::Ignore(400));
        assert_eq!(parse_callback(&get("/auth/callback?code=abc"), "s1"), Callback::Ignore(400));
        assert_eq!(parse_callback(&get("/favicon.ico"), "s1"), Callback::Ignore(404));
        assert_eq!(parse_callback(&get("/auth/callback?state=s1"), "s1"), Callback::Ignore(400));
        assert_eq!(
            parse_callback(&get("/auth/callback?state=s1&error=access_denied"), "s1"),
            Callback::Denied("access_denied".into())
        );
        // Someone else's error with a wrong state must not abort our login.
        assert_eq!(parse_callback(&get("/auth/callback?state=x&error=access_denied"), "s1"), Callback::Ignore(400));
        assert_eq!(parse_callback("POST /auth/callback?code=a&state=s1 HTTP/1.1\r\n\r\n", "s1"), Callback::Ignore(405));
        assert_eq!(parse_callback("", "s1"), Callback::Ignore(400));
    }

    #[test]
    fn phase_rules() {
        use MembershipPhase::*;
        assert_eq!(phase_for(false, true, true, Some(Fresh)), SignedOut);
        assert_eq!(phase_for(true, false, true, Some(Fresh)), Unconfigured);
        assert_eq!(phase_for(true, true, false, Some(Fresh)), SessionExpired);
        assert_eq!(phase_for(true, true, true, None), Cached);
        assert_eq!(phase_for(true, true, true, Some(Offline)), Offline);
    }

    #[test]
    fn entitlement_fails_closed() {
        use MembershipPhase::*;
        let now = 1_000_000;
        let yes = member(true);
        let no = member(false);
        assert!(is_entitled(Fresh, Some(&yes), Some(now), now));
        assert!(!is_entitled(Fresh, Some(&no), Some(now), now));
        assert!(!is_entitled(Fresh, None, None, now));
        // Cached / offline: only within the grace window.
        assert!(is_entitled(Cached, Some(&yes), Some(now - OFFLINE_GRACE_SECS), now));
        assert!(!is_entitled(Offline, Some(&yes), Some(now - OFFLINE_GRACE_SECS - 1), now));
        assert!(!is_entitled(Offline, Some(&yes), None, now));
        // A clock set back must not stretch the window.
        assert!(!is_entitled(Cached, Some(&yes), Some(now + 10), now));
        for phase in [SignedOut, Unconfigured, SessionExpired, Error] {
            assert!(!is_entitled(phase, Some(&yes), Some(now), now), "{phase:?}");
        }
    }

    #[test]
    fn membership_parsing_requires_explicit_member() {
        let body = json!({"productSlug": PRODUCT_SLUG, "member": true, "known": true, "planSlug": "pro-yearly",
            "status": "active", "renewal": "auto", "expiresAt": "2027-10-06T00:00:00.000Z",
            "benefits": {"aiDirector": true, "maxExportHeight": 2160}});
        let parsed = parse_membership(&body).unwrap();
        assert!(parsed.member);
        assert_eq!(parsed.plan_slug.as_deref(), Some("pro-yearly"));
        assert_eq!(parsed.benefits.as_ref().and_then(|b| b["maxExportHeight"].as_u64()), Some(2160));
        assert!(parse_membership(&json!({"member": "true"})).is_err());
        assert!(parse_membership(&json!({"active": true})).is_err());
        assert!(parse_session(&json!({"token": "t", "expiresAt": 0})).is_err());
        assert_eq!(parse_session(&json!({"token": "t", "expiresAt": 5})).unwrap().expires_at, 5);
    }

    #[test]
    fn view_never_contains_tokens() {
        let stored = StoredAccount {
            user: Some(AccountUser { auth_user_id: "usr_1".into(), ..AccountUser::default() }),
            session: Some(AppSession { token: "secret-session-token".into(), expires_at: u64::MAX }),
            membership: Some(member(true)),
            membership_checked_at: Some(100),
            signed_in_at: 1,
        };
        let rt = Runtime {
            login_status: "idle",
            login_error: None,
            login_url: None,
            login_task: None,
            phase: Some(MembershipPhase::Fresh),
            last_error: None,
            last_attempt_at: 0,
        };
        let view = build_view(&stored, &rt, true, 100);
        assert!(view.entitled);
        // Entitled but these test benefits are empty: limits stay free.
        assert_eq!(view.limits, FREE_LIMITS);
        let text = serde_json::to_string(&view).unwrap();
        assert!(!text.contains("secret-session-token"));
        assert!(text.contains("\"phase\":\"fresh\""));
    }

    fn with_benefits(benefits: Value) -> Membership {
        Membership { benefits: Some(benefits), ..member(true) }
    }

    #[test]
    fn limits_follow_store_benefits_and_fail_closed() {
        let pro = with_benefits(json!({"watermarkFree": true, "maxExportHeight": 2160, "aiDirector": true,
            "aiCutCleanup": true, "commercialUse": true}));
        assert_eq!(
            limits_for(true, Some(&pro)),
            PlanLimits { max_export_height: 2160, watermark: false, commercial_use: true }
        );
        // Not entitled: free, whatever the cached benefits say.
        assert_eq!(limits_for(false, Some(&pro)), FREE_LIMITS);
        // Entitled but no / unreadable benefits: free.
        assert_eq!(limits_for(true, Some(&member(true))), FREE_LIMITS);
        assert_eq!(limits_for(true, Some(&with_benefits(json!("pro")))), FREE_LIMITS);
        assert_eq!(limits_for(true, None), FREE_LIMITS);
        // Field by field: wrong types are "not granted".
        let odd = limits_for(true, Some(&with_benefits(json!({"watermarkFree": "true", "maxExportHeight": "2160", "aiDirector": 1}))));
        assert_eq!(odd, FREE_LIMITS);
        // Height is clamped into [720, 2160]; a member is never below the free plan.
        assert_eq!(limits_for(true, Some(&with_benefits(json!({"maxExportHeight": 1080})))).max_export_height, 1080);
        assert_eq!(limits_for(true, Some(&with_benefits(json!({"maxExportHeight": 99999})))).max_export_height, 2160);
        assert_eq!(limits_for(true, Some(&with_benefits(json!({"maxExportHeight": 100})))).max_export_height, 720);
        assert_eq!(limits_for(true, Some(&with_benefits(json!({"maxExportHeight": -1})))).max_export_height, 720);
    }

    #[test]
    fn resolution_is_clamped_to_the_plan() {
        assert_eq!(clamp_resolution("4K", 720), "720p");
        assert_eq!(clamp_resolution("1080p", 720), "720p");
        assert_eq!(clamp_resolution("720p", 720), "720p");
        assert_eq!(clamp_resolution("4K", 1080), "1080p");
        assert_eq!(clamp_resolution("4K", 2160), "4K");
        assert_eq!(clamp_resolution("1080p", 2160), "1080p");
        assert_eq!(clamp_resolution("8K; rm -rf", 2160), "1080p");
        assert_eq!(clamp_resolution("", 720), "720p");
        assert_eq!(limit_args(&FREE_LIMITS), ["--maxHeight", "720", "--watermark", "1"]);
    }

    #[test]
    fn entitlement_document_matches_the_node_reader() {
        let doc = entitlement_document(&FREE_LIMITS, 1_000);
        assert_eq!(doc["version"], 1);
        assert_eq!(doc["expiresAt"], 1_000 + ENTITLEMENT_FILE_TTL.as_millis() as u64);
        assert_eq!(doc["limits"], json!({"maxExportHeight": 720, "watermark": true, "commercialUse": false}));
    }

    #[test]
    fn release_service_url_must_be_https() {
        assert_eq!(clean_base_url(" https://x.example/ ").as_deref(), Some("https://x.example"));
        assert_eq!(clean_base_url("   "), None);
        assert_eq!(release_api_url(Some("https://api.example/")).as_deref(), Some("https://api.example"));
        assert_eq!(release_api_url(Some("http://api.example")), None);
        assert_eq!(release_api_url(Some("")), None);
        assert_eq!(release_api_url(None), None);
    }

    async fn send(port: u16, request: &str) -> String {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).await.unwrap();
        response
    }

    #[tokio::test]
    async fn loopback_ignores_strays_and_returns_the_code() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let waiter = tokio::spawn(async move { wait_for_code(listener, "s1").await });

        assert!(send(port, "GET /favicon.ico HTTP/1.1\r\n\r\n").await.starts_with("HTTP/1.1 404"));
        assert!(send(port, "GET /auth/callback?code=old&state=stale HTTP/1.1\r\n\r\n").await.starts_with("HTTP/1.1 400"));
        let ok = send(port, "GET /auth/callback?code=c-1&state=s1 HTTP/1.1\r\nHost: x\r\n\r\n").await;
        assert!(ok.starts_with("HTTP/1.1 200"));
        assert!(ok.contains("Signed in"));

        let code = tokio::time::timeout(Duration::from_secs(5), waiter).await.unwrap().unwrap();
        assert_eq!(code.as_deref(), Ok("c-1"));
    }

    #[tokio::test]
    async fn loopback_reports_denial() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let waiter = tokio::spawn(async move { wait_for_code(listener, "s1").await });
        let page = send(port, "GET /auth/callback?state=s1&error=access_denied&error_description=%3Cb%3Eno%3C%2Fb%3E HTTP/1.1\r\n\r\n").await;
        // The reason is shown escaped, never as markup.
        assert!(page.contains("&lt;b&gt;no&lt;/b&gt;"));
        let result = waiter.await.unwrap();
        assert!(result.unwrap_err().contains("<b>no</b>"));
    }
}
