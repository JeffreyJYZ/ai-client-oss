use std::fs;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Duration;
use tauri::Manager;

/// Settings live at the root of the app data dir; one file per conversation.
const SETTINGS_FILE: &str = "settings.json";
const CONVERSATIONS_DIR: &str = "conversations";

/// Whole-request deadline: a hung host must fail the fetch rather than
/// park the command — and the UI awaiting it — indefinitely.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// Page-size cap: a runaway endpoint must fail loudly instead of
/// buffering an unbounded response into app memory.
const MAX_RESPONSE_BYTES: usize = 10 * 1024 * 1024;

/// Sites 403 the default reqwest user agent, so send a desktop
/// browser's and be treated like a browser hit the page.
const USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36";

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

/// One shared client for every fetch: the connection pool and TLS
/// sessions are reused across calls, and `reqwest::Client` is designed
/// to be shared, not rebuilt per request.
static HTTP_CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();

fn http_client() -> Result<&'static reqwest::Client, String> {
    let slot = HTTP_CLIENT.get_or_init(|| {
        // The rustls-no-provider build has no crypto provider of its own;
        // install the ring one (already in the tree for the updater) as
        // the process default, as tauri-plugin-updater itself does.
        let _ = rustls::crypto::ring::default_provider().install_default();
        reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|e| format!("failed to build http client: {e}"))
    });
    slot.as_ref().map_err(|e| e.clone())
}

/// Fetch a page for the model, bypassing the browser's CORS limit: the
/// renderer cannot cross-origin read arbitrary sites, the Rust shell
/// can. Over [`MAX_RESPONSE_BYTES`] is an error, never a truncated page.
#[tauri::command]
async fn fetch_url(url: String) -> Result<String, String> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err(format!(
            "fetch_url: only http:// and https:// URLs are allowed: {url}"
        ));
    }
    let client = http_client()?;
    let mut response = client
        .get(url.as_str())
        .send()
        .await
        .map_err(|e| format!("failed to fetch {url}: {e}"))?;
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("failed to read response from {url}: {e}"))?
    {
        if body.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err(format!(
                "response from {url} exceeds the {MAX_RESPONSE_BYTES}-byte cap"
            ));
        }
        body.extend_from_slice(&chunk);
    }
    // Lossy, not an error: pages in a legacy encoding (GBK, Shift-JIS) are
    // reachable, and a page that is mostly readable beats no page at all.
    Ok(String::from_utf8_lossy(&body).into_owned())
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
            fetch_url,
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
