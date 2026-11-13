import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

const MAX_ITEM_CHARS = 250_000;
const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

function sanitizePreview(text) {
    return text.replace(/\s+/g, ' ').trim().slice(0, 180);
}

function extractColorHex(text) {
    const t = text.trim();
    if (/^#[0-9a-fA-F]{3}$/.test(t))
        return `#${t[1]}${t[1]}${t[2]}${t[2]}${t[3]}${t[3]}`.toUpperCase();
    if (/^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(t))
        return t.toUpperCase();
    const rgbMatch = t.match(/^rgba?\s*\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i);
    if (rgbMatch) {
        const r = Math.min(255, parseInt(rgbMatch[1], 10)).toString(16).padStart(2, '0');
        const g = Math.min(255, parseInt(rgbMatch[2], 10)).toString(16).padStart(2, '0');
        const b = Math.min(255, parseInt(rgbMatch[3], 10)).toString(16).padStart(2, '0');
        return `#${r}${g}${b}`.toUpperCase();
    }
    return null;
}

function parseFileUrisFromText(raw) {
    if (!raw)
        return [];
    return raw
        .split(/\r?\n/)
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('#') && (l.startsWith('file://') || l.startsWith('/')))
        .map(l => (l.startsWith('/') ? Gio.File.new_for_path(l).get_uri() : l));
}

/**
 * Zero-polling Meta.Selection clipboard history engine with privacy guard,
 * favorites/pinning, disk JSON persistence, and VirtualKeyboard auto-paste.
 */
