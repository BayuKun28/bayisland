import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import St from 'gi://St';

/**
 * Renders TRANSIENT_BANNER for OSD (volume/brightness/mic/caffeine),
 * Power events, Notifications, Terminal Task Done, Resource Spikes, and Alarms.
 */
export class TransientView {
    constructor({ onDismiss, onActivate }) {
        this._onDismiss = onDismiss;
        this._onActivate = onActivate;

        this._root = null;
        this._titleLabel = null;
        this._bodyLabel = null;
        this._valueLabel = null;
        this._icon = null;
        this._levelFill = null;
        this._trackWidth = 190;
        this._currentCoalesceKey = null;
        this._currentKind = null;
    }

    getPreferredSize(model) {
        const t = model.transient;
        if (!t)
            return { width: 280, height: 52 };

        if (t.kind === 'osd')
            return { width: t.level !== null && t.level !== undefined ? 304 : 236, height: 52 };
        if (t.kind === 'power')
            return { width: 292, height: 54 };
        if (t.kind === 'notification') {
            const hasActions = Array.isArray(t.actions) && t.actions.length > 0;
            return { width: 352, height: hasActions ? 98 : 68 };
        }
        if (t.kind === 'alarm')
            return { width: 320, height: 76 };
        // task, resource, banner
        return { width: 332, height: t.body ? 64 : 52 };
    }

