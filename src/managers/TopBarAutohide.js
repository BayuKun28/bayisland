import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Layout from 'resource:///org/gnome/shell/ui/layout.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

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
 * TopBarAutohide isolates GNOME Shell panel intellihide/autohide mechanics,
 * edge pressure barriers, window overlap detection, and slide animations.
 */
export class TopBarAutohide {
    constructor({ signals, timers, onPanelStateChanged, getPanelMetrics, isPanelVisiblyShowing }) {
        this._signals = signals;
        this._timers = timers;
        this._onPanelStateChanged = onPanelStateChanged;
        this._getPanelMetrics = getPanelMetrics;
        this._isPanelVisiblyShowing = isPanelVisiblyShowing;

        this._destroyed = false;
        this._autohideMode = 'disabled';
        this._hoverMode = 'edges';
        this._showInOverview = true;
        this._animMs = 200;
        this._externalHideTopBarActive = false;
        this._holdPanelVisible = false;

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
        this._inShowPanel = false;
        this._inHidePanel = false;
        this._pointerWatchId = 0;
        this._blockerMenu = null;
        this._blockerMenuSigId = 0;
        this._lastOverviewSearchPad = null;
        this._autohideSigIds = [];
        this._windowActors = new Map();

        this._pressureBarrier = null;
        this._pressureTriggerSigId = 0;
        this._barriers = [];

        this._cursorTracker = typeof global.get_cursor_tracker === 'function'
            ? global.get_cursor_tracker()
            : typeof global.backend?.get_cursor_tracker === 'function'
                ? global.backend.get_cursor_tracker()
                : Meta.CursorTracker?.get_for_display?.(global.display);
    }

    setOptions({
        autohideMode = this._autohideMode,
        hoverMode = this._hoverMode,
        showInOverview = this._showInOverview,
        animMs = this._animMs,
        externalHideTopBarActive = this._externalHideTopBarActive,
    } = {}) {
        const changed =
            autohideMode !== this._autohideMode ||
            hoverMode !== this._hoverMode ||
            showInOverview !== this._showInOverview ||
            animMs !== this._animMs ||
            externalHideTopBarActive !== this._externalHideTopBarActive;

        this._autohideMode = autohideMode;
        this._hoverMode = hoverMode;
        this._showInOverview = showInOverview;
        this._animMs = animMs;
        this._externalHideTopBarActive = externalHideTopBarActive;

        if (changed)
            this._syncAutohideState();
    }

    setHoldPanelVisible(hold) {
        const monitor = Main.layoutManager.primaryMonitor;
        if (monitor?.inFullscreen && hold)
            return;
        const want = Boolean(hold);
        if (want === this._holdPanelVisible)
            return;
        this._holdPanelVisible = want;
        if (this._autohideActive)
            this._reconcileAutohideVisibility('hold-change');
    }

    isAutohideActive() {
        return this._autohideActive;
    }

    isPanelHidden() {
        return this._panelHidden;
    }

    isPanelVisibleAnim() {
        return this._panelVisibleAnim;
    }

    syncPressureBarrier() {
        this._syncPressureBarrier();
    }

    showPanel(animMs = 0, trigger = 'manual') {
        this._showPanel(animMs, trigger);
    }

    _emitPanelState() {
        this._onPanelStateChanged?.();
    }

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
            const metrics = this._getPanelMetrics?.() ?? {};
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

        const statusArea = Main.panel?.statusArea;
        if (statusArea) {
            for (const key of Object.keys(statusArea)) {
                const item = statusArea[key];
                const menu = item?.menu;
                if (menu && typeof menu.connect === 'function') {
                    this._autohideSigIds.push(
                        this._signals.connect(menu, 'open-state-changed', (_m, open) => {
                            if (this._destroyed || !this._autohideActive)
                                return;
                            if (open) {
                                this._revealHoldUntilLeave = true;
                                if (!this._isPanelVisiblyShowing())
                                    this._showPanel(0, 'menu-opened');
                                this._watchBlockerMenu(menu);
                                this._startWatchingPointer();
                            } else {
                                this._releaseBlockerMenu();
                                this._handleMenusOrPointerLeave();
                            }
                        })
                    );
                }
            }
        }

