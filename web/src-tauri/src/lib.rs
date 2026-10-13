use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;
use tauri::Manager;

/// Settings live at the root of the app data dir; one file per conversation.
const SETTINGS_FILE: &str = "settings.json";
const CONVERSATIONS_DIR: &str = "conversations";

/// Installed plugin source: `<app data>/plugins/<id>/plugin.json` plus assets.
const PLUGINS_DIR: &str = "plugins";

/// Per-plugin scoped data: `<app data>/plugin-data/<id>/` (spec §7).
const PLUGIN_DATA_DIR: &str = "plugin-data";

/// Whole-request deadline: a hung host must fail the fetch rather than
/// park the command — and the UI awaiting it — indefinitely.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// Whole-request deadline for the third-party API pass-through: that
/// API documents a 110-second per-URL backend timeout and tells
/// clients to allow 150, so the page-fetch command's 30 seconds
/// does not fit here.
const API_REQUEST_TIMEOUT: Duration = Duration::from_secs(150);

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

/// The one scope helper the plugin commands share (spec §7). Resolve
/// `root/rel_path` so that the result can only ever be inside `root`:
///
/// 1. `root` is created on demand and canonicalized, so symlinks in the app
///    data path itself are resolved once. **A read through this helper
///    therefore creates `root`**: `plugin_fs_read`/`plugin_fs_list` on an
///    unknown id leave an empty `plugin-data/<id>/` behind. That is harmless —
///    it is only ever the plugin's own scope directory, never anything outside
///    it;
/// 2. an absolute `rel_path` is refused — `Path::join` would discard `root`;
/// 3. the deepest **existing** ancestor of the join is canonicalized and must
///    be under the canonical root, so a symlink anywhere along the path is
///    resolved *before* the check (a plain prefix test on the un-canonicalized
///    join would let `link -> /etc` through);
/// 4. the non-existent suffix is re-appended to that canonical ancestor. Each
///    such component is `symlink_metadata`-checked and refused if it is a
///    symlink: a **dangling** symlink (target not yet created) makes
///    `canonicalize` return `NotFound`, so without this check the walk treats
///    it as a plain absent name and returns the symlink itself, which
///    `fs::write` then follows out of `root`. So the suffix is safe because no
///    component of it is a symlink, not merely because it does not exist.
///
/// A `rel_path` that normalises to `root` itself (`""`, `"."`, `"subdir/.."`
/// with `subdir` present) resolves to the root, so `plugin_fs_delete` on one
/// clears the plugin's own scoped directory — inside the contract, which is
/// "at or below `root`", and it names only the plugin's own data.
///
/// `Path::starts_with` is component-wise, so `…/x` is not a prefix of `…/xy`.
fn resolve_within(root: &Path, rel_path: &str) -> Result<PathBuf, String> {
    fs::create_dir_all(root)
        .map_err(|e| format!("failed to create {}: {e}", root.display()))?;
    let root = fs::canonicalize(root)
        .map_err(|e| format!("failed to canonicalize {}: {e}", root.display()))?;

    let rel = Path::new(rel_path);
    if rel.is_absolute() {
        return Err(format!(
            "{} must be a relative path inside the plugin directory",
            rel_path
        ));
    }

    // Walk up from the join until an ancestor exists, canonicalizing it. Any
    // symlink on the way is resolved by `canonicalize` before the check, so a
    // link pointing outside `root` is refused rather than followed.
    let mut current = root.join(rel);
    let mut suffix: Vec<std::ffi::OsString> = Vec::new();
    loop {
        match fs::canonicalize(&current) {
            Ok(resolved) => {
                if !resolved.starts_with(&root) {
                    return Err(format!(
                        "path escapes the plugin directory: {rel_path}"
                    ));
                }
                let mut path = resolved;
                for part in suffix.iter().rev() {
                    path.push(part);
                }
                return Ok(path);
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                // `NotFound` does not mean "not a symlink": a dangling symlink
                // reports it too. Refuse any symlink here, so the re-appended
                // suffix cannot carry one out of the root.
                if fs::symlink_metadata(&current)
                    .map(|meta| meta.file_type().is_symlink())
                    .unwrap_or(false)
                {
                    return Err(format!(
                        "path escapes the plugin directory: {rel_path}"
                    ));
                }
                let name = current.file_name().ok_or_else(|| {
                    format!("cannot resolve a parent of {rel_path}")
                })?;
                suffix.push(name.to_os_string());
                current = current
                    .parent()
                    .ok_or_else(|| format!("cannot resolve a parent of {rel_path}"))?
                    .to_path_buf();
            }
            Err(e) => {
                return Err(format!("failed to resolve {rel_path}: {e}"));
            }
        }
    }
}

