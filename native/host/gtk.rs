// The Linux window: GTK 3 + WebKitGTK, loaded with dlopen so the program has no link-time dependency on either.
// If they are missing it says so and exits with code 3; the launcher turns that into a plain message.

use crate::common::*;
use std::collections::HashMap;
use std::ffi::{c_char, c_int, c_uint, c_ulong, c_void, CStr, CString};
use std::ptr::null_mut;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, OnceLock};

type P = *mut c_void;

extern "C" {
    fn dlopen(file: *const c_char, flags: c_int) -> P;
    fn dlsym(handle: P, name: *const c_char) -> P;
}
const RTLD_NOW: c_int = 2;
const RTLD_GLOBAL: c_int = 0x100;

unsafe fn sym<T: Copy>(libs: &[P], name: &str) -> Option<T> {
    let c = CString::new(name).ok()?;
    for &l in libs {
        let p = dlsym(l, c.as_ptr());
        if !p.is_null() {
            return Some(std::mem::transmute_copy::<P, T>(&p));
        }
    }
    None
}

macro_rules! api {
    ($($name:ident : $ty:ty),* $(,)?) => {
        struct Api { $($name: $ty,)* }
        impl Api {
            unsafe fn load(libs: &[P]) -> Result<Api, String> {
                Ok(Api { $($name: sym::<$ty>(libs, stringify!($name)).ok_or_else(|| format!("missing function {}", stringify!($name)))?,)* })
            }
        }
    };
}

api! {
    gtk_init_check: unsafe extern "C" fn(*mut c_int, P) -> c_int,
    gtk_window_new: unsafe extern "C" fn(c_int) -> P,
    gtk_window_set_title: unsafe extern "C" fn(P, *const c_char),
    gtk_window_set_default_size: unsafe extern "C" fn(P, c_int, c_int),
    gtk_container_add: unsafe extern "C" fn(P, P),
    gtk_widget_show_all: unsafe extern "C" fn(P),
    gtk_main: unsafe extern "C" fn(),
    gtk_main_quit: unsafe extern "C" fn(),
    g_signal_connect_data: unsafe extern "C" fn(P, *const c_char, P, P, P, c_int) -> c_ulong,
    g_idle_add: unsafe extern "C" fn(unsafe extern "C" fn(P) -> c_int, P) -> c_uint,
    g_malloc: unsafe extern "C" fn(usize) -> P,
    g_free: unsafe extern "C" fn(P),
    g_object_ref: unsafe extern "C" fn(P) -> P,
    g_object_unref: unsafe extern "C" fn(P),
    g_memory_input_stream_new_from_data: unsafe extern "C" fn(P, isize, P) -> P,
    g_input_stream_read_all: unsafe extern "C" fn(P, P, usize, *mut usize, P, P) -> c_int,
    g_get_user_special_directory: unsafe extern "C" fn(c_int) -> *const c_char,
    webkit_web_view_new: unsafe extern "C" fn() -> P,
    webkit_web_view_get_context: unsafe extern "C" fn(P) -> P,
    webkit_web_view_load_uri: unsafe extern "C" fn(P, *const c_char),
    webkit_web_view_load_html: unsafe extern "C" fn(P, *const c_char, *const c_char),
    webkit_web_context_register_uri_scheme: unsafe extern "C" fn(P, *const c_char, P, P, P),
    webkit_web_context_get_security_manager: unsafe extern "C" fn(P) -> P,
    webkit_security_manager_register_uri_scheme_as_secure: unsafe extern "C" fn(P, *const c_char),
    webkit_security_manager_register_uri_scheme_as_cors_enabled: unsafe extern "C" fn(P, *const c_char),
    webkit_uri_scheme_request_get_uri: unsafe extern "C" fn(P) -> *const c_char,
    webkit_uri_scheme_request_finish: unsafe extern "C" fn(P, P, i64, *const c_char),
    webkit_policy_decision_ignore: unsafe extern "C" fn(P),
    webkit_policy_decision_download: unsafe extern "C" fn(P),
    webkit_navigation_policy_decision_get_navigation_action: unsafe extern "C" fn(P) -> P,
    webkit_navigation_action_get_request: unsafe extern "C" fn(P) -> P,
    webkit_uri_request_get_uri: unsafe extern "C" fn(P) -> *const c_char,
    webkit_response_policy_decision_get_response: unsafe extern "C" fn(P) -> P,
    webkit_uri_response_get_http_headers: unsafe extern "C" fn(P) -> P,
    webkit_download_set_destination: unsafe extern "C" fn(P, *const c_char),
    soup_message_headers_new: unsafe extern "C" fn(c_int) -> P,
    soup_message_headers_append: unsafe extern "C" fn(P, *const c_char, *const c_char),
    soup_message_headers_get_one: unsafe extern "C" fn(P, *const c_char) -> *const c_char,
}

