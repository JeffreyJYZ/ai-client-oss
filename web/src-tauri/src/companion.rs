//! The local companion: a loopback HTTP surface for the website.
//!
//! The web build is a static page on `aiclient.jyz.land`. It cannot reach the
//! filesystem, it holds provider keys in `localStorage`, and an endpoint that
//! refuses a CORS preflight is unreachable from it. The desktop app already has
//! the app-data directory and a Rust client that makes those requests, so this
//! module exposes exactly two things over `127.0.0.1`: the settings file, and a
//! chat forwarder for the providers configured in it.
//!
//! The surface is deliberately tiny and bounded:
//!
//! - **Bind**: loopback only, a fixed port, so a page can find it without
//!   scanning (scanning a port range looks like malware and trips browser
//!   prompts).
//! - **Auth**: a 32-byte bearer token in `companion.json`, mode `0600`,
//!   generated on first run and rotatable from the desktop UI.
//! - **Guards**: exact `Origin` allowlist, `Host` allowlist (DNS rebinding), and
//!   a preflight answer that carries no authority — a preflight is
//!   credentialless and is answered *before* the token check, while the real
//!   request still needs the token.
//! - **Targets**: `/v1/chat` forwards only to a host that a configured
//!   provider's `baseUrl` names. That bound is what keeps the route a
//!   forwarder for the user's providers rather than a general proxy.
//!
//! This is not a sandbox and grants nothing beyond the routes below: settings
//! in one file, chat to configured hosts. See
//! `docs/superpowers/specs/2026-10-22-local-companion.md`.

use std::collections::HashMap;
use std::fs;
use std::io;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::body::{Body, Bytes};
use axum::extract::{DefaultBodyLimit, State};
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, Method, Request, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use ring::rand::{SecureRandom, SystemRandom};
use serde::Deserialize;
use serde_json::{json, Value};

/// The port the site probes. Fixed on purpose: a page cannot read a port from
/// disk, and scanning a range is hostile behaviour in a browser.
const DEFAULT_PORT: u16 = 47821;

/// Overridable for tests and for a machine where the default port is taken.
const PORT_ENV: &str = "AI_CLIENT_COMPANION_PORT";

/// Extra allowed page origins, comma-separated. The compiled-in list is the
/// production site and the dev server.
const ORIGINS_ENV: &str = "AI_CLIENT_COMPANION_ORIGINS";

/// The token file, next to `settings.json` in the app data dir.
const COMPANION_FILE: &str = "companion.json";

/// A settings file bigger than this is a bug, not a document.
const MAX_BODY_BYTES: usize = 4 * 1024 * 1024;

/// A chat body is a whole conversation — attachments and long histories are
/// routinely larger than a settings file, so the forwarder gets its own budget
/// rather than inheriting the settings one.
const MAX_CHAT_BODY_BYTES: usize = 32 * 1024 * 1024;

/// Origins the site is served from. Exact strings, never a wildcard: a wildcard
/// would let any page on the internet drive this surface, and the token would be
/// the only thing left standing.
const ORIGINS: &[&str] = &[
    "https://aiclient.jyz.land",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    // The app's own webview on macOS/Linux; harmless, and it keeps the desktop
    // free to talk to the same surface if it ever wants to.
    "tauri://localhost",
];

/// Headers a forwarder must not copy: framing and connection management belong
/// to the hop doing the talking, not to the caller.
const HOP_BY_HOP: &[&str] = &[
    "host",
    "connection",
    "keep-alive",
    "transfer-encoding",
    "content-length",
    "upgrade",
    "proxy-connection",
    // Let reqwest negotiate (and decompress) the encoding itself.
    "accept-encoding",
    "origin",
    "referer",
];

/// One page the companion has heard from. Recorded for the desktop UI only and
/// never consulted for auth: the bearer token stays the sole authority, so a
/// stale record cannot admit a request.
#[derive(Clone)]
struct SeenOrigin {
    origin: String,
    at: u64,
}

/// What the desktop window shows about pairing. Session-local on purpose — the
/// pairing itself lives in the page's `localStorage`, so this is an
/// observation, not a second source of truth.
#[derive(Default)]
struct PairingLog {
    paired: u64,
    last_pair: Option<SeenOrigin>,
    last_seen: Option<SeenOrigin>,
}

/// The state every route needs. `settings` is a path rather than an
/// `AppHandle` so a test can drive the real router against a temp dir.
#[derive(Clone)]
struct CompanionState {
    settings: PathBuf,
    port: u16,
    token: Arc<Mutex<String>>,
    pairing: Arc<Mutex<PairingLog>>,
}

/// The process-wide handle the desktop commands read. Set once at startup.
struct Companion {
    token: Arc<Mutex<String>>,
    port: u16,
    running: Arc<AtomicBool>,
    pairing: Arc<Mutex<PairingLog>>,
}

