import GLib from 'gi://GLib';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

export const IslandState = {
    HIDDEN: 'HIDDEN',
    IDLE_BAR: 'IDLE_BAR',
    INTEGRATED_CLOCK: 'INTEGRATED_CLOCK',
    HOVER_PEEK: 'HOVER_PEEK',
    DROP_CATCH: 'DROP_CATCH',
    AMBIENT_DOT: 'AMBIENT_DOT',
    COMPACT_PILL: 'COMPACT_PILL',
    SPLIT_PILL: 'SPLIT_PILL',
    TRANSIENT_BANNER: 'TRANSIENT_BANNER',
    EXPANDED_MODAL: 'EXPANDED_MODAL',
};

export const DEFAULT_TAB_ORDER = ['home', 'media', 'power', 'clipboard', 'shelf'];
export const HubTabs = DEFAULT_TAB_ORDER;

export const TAB_DEFS = {
    home: {
        id: 'home',
        label: 'Home',
        icon: 'go-home-symbolic',
        description: 'Clock, calendar, quick actions, focus timer, and notifications',
    },
    media: {
        id: 'media',
        label: 'Media',
        icon: 'audio-x-generic-symbolic',
        description: 'Universal MPRIS controls, player switcher, and audio output',
    },
    power: {
        id: 'power',
        label: 'Power',
        icon: 'battery-good-symbolic',
        description: 'Ubuntu power modes, battery telemetry, and thermal sensors',
    },
    clipboard: {
        id: 'clipboard',
        label: 'Clip',
        icon: 'edit-paste-symbolic',
        description: 'Clipboard history, pinned snippets, search, and paste',
    },
    shelf: {
        id: 'shelf',
        label: 'Shelf',
        icon: 'folder-download-symbolic',
        description: 'Drag & drop temporary file shelf and auto-stashed screenshots',
    },
};

export const Weights = {
    IDLE: 0,
    MEDIA: 30,
    TIMER: 40,
    PRIVACY: 45,
    POWER: 55,
    RESOURCE: 60,
    TASK: 65,
    NOTIFICATION: 75,
    OSD: 85,
    ALARM: 100,
};

export function normalizeTab(tab) {
    if (!tab)
        return null;
    if (tab === 'timer' || tab === 'notif' || tab === 'notifications')
        return 'home';
    if (tab === 'status')
        return 'power';
    return DEFAULT_TAB_ORDER.includes(tab) ? tab : 'home';
}

export function normalizeTabOrder(rawOrder) {
    const out = [];
    if (Array.isArray(rawOrder)) {
        for (const item of rawOrder) {
            if (typeof item !== 'string')
                continue;
            const id = item === 'status' ? 'power' : item;
            if (DEFAULT_TAB_ORDER.includes(id) && !out.includes(id))
                out.push(id);
        }
    }
    for (const defId of DEFAULT_TAB_ORDER) {
        if (!out.includes(defId))
            out.push(defId);
    }
    return out;
}

/**
 * Priority-driven state arbiter with preemption stack, transient coalescing,
 * idle grab handle + hover-peek, drop-catch reveal, and in-place updates.
 */
export class PriorityManager extends Signals.EventEmitter {
    constructor(timers) {
        super();
        this._timers = timers;
        this._nextId = 1;

        this._persistent = {
            media: { active: false },
            timer: { active: false },
            privacy: { active: false, camera: false, mic: false, micMuted: false },
        };

        this._meta = {
            unreadNotifs: 0,
            shelfCount: 0,
            clipCount: 0,
            clipPaused: false,
            powerPct: 0,
            onBattery: false,
            charging: false,
            powerProfile: 'balanced',
            dnd: false,
            dragHighlight: false,
            clockText: '',
            dateText: '',
        };

        this._transient = null;
        this._transientTimerId = 0;
        this._transientRemainingMs = 0;
        this._transientStartedUs = 0;

        this._expanded = {
            active: false,
            tab: 'home',
        };

        this._hovered = false;
        this._hoverPeek = false;
        this._dragCatch = false;

        this._options = {
            showIdlePill: false,
            idleHandleEnabled: true,
            idleHoverPeek: true,
            hideInFullscreen: false,
            topbarCollisionMode: 'drop-below',
            topbarIntegrationMode: 'merged-pill',
            mergedPillPreset: 'hover-pill',
            expandedDefaultTab: 'auto',
            tabOrder: [...DEFAULT_TAB_ORDER],
        };
        this._environment = {
            panelVisible: false,
            inFullscreen: false,
        };
        this._debugProvider = null;

        this._currentModel = this._computeModel();
    }

