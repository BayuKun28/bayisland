#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UUID="bayisland@baydev"
DEV_DATA_HOME="$(mktemp -d /tmp/bayisland-dev-xdg.XXXXXX)"

cleanup() {
    rm -rf "${DEV_DATA_HOME}"
}
trap cleanup EXIT

echo "==> Compiling GSettings schemas..."
glib-compile-schemas --strict "${PROJECT_DIR}/schemas"

mkdir -p "${DEV_DATA_HOME}/gnome-shell/extensions"
ln -sfn "${PROJECT_DIR}" "${DEV_DATA_HOME}/gnome-shell/extensions/${UUID}"

echo "==> Starting isolated nested GNOME Shell (Wayland)..."
export XDG_DATA_HOME="${DEV_DATA_HOME}"

dbus-run-session -- bash -c '
set -e
gnome-shell --nested --wayland &
SHELL_PID=$!

cleanup_shell() {
    kill "${SHELL_PID}" 2>/dev/null || true
    wait "${SHELL_PID}" 2>/dev/null || true
}
trap cleanup_shell EXIT

for _ in $(seq 1 40); do
    if gdbus introspect --session -d org.gnome.Shell.Extensions -o /org/gnome/Shell/Extensions >/dev/null 2>&1; then
        break
    fi
    sleep 0.25
done

echo "==> Enabling '"${UUID}"' in nested shell..."
gnome-extensions enable '"${UUID}"'

sleep 1.0
echo "==> Dispatching sample banner & Volume OSD preview inside nested D-Bus..."
echo "    (Note: hardware Volume keys hit your host GNOME Shell; use PreviewOsd or scroll the pill here)"
gdbus call --session -d org.bayisland.Shell -o /org/bayisland/Shell \
    -m org.bayisland.Shell.ShowBanner "BayIsland Nested Preview" "5-Tab Hub, Solid Accent & Priority Arbiter Active" "emblem-ok-symbolic" 2600 >/dev/null || true

sleep 2.8
gdbus call --session -d org.bayisland.Shell -o /org/bayisland/Shell \
    -m org.bayisland.Shell.PreviewOsd "audio-volume-high-symbolic" "Volume" 0.68 >/dev/null || true

wait "${SHELL_PID}"
'