/// Newer WebKitGTK only: request method, headers and body, and real status codes on answers. Without them
/// pages still load, but a POST cannot carry its body and every answer shows as 200.
struct Optional {
    request_method: Option<unsafe extern "C" fn(P) -> *const c_char>,
    request_headers: Option<unsafe extern "C" fn(P) -> P>,
    request_body: Option<unsafe extern "C" fn(P) -> P>,
    finish_with_response: Option<unsafe extern "C" fn(P, P)>,
    response_new: Option<unsafe extern "C" fn(P, i64) -> P>,
    response_set_status: Option<unsafe extern "C" fn(P, c_uint, *const c_char)>,
    response_set_content_type: Option<unsafe extern "C" fn(P, *const c_char)>,
    response_set_http_headers: Option<unsafe extern "C" fn(P, P)>,
    set_background_color: Option<unsafe extern "C" fn(P, *const [f64; 4])>,
}

struct State {
    api: Api,
    opt: Optional,
    view: usize,
    pending: Mutex<HashMap<u32, usize>>,
    next: AtomicU32,
}
// Only function pointers and addresses; every call into GTK is made on the main thread.
unsafe impl Send for State {}
unsafe impl Sync for State {}

static STATE: OnceLock<State> = OnceLock::new();
fn st() -> &'static State {
    STATE.get().expect("window not started")
}

unsafe fn cstr(p: *const c_char) -> String {
    if p.is_null() { String::new() } else { CStr::from_ptr(p).to_string_lossy().into_owned() }
}
fn c(s: &str) -> CString {
    CString::new(s.replace('\0', "")).unwrap_or_default()
}

enum Msg {
    In(Incoming),
    Quit,
}

fn post(msg: Msg) {
    let s = STATE.get().expect("window not started");
    unsafe { (s.api.g_idle_add)(on_idle, Box::into_raw(Box::new(msg)) as P) };
}

/// Answer one custom-scheme request (main thread only).
unsafe fn finish(req: P, status: u16, headers: &[(String, String)], body: &[u8]) {
    let s = st();
    let buf = (s.api.g_malloc)(body.len().max(1));
    std::ptr::copy_nonoverlapping(body.as_ptr(), buf as *mut u8, body.len());
    let stream = (s.api.g_memory_input_stream_new_from_data)(buf, body.len() as isize, s.api.g_free as P);
    let ctype = c(header(headers, "content-type").unwrap_or("application/octet-stream"));
    let o = &s.opt;
    if let (Some(new), Some(set_status), Some(set_type), Some(set_headers), Some(fin)) =
        (o.response_new, o.response_set_status, o.response_set_content_type, o.response_set_http_headers, o.finish_with_response)
    {
        let resp = new(stream, body.len() as i64);
        set_status(resp, status as c_uint, std::ptr::null());
        set_type(resp, ctype.as_ptr());
        let hs = (s.api.soup_message_headers_new)(1); // SOUP_MESSAGE_HEADERS_RESPONSE
        for (k, v) in headers {
            if k.eq_ignore_ascii_case("content-type") || k.eq_ignore_ascii_case("content-length") {
                continue;
            }
            (s.api.soup_message_headers_append)(hs, c(k).as_ptr(), c(v).as_ptr());
        }
        set_headers(resp, hs); // the response takes ownership of the headers
        fin(req, resp);
        (s.api.g_object_unref)(resp);
    } else {
        (s.api.webkit_uri_scheme_request_finish)(req, stream, body.len() as i64, ctype.as_ptr());
    }
    (s.api.g_object_unref)(stream);
}