static COMPANION: OnceLock<Companion> = OnceLock::new();

/// Start the listener, or log why it could not start. A bind failure must never
/// block app launch: the feature degrades to "website stays browser-local".
pub fn start(app: tauri::AppHandle) {
    if COMPANION.get().is_some() {
        return;
    }
    let port = std::env::var(PORT_ENV)
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(DEFAULT_PORT);
    let token = match load_or_create_token(&app) {
        Ok(token) => token,
        Err(error) => {
            log::warn!("companion: {error}");
            return;
        }
    };
    // Read the extra-origin list now, so a page cannot race its own first
    // request against an environment value that only lands afterwards.
    let _ = extra_origins();
    let settings = match crate::app_data_dir(&app) {
        Ok(dir) => dir.join(crate::SETTINGS_FILE),
        Err(error) => {
            log::warn!("companion: {error}");
            return;
        }
    };

    let token = Arc::new(Mutex::new(token));
    let running = Arc::new(AtomicBool::new(false));
    let pairing = Arc::new(Mutex::new(PairingLog::default()));
    let state = CompanionState {
        settings,
        port,
        token: token.clone(),
        pairing: pairing.clone(),
    };
    let flag = running.clone();

    tauri::async_runtime::spawn(async move {
        let addr = SocketAddr::from(([127, 0, 0, 1], port));
        let listener = match tokio::net::TcpListener::bind(addr).await {
            Ok(listener) => listener,
            Err(error) => {
                log::warn!(
                    "companion: could not bind {addr}: {error} (the site stays browser-local)"
                );
                return;
            }
        };
        flag.store(true, Ordering::SeqCst);
        log::info!("companion listening on http://{addr}");
        if let Err(error) = axum::serve(listener, router(state)).await {
            log::warn!("companion stopped: {error}");
        }
        flag.store(false, Ordering::SeqCst);
    });

    let _ = COMPANION.set(Companion {
        token,
        port,
        running,
        pairing,
    });
}

/// What the desktop UI shows: the port, this machine's token, whether the
/// listener is up, and the last page that paired or talked to it. The token is
/// the user's own secret, shown only in the app.
#[tauri::command]
pub fn companion_info() -> Result<Value, String> {
    let companion = COMPANION
        .get()
        .ok_or_else(|| "companion: not initialised".to_string())?;
    let token = companion
        .token
        .lock()
        .map_err(|_| "companion: state poisoned".to_string())?
        .clone();
    let pairing = companion
        .pairing
        .lock()
        .map_err(|_| "companion: state poisoned".to_string())?;
    Ok(json!({
        "port": companion.port,
        "token": token,
        "running": companion.running.load(Ordering::SeqCst),
        "paired": pairing.paired > 0,
        "pairedCount": pairing.paired,
        "pairedOrigin": pairing.last_pair.as_ref().map(|seen| seen.origin.clone()),
        "pairedAt": pairing.last_pair.as_ref().map(|seen| seen.at),
        "lastSeenOrigin": pairing.last_seen.as_ref().map(|seen| seen.origin.clone()),
        "lastSeenAt": pairing.last_seen.as_ref().map(|seen| seen.at),
    }))
}

/// Mint a new token and write it down. A page holding the old one is refused
/// from the next request on, because every check reads the live value. The
/// pairing log is cleared with it: every record it held names a page whose
/// stored token just stopped working.
#[tauri::command]
pub fn companion_rotate(app: tauri::AppHandle) -> Result<Value, String> {
    let companion = COMPANION
        .get()
        .ok_or_else(|| "companion: not initialised".to_string())?;
    let token = random_token()?;
    write_secret(&token_path(&app)?, &json!({ "token": token }))?;
    *companion
        .token
        .lock()
        .map_err(|_| "companion: state poisoned".to_string())? = token.clone();
    if let Ok(mut pairing) = companion.pairing.lock() {
        *pairing = PairingLog::default();
    }
    Ok(json!({ "token": token }))
}

/// Milliseconds since the epoch, for the pairing log's timestamps only.
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

/// The page's own origin, or a phrase when it sent none. Only an allowlisted
/// origin reaches a handler (the guard refuses the rest), so this is safe to
/// show verbatim in the desktop UI.
fn origin_of(headers: &HeaderMap) -> String {
    headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("a page without an origin")
        .to_string()
}

/// Note a successful pairing, so the desktop says "paired" the moment a page
/// pairs. Display-only: the page still holds the token and the daemon still
/// checks it on every real request.
fn record_pair(state: &CompanionState, headers: &HeaderMap) {
    let seen = SeenOrigin {
        origin: origin_of(headers),
        at: now_ms(),
    };
    if let Ok(mut pairing) = state.pairing.lock() {
        pairing.paired = pairing.paired.saturating_add(1);
        pairing.last_pair = Some(seen.clone());
        pairing.last_seen = Some(seen);
    }
}

