use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime};
use tauri::{Emitter, Manager};

/// Settings live at the root of the app data dir; one file per conversation.
const SETTINGS_FILE: &str = "settings.json";
const CONVERSATIONS_DIR: &str = "conversations";

/// Installed plugin source: `<app data>/plugins/<id>/plugin.json` plus assets.
const PLUGINS_DIR: &str = "plugins";

/// Per-plugin scoped data: `<app data>/plugin-data/<id>/` (spec §7).
const PLUGIN_DATA_DIR: &str = "plugin-data";

/// The Tauri event the watcher emits when a plugin's source changes (spec §6).
const PLUGIN_CHANGED_EVENT: &str = "plugin-changed";

/// How often the plugins directory is rescanned. Polling keeps the watcher
/// dependency-free — `notify` is not a direct dependency and this task forbids
/// adding one — and a plugin source edit is a human gesture, so a one-second
/// poll is plenty.
const PLUGIN_WATCH_INTERVAL: Duration = Duration::from_millis(1000);

/// Whole-request deadline: a hung host must fail the fetch rather than
/// park the command — and the UI awaiting it — indefinitely.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// Whole-request deadline for the third-party API pass-through: that
/// API documents a 110-second per-URL backend timeout and tells
/// clients to allow 150, so the page-fetch command's 30 seconds
/// does not fit here.
const API_REQUEST_TIMEOUT: Duration = Duration::from_secs(150);

/// Connect-phase deadline for the streamed chat client. That client carries no
/// total deadline (see [`STREAM_READ_TIMEOUT`]), so an unreachable or
/// black-holing host is caught here instead of parking the turn.
const CHAT_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

/// Per-**read** deadline for a streamed chat response: the gap between body
/// chunks, not the whole response.
///
/// A total deadline cannot fit a stream. `reqwest`'s `ClientBuilder::timeout` is
/// "a total request timeout … until the response body has finished", and the
/// shared page-fetch client carries 30 seconds of it — so a chat reply read
/// through that client was cut off mid-body for any answer that took longer than
/// half a minute, a cap the web path never had. `read_timeout` instead "applies
/// to each read operation, and resets after a successful read", so a reply of
/// any total length relays as long as it keeps arriving. With no deadline at all
/// a genuinely dead socket would park the turn until the user stopped it; the
/// user's stop control remains what ends a reply that is merely slow.
const STREAM_READ_TIMEOUT: Duration = Duration::from_secs(300);

/// The URL schemes the shell will relay. `reqwest` refuses anything else anyway,
/// so this is the readable message and defence in depth, checked before a
/// request is built — `command` names the caller the way its own error does.
fn http_url(command: &str, url: &str) -> Result<(), String> {
    if url.starts_with("http://") || url.starts_with("https://") {
        Ok(())
    } else {
        Err(format!(
            "{command}: only http:// and https:// URLs are allowed: {url}"
        ))
    }
}

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

/* --------------------------------------------------------------- watcher */

/// One source file's identity: enough to notice an edit without reading it.
type FileStamp = (SystemTime, u64);

/// Editor/temp files a save can leave beside the real source; a change to one is
/// not a plugin change.
fn is_editor_artefact(name: &str) -> bool {
    name.starts_with('.')
        || name.ends_with('~')
        || name.ends_with(".swp")
        || name.ends_with(".swx")
        || name.ends_with(".tmp")
}

/// The plugin id a changed path belongs to, or `None` when the change is not a
/// plugin-source change worth reloading (spec §6). This is the watcher's whole
/// relevance rule, split out so it can be unit-tested without a live watcher:
///
/// - the path must be a **file** at or below `plugins/<id>/…` — so a change
///   under the sibling `plugin-data/` tree is not a plugin change, and neither
///   is a change to the `plugins` directory itself;
/// - `<id>` must pass the same allowlist the commands use, so a stray file
///   directly in `plugins/` or a `.hidden` directory is ignored;
/// - no component may be an editor/temp artefact.
fn changed_plugin(plugins_root: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(plugins_root).ok()?;
    let mut components = rel.components();
    let id = match components.next()? {
        std::path::Component::Normal(name) => name.to_str()?,
        _ => return None,
    };
    if safe_id(id).is_err() {
        return None;
    }
    let mut saw_file = false;
    for component in components {
        let name = match component {
            std::path::Component::Normal(name) => name.to_str()?,
            _ => return None,
        };
        if is_editor_artefact(name) {
            return None;
        }
        saw_file = true;
    }
    if !saw_file {
        // The plugin directory itself, not a file inside it.
        return None;
    }
    Some(id.to_string())
}

/// Every file under `root`, keyed by absolute path. Directories are not
/// recorded: a directory's mtime moves when its files do, so files alone are
/// enough and a directory-only touch does not spuriously reload.
fn scan_plugins(root: &Path) -> BTreeMap<PathBuf, FileStamp> {
    let mut files = BTreeMap::new();
    collect_files(root, &mut files);
    files
}