unsafe extern "C" fn on_scheme(req: P, _data: P) {
    let s = st();
    let uri = cstr((s.api.webkit_uri_scheme_request_get_uri)(req));
    let Some(target) = target_of(&uri) else {
        finish(req, 404, &[("Content-Type".into(), "text/plain".into())], &not_found_body());
        return;
    };
    let method = s.opt.request_method.map(|f| cstr(f(req))).filter(|m| !m.is_empty()).unwrap_or_else(|| "GET".to_string());
    let mut headers = Vec::new();
    if let Some(get) = s.opt.request_headers {
        let h = get(req);
        if !h.is_null() {
            for name in FORWARDED_HEADERS {
                let v = (s.api.soup_message_headers_get_one)(h, c(name).as_ptr());
                if !v.is_null() {
                    headers.push((name.to_string(), cstr(v)));
                }
            }
        }
    }
    let mut body = Vec::new();
    if method != "GET" && method != "HEAD" {
        match s.opt.request_body {
            Some(get) => {
                let stream = get(req);
                if !stream.is_null() {
                    let mut chunk = vec![0u8; 64 * 1024];
                    loop {
                        let mut n = 0usize;
                        let ok = (s.api.g_input_stream_read_all)(stream, chunk.as_mut_ptr() as P, chunk.len(), &mut n, null_mut(), null_mut());
                        body.extend_from_slice(&chunk[..n]);
                        if ok == 0 || n < chunk.len() {
                            break;
                        }
                    }
                    (s.api.g_object_unref)(stream);
                }
            }
            None => {
                finish(req, 501, &[("Content-Type".into(), "text/plain".into())], b"This WebKitGTK is too old to send a request body (it needs 2.40 or newer).");
                return;
            }
        }
    }
    let id = s.next.fetch_add(1, Ordering::Relaxed);
    (s.api.g_object_ref)(req);
    s.pending.lock().unwrap().insert(id, req as usize);
    send_request(id, &method, &target, &headers, &body);
}

unsafe extern "C" fn on_idle(data: P) -> c_int {
    let s = st();
    match *Box::from_raw(data as *mut Msg) {
        Msg::Quit => (s.api.gtk_main_quit)(),
        Msg::In(Incoming::Ready) => (s.api.webkit_web_view_load_uri)(s.view as P, c(&format!("{ORIGIN}/")).as_ptr()),
        Msg::In(Incoming::Failed(reason)) => (s.api.webkit_web_view_load_html)(s.view as P, c(&failure_page(&reason)).as_ptr(), std::ptr::null()),
        Msg::In(Incoming::Response { id, status, headers, body }) => {
            if let Some(req) = s.pending.lock().unwrap().remove(&id) {
                finish(req as P, status, &headers, &body);
                (s.api.g_object_unref)(req as P);
            }
        }
        Msg::In(Incoming::Error { id, message }) => {
            if let Some(req) = s.pending.lock().unwrap().remove(&id) {
                finish(req as P, 502, &[("Content-Type".into(), "text/plain; charset=utf-8".into())], message.as_bytes());
                (s.api.g_object_unref)(req as P);
            }
        }
    }
    0
}

/// Pages that are not this app's open in the system's own browser, as links in any app do.
fn open_external(uri: &str) {
    let lower = uri.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("mailto:") {
        let _ = std::process::Command::new("xdg-open").arg(uri).spawn();
    }
}