/// A plugin id is one plain path component. **Allowlist**, not a denylist:
/// only ASCII letters, digits, `.`, `_` and `-`, and no leading or trailing
/// `.`. A denylist of `/`, `\`, `.` and `..` misses a Windows **drive prefix**
/// — `PathBuf::join` clears the base entirely when the pushed path has a
/// prefix but no root, so `id = "C:"` would make {@link plugin_root} return a
/// drive-relative path resolving to the process cwd.
///
/// **The same rule is enforced at install time by `manifestSchema.id` in
/// `web/src/lib/plugins/manifest.ts`; keep the two in step** (that one fails a
/// bad id with a readable decode error before it ever reaches here).
fn safe_id(id: &str) -> Result<&str, String> {
    let allowed = |c: char| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-';
    let ok = !id.is_empty()
        && !id.starts_with('.')
        && !id.ends_with('.')
        && id.chars().all(allowed);
    if ok {
        Ok(id)
    } else {
        Err(format!(
            "invalid plugin id {id:?}: use only letters, digits, '.', '_' and '-', with no leading or trailing '.'"
        ))
    }
}

/// `<app data>/<base>/<id>` for a validated plugin id.
fn plugin_root(app: &tauri::AppHandle, base: &str, id: &str) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join(base).join(safe_id(id)?))
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

/* ------------------------------------------------------------------ plugins */

/// Scan `<app data>/plugins/` and return each `plugin.json` **verbatim** (spec
/// §7), so an invalid manifest reaches the UI with its reason instead of
/// vanishing here. A directory with no readable manifest is skipped.
#[tauri::command]
fn plugin_list(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let dir = app_data_dir(&app)?.join(PLUGINS_DIR);
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let entries = fs::read_dir(&dir).map_err(|e| format!("failed to read plugins dir: {e}"))?;
    let mut manifests = Vec::new();
    for entry in entries {
        let path = entry
            .map_err(|e| format!("failed to read dir entry: {e}"))?
            .path();
        if !path.is_dir() {
            continue;
        }
        match fs::read_to_string(path.join("plugin.json")) {
            Ok(text) => manifests.push(text),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(format!("failed to read a plugin manifest: {e}")),
        }
    }
    Ok(manifests)
}

/// Read a file inside one plugin's source directory (spec §7).
#[tauri::command]
fn plugin_read_file(
    app: tauri::AppHandle,
    id: String,
    rel_path: String,
) -> Result<String, String> {
    let path = resolve_within(&plugin_root(&app, PLUGINS_DIR, &id)?, &rel_path)?;
    fs::read_to_string(&path).map_err(|e| format!("failed to read plugin file: {e}"))
}

/// Write a file inside one plugin's source directory (install/update, spec §7).
#[tauri::command]
fn plugin_write_file(
    app: tauri::AppHandle,
    id: String,
    rel_path: String,
    contents: String,
) -> Result<(), String> {
    let path = resolve_within(&plugin_root(&app, PLUGINS_DIR, &id)?, &rel_path)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("failed to create plugin dir: {e}"))?;
    }
    fs::write(&path, contents).map_err(|e| format!("failed to write plugin file: {e}"))
}

/// Delete one plugin's source directory (spec §7).
#[tauri::command]
fn plugin_remove(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let dir = plugin_root(&app, PLUGINS_DIR, &id)?;
    match fs::remove_dir_all(&dir) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("failed to remove plugin: {e}")),
    }
}

