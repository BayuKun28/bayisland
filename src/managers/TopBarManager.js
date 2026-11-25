import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GnomeDesktop from 'gi://GnomeDesktop';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

import { EN_DAYS_SHORT, EN_MONTHS_SHORT } from '../utils/Formatters.js';
import { TopBarAutohide } from './TopBarAutohide.js';

/**
 * Coordinates GNOME Top Bar integration (dateMenu clock slot replacement,
 * zero-drift clock sync, anti-overlap panel corridor geometry) and delegates
 * panel autohide / intellihide to TopBarAutohide.
 */
export class TopBarManager extends Signals.EventEmitter {
    constructor({ signals, timers }) {
        super();
        this._signals = signals;
        this._timers = timers;
        this._destroyed = false;

        // Clock & date slot options
        this._integrationMode = 'merged-pill';
        this._hiddenState = true;
        this._reservedWidth = 224;
        this._slotClaimed = false;
        this._savedDateMenu = null;
        this._lastAppliedReserveW = -1;
        this._lastAppliedTargetH = -1;
        this._syncingSlot = false;

        // Clock formatting settings + WallClock sync
        this._ifaceSettings = null;
        this._wallClock = null;
        this._wallClockSigId = 0;
        this._clockFallbackTimerId = 0;
        this._clockText = '00:00';
        this._dateText = '';

        this._autohide = new TopBarAutohide({
            signals: this._signals,
            timers: this._timers,
            onPanelStateChanged: () => {
                this._syncDateMenuSlot();
                this.emit('panel-state-changed');
            },
            getPanelMetrics: () => this.getPanelMetrics(),
            isPanelVisiblyShowing: () => this.isPanelVisiblyShowing(),
        });

        this._initClock();
    }

    _initClock() {
        try {
            const src = Gio.SettingsSchemaSource.get_default();
            const schema = src?.lookup('org.gnome.desktop.interface', true);
            if (schema) {
                this._ifaceSettings = new Gio.Settings({ settings_schema: schema });
                for (const key of ['clock-format', 'clock-show-date', 'clock-show-weekday', 'clock-show-seconds']) {
                    this._signals.connect(this._ifaceSettings, `changed::${key}`, () => {
                        this._refreshClockText();
                    });
                }
            }
        } catch {
            this._ifaceSettings = null;
        }

        try {
            this._wallClock = new GnomeDesktop.WallClock();
            this._wallClockSigId = this._wallClock.connect('notify::clock', () => {
                this._refreshClockText();
            });
        } catch {
            this._wallClock = null;
        }

        this._refreshClockText();
    }

    _readClockPrefs() {
        let use24h = true;
        let showDate = true;
        let showWeekday = true;
        let showSeconds = false;

        if (this._ifaceSettings) {
            try {
                use24h = this._ifaceSettings.get_string('clock-format') !== '12h';
                showDate = this._ifaceSettings.get_boolean('clock-show-date');
                showWeekday = this._ifaceSettings.get_boolean('clock-show-weekday');
                showSeconds = this._ifaceSettings.get_boolean('clock-show-seconds');
            } catch {
                // Fall back to safe defaults
            }
        }

        return { use24h, showDate, showWeekday, showSeconds };
    }

    _scheduleFallbackClockTick(now, showSeconds) {
        if (this._clockFallbackTimerId) {
            this._timers.clear(this._clockFallbackTimerId);
            this._clockFallbackTimerId = 0;
        }
        if (this._destroyed)
            return;

        const sec = now.get_second();
        const micro = now.get_microsecond();
        const delayMs = showSeconds
            ? Math.max(50, 1000 - Math.floor(micro / 1000) + 10)
            : Math.max(200, (60 - sec) * 1000 - Math.floor(micro / 1000) + 50);

        this._clockFallbackTimerId = this._timers.setTimeout(delayMs, () => {
            this._clockFallbackTimerId = 0;
            this._refreshClockText();
        });
    }