unsafe extern "C" fn on_policy(view: P, decision: P, kind: c_int, _data: P) -> c_int {
    let s = st();
    match kind {
        0 | 1 => {
            // 0 navigation, 1 new window
            let action = (s.api.webkit_navigation_policy_decision_get_navigation_action)(decision);
            let uri = cstr((s.api.webkit_uri_request_get_uri)((s.api.webkit_navigation_action_get_request)(action)));
            let ours = uri.starts_with("nc://") || uri.starts_with("about:") || uri.starts_with("data:") || uri.starts_with("blob:");
            if ours && kind == 0 {
                return 0;
            }
            (s.api.webkit_policy_decision_ignore)(decision);
            if ours {
                (s.api.webkit_web_view_load_uri)(view, c(&uri).as_ptr());
            } else {
                open_external(&uri);
            }
            1
        }
        2 => {
            // A response that says "attachment" is a file to save (exporting chats), not a page.
            let resp = (s.api.webkit_response_policy_decision_get_response)(decision);
            let hs = (s.api.webkit_uri_response_get_http_headers)(resp);
            if !hs.is_null() {
                let d = cstr((s.api.soup_message_headers_get_one)(hs, c("Content-Disposition").as_ptr())).to_ascii_lowercase();
                if d.starts_with("attachment") {
                    (s.api.webkit_policy_decision_download)(decision);
                    return 1;
                }
            }
            0
        }
        _ => 0,
    }
}

