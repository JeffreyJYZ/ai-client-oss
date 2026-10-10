use std::fs;
use std::path::PathBuf;
use tauri::Manager;

/// Settings live at the root of the app data dir; one file per conversation.
const SETTINGS_FILE: &str = "settings.json";
const CONVERSATIONS_DIR: &str = "conversations";

/// Resolve (but do not create) the platform app data directory.
fn app_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("failed to resolve app data dir: {e}"))
}

/// Resolve the conversations directory, creating it if needed.
fn conversations_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app_data_dir(app)?.join(CONVERSATIONS_DIR);
    fs::create_dir_all(&dir).map_err(|e| format!("failed to create conversations dir: {e}"))?;
    Ok(dir)
}

#[tauri::command]
fn db_get_settings(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let path = app_data_dir(&app)?.join(SETTINGS_FILE);
    match fs::read_to_string(&path) {
        Ok(contents) => Ok(Some(contents)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("failed to read settings: {e}")),
    }
}

#[tauri::command]
fn db_set_settings(app: tauri::AppHandle, json: String) -> Result<(), String> {
    let dir = app_data_dir(&app)?;
    fs::create_dir_all(&dir).map_err(|e| format!("failed to create app data dir: {e}"))?;
    fs::write(dir.join(SETTINGS_FILE), json).map_err(|e| format!("failed to write settings: {e}"))
}

#[tauri::command]
fn db_list_conversations(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let dir = conversations_dir(&app)?;
    let entries =
        fs::read_dir(&dir).map_err(|e| format!("failed to read conversations dir: {e}"))?;
    let mut conversations = Vec::new();
    for entry in entries {
        let path = entry
            .map_err(|e| format!("failed to read dir entry: {e}"))?
            .path();
        if !path.is_file() || path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        let contents = fs::read_to_string(&path)
            .map_err(|e| format!("failed to read conversation: {e}"))?;
        conversations.push(contents);
    }
    Ok(conversations)
}

#[tauri::command]
fn db_get_conversation(app: tauri::AppHandle, id: String) -> Result<Option<String>, String> {
    let path = conversations_dir(&app)?.join(format!("{id}.json"));
    match fs::read_to_string(&path) {
        Ok(contents) => Ok(Some(contents)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("failed to read conversation: {e}")),
    }
}

#[tauri::command]
fn db_upsert_conversation(
    app: tauri::AppHandle,
    id: String,
    json: String,
) -> Result<(), String> {
    let path = conversations_dir(&app)?.join(format!("{id}.json"));
    fs::write(&path, json).map_err(|e| format!("failed to write conversation: {e}"))
}

#[tauri::command]
fn db_delete_conversation(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let path = conversations_dir(&app)?.join(format!("{id}.json"));
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("failed to delete conversation: {e}")),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            db_get_settings,
            db_set_settings,
            db_list_conversations,
            db_get_conversation,
            db_upsert_conversation,
            db_delete_conversation,
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
