import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import St from 'gi://St';

export class ShelfTab {
    constructor({ callbacks }) {
        this._cb = callbacks;
        this._root = null;
        this._dropBox = null;
        this._rowsBox = null;
        this._isEmpty = true;
        this._itemCount = 0;
        this._lastPalette = null;
    }

    render(model, palette, shelfSnapshot) {
        this.destroy();

        this._lastPalette = palette ?? null;
        const acc = palette?.accentCss || '#93c5fd';
        const accOnDark = palette?.accentOnDarkCss || acc;
        const fg = palette?.accentFgCss || '#090d16';

        const snap = shelfSnapshot ?? { enabled: true, items: [] };
        const items = snap.items ?? [];
        const isEmpty = items.length === 0;
        this._isEmpty = isEmpty;
        this._itemCount = items.length;
        const dragHighlight = Boolean(model.meta?.dragHighlight);

        const root = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_expand: true,
            style: 'spacing: 8px;',
        });

        // 1. Drop Zone Box (centered full canvas when empty; compact top catcher when populated)
        const dropInlineParts = [];
        if (dragHighlight)
            dropInlineParts.push(`background-color: ${acc}; color: ${fg};`);
        if (isEmpty)
            dropInlineParts.push('spacing: 6px; padding: 16px;');

        this._dropBox = new St.BoxLayout({
            style_class: `bayisland-dropzone${dragHighlight ? ' bayisland-dropzone-active' : ''}`,
            ...(dropInlineParts.length > 0 ? { style: dropInlineParts.join(' ') } : {}),
            vertical: true,
            x_expand: true,
            y_expand: isEmpty,
            reactive: false,
            ...(isEmpty ? {} : { height: 64 }),
        });
        this._dropBox.add_child(new St.Widget({ y_expand: true }));
        this._dropBox.add_child(new St.Icon({
            icon_name: 'folder-download-symbolic',
            icon_size: isEmpty ? 28 : 20,
            x_align: Clutter.ActorAlign.CENTER,
            style: dragHighlight ? `color: ${fg};` : `color: ${accOnDark};`,
        }));
        this._dropBox.add_child(new St.Label({
            text: dragHighlight
                ? 'Release to stash files onto Shelf'
                : (isEmpty ? 'Drag & drop files here to add them' : 'Drop files here — or drag rows out to any app'),
            style_class: isEmpty ? 'bayisland-dropzone-title' : 'bayisland-dropzone-label',
            x_align: Clutter.ActorAlign.CENTER,
            ...(dragHighlight ? { style: `color: ${fg}; font-weight: 700;` } : {}),
        }));
        if (isEmpty && !dragHighlight) {
            this._dropBox.add_child(new St.Label({
                text: 'Or click "+ Add Files…" below to pick from disk',
                style_class: 'bayisland-muted-xs',
                x_align: Clutter.ActorAlign.CENTER,
            }));
        }
        this._dropBox.add_child(new St.Widget({ y_expand: true }));
        root.add_child(this._dropBox);

        // 2. Staged File Cards (left drag-handle area reactive: false for Gtk.DragSource below!)
        if (!isEmpty) {
            this._rowsBox = new St.BoxLayout({
                vertical: true,
                x_expand: true,
                y_expand: true,
                reactive: false,
                style: 'spacing: 6px;',
            });
            for (const item of items.slice(0, 5))
                this._rowsBox.add_child(this._buildItemRow(item, palette));
            root.add_child(this._rowsBox);
        }

        // 3. Footer Control Bar (reactive: true buttons sit cleanly above bridge)
        const footer = new St.BoxLayout({
            x_expand: true,
            style: 'spacing: 6px;',
        });

        const addBtn = new St.Button({
            label: '+ Add Files…',
            style_class: 'bayisland-action-btn bayisland-action-btn-primary',
            style: `background-color: ${acc}; color: ${fg};`,
            reactive: true,
            can_focus: false,
        });
        addBtn.connect('clicked', () => this._cb.onShelfPickFiles?.());
        footer.add_child(addBtn);

        if (items.length > 0) {
            const copyAllBtn = new St.Button({
                label: items.length > 1 ? `Copy All (${items.length})` : 'Copy File (Ctrl+V)',
                style_class: 'bayisland-action-btn',
                reactive: true,
                can_focus: false,
            });
            copyAllBtn.connect('clicked', () => this._cb.onShelfCopyAll?.());
            footer.add_child(copyAllBtn);
        }

        footer.add_child(new St.Widget({ x_expand: true }));

        footer.add_child(new St.Label({
            text: snap.screenshotAutoStash ? 'Auto-Stash Screenshots: ON' : 'Auto-Stash Screenshots: OFF',
            style_class: 'bayisland-muted-xs',
            y_align: Clutter.ActorAlign.CENTER,
        }));

        if (items.length > 0) {
            const clearBtn = new St.Button({
                label: 'Clear',
                style_class: 'bayisland-mini-pill-btn',
                reactive: true,
                can_focus: false,
            });
            clearBtn.connect('clicked', () => this._cb.onShelfClearUnpinned?.());
            footer.add_child(clearBtn);
        }

        root.add_child(footer);
        this._root = root;
        return root;
    }

    _buildItemRow(item, palette) {
        const acc = palette?.accentOnDarkCss || palette?.accentCss || '#93c5fd';

        const row = new St.BoxLayout({
            style_class: `bayisland-shelf-row${item.pinned ? ' bayisland-list-card-pinned' : ''}`,
            x_expand: true,
            height: 44,
            reactive: false,
            style: 'spacing: 6px;',
        });

        // Left Drag Zone (~410px wide, reactive: false so Gtk.DragSource underneath receives press-drag!)
        const dragArea = new St.BoxLayout({
            x_expand: true,
            reactive: false,
            style: 'spacing: 8px;',
            y_align: Clutter.ActorAlign.CENTER,
        });

        dragArea.add_child(new St.Icon({
            icon_name: 'view-more-symbolic',
            icon_size: 13,
            style: 'color: #64748b;',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        dragArea.add_child(new St.Icon({
            icon_name: item.iconName || 'text-x-generic-symbolic',
            icon_size: 16,
            style: `color: ${acc};`,
            y_align: Clutter.ActorAlign.CENTER,
        }));

        const textCol = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const nameLbl = new St.Label({
            text: item.name || 'File',
            style_class: 'bayisland-list-title',
        });
        nameLbl.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        textCol.add_child(nameLbl);

        const metaLbl = new St.Label({
            text: `${item.sizeLabel || 'Snippet'} • Drag out or Copy File`,
            style_class: 'bayisland-muted-xs',
        });
        metaLbl.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        textCol.add_child(metaLbl);
        dragArea.add_child(textCol);

        row.add_child(dragArea);

        // Right Action Buttons (reactive: true -> handled cleanly by BayIsland St buttons!)
        const actions = new St.BoxLayout({
            reactive: true,
            style: 'spacing: 4px;',
            y_align: Clutter.ActorAlign.CENTER,
        });

        const copyBtn = new St.Button({
            label: 'Copy File',
            style_class: 'bayisland-mini-pill-btn',
            reactive: true,
            can_focus: false,
        });
        copyBtn.connect('clicked', () => this._cb.onShelfCopyItem?.(item.id));
        actions.add_child(copyBtn);

        const openBtn = new St.Button({
            style_class: 'bayisland-icon-btn',
            reactive: true,
            can_focus: false,
            child: new St.Icon({ icon_name: 'external-link-symbolic', icon_size: 13 }),
        });
        openBtn.connect('clicked', () => this._cb.onShelfOpenItem?.(item.id));
        actions.add_child(openBtn);

        const pinBtn = new St.Button({
            style_class: `bayisland-icon-btn${item.pinned ? ' bayisland-icon-btn-star' : ''}`,
            reactive: true,
            can_focus: false,
            child: new St.Icon({
                icon_name: item.pinned ? 'starred-symbolic' : 'non-starred-symbolic',
                icon_size: 13,
            }),
        });
        pinBtn.connect('clicked', () => this._cb.onShelfTogglePin?.(item.id));
        actions.add_child(pinBtn);

        const delBtn = new St.Button({
            style_class: 'bayisland-icon-btn bayisland-icon-btn-del',
            reactive: true,
            can_focus: false,
            child: new St.Icon({ icon_name: 'window-close-symbolic', icon_size: 13 }),
        });
        delBtn.connect('clicked', () => this._cb.onShelfRemoveItem?.(item.id));
        actions.add_child(delBtn);

        row.add_child(actions);
        return row;
    }

    getBridgeRegion(shellX, shellY, shellW, shellH = 310) {
        // Aligned with ExpandedView padding (14,16) + unified header (36) + root spacing (10) = headerOffset 60
        // Empty state: dropzone spans full body above footer; Populated: 64px top dropzone + 8px gap + rows
        const padX = 16;
        const headerOffset = 60;
        const footerReserve = 48;
        const bodyWidth = Math.max(240, shellW - padX * 2);

        if (this._isEmpty) {
            const fullDropHeight = Math.max(140, (shellH || 310) - headerOffset - footerReserve);
            return {
                x: shellX + padX,
                y: shellY + headerOffset,
                width: bodyWidth,
                height: fullDropHeight,
                dropHeight: fullDropHeight,
                rowHeight: 44,
                dragZoneWidth: Math.max(180, bodyWidth - 196),
            };
        }

        const dropHeight = 72;
        const minRowsHeight = Math.min(5, Math.max(1, this._itemCount)) * 50;
        const rowsHeight = Math.max(minRowsHeight, (shellH || 336) - headerOffset - dropHeight - footerReserve);
        return {
            x: shellX + padX,
            y: shellY + headerOffset,
            width: bodyWidth,
            height: dropHeight + rowsHeight,
            dropHeight,
            rowHeight: 44,
            dragZoneWidth: Math.max(180, bodyWidth - 196),
        };
    }

    destroy() {
        this._itemCount = 0;
        this._dropBox = null;
        this._rowsBox = null;
        this._root = null;
    }
}