fn collect_files(dir: &Path, out: &mut BTreeMap<PathBuf, FileStamp>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        // `DirEntry::file_type` never follows a symlink, unlike `fs::metadata` —
        // so a symlinked directory is not recursed (there is no loop to guard
        // against: `DirEntry::metadata` below is `lstat`, so it does not follow
        // either). Skipping symlinks is still worth it: without it a symlink is
        // recorded as a plain *file* (its own mtime and length), which puts a
        // path in the watch set whose real target's edits are invisible and
        // which pulls nothing at or below the plugins root. Plugins are
        // full-trust, so this is containment tidiness, not a security guard.
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            collect_files(&path, out);
        } else if let Ok(meta) = entry.metadata() {
            if let Ok(modified) = meta.modified() {
                out.insert(path, (modified, meta.len()));
            }
        }
    }
}

/// The distinct plugin ids whose files differ between two scans — added, removed
/// or modified. A path that is not a plugin source change (`changed_plugin`) is
/// dropped here, so the caller only ever sees ids worth reloading.
fn changed_ids(
    before: &BTreeMap<PathBuf, FileStamp>,
    after: &BTreeMap<PathBuf, FileStamp>,
    plugins_root: &Path,
) -> Vec<String> {
    let mut ids: BTreeSet<String> = BTreeSet::new();
    for (path, stamp) in after {
        if before.get(path) != Some(stamp) {
            if let Some(id) = changed_plugin(plugins_root, path) {
                ids.insert(id);
            }
        }
    }
    for path in before.keys() {
        if !after.contains_key(path) {
            if let Some(id) = changed_plugin(plugins_root, path) {
                ids.insert(id);
            }
        }
    }
    ids.into_iter().collect()
}

/// Owns the background polling thread. `Drop` sets the stop flag, so the watcher
/// cannot outlive the app that manages it, and a single managed instance means
/// the thread cannot be started twice and leak across reloads.
struct PluginWatcher {
    stop: Arc<AtomicBool>,
}

impl PluginWatcher {
    fn start(app: tauri::AppHandle) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&stop);
        let root = match app_data_dir(&app) {
            Ok(dir) => dir.join(PLUGINS_DIR),
            Err(e) => {
                log::warn!("plugin watcher disabled: {e}");
                return Self { stop };
            }
        };
        let spawned = std::thread::Builder::new()
            .name("plugin-watcher".into())
            .spawn(move || {
                // Seed from the current state so files that already exist are
                // not reported as changes on the first tick.
                let mut before = scan_plugins(&root);
                while !flag.load(Ordering::Relaxed) {
                    std::thread::sleep(PLUGIN_WATCH_INTERVAL);
                    if flag.load(Ordering::Relaxed) {
                        break;
                    }
                    let after = scan_plugins(&root);
                    for id in changed_ids(&before, &after, &root) {
                        let payload = serde_json::json!({ "id": id });
                        if let Err(e) = app.emit(PLUGIN_CHANGED_EVENT, payload) {
                            log::warn!(
                                "plugin watcher could not emit {PLUGIN_CHANGED_EVENT}: {e}"
                            );
                        }
                    }
                    before = after;
                }
            });
        if let Err(e) = spawned {
            log::warn!("plugin watcher could not start: {e}");
        }
        Self { stop }
    }
}

impl Drop for PluginWatcher {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

/// Start a client: the rustls-no-provider build has no crypto provider of its
/// own, so install the ring one (already in the tree for the updater) as the
/// process default, as tauri-plugin-updater itself does. Split out because
/// there are two clients with different deadline policies and both must install
/// the provider before their first TLS handshake.
fn client_builder() -> reqwest::ClientBuilder {
    let _ = rustls::crypto::ring::default_provider().install_default();
    reqwest::Client::builder().user_agent(USER_AGENT)
}

/// One shared client for every fetch: the connection pool and TLS
/// sessions are reused across calls, and `reqwest::Client` is designed
/// to be shared, not rebuilt per request.
static HTTP_CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();

fn http_client() -> Result<&'static reqwest::Client, String> {
    let slot = HTTP_CLIENT.get_or_init(|| {
        client_builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|e| format!("failed to build http client: {e}"))
    });
    slot.as_ref().map_err(|e| e.clone())
}

/// Build a client for a streamed chat request: no total deadline, a per-read
/// one (see [`STREAM_READ_TIMEOUT`]) and a bounded connect. Takes the read
/// deadline as an argument so a test can shorten it and prove the semantics in
/// bounded time; production is [`chat_client`].
fn chat_client_from(read_timeout: Duration) -> Result<reqwest::Client, String> {
    client_builder()
        .connect_timeout(CHAT_CONNECT_TIMEOUT)
        .read_timeout(read_timeout)
        .build()
        .map_err(|e| format!("failed to build chat http client: {e}"))
}

