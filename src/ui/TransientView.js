import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { formatNotificationContent } from '../utils/NotifFormatter.js';

function isRasterAvatarIcon(gicon, fallbackName) {
    if (!gicon)
        return Boolean(fallbackName && !fallbackName.endsWith('-symbolic'));
    if (gicon instanceof Gio.FileIcon || gicon instanceof Gio.BytesIcon)
        return true;
    if (gicon instanceof Gio.ThemedIcon) {
        const names = gicon.get_names?.() ?? [];
        return names.length > 0 && names.every(n => !n.endsWith('-symbolic'));
    }
    return false;
}

function classifyActionRole(act, index, totalActions) {
    const labelLower = String(act?.label || '').trim().toLowerCase();
    if (labelLower === 'clear' || labelLower === 'dismiss' || labelLower === 'close')
        return 'muted';
    if (labelLower === 'settings' || labelLower.includes('notification settings'))
        return 'secondary';
    if (act?.primary)
        return 'primary';
    if (index === 0 && totalActions >= 1)
        return 'subtle-highlight';
    return 'secondary';
}

/**
 * Renders TRANSIENT_BANNER for OSD (volume/brightness/mic/caffeine),
 * Power events, Desktop/Web Notifications (e.g. WhatsApp Web), Terminal Task Done,
 * Resource Spikes, and Alarms with responsive monitor-aware sizing & multi-line wrapping.
 */
export class TransientView {
    constructor({ onDismiss, onActivate }) {
        this._onDismiss = onDismiss;
        this._onActivate = onActivate;

        this._root = null;
        this._centerCol = null;
        this._titleLabel = null;
        this._sourceLabel = null;
        this._bodyLabel = null;
        this._valueLabel = null;
        this._badgeLabel = null;
        this._icon = null;
        this._levelFill = null;
        this._track = null;
        this._trackWidth = 196;
        this._actionsWrap = null;
        this._actionItems = [];
        this._actionsLaidOut = false;

        this._currentCoalesceKey = null;
        this._currentKind = null;
        this._targetWidth = 360;
        this._centerWidth = 260;
        this._isRichLayout = false;
        this._hasActions = false;
        this._hasBody = false;
        this._hasSource = false;
        this._actionSig = '';
        this._isDismissing = false;
    }

