import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
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

function isSamePalette(a, b) {
    if (a === b)
        return true;
    if (!a || !b)
        return false;
    return a.pillBgCss === b.pillBgCss &&
        a.integratedBgCss === b.integratedBgCss &&
        a.integratedHoverBgCss === b.integratedHoverBgCss &&
        a.integratedBorderCss === b.integratedBorderCss &&
        a.integratedFlat === b.integratedFlat &&
        a.integratedGlowCss === b.integratedGlowCss &&
        a.integratedOverviewBgCss === b.integratedOverviewBgCss &&
        a.integratedOverviewHoverBgCss === b.integratedOverviewHoverBgCss &&
        a.integratedOverviewBorderCss === b.integratedOverviewBorderCss &&
        a.integratedOverviewFlat === b.integratedOverviewFlat &&
        a.integratedOverviewGlowCss === b.integratedOverviewGlowCss &&
        a.integratedRadiusPx === b.integratedRadiusPx &&
        a.accentCss === b.accentCss &&
        a.accentOnDarkCss === b.accentOnDarkCss &&
        a.accentFgCss === b.accentFgCss;
}

const BayIslandViewport = GObject.registerClass(
class BayIslandViewport extends St.Widget {
    _init(params = {}) {
        super._init({
            clip_to_allocation: false,
            reactive: false,
            x_expand: true,
            y_expand: true,
            ...params,
        });
        this._lockedSize = null;
    }

    setChild(actor, lockedSize = null) {
        this._lockedSize = lockedSize
            ? {
                width: Math.max(1, Math.round(lockedSize.width)),
                height: Math.max(1, Math.round(lockedSize.height)),
            }
            : null;
        this.clip_to_allocation = Boolean(this._lockedSize);

        const cur = this.get_first_child();
        if (cur === actor) {
            this.queue_relayout();
            return;
        }
        if (cur) {
            this.remove_child(cur);
            try {
                cur.destroy();
            } catch {
                // Already destroyed
            }
        }
        if (actor)
            this.add_child(actor);
        this.queue_relayout();
    }

    setLockedSize(lockedSize) {
        const next = lockedSize
            ? {
                width: Math.max(1, Math.round(lockedSize.width)),
                height: Math.max(1, Math.round(lockedSize.height)),
            }
            : null;
        if (next && this._lockedSize &&
            next.width === this._lockedSize.width &&
            next.height === this._lockedSize.height)
            return;
        if (!next && !this._lockedSize)
            return;
        this._lockedSize = next;
        this.clip_to_allocation = Boolean(this._lockedSize);
        this.queue_relayout();
    }

    vfunc_get_preferred_width(forHeight) {
        const child = this.get_first_child();
        if (!child || !child.visible)
            return [0, 0];
        const [minW, natW] = child.get_preferred_width(forHeight);
        if (this._lockedSize)
            return [0, Math.max(minW, this._lockedSize.width)];
        return [minW, natW];
    }

    vfunc_get_preferred_height(forWidth) {
        const child = this.get_first_child();
        if (!child || !child.visible)
            return [0, 0];
        const queryW = this._lockedSize ? this._lockedSize.width : forWidth;
        const [minH, natH] = child.get_preferred_height(queryW);
        if (this._lockedSize)
            return [0, Math.max(minH, this._lockedSize.height)];
        return [minH, natH];
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        const child = this.get_first_child();
        if (!child || !child.visible)
            return;

        const availW = Math.max(0, box.x2 - box.x1);
        const availH = Math.max(0, box.y2 - box.y1);

        let childW;
        let childH;
        if (this._lockedSize) {
            const [minW] = child.get_preferred_width(-1);
            childW = Math.max(minW, this._lockedSize.width);
            const [minH] = child.get_preferred_height(childW);
            childH = Math.max(minH, this._lockedSize.height);
        } else {
            const [minW] = child.get_preferred_width(-1);
            childW = Math.max(minW, availW);
            const [minH] = child.get_preferred_height(childW);
            childH = Math.max(minH, availH);
        }

        const dx = Math.round((availW - childW) / 2);
        const cBox = new Clutter.ActorBox({
            x1: dx,
            y1: 0,
            x2: dx + childW,
            y2: childH,
        });
        child.allocate(cBox);
    }
});

/**
 * Root Chrome container & Adaptive Positioning Manager for BayIsland v2.1.
 * - Coordinates IDLE_BAR hover dwell / HOVER_PEEK / DROP_CATCH / 5-Tab Hub.
 * - Uses Option A ("drop-below") when hidetopbar shows PanelBox, leaving y=0..4 clear.
 * - Uses GrabHelper + focus-window tracking for reliable outside-click minimize,
 *   with seamless pointer handoff to GTK4 dnd-bridge.js inside the Shelf tab.
 */
