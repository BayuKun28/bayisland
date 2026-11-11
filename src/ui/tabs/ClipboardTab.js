import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import St from 'gi://St';

function formatRelativeAge(tsMs) {
    const diffSec = Math.max(0, Math.floor((Date.now() - tsMs) / 1000));
    if (diffSec < 10)
        return 'just now';
    if (diffSec < 60)
        return `${diffSec}s`;
    const mins = Math.floor(diffSec / 60);
    if (mins < 60)
        return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24)
        return `${hrs}h`;
    return `${Math.floor(hrs / 24)}d`;
}

export class ClipboardTab {
    constructor({ callbacks }) {
        this._cb = callbacks;
        this._root = null;
        this._listBox = null;
        this._searchEntry = null;
        this._allFilterBtn = null;
        this._pinFilterBtn = null;
        this._pauseBtn = null;
        this._modeBtn = null;
        this._query = '';
        this._pinnedOnly = false;
        this._lastSnapshot = null;
        this._lastPalette = null;
    }

    render(_model, palette, clipSnapshot) {
        this.destroy();

        this._lastSnapshot = clipSnapshot;
        this._lastPalette = palette ?? null;

        const acc = palette?.accentCss || '#93c5fd';
        const fg = palette?.accentFgCss || '#090d16';

        const root = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_expand: true,
            style: 'spacing: 8px;',
        });

        // Regrouped Toolbar: [Search + Segmented All|Pin Filter] | [Capture + Mode + Clear]
        const bar = new St.BoxLayout({
            x_expand: true,
            style: 'spacing: 7px;',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._searchEntry = new St.Entry({
            style_class: 'bayisland-search-entry',
            style: `caret-color: ${acc};`,
            hint_text: 'Search clipboard history…',
            text: this._query,
            can_focus: true,
            reactive: true,
            track_hover: true,
            x_expand: true,
        });
        this._searchEntry.clutter_text.connect('text-changed', () => {
            this._query = this._searchEntry?.get_text() || '';
            this._populateList();
        });
        this._searchEntry.connect('button-press-event', () => {
            this._cb.onAcquireTextModal?.(this._searchEntry);
            return Clutter.EVENT_PROPAGATE;
        });
        this._searchEntry.clutter_text.connect('key-focus-out', () => {
            this._cb.onReleaseTextModal?.();
        });
        bar.add_child(this._searchEntry);

        const segBox = new St.BoxLayout({
            style_class: 'bayisland-clip-seg',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._allFilterBtn = new St.Button({
            label: 'All',
            style_class: `bayisland-clip-seg-btn${!this._pinnedOnly ? ' bayisland-clip-seg-btn-active' : ''}`,
            ...(!this._pinnedOnly ? { style: `background-color: ${acc}; color: ${fg};` } : {}),
            reactive: true,
            can_focus: false,
        });
        this._pinFilterBtn = new St.Button({
            label: '★ Pin',
            style_class: `bayisland-clip-seg-btn${this._pinnedOnly ? ' bayisland-clip-seg-btn-active' : ''}`,
            ...(this._pinnedOnly ? { style: `background-color: ${acc}; color: ${fg};` } : {}),
            reactive: true,
            can_focus: false,
        });
        const updateFilterSwitch = pinnedOnly => {
            this._pinnedOnly = pinnedOnly;
            const curAcc = this._lastPalette?.accentCss || '#93c5fd';
            const curFg = this._lastPalette?.accentFgCss || '#090d16';
            if (this._allFilterBtn) {
                this._allFilterBtn.style_class = `bayisland-clip-seg-btn${!pinnedOnly ? ' bayisland-clip-seg-btn-active' : ''}`;
                this._allFilterBtn.style = !pinnedOnly ? `background-color: ${curAcc}; color: ${curFg};` : null;
            }
            if (this._pinFilterBtn) {
                this._pinFilterBtn.style_class = `bayisland-clip-seg-btn${pinnedOnly ? ' bayisland-clip-seg-btn-active' : ''}`;
                this._pinFilterBtn.style = pinnedOnly ? `background-color: ${curAcc}; color: ${curFg};` : null;
            }
            this._populateList();
        };
        this._allFilterBtn.connect('clicked', () => updateFilterSwitch(false));
        this._pinFilterBtn.connect('clicked', () => updateFilterSwitch(true));
        segBox.add_child(this._allFilterBtn);
        segBox.add_child(this._pinFilterBtn);
        bar.add_child(segBox);

        bar.add_child(new St.Widget({
            style_class: 'bayisland-split-divider',
            y_align: Clutter.ActorAlign.CENTER,
        }));

        const paused = Boolean(clipSnapshot?.paused);
        this._pauseBtn = new St.Button({
            label: paused ? 'Paused' : 'Capture',
            style_class: `bayisland-mini-pill-btn${paused ? ' bayisland-mini-pill-btn-warn' : ''}`,
            reactive: true,
            can_focus: false,
        });
        this._pauseBtn.connect('clicked', () => this._cb.onClipTogglePause?.());
        bar.add_child(this._pauseBtn);

        const autoPaste = clipSnapshot?.autoPaste !== false;
        this._modeBtn = new St.Button({
            label: autoPaste ? 'Paste' : 'Copy',
            style_class: `bayisland-mini-pill-btn${autoPaste ? ' bayisland-mini-pill-btn-active' : ''}`,
            ...(autoPaste ? { style: `background-color: ${acc}; color: ${fg};` } : {}),
            reactive: true,
            can_focus: false,
        });
        this._modeBtn.connect('clicked', () => this._cb.onClipToggleAutoPaste?.());
        bar.add_child(this._modeBtn);

        const clearBtn = new St.Button({
            label: 'Clear',
            style_class: 'bayisland-mini-pill-btn',
            reactive: true,
            can_focus: false,
        });
        clearBtn.connect('clicked', () => this._cb.onClipClearUnpinned?.());
        bar.add_child(clearBtn);

        root.add_child(bar);

        // Scrollable items list
        const scroll = new St.ScrollView({
            style_class: 'bayisland-scroll-view vfade',
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
        });
        this._listBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style: 'spacing: 5px;',
        });
        scroll.child = this._listBox;
        root.add_child(scroll);

        this._populateList();
        this._root = root;
        return root;
    }

    updateSnapshot(clipSnapshot, palette) {
        this._lastSnapshot = clipSnapshot;
        if (palette)
            this._lastPalette = palette;

        const acc = this._lastPalette?.accentCss || '#93c5fd';
        const fg = this._lastPalette?.accentFgCss || '#090d16';

        if (this._pauseBtn) {
            const paused = Boolean(clipSnapshot?.paused);
            this._pauseBtn.label = paused ? 'Paused' : 'Capture';
            this._pauseBtn.style_class = `bayisland-mini-pill-btn${paused ? ' bayisland-mini-pill-btn-warn' : ''}`;
        }
        if (this._modeBtn) {
            const autoPaste = clipSnapshot?.autoPaste !== false;
            this._modeBtn.label = autoPaste ? 'Paste' : 'Copy';
            this._modeBtn.style_class = `bayisland-mini-pill-btn${autoPaste ? ' bayisland-mini-pill-btn-active' : ''}`;
            this._modeBtn.style = autoPaste ? `background-color: ${acc}; color: ${fg};` : null;
        }
        if (this._listBox)
            this._populateList();
    }

    _populateList() {
        if (!this._listBox)
            return;
        this._listBox.destroy_all_children();

        const snap = this._lastSnapshot;
        if (!snap?.enabled) {
            this._listBox.add_child(this._emptyState('Clipboard history is disabled in Settings'));
            return;
        }

        const q = this._query.trim().toLowerCase();
        const items = (snap.entries ?? []).filter(e => {
            if (this._pinnedOnly && !e.pinned)
                return false;
            if (q && !e.text.toLowerCase().includes(q))
                return false;
            return true;
        });

        if (items.length === 0) {
            this._listBox.add_child(this._emptyState(
                q ? 'No matching entries' : 'No clipboard history yet'
            ));
            return;
        }

        for (const item of items.slice(0, 40))
            this._listBox.add_child(this._buildRow(item));
    }

    _emptyState(text) {
        const box = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'padding: 68px 0px; spacing: 6px;',
        });
        box.add_child(new St.Icon({
            icon_name: 'edit-paste-symbolic',
            icon_size: 24,
            style: 'color: #64748b;',
        }));
        box.add_child(new St.Label({
            text,
            style_class: 'bayisland-muted-sm',
        }));
        return box;
    }

    _buildRow(item) {
        const acc = this._lastPalette?.accentCss || '#93c5fd';
        const fg = this._lastPalette?.accentFgCss || '#090d16';

        const row = new St.BoxLayout({
            style_class: `bayisland-list-card${item.pinned ? ' bayisland-list-card-pinned' : ''}`,
            x_expand: true,
            style: 'spacing: 8px;',
        });

        const mainBtn = new St.Button({
            style_class: 'bayisland-row-main-btn',
            reactive: true,
            can_focus: false,
            x_expand: true,
        });

        const inner = new St.BoxLayout({
            style: 'spacing: 8px;',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });

        if (item.colorHex) {
            inner.add_child(new St.Widget({
                style_class: 'bayisland-color-swatch',
                style: `background-color: ${item.colorHex};`,
                y_align: Clutter.ActorAlign.CENTER,
            }));
        } else if (item.fileUris?.length > 0) {
            inner.add_child(new St.Icon({
                icon_name: 'folder-symbolic',
                icon_size: 14,
                style: `color: ${acc};`,
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }

        const previewLbl = new St.Label({
            text: item.preview || item.text,
            style_class: 'bayisland-list-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        previewLbl.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        inner.add_child(previewLbl);

        inner.add_child(new St.Label({
            text: formatRelativeAge(item.timestampMs),
            style_class: 'bayisland-muted-xs',
            y_align: Clutter.ActorAlign.CENTER,
        }));

        mainBtn.set_child(inner);
        mainBtn.connect('clicked', () => {
            this._cb.onReleaseTextModal?.();
            this._cb.onClipActivate?.(item.id, null);
        });
        row.add_child(mainBtn);

        if (item.fileUris?.length > 0) {
            const toShelfBtn = new St.Button({
                label: '-> Shelf',
                style_class: 'bayisland-mini-pill-btn bayisland-mini-pill-btn-active',
                style: `background-color: ${acc}; color: ${fg};`,
                reactive: true,
                can_focus: false,
            });
            toShelfBtn.connect('clicked', () => this._cb.onClipSendToShelf?.(item.id));
            row.add_child(toShelfBtn);
        }

        const copyBtn = new St.Button({
            style_class: 'bayisland-icon-btn',
            reactive: true,
            can_focus: false,
            child: new St.Icon({ icon_name: 'edit-copy-symbolic', icon_size: 13 }),
        });
        copyBtn.connect('clicked', () => {
            this._cb.onReleaseTextModal?.();
            this._cb.onClipActivate?.(item.id, false);
        });
        row.add_child(copyBtn);

        const pinBtn = new St.Button({
            style_class: `bayisland-icon-btn${item.pinned ? ' bayisland-icon-btn-star' : ''}`,
            reactive: true,
            can_focus: false,
            child: new St.Icon({
                icon_name: item.pinned ? 'starred-symbolic' : 'non-starred-symbolic',
                icon_size: 13,
            }),
        });
        pinBtn.connect('clicked', () => this._cb.onClipTogglePin?.(item.id));
        row.add_child(pinBtn);

        const delBtn = new St.Button({
            style_class: 'bayisland-icon-btn bayisland-icon-btn-del',
            reactive: true,
            can_focus: false,
            child: new St.Icon({ icon_name: 'window-close-symbolic', icon_size: 13 }),
        });
        delBtn.connect('clicked', () => this._cb.onClipDelete?.(item.id));
        row.add_child(delBtn);

        return row;
    }

    destroy() {
        this._cb.onReleaseTextModal?.();
        this._searchEntry = null;
        this._allFilterBtn = null;
        this._pinFilterBtn = null;
        this._pauseBtn = null;
        this._modeBtn = null;
        this._listBox = null;
        this._root = null;
    }
}
