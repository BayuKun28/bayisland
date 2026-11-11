import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix?version=2.0';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

import { IslandState, Weights } from '../core/PriorityManager.js';

const BRIDGE_TITLE = '__bayisland_dnd_bridge__';

function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0)
        return '';
    if (bytes < 1024)
        return `${bytes} B`;
    if (bytes < 1024 * 1024)
        return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024)
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function guessIconName(contentType, isDir) {
    if (isDir)
        return 'folder-symbolic';
    const ct = (contentType || '').toLowerCase();
    if (ct.startsWith('image/'))
        return 'image-x-generic-symbolic';
    if (ct.startsWith('audio/'))
        return 'audio-x-generic-symbolic';
    if (ct.startsWith('video/'))
        return 'video-x-generic-symbolic';
    if (ct.includes('pdf'))
        return 'application-pdf-symbolic';
    if (ct.includes('zip') || ct.includes('tar') || ct.includes('gzip') || ct.includes('xz'))
        return 'package-x-generic-symbolic';
    if (ct.startsWith('text/') || ct.includes('json') || ct.includes('xml') || ct.includes('javascript'))
        return 'text-x-generic-symbolic';
    return 'text-x-generic-symbolic';
}

/**
 * Manages the BayIsland Drag & Drop File Shelf:
 * - Native Wayland Drag-In & Drag-Out via on-demand GTK4 Meta.WaylandClient bridge
 * - Instant File Clipboard Copy (x-special/gnome-copied-files + text/uri-list)
 * - Auto-Stash Screenshot monitor via Gio.FileMonitor
 * - Auto-reveal Drop Catcher via Main.xdndHandler / global.backend.get_dnd()
 */