export class IslandContainer {
    constructor({ signals, timers, priority, topBar = null, callbacks }) {
        this._signals = signals;
        this._timers = timers;
        this._priority = priority;
        this._topBar = topBar;
        this._cb = callbacks;

        this._pillStyle = 'floating';
        this._collisionMode = 'drop-below';
        this._topbarIntegrationMode = 'merged-pill';
        this._mergedClockRightClickGnome = true;
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
        this._restacking = false;
        this._destroying = false;
        this._disposedActors = new WeakSet();
        this._deferredExpandedCleanup = false;
        this._bridgeRect = null;
        this._focusWindowId = 0;
        this._resumeSafetyTimerId = 0;
        this._hoverDwellTimerId = 0;
        this._hoverLeaveTimerId = 0;
        this._lastState = IslandState.HIDDEN;
        this._lastStyleClass = null;
        this._lastInlineStyle = undefined;
        this._lastInOverview = false;
        this._lastInPanelSlot = false;
        this._targetWidth = 172;
        this._targetHeight = 22;
        this._inRenderModel = false;
        this._transientDrag = null;

        this._contentBin = new BayIslandViewport({
            style_class: 'bayisland-content-bin',
        });

        this._shell = new St.Widget({
            name: 'bayislandShell',
            style_class: 'bayisland-shell',
            reactive: false,
            track_hover: true,
            can_focus: false,
            clip_to_allocation: false,
            layout_manager: new Clutter.BinLayout(),
            x: 0,
            y: 0,
            width: 172,
            height: 22,
            opacity: 0,
            visible: true,
        });
        this._shell.add_child(this._contentBin);

        Main.layoutManager.addTopChrome(this._shell, {
            affectsInputRegion: true,
            affectsStruts: false,
            trackFullscreen: false,
        });

        this._ensureShellTopOrder();

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
            onToggleMinimizePersistent: () => this._priority?.toggleMinimizePersistent(),
        });
        this._splitView = new SplitView({
            onExpandTab: tab => this._priority.expand(tab),
        });
        this._transientView = new TransientView({
            onDismiss: id => this._priority.dismissTransient(id),
            onActivate: () => this._cb.onTransientActivate?.(),
            onOsdSeek: (t, fraction) => {
                if (t?.coalesceKey === 'osd-volume' || t?.title?.toLowerCase().includes('volume'))
                    this._cb.onSetOutputVolume?.(fraction);
                else if (t?.coalesceKey === 'osd-brightness' || t?.title?.toLowerCase().includes('brightness'))
                    this._cb.onSetBrightnessFraction?.(fraction);
            },
            onOsdToggleMute: () => this._cb.onToggleOutputMute?.(),
        });
        this._expandedView = new ExpandedView({
            ...callbacks,
            onSelectTab: tab => this._priority.setExpandedTab(tab),
            onCollapse: () => this._priority.collapse(),
            onAcquireTextModal: entry => this.acquireTextModal(entry),
            onReleaseTextModal: () => this.releaseTextModal(),
        }, this._timers);

        this._bindEvents();
        this._priority.setDebugProvider?.(() => {
            const shellAlive = Boolean(!this._destroying && this._shell && !this._disposedActors.has(this._shell));
            return {
                shellVisible: shellAlive ? Boolean(this._shell.visible) : false,
                shellOpacity: shellAlive ? (this._shell.opacity ?? 0) : 0,
                shellRect: shellAlive ? {
                    x: Math.round(this._shell.x),
                    y: Math.round(this._shell.y),
                    width: Math.round(this._shell.width),
                    height: Math.round(this._shell.height),
                } : null,
                unredirectDisabled: this._unredirectDisabled,
                topOrderOk: shellAlive ? this._isShellTopOrderOk() : false,
                topbarIntegrationMode: this._topbarIntegrationMode,
                clockSlotClaimed: Boolean(this._topBar?._slotClaimed),
            };
        });
        this._syncEnvironment();
    }

    _trackActorLifecycle(actor, onDestroy = null) {
        if (!actor || typeof actor.connect !== 'function')
            return;
        try {
            this._signals.connect(actor, 'destroy', () => {
                this._disposedActors.add(actor);
                onDestroy?.();
            });
        } catch {
            // Non-Clutter GObjects without destroy signal
        }
    }

    _bindEvents() {
        this._trackActorLifecycle(this._shell, () => {
            this._destroying = true;
            this._clearHoverTimers();
            this._clearResumeSafetyTimer();
            this._morph?.destroy();
            this._shell = null;
            this._contentBin = null;
        });
        this._trackActorLifecycle(Main.uiGroup, () => {
            this._destroying = true;
            this._clearHoverTimers();
            this._clearResumeSafetyTimer();
            this._morph?.destroy();
        });
        this._trackActorLifecycle(Main.layoutManager.panelBox);
        this._trackActorLifecycle(Main.layoutManager.overviewGroup);
        this._trackActorLifecycle(Main.layoutManager.modalDialogGroup);
        this._trackActorLifecycle(global.window_group);
        this._trackActorLifecycle(global.top_window_group);

        this._signals.connect(this._shell, 'notify::hover', () => {
            if (this._destroying || !this._shell)
                return;
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
                    this._transientView?.animateDismiss?.(() => {
                        this._priority.dismissTransient(model.transient?.id);
                    }) || this._priority.dismissTransient(model.transient?.id);
                    return Clutter.EVENT_STOP;
                }
                if (btn === Clutter.BUTTON_PRIMARY && typeof model.transient?.onActivate === 'function') {
                    model.transient.onActivate();
                    this._transientView?.animateDismiss?.(() => {
                        this._priority.dismissTransient(model.transient?.id);
                    }) || this._priority.dismissTransient(model.transient?.id);
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_STOP;
            }

            if (model.state === IslandState.IDLE_BAR ||
                model.state === IslandState.HOVER_PEEK ||
                model.state === IslandState.INTEGRATED_CLOCK) {
                if (btn === Clutter.BUTTON_PRIMARY) {
                    this._priority.expand();
                    return Clutter.EVENT_STOP;
                }
                if (model.state === IslandState.INTEGRATED_CLOCK &&
                    btn === Clutter.BUTTON_SECONDARY &&
                    this._mergedClockRightClickGnome) {
                    this._topBar?.toggleGnomeCalendar();
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
                model.state !== IslandState.INTEGRATED_CLOCK &&
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
        const syncFromPanelGeometry = () => {
            if (!this._destroying && this._topbarIntegrationMode === 'merged-pill') {
                this._topBar?.syncPanelGeometry?.();
                this._repositionCurrent();
            }
        };
        if (Main.panel) {
            this._signals.connect(Main.panel, 'style-changed', syncFromPanelGeometry);
            this._signals.connect(Main.panel, 'notify::height', syncFromPanelGeometry);
        }
        if (Main.panel?._leftBox)
            this._signals.connect(Main.panel._leftBox, 'notify::width', syncFromPanelGeometry);
        if (Main.panel?._rightBox)
            this._signals.connect(Main.panel._rightBox, 'notify::width', syncFromPanelGeometry);
        for (const areaKey of ['quickSettings', 'activities']) {
            const area = Main.panel?.statusArea?.[areaKey];
            const areaActor = area?.container ?? area;
            if (areaActor && typeof areaActor.connect === 'function') {
                this._signals.connect(areaActor, 'notify::height', syncFromPanelGeometry);
                this._signals.connect(areaActor, 'style-changed', syncFromPanelGeometry);
            }
        }
        this._signals.connect(Main.overview, 'showing', () => this._onEnvironmentChanged());
        this._signals.connect(Main.overview, 'shown', () => this._onEnvironmentChanged());
        this._signals.connect(Main.overview, 'hiding', () => this._onEnvironmentChanged());
        this._signals.connect(Main.overview, 'hidden', () => this._onEnvironmentChanged());
        this._signals.connect(Main.layoutManager, 'monitors-changed', () => this._onEnvironmentChanged());
        this._signals.connect(global.display, 'in-fullscreen-changed', () => this._onEnvironmentChanged());
        this._signals.connect(global.display, 'window-created', () => {
            if (!this._destroying && this._shell && this._priority.getModel()?.state !== IslandState.HIDDEN)
                this._ensureShellTopOrder();
        });
        this._signals.connect(global.display, 'notify::focus-window', () => {
            if (!this._destroying && this._shell && this._priority.getModel()?.state !== IslandState.HIDDEN)
                this._ensureShellTopOrder();
        });
        if (GObject.signal_lookup('restacked', global.display.constructor)) {
            this._signals.connect(global.display, 'restacked', () => {
                if (!this._destroying && this._shell && this._priority.getModel()?.state !== IslandState.HIDDEN)
                    this._ensureShellTopOrder();
            });
        }
        this._signals.connect(Main.sessionMode, 'updated', () => this._onEnvironmentChanged());
        this._signals.connect(global.window_manager, 'switch-workspace', () => this._onEnvironmentChanged());
        this._signals.connect(Main.uiGroup, 'child-added', (_g, actor) => {
            if (!this._destroying && this._shell && actor !== this._shell)
                this._ensureShellTopOrder();
        });
        this._signals.connect(Main.uiGroup, 'child-removed', (_g, actor) => {
            if (this._destroying || !this._shell)
                return;
            if (actor === this._shell) {
                this._destroying = true;
                return;
            }
            this._ensureShellTopOrder();
        });

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
        if (!this._shell || !this._shell.visible || this._shell.opacity === 0)
            return false;
        const [px, py] = this._shell.get_transformed_position();
        const [pw, ph] = this._shell.get_transformed_size();
        return ex >= px && ex <= (px + pw) && ey >= py && ey <= (py + ph);
    }

    _onShellCapturedEvent(event) {
        const model = this._priority.getModel();
        if (!model)
            return Clutter.EVENT_PROPAGATE;

        // Interactive pointer swipe / flick to dismiss transient notification banner
        if (model.state === IslandState.TRANSIENT_BANNER) {
            const type = event.type();
            if (!event.get_coords)
                return Clutter.EVENT_PROPAGATE;

            const [ex, ey] = event.get_coords();
            const inShell = this._isCoordsInShell(ex, ey);

            if (type === Clutter.EventType.BUTTON_PRESS || type === Clutter.EventType.TOUCH_BEGIN) {
                if (!inShell)
                    return Clutter.EVENT_PROPAGATE;
                const btn = event.get_button?.() ?? 1;
                if (btn !== Clutter.BUTTON_PRIMARY && type !== Clutter.EventType.TOUCH_BEGIN)
                    return Clutter.EVENT_PROPAGATE;

                let src = global.stage?.get_event_actor?.(event) ?? event.get_source?.();
                let isInteractive = false;
                while (src && src !== this._shell) {
                    if (src instanceof St.Button || src instanceof St.Entry ||
                        src.has_style_class_name?.('bayisland-level-track') ||
                        src.has_style_class_name?.('bayisland-level-fill')) {
                        isInteractive = true;
                        break;
                    }
                    src = src.get_parent?.();
                }
                if (isInteractive)
                    return Clutter.EVENT_PROPAGATE;

                this._transientDrag = {
                    startX: ex,
                    startY: ey,
                    isDragging: false,
                    lastDx: 0,
                    lastDy: 0,
                };
                return Clutter.EVENT_PROPAGATE;
            }

            if (type === Clutter.EventType.MOTION) {
                if (!this._transientDrag)
                    return Clutter.EVENT_PROPAGATE;

                const dx = ex - this._transientDrag.startX;
                const dy = ey - this._transientDrag.startY;
                this._transientDrag.lastDx = dx;
                this._transientDrag.lastDy = dy;

                if (!this._transientDrag.isDragging) {
                    if (dx > 8 || dx < -14 || dy < -8 || dy > 14)
                        this._transientDrag.isDragging = true;
                }

                if (this._transientDrag.isDragging) {
                    this._transientView?.setSwipeOffset?.(dx, dy);
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            }

            if (type === Clutter.EventType.BUTTON_RELEASE || type === Clutter.EventType.TOUCH_END) {
                if (!this._transientDrag)
                    return Clutter.EVENT_PROPAGATE;

                const drag = this._transientDrag;
                this._transientDrag = null;

                if (drag.isDragging) {
                    const dx = drag.lastDx;
                    const dy = drag.lastDy;
                    if (dx > 60 || dy < -30) {
                        this._transientView?.animateDismiss?.(() => {
                            this._priority.dismissTransient(model.transient?.id);
                        }, dx, dy) || this._priority.dismissTransient(model.transient?.id);
                    } else {
                        this._transientView?.resetSwipe?.(true);
                    }
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            }

            return Clutter.EVENT_PROPAGATE;
        }

        if (model.state !== IslandState.EXPANDED_MODAL || model.tab !== 'shelf')
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
            if (this._destroying || !this._shell)
                return;
            if (!this._focusWindowId) {
                this._focusWindowId = global.display.connect('notify::focus-window', () => {
                    if (this._destroying || this._priority.getModel()?.state !== IslandState.EXPANDED_MODAL)
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
            if (this._grabHelper?.grabbed) {
                try {
                    this._grabHelper.ungrab({ isUser: false });
                } catch {
                    // Already ungrabbed/disposed
                }
            }
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

    setAppearance({
        pillStyle,
        collisionMode,
        topbarIntegrationMode,
        mergedClockRightClickGnome,
        topMargin,
        idleHoverDwellMs,
    }) {
        if (this._destroying || !this._shell)
            return;
        if (pillStyle !== undefined)
            this._pillStyle = pillStyle;
        if (collisionMode !== undefined)
            this._collisionMode = collisionMode;
        if (topbarIntegrationMode !== undefined)
            this._topbarIntegrationMode = topbarIntegrationMode === 'separate' ? 'separate' : 'merged-pill';
        if (mergedClockRightClickGnome !== undefined)
            this._mergedClockRightClickGnome = Boolean(mergedClockRightClickGnome);
        if (topMargin !== undefined)
            this._topMargin = topMargin;
        if (idleHoverDwellMs !== undefined)
            this._idleHoverDwellMs = Math.max(50, Math.min(600, Math.round(idleHoverDwellMs)));

        const model = this._priority.getModel();
        this._syncTopBarSlotMetrics(model);
        this._applyShellStyleClasses(model.state, model);
        this._repositionCurrent();
    }

    setPalette(palette) {
        if (isSamePalette(this._palette, palette))
            return;
        this._palette = palette;
        if (this._destroying || !this._shell)
            return;

        const model = this._priority.getModel();
        this._applyInlineTheme(this._lastState, model);
        if (model.state === IslandState.IDLE_BAR && this._compactView?._idleUnreadDot) {
            const dotCss = palette?.accentOnDarkCss ?? palette?.accentCss;
            if (dotCss)
                this._compactView._idleUnreadDot.style = `background-color: ${dotCss};`;
            return;
        }
        this.renderModel(model, false);
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
                this._contentBin.setLockedSize({ width, height });
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

    _isInOverview() {
        return Boolean(
            Main.overview?.visibleTarget ||
            Main.overview?.visible ||
            Main.panel?.has_style_pseudo_class?.('overview')
        );
    }

    _isPanelVisiblyBlockingTop() {
        if (this._topBar)
            return this._topBar.isPanelVisiblyShowing();
        const monitor = Main.layoutManager.primaryMonitor;
        const panelBox = Main.layoutManager.panelBox;
        if (!monitor || !panelBox || this._disposedActors.has(panelBox) || !panelBox.visible)
            return false;

        const panelY = panelBox.y + (panelBox.translation_y ?? 0);
        const panelBottom = panelY + panelBox.height;
        return panelBottom > monitor.y + 4;
    }

    _getPanelSlotMetrics() {
        if (this._topBar)
            return this._topBar.getPanelMetrics();
        const monitor = Main.layoutManager.primaryMonitor ?? { x: 0, y: 0, width: 1280, height: 800 };
        const panelBox = Main.layoutManager.panelBox;
        const panelVisible = this._isPanelVisiblyBlockingTop();
        const panelBoxY = panelBox ? Math.round(panelBox.y + (panelBox.translation_y ?? 0)) : monitor.y;
        const panelHeight = panelBox ? Math.max(24, Math.round(panelBox.height)) : 28;
        return {
            monitor,
            panelVisible,
            panelBoxY,
            panelHeight,
            innerY: panelBoxY,
            innerHeight: panelHeight,
            slotPillHeight: Math.max(24, Math.min(32, panelHeight - 4)),
            panelBottom: panelBoxY + panelHeight,
            corridorLeft: monitor.x + 8,
            corridorRight: monitor.x + monitor.width - 8,
            maxCenteredWidth: Math.min(360, monitor.width - 64),
        };
    }

    _isIntegratedPanelState(model, width = null) {
        if (!model || this._topbarIntegrationMode !== 'merged-pill')
            return false;
        if (!this._isPanelVisiblyBlockingTop())
            return false;
        if (model.state === IslandState.INTEGRATED_CLOCK)
            return true;
        if (model.state === IslandState.AMBIENT_DOT ||
            model.state === IslandState.COMPACT_PILL ||
            model.state === IslandState.SPLIT_PILL) {
            const metrics = this._getPanelSlotMetrics();
            const checkW = width ?? 240;
            return checkW <= metrics.maxCenteredWidth;
        }
        return false;
    }

    _syncTopBarSlotMetrics(model = this._priority?.getModel(), knownWidth = null) {
        const metrics = this._getPanelSlotMetrics();
        const pillH = metrics.slotPillHeight ?? Math.max(24, Math.min(32, metrics.panelHeight - 4));
        const inSlot = this._isIntegratedPanelState(model, knownWidth);
        const metricsChanged = this._compactView.setIntegratedMetrics({
            height: pillH,
            maxWidth: metrics.maxCenteredWidth,
            inSlot,
        });
        this._splitView.setIntegratedMetrics({
            height: pillH,
            maxWidth: metrics.maxCenteredWidth,
            inSlot,
        });

        let reserveW = Math.min(metrics.maxCenteredWidth, 226);
        if (inSlot && Number.isFinite(knownWidth) && knownWidth > 0)
            reserveW = Math.min(metrics.maxCenteredWidth, knownWidth);
        else if (inSlot && model?.state === IslandState.INTEGRATED_CLOCK)
            reserveW = this._compactView.getPreferredSize(model).width;
        else if (inSlot && model?.state === IslandState.SPLIT_PILL)
            reserveW = this._splitView.getPreferredSize().width;
        else if (inSlot && (model?.state === IslandState.COMPACT_PILL || model?.state === IslandState.AMBIENT_DOT))
            reserveW = this._compactView.getPreferredSize(model).width;

        this._topBar?.setSlotReservation({
            active: Boolean(model && model.state !== IslandState.HIDDEN),
            width: reserveW,
        });
        return metricsChanged;
    }

    _syncEnvironment() {
        if (this._destroying)
            return false;
        const monitor = Main.layoutManager.primaryMonitor;
        return this._priority.setEnvironment({
            panelVisible: this._isPanelVisiblyBlockingTop(),
            inFullscreen: Boolean(monitor?.inFullscreen),
        });
    }

    _onEnvironmentChanged() {
        if (this._destroying || !this._shell)
            return;
        this._syncEnvironment();
        this._topBar?.syncPanelGeometry();
        this._repositionCurrent();
        if (this._priority.getModel()?.state !== IslandState.HIDDEN)
            this._ensureShellTopOrder();
    }

    _syncIdleHitboxMetrics(model = this._priority?.getModel()) {
        const panelVisible = this._isPanelVisiblyBlockingTop();
        const isEdgeFlush =
            (model?.state === IslandState.IDLE_BAR || model?.state === IslandState.HOVER_PEEK) &&
            !panelVisible &&
            this._pillStyle === 'floating';

        if (isEdgeFlush) {
            this._compactView.setIdleHitbox({
                topPad: this._topMargin,
                hitHeight: Math.max(20, this._topMargin + 16),
                alignStart: true,
                edgeFlush: true,
            });
        } else {
            this._compactView.setIdleHitbox({
                topPad: 4,
                hitHeight: 18,
                alignStart: false,
                edgeFlush: false,
            });
        }
        return isEdgeFlush;
    }

    _computeCoords(width, model = this._priority?.getModel(), itemHeight = null) {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return { x: 0, y: 0 };

        const metrics = this._getPanelSlotMetrics();
        const panelVisible = metrics.panelVisible;

        if (this._isIntegratedPanelState(model, width)) {
            const fallbackH = metrics.slotPillHeight ?? Math.max(24, Math.min(32, metrics.panelHeight - 4));
            const innerY = metrics.innerY ?? metrics.panelBoxY;
            const innerH = metrics.innerHeight ?? metrics.panelHeight;
            const pillH = Number.isFinite(itemHeight) && itemHeight > 0
                ? Math.min(innerH, Math.round(itemHeight))
                : fallbackH;
            let ix = metrics.monitor.x + Math.round((metrics.monitor.width - width) / 2);
            if (width <= (metrics.corridorRight - metrics.corridorLeft))
                ix = Math.max(metrics.corridorLeft, Math.min(metrics.corridorRight - width, ix));
            const iy = Math.max(
                metrics.monitor.y + 1,
                Math.round(innerY + (innerH - pillH) / 2)
            );
            return { x: ix, y: iy };
        }

        const x = monitor.x + Math.round((monitor.width - width) / 2);

        if ((model?.state === IslandState.IDLE_BAR || model?.state === IslandState.HOVER_PEEK) &&
            !panelVisible &&
            this._pillStyle === 'floating') {
            return { x, y: monitor.y };
        }

        const baseTopY = monitor.y + (this._pillStyle === 'notch' ? 0 : this._topMargin);
        let y;
        if (panelVisible && (this._collisionMode === 'drop-below' || this._topbarIntegrationMode === 'merged-pill')) {
            y = Math.round(Math.max(baseTopY, metrics.panelBottom + Math.max(4, this._topMargin)));
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
        if (this._destroying || !this._shell || !this._morph || this._inRenderModel)
            return;
        const model = this._priority.getModel();
        if (!model || model.state === IslandState.HIDDEN || this._deferredExpandedCleanup || this._morph.isCollapsing())
            return;

        this._syncIdleHitboxMetrics(model);
        const metricsChanged = this._syncTopBarSlotMetrics(model);
        const { width, height } = this._getTargetSize(model);
        const inPanelSlot = this._isIntegratedPanelState(model, width);
        const inOverview = this._isInOverview();
        const sizeChanged =
            Math.abs((this._targetWidth ?? 0) - width) > 0.5 ||
            Math.abs((this._targetHeight ?? 0) - height) > 0.5;
        const slotChanged = inPanelSlot !== this._lastInPanelSlot;
        const overviewChanged = inOverview !== this._lastInOverview;

        if (metricsChanged || sizeChanged || slotChanged || overviewChanged) {
            this.renderModel(model, true);
            return;
        }

        this._syncTopBarSlotMetrics(model, width);
        this._applyShellStyleClasses(model.state, model, width);
        const coords = this._computeCoords(width, model, height);
        const panelBox = Main.layoutManager.panelBox;
        const panelTransition = (panelBox && !this._disposedActors.has(panelBox))
            ? (panelBox.get_transition('y') || panelBox.get_transition('translation-y'))
            : null;
        if (panelTransition)
            this._morph.snapPosition(coords);
        else
            this._morph.glidePosition(coords);

        if (this._morph.isVisible() && this._shell && !this._shell.visible)
            this._shell.show();

        const bridgeRect = this._wantsBridgePassthrough(model)
            ? this._computeBridgeRect(model, coords.x, coords.y, width, height)
            : null;
        this._bridgeRect = bridgeRect;
        this._cb.onSyncShelfBridge?.(model, bridgeRect);
    }

    _getTargetSize(model) {
        switch (model.state) {
        case IslandState.IDLE_BAR:
        case IslandState.INTEGRATED_CLOCK:
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
            return { width: 172, height: 22 };
        }
    }

    _shouldLockViewport(state) {
        return state === IslandState.EXPANDED_MODAL ||
            state === IslandState.TRANSIENT_BANNER;
    }

    _isDarkVisibleState(state) {
        return state === IslandState.EXPANDED_MODAL ||
            state === IslandState.TRANSIENT_BANNER ||
            state === IslandState.DROP_CATCH ||
            state === IslandState.INTEGRATED_CLOCK ||
            state === IslandState.HOVER_PEEK ||
            state === IslandState.COMPACT_PILL ||
            state === IslandState.SPLIT_PILL ||
            state === IslandState.AMBIENT_DOT;
    }

    _cleanupDeferredExpandedTab() {
        if (!this._deferredExpandedCleanup)
            return;
        this._deferredExpandedCleanup = false;
        this._expandedView?.destroyCurrentTab();
    }

    _isShellTopOrderOk() {
        if (this._destroying || !this._shell ||
            this._disposedActors.has(this._shell) ||
            this._disposedActors.has(Main.uiGroup))
            return false;
        const parent = this._shell.get_parent?.();
        if (!parent || parent !== Main.uiGroup)
            return false;
        const children = parent.get_children();
        const myIdx = children.indexOf(this._shell);
        if (myIdx === -1)
            return false;

        const blockers = [
            global.window_group,
            global.top_window_group,
            Main.layoutManager.panelBox,
            Main.layoutManager.overviewGroup,
        ];
        let floorIdx = -1;
        for (const actor of blockers) {
            if (actor && !this._disposedActors.has(actor)) {
                const idx = children.indexOf(actor);
                if (idx > floorIdx)
                    floorIdx = idx;
            }
        }
        if (myIdx <= floorIdx)
            return false;

        const modalGroup = Main.layoutManager.modalDialogGroup;
        if (modalGroup && !this._disposedActors.has(modalGroup)) {
            const modalIdx = children.indexOf(modalGroup);
            if (modalIdx > floorIdx && myIdx > modalIdx)
                return false;
        }
        return true;
    }

    _ensureShellTopOrder() {
        if (this._restacking || this._destroying || !this._shell ||
            this._disposedActors.has(this._shell) ||
            this._disposedActors.has(Main.uiGroup))
            return;
        if (!this._shell.get_stage?.())
            return;
        const parent = this._shell.get_parent?.();
        if (!parent || parent !== Main.uiGroup)
            return;
        if (this._isShellTopOrderOk())
            return;

        this._restacking = true;
        try {
            const children = parent.get_children();
            const blockers = [
                global.window_group,
                global.top_window_group,
                Main.layoutManager.panelBox,
                Main.layoutManager.overviewGroup,
            ];
            let floorIdx = -1;
            for (const actor of blockers) {
                if (actor && !this._disposedActors.has(actor)) {
                    const idx = children.indexOf(actor);
                    if (idx > floorIdx)
                        floorIdx = idx;
                }
            }

            const modalGroup = Main.layoutManager.modalDialogGroup;
            const modalIdx = (modalGroup && !this._disposedActors.has(modalGroup))
                ? children.indexOf(modalGroup)
                : -1;

            if (modalIdx > floorIdx)
                parent.set_child_below_sibling(this._shell, modalGroup);
            else
                parent.set_child_above_sibling(this._shell, null);
        } finally {
            this._restacking = false;
        }
    }

    _isEdgeFlushState(state) {
        return (state === IslandState.IDLE_BAR || state === IslandState.HOVER_PEEK) &&
            !this._isPanelVisiblyBlockingTop() &&
            this._pillStyle === 'floating';
    }

    _applyShellStyleClasses(state, model, knownWidth = null) {
        const classes = ['bayisland-shell'];
        const panelVisible = this._isPanelVisiblyBlockingTop();
        const inPanelSlot = this._isIntegratedPanelState(model, knownWidth);
        const inOverview = this._isInOverview();

        if (state === IslandState.IDLE_BAR)
            classes.push('bayisland-idle-bar');
        else if (inPanelSlot) {
            const flatIntegrated = inOverview
                ? (this._palette?.integratedOverviewFlat ?? true)
                : (this._palette?.integratedFlat ?? true);
            classes.push('bayisland-integrated-clock');
            if (model?.hovered)
                classes.push('bayisland-integrated-clock-hover');
            if (flatIntegrated)
                classes.push('bayisland-integrated-flat');
        } else if (state === IslandState.HOVER_PEEK)
            classes.push(this._isEdgeFlushState(state) ? 'bayisland-hover-peek-edge' : 'bayisland-hover-peek');
        else if (state === IslandState.DROP_CATCH) {
            classes.push('bayisland-dropcatch');
            if (model.meta?.dragHighlight)
                classes.push('bayisland-dropcatch-glow');
        }

        if (this._pillStyle === 'notch' &&
            !inPanelSlot &&
            state !== IslandState.IDLE_BAR &&
            !(panelVisible && (this._collisionMode === 'drop-below' || this._topbarIntegrationMode === 'merged-pill')))
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
        this._applyInlineTheme(state, model, inPanelSlot, inOverview);
    }

    _applyInlineTheme(state = this._lastState, model = this._priority?.getModel(), inPanelSlot = null, inOverview = null) {
        let nextStyle = null;
        const transparentShell =
            state === IslandState.IDLE_BAR ||
            (state === IslandState.HOVER_PEEK && this._isEdgeFlushState(state));
        if (!transparentShell && this._palette) {
            const isIntegrated = inPanelSlot ?? this._isIntegratedPanelState(model);
            if (state === IslandState.DROP_CATCH && model?.meta?.dragHighlight) {
                nextStyle = `background-color: ${this._palette.accentCss}; color: ${this._palette.accentFgCss};`;
            } else if (isIntegrated) {
                const overviewActive = inOverview ?? this._isInOverview();
                const bgCss = overviewActive
                    ? (model?.hovered
                        ? (this._palette.integratedOverviewHoverBgCss || this._palette.integratedHoverBgCss || this._palette.pillBgCss)
                        : (this._palette.integratedOverviewBgCss || this._palette.integratedBgCss || this._palette.pillBgCss))
                    : (model?.hovered
                        ? (this._palette.integratedHoverBgCss || this._palette.pillBgCss)
                        : (this._palette.integratedBgCss || this._palette.pillBgCss));
                const borderCss = overviewActive
                    ? (this._palette.integratedOverviewBorderCss ?? 'none')
                    : (this._palette.integratedBorderCss || '1px solid rgba(255, 255, 255, 0.10)');
                const glowCss = overviewActive
                    ? this._palette.integratedOverviewGlowCss
                    : this._palette.integratedGlowCss;
                const radCss = Number.isFinite(this._palette.integratedRadiusPx)
                    ? ` border-radius: ${this._palette.integratedRadiusPx}px;`
                    : '';
                const shadowCss = glowCss ? ` box-shadow: ${glowCss} !important;` : '';
                nextStyle = `background-color: ${bgCss}; border: ${borderCss};${radCss}${shadowCss}`;
            } else {
                nextStyle = `background-color: ${this._palette.pillBgCss};`;
            }
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
        if (this._destroying || !this._shell || !this._contentBin || !this._morph || this._inRenderModel)
            return;
        if (inPlaceOnly && this._morph.isCollapsing() && model.state === IslandState.IDLE_BAR)
            return;

        this._inRenderModel = true;
        try {
            const prevState = this._lastState;
            this._lastState = model.state;
            this._lastInOverview = this._isInOverview();

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
                this._lastInPanelSlot = false;
                this._targetWidth = 172;
                this._targetHeight = 22;
                this._topBar?.setPanelHold(false);
                this._topBar?.setSlotReservation({ active: false });
                this._cleanupDeferredExpandedTab();
                this._morph.setEqualizerPlaying(false);
                this._expandedView.destroyCurrentTab();
                const coords = this._computeCoords(172, model);
                this._morph.morphTo({
                    x: coords.x,
                    y: coords.y,
                    width: 172,
                    height: 22,
                    visible: false,
                    isExpanding: false,
                    inPlaceOnly: false,
                    onHidden: () => {
                        this._contentBin.setChild(null, null);
                        this._setUnredirectDisabled(false);
                    },
                });
                return;
            }

            // Keep stage composited while BayIsland (even IDLE_BAR) is shown so
            // Mutter never skips painting the island over maximized/fullscreen apps,
            // and re-assert chrome stacking above fullscreen/top windows.
            this._setUnredirectDisabled(true);
            this._ensureShellTopOrder();
            this._syncIdleHitboxMetrics(model);
            this._syncTopBarSlotMetrics(model);
            this._topBar?.setPanelHold(model.state === IslandState.EXPANDED_MODAL);

            // Smooth two-phase collapse when returning from any dark surface -> IDLE_BAR
            if (model.state === IslandState.IDLE_BAR &&
                this._isDarkVisibleState(prevState) &&
                this._morph.isVisible() &&
                this._shell.visible &&
                !inPlaceOnly) {
                this._deferredExpandedCleanup = prevState === IslandState.EXPANDED_MODAL;

                const idleSize = this._getTargetSize(model);
                const targetCoords = this._computeCoords(idleSize.width, model);
                const targetRect = {
                    x: targetCoords.x,
                    y: targetCoords.y,
                    width: idleSize.width,
                    height: idleSize.height,
                };
                this._lastInPanelSlot = false;
                this._targetWidth = idleSize.width;
                this._targetHeight = idleSize.height;

                const monitor = Main.layoutManager.primaryMonitor ?? { x: 0, y: 0, width: 1280 };
                if (prevState === IslandState.HOVER_PEEK && this._shell.y <= monitor.y + 1 && this._shell.height > 40) {
                    this._compactView.stripEdgePadding();
                    this._shell.set_position(this._shell.x, monitor.y + this._topMargin);
                    this._shell.set_size(this._shell.width, 40);
                }

                const shrinkW = 132;
                const shrinkH = 12;
                const panelVisible = this._isPanelVisiblyBlockingTop();
                const isEdgeFlushIdle = !panelVisible && this._pillStyle === 'floating';
                const shrinkX = monitor.x + Math.round((monitor.width - shrinkW) / 2);
                const shrinkY = isEdgeFlushIdle
                    ? monitor.y + Math.max(2, this._topMargin - 2)
                    : Math.round(targetRect.y + (targetRect.height - shrinkH) / 2);

                const collapsingClass = 'bayisland-shell bayisland-collapsing';
                if (this._lastStyleClass !== collapsingClass) {
                    this._lastStyleClass = collapsingClass;
                    this._shell.style_class = collapsingClass;
                }
                this._applyInlineTheme(prevState, model);

                this._morph.collapseToIdleBar({
                    shrinkRect: { x: shrinkX, y: shrinkY, width: shrinkW, height: shrinkH },
                    targetRect,
                    onMidSwap: () => {
                        this._cleanupDeferredExpandedTab();
                        if (this._destroying || !this._shell || !this._contentBin)
                            return;
                        if (this._priority.getModel()?.state !== IslandState.IDLE_BAR)
                            return;
                        this._syncIdleHitboxMetrics(model);
                        this._applyShellStyleClasses(model.state, model);
                        const idleChild = this._compactView.render(model, this._palette);
                        this._contentBin.setChild(idleChild, null);
                        this._morph.setEqualizerPlaying(false);
                        this._morph.registerEqBars([]);
                        this._ensureShellTopOrder();
                    },
                    onComplete: () => {
                        if (!this._destroying && this._shell)
                            this._repositionCurrent();
                    },
                });
                return;
            }

            this._cleanupDeferredExpandedTab();
            if (model.state !== IslandState.EXPANDED_MODAL)
                this._expandedView.destroyCurrentTab();

            this._applyShellStyleClasses(model.state, model);

            let updatedInPlace = false;
            if (inPlaceOnly && prevState === model.state) {
                if (model.state === IslandState.IDLE_BAR ||
                    model.state === IslandState.INTEGRATED_CLOCK ||
                    model.state === IslandState.HOVER_PEEK ||
                    model.state === IslandState.DROP_CATCH ||
                    model.state === IslandState.COMPACT_PILL ||
                    model.state === IslandState.AMBIENT_DOT)
                    updatedInPlace = this._compactView.updateInPlace(model);
                else if (model.state === IslandState.SPLIT_PILL)
                    updatedInPlace = this._splitView.updateInPlace(model);
                else if (model.state === IslandState.TRANSIENT_BANNER)
                    updatedInPlace = this._transientView.updateInPlace(model);
                else if (model.state === IslandState.EXPANDED_MODAL) {
                    if (this._expandedView.getCurrentTabId() !== model.tab)
                        updatedInPlace = this._expandedView.switchTab(model.tab, model, this._palette, this._snapshots);
                    else
                        updatedInPlace = this._expandedView.updateInPlace(model, this._snapshots);
                }
            }

            let builtChild = null;
            let eqBars = [];
            if (!updatedInPlace) {
                switch (model.state) {
                case IslandState.IDLE_BAR:
                case IslandState.INTEGRATED_CLOCK:
                case IslandState.HOVER_PEEK:
                case IslandState.DROP_CATCH:
                case IslandState.AMBIENT_DOT:
                case IslandState.COMPACT_PILL:
                    builtChild = this._compactView.render(model, this._palette);
                    eqBars = this._compactView.getEqBars();
                    break;
                case IslandState.SPLIT_PILL:
                    builtChild = this._splitView.render(model, this._palette);
                    eqBars = this._splitView.getEqBars();
                    break;
                case IslandState.TRANSIENT_BANNER:
                    builtChild = this._transientView.render(model, this._palette);
                    break;
                case IslandState.EXPANDED_MODAL:
                    builtChild = this._expandedView.render(model, this._palette, this._snapshots);
                    break;
                }
            }

            let size;
            if (!updatedInPlace) {
                if (model.state === IslandState.TRANSIENT_BANNER) {
                    const initW = this._transientView.estimateWidth(model);
                    this._contentBin.setChild(builtChild, { width: initW, height: 240 });
                    size = this._getTargetSize(model);
                    this._contentBin.setLockedSize(size);
                } else {
                    size = this._getTargetSize(model);
                    const lockedSize = this._shouldLockViewport(model.state) ? size : null;
                    this._contentBin.setChild(builtChild, lockedSize);
                }
                this._morph.registerEqBars(eqBars);
            } else {
                size = this._getTargetSize(model);
                const lockedSize = this._shouldLockViewport(model.state) ? size : null;
                this._contentBin.setLockedSize(lockedSize);
            }

            const { width, height } = size;
            this._targetWidth = width;
            this._targetHeight = height;
            this._lastInPanelSlot = this._isIntegratedPanelState(model, width);
            this._syncTopBarSlotMetrics(model, width);
            this._applyShellStyleClasses(model.state, model, width);

            const mediaPlaying =
                model.persistent?.media?.active &&
                model.persistent?.media?.status === 'Playing' &&
                (model.state === IslandState.COMPACT_PILL || model.state === IslandState.SPLIT_PILL);
            this._morph.setEqualizerPlaying(mediaPlaying);

            const { x, y } = this._computeCoords(width, model, height);
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

            let fadeDelayMs = 0;
            let fadeDurationMs = 135;
            if (model.state === IslandState.EXPANDED_MODAL) {
                fadeDelayMs = prevState === IslandState.EXPANDED_MODAL ? 0 : 95;
                fadeDurationMs = prevState === IslandState.EXPANDED_MODAL ? 125 : 155;
            } else if (model.state === IslandState.TRANSIENT_BANNER) {
                fadeDelayMs = prevState === IslandState.TRANSIENT_BANNER ? 15 : 40;
                fadeDurationMs = 145;
            }

            this._morph.morphTo({
                x,
                y,
                width,
                height,
                visible: true,
                isExpanding,
                inPlaceOnly: updatedInPlace,
                fadeDelayMs,
                fadeDurationMs,
                onSettled: passthrough
                    ? () => {
                        const cur = this._priority.getModel();
                        if (this._wantsBridgePassthrough(cur) && this._bridgeRect)
                            this._cb.onSyncShelfBridge?.(cur, this._bridgeRect);
                    }
                    : undefined,
            });
        } finally {
            this._inRenderModel = false;
        }
    }

    destroy() {
        this._destroying = true;
        this._transientDrag = null;
        this._topBar?.setPanelHold(false);
        this._topBar?.setSlotReservation({ active: false });
        this._clearHoverTimers();
        this._clearResumeSafetyTimer();
        this._syncExpandedModal(false);
        this._setUnredirectDisabled(false);
        this._cb.onSyncShelfBridge?.({ state: IslandState.HIDDEN }, null);
        this._morph?.destroy();
        this._cleanupDeferredExpandedTab();
        this._expandedView?.destroy();

        const shell = this._shell;
        this._shell = null;
        this._contentBin = null;
        this._grabHelper = null;

        if (shell && !this._disposedActors.has(shell)) {
            try {
                Main.layoutManager.removeChrome(shell);
            } catch {
                // Already removed
            }

            try {
                shell.destroy();
            } catch {
                // Already disposed
            }
        }
    }
}