/// Note an authenticated request, so the desktop can say a paired page is
/// talking to the app right now (a page keeps its token across restarts and
/// never calls `/v1/pair` again).
fn record_seen(state: &CompanionState, headers: &HeaderMap) {
    if let Ok(mut pairing) = state.pairing.lock() {
        pairing.last_seen = Some(SeenOrigin {
            origin: origin_of(headers),
            at: now_ms(),
        });
    }
}

fn token_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(crate::app_data_dir(app)?.join(COMPANION_FILE))
}

/// Read the token, minting one on first run. A malformed file is rewritten
/// rather than reported: the token is ours to own, and a corrupt one would
/// otherwise disable the feature until the user found the file.
fn load_or_create_token(app: &tauri::AppHandle) -> Result<String, String> {
    let path = token_path(app)?;
    if let Ok(raw) = fs::read_to_string(&path) {
        if let Ok(parsed) = serde_json::from_str::<Value>(&raw) {
            if let Some(token) = parsed.get("token").and_then(Value::as_str) {
                if !token.is_empty() {
                    return Ok(token.to_string());
                }
            }
        }
    }
    let token = random_token()?;
    write_secret(&path, &json!({ "token": token }))?;
    Ok(token)
}

/// 32 bytes from the OS, hex-encoded. `ring` is already in the tree for TLS, so
/// this needs no new crate and no `rand` feature surprise.
fn random_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| "companion: no system randomness available".to_string())?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// Write a secret-bearing JSON file atomically and `0600` on unix. A partial
/// write would leave a token that cannot be read back, so the rename is the
/// commit.
fn write_secret(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("companion: cannot create {parent:?}: {e}"))?;
    }
    let body = serde_json::to_vec_pretty(value).map_err(|e| format!("companion: {e}"))?;
    let tmp = tmp_sibling(path);
    fs::write(&tmp, &body).map_err(|e| format!("companion: cannot write {tmp:?}: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
    }
    fs::rename(&tmp, path).map_err(|e| format!("companion: cannot commit {path:?}: {e}"))
}

/// A sibling temp name unique to this process and this write.
///
/// A fixed `settings.json.tmp` was shared by every writer — two tabs, or a page
/// write racing a token rotation — so one rename could commit the other's bytes
/// or fail outright on Windows. The pid and a counter make each write its own.
pub(crate) fn tmp_sibling(path: &Path) -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let unique = COUNTER.fetch_add(1, Ordering::Relaxed);
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "companion".to_string());
    path.with_file_name(format!(".{name}.{}.{unique}.tmp", std::process::id()))
}

fn router(state: CompanionState) -> Router {
    Router::new()
        .route("/v1/ping", get(ping))
        .route("/v1/pair", post(pair))
        .route(
            "/v1/settings",
            // The settings route keeps its own, smaller cap: the router-wide
            // limit has to accommodate a chat body, which is far bigger.
            get(get_settings)
                .put(put_settings)
                .layer(DefaultBodyLimit::max(MAX_BODY_BYTES)),
        )
        .route("/v1/chat", post(chat))
        // Router-wide cap is the chat-sized one; `/v1/settings` narrows it on
        // its own route, above.
        .layer(DefaultBodyLimit::max(MAX_CHAT_BODY_BYTES))
        // Outermost: every response, including an extractor's own rejection,
        // carries the CORS headers, and the Host/Origin checks run before any
        // handler can read a body.
        .layer(middleware::from_fn_with_state(state.clone(), guard))
        .with_state(state)
}

/// Host, origin, and the preflight. The token is checked in the handlers, never
/// here, because `/v1/ping` and `/v1/pair` must answer without one.
async fn guard(
    State(state): State<CompanionState>,
    request: Request<Body>,
    next: Next,
) -> Response {
    if !host_allowed(request.headers(), state.port) {
        // No CORS header on a refusal: a page must not be able to read it.
        return error(StatusCode::FORBIDDEN, "host not allowed");
    }
    let origin = request
        .headers()
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    if let Some(origin) = origin.as_deref() {
        if !origin_allowed(origin) {
            return error(StatusCode::FORBIDDEN, "origin not allowed");
        }
    }
    if request.method() == Method::OPTIONS {
        return preflight(origin.as_deref());
    }

    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.append(header::VARY, HeaderValue::from_static("Origin"));
    if let Some(origin) = origin.as_deref() {
        if let Ok(value) = HeaderValue::from_str(origin) {
            headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, value);
        }
    }
    response
}

