// NeuroClaw's window program for Linux (macOS has its own, scripts/release/macos/NeuroClawHost.swift).
//
// It draws one window around the system's own web view and carries the page's requests to the engine as lines
// on stdout, and the engine's answers back from stdin. It opens no network port and needs no browser.
//   Linux: GTK 3 and WebKitGTK, found at run time with dlopen (nothing is linked in or bundled).
// Windows is not covered yet: Microsoft's WebView2 cannot be reached without WebView2Loader.dll, which is
// Microsoft's SDK code and would need the owner's yes (see docs/PLATFORMS.md).
// Standard library only: no crates. Built with rustc by scripts/build-window-host.mjs.
//
// Exit codes: 0 the window was closed; 3 the system has no web view to use; 4 there is no display.

mod common;
#[cfg(target_os = "linux")]
mod gtk;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let title = args.iter().position(|a| a == "--title").and_then(|i| args.get(i + 1)).cloned().unwrap_or_else(|| "NeuroClaw".to_string());
    #[cfg(target_os = "linux")]
    gtk::run(&title);
    #[cfg(not(target_os = "linux"))]
    {
        let _ = title;
        eprintln!("this window program is for Linux only; macOS uses NeuroClaw.app's own window, and Windows is not covered yet");
        std::process::exit(2);
    }
}