    setDebugProvider(fn) {
        this._debugProvider = typeof fn === 'function' ? fn : null;
    }

    getDebugInfo() {
        const extra = this._debugProvider ? (this._debugProvider() ?? {}) : {};
        return {
            panelVisible: this._environment.panelVisible,
            inFullscreen: this._environment.inFullscreen,
            ...extra,
        };
    }

    setOptions(opts) {
        const next = { ...opts };
        if (next.tabOrder !== undefined)
            next.tabOrder = normalizeTabOrder(next.tabOrder);
        if (next.expandedDefaultTab !== undefined && next.expandedDefaultTab !== 'auto')
            next.expandedDefaultTab = normalizeTab(next.expandedDefaultTab) ?? 'home';
        if (next.topbarIntegrationMode !== undefined)
            next.topbarIntegrationMode = next.topbarIntegrationMode === 'separate' ? 'separate' : 'merged-pill';
        if (next.mergedPillPreset !== undefined) {
            next.mergedPillPreset = ['hover-pill', 'minimal-clock', 'handle-clock'].includes(next.mergedPillPreset)
                ? next.mergedPillPreset
                : 'hover-pill';
        }
        Object.assign(this._options, next);
        if (!this._options.idleHandleEnabled)
            this._hoverPeek = false;
        this._expanded.tab = normalizeTab(this._expanded.tab) ?? 'home';
        this._reconcile(false);
    }

    setEnvironment(env) {
        const nextPanelVisible = env.panelVisible !== undefined
            ? Boolean(env.panelVisible)
            : this._environment.panelVisible;
        const nextInFullscreen = env.inFullscreen !== undefined
            ? Boolean(env.inFullscreen)
            : this._environment.inFullscreen;

        if (nextPanelVisible === this._environment.panelVisible &&
            nextInFullscreen === this._environment.inFullscreen)
            return false;

        this._environment.panelVisible = nextPanelVisible;
        this._environment.inFullscreen = nextInFullscreen;
        this._reconcile(false);
        return true;
    }

    updateMeta(data, { inPlaceHint = true } = {}) {
        Object.assign(this._meta, data);
        this._reconcile(inPlaceHint);
    }

    updatePersistent(slot, data, { inPlaceHint = false } = {}) {
        const prev = this._persistent[slot] ?? {};
        const wasActive = Boolean(prev.active);
        this._persistent[slot] = { ...prev, ...data };
        const nowActive = Boolean(this._persistent[slot].active);

        if (this._expanded.active && !nowActive && this._expanded.tab === slot && slot !== 'media')
            this._expanded.tab = this._pickBestTab();

        const canUpdateInPlace = inPlaceHint && wasActive === nowActive &&
            this._currentModel.state !== IslandState.TRANSIENT_BANNER;
        this._reconcile(canUpdateInPlace);
    }

    pushTransient(payload) {
        const weight = payload.weight ?? Weights.NOTIFICATION;
        const durationMs = payload.durationMs ?? 2500;
        const sticky = Boolean(payload.sticky);

        if (this._transient && weight < this._transient.weight)
            return null;

        const sameCoalesce = Boolean(
            this._transient &&
            payload.coalesceKey &&
            this._transient.coalesceKey === payload.coalesceKey &&
            this._transient.kind === payload.kind
        );

        const id = sameCoalesce ? this._transient.id : this._nextId++;
        this._transient = {
            ...payload,
            id,
            weight,
            durationMs,
            sticky,
        };

        this._clearTransientTimer();
        if (!sticky && durationMs > 0) {
            this._transientRemainingMs = durationMs;
            if (!this._hovered)
                this._armTransientTimer(durationMs);
        } else {
            this._transientRemainingMs = 0;
        }

        if (this._expanded.active && weight >= Weights.OSD)
            this._expanded.active = false;

        this._reconcile(sameCoalesce);
        return id;
    }

    dismissTransient(id = null) {
        if (!this._transient)
            return;
        if (id !== null && this._transient.id !== id)
            return;

        const onDismiss = this._transient.onDismiss;
        this._clearTransientTimer();
        this._transient = null;
        this._transientRemainingMs = 0;
        this._reconcile(false);

        if (typeof onDismiss === 'function') {
            try {
                onDismiss();
            } catch (e) {
                logError(e, 'BayIsland transient onDismiss failed');
            }
        }
    }