    render(model, palette) {
        const t = model.transient;
        this._currentKind = t.kind;
        this._currentCoalesceKey = t.coalesceKey ?? null;
        this._levelFill = null;
        this._valueLabel = null;
        this._titleLabel = null;
        this._bodyLabel = null;
        this._icon = null;

        const box = new St.BoxLayout({
            style_class: 'bayisland-transient-box',
            x_expand: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        // Icon badge
        const iconWrap = new St.Bin({
            style_class: 'bayisland-transient-icon-wrap',
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.CENTER,
        });
        const gicon = this._resolveGIcon(t);
        this._icon = new St.Icon({
            ...(gicon
                ? { gicon }
                : { icon_name: t.iconName || 'dialog-information-symbolic' }),
            icon_size: 18,
            ...(t.iconColor ? { style: `color: ${t.iconColor};` } : {}),
        });
        iconWrap.set_child(this._icon);
        box.add_child(iconWrap);

        // Center column
        const centerCol = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'spacing: 4px;',
        });

        const topRow = new St.BoxLayout({
            x_expand: true,
            style: 'spacing: 8px;',
        });

        this._titleLabel = new St.Label({
            text: t.title || 'BayIsland',
            style_class: 'bayisland-transient-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._titleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        topRow.add_child(this._titleLabel);

        if (t.badgeText) {
            let badgeCls = 'bayisland-badge ';
            if (t.badgeKind === 'error')
                badgeCls += 'bayisland-badge-error';
            else if (t.badgeKind === 'warn')
                badgeCls += 'bayisland-badge-warn';
            else
                badgeCls += 'bayisland-badge-success';

            topRow.add_child(new St.Label({
                text: t.badgeText,
                style_class: badgeCls,
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }

        if (t.level !== null && t.level !== undefined) {
            const pct = Math.round((t.level / (t.maxLevel || 1)) * 100);
            this._valueLabel = new St.Label({
                text: `${pct}%`,
                style_class: 'bayisland-transient-value',
                y_align: Clutter.ActorAlign.CENTER,
            });
            topRow.add_child(this._valueLabel);
        }

        centerCol.add_child(topRow);

        if (t.body) {
            this._bodyLabel = new St.Label({
                text: t.body,
                style_class: 'bayisland-transient-body',
                x_expand: true,
            });
            this._bodyLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            centerCol.add_child(this._bodyLabel);
        }

        if (t.level !== null && t.level !== undefined) {
            this._trackWidth = t.kind === 'power' ? 182 : 196;
            const track = new St.Widget({
                style_class: 'bayisland-level-track',
                width: this._trackWidth,
                layout_manager: new Clutter.BinLayout(),
                clip_to_allocation: true,
            });

            const maxVal = t.maxLevel && t.maxLevel > 0 ? t.maxLevel : 1;
            const ratio = Math.max(0, Math.min(1, t.level / maxVal));
            const isOverdrive = t.level > 1.001 && maxVal <= 1.001;
            let fillCls = 'bayisland-level-fill';
            let fillStyle = `background-color: ${palette?.accentCss ?? '#60a5fa'};`;
            if (isOverdrive) {
                fillCls += ' bayisland-level-fill-overdrive';
                fillStyle = '';
            } else if (t.kind === 'power') {
                fillCls += ' bayisland-level-fill-power';
                fillStyle = '';
            }

            this._levelFill = new St.Widget({
                style_class: fillCls,
                ...(fillStyle ? { style: fillStyle } : {}),
                width: Math.max(4, Math.round(this._trackWidth * ratio)),
                x_align: Clutter.ActorAlign.START,
            });
            track.add_child(this._levelFill);
            centerCol.add_child(track);
        }

        if (Array.isArray(t.actions) && t.actions.length > 0) {
            const actionsRow = new St.BoxLayout({
                style_class: 'bayisland-actions-row',
            });
            const acc = palette?.accentCss || '#93c5fd';
            const fg = palette?.accentFgCss || '#090d16';
            for (const act of t.actions.slice(0, 3)) {
                const btn = new St.Button({
                    label: act.label,
                    style_class: `bayisland-action-btn${act.primary ? ' bayisland-action-btn-primary' : ''}`,
                    ...(act.primary ? { style: `background-color: ${acc}; color: ${fg};` } : {}),
                    reactive: true,
                    can_focus: false,
                });
                btn.connect('clicked', () => {
                    try {
                        act.callback?.();
                    } finally {
                        this._onDismiss?.(t.id);
                    }
                });
                actionsRow.add_child(btn);
            }
            centerCol.add_child(actionsRow);
        }

        box.add_child(centerCol);

        if (t.kind === 'notification' || t.kind === 'alarm' || t.sticky) {
            const closeBtn = new St.Button({
                style_class: 'bayisland-dismiss-btn',
                reactive: true,
                can_focus: false,
                y_align: Clutter.ActorAlign.START,
                child: new St.Icon({
                    icon_name: 'window-close-symbolic',
                    icon_size: 13,
                }),
            });
            closeBtn.connect('clicked', () => this._onDismiss?.(t.id));
            box.add_child(closeBtn);
        }

        this._root = box;
        return box;
    }

    updateInPlace(model) {
        const t = model.transient;
        if (!this._root || !t)
            return false;
        if (t.kind !== this._currentKind || (t.coalesceKey ?? null) !== this._currentCoalesceKey)
            return false;

        if (this._titleLabel)
            this._titleLabel.text = t.title || 'BayIsland';
        if (this._bodyLabel && t.body !== undefined)
            this._bodyLabel.text = t.body || '';
        if (this._icon) {
            const gicon = this._resolveGIcon(t);
            if (gicon)
                this._icon.gicon = gicon;
            else if (t.iconName)
                this._icon.icon_name = t.iconName;
        }
        if (t.level !== null && t.level !== undefined) {
            const maxVal = t.maxLevel && t.maxLevel > 0 ? t.maxLevel : 1;
            const ratio = Math.max(0, Math.min(1, t.level / maxVal));
            if (this._valueLabel)
                this._valueLabel.text = `${Math.round((t.level / maxVal) * 100)}%`;
            if (this._levelFill)
                this._levelFill.width = Math.max(4, Math.round(this._trackWidth * ratio));
        }
        return true;
    }

    _resolveGIcon(t) {
        if (t.icon instanceof Gio.Icon)
            return t.icon;
        if (t.iconName)
            return new Gio.ThemedIcon({ name: t.iconName });
        return null;
    }
}