export class ClipboardManager extends Signals.EventEmitter {
    constructor({ timers, priority, onSendFilesToShelf }) {
        super();
        this._timers = timers;
        this._priority = priority;
        this._onSendFilesToShelf = onSendFilesToShelf;

        this._enabled = false;
        this._autoPaste = true;
        this._pasteShortcut = 'shift-insert';
        this._ignorePasswords = true;
        this._maxItems = 60;
        this._paused = false;

        this._entries = [];
        this._nextId = 1;
        this._selection = null;
        this._selectionSigId = 0;
        this._virtualKbd = null;
        this._pasteTimerId = 0;
        this._saveTimerId = 0;

        this._selfIgnoreRemaining = 0;
        this._lastSelfText = null;
        this._lastSelfMonoUs = 0;

        this._storeDir = GLib.build_filenamev([GLib.get_user_data_dir(), 'bayisland']);
        this._storePath = GLib.build_filenamev([this._storeDir, 'clipboard-history.json']);
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

    setOptions({ autoPaste, pasteShortcut, ignorePasswords, maxItems }) {
        if (autoPaste !== undefined)
            this._autoPaste = Boolean(autoPaste);
        if (pasteShortcut !== undefined)
            this._pasteShortcut = pasteShortcut;
        if (ignorePasswords !== undefined)
            this._ignorePasswords = Boolean(ignorePasswords);
        if (maxItems !== undefined) {
            this._maxItems = Math.max(10, Math.min(200, Math.round(maxItems)));
            this._trimEntries();
            this._publishChanged();
        }
    }

    isPaused() {
        return this._paused;
    }

    togglePaused() {
        this._paused = !this._paused;
        this._priority?.updateMeta({ clipPaused: this._paused }, { inPlaceHint: true });
        this.emit('changed', this.getSnapshot());
    }

    getAutoPaste() {
        return this._autoPaste;
    }

    setAutoPaste(val) {
        this._autoPaste = Boolean(val);
        this.emit('changed', this.getSnapshot());
    }

    getSnapshot() {
        return {
            enabled: this._enabled,
            paused: this._paused,
            autoPaste: this._autoPaste,
            entries: [...this._entries],
        };
    }

    activateEntry(id, forceAutoPaste = null) {
        const entry = this._entries.find(e => e.id === id);
        if (!entry)
            return;

        const clipboard = St.Clipboard.get_default();
        this._selfIgnoreRemaining = 1;
        this._lastSelfText = entry.text;
        this._lastSelfMonoUs = GLib.get_monotonic_time();

        clipboard.set_text(St.ClipboardType.CLIPBOARD, entry.text);

        // Bump recency without disturbing pinned order semantics
        entry.timestampMs = Date.now();
        this._reorderEntries();
        this._scheduleSave();
        this._publishChanged();

        const shouldPaste = forceAutoPaste !== null ? Boolean(forceAutoPaste) : this._autoPaste;
        if (shouldPaste) {
            this._priority?.collapse();
            this._scheduleVirtualPaste();
        }
    }

    togglePin(id) {
        const entry = this._entries.find(e => e.id === id);
        if (!entry)
            return;
        entry.pinned = !entry.pinned;
        this._reorderEntries();
        this._scheduleSave();
        this._publishChanged();
    }

    deleteEntry(id) {
        const idx = this._entries.findIndex(e => e.id === id);
        if (idx === -1)
            return;
        this._entries.splice(idx, 1);
        this._scheduleSave();
        this._publishChanged();
    }

    clearUnpinned() {
        this._entries = this._entries.filter(e => e.pinned);
        this._scheduleSave();
        this._publishChanged();
    }

    sendEntryUrisToShelf(id) {
        const entry = this._entries.find(e => e.id === id);
        if (!entry || !entry.fileUris?.length)
            return;
        this._onSendFilesToShelf?.(entry.fileUris);
    }

    _start() {
        this._loadFromDisk();
        this._publishChanged();

        try {
            this._selection = global.display.get_selection();
            this._selectionSigId = this._selection.connect('owner-changed', (_sel, selectionType) => {
                if (!this._enabled || this._paused)
                    return;
                if (selectionType === Meta.SelectionType.SELECTION_CLIPBOARD)
                    this._queryClipboard();
            });
        } catch (e) {
            logError(e, 'BayIsland ClipboardManager selection listener failed');
        }
    }

    _queryClipboard() {
        const clipboard = St.Clipboard.get_default();
        if (!clipboard)
            return;

        let mimetypes = [];
        try {
            mimetypes = clipboard.get_mimetypes(St.ClipboardType.CLIPBOARD) ?? [];
        } catch {
            mimetypes = [];
        }

        if (this._ignorePasswords && mimetypes.includes('x-kde-passwordManagerHint'))
            return;

        const hasUriList = mimetypes.includes('text/uri-list') || mimetypes.includes('x-special/gnome-copied-files');
        if (hasUriList) {
            clipboard.get_content(St.ClipboardType.CLIPBOARD, 'text/uri-list', (_cb, bytes) => {
                if (!this._enabled || this._paused || !bytes)
                    return;
                const raw = new TextDecoder().decode(bytes.get_data?.() ?? bytes.toArray?.() ?? []);
                const uris = parseFileUrisFromText(raw);
                if (uris.length > 0) {
                    const label = uris.map(u => {
                        try { return Gio.File.new_for_uri(u).get_basename() || u; } catch { return u; }
                    }).join('\n');
                    this._ingestText(label, uris);
                }
            });
            return;
        }

        clipboard.get_text(St.ClipboardType.CLIPBOARD, (_cb, text) => {
            if (!this._enabled || this._paused)
                return;
            this._ingestText(text, null);
        });
    }

    _ingestText(text, explicitUris) {
        if (typeof text !== 'string' || !text.trim() || text.length > MAX_ITEM_CHARS)
            return;

        if (this._selfIgnoreRemaining > 0) {
            this._selfIgnoreRemaining--;
            if (text === this._lastSelfText && (GLib.get_monotonic_time() - this._lastSelfMonoUs) < 1_000_000)
                return;
        }

        const existingIdx = this._entries.findIndex(e => e.text === text);
        const uris = explicitUris?.length ? explicitUris : parseFileUrisFromText(text);

        if (existingIdx !== -1) {
            const existing = this._entries[existingIdx];
            existing.timestampMs = Date.now();
            if (uris.length > 0)
                existing.fileUris = uris;
            this._reorderEntries();
            this._scheduleSave();
            this._publishChanged();
            return;
        }

        const entry = {
            id: `clip-${this._nextId++}`,
            text,
            preview: sanitizePreview(text),
            pinned: false,
            timestampMs: Date.now(),
            colorHex: extractColorHex(text),
            fileUris: uris,
        };

        this._entries.unshift(entry);
        this._reorderEntries();
        this._trimEntries();
        this._scheduleSave();
        this._publishChanged();
    }

    _reorderEntries() {
        const pinned = this._entries.filter(e => e.pinned).sort((a, b) => b.timestampMs - a.timestampMs);
        const regular = this._entries.filter(e => !e.pinned).sort((a, b) => b.timestampMs - a.timestampMs);
        this._entries = [...pinned, ...regular];
    }

    _trimEntries() {
        const pinned = this._entries.filter(e => e.pinned);
        const regular = this._entries.filter(e => !e.pinned).slice(0, this._maxItems);
        this._entries = [...pinned, ...regular];
    }

    _scheduleVirtualPaste() {
        if (this._pasteTimerId) {
            this._timers.clear(this._pasteTimerId);
            this._pasteTimerId = 0;
        }

        this._pasteTimerId = this._timers.setTimeout(85, () => {
            this._pasteTimerId = 0;
            try {
                if (!this._virtualKbd) {
                    this._virtualKbd = Clutter.get_default_backend()
                        .get_default_seat()
                        .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
                }

                const nowUs = GLib.get_monotonic_time();
                if (this._pasteShortcut === 'ctrl-v') {
                    this._virtualKbd.notify_keyval(nowUs, Clutter.KEY_Control_L, Clutter.KeyState.PRESSED);
                    this._virtualKbd.notify_keyval(nowUs + 5000, Clutter.KEY_v, Clutter.KeyState.PRESSED);
                    this._virtualKbd.notify_keyval(nowUs + 15000, Clutter.KEY_v, Clutter.KeyState.RELEASED);
                    this._virtualKbd.notify_keyval(nowUs + 20000, Clutter.KEY_Control_L, Clutter.KeyState.RELEASED);
                } else {
                    this._virtualKbd.notify_keyval(nowUs, Clutter.KEY_Shift_L, Clutter.KeyState.PRESSED);
                    this._virtualKbd.notify_keyval(nowUs + 5000, Clutter.KEY_Insert, Clutter.KeyState.PRESSED);
                    this._virtualKbd.notify_keyval(nowUs + 15000, Clutter.KEY_Insert, Clutter.KeyState.RELEASED);
                    this._virtualKbd.notify_keyval(nowUs + 20000, Clutter.KEY_Shift_L, Clutter.KeyState.RELEASED);
                }
            } catch (e) {
                logError(e, 'BayIsland virtual paste failed');
            }
        });
    }

    _loadFromDisk() {
        try {
            const file = Gio.File.new_for_path(this._storePath);
            if (!file.query_exists(null))
                return;
            const [ok, bytes] = file.load_contents(null);
            if (!ok)
                return;
            const parsed = JSON.parse(new TextDecoder().decode(bytes));
            if (!Array.isArray(parsed))
                return;

            this._entries = parsed
                .filter(e => e && typeof e.text === 'string' && e.text.length > 0 && e.text.length <= MAX_ITEM_CHARS)
                .map(e => ({
                    id: `clip-${this._nextId++}`,
                    text: e.text,
                    preview: sanitizePreview(e.text),
                    pinned: Boolean(e.pinned),
                    timestampMs: Number(e.timestampMs) || Date.now(),
                    colorHex: extractColorHex(e.text),
                    fileUris: Array.isArray(e.fileUris) ? e.fileUris : parseFileUrisFromText(e.text),
                }));
            this._reorderEntries();
            this._trimEntries();
        } catch {
            this._entries = [];
        }
    }

    _scheduleSave() {
        if (this._saveTimerId)
            this._timers.clear(this._saveTimerId);
        this._saveTimerId = this._timers.setTimeout(600, () => {
            this._saveTimerId = 0;
            this._writeToDiskNow();
        });
    }

    _writeToDiskNow() {
        try {
            GLib.mkdir_with_parents(this._storeDir, 0o700);
            const serializable = this._entries
                .filter(e => e.text.length <= 65_536)
                .map(e => ({
                    text: e.text,
                    pinned: e.pinned,
                    timestampMs: e.timestampMs,
                    fileUris: e.fileUris,
                }));
            GLib.file_set_contents(this._storePath, JSON.stringify(serializable));
        } catch (e) {
            logError(e, 'BayIsland failed to save clipboard history');
        }
    }

    _publishChanged() {
        this._priority?.updateMeta({
            clipCount: this._entries.length,
            clipPaused: this._paused,
        }, { inPlaceHint: true });
        this.emit('changed', this.getSnapshot());
    }

    _stop() {
        if (this._saveTimerId) {
            this._timers.clear(this._saveTimerId);
            this._saveTimerId = 0;
            this._writeToDiskNow();
        }
        if (this._pasteTimerId) {
            this._timers.clear(this._pasteTimerId);
            this._pasteTimerId = 0;
        }
        if (this._selection && this._selectionSigId) {
            try { this._selection.disconnect(this._selectionSigId); } catch {}
            this._selectionSigId = 0;
        }
        this._selection = null;
        this._virtualKbd = null;
    }

    destroy() {
        this._stop();
    }
}
