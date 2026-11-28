#!/bin/sh
# NeuroClaw installer, shipped inside every Linux package as <app>/scripts/install.sh.
#
#   install.sh --system   run by the .deb's postinst (as root): check the install, refresh the menu and icon caches
#   install.sh --user     per-user install from the unpacked .tar.gz: command, menu entry and icon under ~/.local
#   install.sh --remove   undo --user
#
# POSIX sh and tools every desktop has. It starts no service, opens no port, downloads nothing and changes nothing
# outside the package's own files (--system) or ~/.local (--user). The app is started with `neuroclaw`, which is
# the same as `npm run app` in the source tree: the launcher runs the engine and opens its own window.
set -eu

mode="${1:---system}"
here=$(cd "$(dirname "$0")" && pwd)           # <root>/app/scripts
app=$(dirname "$here")                         # <root>/app
root=$(dirname "$app")                         # <root>   (/opt/neuroclaw for the .deb)

say() { printf '  %s\n' "$*"; }
warn() { printf '  ! %s\n' "$*" >&2; }

check_install() {
  [ -x "$root/runtime/node" ] || { warn "the bundled Node runtime is missing or not executable: $root/runtime/node"; return 1; }
  [ -f "$app/scripts/desktop-launcher.mjs" ] || { warn "the launcher is missing: $app/scripts/desktop-launcher.mjs"; return 1; }
  "$root/runtime/node" -e 'process.exit(0)' || { warn "the bundled Node runtime does not start on this machine"; return 1; }
  if [ -x "$root/runtime/neuroclaw-window" ]; then
    command -v ldconfig >/dev/null 2>&1 && ! ldconfig -p 2>/dev/null | grep -q 'libwebkit2gtk-4' \
      && warn "WebKitGTK was not found: install libwebkit2gtk-4.1-0 so the app can open its window"
  fi
  return 0
}

refresh_caches() {
  prefix="$1"
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database -q "$prefix/applications" 2>/dev/null || true
  command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -q -t -f "$prefix/icons/hicolor" 2>/dev/null || true
}

case "$mode" in
  --system)
    say "NeuroClaw: checking the install in $root"
    check_install || exit 1
    refresh_caches /usr/share
    say "NeuroClaw is installed. Open it from the application menu, or run: neuroclaw"
    ;;
  --user)
    say "NeuroClaw: installing for $(id -un) under ~/.local"
    check_install || exit 1
    bin="${HOME}/.local/bin"; share="${XDG_DATA_HOME:-$HOME/.local/share}"
    mkdir -p "$bin" "$share/applications" "$share/icons/hicolor/256x256/apps"
    printf '#!/bin/sh\nexec "%s/runtime/node" "%s/app/scripts/desktop-launcher.mjs" "$@"\n' "$root" "$root" > "$bin/neuroclaw"
    chmod 755 "$bin/neuroclaw"
    [ -f "$root/neuroclaw.png" ] && cp "$root/neuroclaw.png" "$share/icons/hicolor/256x256/apps/neuroclaw.png"
    if [ -f "$root/neuroclaw.desktop" ]; then
      sed "s|^Exec=.*|Exec=$bin/neuroclaw|" "$root/neuroclaw.desktop" > "$share/applications/neuroclaw.desktop"
    fi
    refresh_caches "$share"
    say "Done. Open NeuroClaw from your application menu, or run: $bin/neuroclaw"
    case ":$PATH:" in *":$bin:"*) ;; *) say "(add $bin to your PATH to run it by name)";; esac
    ;;
  --remove)
    bin="${HOME}/.local/bin"; share="${XDG_DATA_HOME:-$HOME/.local/share}"
    rm -f "$bin/neuroclaw" "$share/applications/neuroclaw.desktop" "$share/icons/hicolor/256x256/apps/neuroclaw.png"
    refresh_caches "$share"
    say "NeuroClaw removed from ~/.local. Your data in ~/.neuroclaw was kept."
    ;;
  *) warn "usage: install.sh [--system | --user | --remove]"; exit 2 ;;
esac