/// One shared client for streamed chat, with that deadline policy. It cannot be
/// [`HTTP_CLIENT`]: a client's total deadline cannot be cleared per request
/// (`RequestBuilder` has `timeout`, not an `Option` to unset), so the only way
/// for a streamed body not to inherit the 30-second page-fetch deadline is a
/// client that never had one. Sharing it keeps its pool and TLS sessions reused
/// across turns, as the page-fetch client's are.
static CHAT_CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();

fn chat_client() -> Result<&'static reqwest::Client, String> {
    let slot = CHAT_CLIENT.get_or_init(|| chat_client_from(STREAM_READ_TIMEOUT));
    slot.as_ref().map_err(|e| e.clone())
}

/// Fetch a page for the model, bypassing the browser's CORS limit: the
/// renderer cannot cross-origin read arbitrary sites, the Rust shell
/// can. Over [`MAX_RESPONSE_BYTES`] is an error, never a truncated page.
#[tauri::command]
async fn fetch_url(url: String) -> Result<String, String> {
    http_url("fetch_url", &url)?;
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

/// Open one http(s) URL in the user's default browser.
///
/// A webview cannot do this itself: Tauri v2 does not hand an external
/// `target="_blank"` navigation to the OS, so without this the app's own
/// in-window links (the docs site, the release page) do nothing on the desktop.
/// The URL is one argv entry and never goes through a shell, so no part of it
/// can be read as a command, and its scheme goes through the same guard the
/// fetch commands use.
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    http_url("open_external", &url)?;
    let (program, args): (&str, &[&str]) = if cfg!(target_os = "macos") {
        ("open", &[url.as_str()])
    } else if cfg!(target_os = "windows") {
        // `rundll32` takes the URL as its own argument, so there is no shell
        // and none of its quoting rules.
        ("rundll32", &["url.dll,FileProtocolHandler", url.as_str()])
    } else {
        ("xdg-open", &[url.as_str()])
    };
    std::process::Command::new(program)
        .args(args)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("open_external: failed to launch {program}: {e}"))
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
    http_url("http_request", &url)?;
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

/* --------------------------------------------------------- streamed chat */

/// One message the desktop chat transport relays to the frontend, **in order**.
///
/// The status is relayed before a byte of the body is read, so the caller can
/// tell a non-2xx apart without accumulating anything. A failure that happens
/// *before* the status is the command's own `Err` (the caller has no stream to
/// consume yet); after it, it is a terminal `Error` message, so the caller's
/// stream has one source of truth for how it ended. `End` is that source for a
/// body relayed whole.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
enum StreamMessage {
    /// The response's status, relayed before its body.
    Status { status: u16 },
    /// One run of the response body, decoded to text (see [`take_text`]).
    Chunk { text: String },
    /// The body could not be relayed to its end.
    Error { message: String },
    /// The body was relayed to its end.
    End,
}

/// Move every complete UTF-8 character out of `buffer`, leaving a truncated tail
/// behind for the next chunk.
///
/// A response body is a byte stream, so a multi-byte character can straddle two
/// chunks; decoding each chunk on its own (`String::from_utf8_lossy`) would
/// corrupt it into replacement characters. This is the incremental decode the
/// web path already gets from `TextDecoder`: an incomplete tail is carried to
/// the next chunk, and a genuinely invalid byte becomes U+FFFD.
fn take_text(buffer: &mut Vec<u8>) -> String {
    let mut out = String::new();
    loop {
        match std::str::from_utf8(buffer) {
            Ok(text) => {
                out.push_str(text);
                buffer.clear();
                break;
            }
            Err(e) => {
                let valid = e.valid_up_to();
                // `valid_up_to` is a UTF-8 boundary, so the prefix decodes.
                out.push_str(std::str::from_utf8(&buffer[..valid]).unwrap_or_default());
                match e.error_len() {
                    // An incomplete tail: hold it for the next chunk.
                    None => {
                        buffer.drain(..valid);
                        break;
                    }
                    // Invalid bytes: replace them, as the decoder does.
                    Some(len) => {
                        out.push('\u{FFFD}');
                        buffer.drain(..valid + len);
                    }
                }
            }
        }
    }
    out
}

