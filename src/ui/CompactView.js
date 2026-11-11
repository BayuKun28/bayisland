import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import { IslandState } from '../core/PriorityManager.js';
import { createRingGauge } from './RingGauge.js';

const EN_DAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const EN_MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatClock(sec) {
    const s = Math.max(0, Math.floor(sec));
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return `${String(m).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
}

function getPeekDateString() {
    const now = GLib.DateTime.new_now_local();
    const dow = now.get_day_of_week() % 7;
    const monthIdx = Math.max(0, Math.min(11, now.get_month() - 1));
    return `${EN_DAYS_SHORT[dow]} ${now.get_day_of_month()} ${EN_MONTHS_SHORT[monthIdx]}`;
}

function getPeekClockString() {
    const now = GLib.DateTime.new_now_local();
    let use24h = true;
    try {
        const src = Gio.SettingsSchemaSource.get_default();
        const schema = src?.lookup('org.gnome.desktop.interface', true);
        if (schema) {
            const gs = new Gio.Settings({ settings_schema: schema });
            use24h = gs.get_string('clock-format') !== '12h';
        }
    } catch {
        use24h = true;
    }
    return (use24h ? now.format('%H:%M') : now.format('%I:%M %p')) || '00:00';
}

function getProfileIconName(profile) {
    if (profile === 'power-saver')
        return 'power-profile-power-saver-symbolic';
    if (profile === 'performance')
        return 'power-profile-performance-symbolic';
    return 'power-profile-balanced-symbolic';
}

export function buildEqualizerWidget(barCount = 4, accentCss = '#93c5fd') {
    const eqBox = new St.BoxLayout({
        style_class: 'bayisland-eq-box',
        y_align: Clutter.ActorAlign.CENTER,
    });
    const bars = [];
    for (let i = 0; i < barCount; i++) {
        const bar = new St.Widget({
            style_class: 'bayisland-eq-bar',
            style: `background-color: ${accentCss};`,
            y_align: Clutter.ActorAlign.END,
        });
        eqBox.add_child(bar);
        bars.push(bar);
    }
    return { eqBox, bars };
}

/**
 * Builds and updates IDLE_BAR, INTEGRATED_CLOCK, HOVER_PEEK, DROP_CATCH, AMBIENT_DOT, and COMPACT_PILL layouts.
 */
export class CompactView {
    constructor({ onExpand, onMediaToggle }) {
        this._onExpand = onExpand;
        this._onMediaToggle = onMediaToggle;
        this._root = null;
        this._currentPrimary = null;

        this._idleTopPad = 4;
        this._idleHitHeight = 18;
        this._idleAlignStart = false;
        this._edgeFlush = false;
        this._integratedHeight = 28;
        this._renderedHeight = 28;
        this._integratedMaxWidth = 360;
        this._integratedInSlot = false;
        this._integratedFullLayout = true;
        this._integratedPreset = 'hover-pill';
        this._integratedShowDate = true;
        this._integratedShowBatText = true;
        this._integratedHasCam = false;
        this._integratedHasMic = false;
        this._integratedMicMuted = false;
        this._integratedHadUnread = false;

        this._titleLabel = null;
        this._timerLabel = null;
        this._eqBars = [];

        this._idleUnreadDot = null;
        this._peekDateLabel = null;
        this._peekDateSep = null;
        this._peekClockLabel = null;
        this._peekBatRing = null;
        this._peekBatNumLabel = null;
        this._peekBadge = null;
        this._peekBadgeLabel = null;
        this._peekDndIcon = null;
        this._peekProfileIcon = null;
        this._integratedDot = null;
        this._dropIcon = null;
        this._dropTitleLabel = null;
    }

    setIntegratedMetrics({ height = 28, maxWidth = 360, inSlot = false } = {}) {
        const nextH = Math.max(22, Math.min(44, Math.round(height)));
        const nextMaxW = Math.max(150, Math.round(maxWidth));
        const nextInSlot = Boolean(inSlot);
        const changed =
            nextH !== this._integratedHeight ||
            nextMaxW !== this._integratedMaxWidth ||
            nextInSlot !== this._integratedInSlot;
        this._integratedHeight = nextH;
        this._integratedMaxWidth = nextMaxW;
        this._integratedInSlot = nextInSlot;
        return changed;
    }

    render(model, palette) {
        if (model.state === IslandState.IDLE_BAR)
            return this._renderIdleBar(model, palette);
        if (model.state === IslandState.INTEGRATED_CLOCK)
            return this._renderIntegratedClock(model, palette);
        if (model.state === IslandState.HOVER_PEEK)
            return this._renderHoverPeek(model, palette);
        if (model.state === IslandState.DROP_CATCH)
            return this._renderDropCatch(model, palette);

        const primary = model.primary;
        if (primary === 'idle')
            return this._renderIdle();
        if (primary === 'privacy')
            return this._renderPrivacy(model.persistent.privacy);
        if (primary === 'timer')
            return this._renderTimer(model.persistent.timer);
        return this._renderMedia(model.persistent.media, palette);
    }

    _useIntegratedFullLayout(model) {
        if (!model || model.state !== IslandState.INTEGRATED_CLOCK)
            return false;
        return model.preset === 'hover-pill' || (Boolean(model.hovered) && Boolean(model.expandOnHover));
    }

    _syncStatusBadgesAndClock(model, { useCompactBattery = false } = {}) {
        const meta = model.meta ?? {};
        const unread = meta.unreadNotifs ?? 0;
        const wantDndOnly = unread === 0 && Boolean(meta.dnd);
        const dateStr = meta.dateText || getPeekDateString();
        const clockStr = meta.clockText || getPeekClockString();

        if (this._peekDateLabel)
            this._peekDateLabel.text = dateStr;
        if (this._peekClockLabel)
            this._peekClockLabel.text = clockStr;

        if (this._peekProfileIcon)
            this._peekProfileIcon.icon_name = getProfileIconName(meta.powerProfile);

        if (this._peekBatRing) {
            const pct = Math.max(0, Math.min(100, Math.round(meta.powerPct ?? 0)));
            const ringColor = (meta.onBattery && pct <= 20)
                ? '#ef4444'
                : (meta.charging ? '#4ade80' : '#34d399');
            this._peekBatRing.setValues({ fraction: pct / 100, colorCss: ringColor });
            if (this._peekBatNumLabel) {
                const compactFont = this._integratedHeight <= 25
                    ? '9.5px'
                    : (this._integratedHeight >= 29 ? '11px' : '10.5px');
                this._peekBatNumLabel.text = `${pct}%`;
                this._peekBatNumLabel.style = (meta.onBattery && pct <= 20)
                    ? `color: #fca5a5;${useCompactBattery ? ` font-size: ${compactFont};` : ''}`
                    : `color: #f1f5f9;${useCompactBattery ? ` font-size: ${compactFont};` : ''}`;
            }
        }

        if (this._peekBadgeLabel && unread > 0)
            this._peekBadgeLabel.text = String(unread);

        if (this._integratedDot)
            this._integratedDot.visible = unread > 0;

        return { unread, wantDndOnly };
    }

    updateInPlace(model) {
        if (!this._root)
            return false;

        if (model.state === IslandState.IDLE_BAR && this._currentPrimary === 'idle-bar') {
            if (this._idleUnreadDot)
                this._idleUnreadDot.visible = (model.meta?.unreadNotifs ?? 0) > 0;
            return true;
        }

        if (model.state === IslandState.INTEGRATED_CLOCK && this._currentPrimary === 'integrated-clock') {
            const wantFull = this._useIntegratedFullLayout(model);
            const wantDate = this._integratedMaxWidth >= 208;
            const wantBatText = this._integratedMaxWidth >= 264;
            const priv = model.persistent?.privacy ?? {};
            const hasCam = Boolean(priv.active && priv.camera);
            const hasMic = Boolean(priv.active && priv.mic);
            const micMuted = Boolean(priv.micMuted);
            const heightChanged = Math.abs(this._integratedHeight - (this._renderedHeight ?? this._integratedHeight)) >= 1;
            if ((wantFull && heightChanged) ||
                wantFull !== this._integratedFullLayout ||
                (model.preset ?? 'hover-pill') !== this._integratedPreset ||
                wantDate !== this._integratedShowDate ||
                wantBatText !== this._integratedShowBatText ||
                hasCam !== this._integratedHasCam ||
                hasMic !== this._integratedHasMic ||
                (hasMic && micMuted !== this._integratedMicMuted))
                return false;

            const meta = model.meta ?? {};
            const unread = meta.unreadNotifs ?? 0;
            const wantDndOnly = unread === 0 && Boolean(meta.dnd);

            if (wantFull) {
                if ((unread > 0) !== Boolean(this._peekBadge))
                    return false;
                if (wantDndOnly !== Boolean(this._peekDndIcon))
                    return false;
            } else {
                if ((unread > 0) !== this._integratedHadUnread)
                    return false;
                if (wantDndOnly !== Boolean(this._peekDndIcon))
                    return false;
                if (heightChanged && this._root) {
                    this._root.height = this._integratedHeight;
                    this._renderedHeight = this._integratedHeight;
                }
            }

            this._syncStatusBadgesAndClock(model, { useCompactBattery: true });
            return true;
        }

        if (model.state === IslandState.HOVER_PEEK && this._currentPrimary === 'peek') {
            const meta = model.meta ?? {};
            const unread = meta.unreadNotifs ?? 0;
            const wantDndOnly = unread === 0 && Boolean(meta.dnd);
            if ((unread > 0) !== Boolean(this._peekBadge))
                return false;
            if (wantDndOnly !== Boolean(this._peekDndIcon))
                return false;
            this._syncStatusBadgesAndClock(model, { useCompactBattery: false });
            return true;
        }

        if (model.state === IslandState.DROP_CATCH && this._currentPrimary === 'drop-catch') {
            const hi = Boolean(model.meta?.dragHighlight);
            const acc = this._lastPalette?.accentOnDarkCss || this._lastPalette?.accentCss || '#93c5fd';
            const fg = this._lastPalette?.accentFgCss || '#090d16';
            if (this._dropIcon)
                this._dropIcon.style = hi ? `color: ${fg};` : `color: ${acc};`;
            if (this._dropTitleLabel) {
                this._dropTitleLabel.text = hi ? 'Drop now to stash on Shelf' : 'Drop Files onto BayIsland Shelf';
                this._dropTitleLabel.style = hi ? `color: ${fg};` : null;
            }
            if (this._dropSubLabel)
                this._dropSubLabel.style = hi ? `color: ${fg}; opacity: 0.85;` : null;
            this._root.style_class = `bayisland-dropcatch-box${hi ? ' bayisland-dropcatch-active' : ''}`;
            return true;
        }

        if (model.primary === 'timer' && this._currentPrimary === 'timer' && this._timerLabel) {
            this._timerLabel.text = formatClock(model.persistent.timer.remainingSec ?? 0);
            return true;
        }
        if (model.primary === 'media' && this._currentPrimary === 'media' && this._titleLabel) {
            this._titleLabel.text = model.persistent.media.title || 'Media';
            return true;
        }
        return false;
    }

    setIdleHitbox({ topPad = 4, hitHeight = 18, alignStart = false, edgeFlush = false } = {}) {
        const nextPad = Math.max(0, Math.round(topPad));
        const nextH = Math.max(16, Math.round(hitHeight));
        const nextAlign = Boolean(alignStart);
        const nextFlush = Boolean(edgeFlush);
        const changed =
            nextPad !== this._idleTopPad ||
            nextH !== this._idleHitHeight ||
            nextAlign !== this._idleAlignStart ||
            nextFlush !== this._edgeFlush;

        this._idleTopPad = nextPad;
        this._idleHitHeight = nextH;
        this._idleAlignStart = nextAlign;
        this._edgeFlush = nextFlush;

        if (changed && this._root && this._currentPrimary === 'idle-bar') {
            this._root.style = this._idleAlignStart
                ? `padding: ${this._idleTopPad}px 8px 4px 8px;`
                : null;
            this._root.y_align = this._idleAlignStart
                ? Clutter.ActorAlign.START
                : Clutter.ActorAlign.CENTER;
        }
    }

    getEqBars() {
        return this._eqBars;
    }

    getPreferredSize(model) {
        if (model.state === IslandState.IDLE_BAR)
            return { width: 172, height: this._idleHitHeight };
        if (model.state === IslandState.INTEGRATED_CLOCK) {
            const meta = model.meta ?? {};
            const priv = model.persistent?.privacy ?? {};
            const hasCam = Boolean(priv.active && priv.camera);
            const hasMic = Boolean(priv.active && priv.mic);
            const unread = meta.unreadNotifs ?? 0;
            const dnd = Boolean(meta.dnd);
            const showDate = this._integratedMaxWidth >= 208;
            const showBatText = this._integratedMaxWidth >= 264;
            const dateStr = showDate ? (meta.dateText || getPeekDateString()) : '';
            const clockStr = meta.clockText || getPeekClockString();
            const extraDatePx = showDate ? Math.max(0, dateStr.length - 6) * 6 : 0;
            const extraClockPx = Math.max(0, clockStr.length - 5) * 6;
            const full = this._useIntegratedFullLayout(model);
            let w;
            if (full) {
                const batBase = showBatText ? (showDate ? 278 : 230) : (showDate ? 238 : 190);
                const statusExtra = (unread > 0 ? 32 : (dnd ? 18 : 0)) + (hasCam ? 10 : 0) + (hasMic ? 10 : 0);
                w = batBase + statusExtra + extraDatePx + extraClockPx;
            } else {
                const dotExtra = ((unread > 0 || dnd) ? 14 : 0) + (hasCam ? 10 : 0) + (hasMic ? 10 : 0);
                const idleBase = showDate
                    ? (model.preset === 'handle-clock' ? 164 : 140)
                    : (model.preset === 'handle-clock' ? 100 : 76);
                w = idleBase + dotExtra + extraDatePx + extraClockPx;
            }
            return {
                width: Math.min(this._integratedMaxWidth, w),
                height: this._integratedHeight,
            };
        }
        if (model.state === IslandState.HOVER_PEEK) {
            const meta = model.meta ?? {};
            const unread = meta.unreadNotifs ?? 0;
            const dnd = Boolean(meta.dnd);
            const clockStr = meta.clockText || getPeekClockString();
            const extraClockPx = Math.max(0, clockStr.length - 5) * 6;
            const h = this._edgeFlush ? (40 + this._idleTopPad) : 40;
            const w = (unread > 0 ? 336 : (dnd ? 318 : 306)) + extraClockPx;
            return { width: w, height: h };
        }
        if (model.state === IslandState.DROP_CATCH)
            return { width: 320, height: 68 };

        const slotH = this._integratedInSlot ? this._integratedHeight : null;
        if (model.primary === 'idle')
            return { width: 84, height: Math.min(24, slotH ?? 24) };
        if (model.primary === 'privacy') {
            const p = model.persistent.privacy;
            const dual = p.camera && p.mic;
            return { width: dual ? 136 : 112, height: slotH ? Math.min(30, slotH) : 30 };
        }
        if (model.primary === 'timer')
            return { width: 142, height: slotH ? Math.min(34, slotH) : 36 };
        return { width: 224, height: slotH ? Math.min(34, slotH) : 36 };
    }

    _attachRoot(root) {
        this._root = root;
        root.connect('destroy', () => {
            if (this._root === root) {
                this._root = null;
                this._currentPrimary = null;
                this._resetRefs();
            }
        });
        return root;
    }

    stripEdgePadding() {
        if (this._root && this._currentPrimary === 'peek' && this._edgeFlush)
            this._root.style = 'padding: 0px;';
    }

    _resetRefs() {
        this._eqBars = [];
        this._titleLabel = null;
        this._timerLabel = null;
        this._idleUnreadDot = null;
        this._peekDateLabel = null;
        this._peekDateSep = null;
        this._peekClockLabel = null;
        this._peekBatRing = null;
        this._peekBatNumLabel = null;
        this._peekBadge = null;
        this._peekBadgeLabel = null;
        this._peekDndIcon = null;
        this._peekProfileIcon = null;
        this._integratedDot = null;
        this._dropIcon = null;
        this._dropTitleLabel = null;
        this._dropSubLabel = null;
    }

    _renderIdleBar(model, palette) {
        this._resetRefs();
        this._currentPrimary = 'idle-bar';
        this._lastPalette = palette;

        const wrap = new St.BoxLayout({
            style_class: 'bayisland-idle-handle-wrap',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: this._idleAlignStart ? Clutter.ActorAlign.START : Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true,
            ...(this._idleAlignStart ? { style: `padding: ${this._idleTopPad}px 8px 4px 8px;` } : {}),
        });

        const hasNotifs = (model.meta?.unreadNotifs ?? 0) > 0;
        const bar = new St.Widget({
            style_class: 'bayisland-idle-handle-bar',
            y_align: Clutter.ActorAlign.CENTER,
        });
        wrap.add_child(bar);

        this._idleUnreadDot = new St.Widget({
            style_class: 'bayisland-idle-handle-dot',
            y_align: Clutter.ActorAlign.CENTER,
            ...(palette?.accentOnDarkCss || palette?.accentCss
                ? { style: `background-color: ${palette.accentOnDarkCss || palette.accentCss};` }
                : {}),
            visible: hasNotifs,
        });
        wrap.add_child(this._idleUnreadDot);

        return this._attachRoot(wrap);
    }

    _appendPrivacyDots(container, privacy) {
        if (!privacy?.active)
            return false;
        let added = false;
        if (privacy.camera) {
            container.add_child(new St.Widget({
                style_class: 'bayisland-privacy-dot-sm bayisland-privacy-dot-cam',
                y_align: Clutter.ActorAlign.CENTER,
            }));
            added = true;
        }
        if (privacy.mic) {
            container.add_child(new St.Widget({
                style_class: `bayisland-privacy-dot-sm ${privacy.micMuted ? 'bayisland-privacy-dot-mic-muted' : 'bayisland-privacy-dot-mic'}`,
                y_align: Clutter.ActorAlign.CENTER,
            }));
            added = true;
        }
        return added;
    }

    _renderIntegratedClock(model, palette) {
        this._resetRefs();
        this._currentPrimary = 'integrated-clock';
        this._lastPalette = palette;
        const meta = model.meta ?? {};
        const priv = model.persistent?.privacy ?? {};
        const unread = meta.unreadNotifs ?? 0;
        const preset = model.preset ?? 'hover-pill';
        const fullLayout = this._useIntegratedFullLayout(model);
        const showDate = this._integratedMaxWidth >= 208;
        const showBatText = this._integratedMaxWidth >= 264;
        this._integratedPreset = preset;
        this._integratedFullLayout = fullLayout;
        this._integratedShowDate = showDate;
        this._integratedShowBatText = showBatText;
        this._integratedHasCam = Boolean(priv.active && priv.camera);
        this._integratedHasMic = Boolean(priv.active && priv.mic);
        this._integratedMicMuted = Boolean(priv.micMuted);
        this._integratedHadUnread = unread > 0;
        this._renderedHeight = this._integratedHeight;

        const dateStr = meta.dateText || getPeekDateString();
        const clockStr = meta.clockText || getPeekClockString();

        if (fullLayout) {
            const box = new St.BoxLayout({
                style_class: 'bayisland-peek-box bayisland-integrated-clock-box',
                x_expand: true,
                y_expand: true,
                height: this._integratedHeight,
                y_align: Clutter.ActorAlign.CENTER,
            });

            const pct = Math.max(0, Math.min(100, Math.round(meta.powerPct ?? 0)));
            const ringSize = Math.max(15, Math.min(20, this._integratedHeight - 9));
            const ringColor = (meta.onBattery && pct <= 20)
                ? '#ef4444'
                : (meta.charging ? '#4ade80' : '#34d399');
            const compactFont = this._integratedHeight <= 25
                ? '9.5px'
                : (this._integratedHeight >= 29 ? '11px' : '10.5px');

            const batChip = new St.BoxLayout({
                style_class: 'bayisland-peek-chip bayisland-peek-chip-compact',
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._peekBatRing = createRingGauge({
                size: ringSize,
                strokeWidth: 2.1,
                fraction: pct / 100,
                colorCss: ringColor,
                trackCss: 'rgba(255, 255, 255, 0.14)',
            });
            batChip.add_child(this._peekBatRing.actor);

            if (showBatText) {
                this._peekBatNumLabel = new St.Label({
                    text: `${pct}%`,
                    style_class: 'bayisland-peek-bat-text',
                    style: (meta.onBattery && pct <= 20)
                        ? `color: #fca5a5; font-size: ${compactFont};`
                        : `color: #f1f5f9; font-size: ${compactFont};`,
                    y_align: Clutter.ActorAlign.CENTER,
                });
                batChip.add_child(this._peekBatNumLabel);
            }
            box.add_child(batChip);

            const centerGroup = new St.BoxLayout({
                style_class: 'bayisland-peek-center',
                x_expand: true,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            });
            if (showDate) {
                this._peekDateLabel = new St.Label({
                    text: dateStr,
                    style_class: 'bayisland-peek-date',
                    y_align: Clutter.ActorAlign.CENTER,
                });
                centerGroup.add_child(this._peekDateLabel);
                this._peekDateSep = new St.Label({
                    text: '•',
                    style_class: 'bayisland-peek-sep',
                    y_align: Clutter.ActorAlign.CENTER,
                });
                centerGroup.add_child(this._peekDateSep);
            }
            this._peekClockLabel = new St.Label({
                text: clockStr,
                style_class: 'bayisland-peek-clock',
                y_align: Clutter.ActorAlign.CENTER,
            });
            centerGroup.add_child(this._peekClockLabel);
            box.add_child(centerGroup);

            const rightGroup = new St.BoxLayout({
                style_class: 'bayisland-peek-right',
                y_align: Clutter.ActorAlign.CENTER,
            });

            const statusChip = new St.BoxLayout({
                style_class: 'bayisland-peek-chip bayisland-peek-chip-compact',
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._appendPrivacyDots(statusChip, priv);
            this._peekProfileIcon = new St.Icon({
                icon_name: getProfileIconName(meta.powerProfile),
                icon_size: 12,
                style: `color: ${palette?.accentOnDarkCss ?? palette?.accentCss ?? '#93c5fd'};`,
                y_align: Clutter.ActorAlign.CENTER,
            });
            statusChip.add_child(this._peekProfileIcon);

            if (unread > 0) {
                const acc = palette?.accentCss || '#93c5fd';
                const fg = palette?.accentFgCss || '#090d16';
                this._peekBadge = new St.BoxLayout({
                    style_class: 'bayisland-peek-badge',
                    y_align: Clutter.ActorAlign.CENTER,
                    style: `spacing: 3px; background-color: ${acc}; color: ${fg};`,
                });
                this._peekBadge.add_child(new St.Icon({
                    icon_name: meta.dnd ? 'notifications-disabled-symbolic' : 'preferences-system-notifications-symbolic',
                    icon_size: 10,
                    style: `color: ${fg};`,
                }));
                this._peekBadgeLabel = new St.Label({
                    text: String(unread),
                    style: `color: ${fg}; font-weight: 700;`,
                });
                this._peekBadge.add_child(this._peekBadgeLabel);
                statusChip.add_child(this._peekBadge);
            } else if (meta.dnd) {
                this._peekDndIcon = new St.Icon({
                    icon_name: 'notifications-disabled-symbolic',
                    icon_size: 12,
                    style: 'color: #fbbf24;',
                    y_align: Clutter.ActorAlign.CENTER,
                });
                statusChip.add_child(this._peekDndIcon);
            }
            rightGroup.add_child(statusChip);

            rightGroup.add_child(new St.Bin({
                style_class: 'bayisland-peek-expand-btn bayisland-peek-expand-btn-compact',
                y_align: Clutter.ActorAlign.CENTER,
                child: new St.Icon({
                    icon_name: 'pan-down-symbolic',
                    icon_size: 11,
                    style_class: 'bayisland-peek-chevron',
                }),
            }));
            box.add_child(rightGroup);
            return this._attachRoot(box);
        }

        // Minimal Clock or Handle+Clock idle layout (clean single-row centered capsule)
        const accentBright = palette?.accentOnDarkCss ?? palette?.accentCss;
        const row = new St.BoxLayout({
            style_class: 'bayisland-integrated-minimal-box',
            x_expand: true,
            y_expand: true,
            height: this._integratedHeight,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        if (preset === 'handle-clock') {
            row.add_child(new St.Widget({
                style_class: 'bayisland-integrated-handle-pill',
                y_align: Clutter.ActorAlign.CENTER,
                ...(accentBright ? { style: `background-color: ${accentBright};` } : {}),
            }));
        }

        if (showDate) {
            this._peekDateLabel = new St.Label({
                text: dateStr,
                style_class: 'bayisland-peek-date',
                y_align: Clutter.ActorAlign.CENTER,
            });
            row.add_child(this._peekDateLabel);
            this._peekDateSep = new St.Label({
                text: '•',
                style_class: 'bayisland-peek-sep',
                y_align: Clutter.ActorAlign.CENTER,
            });
            row.add_child(this._peekDateSep);
        }
        this._peekClockLabel = new St.Label({
            text: clockStr,
            style_class: 'bayisland-peek-clock',
            y_align: Clutter.ActorAlign.CENTER,
        });
        row.add_child(this._peekClockLabel);

        this._appendPrivacyDots(row, priv);

        if (unread > 0) {
            this._integratedDot = new St.Widget({
                style_class: 'bayisland-idle-handle-dot',
                y_align: Clutter.ActorAlign.CENTER,
                ...(accentBright ? { style: `background-color: ${accentBright};` } : {}),
            });
            row.add_child(this._integratedDot);
        } else if (meta.dnd) {
            this._peekDndIcon = new St.Icon({
                icon_name: 'notifications-disabled-symbolic',
                icon_size: 11,
                style: 'color: #fbbf24;',
                y_align: Clutter.ActorAlign.CENTER,
            });
            row.add_child(this._peekDndIcon);
        }

        return this._attachRoot(row);
    }

    _renderHoverPeek(model, palette) {
        this._resetRefs();
        this._currentPrimary = 'peek';
        this._lastPalette = palette;
        const meta = model.meta ?? {};

        const box = new St.BoxLayout({
            style_class: this._edgeFlush ? 'bayisland-peek-box bayisland-peek-pill' : 'bayisland-peek-box',
            ...(this._edgeFlush && palette?.pillBgCss
                ? { style: `background-color: ${palette.pillBgCss};` }
                : {}),
            x_expand: true,
            y_expand: !this._edgeFlush,
            height: 40,
            y_align: Clutter.ActorAlign.CENTER,
        });

        // Left Chip: Clean 18px Cairo Battery Arc + Tabular Readout
        const pct = Math.max(0, Math.min(100, Math.round(meta.powerPct ?? 0)));
        const ringColor = (meta.onBattery && pct <= 20)
            ? '#ef4444'
            : (meta.charging ? '#4ade80' : '#34d399');

        const batChip = new St.BoxLayout({
            style_class: 'bayisland-peek-chip',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._peekBatRing = createRingGauge({
            size: 18,
            strokeWidth: 2.3,
            fraction: pct / 100,
            colorCss: ringColor,
            trackCss: 'rgba(255, 255, 255, 0.14)',
        });
        batChip.add_child(this._peekBatRing.actor);

        this._peekBatNumLabel = new St.Label({
            text: `${pct}%`,
            style_class: 'bayisland-peek-bat-text',
            style: (meta.onBattery && pct <= 20) ? 'color: #fca5a5;' : 'color: #f1f5f9;',
            y_align: Clutter.ActorAlign.CENTER,
        });
        batChip.add_child(this._peekBatNumLabel);
        box.add_child(batChip);

        // Center Focal Zone: Symmetrical Date • Clock
        const centerGroup = new St.BoxLayout({
            style_class: 'bayisland-peek-center',
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._peekDateLabel = new St.Label({
            text: meta.dateText || getPeekDateString(),
            style_class: 'bayisland-peek-date',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._peekDateSep = new St.Label({
            text: '•',
            style_class: 'bayisland-peek-sep',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._peekClockLabel = new St.Label({
            text: meta.clockText || getPeekClockString(),
            style_class: 'bayisland-peek-clock',
            y_align: Clutter.ActorAlign.CENTER,
        });
        centerGroup.add_child(this._peekDateLabel);
        centerGroup.add_child(this._peekDateSep);
        centerGroup.add_child(this._peekClockLabel);
        box.add_child(centerGroup);

        // Right Anchor: Status Chip (Power Profile + Unread / DND) + Circular Expand Cue
        const rightGroup = new St.BoxLayout({
            style_class: 'bayisland-peek-right',
            y_align: Clutter.ActorAlign.CENTER,
        });

        const statusChip = new St.BoxLayout({
            style_class: 'bayisland-peek-chip',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._peekProfileIcon = new St.Icon({
            icon_name: getProfileIconName(meta.powerProfile),
            icon_size: 13,
            style: `color: ${palette?.accentOnDarkCss ?? palette?.accentCss ?? '#93c5fd'};`,
            y_align: Clutter.ActorAlign.CENTER,
        });
        statusChip.add_child(this._peekProfileIcon);

        const unread = meta.unreadNotifs ?? 0;
        if (unread > 0) {
            const acc = palette?.accentCss || '#93c5fd';
            const fg = palette?.accentFgCss || '#090d16';
            this._peekBadge = new St.BoxLayout({
                style_class: 'bayisland-peek-badge',
                y_align: Clutter.ActorAlign.CENTER,
                style: `spacing: 3px; background-color: ${acc}; color: ${fg};`,
            });
            this._peekBadge.add_child(new St.Icon({
                icon_name: meta.dnd ? 'notifications-disabled-symbolic' : 'preferences-system-notifications-symbolic',
                icon_size: 10,
                style: `color: ${fg};`,
            }));
            this._peekBadgeLabel = new St.Label({
                text: String(unread),
                style: `color: ${fg}; font-weight: 700;`,
            });
            this._peekBadge.add_child(this._peekBadgeLabel);
            statusChip.add_child(this._peekBadge);
        } else if (meta.dnd) {
            this._peekDndIcon = new St.Icon({
                icon_name: 'notifications-disabled-symbolic',
                icon_size: 13,
                style: 'color: #fbbf24;',
                y_align: Clutter.ActorAlign.CENTER,
            });
            statusChip.add_child(this._peekDndIcon);
        }
        rightGroup.add_child(statusChip);

        rightGroup.add_child(new St.Bin({
            style_class: 'bayisland-peek-expand-btn',
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({
                icon_name: 'pan-down-symbolic',
                icon_size: 12,
                style_class: 'bayisland-peek-chevron',
            }),
        }));
        box.add_child(rightGroup);

        if (this._edgeFlush) {
            const edgeWrap = new St.Bin({
                style_class: 'bayisland-peek-edge-wrap',
                style: `padding: ${this._idleTopPad}px 0px 0px 0px;`,
                x_expand: true,
                y_expand: true,
                x_align: Clutter.ActorAlign.FILL,
                y_align: Clutter.ActorAlign.START,
                child: box,
            });
            return this._attachRoot(edgeWrap);
        }

        return this._attachRoot(box);
    }

    _renderDropCatch(model, palette) {
        this._resetRefs();
        this._currentPrimary = 'drop-catch';
        this._lastPalette = palette;
        const hi = Boolean(model.meta?.dragHighlight);
        const acc = palette?.accentOnDarkCss || palette?.accentCss || '#93c5fd';
        const fg = palette?.accentFgCss || '#090d16';

        const box = new St.BoxLayout({
            style_class: `bayisland-dropcatch-box${hi ? ' bayisland-dropcatch-active' : ''}`,
            x_expand: true,
            y_expand: true,
            reactive: false,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._dropIcon = new St.Icon({
            icon_name: 'folder-download-symbolic',
            icon_size: 22,
            style: hi ? `color: ${fg};` : `color: ${acc};`,
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(this._dropIcon);

        const col = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'spacing: 2px;',
        });
        this._dropTitleLabel = new St.Label({
            text: hi ? 'Drop now to stash on Shelf' : 'Drop Files onto BayIsland Shelf',
            style_class: 'bayisland-transient-title',
            ...(hi ? { style: `color: ${fg};` } : {}),
        });
        col.add_child(this._dropTitleLabel);
        this._dropSubLabel = new St.Label({
            text: 'Temporary stash • Drag back out or press Ctrl+V',
            style_class: 'bayisland-muted-xs',
            ...(hi ? { style: `color: ${fg}; opacity: 0.85;` } : {}),
        });
        col.add_child(this._dropSubLabel);
        box.add_child(col);

        return this._attachRoot(box);
    }

    _renderIdle() {
        this._resetRefs();
        this._currentPrimary = 'idle';
        const box = new St.BoxLayout({
            style_class: 'bayisland-ambient-box',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true,
        });
        box.add_child(new St.Widget({
            style_class: 'bayisland-idle-dot',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        return this._attachRoot(box);
    }

    _renderPrivacy(privacy) {
        this._resetRefs();
        this._currentPrimary = 'privacy';
        const box = new St.BoxLayout({
            style_class: 'bayisland-ambient-box',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true,
        });

        if (privacy.camera) {
            box.add_child(new St.Widget({
                style_class: 'bayisland-privacy-dot bayisland-privacy-dot-cam',
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }
        if (privacy.mic) {
            box.add_child(new St.Widget({
                style_class: 'bayisland-privacy-dot bayisland-privacy-dot-mic',
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }

        const parts = [];
        if (privacy.camera)
            parts.push('Cam');
        if (privacy.mic)
            parts.push(privacy.micMuted ? 'Mic Muted' : 'Mic');

        box.add_child(new St.Label({
            text: parts.join(' • '),
            style_class: 'bayisland-privacy-label',
            y_align: Clutter.ActorAlign.CENTER,
        }));

        return this._attachRoot(box);
    }

    _renderTimer(timer) {
        this._resetRefs();
        this._currentPrimary = 'timer';

        const box = new St.BoxLayout({
            style_class: 'bayisland-compact-box',
            x_expand: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        box.add_child(new St.Icon({
            icon_name: 'alarm-symbolic',
            icon_size: 15,
            style: 'color: #fbbf24;',
            y_align: Clutter.ActorAlign.CENTER,
        }));

        this._timerLabel = new St.Label({
            text: formatClock(timer.remainingSec ?? 0),
            style_class: 'bayisland-timer-pill-text',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(this._timerLabel);

        const stateLabel = new St.Label({
            text: timer.running ? (timer.mode === 'pomodoro' ? 'POMO' : 'RUN') : 'PAUSE',
            style_class: 'bayisland-compact-sub',
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(stateLabel);

        return this._attachRoot(box);
    }

    _renderMedia(media, palette) {
        this._resetRefs();
        this._currentPrimary = 'media';

        const box = new St.BoxLayout({
            style_class: 'bayisland-compact-box',
            x_expand: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const artWrap = new St.Bin({
            style_class: 'bayisland-art-mini',
            clip_to_allocation: true,
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({
                ...(media.artIcon
                    ? { gicon: media.artIcon }
                    : { icon_name: 'audio-x-generic-symbolic' }),
                icon_size: 20,
            }),
        });
        box.add_child(artWrap);

        this._titleLabel = new St.Label({
            text: media.title || 'Playing',
            style_class: 'bayisland-compact-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._titleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        box.add_child(this._titleLabel);

        const { eqBox, bars } = buildEqualizerWidget(4, palette?.accentOnDarkCss ?? palette?.accentCss ?? '#93c5fd');
        this._eqBars = bars;
        box.add_child(eqBox);

        return this._attachRoot(box);
    }
}
