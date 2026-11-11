import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GnomeDesktop from 'gi://GnomeDesktop';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Layout from 'resource:///org/gnome/shell/ui/layout.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

const EN_DAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const EN_MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const HANDLED_WINDOW_TYPES = new Set([
    Meta.WindowType.NORMAL,
    Meta.WindowType.DIALOG,
    Meta.WindowType.MODAL_DIALOG,
    Meta.WindowType.TOOLBAR,
    Meta.WindowType.MENU,
    Meta.WindowType.UTILITY,
    Meta.WindowType.SPLASHSCREEN,
]);

/**
 * Coordinates GNOME Top Bar integration (dateMenu clock slot replacement,
 * zero-drift clock sync, anti-overlap panel corridor geometry) and optional
 * built-in Top Bar autohide / intellihide tailored around BayIsland.
 */
export class TopBarManager extends Signals.EventEmitter {
    constructor({ signals, timers }) {
        super();
        this._signals = signals;
        this._timers = timers;
        this._destroyed = false;

        // Clock & date slot options
        this._integrationMode = 'merged-pill';
        this._autohideMode = 'disabled';
        this._hoverMode = 'edges';
        this._showInOverview = true;
        this._animMs = 200;
        this._externalHideTopBarActive = false;

        this._hiddenState = true;
        this._reservedWidth = 224;
        this._slotClaimed = false;
        this._savedDateMenu = null;
        this._holdPanelVisible = false;

        // Clock formatting settings + WallClock sync
        this._ifaceSettings = null;
        this._wallClock = null;
        this._wallClockSigId = 0;
        this._clockFallbackTimerId = 0;
        this._clockText = '00:00';
        this._dateText = '';

        // Autohide runtime state
        this._autohideActive = false;
        this._panelHidden = false;
        this._panelVisibleAnim = false;
        this._revealHoldUntilLeave = false;
        this._baseY = 0;
        this._unredirectDisabled = false;
        this._overlapDetected = false;
        this._overlapTimeoutId = 0;
        this._overlapNeedsRecheck = false;
        this._extReconcileTimerId = 0;
        this._inHidePanel = false;
        this._pointerWatchId = 0;
        this._blockerMenu = null;
        this._blockerMenuSigId = 0;
        this._menuToggleAfterUpdateId = 0;
        this._lastOverviewSearchPad = null;
        this._autohideSigIds = [];
        this._windowActors = new Map();

        this._pressureBarrier = null;
        this._pressureTriggerSigId = 0;
        this._barriers = [];
        this._origToggleQuickSettings = null;
        this._origToggleCalendar = null;

        this._cursorTracker = typeof global.backend?.get_cursor_tracker === 'function'
            ? global.backend.get_cursor_tracker()
            : Meta.CursorTracker.get_for_display(global.display);

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
        let showWeekday = false;
        let showSeconds = false;

        if (this._ifaceSettings) {
            try {
                use24h = this._ifaceSettings.get_string('clock-format') !== '12h';
                showDate = this._ifaceSettings.get_boolean('clock-show-date');
                showWeekday = this._ifaceSettings.get_boolean('clock-show-weekday');
                showSeconds = this._ifaceSettings.get_boolean('clock-show-seconds');
            } catch {
                // Keep defaults
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

        // Even with GnomeDesktop.WallClock, keep a light rollover safety guard
        const sec = now.get_second();
        const waitMs = showSeconds ? 1000 : Math.max(1050, (60 - sec) * 1000 + 250);
        this._clockFallbackTimerId = this._timers.setTimeout(waitMs, () => {
            this._clockFallbackTimerId = 0;
            this._refreshClockText();
        });
    }

    _refreshClockText() {
        if (this._destroyed)
            return;
        const now = GLib.DateTime.new_now_local();
        const { use24h, showDate, showWeekday, showSeconds } = this._readClockPrefs();

        const fmt = use24h
            ? (showSeconds ? '%H:%M:%S' : '%H:%M')
            : (showSeconds ? '%I:%M:%S %p' : '%I:%M %p');
        const nextClock = now.format(fmt) || '00:00';

        const dow = now.get_day_of_week() % 7;
        const monthIdx = Math.max(0, Math.min(11, now.get_month() - 1));
        const day = now.get_day_of_month();
        let nextDate = '';
        if (showDate) {
            nextDate = showWeekday
                ? `${EN_DAYS_SHORT[dow]} ${day} ${EN_MONTHS_SHORT[monthIdx]}`
                : `${EN_MONTHS_SHORT[monthIdx]} ${day}`;
        } else {
            nextDate = `${EN_DAYS_SHORT[dow]} ${day} ${EN_MONTHS_SHORT[monthIdx]}`;
        }

        const changed = nextClock !== this._clockText || nextDate !== this._dateText;
        this._clockText = nextClock;
        this._dateText = nextDate;
        this._scheduleFallbackClockTick(now, showSeconds);

        if (changed)
            this.emit('clock-updated', { clockText: this._clockText, dateText: this._dateText });
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
        if (autohideMode !== undefined)
            this._autohideMode = ['intellihide', 'always'].includes(autohideMode) ? autohideMode : 'disabled';
        if (hoverMode !== undefined)
            this._hoverMode = ['full-width', 'off'].includes(hoverMode) ? hoverMode : 'edges';
        if (showInOverview !== undefined)
            this._showInOverview = Boolean(showInOverview);
        if (animMs !== undefined)
            this._animMs = Math.max(0, Math.min(500, Math.round(animMs)));
        if (externalHideTopBarActive !== undefined)
            this._externalHideTopBarActive = Boolean(externalHideTopBarActive);

        this._syncAutohideState();
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
        const want = Boolean(hold);
        if (want === this._holdPanelVisible)
            return;
        this._holdPanelVisible = want;
        if (this._autohideActive)
            this._reconcileAutohideVisibility('hold-change');
    }

    isPanelVisiblyShowing() {
        const monitor = Main.layoutManager.primaryMonitor;
        const panelBox = Main.layoutManager.panelBox;
        if (!monitor || !panelBox || !panelBox.visible)
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

        // Prefer _rightBox or _leftBox (never mutated by center slot sizing) when mapped & sane
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

            // When OpenBar Islands/Trilands insets .panel-button inside padded .button-container,
            // align vertically with the visible left/right islands rather than the outer invisible panel bar.
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
                const [rw] = rightBox.get_transformed_size();
                if (Number.isFinite(rx) && Number.isFinite(rw) && rw > 0)
                    corridorRight = Math.min(corridorRight, Math.round(rx - 8));
            }
        } catch {
            // Keep safe fallback
        }

        if (corridorRight < corridorLeft + 120) {
            corridorLeft = monitor.x + 8;
            corridorRight = monitor.x + monitor.width - 8;
        }

        const monCenterX = monitor.x + monitor.width / 2;
        const leftAvail = Math.max(60, monCenterX - corridorLeft);
        const rightAvail = Math.max(60, corridorRight - monCenterX);
        const maxCenteredWidth = Math.max(140, Math.round(2 * Math.min(leftAvail, rightAvail)));

        return {
            monitor,
            panelVisible,
            panelBoxY: barY,
            panelHeight: barHeight,
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
        if (this._autohideActive)
            this._syncPressureBarrier();
    }

    toggleGnomeCalendar() {
        const dateMenu = Main.panel?.statusArea?.dateMenu;
        if (!dateMenu?.menu)
            return;

        if (this._autohideActive && !this.isPanelVisiblyShowing())
            this._showPanel(0, 'calendar-menu');

        try {
            dateMenu.menu.toggle();
        } catch {
            // Ignore if menu cannot toggle
        }
    }

    _syncDateMenuSlot() {
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
                if (!this._panelVisibleAnim &&
                    (Math.round(dateContainer.width) !== reserveW || Math.round(dateContainer.height) !== targetH))
                    dateContainer.set_size(reserveW, targetH);
            } catch {
                // Actor disposed
            }
        } else {
            this._releaseDateMenuSlot();
        }
    }

    _releaseDateMenuSlot() {
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

    // ------------------------------------------------------------------
    // Built-in Top Bar Autohide / Intellihide
    // ------------------------------------------------------------------

    _shouldRunAutohide() {
        return !this._destroyed &&
            this._autohideMode !== 'disabled' &&
            !this._externalHideTopBarActive;
    }

    _syncAutohideState() {
        const want = this._shouldRunAutohide();
        if (!want) {
            if (this._autohideActive)
                this._deactivateAutohide();
            return;
        }

        if (!this._autohideActive) {
            this._activateAutohide();
        } else {
            this._syncOverviewSearchPadding();
            this._syncPressureBarrier();
            this._scheduleOverlapCheck();
            this._reconcileAutohideVisibility('settings-changed');
        }
    }

    _syncOverviewSearchPadding() {
        const searchBin = Main.overview?._overview?._controls?._searchEntryBin;
        if (!searchBin)
            return;

        let nextPad = null;
        if (!this._destroyed && this._autohideActive && this._showInOverview) {
            const monitor = Main.layoutManager.primaryMonitor;
            const monY = monitor?.y ?? 0;
            let workAreaTop = monY;
            try {
                if (monitor && typeof Main.layoutManager.getWorkAreaForMonitor === 'function')
                    workAreaTop = Main.layoutManager.getWorkAreaForMonitor(monitor.index)?.y ?? monY;
            } catch {
                workAreaTop = monY;
            }
            const panelBox = Main.layoutManager.panelBox;
            const metrics = this.getPanelMetrics();
            const panelRestH = Math.round(panelBox?.height ?? 32);
            const visSpan = metrics.panelVisible ? Math.round((metrics.panelBottom ?? monY) - monY) : 0;
            const needed = Math.max(panelRestH, visSpan) - Math.max(0, Math.round(workAreaTop - monY));
            nextPad = Math.max(26, needed);
        }

        if (nextPad === this._lastOverviewSearchPad)
            return;

        this._lastOverviewSearchPad = nextPad;
        try {
            if (nextPad !== null)
                searchBin.set_style(`padding-top: ${nextPad}px;`);
            else
                searchBin.set_style(null);
            searchBin.queue_relayout?.();
        } catch {
            // Actor disposed or stage tearing down
        }
    }

    _activateAutohide() {
        const panelBox = Main.layoutManager.panelBox;
        if (!panelBox)
            return;

        this._autohideActive = true;
        const monitor = Main.layoutManager.primaryMonitor ?? { y: 0 };
        this._baseY = monitor.y;

        try {
            Main.layoutManager.removeChrome(panelBox);
            Main.layoutManager.addChrome(panelBox, {
                affectsStruts: false,
                trackFullscreen: true,
            });
        } catch {
            // Keep running best-effort
        }

        this._origToggleQuickSettings = Main.panel.toggleQuickSettings;
        this._origToggleCalendar = Main.panel.toggleCalendar;
        Main.panel.toggleQuickSettings = this._wrapMenuToggle(this._origToggleQuickSettings);
        Main.panel.toggleCalendar = this._wrapMenuToggle(this._origToggleCalendar);

        const reg = (obj, sig, fn) => {
            if (!obj)
                return;
            try {
                const id = obj.connect(sig, fn);
                this._autohideSigIds.push([obj, id]);
            } catch {
                // Skip unsupported signal
            }
        };

        reg(Main.overview, 'showing', () => {
            this._syncOverviewSearchPadding();
            if (this._showInOverview)
                this._showPanel(this._animMs, 'overview');
        });
        reg(Main.overview, 'shown', () => {
            this._syncOverviewSearchPadding();
        });
        reg(Main.panel, 'style-changed', () => {
            this._syncOverviewSearchPadding();
        });
        reg(Main.overview, 'hiding', () => {
            this._reconcileAutohideVisibility('overview-hiding');
        });
        reg(Main.overview, 'hidden', () => {
            this._reconcileAutohideVisibility('overview-hidden');
        });
        reg(Main.panel, 'leave-event', () => {
            this._handleMenusOrPointerLeave();
        });
        reg(Main.layoutManager, 'startup-complete', () => {
            const mon = Main.layoutManager.primaryMonitor ?? { y: 0 };
            this._baseY = mon.y;
            this._syncOverviewSearchPadding();
            this._syncPressureBarrier();
            this._reconcileAutohideVisibility('startup-complete');
        });
        reg(Main.layoutManager, 'monitors-changed', () => {
            const mon = Main.layoutManager.primaryMonitor ?? { y: 0 };
            this._baseY = mon.y;
            this._syncOverviewSearchPadding();
            this._syncPressureBarrier();
            if (this._autohideMode === 'intellihide')
                this._scheduleOverlapCheck();
            else
                this._reconcileAutohideVisibility('monitors-changed');
        });
        reg(panelBox, 'notify::visible', () => {
            if (!this._autohideActive || this._inShowPanel || this._inHidePanel || this._panelVisibleAnim)
                return;
            if (this._panelHidden && panelBox.visible && !this._extReconcileTimerId) {
                this._extReconcileTimerId = this._timers.setTimeout(30, () => {
                    this._extReconcileTimerId = 0;
                    if (this._autohideActive && this._panelHidden && panelBox.visible)
                        this._reconcileAutohideVisibility('external-panel-show');
                });
            }
        });
        reg(panelBox, 'notify::height', () => {
            this._syncOverviewSearchPadding();
            if (!this._autohideActive || !this._panelHidden || this._panelVisibleAnim || panelBox.visible)
                return;
            const targetY = this._baseY - Math.max(24, panelBox.height) - 2;
            if (Math.abs((panelBox.y ?? 0) - targetY) > 0.5)
                panelBox.y = targetY;
        });
        reg(global.window_manager, 'switch-workspace', () => {
            this._scheduleOverlapCheck();
        });
        reg(global.window_manager, 'map', (_wm, wa) => {
            if (wa)
                this._watchWindowActor(wa);
            this._scheduleOverlapCheck();
        });
        reg(global.window_manager, 'minimize', () => {
            this._scheduleOverlapCheck();
        });
        reg(global.window_manager, 'unminimize', () => {
            this._scheduleOverlapCheck();
        });
        reg(global.window_manager, 'size-changed', () => {
            this._scheduleOverlapCheck();
        });
        reg(global.display, 'in-fullscreen-changed', () => {
            this._scheduleOverlapCheck();
        });
        reg(global.display, 'window-entered-monitor', () => {
            this._scheduleOverlapCheck();
        });
        reg(global.display, 'window-left-monitor', () => {
            this._scheduleOverlapCheck();
        });
        reg(global.display, 'workareas-changed', () => {
            this._scheduleOverlapCheck();
        });
        reg(global.display, 'window-created', (_d, metaWin) => {
            const wa = metaWin?.get_compositor_private?.();
            if (wa)
                this._watchWindowActor(wa);
            this._scheduleOverlapCheck();
        });
        reg(global.display, 'restacked', () => {
            this._scheduleOverlapCheck();
        });
        reg(global.display, 'notify::focus-window', () => {
            this._scheduleOverlapCheck();
        });

        for (const wa of global.get_window_actors())
            this._watchWindowActor(wa);

        this._syncOverviewSearchPadding();
        this._syncPressureBarrier();
        this._evaluateOverlapNow();
        this._reconcileAutohideVisibility('init');
    }

    _deactivateAutohide() {
        this._autohideActive = false;
        this._syncOverviewSearchPadding();

        if (this._overlapTimeoutId) {
            this._timers.clear(this._overlapTimeoutId);
            this._overlapTimeoutId = 0;
        }
        if (this._extReconcileTimerId) {
            this._timers.clear(this._extReconcileTimerId);
            this._extReconcileTimerId = 0;
        }
        this._stopWatchingPointer();
        this._releaseBlockerMenu();
        this._disablePressureBarrier();

        if (this._menuToggleAfterUpdateId && global.stage) {
            try { global.stage.disconnect(this._menuToggleAfterUpdateId); } catch {}
            this._menuToggleAfterUpdateId = 0;
        }

        for (const [obj, id] of this._autohideSigIds) {
            try { obj.disconnect(id); } catch {}
        }
        this._autohideSigIds = [];

        for (const entries of this._windowActors.values()) {
            for (const [obj, id] of entries) {
                try { obj.disconnect(id); } catch {}
            }
        }
        this._windowActors.clear();

        if (this._origToggleQuickSettings) {
            Main.panel.toggleQuickSettings = this._origToggleQuickSettings;
            this._origToggleQuickSettings = null;
        }
        if (this._origToggleCalendar) {
            Main.panel.toggleCalendar = this._origToggleCalendar;
            this._origToggleCalendar = null;
        }

        const panelBox = Main.layoutManager.panelBox;
        if (panelBox) {
            try {
                panelBox.remove_all_transitions();
                const mon = Main.layoutManager.primaryMonitor ?? { y: 0 };
                panelBox.y = mon.y;
                panelBox.show();
                Main.layoutManager.removeChrome(panelBox);
                Main.layoutManager.addChrome(panelBox, {
                    affectsStruts: Main.sessionMode.currentMode !== 'unlock-dialog',
                    trackFullscreen: true,
                });
            } catch {
                // Stage tearing down
            }
        }

        this._panelHidden = false;
        this._revealHoldUntilLeave = false;
        this._setUnredirectDisabled(false);
        this.emit('panel-state-changed');
    }

    _wrapMenuToggle(original) {
        if (typeof original !== 'function')
            return original;

        return (...args) => {
            if (!this._autohideActive)
                return original.apply(Main.panel, args);

            const panelBox = Main.layoutManager.panelBox;
            if (panelBox?.visible && panelBox.y >= this._baseY)
                return original.apply(Main.panel, args);

            this._showPanel(0, 'menu-shortcut');
            if (this._menuToggleAfterUpdateId)
                return undefined;

            this._menuToggleAfterUpdateId = global.stage.connect('after-update', (_stage, view) => {
                if (panelBox && view && panelBox.peek_stage_views &&
                    !panelBox.peek_stage_views().includes(view))
                    return;
                if (this._menuToggleAfterUpdateId) {
                    try { global.stage.disconnect(this._menuToggleAfterUpdateId); } catch {}
                    this._menuToggleAfterUpdateId = 0;
                }
                try {
                    original.apply(Main.panel, args);
                } finally {
                    this._handleMenusOrPointerLeave();
                }
            });
            return undefined;
        };
    }

    _watchWindowActor(wa) {
        if (!wa || this._windowActors.has(wa))
            return;
        const mw = wa.get_meta_window?.();
        if (!mw || !HANDLED_WINDOW_TYPES.has(mw.get_window_type()))
            return;

        const entries = [];
        const addSig = (obj, sig, fn) => {
            try {
                const id = obj.connect(sig, fn);
                entries.push([obj, id]);
            } catch {
                // Unsupported signal on this object
            }
        };

        addSig(wa, 'notify::allocation', () => this._scheduleOverlapCheck());
        addSig(wa, 'notify::visible', () => this._scheduleOverlapCheck());
        addSig(wa, 'first-frame', () => this._scheduleOverlapCheck());
        addSig(mw, 'position-changed', () => this._scheduleOverlapCheck());
        addSig(mw, 'size-changed', () => this._scheduleOverlapCheck());
        addSig(mw, 'notify::minimized', () => this._scheduleOverlapCheck());
        addSig(mw, 'notify::fullscreen', () => this._scheduleOverlapCheck());
        addSig(wa, 'destroy', () => {
            const stored = this._windowActors.get(wa);
            if (stored) {
                for (const [obj, id] of stored) {
                    try { obj.disconnect(id); } catch {}
                }
                this._windowActors.delete(wa);
            }
            this._scheduleOverlapCheck();
        });
        this._windowActors.set(wa, entries);
    }

    _scheduleOverlapCheck() {
        if (!this._autohideActive || this._autohideMode !== 'intellihide')
            return;
        if (this._overlapTimeoutId) {
            this._overlapNeedsRecheck = true;
            return;
        }
        this._evaluateOverlapNow();
        this._overlapTimeoutId = this._timers.setTimeout(100, () => {
            this._overlapTimeoutId = 0;
            if (this._overlapNeedsRecheck) {
                this._overlapNeedsRecheck = false;
                this._evaluateOverlapNow();
            }
        });
    }

    _evaluateOverlapNow() {
        if (!this._autohideActive)
            return;

        if (this._autohideMode === 'always') {
            this._overlapDetected = true;
            this._reconcileAutohideVisibility('always-mode');
            return;
        }

        const monitor = Main.layoutManager.primaryMonitor;
        const primaryIdx = Main.layoutManager.primaryIndex;
        const panelBox = Main.layoutManager.panelBox;
        if (!monitor || !panelBox)
            return;

        const panelTop = monitor.y;
        const panelBottom = monitor.y + Math.max(24, panelBox.height);
        const panelLeft = monitor.x;
        const panelRight = monitor.x + monitor.width;

        const activeWs = global.workspace_manager?.get_active_workspace?.();
        let overlaps = Boolean(monitor.inFullscreen);

        if (!overlaps) {
            for (const wa of global.get_window_actors()) {
                if (!wa.visible)
                    continue;
                const mw = wa.get_meta_window?.();
                if (!mw || mw.minimized || mw.is_hidden?.())
                    continue;
                if (!HANDLED_WINDOW_TYPES.has(mw.get_window_type()))
                    continue;
                if (mw.get_monitor?.() !== primaryIdx)
                    continue;
                if (activeWs && !mw.located_on_workspace?.(activeWs) && !mw.is_on_all_workspaces?.())
                    continue;

                const rect = mw.get_frame_rect?.();
                if (!rect || rect.width <= 0 || rect.height <= 0)
                    continue;

                const touchesX = rect.x < panelRight && (rect.x + rect.width) > panelLeft;
                const touchesY = rect.y < panelBottom && (rect.y + rect.height) > panelTop;
                if (touchesX && touchesY) {
                    overlaps = true;
                    break;
                }
            }
        }

        if (overlaps !== this._overlapDetected) {
            this._overlapDetected = overlaps;
            this._reconcileAutohideVisibility('intellihide');
        }
    }

    _reconcileAutohideVisibility(reason) {
        if (!this._autohideActive)
            return;

        const overviewVisible = Main.overview.visibleTarget ?? Main.overview.visible;
        if (this._showInOverview && overviewVisible) {
            this._showPanel(this._animMs, reason);
            return;
        }

        if (this._holdPanelVisible && this.isPanelVisiblyShowing()) {
            this._showPanel(0, reason);
            return;
        }

        if (this._revealHoldUntilLeave) {
            const [px, py] = global.get_pointer();
            if (this._panelVisibleAnim || this._isPointerInPanel(px, py)) {
                if (!this._panelVisibleAnim)
                    this._startWatchingPointer();
                return;
            }
            this._revealHoldUntilLeave = false;
        }

        const activeMenu = this._getActivePanelMenu();
        if (activeMenu) {
            this._watchBlockerMenu(activeMenu);
            return;
        }

        if (this._autohideMode === 'always' || this._overlapDetected)
            this._hidePanel(this._animMs, reason);
        else
            this._showPanel(this._animMs, reason);
    }

    _getActivePanelMenu() {
        const direct = Main.panel?.menuManager?.activeMenu;
        if (direct?.isOpen)
            return direct;
        return this._panelGrabMenu();
    }

    _panelGrabMenu() {
        const panelBox = Main.layoutManager.panelBox;
        if (!panelBox)
            return null;
        let actor = global.stage.get_grab_actor?.();
        let grabMenu = null;
        const seen = new Set();
        while (actor) {
            if (panelBox.contains(actor))
                return grabMenu?.isOpen ? grabMenu : null;
            const menu = actor._delegate;
            if (menu instanceof PopupMenu.PopupMenuBase && menu.sourceActor && !seen.has(menu)) {
                seen.add(menu);
                grabMenu ??= menu;
                actor = menu.sourceActor;
            } else {
                actor = actor.get_parent?.();
            }
        }
        return null;
    }

    _watchBlockerMenu(menu) {
        if (!menu || menu === this._blockerMenu)
            return;
        this._releaseBlockerMenu();
        this._blockerMenu = menu;
        try {
            this._blockerMenuSigId = menu.connect('open-state-changed', (_m, open) => {
                if (!open && this._blockerMenu) {
                    this._releaseBlockerMenu();
                    this._handleMenusOrPointerLeave();
                }
            });
        } catch {
            this._blockerMenu = null;
        }
    }

    _releaseBlockerMenu() {
        if (this._blockerMenu && this._blockerMenuSigId) {
            try { this._blockerMenu.disconnect(this._blockerMenuSigId); } catch {}
        }
        this._blockerMenu = null;
        this._blockerMenuSigId = 0;
    }

    _handleMenusOrPointerLeave() {
        const overviewVisible = Main.overview.visibleTarget ?? Main.overview.visible;
        if (!this._autohideActive || overviewVisible)
            return;
        const activeMenu = this._getActivePanelMenu();
        if (activeMenu) {
            this._watchBlockerMenu(activeMenu);
            return;
        }
        const [px, py] = global.get_pointer();
        if (this._isPointerInPanel(px, py) && !this._panelHidden) {
            this._revealHoldUntilLeave = true;
            this._startWatchingPointer();
            return;
        }
        this._revealHoldUntilLeave = false;
        this._reconcileAutohideVisibility('pointer-leave');
    }

    _isPointerInPanel(px, py) {
        const mon = Main.layoutManager.primaryMonitor;
        const panelBox = Main.layoutManager.panelBox;
        if (!mon || !panelBox)
            return false;
        const h = Math.max(24, panelBox.height);
        return px >= mon.x && px <= (mon.x + mon.width) && py >= mon.y && py <= (mon.y + h);
    }

    _startWatchingPointer() {
        if (this._pointerWatchId || !this._cursorTracker)
            return;
        this._pointerWatchId = this._cursorTracker.connect('position-invalidated', () => {
            if (!this._autohideActive || this._panelVisibleAnim)
                return;
            const [px, py] = global.get_pointer();
            if (!this._isPointerInPanel(px, py)) {
                this._stopWatchingPointer();
                this._revealHoldUntilLeave = false;
                this._reconcileAutohideVisibility('pointer-left');
            }
        });
    }

    _stopWatchingPointer() {
        if (this._pointerWatchId && this._cursorTracker) {
            try { this._cursorTracker.disconnect(this._pointerWatchId); } catch {}
        }
        this._pointerWatchId = 0;
    }

    _syncPressureBarrier() {
        this._disablePressureBarrier();
        if (!this._autohideActive || this._hoverMode === 'off')
            return;

        const mon = Main.layoutManager.primaryMonitor;
        if (!mon || mon.width <= 0)
            return;

        try {
            this._pressureBarrier = new Layout.PressureBarrier(
                100,
                1000,
                Shell.ActionMode.NORMAL
            );
            this._pressureTriggerSigId = this._pressureBarrier.connect('trigger', () => {
                if (!this._autohideActive)
                    return;
                this._showPanel(this._animMs, 'mouse-enter');
            });

            const addSeg = (x1, x2) => {
                if (x2 - x1 < 40)
                    return;
                const barrier = new Meta.Barrier({
                    backend: global.backend,
                    x1: Math.round(x1),
                    x2: Math.round(x2),
                    y1: Math.round(mon.y),
                    y2: Math.round(mon.y),
                    directions: Meta.BarrierDirection.POSITIVE_Y,
                });
                this._pressureBarrier.addBarrier(barrier);
                this._barriers.push(barrier);
            };

            if (this._hoverMode === 'edges' && mon.width > 420) {
                const centerLeft = Math.round(mon.x + mon.width / 2 - 140);
                const centerRight = Math.round(mon.x + mon.width / 2 + 140);
                addSeg(mon.x, centerLeft);
                addSeg(centerRight, mon.x + mon.width);
            } else {
                addSeg(mon.x, mon.x + mon.width);
            }
        } catch {
            this._disablePressureBarrier();
        }
    }

    _disablePressureBarrier() {
        this._stopWatchingPointer();
        if (this._pressureBarrier && this._pressureTriggerSigId) {
            try { this._pressureBarrier.disconnect(this._pressureTriggerSigId); } catch {}
        }
        this._pressureTriggerSigId = 0;

        for (const barrier of this._barriers) {
            try { this._pressureBarrier?.removeBarrier(barrier); } catch {}
            try { barrier.destroy(); } catch {}
        }
        this._barriers = [];
        this._pressureBarrier = null;
    }

    _setUnredirectDisabled(disabled) {
        const want = Boolean(disabled);
        if (want === this._unredirectDisabled)
            return;
        try {
            if (typeof global.compositor?.disable_unredirect === 'function') {
                if (want)
                    global.compositor.disable_unredirect();
                else
                    global.compositor.enable_unredirect();
            } else if (want) {
                Meta.disable_unredirect_for_display(global.display);
            } else {
                Meta.enable_unredirect_for_display(global.display);
            }
            this._unredirectDisabled = want;
        } catch {
            // Best effort
        }
    }

    _showPanel(animMs, trigger) {
        const panelBox = Main.layoutManager.panelBox;
        if (!panelBox)
            return;

        if (trigger === 'mouse-enter' || trigger === 'menu-shortcut' || trigger === 'calendar-menu')
            this._revealHoldUntilLeave = true;
        else if (trigger !== 'overview' && trigger !== 'hold-change')
            this._revealHoldUntilLeave = false;

        const atBaseY = Math.abs((panelBox.y ?? 0) - this._baseY) <= 0.5;
        if (!this._panelHidden && !this._panelVisibleAnim && panelBox.visible && atBaseY) {
            if (this._revealHoldUntilLeave) {
                const [px, py] = global.get_pointer();
                if (this._isPointerInPanel(px, py))
                    this._startWatchingPointer();
                else
                    this._revealHoldUntilLeave = false;
            }
            this._syncDateMenuSlot();
            return;
        }

        if (this._inShowPanel)
            return;
        this._inShowPanel = true;
        try {
            this._panelHidden = false;
            panelBox.remove_all_transitions();
            panelBox.show();
            this._setUnredirectDisabled(true);

            // If animMs <= 0 or already at target Y, complete without a 0-delta ease
            // so Clutter doesn't fire onComplete synchronously mid-reconcile.
            if (animMs <= 0 || atBaseY) {
                this._panelVisibleAnim = false;
                panelBox.y = this._baseY;
                this._syncDateMenuSlot();
                this.emit('panel-state-changed');
                if (this._revealHoldUntilLeave) {
                    const [px, py] = global.get_pointer();
                    if (this._isPointerInPanel(px, py))
                        this._startWatchingPointer();
                    else
                        this._revealHoldUntilLeave = false;
                }
                return;
            }

            this._panelVisibleAnim = true;
            panelBox.ease({
                y: this._baseY,
                duration: animMs,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => {
                    this._panelVisibleAnim = false;
                    this._syncDateMenuSlot();
                    this.emit('panel-state-changed');
                    const [px, py] = global.get_pointer();
                    if (this._isPointerInPanel(px, py)) {
                        this._revealHoldUntilLeave = true;
                        this._startWatchingPointer();
                    } else if (this._autohideMode === 'always' || this._overlapDetected) {
                        this._revealHoldUntilLeave = false;
                        this._handleMenusOrPointerLeave();
                    } else {
                        this._revealHoldUntilLeave = false;
                    }
                },
            });
            this.emit('panel-state-changed');
        } finally {
            this._inShowPanel = false;
        }
    }

    _hidePanel(animMs, _trigger) {
        const panelBox = Main.layoutManager.panelBox;
        if (!panelBox)
            return;

        const targetY = this._baseY - Math.max(24, panelBox.height) - 2;
        if (this._panelHidden && !this._panelVisibleAnim && !panelBox.visible &&
            Math.abs((panelBox.y ?? 0) - targetY) <= 0.5)
            return;

        if (this._inHidePanel)
            return;
        this._inHidePanel = true;
        try {
            this._revealHoldUntilLeave = false;
            this._stopWatchingPointer();
            this._panelHidden = true;
            panelBox.remove_all_transitions();

            if (animMs <= 0 || Math.abs((panelBox.y ?? 0) - targetY) <= 0.5) {
                this._panelVisibleAnim = false;
                panelBox.y = targetY;
                panelBox.hide();
                this._setUnredirectDisabled(false);
                this._syncDateMenuSlot();
                this.emit('panel-state-changed');
                return;
            }

            this._panelVisibleAnim = true;
            panelBox.ease({
                y: targetY,
                duration: animMs,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => {
                    this._panelVisibleAnim = false;
                    if (this._panelHidden) {
                        panelBox.y = targetY;
                        panelBox.hide();
                        this._setUnredirectDisabled(false);
                    }
                    this._syncDateMenuSlot();
                    this.emit('panel-state-changed');
                },
            });
            this.emit('panel-state-changed');
        } finally {
            this._inHidePanel = false;
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

        this._deactivateAutohide();
        this._releaseDateMenuSlot();
    }
}