export class DropShelfManager extends Signals.EventEmitter {
    constructor({ extensionDir, timers, priority, getBridgeRect }) {
        super();
        this._extensionDir = extensionDir;
        this._timers = timers;
        this._priority = priority;
        this._getBridgeRect = getBridgeRect;

        this._enabled = false;
        this._dragReveal = true;
        this._screenshotAutoStash = true;

        this._items = [];
        this._nextId = 1;
        this._pickerOpen = false;
        this._dragOutActive = false;

        this._dndSignals = [];
        this._dndObj = null;
        this._dragLeaveTimerId = 0;

        this._waylandClient = null;
        this._subprocess = null;
        this._stdinStream = null;
        this._stdoutStream = null;
        this._bridgeMetaWin = null;
        this._wmMapSigId = 0;
        this._bridgePosTimerId = 0;
        this._pointerInBridge = false;
        this._bridgeReady = false;
        this._lastShowGeometry = null;

        this._ssMonitor = null;
        this._ssMonitorSigId = 0;
        this._seenScreenshots = new Set();

        this._dataDir = GLib.build_filenamev([GLib.get_user_data_dir(), 'bayisland']);
        this._storePath = GLib.build_filenamev([this._dataDir, 'shelf.json']);
        this._cacheDir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'bayisland', 'shelf']);
    }

    setEnabled(enabled) {
        const want = Boolean(enabled);
        if (want === this._enabled)
            return;
        this._enabled = want;
        if (want)
            this._start();
        else
            this._stop();
    }

    setOptions({ dragReveal, screenshotAutoStash }) {
        if (dragReveal !== undefined)
            this._dragReveal = Boolean(dragReveal);
        if (screenshotAutoStash !== undefined) {
            const next = Boolean(screenshotAutoStash);
            if (next !== this._screenshotAutoStash) {
                this._screenshotAutoStash = next;
                if (this._enabled) {
                    if (next)
                        this._startScreenshotMonitor();
                    else
                        this._stopScreenshotMonitor();
                }
            }
        }
    }

    isModalLockActive() {
        return this._pickerOpen || this._dragOutActive;
    }

    isPickerOpen() {
        return this._pickerOpen;
    }

    isPointerInBridge() {
        return this._pointerInBridge;
    }

    getSnapshot() {
        return {
            enabled: this._enabled,
            screenshotAutoStash: this._screenshotAutoStash,
            items: this._items.map(it => ({ ...it })),
        };
    }

    addUris(uris, { source = 'drop', showToast = false } = {}) {
        if (!Array.isArray(uris) || uris.length === 0)
            return 0;

        let added = 0;
        for (const rawUri of uris) {
            const uri = rawUri?.trim();
            if (!uri)
                continue;
            const file = uri.startsWith('/') ? Gio.File.new_for_path(uri) : Gio.File.new_for_uri(uri);
            const normUri = file.get_uri();
            if (this._items.some(i => i.uri === normUri))
                continue;

            const info = this._readFileMeta(file);
            this._items.unshift({
                id: `shelf-${this._nextId++}`,
                kind: 'file',
                uri: normUri,
                path: file.get_path() || '',
                name: info.name,
                sizeBytes: info.sizeBytes,
                sizeLabel: formatBytes(info.sizeBytes),
                mimeType: info.mimeType,
                iconName: info.iconName,
                isTempCopy: false,
                source,
                pinned: false,
                addedAtMs: Date.now(),
            });
            added++;
        }

        if (added > 0) {
            this._saveToDisk();
            this._publishChanged();
            this._syncBridgeItemsIfVisible();
            if (showToast) {
                this._priority?.pushTransient({
                    kind: 'banner',
                    weight: Weights.NOTIFICATION - 5,
                    coalesceKey: 'shelf-added',
                    title: added === 1 ? `Stashed: ${this._items[0].name}` : `${added} files stashed to Shelf`,
                    body: 'Open Shelf tab to drag out or press Ctrl+V',
                    iconName: 'folder-download-symbolic',
                    iconColor: '#93c5fd',
                    durationMs: 2600,
                });
            }
        }
        return added;
    }

    addTextSnippet(text) {
        const clean = typeof text === 'string' ? text.trim() : '';
        if (!clean)
            return false;

        try {
            GLib.mkdir_with_parents(this._cacheDir, 0o700);
            const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(11, 19);
            const path = GLib.build_filenamev([this._cacheDir, `snippet-${stamp}.txt`]);
            GLib.file_set_contents(path, clean);
            const file = Gio.File.new_for_path(path);
            this._items.unshift({
                id: `shelf-${this._nextId++}`,
                kind: 'file',
                uri: file.get_uri(),
                path,
                name: `snippet-${stamp}.txt`,
                sizeBytes: clean.length,
                sizeLabel: formatBytes(clean.length),
                mimeType: 'text/plain',
                iconName: 'text-x-generic-symbolic',
                isTempCopy: true,
                source: 'drop-text',
                pinned: false,
                addedAtMs: Date.now(),
            });
            this._saveToDisk();
            this._publishChanged();
            this._syncBridgeItemsIfVisible();
            return true;
        } catch (e) {
            logError(e, 'BayIsland failed to stash dropped snippet');
            return false;
        }
    }

    copyItemFilesToClipboard(id) {
        const item = this._items.find(i => i.id === id);
        if (!item)
            return;
        this._writeUrisToClipboard([item.uri]);
    }

    copyAllFilesToClipboard() {
        const uris = this._items.map(i => i.uri).filter(Boolean);
        if (uris.length > 0)
            this._writeUrisToClipboard(uris);
    }

    _writeUrisToClipboard(uris) {
        try {
            const clipboard = St.Clipboard.get_default();
            const uriListPayload = `${uris.join('\r\n')}\r\n`;
            const gnomeCopyPayload = `copy\n${uris.join('\n')}`;
            const enc = new TextEncoder();

            clipboard.set_content(
                St.ClipboardType.CLIPBOARD,
                'x-special/gnome-copied-files',
                GLib.Bytes.new(enc.encode(gnomeCopyPayload))
            );
            clipboard.set_content(
                St.ClipboardType.CLIPBOARD,
                'text/uri-list',
                GLib.Bytes.new(enc.encode(uriListPayload))
            );
        } catch (e) {
            logError(e, 'BayIsland failed to copy file URIs to clipboard');
        }
    }

    openItem(id) {
        const item = this._items.find(i => i.id === id);
        if (!item?.uri)
            return;
        try {
            Gio.AppInfo.launch_default_for_uri(item.uri, global.create_app_launch_context(0, -1));
        } catch (e) {
            logError(e, 'BayIsland failed to open shelf item');
        }
    }

    togglePin(id) {
        const item = this._items.find(i => i.id === id);
        if (!item)
            return;
        item.pinned = !item.pinned;
        this._saveToDisk();
        this._publishChanged();
    }

    removeItem(id) {
        const idx = this._items.findIndex(i => i.id === id);
        if (idx === -1)
            return;
        const [removed] = this._items.splice(idx, 1);
        if (removed?.isTempCopy && removed.path) {
            try {
                Gio.File.new_for_path(removed.path).delete(null);
            } catch {
                // Best effort cleanup
            }
        }
        this._saveToDisk();
        this._publishChanged();
        this._syncBridgeItemsIfVisible();
    }

    clearUnpinned() {
        const kept = [];
        for (const item of this._items) {
            if (item.pinned) {
                kept.push(item);
            } else if (item.isTempCopy && item.path) {
                try { Gio.File.new_for_path(item.path).delete(null); } catch {}
            }
        }
        this._items = kept;
        this._saveToDisk();
        this._publishChanged();
        this._syncBridgeItemsIfVisible();
    }

    openFilePicker() {
        if (!this._enabled)
            return;
        this._ensureBridgeProcess();
        this._pickerOpen = true;
        this.emit('bridge-activity', { kind: 'picker-open' });
        this._sendBridge({ cmd: 'pick-files' });
    }

    syncWithUiState(model, bridgeRect) {
        if (!this._enabled) {
            this._hideBridge();
            return;
        }

        const needsBridge =
            model.state === IslandState.DROP_CATCH ||
            (model.state === IslandState.EXPANDED_MODAL && model.tab === 'shelf');

        if (!needsBridge || !bridgeRect || bridgeRect.width <= 0 || bridgeRect.height <= 0) {
            if (!this._pickerOpen && !this._dragOutActive)
                this._hideBridge();
            return;
        }

        this._ensureBridgeProcess();
        this._lastShowGeometry = bridgeRect;

        const mode = model.state === IslandState.DROP_CATCH ? 'drop-catch' : 'shelf';
        const dragRows = this._items.slice(0, 6).map(it => ({
            id: it.id,
            uri: it.uri,
            iconName: it.iconName,
        }));

        this._sendBridge({
            cmd: 'show',
            mode,
            x: Math.round(bridgeRect.x),
            y: Math.round(bridgeRect.y),
            width: Math.round(bridgeRect.width),
            height: Math.round(bridgeRect.height),
            dropHeight: Math.round(bridgeRect.dropHeight ?? bridgeRect.height),
            rowHeight: Math.round(bridgeRect.rowHeight ?? 44),
            dragZoneWidth: Math.round(bridgeRect.dragZoneWidth ?? (bridgeRect.width - 160)),
            items: dragRows,
        });

        this._positionBridgeWindow(bridgeRect);
    }

    _readFileMeta(file) {
        let name = file.get_basename?.() || 'File';
        let sizeBytes = -1;
        let mimeType = '';
        let isDir = false;
        try {
            const info = file.query_info(
                'standard::display-name,standard::size,standard::content-type,standard::type',
                Gio.FileQueryInfoFlags.NONE,
                null
            );
            name = info.get_display_name() || name;
            sizeBytes = info.get_size();
            mimeType = info.get_content_type() || '';
            isDir = info.get_file_type() === Gio.FileType.DIRECTORY;
        } catch {
            // Fallback defaults
        }
        return {
            name,
            sizeBytes,
            mimeType,
            iconName: guessIconName(mimeType, isDir),
        };
    }

    _start() {
        this._loadFromDisk();
        this._publishChanged();
        this._connectDndMonitor();
        if (this._screenshotAutoStash)
            this._startScreenshotMonitor();
    }

    _connectDndMonitor() {
        try {
            const dnd = global.backend?.get_dnd?.();
            if (!dnd)
                return;
            this._dndObj = dnd;

            const onPos = (_dnd, x, y) => {
                if (!this._enabled || !this._dragReveal || this._dragOutActive)
                    return;
                const model = this._priority?.getModel();
                if (model?.state === IslandState.EXPANDED_MODAL)
                    return;

                const mon = Main.layoutManager.primaryMonitor;
                if (!mon)
                    return;
                const centerX = mon.x + mon.width / 2;
                const topLimit = mon.y + 110;
                const inTopCatch = Math.abs(x - centerX) <= 190 && y >= mon.y && y <= topLimit;

                if (inTopCatch) {
                    if (this._dragLeaveTimerId) {
                        this._timers.clear(this._dragLeaveTimerId);
                        this._dragLeaveTimerId = 0;
                    }
                    this._priority?.setDragCatch(true, model?.meta?.dragHighlight);
                } else if (model?.state === IslandState.DROP_CATCH) {
                    if (!this._dragLeaveTimerId) {
                        this._dragLeaveTimerId = this._timers.setTimeout(240, () => {
                            this._dragLeaveTimerId = 0;
                            this._priority?.setDragCatch(false, false);
                        });
                    }
                }
            };

            const onLeave = () => {
                if (this._dragLeaveTimerId) {
                    this._timers.clear(this._dragLeaveTimerId);
                    this._dragLeaveTimerId = 0;
                }
                const model = this._priority?.getModel();
                if (model?.state === IslandState.DROP_CATCH) {
                    this._dragLeaveTimerId = this._timers.setTimeout(260, () => {
                        this._dragLeaveTimerId = 0;
                        this._priority?.setDragCatch(false, false);
                    });
                }
            };

            this._dndSignals.push(
                dnd.connect('dnd-position-change', onPos),
                dnd.connect('dnd-leave', onLeave)
            );
        } catch {
            // Optional under headless backend
        }
    }

    _startScreenshotMonitor() {
        this._stopScreenshotMonitor();
        try {
            const picDir = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES);
            if (!picDir)
                return;
            const ssPath = GLib.build_filenamev([picDir, 'Screenshots']);
            const dir = Gio.File.new_for_path(ssPath);
            if (!dir.query_exists(null))
                return;

            this._ssMonitor = dir.monitor_directory(Gio.FileMonitorFlags.NONE, null);
            this._ssMonitorSigId = this._ssMonitor.connect('changed', (_mon, file, _other, eventType) => {
                if (!this._enabled || !this._screenshotAutoStash)
                    return;
                if (eventType !== Gio.FileMonitorEvent.CHANGES_DONE_HINT &&
                    eventType !== Gio.FileMonitorEvent.CREATED)
                    return;

                const name = file?.get_basename?.() || '';
                if (!/\.(png|jpe?g|webp)$/i.test(name))
                    return;
                const uri = file.get_uri();
                if (this._seenScreenshots.has(uri))
                    return;
                this._seenScreenshots.add(uri);
                if (this._seenScreenshots.size > 40)
                    this._seenScreenshots.clear();

                // Brief delay so PNG write finishes cleanly before metadata query
                this._timers.setTimeout(180, () => {
                    if (this._enabled && file.query_exists(null))
                        this.addUris([uri], { source: 'screenshot', showToast: true });
                });
            });
        } catch {
            // Optional screenshot monitor
        }
    }

    _stopScreenshotMonitor() {
        if (this._ssMonitor && this._ssMonitorSigId) {
            try { this._ssMonitor.disconnect(this._ssMonitorSigId); } catch {}
            this._ssMonitorSigId = 0;
        }
        try { this._ssMonitor?.cancel(); } catch {}
        this._ssMonitor = null;
    }

    _ensureBridgeProcess() {
        if (this._subprocess)
            return;

        const helperPath = `${this._extensionDir}/src/helpers/dnd-bridge.js`;
        const flags = Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE;
        const launcher = new Gio.SubprocessLauncher({ flags });

        if (Meta.is_wayland_compositor()) {
            try {
                try {
                    this._waylandClient = Meta.WaylandClient.new(global.context, launcher);
                } catch {
                    this._waylandClient = Meta.WaylandClient.new(launcher);
                }
                this._subprocess = this._waylandClient.spawnv(global.display, ['/usr/bin/gjs', '-m', helperPath]);
            } catch (e) {
                logError(e, 'BayIsland WaylandClient spawnv failed; falling back to launcher');
                this._waylandClient = null;
                this._subprocess = launcher.spawnv(['/usr/bin/gjs', '-m', helperPath]);
            }
        } else {
            this._subprocess = launcher.spawnv(['/usr/bin/gjs', '-m', helperPath]);
        }

        try { launcher.close?.(); } catch {}

        if (!this._subprocess)
            return;

        // Ensure GioUnix stream types are registered in GJS before wrapping subprocess pipes.
        void GioUnix.InputStream;
        void GioUnix.OutputStream;

        this._stdinStream = new Gio.DataOutputStream({
            base_stream: this._subprocess.get_stdin_pipe(),
        });
        this._stdoutStream = new Gio.DataInputStream({
            base_stream: this._subprocess.get_stdout_pipe(),
        });

        if (!this._wmMapSigId) {
            this._wmMapSigId = global.window_manager.connect_after('map', (_wm, windowActor) => {
                const metaWin = windowActor?.get_meta_window?.();
                if (!metaWin)
                    return;
                const ownedByUs = this._waylandClient?.owns_window?.(metaWin) ||
                    metaWin.get_title?.() === BRIDGE_TITLE;
                if (!ownedByUs)
                    return;

                this._bridgeMetaWin = metaWin;
                if (this._bridgePosTimerId) {
                    this._timers.clear(this._bridgePosTimerId);
                    this._bridgePosTimerId = 0;
                }
                this._bridgePosTimerId = this._timers.setTimeout(16, () => {
                    this._bridgePosTimerId = 0;
                    const win = this._bridgeMetaWin;
                    if (!win || !this._enabled || !win.get_compositor_private?.())
                        return;
                    try {
                        this._waylandClient?.hide_from_window_list(win);
                        win.make_above();
                        win.stick();
                    } catch {
                        // Best effort
                    }
                    if (this._lastShowGeometry)
                        this._positionBridgeWindow(this._lastShowGeometry);
                });
            });
        }

        this._readBridgeStdoutLoop();

        this._subprocess.wait_async(null, () => {
            if (this._bridgePosTimerId) {
                this._timers.clear(this._bridgePosTimerId);
                this._bridgePosTimerId = 0;
            }
            this._subprocess = null;
            this._waylandClient = null;
            this._stdinStream = null;
            this._stdoutStream = null;
            this._bridgeMetaWin = null;
            this._bridgeReady = false;
            this._pickerOpen = false;
            this._dragOutActive = false;
            this._pointerInBridge = false;
        });
    }

    _positionBridgeWindow(rect) {
        const win = this._bridgeMetaWin;
        if (!win || !rect || !win.get_compositor_private?.())
            return;
        try {
            this._waylandClient?.hide_from_window_list(win);
            win.make_above();
            win.stick();
            win.move_frame(
                true,
                Math.round(rect.x),
                Math.round(rect.y)
            );
        } catch {
            // Wayland frame not ready or unmapped
        }
    }

    _readBridgeStdoutLoop() {
        const stream = this._stdoutStream;
        if (!stream)
            return;

        stream.read_line_async(GLib.PRIORITY_DEFAULT, null, (s, res) => {
            try {
                const [line] = s.read_line_finish_utf8(res);
                if (line === null)
                    return;
                this._onBridgeEvent(line.trim());
                if (this._stdoutStream === stream)
                    this._readBridgeStdoutLoop();
            } catch {
                // Stream closed
            }
        });
    }

    _onBridgeEvent(line) {
        if (!line)
            return;
        let msg;
        try {
            msg = JSON.parse(line);
        } catch {
            return;
        }

        switch (msg.event) {
        case 'ready':
            this._bridgeReady = true;
            break;
        case 'shown':
            if (this._lastShowGeometry)
                this._positionBridgeWindow(this._lastShowGeometry);
            break;
        case 'drag-enter':
            this._priority?.setDragCatch(
                this._priority.getModel()?.state === IslandState.DROP_CATCH,
                true
            );
            break;
        case 'drag-leave':
            this._priority?.updateMeta({ dragHighlight: false }, { inPlaceHint: true });
            break;
        case 'drop':
            if (Array.isArray(msg.uris) && msg.uris.length > 0)
                this.addUris(msg.uris, { source: 'drop', showToast: false });
            else if (msg.text)
                this.addTextSnippet(msg.text);

            if (this._priority?.getModel()?.state === IslandState.DROP_CATCH)
                this._priority.expand('shelf');
            break;
        case 'pointer-enter':
            this._pointerInBridge = true;
            this.emit('bridge-activity', { kind: 'pointer-enter' });
            break;
        case 'pointer-leave':
            this._pointerInBridge = false;
            this.emit('bridge-activity', { kind: 'pointer-leave' });
            break;
        case 'drag-out-begin':
            this._dragOutActive = true;
            this.emit('bridge-activity', { kind: 'drag-out-begin' });
            break;
        case 'drag-out-end':
            this._dragOutActive = false;
            this.emit('bridge-activity', { kind: 'drag-out-end' });
            break;
        case 'picker-open':
            this._pickerOpen = true;
            this.emit('bridge-activity', { kind: 'picker-open' });
            break;
        case 'picker-result':
            this._pickerOpen = false;
            if (Array.isArray(msg.uris) && msg.uris.length > 0)
                this.addUris(msg.uris, { source: 'picker', showToast: false });
            this.emit('bridge-activity', { kind: 'picker-result' });
            break;
        }
    }

    _syncBridgeItemsIfVisible() {
        const model = this._priority?.getModel();
        if (model?.state === IslandState.EXPANDED_MODAL && model.tab === 'shelf' && this._lastShowGeometry)
            this.syncWithUiState(model, this._lastShowGeometry);
    }

    _sendBridge(obj) {
        if (!this._stdinStream)
            return;
        try {
            this._stdinStream.put_string(`${JSON.stringify(obj)}\n`, null);
            this._stdinStream.flush(null);
        } catch {
            // Subprocess closed
        }
    }

    _hideBridge() {
        this._lastShowGeometry = null;
        this._pointerInBridge = false;
        if (this._bridgePosTimerId) {
            this._timers.clear(this._bridgePosTimerId);
            this._bridgePosTimerId = 0;
        }
        if (this._subprocess)
            this._sendBridge({ cmd: 'hide' });
    }

    _killBridge() {
        if (this._bridgePosTimerId) {
            this._timers.clear(this._bridgePosTimerId);
            this._bridgePosTimerId = 0;
        }
        if (this._wmMapSigId) {
            try { global.window_manager.disconnect(this._wmMapSigId); } catch {}
            this._wmMapSigId = 0;
        }
        if (this._subprocess) {
            this._sendBridge({ cmd: 'quit' });
            try { this._subprocess.force_exit(); } catch {}
        }
        this._subprocess = null;
        this._waylandClient = null;
        this._stdinStream = null;
        this._stdoutStream = null;
        this._bridgeMetaWin = null;
        this._bridgeReady = false;
        this._pointerInBridge = false;
    }

    _loadFromDisk() {
        try {
            const file = Gio.File.new_for_path(this._storePath);
            if (!file.query_exists(null))
                return;
            const [ok, bytes] = file.load_contents(null);
            if (!ok)
                return;
            const arr = JSON.parse(new TextDecoder().decode(bytes));
            if (!Array.isArray(arr))
                return;

            this._items = arr
                .filter(it => it && typeof it.uri === 'string')
                .filter(it => {
                    try {
                        return Gio.File.new_for_uri(it.uri).query_exists(null);
                    } catch {
                        return false;
                    }
                })
                .map(it => {
                    const f = Gio.File.new_for_uri(it.uri);
                    const info = this._readFileMeta(f);
                    return {
                        id: `shelf-${this._nextId++}`,
                        kind: 'file',
                        uri: it.uri,
                        path: f.get_path() || '',
                        name: info.name,
                        sizeBytes: info.sizeBytes,
                        sizeLabel: formatBytes(info.sizeBytes),
                        mimeType: info.mimeType,
                        iconName: info.iconName,
                        isTempCopy: Boolean(it.isTempCopy),
                        source: it.source || 'drop',
                        pinned: Boolean(it.pinned),
                        addedAtMs: Number(it.addedAtMs) || Date.now(),
                    };
                });
        } catch {
            this._items = [];
        }
    }

    _saveToDisk() {
        try {
            GLib.mkdir_with_parents(this._dataDir, 0o700);
            const data = this._items.map(it => ({
                uri: it.uri,
                isTempCopy: it.isTempCopy,
                source: it.source,
                pinned: it.pinned,
                addedAtMs: it.addedAtMs,
            }));
            GLib.file_set_contents(this._storePath, JSON.stringify(data));
        } catch (e) {
            logError(e, 'BayIsland failed to save shelf items');
        }
    }

    _publishChanged() {
        this._priority?.updateMeta({ shelfCount: this._items.length }, { inPlaceHint: true });
        this.emit('changed', this.getSnapshot());
    }

    _stop() {
        if (this._dragLeaveTimerId) {
            this._timers.clear(this._dragLeaveTimerId);
            this._dragLeaveTimerId = 0;
        }
        this._stopScreenshotMonitor();
        for (const id of this._dndSignals) {
            try { this._dndObj?.disconnect(id); } catch {}
        }
        this._dndSignals = [];
        this._dndObj = null;
        this._killBridge();
        this._priority?.setDragCatch(false, false);
    }

    destroy() {
        this._stop();
    }
}
