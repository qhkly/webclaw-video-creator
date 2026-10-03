mod commands;

use commands::asset_commands::fetch_assets;
use commands::cutter_commands::{allow_media_preview, export_cut, transcribe_video};
use commands::ffmpeg_commands::combine_audio_video;
use commands::render_commands::{render_video, save_scenes_json};
use commands::settings_commands::{get_settings, save_settings};
use commands::tts_commands::generate_tts;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
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
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, _event| {});
}
