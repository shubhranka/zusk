pub mod commands;
pub mod db;
pub mod error;
pub mod profiles;
pub mod secrets;

use tauri::Manager;

use commands::AppState;
use profiles::ProfileStore;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            let profiles = ProfileStore::load(config_dir.join("connections.json"))?;
            app.manage(AppState::new(profiles));
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
            commands::run_query,
            commands::cancel_query,
            commands::get_read_only,
            commands::set_read_only,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Zusk");
}