/// Exact match. A suffix or wildcard rule would let `https://aiclient.jyz.land.`
/// or an attacker's lookalike through, and the token is the only other gate.
fn origin_allowed(origin: &str) -> bool {
    if ORIGINS.contains(&origin) {
        return true;
    }
    extra_origins().iter().any(|allowed| allowed == origin)
}

fn extra_origins() -> &'static [String] {
    static EXTRA: OnceLock<Vec<String>> = OnceLock::new();
    EXTRA.get_or_init(|| {
        std::env::var(ORIGINS_ENV)
            .map(|value| {
                value
                    .split(',')
                    .map(str::trim)
                    .filter(|entry| !entry.is_empty())
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default()
    })
}

/// The DNS-rebinding guard: a page served from `evil.test` can resolve that name
/// to `127.0.0.1`, and then the `Origin` header is the attacker's while the
/// connection is local. `Host` is what still names this process.
fn host_allowed(headers: &HeaderMap, port: u16) -> bool {
    let Some(host) = headers.get(header::HOST).and_then(|value| value.to_str().ok()) else {
        return false;
    };
    host == format!("127.0.0.1:{port}") || host == format!("localhost:{port}")
}

/// Chrome's Private Network Access preflight asks before a public page may touch
/// loopback, and it is credentialless: answering it is not authentication.
fn preflight(origin: Option<&str>) -> Response {
    let mut builder = Response::builder()
        .status(StatusCode::NO_CONTENT)
        .header(
            header::ACCESS_CONTROL_ALLOW_METHODS,
            "GET, POST, PUT, OPTIONS",
        )
        .header(
            header::ACCESS_CONTROL_ALLOW_HEADERS,
            "authorization, content-type",
        )
        .header(header::ACCESS_CONTROL_MAX_AGE, "600")
        .header("access-control-allow-private-network", "true")
        .header(header::VARY, "Origin");
    if let Some(origin) = origin {
        builder = builder.header(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
    }
    builder
        .body(Body::empty())
        .unwrap_or_else(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "preflight"))
}

/// Compare without an early exit. Over loopback with a 256-bit token this is
/// not practically exploitable, but a short-circuiting `==` is a timing oracle
/// and the constant-time compare is already in the tree.
fn same_token(candidate: &str, current: &str) -> bool {
    !current.is_empty()
        && ring::constant_time::verify_slices_are_equal(candidate.as_bytes(), current.as_bytes())
            .is_ok()
}

fn authorized(state: &CompanionState, headers: &HeaderMap) -> bool {
    let Some(value) = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };
    let Some(token) = value.strip_prefix("Bearer ") else {
        return false;
    };
    match state.token.lock() {
        Ok(current) => same_token(token, current.as_str()),
        Err(_) => false,
    }
}

fn error(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
}

fn ok_json(value: Value) -> Response {
    (StatusCode::OK, Json(value)).into_response()
}

fn unauthorized() -> Response {
    error(StatusCode::UNAUTHORIZED, "bad or missing token")
}

/// The page's readiness probe. Answers without a token so the page can tell
/// "the app is running but I am not paired" from "the app is not running"; it
/// carries nothing secret — not the token, not the settings.
async fn ping(State(state): State<CompanionState>) -> Response {
    ok_json(json!({
        "app": "ai-client",
        "version": env!("CARGO_PKG_VERSION"),
        "port": state.port,
    }))
}

#[derive(Deserialize)]
struct PairBody {
    token: String,
}

/// Validate a pasted token before the page stores it. Separate from
/// `/v1/settings` so a wrong token gets a sentence rather than an empty read.
async fn pair(
    State(state): State<CompanionState>,
    headers: HeaderMap,
    Json(body): Json<PairBody>,
) -> Response {
    let current = match state.token.lock() {
        Ok(current) => current.clone(),
        Err(_) => return error(StatusCode::INTERNAL_SERVER_ERROR, "companion state poisoned"),
    };
    if same_token(&body.token, &current) {
        record_pair(&state, &headers);
        ok_json(json!({ "ok": true }))
    } else {
        error(StatusCode::UNAUTHORIZED, "bad token")
    }
}

async fn get_settings(State(state): State<CompanionState>, headers: HeaderMap) -> Response {
    if !authorized(&state, &headers) {
        return unauthorized();
    }
    record_seen(&state, &headers);
    match fs::read(&state.settings) {
        Ok(bytes) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(bytes))
            .unwrap_or_else(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "settings")),
        Err(io_error) if io_error.kind() == io::ErrorKind::NotFound => {
            error(StatusCode::NOT_FOUND, "no settings yet")
        }
        Err(io_error) => error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("cannot read settings: {io_error}"),
        ),
    }
}

