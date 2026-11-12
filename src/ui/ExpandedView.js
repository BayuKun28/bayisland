import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { normalizeTabOrder, TAB_DEFS } from '../core/PriorityManager.js';
import { HomeTab } from './tabs/HomeTab.js';
import { PowerTab } from './tabs/PowerTab.js';
import { MediaTab } from './tabs/MediaTab.js';
import { ClipboardTab } from './tabs/ClipboardTab.js';
import { ShelfTab } from './tabs/ShelfTab.js';

function getStripClock() {
    return GLib.DateTime.new_now_local().format('%H:%M') || '00:00';
}

/**
 * Interactive 5-Tab Minimalist Obsidian Bento Hub (EXPANDED_MODAL):
 * Layer 1: Streamlined 36px Header Bar (Stationary Nav Pills + Conditional Status Badges + System Controls)
 * Layer 2: Domain-Grouped Adaptive-Height Bento Canvas
 */
export class ExpandedView {
    constructor(callbacks, timers) {
        this._cb = callbacks;
        this._timers = timers;

        this._root = null;
        this._bodyBin = null;
        this._currentTabId = null;
        this._activeTabInstance = null;
        this._lastPalette = null;

        this._stripClockLabel = null;
        this._lowBatBtn = null;
        this._incogBadge = null;
        this._tabButtons = {};
        this._tabBadges = {};

        this._homeTab = new HomeTab({ callbacks, timers });
        this._powerTab = new PowerTab({ callbacks });
        this._mediaTab = new MediaTab({ callbacks });
        this._clipboardTab = new ClipboardTab({ callbacks });
        this._shelfTab = new ShelfTab({ callbacks });
    }

    getPreferredSize(model = null, snapshots = null) {
        const monitor = Main.layoutManager.primaryMonitor ?? { width: 1280, height: 800 };
        const width = Math.min(730, Math.max(540, monitor.width - 32));
        const maxH = Math.max(300, monitor.height - 84);
        const tab = model?.tab || 'home';

        let targetH;
        switch (tab) {
        case 'media':
            targetH = 310;
            break;
        case 'power':
            targetH = 356;
            break;
        case 'clipboard':
            targetH = 392;
            break;
        case 'shelf': {
            const count = model?.meta?.shelfCount ?? snapshots?.shelf?.items?.length ?? 0;
            targetH = count === 0
                ? 310
                : Math.min(436, 186 + Math.min(5, count) * 52);
            break;
        }
        case 'home':
        default:
            targetH = 362;
            break;
        }

        return {
            width,
            height: Math.min(maxH, targetH),
        };
    }

