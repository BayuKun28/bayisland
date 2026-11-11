#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UUID="bayisland@baydev"
EXT_DIR="${HOME}/.local/share/gnome-shell/extensions"
TARGET="${EXT_DIR}/${UUID}"

echo "==> Compiling GSettings schemas..."
glib-compile-schemas --strict "${PROJECT_DIR}/schemas"

mkdir -p "${EXT_DIR}"

if [[ "${1:-}" == "--copy" ]]; then
    echo "==> Copying extension files to ${TARGET}..."
    rm -rf "${TARGET}"
    mkdir -p "${TARGET}"
    cp -a "${PROJECT_DIR}/metadata.json" "${PROJECT_DIR}/stylesheet.css" \
        "${PROJECT_DIR}/extension.js" "${PROJECT_DIR}/prefs.js" \
        "${PROJECT_DIR}/schemas" "${PROJECT_DIR}/src" "${TARGET}/"
else
    echo "==> Linking ${PROJECT_DIR} -> ${TARGET}..."
    if [[ -d "${TARGET}" && ! -L "${TARGET}" ]]; then
        BACKUP="${TARGET}.bak.$(date +%Y%m%d%H%M%S)"
        echo "    Moving existing non-symlink directory to ${BACKUP}"
        mv "${TARGET}" "${BACKUP}"
    fi
    ln -sfn "${PROJECT_DIR}" "${TARGET}"
fi

echo "==> Checking GNOME Shell extension discovery..."
if gnome-extensions info "${UUID}" >/dev/null 2>&1; then
    echo "==> Extension discovered by GNOME Shell. Enabling ${UUID}..."
    gnome-extensions enable "${UUID}" || true
    gnome-extensions info "${UUID}" | sed 's/^/    /'
else
    echo "==> Installed at ${TARGET}."
    echo "    Note: Because GNOME Shell is running on Wayland, newly added extension"
    echo "    directories are scanned at login. Log out & back in once, then run:"
    echo "      gnome-extensions enable ${UUID}"
fi