async fn put_settings(
    State(state): State<CompanionState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if !authorized(&state, &headers) {
        return unauthorized();
    }
    record_seen(&state, &headers);
    if body.len() > MAX_BODY_BYTES {
        return error(StatusCode::PAYLOAD_TOO_LARGE, "settings too large");
    }
    // A page that writes half a settings object would poison the app's own next
    // boot, so the shape is checked before the file is touched.
    if serde_json::from_slice::<Value>(&body).is_err() {
        return error(StatusCode::BAD_REQUEST, "body is not JSON");
    }
    if let Some(parent) = state.settings.parent() {
        if let Err(io_error) = fs::create_dir_all(parent) {
            return error(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("cannot create {parent:?}: {io_error}"),
            );
        }
    }
    let tmp = tmp_sibling(&state.settings);
    if let Err(io_error) = fs::write(&tmp, &body) {
        return error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("cannot write settings: {io_error}"),
        );
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // A settings file holds provider keys; it is the user's alone.
        let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
    }
    if let Err(io_error) = fs::rename(&tmp, &state.settings) {
        return error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("cannot commit settings: {io_error}"),
        );
    }
    ok_json(json!({ "ok": true }))
}

#[derive(Deserialize)]
struct ChatBody {
    url: String,
    #[serde(default)]
    headers: HashMap<String, String>,
    #[serde(default)]
    body: String,
}

/// The forwarder. The page keeps every bit of provider logic — it builds the
/// body and the headers — and this route contributes only what the webview
/// cannot: a request that is not cross-origin from the page's point of view.
async fn chat(
    State(state): State<CompanionState>,
    headers: HeaderMap,
    Json(request): Json<ChatBody>,
) -> Response {
    if !authorized(&state, &headers) {
        return unauthorized();
    }
    record_seen(&state, &headers);
    let Some(origin) = url_origin(&request.url) else {
        return error(StatusCode::BAD_REQUEST, "only http:// and https:// URLs");
    };
    // The SSRF bound: this is a forwarder for the user's configured providers,
    // not a proxy to whatever a page can name.
    if !provider_origins(&state).iter().any(|allowed| allowed == &origin) {
        return error(
            StatusCode::FORBIDDEN,
            "target host is not a configured provider",
        );
    }
    let client = match crate::chat_client() {
        Ok(client) => client,
        Err(message) => return error(StatusCode::INTERNAL_SERVER_ERROR, &message),
    };

    let mut outgoing = client.post(request.url.as_str()).body(request.body);
    for (name, value) in &request.headers {
        if HOP_BY_HOP.contains(&name.to_ascii_lowercase().as_str()) {
            continue;
        }
        // The names come from the page, so they are validated rather than
        // handed to reqwest: an unparsable one would otherwise turn every
        // request into an opaque upstream failure.
        let Ok(name) = HeaderName::from_bytes(name.as_bytes()) else {
            return error(StatusCode::BAD_REQUEST, "invalid header name");
        };
        let Ok(value) = HeaderValue::from_str(value) else {
            return error(StatusCode::BAD_REQUEST, "invalid header value");
        };
        outgoing = outgoing.header(name, value);
    }
    let upstream = match outgoing.send().await {
        Ok(response) => response,
        Err(request_error) => {
            return error(
                StatusCode::BAD_GATEWAY,
                &format!("upstream request failed: {request_error}"),
            )
        }
    };

    let status = StatusCode::from_u16(upstream.status().as_u16())
        .unwrap_or(StatusCode::BAD_GATEWAY);
    let content_type = upstream.headers().get(header::CONTENT_TYPE).cloned();
    // The body is relayed as it arrives: a reply is an event stream, and
    // buffering it would turn a slow answer into a dead one.
    let body = Body::from_stream(futures_util::stream::unfold(
        upstream,
        |mut response| async move {
            match response.chunk().await {
                Ok(Some(chunk)) => Some((Ok::<Bytes, io::Error>(chunk), response)),
                Ok(None) => None,
                Err(read_error) => Some((Err(io::Error::other(read_error)), response)),
            }
        },
    ));
    let mut builder = Response::builder().status(status);
    if let Some(content_type) = content_type {
        builder = builder.header(header::CONTENT_TYPE, content_type);
    }
    builder
        .body(body)
        .unwrap_or_else(|_| error(StatusCode::BAD_GATEWAY, "upstream response"))
}