        this._autohideSigIds.push(
            this._signals.connect(global.window_manager, 'switch-workspace', () => {
                this._scheduleOverlapCheck();
                this._reconcileAutohideVisibility('workspace-switch');
            }),
            this._signals.connect(global.display, 'in-fullscreen-changed', () => {
                this._scheduleOverlapCheck();
                this._reconcileAutohideVisibility('fullscreen-changed');
            }),
            this._signals.connect(global.display, 'restacked', () => this._scheduleOverlapCheck()),
            this._signals.connect(global.display, 'notify::focus-window', () => this._scheduleOverlapCheck()),
            this._signals.connect(Main.overview, 'showing', () => {
                this._syncOverviewSearchPadding();
                this._reconcileAutohideVisibility('overview-showing');
            }),
            this._signals.connect(Main.overview, 'shown', () => {
                this._syncOverviewSearchPadding();
            }),
            this._signals.connect(Main.overview, 'hiding', () => {
                this._syncOverviewSearchPadding();
                this._reconcileAutohideVisibility('overview-hiding');
            }),
            this._signals.connect(Main.overview, 'hidden', () => {
                this._syncOverviewSearchPadding();
                this._scheduleOverlapCheck();
                this._reconcileAutohideVisibility('overview-hidden');
            }),
            this._signals.connect(panelBox, 'enter-event', () => this._reconcileAutohideVisibility('panel-enter')),
            this._signals.connect(panelBox, 'leave-event', () => this._handleMenusOrPointerLeave()),
            this._signals.connect(panelBox, 'notify::visible', () => {
                if (!this._autohideActive || this._inShowPanel || this._inHidePanel || this._panelVisibleAnim)
                    return;
                if (this._panelHidden && panelBox.visible && !this._extReconcileTimerId) {
                    this._extReconcileTimerId = this._timers.setTimeout(30, () => {
                        this._extReconcileTimerId = 0;
                        if (this._autohideActive && this._panelHidden && panelBox.visible)
                            this._reconcileAutohideVisibility('external-panel-show');
                    });
                }
            }),
            this._signals.connect(global.window_manager, 'map', (_wm, wa) => {
                if (wa)
                    this._watchWindowActor(wa);
                this._scheduleOverlapCheck();
            }),
            this._signals.connect(global.window_manager, 'minimize', () => this._scheduleOverlapCheck()),
            this._signals.connect(global.window_manager, 'unminimize', () => this._scheduleOverlapCheck()),
            this._signals.connect(global.window_manager, 'size-changed', () => this._scheduleOverlapCheck()),
            this._signals.connect(global.display, 'window-entered-monitor', () => this._scheduleOverlapCheck()),
            this._signals.connect(global.display, 'window-left-monitor', () => this._scheduleOverlapCheck()),
            this._signals.connect(global.display, 'workareas-changed', () => this._scheduleOverlapCheck()),
            this._signals.connect(Main.layoutManager, 'monitors-changed', () => {
                this._baseY = (Main.layoutManager.primaryMonitor ?? { y: 0 }).y;
                this._syncPressureBarrier();
                this._scheduleOverlapCheck();
                this._reconcileAutohideVisibility('monitors-changed');
            })
        );

        const winGroup = global.window_group;
        if (winGroup) {
            this._autohideSigIds.push(
                this._signals.connect(winGroup, 'child-added', (_c, actor) => this._watchWindowActor(actor)),
                this._signals.connect(winGroup, 'child-removed', (_c, actor) => {
                    const entries = this._windowActors.get(actor);
                    if (entries) {
                        for (const [obj, sid] of entries) {
                            try { obj.disconnect(sid); } catch {}
                        }
                        this._windowActors.delete(actor);
                    }
                    this._scheduleOverlapCheck();
                })
            );
            for (const actor of winGroup.get_children())
                this._watchWindowActor(actor);
        }