    _refreshClockText() {
        if (this._destroyed)
            return;

        const now = GLib.DateTime.new_now_local();
        const { use24h, showDate, showWeekday, showSeconds } = this._readClockPrefs();

        let nextClock;
        if (showSeconds)
            nextClock = (use24h ? now.format('%H:%M:%S') : now.format('%I:%M:%S %p')) || '00:00:00';
        else
            nextClock = (use24h ? now.format('%H:%M') : now.format('%I:%M %p')) || '00:00';

        let nextDate = '';
        if (showDate) {
            const dow = now.get_day_of_week() % 7;
            const day = now.get_day_of_month();
            const monthIdx = Math.max(0, Math.min(11, now.get_month() - 1));
            nextDate = showWeekday
                ? `${EN_DAYS_SHORT[dow]} ${day} ${EN_MONTHS_SHORT[monthIdx]}`
                : `${day} ${EN_MONTHS_SHORT[monthIdx]}`;
        }

        const changed = nextClock !== this._clockText || nextDate !== this._dateText;
        this._clockText = nextClock;
        this._dateText = nextDate;

        this._scheduleFallbackClockTick(now, showSeconds);

        if (changed) {
            const payload = { clockText: this._clockText, dateText: this._dateText };
            this.emit('clock-changed', payload);
            this.emit('clock-updated', payload);
        }
    }

    getClockStrings() {
        return {
            clockText: this._clockText,
            dateText: this._dateText,
        };
    }

    setOptions({
        integrationMode,
        autohideMode,
        hoverMode,
        showInOverview,
        animMs,
        externalHideTopBarActive,
    }) {
        if (this._destroyed)
            return;

        if (integrationMode !== undefined)
            this._integrationMode = integrationMode === 'separate' ? 'separate' : 'merged-pill';

        this._autohide.setOptions({
            autohideMode,
            hoverMode,
            showInOverview,
            animMs,
            externalHideTopBarActive,
        });

        this._syncDateMenuSlot();
    }

    setSlotReservation({ active, width }) {
        if (this._destroyed)
            return;
        this._hiddenState = !active;
        if (Number.isFinite(width) && width > 0)
            this._reservedWidth = Math.max(120, Math.round(width));
        this._syncDateMenuSlot();
    }

    setPanelHold(hold) {
        this._autohide.setHoldPanelVisible(hold);
    }