    render(model, palette, snapshots) {
        this.destroyCurrentTab();

        const tab = model.tab || 'home';
        this._currentTabId = tab;
        this._lastPalette = palette ?? null;
        this._tabButtons = {};
        this._tabBadges = {};

        const snaps = snapshots ?? {};
        const meta = model.meta ?? {};
        const privacy = model.persistent?.privacy ?? {};
        const acc = palette?.accentCss || '#93c5fd';
        const fg = palette?.accentFgCss || '#090d16';
        const activeBadgeBg = fg === '#ffffff' ? 'rgba(255, 255, 255, 0.22)' : 'rgba(9, 13, 22, 0.16)';

        const root = new St.BoxLayout({
            style_class: 'bayisland-hub-root',
            vertical: true,
            x_expand: true,
            y_expand: true,
        });

        // 1. Streamlined 36px Unified Header Bar (keeps Shelf bridge headerOffset = 60)
        const headerBar = new St.BoxLayout({
            style_class: 'bayisland-hub-header',
            reactive: true,
            x_expand: true,
            height: 36,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const navRow = new St.BoxLayout({
            style_class: 'bayisland-hub-nav-row',
            reactive: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const shelfCount = meta.shelfCount ?? snaps.shelf?.items?.length ?? 0;
        const notifCount = meta.unreadNotifs ?? snaps.notifHistory?.totalUnread ?? 0;
        const tabOrder = normalizeTabOrder(model.tabOrder);

        for (const id of tabOrder) {
            const def = TAB_DEFS[id];
            if (!def)
                continue;

            const isActive = tab === id;
            const btn = new St.Button({
                style_class: `bayisland-hub-tab-btn${isActive ? ' bayisland-hub-tab-btn-active' : ''}`,
                ...(isActive ? { style: `background-color: ${acc}; color: ${fg};` } : {}),
                reactive: true,
                can_focus: false,
                y_align: Clutter.ActorAlign.CENTER,
            });
            const inner = new St.BoxLayout({
                style_class: 'bayisland-hub-tab-inner',
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            });
            inner.add_child(new St.Icon({
                icon_name: def.icon,
                icon_size: 13,
                y_align: Clutter.ActorAlign.CENTER,
                ...(isActive ? { style: `color: ${fg};` } : {}),
            }));
            inner.add_child(new St.Label({
                text: def.label,
                y_align: Clutter.ActorAlign.CENTER,
                ...(isActive ? { style: `color: ${fg}; font-weight: 700;` } : {}),
            }));

            if (id === 'home' || id === 'shelf') {
                const count = id === 'home' ? notifCount : shelfCount;
                const badge = new St.Label({
                    text: String(count),
                    style_class: 'bayisland-tab-count',
                    style: isActive
                        ? `background-color: ${activeBadgeBg}; color: ${fg};`
                        : `background-color: ${acc}; color: ${fg};`,
                    y_align: Clutter.ActorAlign.CENTER,
                    visible: count > 0,
                });
                inner.add_child(badge);
                this._tabBadges[id] = { label: badge, active: isActive };
            }

            btn.set_child(inner);
            btn.connect('clicked', () => this._cb.onSelectTab?.(id));
            this._tabButtons[id] = btn;
            navRow.add_child(btn);
        }
        headerBar.add_child(navRow);

        headerBar.add_child(new St.Widget({ x_expand: true }));

        const utilityRow = new St.BoxLayout({
            style_class: 'bayisland-hub-utility-row',
            y_align: Clutter.ActorAlign.CENTER,
        });

        if (privacy.camera || privacy.mic) {
            const pParts = [];
            if (privacy.camera)
                pParts.push('Cam');
            if (privacy.mic)
                pParts.push(privacy.micMuted ? 'Muted' : 'Mic');
            const privBtn = new St.Button({
                label: pParts.join('+'),
                style_class: 'bayisland-hub-mini-pill-btn bayisland-mini-pill-btn-warn',
                reactive: true,
                can_focus: false,
                y_align: Clutter.ActorAlign.CENTER,
            });
            privBtn.connect('clicked', () => {
                if (privacy.mic)
                    this._cb.onToggleMicMute?.();
            });
            utilityRow.add_child(privBtn);
        }

        this._incogBadge = new St.Label({
            text: 'Paused',
            style_class: 'bayisland-hub-mini-pill bayisland-mini-pill-btn-warn',
            y_align: Clutter.ActorAlign.CENTER,
            visible: Boolean(meta.clipPaused),
        });
        utilityRow.add_child(this._incogBadge);

        const powerPct = Math.round(meta.powerPct ?? snaps.power?.percentage ?? 0);
        const lowBat = Boolean(meta.onBattery && powerPct > 0 && powerPct <= 20);
        this._lowBatBtn = new St.Button({
            label: `${powerPct}%`,
            style_class: 'bayisland-hub-mini-pill-btn bayisland-hub-mini-danger',
            reactive: true,
            can_focus: false,
            y_align: Clutter.ActorAlign.CENTER,
            visible: lowBat,
        });
        this._lowBatBtn.connect('clicked', () => this._cb.onSelectTab?.('power'));
        utilityRow.add_child(this._lowBatBtn);

        this._stripClockLabel = new St.Label({
            text: getStripClock(),
            style_class: 'bayisland-hub-header-clock',
            y_align: Clutter.ActorAlign.CENTER,
        });
        utilityRow.add_child(this._stripClockLabel);

        const prefsBtn = new St.Button({
            style_class: 'bayisland-icon-btn',
            reactive: true,
            can_focus: false,
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({
                icon_name: 'preferences-system-symbolic',
                icon_size: 13,
            }),
        });
        prefsBtn.connect('clicked', () => this._cb.onOpenExtensionPrefs?.());
        utilityRow.add_child(prefsBtn);

        const closeBtn = new St.Button({
            style_class: 'bayisland-dismiss-btn',
            reactive: true,
            can_focus: false,
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({
                icon_name: 'pan-up-symbolic',
                icon_size: 14,
            }),
        });
        closeBtn.connect('clicked', () => this._cb.onCollapse?.());
        utilityRow.add_child(closeBtn);

        headerBar.add_child(utilityRow);
        root.add_child(headerBar);

        // 2. Content Body Bin (non-reactive so Shelf bridge drops/drags pass through cleanly)
        this._bodyBin = new St.Bin({
            x_expand: true,
            y_expand: true,
            reactive: false,
            clip_to_allocation: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.FILL,
        });

        this._mountActiveTab(tab, model, palette, snaps);
        root.add_child(this._bodyBin);

        this._root = root;
        root.connect('destroy', () => {
            if (this._root === root) {
                this._root = null;
                this._bodyBin = null;
                this._stripClockLabel = null;
                this._lowBatBtn = null;
                this._incogBadge = null;
                this._tabButtons = {};
                this._tabBadges = {};
                this._currentTabId = null;
            }
        });
        return root;
    }

    getCurrentTabId() {
        return this._currentTabId;
    }

    _mountActiveTab(tab, model, palette, snaps) {
        let child = null;
        switch (tab) {
        case 'power':
            this._activeTabInstance = this._powerTab;
            child = this._powerTab.render(model, palette, snaps.power, snaps.powerProfile);
            break;
        case 'media':
            this._activeTabInstance = this._mediaTab;
            child = this._mediaTab.render(model, palette, snaps.quickActions);
            break;
        case 'clipboard':
            this._activeTabInstance = this._clipboardTab;
            child = this._clipboardTab.render(model, palette, snaps.clipboard);
            break;
        case 'shelf':
            this._activeTabInstance = this._shelfTab;
            child = this._shelfTab.render(model, palette, snaps.shelf);
            break;
        case 'home':
        default:
            this._activeTabInstance = this._homeTab;
            child = this._homeTab.render(model, palette, snaps.quickActions, snaps.notifHistory);
            break;
        }
        this._bodyBin?.set_child(child);
    }

    switchTab(nextTab, model, palette, snapshots) {
        if (!this._root || !this._bodyBin)
            return false;
        const normalized = nextTab || 'home';
        if (this._currentTabId === normalized)
            return this.updateInPlace(model, snapshots);

        const prevTab = this._currentTabId;
        this._currentTabId = normalized;

        const order = normalizeTabOrder(model?.tabOrder);
        const prevIdx = order.indexOf(prevTab);
        const nextIdx = order.indexOf(normalized);
        let dir = 0;
        if (prevIdx !== -1 && nextIdx !== -1 && prevIdx !== nextIdx)
            dir = nextIdx > prevIdx ? 1 : -1;

        if (palette)
            this._lastPalette = palette;
        const pal = palette ?? this._lastPalette;
        const acc = pal?.accentCss || '#93c5fd';
        const fg = pal?.accentFgCss || '#090d16';
        const activeBadgeBg = fg === '#ffffff' ? 'rgba(255, 255, 255, 0.22)' : 'rgba(9, 13, 22, 0.16)';

        // 1. Update tab button styles smoothly without rebuilding header
        if (prevTab && this._tabButtons[prevTab]) {
            const prevBtn = this._tabButtons[prevTab];
            prevBtn.remove_style_class_name('bayisland-hub-tab-btn-active');
            prevBtn.style = '';
            const inner = prevBtn.get_child();
            if (inner) {
                const icon = inner.get_first_child();
                if (icon) icon.style = '';
                const lbl = icon?.get_next_sibling();
                if (lbl) lbl.style = '';
            }
            if (this._tabBadges[prevTab]) {
                this._tabBadges[prevTab].label.style = `background-color: ${acc}; color: ${fg};`;
                this._tabBadges[prevTab].active = false;
            }
        }

        if (this._tabButtons[normalized]) {
            const nextBtn = this._tabButtons[normalized];
            nextBtn.add_style_class_name('bayisland-hub-tab-btn-active');
            nextBtn.style = `background-color: ${acc}; color: ${fg};`;
            const inner = nextBtn.get_child();
            if (inner) {
                const icon = inner.get_first_child();
                if (icon) icon.style = `color: ${fg};`;
                const lbl = icon?.get_next_sibling();
                if (lbl) lbl.style = `color: ${fg}; font-weight: 700;`;
            }
            if (this._tabBadges[normalized]) {
                this._tabBadges[normalized].label.style = `background-color: ${activeBadgeBg}; color: ${fg};`;
                this._tabBadges[normalized].active = true;
            }

            try {
                nextBtn.set_pivot_point(0.5, 0.5);
                nextBtn.scale_x = 0.94;
                nextBtn.scale_y = 0.94;
                nextBtn.ease({
                    scale_x: 1.0,
                    scale_y: 1.0,
                    duration: 200,
                    mode: Clutter.AnimationMode.EASE_OUT_BACK,
                });
            } catch {}
        }

        // 2. Destroy old tab instance safely
        if (this._activeTabInstance) {
            try {
                this._activeTabInstance.destroy();
            } catch {}
            this._activeTabInstance = null;
        }

        // 3. Mount new tab with bouncing, smooth slide-in
        const snaps = snapshots ?? {};
        this._mountActiveTab(normalized, model, pal, snaps);
        const child = this._bodyBin.get_child();
        if (child) {
            const startX = dir * 48;
            child.remove_all_transitions();
            child.translation_x = startX;
            child.opacity = 0;
            child.ease({
                translation_x: 0,
                duration: 220,
                mode: Clutter.AnimationMode.EASE_OUT_BACK,
            });
            child.ease({
                opacity: 255,
                duration: 160,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }

        // 4. Update header strip clock and telemetry
        if (this._stripClockLabel)
            this._stripClockLabel.text = getStripClock();
        this._updateStripPowerAndBadges(model.meta, snaps);

        return true;
    }

    updateInPlace(model, snaps) {
        if (!this._root || this._currentTabId !== model.tab)
            return false;

        if (this._stripClockLabel)
            this._stripClockLabel.text = getStripClock();

        this._updateStripPowerAndBadges(model.meta, snaps);

        if (this._activeTabInstance?.updateInPlace)
            return Boolean(this._activeTabInstance.updateInPlace(model));

        return true;
    }

    _updateStripPowerAndBadges(meta, snaps) {
        const m = meta ?? {};
        if (this._incogBadge)
            this._incogBadge.visible = Boolean(m.clipPaused);
        if (this._lowBatBtn) {
            const pct = Math.round(m.powerPct ?? snaps?.power?.percentage ?? 0);
            this._lowBatBtn.label = `${pct}%`;
            this._lowBatBtn.visible = Boolean(m.onBattery && pct > 0 && pct <= 20);
        }
        if (this._tabBadges.shelf) {
            const c = m.shelfCount ?? snaps?.shelf?.items?.length ?? 0;
            this._tabBadges.shelf.label.text = String(c);
            this._tabBadges.shelf.label.visible = c > 0;
        }
        if (this._tabBadges.home) {
            const c = m.unreadNotifs ?? snaps?.notifHistory?.totalUnread ?? 0;
            this._tabBadges.home.label.text = String(c);
            this._tabBadges.home.label.visible = c > 0;
        }
    }

    updatePowerProfile(model, palette, snaps) {
        if (palette)
            this._lastPalette = palette;
        const pal = palette ?? this._lastPalette;
        this._updateStripPowerAndBadges(model.meta, snaps);
        if (this._currentTabId === 'power' && this._bodyBin) {
            if (this._powerTab.updateSnapshot?.(model, pal, snaps.power, snaps.powerProfile))
                return;
            const child = this._powerTab.render(model, pal, snaps.power, snaps.powerProfile);
            this._bodyBin.set_child(child);
        }
    }

    updateQuickActions(quickSnap, palette) {
        if (palette)
            this._lastPalette = palette;
        const pal = palette ?? this._lastPalette;
        if (this._currentTabId === 'home')
            this._homeTab.updateQuickActions(quickSnap, pal);
        else if (this._currentTabId === 'media')
            this._mediaTab.updateQuickActions(quickSnap, pal);
    }

    updateClipboard(clipSnap, palette) {
        if (palette)
            this._lastPalette = palette;
        if (this._currentTabId === 'clipboard')
            this._clipboardTab.updateSnapshot(clipSnap, palette ?? this._lastPalette);
    }

    updateShelf(model, palette, shelfSnap) {
        if (palette)
            this._lastPalette = palette;
        this._updateStripPowerAndBadges(model.meta, { shelf: shelfSnap });
        if (this._currentTabId === 'shelf' && this._bodyBin) {
            const child = this._shelfTab.render(model, palette ?? this._lastPalette, shelfSnap);
            this._bodyBin.set_child(child);
        }
    }

    updateNotifications(history, model) {
        this._updateStripPowerAndBadges(model?.meta, { notifHistory: history });
        if (this._currentTabId === 'home')
            this._homeTab.updateHistory(history, this._lastPalette);
    }

    getShelfBridgeRegion(shellX, shellY, shellW, shellH) {
        return this._shelfTab.getBridgeRegion(shellX, shellY, shellW, shellH);
    }

    destroyCurrentTab() {
        if (this._activeTabInstance) {
            try {
                this._activeTabInstance.destroy();
            } catch {
                // Best effort cleanup
            }
            this._activeTabInstance = null;
        }
        this._currentTabId = null;
    }

    destroy() {
        this.destroyCurrentTab();
        try { this._homeTab?.disposePermanent?.(); } catch {}
        this._homeTab = null;
        this._powerTab = null;
        this._mediaTab = null;
        this._clipboardTab = null;
        this._shelfTab = null;
        this._tabButtons = {};
        this._tabBadges = {};
        this._stripClockLabel = null;
        this._lowBatBtn = null;
        this._incogBadge = null;
        this._bodyBin = null;
        this._root = null;
    }
}