fn percent_encode(path: &str) -> String {
    let mut out = String::new();
    for b in path.bytes() {
        if b.is_ascii_alphanumeric() || b"/-._~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// Where a download goes: the person's Downloads folder, never overwriting a file that is already there.
fn download_path(dir: &str, suggested: &str) -> String {
    let name: String = suggested.rsplit(['/', '\\']).next().unwrap_or("").chars().filter(|c| !c.is_control()).collect();
    let name = if name.trim().is_empty() || name == "." || name == ".." { "download".to_string() } else { name };
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (name[..i].to_string(), name[i..].to_string()),
        _ => (name.clone(), String::new()),
    };
    let mut path = format!("{dir}/{name}");
    let mut n = 1;
    while std::path::Path::new(&path).exists() && n < 1000 {
        path = format!("{dir}/{stem} ({n}){ext}");
        n += 1;
    }
    path
}

unsafe extern "C" fn on_destination(_download: P, suggested: *const c_char, _data: P) -> c_int {
    let s = st();
    let dir = {
        let d = cstr((s.api.g_get_user_special_directory)(2)); // G_USER_DIRECTORY_DOWNLOAD
        if d.is_empty() { format!("{}/Downloads", std::env::var("HOME").unwrap_or_default()) } else { d }
    };
    let _ = std::fs::create_dir_all(&dir);
    let uri = format!("file://{}", percent_encode(&download_path(&dir, &cstr(suggested))));
    (s.api.webkit_download_set_destination)(_download, c(&uri).as_ptr());
    1
}

unsafe extern "C" fn on_download_started(_context: P, download: P, _data: P) {
    let s = st();
    (s.api.g_signal_connect_data)(download, c("decide-destination").as_ptr(), on_destination as P, null_mut(), null_mut(), 0);
}

unsafe extern "C" fn on_destroy(_widget: P, _data: P) {
    (st().api.gtk_main_quit)();
}

fn die(code: i32, message: &str) -> ! {
    eprintln!("{message}");
    std::process::exit(code)
}

pub fn run(title: &str) {
    unsafe {
        let open = |name: &str| dlopen(c(name).as_ptr(), RTLD_NOW | RTLD_GLOBAL);
        let gtk_lib = open("libgtk-3.so.0");
        if gtk_lib.is_null() {
            die(3, "GTK 3 (libgtk-3-0) is not installed");
        }
        let web_lib = ["libwebkit2gtk-4.1.so.0", "libwebkit2gtk-4.0.so.37"].iter().map(|n| open(n)).find(|h| !h.is_null());
        let Some(web_lib) = web_lib else { die(3, "WebKitGTK (libwebkit2gtk-4.1-0) is not installed") };
        let libs = [web_lib, gtk_lib];
        let api = match Api::load(&libs) {
            Ok(a) => a,
            Err(e) => die(3, &format!("this WebKitGTK is too old or incompatible: {e}")),
        };
        let opt = Optional {
            request_method: sym(&libs, "webkit_uri_scheme_request_get_http_method"),
            request_headers: sym(&libs, "webkit_uri_scheme_request_get_http_headers"),
            request_body: sym(&libs, "webkit_uri_scheme_request_get_http_body"),
            finish_with_response: sym(&libs, "webkit_uri_scheme_request_finish_with_response"),
            response_new: sym(&libs, "webkit_uri_scheme_response_new"),
            response_set_status: sym(&libs, "webkit_uri_scheme_response_set_status"),
            response_set_content_type: sym(&libs, "webkit_uri_scheme_response_set_content_type"),
            response_set_http_headers: sym(&libs, "webkit_uri_scheme_response_set_http_headers"),
            set_background_color: sym(&libs, "webkit_web_view_set_background_color"),
        };
        if (api.gtk_init_check)(null_mut(), null_mut()) == 0 {
            die(4, "there is no display to open a window on");
        }
        let window = (api.gtk_window_new)(0);
        (api.gtk_window_set_title)(window, c(title).as_ptr());
        (api.gtk_window_set_default_size)(window, 1100, 800);
        let view = (api.webkit_web_view_new)();
        if let Some(set_bg) = opt.set_background_color {
            set_bg(view, &[0.067, 0.047, 0.055, 1.0]);
        }
        let context = (api.webkit_web_view_get_context)(view);
        let scheme = c("nc");
        (api.webkit_web_context_register_uri_scheme)(context, scheme.as_ptr(), on_scheme as P, null_mut(), null_mut());
        let security = (api.webkit_web_context_get_security_manager)(context);
        (api.webkit_security_manager_register_uri_scheme_as_secure)(security, scheme.as_ptr());
        (api.webkit_security_manager_register_uri_scheme_as_cors_enabled)(security, scheme.as_ptr());
        (api.g_signal_connect_data)(view, c("decide-policy").as_ptr(), on_policy as P, null_mut(), null_mut(), 0);
        (api.g_signal_connect_data)(context, c("download-started").as_ptr(), on_download_started as P, null_mut(), null_mut(), 0);
        (api.g_signal_connect_data)(window, c("destroy").as_ptr(), on_destroy as P, null_mut(), null_mut(), 0);
        (api.gtk_container_add)(window, view);
        (api.webkit_web_view_load_html)(view, c(&starting_page()).as_ptr(), std::ptr::null());
        (api.gtk_widget_show_all)(window);

        let gtk_main = api.gtk_main;
        let _ = STATE.set(State { api, opt, view: view as usize, pending: Mutex::new(HashMap::new()), next: AtomicU32::new(1) });
        std::thread::spawn(|| {
            read_engine(|m| post(Msg::In(m)));
            post(Msg::Quit); // the launcher closed its end: the app is shutting down
        });
        gtk_main();
    }
    std::process::exit(0);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn downloads_never_overwrite_and_never_escape() {
        let dir = std::env::temp_dir().join(format!("nc-dl-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let d = dir.to_str().unwrap();
        assert_eq!(download_path(d, "../../etc/passwd"), format!("{d}/passwd"));
        assert_eq!(download_path(d, ""), format!("{d}/download"));
        std::fs::write(format!("{d}/chats.json"), "x").unwrap();
        assert_eq!(download_path(d, "chats.json"), format!("{d}/chats (1).json"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn paths_become_file_uris() {
        assert_eq!(percent_encode("/home/a b/ü.txt"), "/home/a%20b/%C3%BC.txt");
    }
}
