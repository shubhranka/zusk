pub mod ai;
pub mod commands;
pub mod db;
pub mod error;
pub mod profiles;
pub mod secrets;
pub mod template;

use tauri::Manager;

use ai::AiStore;
use commands::AppState;
use profiles::ProfileStore;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            let profiles = ProfileStore::load(config_dir.join("connections.json"))?;
            let ai = AiStore::load(config_dir.join("llm.json"));
            app.manage(AppState::new(profiles, ai));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_connections,
            commands::save_connection,
            commands::delete_connection,
            commands::test_connection,
            commands::connect,
            commands::disconnect,
            commands::list_schemas,
            commands::list_schema_objects,
            commands::describe_table,
            commands::list_relations,
            commands::function_definition,
            commands::render_template,
            commands::run_query,
            commands::cancel_query,
            commands::get_read_only,
            commands::set_read_only,
            commands::get_ai_settings,
            commands::save_ai_settings,
            commands::test_ai,
            commands::fix_sql,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Zusk");
}