        this._syncOverviewSearchPadding();
        this._syncPressureBarrier();
        this._scheduleOverlapCheck();
        this._reconcileAutohideVisibility('autohide-activated');
    }

    _deactivateAutohide() {
        if (!this._autohideActive)
            return;

        this._autohideActive = false;
        this._stopWatchingPointer();
        this._releaseBlockerMenu();

        if (this._extReconcileTimerId) {
            this._timers.clear(this._extReconcileTimerId);
            this._extReconcileTimerId = 0;
        }

        this._disablePressureBarrier();

        for (const entries of this._windowActors.values()) {
            for (const [obj, sid] of entries) {
                try { obj.disconnect(sid); } catch {}
            }
        }
        this._windowActors.clear();

        for (const sid of this._autohideSigIds) {
            try { this._signals.disconnect(sid); } catch {}
        }
        this._autohideSigIds = [];

        const panelBox = Main.layoutManager.panelBox;
        if (panelBox) {
            panelBox.remove_all_transitions();
            panelBox.y = this._baseY;
            panelBox.translation_y = 0;
            panelBox.show();
            try {
                Main.layoutManager.removeChrome(panelBox);
                Main.layoutManager.addChrome(panelBox, {
                    affectsStruts: true,
                    trackFullscreen: true,
                });
            } catch {
                // Keep running best-effort
            }
        }
        this._panelHidden = false;
        this._panelVisibleAnim = false;
        this._revealHoldUntilLeave = false;
        this._setUnredirectDisabled(false);
        this._syncOverviewSearchPadding();
        this._emitPanelState();
    }

    _watchWindowActor(wa) {
        if (!wa || this._windowActors.has(wa))
            return;
        const entries = [];
        const addSig = (obj, sig) => {
            if (!obj || typeof obj.connect !== 'function')
                return;
            try {
                entries.push([obj, obj.connect(sig, () => this._scheduleOverlapCheck())]);
            } catch {
                // Unsupported signal
            }
        };
        addSig(wa, 'notify::allocation');
        addSig(wa, 'notify::visible');
        const mw = wa.get_meta_window?.();
        if (mw && HANDLED_WINDOW_TYPES.has(mw.get_window_type?.())) {
            addSig(mw, 'notify::fullscreen');
            addSig(mw, 'notify::minimized');
            addSig(mw, 'size-changed');
            addSig(mw, 'position-changed');
        }
        this._windowActors.set(wa, entries);
    }

    _scheduleOverlapCheck() {
        if (!this._autohideActive)
            return;

        if (this._overlapTimeoutId) {
            this._overlapNeedsRecheck = true;
            return;
        }

        this._overlapTimeoutId = this._timers.setTimeout(60, () => {
            this._overlapTimeoutId = 0;
            this._evaluateOverlapNow();
            if (this._overlapNeedsRecheck) {
                this._overlapNeedsRecheck = false;
                this._scheduleOverlapCheck();
            }
        });
    }

    _evaluateOverlapNow() {
        if (!this._autohideActive)
            return;

        const monitor = Main.layoutManager.primaryMonitor;
        const panelBox = Main.layoutManager.panelBox;
        if (!monitor || !panelBox)
            return;

        const panelH = Math.max(28, panelBox.height || 28);
        const RectClass = globalThis.Mtk?.Rectangle ?? Meta.Rectangle;
        const panelRect = new RectClass({
            x: monitor.x,
            y: monitor.y,
            width: monitor.width,
            height: panelH,
        });

        const activeWs = global.workspace_manager.get_active_workspace();
        let overlap = false;

        if (monitor?.inFullscreen) {
            overlap = true;
        } else {
            for (const metaWin of global.display.get_tab_list(Meta.TabList.NORMAL, activeWs)) {
                if (!metaWin.showing_on_its_workspace() || metaWin.minimized)
                    continue;
                if (!HANDLED_WINDOW_TYPES.has(metaWin.get_window_type()))
                    continue;
                if (metaWin.is_fullscreen?.() && (metaWin.get_monitor?.() === monitor.index)) {
                    overlap = true;
                    break;
                }

                const rect = metaWin.get_frame_rect();
                if (rect.x < panelRect.x + panelRect.width &&
                    rect.x + rect.width > panelRect.x &&
                    rect.y < panelRect.y + panelRect.height &&
                    rect.y + rect.height > panelRect.y) {
                    overlap = true;
                    break;
                }
            }
        }

        const overlapChanged = overlap !== this._overlapDetected;
        this._overlapDetected = overlap;
        const shouldHide = (this._autohideMode === 'always' || this._autohideMode === 'autohide') || (this._autohideMode === 'intellihide' && overlap);
        const stateMismatch = shouldHide !== this._panelHidden;

        if (overlapChanged || stateMismatch) {
            this._reconcileAutohideVisibility('overlap-evaluated');
        }
    }

    _reconcileAutohideVisibility(reason) {
        if (!this._autohideActive)
            return;

        const panelBox = Main.layoutManager.panelBox;
        if (!panelBox)
            return;

        const inOverview = Boolean(
            Main.overview?.visibleTarget !== undefined
                ? Main.overview.visibleTarget
                : Main.overview?.visible
        );
        if (inOverview) {
            if (this._showInOverview)
                this._showPanel(this._animMs, 'overview');
            else
                this._hidePanel(this._animMs, 'overview-hidden');
            return;
        }

        const monitor = Main.layoutManager.primaryMonitor;
        if (monitor?.inFullscreen) {
            this._revealHoldUntilLeave = false;
            this._stopWatchingPointer();
            this._releaseBlockerMenu();
            this._hidePanel(0, 'fullscreen');
            return;
        }

        if (this._holdPanelVisible) {
            this._showPanel(this._animMs, 'panel-hold');
            return;
        }

        if (this._revealHoldUntilLeave) {
            const [px, py] = global.get_pointer();
            if (this._panelVisibleAnim || this._isPointerInPanel(px, py) || this._getActivePanelMenu()) {
                this._showPanel(this._animMs, 'reveal-hold');
                return;
            }
            this._revealHoldUntilLeave = false;
        }

        if (this._getActivePanelMenu() || this._panelGrabMenu()) {
            this._showPanel(this._animMs, 'active-menu');
            return;
        }

        const [px, py] = global.get_pointer();
        if (this._isPointerInPanel(px, py)) {
            this._showPanel(this._animMs, 'pointer-in-panel');
            this._startWatchingPointer();
            return;
        }

        if (this._autohideMode === 'always' || this._autohideMode === 'autohide') {
            this._hidePanel(this._animMs, 'autohide-always');
            return;
        }

        if (this._autohideMode === 'intellihide') {
            if (this._overlapDetected)
                this._hidePanel(this._animMs, 'intellihide-overlap');
            else
                this._showPanel(this._animMs, 'intellihide-clear');
        }
    }

    _getActivePanelMenu() {
        const statusArea = Main.panel?.statusArea;
        if (!statusArea)
            return null;
        for (const key of Object.keys(statusArea)) {
            const item = statusArea[key];
            if (item?.menu && item.menu.isOpen)
                return item.menu;
        }
        return null;
    }

    _panelGrabMenu() {
        const grab = Main.panel?._grab;
        return Boolean(grab);
    }

    _watchBlockerMenu(menu) {
        this._releaseBlockerMenu();
        if (!menu)
            return;
        this._blockerMenu = menu;
        this._blockerMenuSigId = menu.connect('open-state-changed', (_m, open) => {
            if (!open) {
                this._releaseBlockerMenu();
                this._handleMenusOrPointerLeave();
            }
        });
    }

    _releaseBlockerMenu() {
        if (this._blockerMenu && this._blockerMenuSigId) {
            try { this._blockerMenu.disconnect(this._blockerMenuSigId); } catch {}
        }
        this._blockerMenu = null;
        this._blockerMenuSigId = 0;
    }

    _handleMenusOrPointerLeave() {
        if (!this._autohideActive)
            return;

        const openMenu = this._getActivePanelMenu();
        if (openMenu) {
            this._watchBlockerMenu(openMenu);
            return;
        }

        const [px, py] = global.get_pointer();
        if (this._isPointerInPanel(px, py))
            return;

        this._revealHoldUntilLeave = false;
        this._stopWatchingPointer();
        this._reconcileAutohideVisibility('menus-or-pointer-left');
    }

    _isPointerInPanel(px, py) {
        const monitor = Main.layoutManager.primaryMonitor;
        const panelBox = Main.layoutManager.panelBox;
        if (!monitor || !panelBox || this._panelHidden || !panelBox.visible)
            return false;

        const panelY = panelBox.y + (panelBox.translation_y ?? 0);
        const panelH = Math.max(28, panelBox.height || 28);
        return px >= monitor.x &&
            px <= monitor.x + monitor.width &&
            py >= panelY &&
            py <= panelY + panelH + 4;
    }

    _startWatchingPointer() {
        if (this._pointerWatchId)
            return;

        this._pointerWatchId = this._timers.setInterval(100, () => {
            if (!this._autohideActive) {
                this._stopWatchingPointer();
                return;
            }

            if (this._getActivePanelMenu() || this._panelGrabMenu())
                return;

            const [px, py] = global.get_pointer();
            if (!this._isPointerInPanel(px, py)) {
                this._revealHoldUntilLeave = false;
                this._stopWatchingPointer();
                this._reconcileAutohideVisibility('pointer-watch-left');
            }
        });
    }

    _stopWatchingPointer() {
        if (this._pointerWatchId) {
            this._timers.clear(this._pointerWatchId);
            this._pointerWatchId = 0;
        }
    }

    _syncPressureBarrier() {
        this._disablePressureBarrier();
        if (!this._autohideActive || this._hoverMode === 'off')
            return;

        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;

        const threshold = 100;
        this._pressureBarrier = new Layout.PressureBarrier(
            threshold,
            1000,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW
        );

        this._pressureTriggerSigId = this._pressureBarrier.connect('trigger', () => {
            if (Main.layoutManager.primaryMonitor?.inFullscreen)
                return;
            this._revealHoldUntilLeave = true;
            this._showPanel(this._animMs, 'pressure-barrier');
            this._startWatchingPointer();
        });

        const y = monitor.y;
        if (this._hoverMode === 'edges') {
            const edgeW = Math.max(120, Math.round(monitor.width * 0.18));
            const leftBarrier = new Meta.Barrier({
                backend: global.backend,
                x1: monitor.x,
                y1: y,
                x2: monitor.x + edgeW,
                y2: y,
                directions: Meta.BarrierDirection.POSITIVE_Y,
            });
            const rightBarrier = new Meta.Barrier({
                backend: global.backend,
                x1: monitor.x + monitor.width - edgeW,
                y1: y,
                x2: monitor.x + monitor.width,
                y2: y,
                directions: Meta.BarrierDirection.POSITIVE_Y,
            });
            this._barriers.push(leftBarrier, rightBarrier);
            this._pressureBarrier.addBarrier(leftBarrier);
            this._pressureBarrier.addBarrier(rightBarrier);
        } else {
            const fullBarrier = new Meta.Barrier({
                backend: global.backend,
                x1: monitor.x,
                y1: y,
                x2: monitor.x + monitor.width,
                y2: y,
                directions: Meta.BarrierDirection.POSITIVE_Y,
            });
            this._barriers.push(fullBarrier);
            this._pressureBarrier.addBarrier(fullBarrier);
        }
    }

    _disablePressureBarrier() {
        if (this._pressureBarrier && this._pressureTriggerSigId) {
            try { this._pressureBarrier.disconnect(this._pressureTriggerSigId); } catch {}
        }
        if (this._pressureBarrier) {
            try { this._pressureBarrier.destroy(); } catch {}
        }
        this._pressureBarrier = null;
        this._pressureTriggerSigId = 0;

        for (const b of this._barriers) {
            try { b.destroy(); } catch {}
        }
        this._barriers = [];
    }

    _setUnredirectDisabled(disabled) {
        const want = Boolean(disabled);
        if (want === this._unredirectDisabled)
            return;
        this._unredirectDisabled = want;
        try {
            if (typeof global.compositor?.disable_unredirect === 'function') {
                if (want)
                    global.compositor.disable_unredirect();
                else
                    global.compositor.enable_unredirect();
            } else if (typeof Meta.disable_unredirect_for_display === 'function') {
                if (want)
                    Meta.disable_unredirect_for_display(global.display);
                else
                    Meta.enable_unredirect_for_display(global.display);
            }
        } catch {
            // Ignore unredirect errors on older shells
        }
    }

    _showPanel(animMs, trigger) {
        const panelBox = Main.layoutManager.panelBox;
        if (!panelBox || this._inShowPanel)
            return;
        const inOverview = Boolean(
            Main.overview?.visibleTarget !== undefined
                ? Main.overview.visibleTarget
                : Main.overview?.visible
        );
        if (Main.layoutManager.primaryMonitor?.inFullscreen && !inOverview)
            return;

        this._inShowPanel = true;
        try {
            panelBox.remove_all_transitions();
            const targetY = this._baseY;
            this._panelHidden = false;
            panelBox.show();

            if (animMs <= 0 || Math.abs((panelBox.y ?? 0) - targetY) <= 0.5) {
                this._panelVisibleAnim = false;
                panelBox.y = targetY;
                this._setUnredirectDisabled(false);
                this._emitPanelState();
                return;
            }

            this._setUnredirectDisabled(true);
            this._panelVisibleAnim = true;
            panelBox.ease({
                y: targetY,
                duration: animMs,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => {
                    this._panelVisibleAnim = false;
                    panelBox.y = targetY;
                    this._setUnredirectDisabled(false);
                    this._emitPanelState();
                },
            });
            this._emitPanelState();
        } finally {
            this._inShowPanel = false;
        }
    }

    _hidePanel(animMs, _trigger) {
        if (this._inHidePanel)
            return;
        this._inHidePanel = true;

        try {
            const panelBox = Main.layoutManager.panelBox;
            if (!panelBox)
                return;

            panelBox.remove_all_transitions();
            const panelH = Math.max(28, panelBox.height || 28);
            const targetY = this._baseY - panelH;

            this._panelHidden = true;
            this._setUnredirectDisabled(true);

            if (animMs <= 0 || !panelBox.visible || Math.abs((panelBox.y ?? 0) - targetY) <= 0.5) {
                this._panelVisibleAnim = false;
                panelBox.y = targetY;
                panelBox.hide();
                this._setUnredirectDisabled(false);
                this._emitPanelState();
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
                    this._emitPanelState();
                },
            });
            this._emitPanelState();
        } finally {
            this._inHidePanel = false;
        }
    }

    destroy() {
        this._destroyed = true;
        this._deactivateAutohide();
    }
}