    isPanelVisiblyShowing() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor || monitor.inFullscreen)
            return false;

        if (this._autohide?.isAutohideActive() && this._autohide.isPanelHidden())
            return false;

        const panelBox = Main.layoutManager.panelBox;
        if (!panelBox || !panelBox.visible)
            return false;
        const panelY = panelBox.y + (panelBox.translation_y ?? 0);
        return (panelY + panelBox.height) > monitor.y + 4;
    }

    getPanelMetrics() {
        const monitor = Main.layoutManager.primaryMonitor ?? { x: 0, y: 0, width: 1280, height: 800 };
        const panelBox = Main.layoutManager.panelBox;
        const panelVisible = this.isPanelVisiblyShowing();
        const panelBoxY = panelBox ? Math.round(panelBox.y + (panelBox.translation_y ?? 0)) : monitor.y;
        const panelBoxHeight = panelBox ? Math.max(24, Math.round(panelBox.height)) : 28;

        let mTop = 0;
        let mBottom = 0;
        let bTop = 0;
        let bBottom = 0;
        const panelActor = Main.panel;
        try {
            const tn = panelActor?.get_theme_node?.();
            if (tn) {
                mTop = Math.max(0, Math.round(tn.get_margin(St.Side.TOP)));
                mBottom = Math.max(0, Math.round(tn.get_margin(St.Side.BOTTOM)));
                bTop = Math.max(0, Math.round(tn.get_border_width(St.Side.TOP)));
                bBottom = Math.max(0, Math.round(tn.get_border_width(St.Side.BOTTOM)));
            }
        } catch {
            // Keep 0 margins/borders fallback
        }

        let barY = panelBoxY + mTop;
        let barHeight = Math.max(24, panelBoxHeight - mTop - mBottom);
        let matchedIslandBox = false;

        // Prefer _rightBox or _leftBox when mapped & sane
        try {
            for (const refBox of [panelActor?._rightBox, panelActor?._leftBox]) {
                if (panelVisible && refBox && refBox.visible && refBox.get_stage?.()) {
                    const [, ry] = refBox.get_transformed_position();
                    const [, rh] = refBox.get_transformed_size();
                    if (Number.isFinite(ry) && Number.isFinite(rh) && rh >= 22 && rh <= panelBoxHeight) {
                        barY = Math.round(ry);
                        barHeight = Math.round(rh);
                        break;
                    }
                }
            }

            if (panelVisible && panelActor) {
                const panelAlpha = panelActor.get_theme_node?.()?.get_background_color?.()?.alpha ?? 255;
                for (const candidate of [panelActor.statusArea?.quickSettings, panelActor.statusArea?.activities]) {
                    const container = candidate?.container;
                    const btn = (container && typeof container.get_child === 'function' ? container.get_child() : null) ?? candidate;
                    if (!btn || !btn.visible || !btn.get_stage?.())
                        continue;
                    const [, by] = btn.get_transformed_position();
                    const [, bh] = btn.get_transformed_size();
                    if (!Number.isFinite(by) || !Number.isFinite(bh) || bh < 22 || bh > panelBoxHeight)
                        continue;
                    const btnAlpha = btn.get_theme_node?.()?.get_background_color?.()?.alpha ?? 0;
                    let vPad = 0;
                    try {
                        const ctn = container?.get_theme_node?.();
                        if (ctn)
                            vPad = Math.round(ctn.get_padding(St.Side.TOP) + ctn.get_padding(St.Side.BOTTOM));
                    } catch {
                        // Ignore unreadable padding
                    }
                    if ((panelAlpha < 90 && (btnAlpha >= 80 || vPad >= 2)) || (vPad >= 2 && bh <= panelBoxHeight - 2)) {
                        barY = Math.round(by);
                        barHeight = Math.round(bh);
                        matchedIslandBox = true;
                        break;
                    }
                }
            }
        } catch {
            // Keep theme-node compensated panelBox fallback
        }

        const innerY = matchedIslandBox ? barY : (barY + bTop);
        const innerHeight = matchedIslandBox
            ? Math.max(22, barHeight)
            : Math.max(22, barHeight - bTop - bBottom);
        const slotPillHeight = matchedIslandBox
            ? Math.max(24, Math.min(44, innerHeight))
            : Math.max(24, Math.min(34, innerHeight - 3));
        const panelBottom = Math.max(panelBoxY + panelBoxHeight, barY + barHeight);

        let corridorLeft = monitor.x + 8;
        let corridorRight = monitor.x + monitor.width - 8;

        try {
            const leftBox = Main.panel?._leftBox;
            if (leftBox && leftBox.visible && leftBox.get_stage?.()) {
                const [lx] = leftBox.get_transformed_position();
                const [lw] = leftBox.get_transformed_size();
                if (Number.isFinite(lx) && Number.isFinite(lw) && lw > 0)
                    corridorLeft = Math.max(corridorLeft, Math.round(lx + lw + 8));
            }
        } catch {
            // Keep safe fallback
        }

        try {
            const rightBox = Main.panel?._rightBox;
            if (rightBox && rightBox.visible && rightBox.get_stage?.()) {
                const [rx] = rightBox.get_transformed_position();
                if (Number.isFinite(rx) && rx > 0)
                    corridorRight = Math.min(corridorRight, Math.round(rx - 8));
            }
        } catch {
            // Keep safe fallback
        }

        const maxCorridorWidth = Math.max(0, corridorRight - corridorLeft);
        const monCenterX = Math.round(monitor.x + monitor.width / 2);
        const leftHalf = monCenterX - corridorLeft;
        const rightHalf = corridorRight - monCenterX;
        const maxCenteredWidth = Math.max(0, Math.min(leftHalf, rightHalf) * 2);

        return {
            monitor,
            panelVisible,
            panelBoxY,
            panelBoxHeight,
            barY,
            barHeight,
            innerY,
            innerHeight,
            slotPillHeight,
            panelBottom,
            corridorLeft,
            corridorRight,
            maxCenteredWidth,
        };
    }

    syncPanelGeometry() {
        if (this._destroyed)
            return;
        this._syncDateMenuSlot();
        this._autohide.syncPressureBarrier();
    }

    toggleGnomeCalendar() {
        const dateMenu = Main.panel?.statusArea?.dateMenu;
        if (!dateMenu?.menu)
            return;

        if (this._autohide.isAutohideActive() && !this.isPanelVisiblyShowing())
            this._autohide.showPanel(0, 'calendar-menu');

        try {
            dateMenu.menu.toggle();
        } catch {
            // Ignore if menu cannot toggle
        }
    }

    _syncDateMenuSlot() {
        if (this._syncingSlot)
            return;
        this._syncingSlot = true;
        try {
            const wantClaim =
                !this._destroyed &&
                this._integrationMode === 'merged-pill' &&
                !this._hiddenState &&
                this.isPanelVisiblyShowing();

            const dateMenu = Main.panel?.statusArea?.dateMenu;
            const dateContainer = dateMenu?.container ?? dateMenu;

            if (!dateContainer) {
                this._slotClaimed = false;
                this._savedDateMenu = null;
                return;
            }

            if (wantClaim) {
                if (!this._slotClaimed) {
                    this._savedDateMenu = {
                        dateMenu,
                        dateContainer,
                        opacity: dateContainer.opacity,
                        reactive: dateContainer.reactive,
                        btnReactive: dateMenu.reactive,
                    };
                    this._slotClaimed = true;
                }
                const { maxCenteredWidth, slotPillHeight, innerHeight } = this.getPanelMetrics();
                const reserveW = Math.min(maxCenteredWidth, Math.max(120, Math.round(this._reservedWidth)));
                const targetH = Math.max(18, Math.min(44, slotPillHeight ?? Math.round(innerHeight - 2)));
                try {
                    if (dateContainer.opacity !== 0)
                        dateContainer.opacity = 0;
                    if (dateContainer.reactive)
                        dateContainer.reactive = false;
                    if (dateMenu !== dateContainer && dateMenu.reactive)
                        dateMenu.reactive = false;

                    const panelBox = Main.layoutManager.panelBox;
                    const isPanelAnimating = this._autohide.isPanelVisibleAnim() ||
                        Boolean(panelBox?.get_transition?.('y') || panelBox?.get_transition?.('translation-y'));
                    const isQuickSettingsOpen = Boolean(Main.panel?.statusArea?.quickSettings?.menu?.isOpen);

                    if (!isPanelAnimating && !isQuickSettingsOpen &&
                        (this._lastAppliedReserveW !== reserveW || this._lastAppliedTargetH !== targetH)) {
                        this._lastAppliedReserveW = reserveW;
                        this._lastAppliedTargetH = targetH;
                        dateContainer.set_size(reserveW, targetH);
                    }
                } catch {
                    // Actor disposed
                }
            } else {
                this._releaseDateMenuSlot();
            }
        } finally {
            this._syncingSlot = false;
        }
    }

    _releaseDateMenuSlot() {
        this._lastAppliedReserveW = -1;
        this._lastAppliedTargetH = -1;
        if (!this._slotClaimed)
            return;
        const saved = this._savedDateMenu;
        this._slotClaimed = false;
        this._savedDateMenu = null;
        if (!saved)
            return;
        try {
            if (saved.dateContainer?.get_stage?.() || saved.dateContainer?.get_parent?.()) {
                saved.dateContainer.set_size(-1, -1);
                saved.dateContainer.opacity = saved.opacity ?? 255;
                saved.dateContainer.reactive = saved.reactive ?? true;
            }
            if (saved.dateMenu && saved.dateMenu !== saved.dateContainer)
                saved.dateMenu.reactive = saved.btnReactive ?? true;
        } catch {
            // Actor already destroyed
        }
    }

    destroy() {
        this._destroyed = true;
        if (this._clockFallbackTimerId) {
            this._timers.clear(this._clockFallbackTimerId);
            this._clockFallbackTimerId = 0;
        }
        if (this._wallClock && this._wallClockSigId) {
            try { this._wallClock.disconnect(this._wallClockSigId); } catch {}
        }
        this._wallClockSigId = 0;
        this._wallClock = null;
        this._ifaceSettings = null;

        this._autohide?.destroy();
        this._autohide = null;
        this._releaseDateMenuSlot();
    }
}
