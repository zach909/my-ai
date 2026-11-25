// What the Windows and Linux window programs share. Standard library only.
//
// The window is a dumb pipe between the system's web view and NeuroClaw's engine. Every request the page makes
// becomes one line on stdout (`Q <id> <METHOD> <target> <headers> <body>`, free text in base64, "-" for empty);
// every answer arrives as one line on stdin (`R <id> <status> <headers> <body>`, `E <id> <message>`,
// `READY`, `FAILED <message>`). The launcher (scripts/desktop-launcher.mjs) carries the lines to the engine.
// The format is documented in interface/platform/embedded-transport.ts.

use std::io::{BufRead, Write};
use std::sync::Mutex;

pub const ORIGIN: &str = "nc://app";

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn b64_encode(data: &[u8]) -> String {
    if data.is_empty() {
        return "-".to_string();
    }
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let n = (chunk[0] as u32) << 16 | (*chunk.get(1).unwrap_or(&0) as u32) << 8 | *chunk.get(2).unwrap_or(&0) as u32;
        out.push(ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(ALPHABET[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { ALPHABET[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { ALPHABET[n as usize & 63] as char } else { '=' });
    }
    out
}

pub fn b64_decode(text: &str) -> Vec<u8> {
    if text == "-" {
        return Vec::new();
    }
    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    let (mut acc, mut bits) = (0u32, 0u32);
    for c in text.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => continue, // '=' padding and anything else
        };
        acc = (acc << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    out
}

/// A line from the engine.
#[derive(Debug, PartialEq)]
pub enum Incoming {
    Ready,
    Failed(String),
    Response { id: u32, status: u16, headers: Vec<(String, String)>, body: Vec<u8> },
    Error { id: u32, message: String },
}

pub fn parse_incoming(line: &str) -> Option<Incoming> {
    let t: Vec<&str> = line.trim().split(' ').collect();
    match t.first().copied()? {
        "READY" => Some(Incoming::Ready),
        "FAILED" => Some(Incoming::Failed(String::from_utf8_lossy(&b64_decode(t.get(1).copied().unwrap_or("-"))).into_owned())),
        "E" if t.len() >= 2 => Some(Incoming::Error {
            id: t[1].parse().ok()?,
            message: String::from_utf8_lossy(&b64_decode(t.get(2).copied().unwrap_or("-"))).into_owned(),
        }),
        "R" if t.len() == 5 => {
            let block = String::from_utf8_lossy(&b64_decode(t[3])).into_owned();
            let headers = block
                .split('\n')
                .filter_map(|l| l.split_once(':').map(|(k, v)| (k.trim().to_string(), v.trim().to_string())))
                .collect();
            Some(Incoming::Response { id: t[1].parse().ok()?, status: t[2].parse().ok()?, headers, body: b64_decode(t[4]) })
        }
        _ => None,
    }
}

static OUT: Mutex<()> = Mutex::new(());

/// Write one request line to the engine (through the launcher). Safe to call from any thread.
pub fn send_request(id: u32, method: &str, target: &str, headers: &[(String, String)], body: &[u8]) {
    let block: String = headers.iter().map(|(k, v)| format!("{k}: {v}")).collect::<Vec<_>>().join("\n");
    let line = format!("Q {id} {method} {} {} {}\n", b64_encode(target.as_bytes()), b64_encode(block.as_bytes()), b64_encode(body));
    let _guard = OUT.lock().unwrap_or_else(|e| e.into_inner());
    let mut out = std::io::stdout().lock();
    let _ = out.write_all(line.as_bytes());
    let _ = out.flush();
}

/// Read engine lines from stdin until it closes, handing each to `deliver`.
pub fn read_engine(mut deliver: impl FnMut(Incoming)) {
    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        match line {
            Ok(l) => {
                if let Some(m) = parse_incoming(&l) {
                    deliver(m);
                }
            }
            Err(_) => break,
        }
    }
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

const STYLE: &str = "body{margin:0;min-height:100vh;display:grid;place-items:center;background:#110c0e;color:#f8ede9;font-family:ui-rounded,'SF Pro Rounded',system-ui,-apple-system,'Segoe UI',sans-serif;padding:16px;box-sizing:border-box}main{max-width:34rem;padding:28px;border:1px solid rgba(255,228,218,.2);border-radius:32px;background:rgba(255,240,232,.08);text-align:center}h1{font-size:1.2rem;margin:0 0 .5rem}p{margin:.4rem 0;color:rgba(248,237,233,.75);overflow-wrap:anywhere}";

/// Shown until the engine says it is ready.
pub fn starting_page() -> String {
    format!("<!doctype html><meta charset=\"utf-8\"><title>NeuroClaw</title><style>{STYLE}</style><main><h1>Starting NeuroClaw</h1><p>One moment.</p></main>")
}

/// Shown when the engine could not start or stopped.
pub fn failure_page(reason: &str) -> String {
    format!("<!doctype html><meta charset=\"utf-8\"><title>NeuroClaw</title><style>{STYLE}</style><main><h1>NeuroClaw could not start</h1><p>{}</p><p>Close this window and open NeuroClaw again. If it keeps happening, send the log file named above with your report.</p></main>", esc(reason))
}

/// The page for an address the window cannot serve (anything not on this app).
pub fn not_found_body() -> Vec<u8> {
    b"Not found".to_vec()
}

/// "scheme://app/path?q" -> "/path?q", or None when the address is not this app's.
pub fn target_of(uri: &str) -> Option<String> {
    let rest = uri.strip_prefix(ORIGIN)?;
    let rest = rest.split('#').next().unwrap_or("");
    if rest.is_empty() {
        Some("/".to_string())
    } else if rest.starts_with('/') {
        Some(rest.to_string())
    } else {
        None
    }
}

/// Only these request headers are passed on: the engine's rules need Content-Type (CSRF guard) and Accept (page or API).
pub const FORWARDED_HEADERS: [&str; 2] = ["Content-Type", "Accept"];

pub fn header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_round_trips_every_length() {
        for n in 0..70usize {
            let data: Vec<u8> = (0..n).map(|i| (i * 37 + 11) as u8).collect();
            assert_eq!(b64_decode(&b64_encode(&data)), data, "length {n}");
        }
        assert_eq!(b64_encode(b""), "-");
        assert_eq!(b64_encode(b"Man"), "TWFu");
        assert_eq!(b64_encode(b"Ma"), "TWE=");
        assert_eq!(b64_decode("TWE="), b"Ma");
    }

    #[test]
    fn engine_lines_parse() {
        assert_eq!(parse_incoming("READY"), Some(Incoming::Ready));
        assert_eq!(parse_incoming(&format!("FAILED {}", b64_encode(b"boom"))), Some(Incoming::Failed("boom".into())));
        let line = format!("R 7 404 {} {}", b64_encode(b"Content-Type: text/plain\nSet-Cookie: a=1"), b64_encode(b"nope"));
        match parse_incoming(&line) {
            Some(Incoming::Response { id: 7, status: 404, headers, body }) => {
                assert_eq!(headers.len(), 2);
                assert_eq!(header(&headers, "content-type"), Some("text/plain"));
                assert_eq!(body, b"nope");
            }
            other => panic!("unexpected {other:?}"),
        }
        assert_eq!(parse_incoming("R 1 200 - -"), Some(Incoming::Response { id: 1, status: 200, headers: vec![], body: vec![] }));
        assert_eq!(parse_incoming(&format!("E 3 {}", b64_encode(b"bad"))), Some(Incoming::Error { id: 3, message: "bad".into() }));
        assert_eq!(parse_incoming("garbage"), None);
    }

    #[test]
    fn only_this_apps_addresses_are_served() {
        assert_eq!(target_of("nc://app"), Some("/".into()));
        assert_eq!(target_of("nc://app/"), Some("/".into()));
        assert_eq!(target_of("nc://app/settings?x=1#top"), Some("/settings?x=1".into()));
        assert_eq!(target_of("nc://other/"), None);
        assert_eq!(target_of("nc://app.evil.example/"), None);
        assert_eq!(target_of("https://example.com/"), None);
    }

    #[test]
    fn failure_text_is_escaped() {
        assert!(failure_page("<script>x</script>").contains("&lt;script&gt;"));
    }
}