    setHovered(hovered) {
        const nextHovered = Boolean(hovered);
        if (this._hovered === nextHovered)
            return;
        this._hovered = nextHovered;

        if (this._currentModel.state === IslandState.INTEGRATED_CLOCK) {
            const preset = this._options.mergedPillPreset;
            const structuralHover = (preset === 'minimal-clock' || preset === 'handle-clock') && this._options.idleHoverPeek;
            this._reconcile(!structuralHover);
        }

        if (!this._transient || this._transient.sticky)
            return;

        if (nextHovered) {
            if (this._transientTimerId) {
                const elapsedMs = Math.floor((GLib.get_monotonic_time() - this._transientStartedUs) / 1000);
                this._transientRemainingMs = Math.max(1200, this._transientRemainingMs - elapsedMs);
                this._clearTransientTimer();
            }
        } else if (this._transientRemainingMs > 0) {
            this._armTransientTimer(Math.max(1000, this._transientRemainingMs));
        }
    }

    setHoverPeek(active) {
        const want = Boolean(active && this._options.idleHandleEnabled && this._options.idleHoverPeek);
        if (want === this._hoverPeek)
            return;
        this._hoverPeek = want;
        this._reconcile(false);
    }

    setDragCatch(active, highlight = false) {
        const want = Boolean(active);
        const hi = Boolean(highlight);
        if (want === this._dragCatch && hi === this._meta.dragHighlight)
            return;
        this._dragCatch = want;
        this._meta.dragHighlight = hi;
        this._reconcile(want && this._currentModel.state === IslandState.DROP_CATCH);
    }

    expand(tab = null) {
        this._expanded.active = true;
        this._expanded.tab = normalizeTab(tab) ?? this._pickBestTab();
        this._hoverPeek = false;
        this._dragCatch = false;
        this._meta.dragHighlight = false;
        if (this._transient && !this._transient.sticky) {
            this._clearTransientTimer();
            this._transient = null;
        }
        this._reconcile(false);
    }

    collapse() {
        if (!this._expanded.active)
            return;
        this._expanded.active = false;
        this._dragCatch = false;
        this._meta.dragHighlight = false;
        this._reconcile(false);
    }

    toggleExpand(tab = null) {
        if (this._expanded.active) {
            const normalized = normalizeTab(tab);
            if (normalized && normalized !== this._expanded.tab)
                this.setExpandedTab(normalized);
            else
                this.collapse();
        } else {
            this.expand(tab);
        }
    }

    setExpandedTab(tab) {
        if (!this._expanded.active)
            return;
        const normalized = normalizeTab(tab) ?? 'home';
        if (normalized === this._expanded.tab)
            return;
        this._expanded.tab = normalized;
        // Full structural re-render for switching tabs
        this._reconcile(false);
    }

    getModel() {
        return this._currentModel;
    }

    getTabOrder() {
        return [...(this._options.tabOrder ?? DEFAULT_TAB_ORDER)];
    }

    getPersistent() {
        return this._persistent;
    }

    _pickBestTab() {
        const pref = this._options.expandedDefaultTab;
        if (pref && pref !== 'auto')
            return normalizeTab(pref) ?? 'home';
        if (this._persistent.media.active)
            return 'media';
        return 'home';
    }

    _armTransientTimer(ms) {
        this._clearTransientTimer();
        this._transientStartedUs = GLib.get_monotonic_time();
        this._transientRemainingMs = ms;
        const activeId = this._transient?.id;
        this._transientTimerId = this._timers.setTimeout(ms, () => {
            this._transientTimerId = 0;
            this.dismissTransient(activeId);
        });
    }

    _clearTransientTimer() {
        if (this._transientTimerId) {
            this._timers.clear(this._transientTimerId);
            this._transientTimerId = 0;
        }
    }