/// Every origin (scheme, host and effective port) a configured provider points
/// at. An unreadable or empty settings file yields none, which refuses every
/// chat — the page then falls back to its own transport and says why.
///
/// Origin, not host: matching the host alone let a page forward to any port on
/// it, in either scheme, so a provider on `http://127.0.0.1:8787` also granted
/// `https://127.0.0.1:22`. That is wider than "a host a configured provider
/// names", and the point of the bound is to be a forwarder, not a proxy.
fn provider_origins(state: &CompanionState) -> Vec<String> {
    let Ok(raw) = fs::read(&state.settings) else {
        return Vec::new();
    };
    let Ok(parsed) = serde_json::from_slice::<Value>(&raw) else {
        return Vec::new();
    };
    parsed
        .get("providers")
        .and_then(Value::as_array)
        .map(|providers| {
            providers
                .iter()
                .filter_map(|provider| provider.get("baseUrl").and_then(Value::as_str))
                .filter_map(url_origin)
                .collect()
        })
        .unwrap_or_default()
}

/// The origin of an http(s) URL — `scheme://host:port`, with the scheme's
/// default port filled in, host lowercased and any userinfo dropped. `None`
/// for anything that is not http(s) or has no host.
fn url_origin(url: &str) -> Option<String> {
    let lower = url.to_ascii_lowercase();
    let default_port = if lower.starts_with("https://") {
        443
    } else if lower.starts_with("http://") {
        80
    } else {
        return None;
    };
    let host = url_host(url)?;
    let port = url_port(url).unwrap_or(default_port);
    let scheme = if default_port == 443 { "https" } else { "http" };
    Some(format!("{scheme}://{host}:{port}"))
}

/// The explicit port in an http(s) URL's authority, when it carries one. IPv6
/// literals keep their brackets, so the port is whatever follows `]:`.
fn url_port(url: &str) -> Option<u16> {
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))?;
    let authority = rest.split(['/', '?', '#']).next()?;
    let host_port = authority.rsplit('@').next()?;
    let port = if let Some(bracketed) = host_port.strip_prefix('[') {
        bracketed.split_once(']')?.1.strip_prefix(':')?
    } else {
        host_port.split_once(':')?.1
    };
    port.parse().ok()
}