/// Absolute path of the plugin's scoped data directory, created on demand.
#[tauri::command]
fn plugin_data_dir(app: tauri::AppHandle, id: String) -> Result<String, String> {
    let root = plugin_root(&app, PLUGIN_DATA_DIR, &id)?;
    fs::create_dir_all(&root).map_err(|e| format!("failed to create plugin data dir: {e}"))?;
    fs::canonicalize(&root)
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|e| format!("failed to resolve plugin data dir: {e}"))
}

/// Read a file inside the plugin's scoped data directory (spec §7).
#[tauri::command]
fn plugin_fs_read(
    app: tauri::AppHandle,
    id: String,
    rel_path: String,
) -> Result<String, String> {
    let path = resolve_within(&plugin_root(&app, PLUGIN_DATA_DIR, &id)?, &rel_path)?;
    fs::read_to_string(&path).map_err(|e| format!("failed to read plugin data file: {e}"))
}

/// Write a file inside the plugin's scoped data directory (spec §7).
#[tauri::command]
fn plugin_fs_write(
    app: tauri::AppHandle,
    id: String,
    rel_path: String,
    contents: String,
) -> Result<(), String> {
    let path = resolve_within(&plugin_root(&app, PLUGIN_DATA_DIR, &id)?, &rel_path)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("failed to create plugin data dir: {e}"))?;
    }
    fs::write(&path, contents).map_err(|e| format!("failed to write plugin data file: {e}"))
}

/// List the names inside the plugin's scoped data directory, or one of its
/// subdirectories (spec §7).
#[tauri::command]
fn plugin_fs_list(
    app: tauri::AppHandle,
    id: String,
    rel_path: String,
) -> Result<Vec<String>, String> {
    let dir = resolve_within(&plugin_root(&app, PLUGIN_DATA_DIR, &id)?, &rel_path)?;
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("failed to read plugin data dir: {e}")),
    };
    let mut names = Vec::new();
    for entry in entries {
        names.push(
            entry
                .map_err(|e| format!("failed to read dir entry: {e}"))?
                .file_name()
                .to_string_lossy()
                .into_owned(),
        );
    }
    Ok(names)
}

/// Delete a file or directory inside the plugin's scoped data directory (spec
/// §7). A missing target is not an error, so a delete is idempotent.
#[tauri::command]
fn plugin_fs_delete(app: tauri::AppHandle, id: String, rel_path: String) -> Result<(), String> {
    let path = resolve_within(&plugin_root(&app, PLUGIN_DATA_DIR, &id)?, &rel_path)?;
    let removed = if path.is_dir() {
        fs::remove_dir_all(&path)
    } else {
        fs::remove_file(&path)
    };
    match removed {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("failed to delete plugin data: {e}")),
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

/// Forward one HTTP request to a third-party API, bypassing the
/// browser's CORS limit the way [`fetch_url`] bypasses it for pages.
/// The caller's headers ride along verbatim — the API authenticates
/// with an `X-API-Key` header — and the body is sent only when the
/// caller supplied one.
#[tauri::command]
async fn http_request(
    method: String,
    url: String,
    headers: std::collections::HashMap<String, String>,
    body: Option<String>,
) -> Result<String, String> {
    let method = method.to_ascii_uppercase();
    if method != "GET" && method != "POST" {
        return Err(format!(
            "http_request: only GET and POST methods are allowed: {method}"
        ));
    }
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err(format!(
            "http_request: only http:// and https:// URLs are allowed: {url}"
        ));
    }
    let client = http_client()?;
    let mut request = match method.as_str() {
        "GET" => client.get(url.as_str()),
        _ => client.post(url.as_str()),
    };
    // The shared client carries the 30-second page-fetch deadline;
    // this API's own, longer deadline replaces it for this request.
    request = request.timeout(API_REQUEST_TIMEOUT);
    for (name, value) in &headers {
        request = request.header(name.as_str(), value.as_str());
    }
    if let Some(body) = body {
        request = request.body(body);
        // Set a JSON content type only when the caller did not.
        if !headers
            .keys()
            .any(|name| name.eq_ignore_ascii_case("content-type"))
        {
            request = request.header("content-type", "application/json");
        }
    }
    let mut response = request
        .send()
        .await
        .map_err(|e| format!("failed to send {method} {url}: {e}"))?;
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
    // Lossy, not an error: a response that is mostly readable beats
    // no response at all.
    Ok(String::from_utf8_lossy(&body).into_owned())
}