    _computeModel() {
        const { media, timer, privacy } = this._persistent;
        const {
            hideInFullscreen,
            showIdlePill,
            idleHandleEnabled,
            idleHoverPeek,
            topbarCollisionMode,
            topbarIntegrationMode,
            mergedPillPreset,
        } = this._options;
        const { panelVisible, inFullscreen } = this._environment;

        if (hideInFullscreen && inFullscreen) {
            return {
                state: IslandState.HIDDEN,
                reason: 'fullscreen',
                persistent: this._persistent,
                meta: this._meta,
                transient: null,
                expanded: this._expanded,
            };
        }

        if (this._expanded.active) {
            return {
                state: IslandState.EXPANDED_MODAL,
                tab: normalizeTab(this._expanded.tab) ?? 'home',
                tabOrder: this._options.tabOrder ?? [...DEFAULT_TAB_ORDER],
                persistent: this._persistent,
                meta: this._meta,
                transient: this._transient,
                expanded: this._expanded,
            };
        }

        if (this._dragCatch) {
            return {
                state: IslandState.DROP_CATCH,
                persistent: this._persistent,
                meta: this._meta,
            };
        }

        if (this._transient) {
            return {
                state: IslandState.TRANSIENT_BANNER,
                transient: this._transient,
                persistent: this._persistent,
                meta: this._meta,
                expanded: this._expanded,
            };
        }

        const hasMedia = Boolean(media.active);
        const hasTimer = Boolean(timer.active);
        const hasPrivacy = Boolean(privacy.active && (privacy.camera || privacy.mic));

        if (hasMedia && (hasTimer || hasPrivacy)) {
            return {
                state: IslandState.SPLIT_PILL,
                left: 'media',
                right: hasTimer ? 'timer' : 'privacy',
                persistent: this._persistent,
                meta: this._meta,
            };
        }

        if (hasTimer && hasPrivacy) {
            return {
                state: IslandState.SPLIT_PILL,
                left: 'timer',
                right: 'privacy',
                persistent: this._persistent,
                meta: this._meta,
            };
        }

        if (hasMedia) {
            return {
                state: IslandState.COMPACT_PILL,
                primary: 'media',
                persistent: this._persistent,
                meta: this._meta,
            };
        }

        if (hasTimer) {
            return {
                state: IslandState.COMPACT_PILL,
                primary: 'timer',
                persistent: this._persistent,
                meta: this._meta,
            };
        }

        if (hasPrivacy) {
            return {
                state: IslandState.AMBIENT_DOT,
                primary: 'privacy',
                persistent: this._persistent,
                meta: this._meta,
            };
        }

        if (topbarIntegrationMode === 'merged-pill' && panelVisible) {
            return {
                state: IslandState.INTEGRATED_CLOCK,
                primary: 'integrated-clock',
                preset: mergedPillPreset ?? 'hover-pill',
                hovered: this._hovered,
                expandOnHover: Boolean(idleHoverPeek),
                persistent: this._persistent,
                meta: this._meta,
            };
        }

        if (topbarCollisionMode === 'hide-idle' && panelVisible) {
            return {
                state: IslandState.HIDDEN,
                reason: 'panel-hide-idle',
                persistent: this._persistent,
                meta: this._meta,
            };
        }

        if (this._hoverPeek && idleHandleEnabled) {
            return {
                state: IslandState.HOVER_PEEK,
                primary: 'peek',
                persistent: this._persistent,
                meta: this._meta,
            };
        }

        if (idleHandleEnabled) {
            return {
                state: IslandState.IDLE_BAR,
                primary: 'idle-bar',
                persistent: this._persistent,
                meta: this._meta,
            };
        }

        if (showIdlePill) {
            return {
                state: IslandState.AMBIENT_DOT,
                primary: 'idle',
                persistent: this._persistent,
                meta: this._meta,
            };
        }

        return {
            state: IslandState.HIDDEN,
            reason: 'idle',
            persistent: this._persistent,
            meta: this._meta,
        };
    }

    _reconcile(inPlaceHint) {
        const prev = this._currentModel;
        const next = this._computeModel();
        this._currentModel = next;

        const orderA = Array.isArray(prev.tabOrder) ? prev.tabOrder.join(',') : '';
        const orderB = Array.isArray(next.tabOrder) ? next.tabOrder.join(',') : '';
        const hoverStructDiff =
            next.state === IslandState.INTEGRATED_CLOCK &&
            next.preset !== 'hover-pill' &&
            next.expandOnHover &&
            prev.hovered !== next.hovered;
        const sameStructure =
            inPlaceHint &&
            prev.state === next.state &&
            prev.primary === next.primary &&
            prev.preset === next.preset &&
            !hoverStructDiff &&
            prev.left === next.left &&
            prev.right === next.right &&
            prev.tab === next.tab &&
            orderA === orderB &&
            prev.transient?.id === next.transient?.id;

        this.emit('model-changed', {
            model: next,
            inPlaceOnly: sameStructure,
        });
    }

    destroy() {
        this._clearTransientTimer();
        this._transient = null;
        this._debugProvider = null;
    }
}