/// The host of an http(s) URL, lowercased, without userinfo or port. Hand-parsed
/// rather than handed to a URL crate: the only question asked of it is "which
/// host is this", and a full parser would be a dependency for that one answer.
fn url_host(url: &str) -> Option<String> {
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))?;
    let authority = rest.split(['/', '?', '#']).next()?;
    if authority.is_empty() {
        return None;
    }
    let host_port = authority.rsplit('@').next()?;
    let host = if let Some(bracketed) = host_port.strip_prefix('[') {
        // IPv6 literal: `[::1]:47821`. A missing closing bracket is malformed,
        // not an address this parser should invent one for.
        let (inner, _) = bracketed.split_once(']')?;
        format!("[{inner}]")
    } else {
        host_port.split(':').next()?.to_string()
    };
    // A single trailing dot is the same host (`example.com.`), so both sides of
    // the allowlist compare through this function and both get the same shape.
    let host = host.trim_end_matches('.').to_string();
    if host.is_empty() {
        None
    } else {
        Some(host.to_ascii_lowercase())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The bound is the origin, so the port and the scheme are part of it: a
    /// provider on `http://127.0.0.1:8787` must not also grant
    /// `https://127.0.0.1:22`.
    #[test]
    fn an_origin_carries_the_scheme_and_the_effective_port() {
        let cases = [
            ("https://api.example.com/v1", "https://api.example.com:443"),
            ("http://api.example.com/v1", "http://api.example.com:80"),
            ("http://127.0.0.1:8787/w/opencode", "http://127.0.0.1:8787"),
            ("https://api.example.com:8443/v1", "https://api.example.com:8443"),
            ("https://API.Example.com./v1", "https://api.example.com:443"),
            ("https://user:pw@api.example.com/v1", "https://api.example.com:443"),
            ("http://[::1]:8787/v1", "http://[::1]:8787"),
            ("ftp://api.example.com", ""),
            ("not a url", ""),
        ];
        for (url, expected) in cases {
            assert_eq!(url_origin(url).unwrap_or_default(), expected, "{url}");
        }
    }

    #[test]
    fn the_same_host_on_another_port_or_scheme_is_not_the_same_origin() {
        let allowed = url_origin("http://127.0.0.1:8787/w/opencode").expect("origin");
        for url in [
            "http://127.0.0.1:1/v1/chat",
            "https://127.0.0.1:22/v1/chat",
            "https://127.0.0.1:8787/v1/chat",
            "http://127.0.0.2:8787/v1/chat",
        ] {
            assert_ne!(url_origin(url).unwrap_or_default(), allowed, "{url}");
        }
    }

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.insert(
                header::HeaderName::from_bytes(name.as_bytes()).expect("a header name"),
                HeaderValue::from_str(value).expect("a header value"),
            );
        }
        map
    }

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "ai-client-companion-{label}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    #[test]
    fn the_host_header_must_name_this_process() {
        assert!(host_allowed(&headers(&[("host", "127.0.0.1:47821")]), 47821));
        assert!(host_allowed(&headers(&[("host", "localhost:47821")]), 47821));
        // DNS rebinding: the Origin is the attacker's, the Host is not ours.
        assert!(!host_allowed(&headers(&[("host", "evil.test:47821")]), 47821));
        // A different port is a different server.
        assert!(!host_allowed(&headers(&[("host", "127.0.0.1:47822")]), 47821));
        assert!(!host_allowed(&headers(&[]), 47821));
    }

    #[test]
    fn only_the_named_origins_pass() {
        assert!(origin_allowed("https://aiclient.jyz.land"));
        assert!(origin_allowed("http://localhost:5173"));
        assert!(!origin_allowed("https://aiclient.jyz.land.evil.test"));
        assert!(!origin_allowed("http://aiclient.jyz.land"));
        assert!(!origin_allowed("null"));
    }

    #[test]
    fn a_host_is_read_without_a_url_crate() {
        assert_eq!(
            url_host("https://api.openai.com/v1/chat/completions"),
            Some("api.openai.com".to_string())
        );
        assert_eq!(
            url_host("http://127.0.0.1:8787/w/opencode/chat"),
            Some("127.0.0.1".to_string())
        );
        assert_eq!(
            url_host("https://user:pw@API.Example.com/x"),
            Some("api.example.com".to_string())
        );
        assert_eq!(url_host("https://[::1]:9000/x"), Some("[::1]".to_string()));
        // A missing closing bracket is malformed, not an address.
        assert_eq!(url_host("https://[::1/x"), None);
        // A trailing dot is the same host on both sides of the allowlist.
        assert_eq!(
            url_host("https://api.example.com./v1"),
            Some("api.example.com".to_string())
        );
        assert_eq!(url_host("file:///etc/passwd"), None);
        assert_eq!(url_host("https://"), None);
    }

    #[test]
    fn a_token_is_written_once_and_read_back() {
        let dir = temp_dir("token");
        let path = dir.join(COMPANION_FILE);
        let token = random_token().expect("a token");
        write_secret(&path, &json!({ "token": token })).expect("write");
        let raw = fs::read_to_string(&path).expect("read");
        let parsed: Value = serde_json::from_str(&raw).expect("json");
        assert_eq!(parsed["token"], json!(token));
        // 32 bytes of hex.
        assert_eq!(token.len(), 64);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&path).expect("metadata").permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "a token file is the user's alone");
        }
        let _ = fs::remove_dir_all(&dir);
    }

    /// One round-trip over a real socket: the guards, the preflight, pairing,
    /// and a settings write/read. Drives the same router production serves.
    #[tokio::test]
    async fn the_router_answers_and_refuses() {
        let dir = temp_dir("router");
        let pairing = Arc::new(Mutex::new(PairingLog::default()));
        let state = CompanionState {
            settings: dir.join(crate::SETTINGS_FILE),
            port: 0,
            token: Arc::new(Mutex::new("test-token".to_string())),
            pairing: pairing.clone(),
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let state = CompanionState { port, ..state };
        let served = router(state);
        let handle = tokio::spawn(async move {
            let _ = axum::serve(listener, served).await;
        });
        let client = reqwest::Client::new();
        let base = format!("http://127.0.0.1:{port}");

        let ping: Value = client
            .get(format!("{base}/v1/ping"))
            .send()
            .await
            .expect("ping")
            .json()
            .await
            .expect("ping json");
        assert_eq!(ping["app"], json!("ai-client"));
        assert_eq!(ping["port"], json!(port));

        // A wrong token is refused, and so is no token.
        assert_eq!(
            client
                .get(format!("{base}/v1/settings"))
                .bearer_auth("wrong")
                .send()
                .await
                .expect("settings")
                .status(),
            StatusCode::UNAUTHORIZED
        );

        // Pairing validates without a read. A refused pairing leaves the log
        // empty; an accepted one records the page for the desktop UI. Neither
        // path ever reads the log back for auth — it is display-only.
        let refused_pair = client
            .post(format!("{base}/v1/pair"))
            .header("origin", "https://aiclient.jyz.land")
            .json(&json!({ "token": "wrong" }))
            .send()
            .await
            .expect("refused pair");
        assert_eq!(refused_pair.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(pairing.lock().expect("pairing").paired, 0);

        let paired = client
            .post(format!("{base}/v1/pair"))
            .header("origin", "https://aiclient.jyz.land")
            .json(&json!({ "token": "test-token" }))
            .send()
            .await
            .expect("pair");
        assert_eq!(paired.status(), StatusCode::OK);
        {
            let log = pairing.lock().expect("pairing");
            assert_eq!(log.paired, 1);
            assert_eq!(
                log.last_pair.as_ref().map(|seen| seen.origin.as_str()),
                Some("https://aiclient.jyz.land")
            );
            assert!(log.last_pair.as_ref().is_some_and(|seen| seen.at > 0));
        }

        // Write then read the settings file through the surface.
        let written = client
            .put(format!("{base}/v1/settings"))
            .bearer_auth("test-token")
            .json(&json!({ "providers": [{ "baseUrl": "https://api.example.com" }] }))
            .send()
            .await
            .expect("put");
        assert_eq!(written.status(), StatusCode::OK);
        let read = client
            .get(format!("{base}/v1/settings"))
            .bearer_auth("test-token")
            .header("origin", "https://aiclient.jyz.land")
            .send()
            .await
            .expect("get");
        assert_eq!(read.status(), StatusCode::OK);
        assert!(read.text().await.expect("body").contains("api.example.com"));
        assert_eq!(
            pairing
                .lock()
                .expect("pairing")
                .last_seen
                .as_ref()
                .map(|seen| seen.origin.as_str()),
            Some("https://aiclient.jyz.land")
        );

        // The preflight is answered for an allowed origin, and refused for one
        // that is not.
        let preflight = client
            .request(reqwest::Method::OPTIONS, format!("{base}/v1/settings"))
            .header("origin", "https://aiclient.jyz.land")
            .header("access-control-request-method", "PUT")
            .send()
            .await
            .expect("preflight");
        assert_eq!(preflight.status(), StatusCode::NO_CONTENT);
        assert_eq!(
            preflight
                .headers()
                .get("access-control-allow-private-network")
                .and_then(|value| value.to_str().ok()),
            Some("true")
        );
        let refused = client
            .get(format!("{base}/v1/ping"))
            .header("origin", "https://evil.test")
            .send()
            .await
            .expect("refused");
        assert_eq!(refused.status(), StatusCode::FORBIDDEN);

        // A forwarder target that is not a configured provider.
        let chat_refused = client
            .post(format!("{base}/v1/chat"))
            .bearer_auth("test-token")
            .json(&json!({
                "url": "https://not-configured.example/x",
                "headers": {},
                "body": "{}",
            }))
            .send()
            .await
            .expect("chat");
        assert_eq!(chat_refused.status(), StatusCode::FORBIDDEN);

        // The settings cap is the small one, and the chat cap is not: a 5 MB
        // chat body is a real conversation, and it must not be refused as if it
        // were an oversized settings document. A fresh client for these: an
        // over-cap body may be refused with a `413` or by dropping the
        // connection mid-upload, and a pooled connection the server already
        // closed would fail for the wrong reason.
        let fresh = reqwest::Client::new();
        let big = "x".repeat(5 * 1024 * 1024);
        let oversized = fresh
            .put(format!("{base}/v1/settings"))
            .bearer_auth("test-token")
            .body(big.clone())
            .header("content-type", "application/json")
            .send()
            .await;
        match oversized {
            Ok(response) => assert_eq!(
                response.status(),
                StatusCode::PAYLOAD_TOO_LARGE,
                "the settings route keeps its own, smaller cap"
            ),
            // Refusing by closing the connection is the other shape of the same
            // answer; what matters is the file below.
            Err(error) => assert!(
                error.is_request() || error.is_body() || error.is_connect(),
                "unexpected failure: {error}"
            ),
        }
        let unchanged = fresh
            .get(format!("{base}/v1/settings"))
            .bearer_auth("test-token")
            .send()
            .await
            .expect("get after an oversized write");
        assert_eq!(unchanged.status(), StatusCode::OK);
        let unchanged = unchanged.text().await.expect("settings body");
        assert!(
            unchanged.contains("api.example.com") && unchanged.len() < 4096,
            "an oversized settings document must never be written"
        );
        let big_chat = fresh
            .post(format!("{base}/v1/chat"))
            .bearer_auth("test-token")
            .json(&json!({
                "url": "https://not-configured.example/x",
                "headers": {},
                "body": big,
            }))
            .send()
            .await
            .expect("big chat");
        assert_eq!(
            big_chat.status(),
            StatusCode::FORBIDDEN,
            "the chat body was read, so the host check — not the size cap — answered"
        );

        // A header name the page made up is a 400, not an opaque upstream
        // failure.
        let bad_header = fresh
            .post(format!("{base}/v1/chat"))
            .bearer_auth("test-token")
            .json(&json!({
                "url": "https://api.example.com/v1/chat/completions",
                "headers": { "bad header": "x" },
                "body": "{}",
            }))
            .send()
            .await
            .expect("bad header");
        assert_eq!(bad_header.status(), StatusCode::BAD_REQUEST);

        handle.abort();
        let _ = fs::remove_dir_all(&dir);
    }
}