#[cfg(test)]
mod scope_tests {
    use super::{resolve_within, safe_id};
    use std::fs;
    use std::path::PathBuf;

    /// A fresh temp root per test — no new dependency, so no `tempfile`.
    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "ai-client-plugin-scope-{}-{tag}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create temp root");
        dir
    }

    fn cleanup(root: &PathBuf) {
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn allows_a_nested_path_inside_the_root() {
        let root = temp_root("nested");
        let resolved = resolve_within(&root, "logs/run.txt").expect("a nested path is allowed");
        assert!(resolved.starts_with(fs::canonicalize(&root).unwrap()));
        assert!(resolved.ends_with("logs/run.txt"));
        cleanup(&root);
    }

    #[test]
    fn refuses_traversal_out_of_the_root() {
        let root = temp_root("traversal");
        let err =
            resolve_within(&root, "../../settings.json").expect_err("traversal must be refused");
        assert!(err.contains("escapes"), "unexpected error: {err}");
        cleanup(&root);
    }

    #[test]
    fn refuses_an_absolute_path_outside_the_root() {
        let root = temp_root("absolute");
        let err = resolve_within(&root, "/etc/passwd").expect_err("absolute must be refused");
        assert!(!err.is_empty());
        cleanup(&root);
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_symlink_that_points_outside_the_root() {
        use std::os::unix::fs::symlink;
        let root = temp_root("symlink");
        let outside = temp_root("symlink-outside");
        fs::write(outside.join("secret.txt"), "secret").expect("seed outside file");
        symlink(&outside, root.join("link")).expect("create symlink");
        let err = resolve_within(&root, "link/secret.txt")
            .expect_err("a symlink escape must be refused");
        assert!(err.contains("escapes"), "unexpected error: {err}");
        cleanup(&root);
        cleanup(&outside);
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_dangling_symlink_that_points_outside_the_root() {
        use std::os::unix::fs::symlink;
        let root = temp_root("dangling-symlink");
        let outside = temp_root("dangling-symlink-outside");
        // The target is absent, so `canonicalize` reports NotFound and the walk
        // would otherwise treat `link` as a plain, non-existent name — returning
        // the symlink itself, which `fs::write` then follows out of the root.
        let target = outside.join("pwned.txt");
        symlink(&target, root.join("link")).expect("create dangling symlink");
        let err =
            resolve_within(&root, "link").expect_err("a dangling symlink must be refused");
        assert!(err.contains("escapes"), "unexpected error: {err}");
        assert!(!target.exists(), "the escape target must not be created");
        cleanup(&root);
        cleanup(&outside);
    }

    #[test]
    fn refuses_a_drive_prefix_or_otherwise_invalid_id() {
        // `C:` (and `C:foo`) is a Windows drive-relative path, and
        // `PathBuf::join` discards the base entirely for a path that has a
        // prefix but no root — so the id must be an allowlist, never a
        // denylist of `/`, `\` and dots.
        for bad in [
            "C:", "C:foo", "C:..", "..", ".", "", ".hidden", "trailing.", "a/b", "a\\b", "a b",
            "a:b",
        ] {
            assert!(safe_id(bad).is_err(), "id {bad:?} must be refused");
        }
        for good in ["acme.theme", "a", "a-b_c.1", "t18.fixture"] {
            assert!(safe_id(good).is_ok(), "id {good:?} must be allowed");
        }
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
            fetch_url,
            http_request,
            plugin_list,
            plugin_read_file,
            plugin_write_file,
            plugin_remove,
            plugin_data_dir,
            plugin_fs_read,
            plugin_fs_write,
            plugin_fs_list,
            plugin_fs_delete,
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
