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
 * Builds and updates IDLE_BAR, HOVER_PEEK, DROP_CATCH, AMBIENT_DOT, and COMPACT_PILL layouts.
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

        this._titleLabel = null;
        this._timerLabel = null;
        this._eqBars = [];

        this._idleUnreadDot = null;
        this._peekDateLabel = null;
        this._peekClockLabel = null;
        this._peekBatRing = null;
        this._peekBatNumLabel = null;
        this._peekBadge = null;
        this._peekBadgeLabel = null;
        this._peekDndIcon = null;
        this._peekProfileIcon = null;
        this._dropIcon = null;
        this._dropTitleLabel = null;
    }

    render(model, palette) {
        if (model.state === IslandState.IDLE_BAR)
            return this._renderIdleBar(model, palette);
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

    updateInPlace(model) {
        if (!this._root)
            return false;

        if (model.state === IslandState.IDLE_BAR && this._currentPrimary === 'idle-bar') {
            if (this._idleUnreadDot)
                this._idleUnreadDot.visible = (model.meta?.unreadNotifs ?? 0) > 0;
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
            if (this._peekDateLabel)
                this._peekDateLabel.text = getPeekDateString();
            if (this._peekClockLabel)
                this._peekClockLabel.text = getPeekClockString();
            if (this._peekProfileIcon)
                this._peekProfileIcon.icon_name = getProfileIconName(meta.powerProfile);
            if (this._peekBatRing && this._peekBatNumLabel) {
                const pct = Math.max(0, Math.min(100, Math.round(meta.powerPct ?? 0)));
                const ringColor = (meta.onBattery && pct <= 20)
                    ? '#ef4444'
                    : (meta.charging ? '#4ade80' : '#34d399');
                this._peekBatRing.setValues({ fraction: pct / 100, colorCss: ringColor });
                this._peekBatNumLabel.text = String(pct);
                this._peekBatNumLabel.style = (meta.onBattery && pct <= 20)
                    ? 'color: #fca5a5;'
                    : 'color: #f8fafc;';
            }
            if (this._peekBadgeLabel && unread > 0)
                this._peekBadgeLabel.text = String(unread);
            return true;
        }

        if (model.state === IslandState.DROP_CATCH && this._currentPrimary === 'drop-catch') {
            const hi = Boolean(model.meta?.dragHighlight);
            const acc = this._lastPalette?.accentCss || '#93c5fd';
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
        if (model.state === IslandState.HOVER_PEEK) {
            const unread = model.meta?.unreadNotifs ?? 0;
            const dnd = Boolean(model.meta?.dnd);
            const h = this._edgeFlush ? (36 + this._idleTopPad) : 36;
            return { width: unread > 0 ? 270 : (dnd ? 250 : 236), height: h };
        }
        if (model.state === IslandState.DROP_CATCH)
            return { width: 320, height: 68 };

        if (model.primary === 'idle')
            return { width: 84, height: 24 };
        if (model.primary === 'privacy') {
            const p = model.persistent.privacy;
            const dual = p.camera && p.mic;
            return { width: dual ? 136 : 112, height: 30 };
        }
        if (model.primary === 'timer')
            return { width: 142, height: 36 };
        return { width: 224, height: 36 };
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
        this._peekClockLabel = null;
        this._peekBatRing = null;
        this._peekBatNumLabel = null;
        this._peekBadge = null;
        this._peekBadgeLabel = null;
        this._peekDndIcon = null;
        this._peekProfileIcon = null;
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
            ...(palette?.accentCss ? { style: `background-color: ${palette.accentCss};` } : {}),
            visible: hasNotifs,
        });
        wrap.add_child(this._idleUnreadDot);

        return this._attachRoot(wrap);
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
            height: 36,
            y_align: Clutter.ActorAlign.CENTER,
        });

        // Left Anchor: 24px Cairo Battery Ring
        const pct = Math.max(0, Math.min(100, Math.round(meta.powerPct ?? 0)));
        const ringColor = (meta.onBattery && pct <= 20)
            ? '#ef4444'
            : (meta.charging ? '#4ade80' : '#34d399');

        this._peekBatNumLabel = new St.Label({
            text: String(pct),
            style_class: 'bayisland-peek-ring-num',
            style: (meta.onBattery && pct <= 20) ? 'color: #fca5a5;' : 'color: #f8fafc;',
        });
        this._peekBatRing = createRingGauge({
            size: 24,
            strokeWidth: 2.4,
            fraction: pct / 100,
            colorCss: ringColor,
            trackCss: 'rgba(255, 255, 255, 0.14)',
            centerChild: this._peekBatNumLabel,
        });
        box.add_child(this._peekBatRing.actor);

        // Center Focal Zone: Symmetrical Date + Clock
        const centerGroup = new St.BoxLayout({
            style_class: 'bayisland-peek-center',
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._peekDateLabel = new St.Label({
            text: getPeekDateString(),
            style_class: 'bayisland-peek-date',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._peekClockLabel = new St.Label({
            text: getPeekClockString(),
            style_class: 'bayisland-peek-clock',
            y_align: Clutter.ActorAlign.CENTER,
        });
        centerGroup.add_child(this._peekDateLabel);
        centerGroup.add_child(this._peekClockLabel);
        box.add_child(centerGroup);

        // Right Anchor: Power Profile + Unread Badge / DND + Expand Chevron
        const rightGroup = new St.BoxLayout({
            style_class: 'bayisland-peek-right',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._peekProfileIcon = new St.Icon({
            icon_name: getProfileIconName(meta.powerProfile),
            icon_size: 13,
            style: `color: ${palette?.accentCss ?? '#93c5fd'};`,
            y_align: Clutter.ActorAlign.CENTER,
        });
        rightGroup.add_child(this._peekProfileIcon);

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
            rightGroup.add_child(this._peekBadge);
        } else if (meta.dnd) {
            this._peekDndIcon = new St.Icon({
                icon_name: 'notifications-disabled-symbolic',
                icon_size: 13,
                style: 'color: #fbbf24;',
                y_align: Clutter.ActorAlign.CENTER,
            });
            rightGroup.add_child(this._peekDndIcon);
        }

        rightGroup.add_child(new St.Icon({
            icon_name: 'pan-down-symbolic',
            icon_size: 13,
            style_class: 'bayisland-peek-chevron',
            y_align: Clutter.ActorAlign.CENTER,
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
        const acc = palette?.accentCss || '#93c5fd';
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

        const { eqBox, bars } = buildEqualizerWidget(4, palette?.accentCss ?? '#93c5fd');
        this._eqBars = bars;
        box.add_child(eqBox);

        return this._attachRoot(box);
    }
}