/// Read a response body to its end, relaying each decoded run through `send`.
/// The body is never held whole: every chunk is handed over as it arrives, so a
/// long reply starts rendering before the endpoint has finished writing it.
async fn relay_body(
    response: &mut reqwest::Response,
    url: &str,
    send: &mut impl FnMut(StreamMessage) -> Result<(), String>,
) -> Result<(), String> {
    let mut pending: Vec<u8> = Vec::new();
    loop {
        let chunk = response
            .chunk()
            .await
            .map_err(|e| format!("failed to read response from {url}: {e}"))?;
        let Some(chunk) = chunk else { break };
        pending.extend_from_slice(&chunk);
        let text = take_text(&mut pending);
        if !text.is_empty() {
            send(StreamMessage::Chunk { text }).map_err(|e| e.to_string())?;
        }
    }
    // A body that ends mid-character: decode the tail lossily rather than
    // dropping it, exactly as the web path's `TextDecoder` flush does.
    if !pending.is_empty() {
        send(StreamMessage::Chunk {
            text: String::from_utf8_lossy(&pending).into_owned(),
        })
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Relay one chat request: the status, then the body in order, decoded to text.
///
/// The sink is a closure rather than the [`tauri::ipc::Channel`] itself, so a
/// test can drive this with a real TCP server and a plain closure (a `Channel`
/// needs a running app); [`chat_stream`] is then only the wiring. The client is
/// a parameter for the same reason: a test can give it a read deadline short
/// enough to observe. Everything before the status is this function's `Err`;
/// once the status is out, a failure is relayed as a terminal `Error` message
/// and the function returns `Ok`, so the caller's stream can never end without
/// saying how.
async fn relay(
    client: &reqwest::Client,
    url: &str,
    headers: &HashMap<String, String>,
    body: &str,
    mut send: impl FnMut(StreamMessage) -> Result<(), String>,
) -> Result<(), String> {
    // The same allowlist the sibling commands enforce, checked before anything
    // is sent (see [`http_url`]).
    http_url("chat_stream", url)?;
    let mut request = client.post(url);
    for (name, value) in headers {
        request = request.header(name.as_str(), value.as_str());
    }
    let mut response = request
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| format!("failed to send POST {url}: {e}"))?;

    let status = response.status().as_u16();
    // A send that fails here means the frontend is gone: there is no one left
    // to fail for, so the channel error is not propagated as a request error.
    let _ = send(StreamMessage::Status { status });

    match relay_body(&mut response, url, &mut send).await {
        Ok(()) => {
            let _ = send(StreamMessage::End);
        }
        Err(message) => {
            let _ = send(StreamMessage::Error { message });
        }
    }
    Ok(())
}

/// In-flight streaming requests, by the caller's own request id, so the
/// frontend can abort one. The abort handle is detached from the task (the
/// command awaits the task and so cannot keep it); aborting drops the task at
/// its next await, which drops the `reqwest::Response` and closes the
/// connection — the request is gone, not merely ignored.
#[derive(Default)]
struct ChatStreams(Mutex<HashMap<String, Box<dyn Fn() + Send + Sync>>>);

/// `POST url` with `headers` and `body`, streaming the response back through
/// `on_event`: the status first, then the body as text chunks, then `End` (or a
/// terminal `Error`).
///
/// This is the desktop chat transport. It exists because a webview cannot make
/// this request at all against a host that answers no CORS preflight for it —
/// the preflight is refused, the POST is never sent. It is a **separate**
/// command from `http_request`, which `fetch_url` depends on whole-response at
/// a time.
#[tauri::command]
async fn chat_stream(
    state: tauri::State<'_, ChatStreams>,
    request_id: String,
    url: String,
    headers: HashMap<String, String>,
    body: String,
    on_event: tauri::ipc::Channel<StreamMessage>,
) -> Result<(), String> {
    // Resolved before the task starts, so a client that cannot be built at all
    // is the command's own `Err` rather than a stream that never speaks.
    let client = chat_client()?;
    let task = tauri::async_runtime::spawn(async move {
        relay(client, &url, &headers, &body, move |message| {
            on_event
                .send(message)
                .map_err(|e| format!("failed to relay a streamed message: {e}"))
        })
        .await
    });

    // Registered before the await, so a cancel arriving while the response is
    // still open finds it.
    let abort = task.inner().abort_handle();
    if let Ok(mut streams) = state.0.lock() {
        streams.insert(request_id.clone(), Box::new(move || abort.abort()));
    }
    let outcome = task.await;
    if let Ok(mut streams) = state.0.lock() {
        streams.remove(&request_id);
    }

    match outcome {
        Ok(result) => result,
        // Aborted: the caller abandoned the turn, so the request being gone is
        // the intended outcome, not an error to report.
        Err(tauri::Error::JoinError(e)) if e.is_cancelled() => Ok(()),
        Err(e) => Err(format!("the streaming request faulted: {e}")),
    }
}

/// Abort an in-flight [`chat_stream`]. A request id the map does not hold is a
/// no-op, so cancelling an already-finished (or already-cancelled) request is
/// safe.
#[tauri::command]
fn chat_stream_cancel(state: tauri::State<'_, ChatStreams>, request_id: String) {
    if let Ok(mut streams) = state.0.lock() {
        if let Some(abort) = streams.remove(&request_id) {
            abort();
        }
    }
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

#[cfg(test)]
mod watcher_tests {
    use super::{changed_ids, changed_plugin, scan_plugins};
    use std::fs;
    use std::path::{Path, PathBuf};

    /// A fresh temp root per test — no new dependency, so no `tempfile`.
    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "ai-client-plugin-watch-{}-{tag}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create temp root");
        dir
    }

    fn cleanup(root: &Path) {
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_plugin_file_is_a_plugin_change() {
        let root = temp_root("plugin-file");
        assert_eq!(
            changed_plugin(&root, &root.join("acme.theme").join("main.js")).as_deref(),
            Some("acme.theme")
        );
        assert_eq!(
            changed_plugin(
                &root,
                &root.join("acme.theme").join("assets").join("x.png")
            )
            .as_deref(),
            Some("acme.theme")
        );
        cleanup(&root);
    }

    #[test]
    fn a_data_dir_or_temp_file_is_not_a_plugin_change() {
        let app_data = temp_root("ignored");
        let plugins = app_data.join("plugins");
        // The scoped data dir is a sibling of `plugins/`, so a path under it
        // does not even strip against the watcher's root. Checked first: it is
        // the strongest form of the rule.
        let data = app_data
            .join("plugin-data")
            .join("acme.theme")
            .join("state.json");
        assert_eq!(changed_plugin(&plugins, &data), None);

        // Temp/editor artefacts under a plugin are not source changes.
        for name in [
            ".DS_Store",
            "main.js~",
            "main.js.swp",
            "main.js.swx",
            ".main.js.tmp",
        ] {
            assert_eq!(
                changed_plugin(&plugins, &plugins.join("acme.theme").join(name)),
                None,
                "{name} must be ignored"
            );
        }
        // A file directly in `plugins/` has no plugin id.
        assert_eq!(changed_plugin(&plugins, &plugins.join("stray.js")), None);
        // The plugin directory itself, not a file inside it.
        assert_eq!(
            changed_plugin(&plugins, &plugins.join("acme.theme")),
            None
        );
        // A directory name that is not a valid plugin id.
        assert_eq!(
            changed_plugin(&plugins, &plugins.join("bad id").join("main.js")),
            None
        );
        cleanup(&app_data);
    }

    #[test]
    fn a_real_edit_is_reported_by_the_scan_and_a_temp_file_is_not() {
        let root = temp_root("scan");
        let plugin = root.join("acme.theme");
        fs::create_dir_all(&plugin).expect("create plugin dir");
        fs::write(plugin.join("plugin.json"), "{}").expect("write manifest");
        let before = scan_plugins(&root);

        // Nothing changed yet.
        assert!(changed_ids(&before, &scan_plugins(&root), &root).is_empty());

        // An edit to the entry is a change for exactly that plugin.
        fs::write(plugin.join("main.js"), "export default {}").expect("write entry");
        assert_eq!(
            changed_ids(&before, &scan_plugins(&root), &root),
            vec!["acme.theme".to_string()]
        );

        // A temp file an editor left behind is not a change.
        let after = scan_plugins(&root);
        fs::write(plugin.join("main.js~"), "backup").expect("write temp");
        assert!(changed_ids(&after, &scan_plugins(&root), &root).is_empty());

        // A whole plugin directory appearing is a change for its id.
        fs::create_dir_all(root.join("acme.other")).expect("create second plugin");
        fs::write(root.join("acme.other").join("plugin.json"), "{}").expect("write manifest");
        assert_eq!(
            changed_ids(&after, &scan_plugins(&root), &root),
            vec!["acme.other".to_string()]
        );
        cleanup(&root);
    }

    #[test]
    fn a_data_dir_write_is_invisible_to_the_scan() {
        // The watcher scans only `plugins/`; a write under `plugin-data/` must
        // not appear at all, the strongest form of "does not trigger a reload".
        let app_data = temp_root("data-invisible");
        let plugins = app_data.join("plugins");
        fs::create_dir_all(plugins.join("acme.theme")).expect("create plugin dir");
        let before = scan_plugins(&plugins);

        let data = app_data.join("plugin-data").join("acme.theme");
        fs::create_dir_all(&data).expect("create data dir");
        fs::write(data.join("state.json"), "{}").expect("write data file");

        assert!(changed_ids(&before, &scan_plugins(&plugins), &plugins).is_empty());
        cleanup(&app_data);
    }

    #[test]
    fn a_deleted_plugin_file_or_directory_is_a_change_for_its_id() {
        // The deletion branch of `changed_ids`: a path present in `before` and
        // absent from `after` is a change for its plugin. It has to be pinned —
        // a deleted file is exactly the edit that would otherwise go unnoticed.
        let root = temp_root("scan-delete");
        let plugin = root.join("acme.theme");
        fs::create_dir_all(&plugin).expect("create plugin dir");
        fs::write(plugin.join("main.js"), "export default {}").expect("write entry");

        let before = scan_plugins(&root);
        fs::remove_file(plugin.join("main.js")).expect("delete entry");
        assert_eq!(
            changed_ids(&before, &scan_plugins(&root), &root),
            vec!["acme.theme".to_string()]
        );

        // Removing the whole plugin directory is the same id.
        fs::write(plugin.join("main.js"), "export default {}").expect("rewrite entry");
        let before = scan_plugins(&root);
        fs::remove_dir_all(&plugin).expect("delete plugin dir");
        assert_eq!(
            changed_ids(&before, &scan_plugins(&root), &root),
            vec!["acme.theme".to_string()]
        );
        cleanup(&root);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_loop_is_not_followed() {
        use std::os::unix::fs::symlink;
        // A directory symlink back to its own directory: following it makes the
        // scan recurse forever. Only the real files are recorded.
        let root = temp_root("symlink-loop");
        let plugin = root.join("acme.theme");
        fs::create_dir_all(&plugin).expect("create plugin dir");
        fs::write(plugin.join("main.js"), "export default {}").expect("write entry");
        symlink(&plugin, plugin.join("loop")).expect("create symlink loop");

        let files = scan_plugins(&root);
        assert_eq!(files.len(), 1);
        assert!(files.contains_key(&plugin.join("main.js")));
        cleanup(&root);
    }
}

#[cfg(test)]
mod stream_tests {
    use super::{chat_client_from, http_url, relay, take_text, StreamMessage};
    use std::collections::HashMap;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::mpsc;
    use std::time::Duration;

    /// Long enough for a handshake and a few local writes; every wait below is
    /// bounded by it, so a mistake fails the test instead of hanging it.
    const PATIENCE: Duration = Duration::from_secs(10);

    /// A client with the production shape's deadlines — no total deadline, a
    /// per-read one — at a length the scripted tests below never approach.
    fn test_client() -> reqwest::Client {
        chat_client_from(Duration::from_secs(30)).expect("build a chat client")
    }

    /// Read the request head (up to the blank line) so the response can be
    /// written while the client is still sending its body.
    fn read_head(socket: &mut TcpStream) {
        let mut head = Vec::new();
        let mut byte = [0u8; 1];
        while socket.read_exact(&mut byte).is_ok() {
            head.push(byte[0]);
            if head.ends_with(b"\r\n\r\n") {
                break;
            }
        }
    }

    fn write_head(socket: &mut TcpStream, status: u16) {
        let reason = if status == 200 { "OK" } else { "Not Found" };
        write!(
            socket,
            "HTTP/1.1 {status} {reason}\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\n\r\n"
        )
        .expect("write the response head");
        socket.flush().expect("flush the head");
    }

    fn write_chunk(socket: &mut TcpStream, text: &str) -> std::io::Result<()> {
        write!(socket, "{:x}\r\n{text}\r\n", text.len())
    }

    /// Everything the relay has sent until (and including) its terminal message.
    fn collect_terminal(rx: &mpsc::Receiver<StreamMessage>) -> Vec<StreamMessage> {
        let mut messages = Vec::new();
        loop {
            let message = rx
                .recv_timeout(PATIENCE)
                .expect("a relayed message, or the terminal one");
            let terminal = matches!(
                message,
                StreamMessage::End | StreamMessage::Error { .. }
            );
            messages.push(message);
            if terminal {
                return messages;
            }
        }
    }

    /// Run one relay on its own thread, returning its message receiver and the
    /// thread's join handle (which resolves to the relay's own result).
    fn relay_in_background(
        client: reqwest::Client,
        url: String,
    ) -> (
        mpsc::Receiver<StreamMessage>,
        std::thread::JoinHandle<Result<(), String>>,
    ) {
        let (tx, rx) = mpsc::channel::<StreamMessage>();
        let handle = std::thread::spawn(move || {
            tauri::async_runtime::block_on(relay(&client, &url, &HashMap::new(), "{}", move |message| {
                tx.send(message).map_err(|e| e.to_string())
            }))
        });
        (rx, handle)
    }

    /// A server that answers one request with `status` and a chunked body it
    /// holds until the test releases it — so the test can prove the status is
    /// relayed **before** any of the body exists — written with `gap` between
    /// runs.
    fn serve(
        status: u16,
        chunks: &'static [&'static str],
        gap: Duration,
    ) -> (u16, mpsc::Sender<()>, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind a port");
        let port = listener.local_addr().expect("read the port").port();
        let (go_tx, go_rx) = mpsc::channel::<()>();
        let handle = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().expect("accept the request");
            read_head(&mut socket);
            write_head(&mut socket, status);
            go_rx
                .recv_timeout(PATIENCE)
                .expect("the test releases the body");
            // A client that hangs up mid-body (a deadline, an abort) makes these
            // writes fail; that is the client's business, not the mock's, and
            // swallowing it here keeps the test's own assertion the one that
            // reports what happened.
            for chunk in chunks {
                if write_chunk(&mut socket, chunk).is_err() {
                    return;
                }
                if socket.flush().is_err() {
                    return;
                }
                std::thread::sleep(gap);
            }
            let _ = socket.write_all(b"0\r\n\r\n");
            let _ = socket.flush();
        });
        (port, go_tx, handle)
    }

    /// Relay one scripted response and return every relayed message in order.
    fn relay_scripted(
        client: reqwest::Client,
        status: u16,
        chunks: &'static [&'static str],
        gap: Duration,
    ) -> Vec<StreamMessage> {
        let (port, go, server) = serve(status, chunks, gap);
        let (rx, client_thread) =
            relay_in_background(client, format!("http://127.0.0.1:{port}/chat/completions"));

        // The body has not been written yet, so a status here is what proves
        // the response is relayed as it arrives rather than read whole first.
        let first = rx
            .recv_timeout(PATIENCE)
            .expect("the status is relayed before the body is written");
        assert_eq!(first, StreamMessage::Status { status });
        go.send(()).expect("release the body");

        let mut messages = vec![first];
        messages.extend(collect_terminal(&rx));

        client_thread
            .join()
            .expect("the relay thread")
            .expect("a relayed response is Ok");
        server.join().expect("the server thread");
        messages
    }

    /// A server that writes a status and one run, then holds the socket open and
    /// **silent** until the test drops the release handle. Only a read deadline
    /// can end such a body, so this pins that one exists: a mock that closed on
    /// its own would end the stream by closing the connection, which is a
    /// different event and would let the test pass with no deadline at all.
    fn serve_stalled() -> (u16, mpsc::Sender<()>, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind a port");
        let port = listener.local_addr().expect("read the port").port();
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let handle = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().expect("accept the request");
            read_head(&mut socket);
            write_head(&mut socket, 200);
            write_chunk(&mut socket, "data: one\n\n").expect("write the run");
            socket.flush().expect("flush the run");
            // Held until the test is done with it, and not a moment longer.
            let _ = release_rx.recv();
        });
        (port, release_tx, handle)
    }

    /// The body the messages carry, concatenated in relay order.
    fn body_of(messages: &[StreamMessage]) -> String {
        messages
            .iter()
            .filter_map(|message| match message {
                StreamMessage::Chunk { text } => Some(text.as_str()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn relays_a_chunked_sse_body_in_order_after_the_status() {
        let script: &'static [&'static str] =
            &["data: one\n\n", "data: two\n\n", "data: [DONE]\n\n"];
        let messages = relay_scripted(
            test_client(),
            200,
            script,
            Duration::from_millis(20),
        );

        assert_eq!(messages.first(), Some(&StreamMessage::Status { status: 200 }));
        assert_eq!(messages.last(), Some(&StreamMessage::End));
        // The chunks carry the body in the order the server wrote it, byte for
        // byte — the caller's line parser sees exactly what the wire carried.
        assert_eq!(body_of(&messages), script.concat());
        // And it was relayed in runs, not as one buffered message.
        let runs = messages
            .iter()
            .filter(|message| matches!(message, StreamMessage::Chunk { .. }))
            .count();
        assert!(runs > 1, "expected several relayed chunks, got {messages:?}");
    }

    #[test]
    fn relays_a_body_that_outlives_the_read_deadline() {
        // Each gap is inside the read deadline; the whole body is not. A
        // per-read deadline lets this through, where a **total** one of the same
        // length — the shape the shared page-fetch client carries, and what this
        // path used to inherit — cuts the reply off mid-body.
        let deadline = Duration::from_millis(500);
        let script: &'static [&'static str] =
            &["data: one\n\n", "data: two\n\n", "data: three\n\n"];
        let messages = relay_scripted(
            chat_client_from(deadline).expect("build a chat client"),
            200,
            script,
            Duration::from_millis(300),
        );

        // Three 300ms gaps: ~900ms of body, against a 500ms deadline.
        assert!(Duration::from_millis(900) > deadline);
        assert_eq!(messages.last(), Some(&StreamMessage::End));
        assert_eq!(body_of(&messages), script.concat());
    }

    #[test]
    fn a_stalled_body_ends_the_stream_instead_of_hanging() {
        // The server writes a status and one run, then holds the socket open and
        // silent. The read deadline must end the stream with a terminal error:
        // with no deadline at all this body would stay open until the user
        // noticed, which is what "no deadline" would mean for a dead connection.
        let client = chat_client_from(Duration::from_millis(250)).expect("build a chat client");
        let (port, release, server) = serve_stalled();

        let (rx, client_thread) =
            relay_in_background(client, format!("http://127.0.0.1:{port}/chat/completions"));
        // Only the read deadline can produce this terminal: the mock has not
        // closed anything.
        let messages = collect_terminal(&rx);

        assert_eq!(messages.first(), Some(&StreamMessage::Status { status: 200 }));
        assert_eq!(body_of(&messages), "data: one\n\n");
        assert!(
            matches!(messages.last(), Some(StreamMessage::Error { .. })),
            "a stalled body must end with a terminal error, got {messages:?}"
        );
        client_thread
            .join()
            .expect("the relay thread")
            .expect("a stalled body is a relayed failure, not a request error");

        drop(release);
        server.join().expect("the server thread");
    }

    #[test]
    fn a_non_http_url_is_refused_before_any_request() {
        let sent = std::cell::RefCell::new(Vec::new());
        let outcome = tauri::async_runtime::block_on(relay(
            &test_client(),
            "file:///etc/passwd",
            &HashMap::new(),
            "{}",
            |message| {
                sent.borrow_mut().push(message);
                Ok(())
            },
        ));
        let error = outcome.expect_err("a non-http URL must be refused");
        assert_eq!(
            error,
            "chat_stream: only http:// and https:// URLs are allowed: file:///etc/passwd"
        );
        assert!(sent.borrow().is_empty(), "nothing may be relayed");
    }

    #[test]
    fn the_url_allowlist_names_every_caller() {
        // The three commands share one check, so each keeps the message its own
        // error carried.
        for command in ["fetch_url", "http_request", "chat_stream"] {
            assert!(http_url(command, "https://example.com/x").is_ok());
            assert!(http_url(command, "http://127.0.0.1:8080/x").is_ok());
            for rejected in ["file:///etc/passwd", "data:text/plain,hi", "/etc/passwd", ""] {
                assert_eq!(
                    http_url(command, rejected).expect_err("a non-http URL must be refused"),
                    format!("{command}: only http:// and https:// URLs are allowed: {rejected}")
                );
            }
        }
    }

    #[test]
    fn a_non_2xx_is_distinguishable_and_its_body_is_relayed() {
        // The caller builds `HTTP ${status}: ${detail}` from exactly these two:
        // a status it can read, and the body it read as text.
        let messages = relay_scripted(
            test_client(),
            404,
            &["{\"error\":\"no such model\"}"],
            Duration::from_millis(20),
        );

        assert_eq!(messages.first(), Some(&StreamMessage::Status { status: 404 }));
        assert_eq!(messages.last(), Some(&StreamMessage::End));
        assert_eq!(body_of(&messages), "{\"error\":\"no such model\"}");
    }

    #[test]
    fn a_character_split_across_chunks_is_not_corrupted() {
        let bytes = "é".as_bytes();
        let mut buffer: Vec<u8> = Vec::new();

        buffer.extend_from_slice(b"a");
        buffer.extend_from_slice(&bytes[..1]);
        // The complete run is relayed; the half character is held back, not
        // replaced.
        assert_eq!(take_text(&mut buffer), "a");
        assert_eq!(buffer, vec![bytes[0]]);

        buffer.extend_from_slice(&bytes[1..]);
        assert_eq!(take_text(&mut buffer), "é");
        assert!(buffer.is_empty());

        // A genuinely invalid byte becomes the replacement character, as the
        // web path's decoder does — and the valid text after it survives.
        buffer.push(0xff);
        buffer.extend_from_slice(b"z");
        assert_eq!(take_text(&mut buffer), "\u{FFFD}z");
        assert!(buffer.is_empty());
    }

    #[test]
    fn a_failure_before_the_status_is_an_error_with_nothing_relayed() {
        // A server that closes the connection before writing a status line, so
        // there is no status and no body to relay. The caller must get an
        // `Err` and no messages at all — never a stream that ended without
        // saying how it ended.
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind a port");
        let port = listener.local_addr().expect("read the port").port();
        let server = std::thread::spawn(move || {
            let (socket, _) = listener.accept().expect("accept the request");
            drop(socket);
        });

        let sent = std::cell::RefCell::new(Vec::new());
        let outcome = tauri::async_runtime::block_on(relay(
            &test_client(),
            &format!("http://127.0.0.1:{port}/chat/completions"),
            &HashMap::new(),
            "{}",
            |message| {
                sent.borrow_mut().push(message);
                Ok(())
            },
        ));
        assert!(outcome.is_err(), "expected a failed request, got {outcome:?}");
        assert!(
            sent.borrow().is_empty(),
            "nothing may be relayed before the status"
        );
        server.join().expect("the server thread");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // The desktop chat transport's in-flight requests, so the frontend can
        // abort one when the user abandons a turn.
        .manage(ChatStreams::default())
        .invoke_handler(tauri::generate_handler![
            db_get_settings,
            db_set_settings,
            db_list_conversations,
            db_get_conversation,
            db_upsert_conversation,
            db_delete_conversation,
            fetch_url,
            http_request,
            open_external,
            chat_stream,
            chat_stream_cancel,
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
            // The plugins directory watcher (spec §6), desktop-only by virtue of
            // living in the shell. Managed, so dropping the app drops it and the
            // polling thread stops at its next tick.
            app.manage(PluginWatcher::start(app.handle().clone()));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
