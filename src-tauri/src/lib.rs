mod commands;

use commands::agent_commands::{
    agent_decide_approval, agent_detect_clis, agent_pending_approvals, agent_project_snapshot, agent_start,
    agent_stop, video_work_dir,
};
use commands::asset_commands::fetch_assets;
use commands::chatgpt_commands::{chatgpt_get_config, chatgpt_save_config, chatgpt_start, chatgpt_status, chatgpt_stop, open_external_url};
use commands::cutter_commands::{allow_media_preview, export_cut, transcribe_video};
use commands::ffmpeg_commands::combine_audio_video;
use commands::render_commands::{render_video, save_scenes_json};
use commands::settings_commands::{get_settings, save_settings};
use commands::tts_commands::generate_tts;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // Video projects live in the stable app-data workspace; allow previews of those files only.
            if let Ok(dir) = video_work_dir(app.handle()) {
                let _ = std::fs::create_dir_all(&dir);
                let _ = app.asset_protocol_scope().allow_directory(&dir, true);
            }
            commands::chatgpt_commands::autostart(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            generate_tts,
            fetch_assets,
            get_settings,
            save_settings,
            render_video,
            save_scenes_json,
            combine_audio_video,
            allow_media_preview,
            transcribe_video,
            export_cut,
            agent_detect_clis,
            agent_start,
            agent_stop,
            agent_pending_approvals,
            agent_decide_approval,
            agent_project_snapshot,
            chatgpt_get_config,
            chatgpt_save_config,
            chatgpt_status,
            chatgpt_start,
            chatgpt_stop,
            open_external_url,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                commands::chatgpt_commands::shutdown();
            }
        });
}
