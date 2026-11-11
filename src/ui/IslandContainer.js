import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import { GrabHelper } from 'resource:///org/gnome/shell/ui/grabHelper.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { IslandState } from '../core/PriorityManager.js';
import { MorphEngine } from './MorphEngine.js';
import { CompactView } from './CompactView.js';
import { SplitView } from './SplitView.js';
import { TransientView } from './TransientView.js';
import { ExpandedView } from './ExpandedView.js';

/**
 * Root Chrome container & Adaptive Positioning Manager for BayIsland v2.1.
 * - Coordinates IDLE_BAR hover dwell / HOVER_PEEK / DROP_CATCH / 5-Tab Hub.
 * - Uses Option A ("drop-below") when hidetopbar shows PanelBox, leaving y=0..4 clear.
 * - Uses GrabHelper + focus-window tracking for reliable outside-click minimize,
 *   with seamless pointer handoff to GTK4 dnd-bridge.js inside the Shelf tab.
 */
export class IslandContainer {
    constructor({ signals, timers, priority, callbacks }) {
        this._signals = signals;
        this._timers = timers;
        this._priority = priority;
        this._cb = callbacks;

        this._pillStyle = 'floating';
        this._collisionMode = 'drop-below';
        this._topMargin = 6;
        this._idleHoverDwellMs = 160;
        this._palette = null;

        this._snapshots = {
            compat: {},
            power: null,
            powerProfile: null,
            quickActions: null,
            clipboard: null,
            shelf: null,
            notifHistory: null,
        };

        this._unredirectDisabled = false;
        this._grabSuspended = false;
        this._bridgeRect = null;
        this._focusWindowId = 0;
        this._resumeSafetyTimerId = 0;
        this._hoverDwellTimerId = 0;
        this._hoverLeaveTimerId = 0;
        this._lastState = IslandState.HIDDEN;
        this._lastStyleClass = null;
        this._lastInlineStyle = undefined;

        this._contentBin = new St.Bin({
            style_class: 'bayisland-content-bin',
            reactive: false,
            clip_to_allocation: true,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.FILL,
        });

        this._shell = new St.Widget({
            name: 'bayislandShell',
            style_class: 'bayisland-shell',
            reactive: true,
            track_hover: true,
            can_focus: false,
            clip_to_allocation: false,
            layout_manager: new Clutter.BinLayout(),
            x: 0,
            y: 0,
            width: 160,
            height: 18,
            visible: false,
        });
        this._shell.add_child(this._contentBin);

        Main.layoutManager.addTopChrome(this._shell, {
            affectsInputRegion: true,
            affectsStruts: false,
            trackFullscreen: false,
        });

        if (Main.layoutManager.modalDialogGroup &&
            this._shell.get_parent() === Main.layoutManager.modalDialogGroup.get_parent()) {
            Main.uiGroup.set_child_below_sibling(this._shell, Main.layoutManager.modalDialogGroup);
        }

        // Connect shell capture BEFORE GrabHelper initializes so Shelf passthrough runs first
        this._signals.connect(this._shell, 'captured-event', (_actor, event) => {
            return this._onShellCapturedEvent(event);
        });

        this._grabHelper = new GrabHelper(this._shell, {
            actionMode: Shell.ActionMode.POPUP,
        });

        this._morph = new MorphEngine(this._shell, this._contentBin, this._timers);
        this._compactView = new CompactView({
            onExpand: () => this._priority.expand(),
            onMediaToggle: () => this._cb.onMediaPlayPause?.(),
        });
        this._splitView = new SplitView({
            onExpandTab: tab => this._priority.expand(tab),
        });
        this._transientView = new TransientView({
            onDismiss: id => this._priority.dismissTransient(id),
            onActivate: () => this._cb.onTransientActivate?.(),
        });
        this._expandedView = new ExpandedView({
            ...callbacks,
            onSelectTab: tab => this._priority.setExpandedTab(tab),
            onCollapse: () => this._priority.collapse(),
            onAcquireTextModal: entry => this.acquireTextModal(entry),
            onReleaseTextModal: () => this.releaseTextModal(),
        }, this._timers);

        this._bindEvents();
        this._syncEnvironment();
    }