    animateDismiss(onComplete) {
        if (this._isDismissing)
            return;
        this._isDismissing = true;
        if (!this._root) {
            onComplete?.();
            return;
        }

        this._root.ease({
            translation_x: 45,
            opacity: 0,
            duration: 130,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                onComplete?.();
            },
        });
    }

    _getMonitorBounds() {
        const monitor = Main.layoutManager.primaryMonitor ?? { width: 1280, height: 800 };
        const maxWidth = Math.max(320, monitor.width - 48);
        const maxHeight = Math.max(180, monitor.height - 96);
        return { monitor, maxWidth, maxHeight };
    }

    _computeTargetWidth(t) {
        const { maxWidth } = this._getMonitorBounds();
        if (!t)
            return Math.min(maxWidth, 320);

        const title = t.title || '';
        const body = t.body || '';
        const sourceTitle = t.sourceTitle || '';
        const actions = Array.isArray(t.actions) ? t.actions.slice(0, 3) : [];
        const hasLevel = t.level !== null && t.level !== undefined;

        if (t.kind === 'osd') {
            const base = hasLevel ? 312 : 244;
            const extraTitle = Math.max(0, title.length - 16) * 5;
            return Math.min(maxWidth, Math.min(410, base + extraTitle));
        }
        if (t.kind === 'power') {
            const base = 304;
            const extra = Math.max(0, title.length - 18) * 4 + (body ? Math.min(80, body.length) : 0);
            return Math.min(maxWidth, Math.min(420, base + extra));
        }

        // Notification, alarm, task, resource, banner -> adapt width to text & actions
        const actionChars = actions.reduce((acc, a) => acc + (a?.label?.length || 0) + 4, 0);
        const contentScore =
            Math.max(title.length * 1.4, sourceTitle.length) +
            body.length * 0.9 +
            actionChars * 1.1;

        let desired = 382;
        if (contentScore > 140 || actions.length >= 3)
            desired = 476;
        else if (contentScore > 80 || actions.length === 2)
            desired = 446;
        else if (contentScore > 44 || body.length > 0)
            desired = 416;

        if (t.kind === 'alarm')
            desired = Math.max(desired, 396);

        return Math.min(maxWidth, desired);
    }

    estimateWidth(model) {
        return this._computeTargetWidth(model?.transient);
    }

    _layoutActionsOnStage() {
        if (this._actionsLaidOut || !this._actionsWrap || !this._actionItems.length)
            return;
        if (!this._actionsWrap.get_stage())
            return;

        this._actionsLaidOut = true;
        const measured = this._actionItems.map(btn => {
            const [, natW] = btn.get_preferred_width(-1);
            return { btn, width: Math.ceil(natW) };
        });

        const gapPx = 6;
        let needsWrap = false;
        let testW = 0;
        for (let i = 0; i < measured.length; i++) {
            testW = i === 0 ? measured[i].width : (testW + gapPx + measured[i].width);
            if (i > 0 && testW > this._centerWidth) {
                needsWrap = true;
                break;
            }
        }
        if (!needsWrap)
            return;

        for (const row of this._actionsWrap.get_children()) {
            row.remove_all_children();
            this._actionsWrap.remove_child(row);
            row.destroy();
        }

        let currentRow = new St.BoxLayout({ style_class: 'bayisland-actions-row' });
        let rowWidthUsed = 0;
        for (const item of measured) {
            const needed = rowWidthUsed === 0 ? item.width : (rowWidthUsed + gapPx + item.width);
            if (rowWidthUsed > 0 && needed > this._centerWidth) {
                this._actionsWrap.add_child(currentRow);
                currentRow = new St.BoxLayout({ style_class: 'bayisland-actions-row' });
                rowWidthUsed = item.width;
            } else {
                rowWidthUsed = needed;
            }
            currentRow.add_child(item.btn);
        }
        if (currentRow.get_n_children() > 0)
            this._actionsWrap.add_child(currentRow);
    }

    getPreferredSize(model) {
        const t = model?.transient;
        if (!t)
            return { width: 320, height: 54 };

        const { maxHeight } = this._getMonitorBounds();
        const width = this._targetWidth || this._computeTargetWidth(t);

        const isCompactBar = t.kind === 'osd' || (t.kind === 'power' && !t.body);
        const minKindH = isCompactBar ? 54 : 70;

        let measuredH = minKindH;
        if (this._root && this._centerCol && this._root.get_stage()) {
            this._layoutActionsOnStage();

            const centerW = this._centerWidth || Math.max(160, width - 116);
            let colH = 0;
            let rowCount = 0;

            if (this._sourceLabel) {
                const [sMin, sNat] = this._sourceLabel.get_preferred_height(centerW);
                colH += Math.ceil(Math.max(sMin, sNat));
                rowCount++;
            }

            if (this._titleLabel) {
                let extraTopW = 0;
                if (this._badgeLabel) {
                    const [, bNat] = this._badgeLabel.get_preferred_width(-1);
                    extraTopW += Math.ceil(bNat) + 8;
                }
                if (this._valueLabel) {
                    const [, vNat] = this._valueLabel.get_preferred_width(-1);
                    extraTopW += Math.ceil(vNat) + 8;
                }
                const titleAvailW = Math.max(100, centerW - extraTopW);
                const [tMin, tNat] = this._titleLabel.get_preferred_height(titleAvailW);
                colH += Math.ceil(Math.max(tMin, tNat));
                rowCount++;
            }

            if (this._bodyLabel) {
                const [bMin, bNat] = this._bodyLabel.get_preferred_height(centerW);
                colH += Math.ceil(Math.max(bMin, bNat));
                rowCount++;
            }

            if (this._track) {
                colH += 10;
                rowCount++;
            }

            if (this._actionsWrap) {
                const [aMin, aNat] = this._actionsWrap.get_preferred_height(centerW);
                colH += Math.ceil(Math.max(aMin, aNat)) + 6;
                rowCount++;
            }

            if (rowCount > 1)
                colH += (rowCount - 1) * 4;

            const padY = this._isRichLayout ? 28 : 20;
            const [colMin, colNat] = this._centerCol.get_preferred_height(centerW);
            const [rootMin, rootNat] = this._root.get_preferred_height(width);
            const directH = Math.max(
                Math.ceil(Math.max(colMin, colNat)) + padY,
                Math.ceil(Math.max(rootMin, rootNat))
            );
            const iconReserve = (this._isAvatar ? 40 : 34) + padY;
            measuredH = Math.max(minKindH, Math.ceil(Math.max(iconReserve, colH + padY, directH)) + 2);
        } else if (this._bodyLabel) {
            const lines = Math.max(1, Math.ceil((t.body || '').length / 46));
            measuredH = Math.max(minKindH, 74 + lines * 19 + (this._hasActions ? 40 : 0));
        }

        return {
            width,
            height: Math.min(maxHeight, measuredH),
        };
    }

    render(model, palette) {
        const t = model.transient;
        const formatted = formatNotificationContent({
            title: t.title || 'BayIsland',
            body: t.body || '',
            sourceTitle: t.sourceTitle || '',
            kind: t.kind || 'notification',
            maxTitleChars: 130,
            maxBodyChars: 380,
            maxSourceChars: 48,
        });
        const cleanTitle = formatted.title;
        const cleanBody = formatted.body;
        const cleanSource = formatted.metaLabel;
        const showSource = Boolean(cleanSource);
        const actions = Array.isArray(t.actions) ? t.actions.slice(0, 3) : [];
        const hasClose = t.kind === 'notification' || t.kind === 'alarm' || Boolean(t.sticky);

        this._currentKind = t.kind;
        this._currentCoalesceKey = t.coalesceKey ?? null;
        this._targetWidth = this._computeTargetWidth({
            ...t,
            title: cleanTitle,
            body: cleanBody,
            sourceTitle: cleanSource,
            actions,
        });
        this._hasBody = Boolean(cleanBody);
        this._hasSource = showSource;
        this._hasActions = actions.length > 0;
        this._actionSig = actions.map(a => a?.label || '').join('|');
        this._isDismissing = false;
        this._isRichLayout = Boolean(
            cleanBody || actions.length > 0 || showSource || cleanTitle.length > 34 || t.kind === 'notification' || t.kind === 'alarm'
        );

        this._levelFill = null;
        this._track = null;
        this._valueLabel = null;
        this._badgeLabel = null;
        this._sourceLabel = null;
        this._titleLabel = null;
        this._bodyLabel = null;
        this._icon = null;
        this._actionsWrap = null;
        this._actionItems = [];
        this._actionsLaidOut = false;

        const gicon = this._resolveGIcon(t);
        this._isAvatar = isRasterAvatarIcon(gicon, t.iconName);
        const iconSizePx = this._isAvatar ? 40 : 34;

        // Exact horizontal budget: left/right pad (32) + icon + spacing (12) + optional close spacing (12 + 24)
        const padX = 32;
        const iconGap = 12;
        const closeReserve = hasClose ? (24 + 12) : 0;
        this._centerWidth = Math.max(160, this._targetWidth - padX - iconSizePx - iconGap - closeReserve);

        const topAlign = this._isRichLayout ? Clutter.ActorAlign.START : Clutter.ActorAlign.CENTER;

        const box = new St.BoxLayout({
            style_class: `bayisland-transient-box${this._isRichLayout ? ' bayisland-transient-box-rich' : ''}`,
            x_expand: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.FILL,
        });

        // Icon or Contact Avatar badge
        const iconWrap = new St.Bin({
            style_class: this._isAvatar
                ? 'bayisland-transient-avatar-wrap'
                : 'bayisland-transient-icon-wrap',
            width: iconSizePx,
            height: iconSizePx,
            clip_to_allocation: true,
            y_align: topAlign,
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._icon = new St.Icon({
            ...(gicon
                ? { gicon }
                : { icon_name: t.iconName || 'dialog-information-symbolic' }),
            icon_size: this._isAvatar ? 26 : 18,
            ...(t.iconColor && !this._isAvatar ? { style: `color: ${t.iconColor};` } : {}),
        });
        iconWrap.set_child(this._icon);
        box.add_child(iconWrap);

        // Center column
        const centerCol = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_align: this._isRichLayout ? Clutter.ActorAlign.START : Clutter.ActorAlign.CENTER,
            style: 'spacing: 4px;',
        });
        this._centerCol = centerCol;

        if (showSource) {
            this._sourceLabel = new St.Label({
                text: cleanSource,
                style_class: 'bayisland-transient-source',
                x_expand: true,
            });
            this._sourceLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            centerCol.add_child(this._sourceLabel);
        }

        const topRow = new St.BoxLayout({
            x_expand: true,
            style: 'spacing: 8px;',
            y_align: Clutter.ActorAlign.START,
        });

        this._titleLabel = new St.Label({
            text: cleanTitle,
            style_class: 'bayisland-transient-title',
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.CENTER,
        });
        if (this._isRichLayout || t.kind === 'notification' || t.kind === 'banner' || t.kind === 'task') {
            this._titleLabel.clutter_text.line_wrap = true;
            this._titleLabel.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
            this._titleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        } else {
            this._titleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        }
        topRow.add_child(this._titleLabel);

        if (t.badgeText) {
            let badgeCls = 'bayisland-badge ';
            if (t.badgeKind === 'error')
                badgeCls += 'bayisland-badge-error';
            else if (t.badgeKind === 'warn')
                badgeCls += 'bayisland-badge-warn';
            else
                badgeCls += 'bayisland-badge-success';

            this._badgeLabel = new St.Label({
                text: t.badgeText,
                style_class: badgeCls,
                y_align: Clutter.ActorAlign.CENTER,
            });
            topRow.add_child(this._badgeLabel);
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

        if (cleanBody) {
            this._bodyLabel = new St.Label({
                text: cleanBody,
                style_class: 'bayisland-transient-body',
                x_expand: true,
                x_align: Clutter.ActorAlign.FILL,
            });
            this._bodyLabel.clutter_text.line_wrap = true;
            this._bodyLabel.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
            this._bodyLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            centerCol.add_child(this._bodyLabel);
        }

        if (t.level !== null && t.level !== undefined) {
            this._trackWidth = Math.max(140, this._centerWidth - 4);
            const track = new St.Widget({
                style_class: 'bayisland-level-track',
                width: this._trackWidth,
                layout_manager: new Clutter.BinLayout(),
                clip_to_allocation: true,
            });
            this._track = track;

            const maxVal = t.maxLevel && t.maxLevel > 0 ? t.maxLevel : 1;
            const ratio = Math.max(0, Math.min(1, t.level / maxVal));
            const isOverdrive = t.level > 1.001 && maxVal <= 1.001;
            let fillCls = 'bayisland-level-fill';
            let fillStyle = `background-color: ${palette?.accentCss ?? '#93c5fd'};`;
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

        if (actions.length > 0) {
            const acc = palette?.accentCss || '#93c5fd';
            const fg = palette?.accentFgCss || '#090d16';

            const actionsWrap = new St.BoxLayout({
                vertical: true,
                x_expand: true,
                style_class: 'bayisland-actions-wrap',
            });
            this._actionsWrap = actionsWrap;

            const singleRow = new St.BoxLayout({
                style_class: 'bayisland-actions-row',
            });
            for (let idx = 0; idx < actions.length; idx++) {
                const act = actions[idx];
                const role = classifyActionRole(act, idx, actions.length);
                let btnCls = 'bayisland-action-btn';
                let btnStyle = null;
                if (role === 'primary') {
                    btnCls += ' bayisland-action-btn-primary';
                    btnStyle = `background-color: ${acc}; color: ${fg};`;
                } else if (role === 'subtle-highlight') {
                    btnCls += ' bayisland-action-btn-subtle';
                } else if (role === 'muted') {
                    btnCls += ' bayisland-action-btn-muted';
                }
                const btn = new St.Button({
                    label: act.label,
                    style_class: btnCls,
                    ...(btnStyle ? { style: btnStyle } : {}),
                    reactive: true,
                    can_focus: false,
                });
                btn.connect('clicked', () => {
                    if (this._isDismissing)
                        return;
                    this.animateDismiss(() => {
                        try {
                            act.callback?.();
                        } finally {
                            this._onDismiss?.(t.id);
                        }
                    });
                });
                singleRow.add_child(btn);
                this._actionItems.push(btn);
            }
            actionsWrap.add_child(singleRow);
            centerCol.add_child(actionsWrap);
        }

        box.add_child(centerCol);

        if (hasClose) {
            const closeBtn = new St.Button({
                style_class: 'bayisland-dismiss-btn',
                reactive: true,
                can_focus: false,
                y_align: topAlign,
                child: new St.Icon({
                    icon_name: 'window-close-symbolic',
                    icon_size: 13,
                }),
            });
            closeBtn.connect('clicked', () => {
                if (this._isDismissing)
                    return;
                this.animateDismiss(() => {
                    this._onDismiss?.(t.id);
                });
            });
            box.add_child(closeBtn);
        }

        this._root = box;
        box.connect('destroy', () => {
            if (this._root === box) {
                this._root = null;
                this._centerCol = null;
                this._titleLabel = null;
                this._sourceLabel = null;
                this._bodyLabel = null;
                this._valueLabel = null;
                this._badgeLabel = null;
                this._icon = null;
                this._levelFill = null;
                this._track = null;
                this._actionsWrap = null;
                this._actionItems = [];
            }
        });
        return box;
    }

    updateInPlace(model) {
        const t = model.transient;
        if (!this._root || !t)
            return false;
        if (t.kind !== this._currentKind || (t.coalesceKey ?? null) !== this._currentCoalesceKey)
            return false;

        const formatted = formatNotificationContent({
            title: t.title || 'BayIsland',
            body: t.body || '',
            sourceTitle: t.sourceTitle || '',
            kind: t.kind || 'notification',
            maxTitleChars: 130,
            maxBodyChars: 380,
            maxSourceChars: 48,
        });
        const cleanTitle = formatted.title;
        const cleanBody = formatted.body;
        const cleanSource = formatted.metaLabel;
        const showSource = Boolean(cleanSource);
        const actions = Array.isArray(t.actions) ? t.actions.slice(0, 3) : [];
        const nextActionSig = actions.map(a => a?.label || '').join('|');

        // Re-render structurally if rows/buttons/body/source presence changed
        if (Boolean(cleanBody) !== this._hasBody ||
            showSource !== this._hasSource ||
            nextActionSig !== this._actionSig)
            return false;

        const prevWidth = this._targetWidth;
        this._targetWidth = this._computeTargetWidth({
            ...t,
            title: cleanTitle,
            body: cleanBody,
            sourceTitle: cleanSource,
            actions,
        });
        const maxWDelta = t.kind === 'osd' ? 48 : 24;
        if (Math.abs(this._targetWidth - prevWidth) > maxWDelta)
            return false;

        if (this._sourceLabel)
            this._sourceLabel.text = cleanSource;
        if (this._titleLabel)
            this._titleLabel.text = cleanTitle;
        if (this._bodyLabel && t.body !== undefined)
            this._bodyLabel.text = cleanBody;
        if (this._icon) {
            const gicon = this._resolveGIcon(t);
            if (isRasterAvatarIcon(gicon, t.iconName) !== this._isAvatar)
                return false;
            if (gicon) {
                const curNames = this._icon.gicon?.get_names?.()?.join(',') || '';
                const nextNames = gicon.get_names?.()?.join(',') || '';
                if (curNames !== nextNames || !this._icon.gicon)
                    this._icon.gicon = gicon;
            } else if (t.iconName && this._icon.icon_name !== t.iconName) {
                this._icon.icon_name = t.iconName;
            }
        }
        if (t.level !== null && t.level !== undefined) {
            const maxVal = t.maxLevel && t.maxLevel > 0 ? t.maxLevel : 1;
            const ratio = Math.max(0, Math.min(1, t.level / maxVal));
            if (this._valueLabel)
                this._valueLabel.text = `${Math.round((t.level / maxVal) * 100)}%`;
            if (this._levelFill) {
                const targetW = Math.max(4, Math.round(this._trackWidth * ratio));
                if (this._levelFill.get_stage?.()) {
                    this._levelFill.remove_all_transitions();
                    this._levelFill.ease({
                        width: targetW,
                        duration: 85,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    });
                } else {
                    this._levelFill.width = targetW;
                }
            }
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