    _bindEvents() {
        this._signals.connect(this._shell, 'notify::hover', () => {
            const hovered = Boolean(this._shell?.hover);
            this._priority.setHovered(hovered);
            this._handleHoverTransition(hovered);
        });

        this._signals.connect(this._shell, 'button-release-event', (_actor, event) => {
            if (event.get_coords) {
                const [ex, ey] = event.get_coords();
                if (!this._isCoordsInShell(ex, ey))
                    return Clutter.EVENT_PROPAGATE;
            }
            let src = global.stage?.get_event_actor?.(event) ?? event.get_source?.();
            if (src && src !== this._shell && !this._shell.contains(src))
                return Clutter.EVENT_PROPAGATE;
            while (src && src !== this._shell) {
                if (src instanceof St.Button || src instanceof St.Entry)
                    return Clutter.EVENT_PROPAGATE;
                src = src.get_parent();
            }

            const btn = event.get_button();
            const model = this._priority.getModel();

            if (model.state === IslandState.TRANSIENT_BANNER) {
                if (btn === Clutter.BUTTON_SECONDARY || btn === Clutter.BUTTON_MIDDLE) {
                    this._priority.dismissTransient(model.transient?.id);
                    return Clutter.EVENT_STOP;
                }
                if (btn === Clutter.BUTTON_PRIMARY && typeof model.transient?.onActivate === 'function') {
                    model.transient.onActivate();
                    this._priority.dismissTransient(model.transient?.id);
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_STOP;
            }

            if (model.state === IslandState.IDLE_BAR || model.state === IslandState.HOVER_PEEK) {
                if (btn === Clutter.BUTTON_PRIMARY) {
                    this._priority.expand();
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            }

            if (model.state === IslandState.COMPACT_PILL || model.state === IslandState.AMBIENT_DOT) {
                if (btn === Clutter.BUTTON_MIDDLE && model.primary === 'media') {
                    this._cb.onMediaPlayPause?.();
                    return Clutter.EVENT_STOP;
                }
                if (btn === Clutter.BUTTON_PRIMARY) {
                    let targetTab = model.primary;
                    if (model.primary === 'privacy' || model.primary === 'idle')
                        targetTab = 'power';
                    else if (model.primary === 'timer')
                        targetTab = 'home';
                    this._priority.toggleExpand(targetTab);
                    return Clutter.EVENT_STOP;
                }
            }
            return Clutter.EVENT_PROPAGATE;
        });

        this._signals.connect(this._shell, 'scroll-event', (_actor, event) => {
            const model = this._priority.getModel();
            if (model.state !== IslandState.COMPACT_PILL &&
                model.state !== IslandState.HOVER_PEEK &&
                model.state !== IslandState.SPLIT_PILL)
                return Clutter.EVENT_PROPAGATE;

            const dir = event.get_scroll_direction();
            if (dir === Clutter.ScrollDirection.UP) {
                this._cb.onStepVolume?.(0.05, { showOsd: true });
                return Clutter.EVENT_STOP;
            }
            if (dir === Clutter.ScrollDirection.DOWN) {
                this._cb.onStepVolume?.(-0.05, { showOsd: true });
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        const panelBox = Main.layoutManager.panelBox;
        this._signals.connect(panelBox, 'notify::visible', () => this._onEnvironmentChanged());
        this._signals.connect(panelBox, 'notify::y', () => this._onEnvironmentChanged());
        this._signals.connect(panelBox, 'notify::translation-y', () => this._onEnvironmentChanged());
        this._signals.connect(panelBox, 'notify::height', () => this._onEnvironmentChanged());
        this._signals.connect(Main.overview, 'showing', () => this._onEnvironmentChanged());
        this._signals.connect(Main.overview, 'hiding', () => this._onEnvironmentChanged());
        this._signals.connect(Main.layoutManager, 'monitors-changed', () => this._onEnvironmentChanged());
        this._signals.connect(global.display, 'in-fullscreen-changed', () => this._onEnvironmentChanged());

        this._signals.connect(this._priority, 'model-changed', (_src, payload) => {
            this.renderModel(payload.model, payload.inPlaceOnly);
        });
    }

    _clearHoverTimers() {
        if (this._hoverDwellTimerId) {
            this._timers.clear(this._hoverDwellTimerId);
            this._hoverDwellTimerId = 0;
        }
        if (this._hoverLeaveTimerId) {
            this._timers.clear(this._hoverLeaveTimerId);
            this._hoverLeaveTimerId = 0;
        }
    }

    _clearResumeSafetyTimer() {
        if (this._resumeSafetyTimerId) {
            this._timers.clear(this._resumeSafetyTimerId);
            this._resumeSafetyTimerId = 0;
        }
    }

    _handleHoverTransition(hovered) {
        const st = this._priority.getModel()?.state;
        if (hovered) {
            if (this._hoverLeaveTimerId) {
                this._timers.clear(this._hoverLeaveTimerId);
                this._hoverLeaveTimerId = 0;
            }
            if (st === IslandState.IDLE_BAR && !this._hoverDwellTimerId) {
                this._hoverDwellTimerId = this._timers.setTimeout(this._idleHoverDwellMs, () => {
                    this._hoverDwellTimerId = 0;
                    if (this._shell?.hover && this._priority.getModel()?.state === IslandState.IDLE_BAR)
                        this._priority.setHoverPeek(true);
                });
            }
        } else {
            if (this._hoverDwellTimerId) {
                this._timers.clear(this._hoverDwellTimerId);
                this._hoverDwellTimerId = 0;
            }
            if (st === IslandState.HOVER_PEEK && !this._hoverLeaveTimerId) {
                this._hoverLeaveTimerId = this._timers.setTimeout(220, () => {
                    this._hoverLeaveTimerId = 0;
                    if (!this._shell?.hover)
                        this._priority.setHoverPeek(false);
                });
            }
        }
    }

    _isCoordsInBridgeInteractive(ex, ey) {
        const r = this._bridgeRect;
        if (!r || r.width <= 0 || r.height <= 0)
            return false;

        const dropBottom = r.y + (r.dropHeight ?? r.height);
        if (ex >= r.x && ex <= (r.x + r.width) && ey >= r.y && ey <= dropBottom)
            return true;

        const dragW = Math.max(0, r.dragZoneWidth ?? r.width);
        if (ey > dropBottom && ey <= (r.y + r.height) && ex >= r.x && ex <= (r.x + dragW))
            return true;

        return false;
    }

    _isCoordsInShell(ex, ey) {
        if (!this._shell || !this._shell.visible)
            return false;
        const [px, py] = this._shell.get_transformed_position();
        const [pw, ph] = this._shell.get_transformed_size();
        return ex >= px && ex <= (px + pw) && ey >= py && ey <= (py + ph);
    }

    _onShellCapturedEvent(event) {
        const model = this._priority.getModel();
        if (!model || model.state !== IslandState.EXPANDED_MODAL || model.tab !== 'shelf')
            return Clutter.EVENT_PROPAGATE;

        const type = event.type();
        if (type !== Clutter.EventType.MOTION &&
            type !== Clutter.EventType.ENTER &&
            type !== Clutter.EventType.BUTTON_PRESS &&
            type !== Clutter.EventType.BUTTON_RELEASE &&
            type !== Clutter.EventType.TOUCH_BEGIN)
            return Clutter.EVENT_PROPAGATE;

        if (!event.get_coords)
            return Clutter.EVENT_PROPAGATE;

        const [ex, ey] = event.get_coords();
        const inBridge = this._isCoordsInBridgeInteractive(ex, ey);

        // Release compositor grab as pointer enters Shelf dropzone/drag-handle area
        // so Wayland delivers native hover, drag-out, and drops to GTK4 dnd-bridge.
        if (inBridge && !this._cb.isShelfModalLockActive?.()) {
            if (this._grabHelper?.grabbed)
                this._suspendModalGrab();
            return Clutter.EVENT_STOP;
        }

        // Prevent GrabHelper from mistaking internal non-reactive Shelf card padding clicks
        // (when _shell.reactive is false) for clicks outside the island.
        if ((type === Clutter.EventType.BUTTON_PRESS ||
            type === Clutter.EventType.BUTTON_RELEASE ||
            type === Clutter.EventType.TOUCH_BEGIN) &&
            this._grabHelper?.grabbed &&
            this._isCoordsInShell(ex, ey)) {
            const target = global.stage.get_event_actor(event);
            if (!target || !this._shell.contains(target))
                return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    }

    handleBridgeActivity(activity) {
        const kind = activity?.kind;
        if (!kind)
            return;

        const model = this._priority.getModel();
        if (model?.state !== IslandState.EXPANDED_MODAL)
            return;

        if (kind === 'picker-open') {
            this._suspendModalGrab();
            return;
        }

        if (kind === 'pointer-enter') {
            this._clearResumeSafetyTimer();
            if (this._grabHelper?.grabbed)
                this._suspendModalGrab();
            return;
        }

        if (kind === 'pointer-leave' || kind === 'drag-out-end' || kind === 'picker-result') {
            if (this._cb.isShelfModalLockActive?.())
                return;
            const [mx, my] = global.get_pointer();
            if (kind !== 'pointer-leave' || model.tab !== 'shelf' || !this._isCoordsInBridgeInteractive(mx, my))
                this._resumeModalGrab();
        }
    }

    _acquireGrab() {
        if (!this._grabHelper || !this._shell || this._grabHelper.grabbed)
            return;
        this._grabSuspended = false;
        this._clearResumeSafetyTimer();
        this._grabHelper.grab({
            actor: this._shell,
            onUngrab: isUser => {
                if (isUser && !this._grabSuspended)
                    this._priority.collapse();
            },
        });
    }

    _suspendModalGrab() {
        if (this._grabSuspended && !this._grabHelper?.grabbed)
            return;
        this._grabSuspended = true;
        if (this._grabHelper?.grabbed)
            this._grabHelper.ungrab({ isUser: false });

        this._clearResumeSafetyTimer();
        if (!this._cb.isShelfModalLockActive?.()) {
            // Guards against fast pointer leaves before cold-started GTK4 bridge maps
            this._resumeSafetyTimerId = this._timers.setTimeout(180, () => {
                this._resumeSafetyTimerId = 0;
                const model = this._priority.getModel();
                if (model?.state !== IslandState.EXPANDED_MODAL || !this._grabSuspended)
                    return;
                if (this._cb.isShelfModalLockActive?.() || this._cb.isPointerInShelfBridge?.())
                    return;
                const [mx, my] = global.get_pointer();
                if (model.tab !== 'shelf' || !this._isCoordsInBridgeInteractive(mx, my))
                    this._resumeModalGrab();
            });
        }
    }

    _resumeModalGrab() {
        const model = this._priority.getModel();
        if (!model || model.state !== IslandState.EXPANDED_MODAL) {
            this._grabSuspended = false;
            return;
        }
        if (this._cb.isShelfModalLockActive?.())
            return;
        this._grabSuspended = false;
        this._clearResumeSafetyTimer();
        this._acquireGrab();
    }

    _syncExpandedModal(expanded) {
        if (expanded) {
            if (!this._focusWindowId) {
                this._focusWindowId = global.display.connect('notify::focus-window', () => {
                    if (this._priority.getModel()?.state !== IslandState.EXPANDED_MODAL)
                        return;
                    if (this._cb.isShelfModalLockActive?.() || this._cb.isShelfPickerOpen?.())
                        return;
                    const win = global.display.focus_window;
                    if (!win || win.get_title?.() === '__bayisland_dnd_bridge__')
                        return;
                    this._priority.collapse();
                });
            }

            if (!this._grabHelper?.grabbed && !this._grabSuspended)
                this._acquireGrab();
        } else {
            this._grabSuspended = false;
            this._clearResumeSafetyTimer();
            if (this._focusWindowId) {
                try { global.display.disconnect(this._focusWindowId); } catch {}
                this._focusWindowId = 0;
            }
            if (this._grabHelper?.grabbed)
                this._grabHelper.ungrab({ isUser: false });
        }
    }

    acquireTextModal(entry) {
        if (!this._shell || this._priority.getModel()?.state !== IslandState.EXPANDED_MODAL)
            return;
        if (!this._grabHelper?.grabbed && !this._grabSuspended)
            this._acquireGrab();
        try {
            entry?.grab_key_focus?.();
        } catch (e) {
            logError(e, 'BayIsland acquireTextModal focus failed');
        }
    }

    releaseTextModal() {
        // GrabHelper keeps compositor modal active; no separate Main.popModal needed
    }

    setAppearance({ pillStyle, collisionMode, topMargin, idleHoverDwellMs }) {
        if (pillStyle !== undefined)
            this._pillStyle = pillStyle;
        if (collisionMode !== undefined)
            this._collisionMode = collisionMode;
        if (topMargin !== undefined)
            this._topMargin = topMargin;
        if (idleHoverDwellMs !== undefined)
            this._idleHoverDwellMs = Math.max(50, Math.min(600, Math.round(idleHoverDwellMs)));

        const model = this._priority.getModel();
        this._applyShellStyleClasses(model.state, model);
        this._repositionCurrent();
    }

    setPalette(palette) {
        this._palette = palette;
        this._applyInlineTheme(this._lastState, this._priority.getModel());
        this.renderModel(this._priority.getModel(), false);
    }

    setCompatSnapshot(snapshot) {
        this._snapshots.compat = snapshot;
    }

    setPowerSnapshot(snapshot) {
        this._snapshots.power = snapshot;
        const model = this._priority.getModel();
        if (model.state === IslandState.EXPANDED_MODAL)
            this._expandedView.updatePowerProfile(model, this._palette, this._snapshots);
    }

    setPowerProfileSnapshot(snapshot) {
        this._snapshots.powerProfile = snapshot;
        const model = this._priority.getModel();
        if (model.state === IslandState.EXPANDED_MODAL)
            this._expandedView.updatePowerProfile(model, this._palette, this._snapshots);
    }

    setQuickActionsSnapshot(snapshot) {
        this._snapshots.quickActions = snapshot;
        const model = this._priority.getModel();
        if (model.state === IslandState.EXPANDED_MODAL)
            this._expandedView.updateQuickActions(snapshot, this._palette);
    }

    setClipboardSnapshot(snapshot) {
        this._snapshots.clipboard = snapshot;
        const model = this._priority.getModel();
        if (model.state === IslandState.EXPANDED_MODAL)
            this._expandedView.updateClipboard(snapshot, this._palette);
    }

    setShelfSnapshot(snapshot) {
        this._snapshots.shelf = snapshot;
        const model = this._priority.getModel();
        if (model.state === IslandState.EXPANDED_MODAL) {
            this._expandedView.updateShelf(model, this._palette, snapshot);
            if (this._wantsBridgePassthrough(model)) {
                const { width, height } = this._getTargetSize(model);
                const coords = this._computeCoords(width);
                const bridgeRect = this._computeBridgeRect(model, coords.x, coords.y, width, height);
                this._bridgeRect = bridgeRect;
                this._cb.onSyncShelfBridge?.(model, bridgeRect);
                this._morph.morphTo({
                    x: coords.x,
                    y: coords.y,
                    width,
                    height,
                    visible: true,
                    isExpanding: false,
                    inPlaceOnly: true,
                    onSettled: () => {
                        const cur = this._priority.getModel();
                        if (this._wantsBridgePassthrough(cur) && this._bridgeRect)
                            this._cb.onSyncShelfBridge?.(cur, this._bridgeRect);
                    },
                });
            }
        }
    }

    setNotificationHistory(history) {
        this._snapshots.notifHistory = history;
        const model = this._priority.getModel();
        if (model.state === IslandState.EXPANDED_MODAL)
            this._expandedView.updateNotifications(history, model);
    }

    _isPanelVisiblyBlockingTop() {
        const monitor = Main.layoutManager.primaryMonitor;
        const panelBox = Main.layoutManager.panelBox;
        if (!monitor || !panelBox || !panelBox.visible)
            return false;

        const panelY = panelBox.y + (panelBox.translation_y ?? 0);
        const panelBottom = panelY + panelBox.height;
        return panelBottom > monitor.y + 4;
    }

    _syncEnvironment() {
        const monitor = Main.layoutManager.primaryMonitor;
        return this._priority.setEnvironment({
            panelVisible: this._isPanelVisiblyBlockingTop(),
            inFullscreen: Boolean(monitor?.inFullscreen),
        });
    }

    _onEnvironmentChanged() {
        this._syncEnvironment();
        this._repositionCurrent();
    }

    _computeCoords(width) {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return { x: 0, y: 0 };

        const x = monitor.x + Math.round((monitor.width - width) / 2);
        const panelBox = Main.layoutManager.panelBox;
        const panelVisible = this._isPanelVisiblyBlockingTop();

        const baseTopY = monitor.y + (this._pillStyle === 'notch' ? 0 : this._topMargin);
        let y;
        if (panelVisible && this._collisionMode === 'drop-below') {
            const panelBottom = panelBox.y + (panelBox.translation_y ?? 0) + panelBox.height;
            y = Math.round(Math.max(baseTopY, panelBottom + Math.max(4, this._topMargin)));
        } else {
            y = baseTopY;
        }

        return { x, y };
    }

    _computeBridgeRect(model, x, y, width, height) {
        if (model.state === IslandState.DROP_CATCH) {
            return {
                x,
                y,
                width,
                height,
                dropHeight: height,
                rowHeight: 44,
                dragZoneWidth: width,
            };
        }
        if (model.state === IslandState.EXPANDED_MODAL && model.tab === 'shelf')
            return this._expandedView.getShelfBridgeRegion(x, y, width, height);
        return null;
    }

    _repositionCurrent() {
        const model = this._priority.getModel();
        if (!model || model.state === IslandState.HIDDEN)
            return;

        const { width, height } = this._getTargetSize(model);
        const coords = this._computeCoords(width);
        const panelTransition = Main.layoutManager.panelBox?.get_transition('y');
        if (panelTransition)
            this._morph.snapPosition(coords);
        else
            this._morph.glidePosition(coords);

        const bridgeRect = this._wantsBridgePassthrough(model)
            ? this._computeBridgeRect(model, coords.x, coords.y, width, height)
            : null;
        this._bridgeRect = bridgeRect;
        this._cb.onSyncShelfBridge?.(model, bridgeRect);
    }

    _getTargetSize(model) {
        switch (model.state) {
        case IslandState.IDLE_BAR:
        case IslandState.HOVER_PEEK:
        case IslandState.DROP_CATCH:
        case IslandState.AMBIENT_DOT:
        case IslandState.COMPACT_PILL:
            return this._compactView.getPreferredSize(model);
        case IslandState.SPLIT_PILL:
            return this._splitView.getPreferredSize();
        case IslandState.TRANSIENT_BANNER:
            return this._transientView.getPreferredSize(model);
        case IslandState.EXPANDED_MODAL:
            return this._expandedView.getPreferredSize(model, this._snapshots);
        default:
            return { width: 160, height: 18 };
        }
    }

    _applyShellStyleClasses(state, model) {
        const classes = ['bayisland-shell'];
        const panelVisible = this._isPanelVisiblyBlockingTop();

        if (state === IslandState.IDLE_BAR)
            classes.push('bayisland-idle-bar');
        else if (state === IslandState.HOVER_PEEK)
            classes.push('bayisland-hover-peek');
        else if (state === IslandState.DROP_CATCH) {
            classes.push('bayisland-dropcatch');
            if (model.meta?.dragHighlight)
                classes.push('bayisland-dropcatch-glow');
        }

        if (this._pillStyle === 'notch' &&
            state !== IslandState.IDLE_BAR &&
            !(panelVisible && this._collisionMode === 'drop-below'))
            classes.push('bayisland-notch');

        if (state === IslandState.TRANSIENT_BANNER)
            classes.push('bayisland-transient');
        if (state === IslandState.EXPANDED_MODAL)
            classes.push('bayisland-expanded');

        const alertStyle = model?.transient?.alertStyle;
        if (alertStyle === 'critical')
            classes.push('bayisland-alert-critical');
        else if (alertStyle === 'success')
            classes.push('bayisland-alert-success');
        else if (alertStyle === 'power')
            classes.push('bayisland-alert-power');

        const nextClass = classes.join(' ');
        if (this._lastStyleClass !== nextClass) {
            this._lastStyleClass = nextClass;
            this._shell.style_class = nextClass;
        }
        this._applyInlineTheme(state, model);
    }

    _applyInlineTheme(state = this._lastState, model = this._priority?.getModel()) {
        let nextStyle = null;
        if (state !== IslandState.IDLE_BAR && this._palette) {
            if (state === IslandState.DROP_CATCH && model?.meta?.dragHighlight)
                nextStyle = `background-color: ${this._palette.accentCss}; color: ${this._palette.accentFgCss};`;
            else
                nextStyle = `background-color: ${this._palette.pillBgCss};`;
        }
        if (this._lastInlineStyle !== nextStyle) {
            this._lastInlineStyle = nextStyle;
            this._shell.style = nextStyle;
        }
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
            // Best effort on headless/older backends
        }
    }

    _wantsBridgePassthrough(model) {
        return model.state === IslandState.DROP_CATCH ||
            (model.state === IslandState.EXPANDED_MODAL && model.tab === 'shelf');
    }

    renderModel(model, inPlaceOnly = false) {
        const prevState = this._lastState;
        this._lastState = model.state;

        if (model.state !== IslandState.IDLE_BAR && model.state !== IslandState.HOVER_PEEK)
            this._clearHoverTimers();

        if (model.state !== IslandState.EXPANDED_MODAL || model.tab !== 'shelf') {
            if (this._grabSuspended && !this._cb.isShelfModalLockActive?.())
                this._grabSuspended = false;
        }

        const isExpanded = model.state === IslandState.EXPANDED_MODAL;
        this._syncExpandedModal(isExpanded);
        if (isExpanded && model.tab !== 'shelf' && this._grabSuspended && !this._cb.isShelfModalLockActive?.())
            this._resumeModalGrab();

        this._cb.onExpandedTabState?.(model);

        const passthrough = this._wantsBridgePassthrough(model);
        this._shell.reactive = !passthrough;

        if (!passthrough) {
            this._bridgeRect = null;
            this._cb.onSyncShelfBridge?.(model, null);
        }

        if (model.state === IslandState.HIDDEN) {
            this._morph.setEqualizerPlaying(false);
            this._expandedView.destroyCurrentTab();
            const coords = this._computeCoords(160);
            this._morph.morphTo({
                x: coords.x,
                y: coords.y,
                width: 160,
                height: 18,
                visible: false,
                isExpanding: false,
                inPlaceOnly: false,
                onHidden: () => {
                    this._contentBin.set_child(null);
                    this._setUnredirectDisabled(false);
                },
            });
            return;
        }

        if (model.state !== IslandState.EXPANDED_MODAL)
            this._expandedView.destroyCurrentTab();

        // Keep stage composited while BayIsland (even IDLE_BAR) is shown so
        // Mutter never skips painting the island over maximized/fullscreen apps.
        this._setUnredirectDisabled(true);

        this._applyShellStyleClasses(model.state, model);

        let updatedInPlace = false;
        if (inPlaceOnly && prevState === model.state) {
            if (model.state === IslandState.IDLE_BAR ||
                model.state === IslandState.HOVER_PEEK ||
                model.state === IslandState.DROP_CATCH ||
                model.state === IslandState.COMPACT_PILL ||
                model.state === IslandState.AMBIENT_DOT)
                updatedInPlace = this._compactView.updateInPlace(model);
            else if (model.state === IslandState.SPLIT_PILL)
                updatedInPlace = this._splitView.updateInPlace(model);
            else if (model.state === IslandState.TRANSIENT_BANNER)
                updatedInPlace = this._transientView.updateInPlace(model);
            else if (model.state === IslandState.EXPANDED_MODAL)
                updatedInPlace = this._expandedView.updateInPlace(model, this._snapshots);
        }

        if (!updatedInPlace) {
            let child = null;
            let eqBars = [];

            switch (model.state) {
            case IslandState.IDLE_BAR:
            case IslandState.HOVER_PEEK:
            case IslandState.DROP_CATCH:
            case IslandState.AMBIENT_DOT:
            case IslandState.COMPACT_PILL:
                child = this._compactView.render(model, this._palette);
                eqBars = this._compactView.getEqBars();
                break;
            case IslandState.SPLIT_PILL:
                child = this._splitView.render(model, this._palette);
                eqBars = this._splitView.getEqBars();
                break;
            case IslandState.TRANSIENT_BANNER:
                child = this._transientView.render(model, this._palette);
                break;
            case IslandState.EXPANDED_MODAL:
                child = this._expandedView.render(model, this._palette, this._snapshots);
                break;
            }

            this._contentBin.set_child(child);
            this._morph.registerEqBars(eqBars);
        }

        const mediaPlaying =
            model.persistent?.media?.active &&
            model.persistent?.media?.status === 'Playing' &&
            (model.state === IslandState.COMPACT_PILL || model.state === IslandState.SPLIT_PILL);
        this._morph.setEqualizerPlaying(mediaPlaying);

        const { width, height } = this._getTargetSize(model);
        const { x, y } = this._computeCoords(width);
        const bridgeRect = passthrough ? this._computeBridgeRect(model, x, y, width, height) : null;
        this._bridgeRect = bridgeRect;
        if (passthrough && bridgeRect)
            this._cb.onSyncShelfBridge?.(model, bridgeRect);

        const isExpanding =
            prevState === IslandState.HIDDEN ||
            prevState === IslandState.IDLE_BAR ||
            model.state === IslandState.EXPANDED_MODAL ||
            model.state === IslandState.TRANSIENT_BANNER ||
            model.state === IslandState.DROP_CATCH;

        this._morph.morphTo({
            x,
            y,
            width,
            height,
            visible: true,
            isExpanding,
            inPlaceOnly: updatedInPlace,
            onSettled: passthrough
                ? () => {
                    const cur = this._priority.getModel();
                    if (this._wantsBridgePassthrough(cur) && this._bridgeRect)
                        this._cb.onSyncShelfBridge?.(cur, this._bridgeRect);
                }
                : undefined,
        });
    }

    destroy() {
        this._clearHoverTimers();
        this._clearResumeSafetyTimer();
        this._syncExpandedModal(false);
        this._setUnredirectDisabled(false);
        this._cb.onSyncShelfBridge?.({ state: IslandState.HIDDEN }, null);
        this._expandedView.destroy();
        this._morph.destroy();

        try {
            Main.layoutManager.removeChrome(this._shell);
        } catch {
            // Already removed
        }

        this._shell?.destroy();
        this._shell = null;
        this._contentBin = null;
        this._grabHelper = null;
    }
}
