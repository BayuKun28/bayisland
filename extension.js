import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import { SignalRegistry } from './src/core/SignalRegistry.js';
import { TimerRegistry } from './src/core/TimerRegistry.js';
import { IslandState, PriorityManager } from './src/core/PriorityManager.js';
import { ExtensionCompat } from './src/utils/ExtensionCompat.js';
import { ThemeBridge } from './src/utils/ThemeBridge.js';
import { IslandContainer } from './src/ui/IslandContainer.js';
import { OsdManager } from './src/managers/OsdManager.js';
import { PowerManager } from './src/managers/PowerManager.js';
import { PowerProfileService } from './src/managers/PowerProfileService.js';
import { QuickActionsManager } from './src/managers/QuickActionsManager.js';
import { ClipboardManager } from './src/managers/ClipboardManager.js';
import { DropShelfManager } from './src/managers/DropShelfManager.js';
import { PrivacyManager } from './src/managers/PrivacyManager.js';
import { MprisManager } from './src/managers/MprisManager.js';
import { TimerManager } from './src/managers/TimerManager.js';
import { NotificationManager } from './src/managers/NotificationManager.js';
import { ResourceManager } from './src/managers/ResourceManager.js';
import { ExternalBusService } from './src/managers/ExternalBusService.js';
import { TopBarManager } from './src/managers/TopBarManager.js';

export default class BayIslandExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._signals = new SignalRegistry();
        this._timers = new TimerRegistry();
        this._priority = new PriorityManager(this._timers);
        this._compat = new ExtensionCompat(this._signals);
        this._themeBridge = new ThemeBridge(this._signals);
        this._topBar = new TopBarManager({
            signals: this._signals,
            timers: this._timers,
        });

        this._osd = new OsdManager(this._priority);
        this._timerManager = new TimerManager({
            timers: this._timers,
            priority: this._priority,
        });
        this._mpris = new MprisManager({
            timers: this._timers,
            priority: this._priority,
        });
        this._privacy = new PrivacyManager({
            signals: this._signals,
            priority: this._priority,
        });
        this._notifications = new NotificationManager({
            timers: this._timers,
            priority: this._priority,
        });
        this._resource = new ResourceManager({
            timers: this._timers,
            priority: this._priority,
        });
        this._powerProfile = new PowerProfileService({
            signals: this._signals,
            timers: this._timers,
            priority: this._priority,
        });
        this._quickActions = new QuickActionsManager({
            signals: this._signals,
            timers: this._timers,
            priority: this._priority,
            openPrefs: () => this.openPreferences(),
        });
        this._dropShelf = new DropShelfManager({
            extensionDir: this.path,
            timers: this._timers,
            priority: this._priority,
        });
        this._clipboard = new ClipboardManager({
            timers: this._timers,
            priority: this._priority,
            onSendFilesToShelf: uris => {
                this._dropShelf?.addUris(uris, { source: 'clipboard', showToast: true });
                this._priority?.expand('shelf');
            },
        });
        this._bus = new ExternalBusService({
            priority: this._priority,
            timerManager: this._timerManager,
            notifications: this._notifications,
            dropShelf: this._dropShelf,
            compat: this._compat,
        });

        this._island = new IslandContainer({
            signals: this._signals,
            timers: this._timers,
            priority: this._priority,
            topBar: this._topBar,
            callbacks: {
                onMediaPlayPause: () => this._mpris?.playPause(),
                onMediaNext: () => this._mpris?.next(),
                onMediaPrev: () => this._mpris?.previous(),
                onMediaRaise: () => this._mpris?.raise(),
                onMediaSeek: frac => this._mpris?.seekToFraction(frac),
                onMediaSelectPlayer: busName => this._mpris?.selectPlayer(busName),
                onTimerStart: (sec, mode, title) => this._timerManager?.start(sec, mode, title),
                onTimerTogglePause: () => this._timerManager?.togglePause(),
                onTimerAddSeconds: sec => this._timerManager?.addSeconds(sec),
                onTimerStop: () => this._timerManager?.stop(),
                onSetPowerProfile: profile => this._powerProfile?.setActiveProfile(profile),
                onExpandedTabState: model => {
                    this._powerProfile?.setLiveMonitoring(
                        model.state === IslandState.EXPANDED_MODAL && model.tab === 'power'
                    );
                },
                onToggleWifi: () => this._quickActions?.toggleWifi(),
                onToggleBluetooth: () => this._quickActions?.toggleBluetooth(),
                onToggleNightLight: () => this._quickActions?.toggleNightLight(),
                onToggleDnd: () => this._quickActions?.toggleDnd(),
                onTriggerScreenshot: () => this._quickActions?.triggerScreenshot(),
                onToggleKeepAwake: () => this._quickActions?.toggleKeepAwake(),
                onOpenSettingsApp: desktopId => this._quickActions?.openSettingsApp(desktopId),
                onOpenExtensionPrefs: () => this._quickActions?.openExtensionPrefs(),
                onToggleMicMute: () => this._quickActions?.toggleMicMute(),
                onToggleOutputMute: () => this._quickActions?.toggleOutputMute(),
                onSetOutputVolume: frac => this._quickActions?.setOutputVolume(frac),
                onStepVolume: (delta, opts) => this._quickActions?.stepVolume(delta, opts),
                onSelectOutputDevice: devId => this._quickActions?.selectOutputDevice(devId),
                onClipTogglePause: () => this._clipboard?.togglePaused(),
                onClipToggleAutoPaste: () => {
                    if (!this._clipboard || !this._settings)
                        return;
                    const next = !this._clipboard.getAutoPaste();
                    this._settings.set_boolean('clipboard-auto-paste', next);
                },
                onClipClearUnpinned: () => this._clipboard?.clearUnpinned(),
                onClipActivate: (id, force) => this._clipboard?.activateEntry(id, force),
                onClipSendToShelf: id => this._clipboard?.sendEntryUrisToShelf(id),
                onClipTogglePin: id => this._clipboard?.togglePin(id),
                onClipDelete: id => this._clipboard?.deleteEntry(id),
                onSyncShelfBridge: (model, rect) => this._dropShelf?.syncWithUiState(model, rect),
                isShelfModalLockActive: () => Boolean(this._dropShelf?.isModalLockActive()),
                isShelfPickerOpen: () => Boolean(this._dropShelf?.isPickerOpen()),
                isPointerInShelfBridge: () => Boolean(this._dropShelf?.isPointerInBridge()),
                onShelfPickFiles: () => this._dropShelf?.openFilePicker(),
                onShelfCopyAll: () => this._dropShelf?.copyAllFilesToClipboard(),
                onShelfClearUnpinned: () => this._dropShelf?.clearUnpinned(),
                onShelfCopyItem: id => this._dropShelf?.copyItemFilesToClipboard(id),
                onShelfOpenItem: id => this._dropShelf?.openItem(id),
                onShelfTogglePin: id => this._dropShelf?.togglePin(id),
                onShelfRemoveItem: id => this._dropShelf?.removeItem(id),
                onNotifClearAll: () => this._notifications?.clearAll(),
                onNotifActivate: id => this._notifications?.activateNotification(id),
                onNotifDismiss: id => this._notifications?.dismissItem(id),
                onNotifAction: (id, idx) => this._notifications?.invokeAction(id, idx),
            },
        });

        this._power = new PowerManager({
            signals: this._signals,
            priority: this._priority,
            onSnapshot: snap => this._island?.setPowerSnapshot(snap),
        });

        this._signals.connect(this._themeBridge, 'palette-changed', (_src, palette) => {
            this._island?.setPalette(palette);
        });

        this._signals.connect(this._compat, 'changed', (_src, snapshot) => {
            this._island?.setCompatSnapshot(snapshot);
            this._syncThemeBridge(snapshot);
            this._syncTopBarOptions(snapshot);
        });

        this._signals.connect(this._topBar, 'clock-updated', (_src, clockData) => {
            this._priority?.updateMeta(clockData, { inPlaceHint: true });
        });

        this._signals.connect(this._topBar, 'panel-state-changed', () => {
            this._island?._onEnvironmentChanged();
        });

        this._signals.connect(this._powerProfile, 'changed', (_src, snapshot) => {
            this._island?.setPowerProfileSnapshot(snapshot);
        });

        this._signals.connect(this._quickActions, 'changed', (_src, snapshot) => {
            this._island?.setQuickActionsSnapshot(snapshot);
        });

        this._signals.connect(this._clipboard, 'changed', (_src, snapshot) => {
            this._island?.setClipboardSnapshot(snapshot);
        });

        this._signals.connect(this._dropShelf, 'changed', (_src, snapshot) => {
            this._island?.setShelfSnapshot(snapshot);
        });

        this._signals.connect(this._dropShelf, 'bridge-activity', (_src, activity) => {
            this._island?.handleBridgeActivity(activity);
        });

        this._signals.connect(this._notifications, 'changed', (_src, history) => {
            this._island?.setNotificationHistory(history);
        });

        this._signals.connect(this._settings, 'changed', () => {
            this._applySettings();
        });

        this._island.setCompatSnapshot(this._compat.getSnapshot());
        this._priority.updateMeta(this._topBar.getClockStrings(), { inPlaceHint: true });
        this._powerProfile.setEnabled(true);
        this._notifications.startWatchingTray();
        this._applySettings();

        this._island.setPowerProfileSnapshot(this._powerProfile.getSnapshot());
        this._island.setQuickActionsSnapshot(this._quickActions.getSnapshot());
        this._island.setClipboardSnapshot(this._clipboard.getSnapshot());
        this._island.setShelfSnapshot(this._dropShelf.getSnapshot());
        this._island.setNotificationHistory(this._notifications.getHistory());

        this._registerShortcuts();
    }

    _registerShortcuts() {
        const mode = Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW;

        Main.wm.addKeybinding(
            'toggle-expand-shortcut',
            this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            mode,
            () => this._priority?.toggleExpand()
        );

        Main.wm.addKeybinding(
            'quick-timer-shortcut',
            this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            mode,
            () => this._priority?.toggleExpand('home')
        );

        Main.wm.addKeybinding(
            'quick-clipboard-shortcut',
            this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            mode,
            () => this._priority?.toggleExpand('clipboard')
        );

        Main.wm.addKeybinding(
            'quick-shelf-shortcut',
            this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            mode,
            () => this._priority?.toggleExpand('shelf')
        );
    }

    _syncThemeBridge(compatSnapshot = null) {
        if (!this._themeBridge || !this._settings)
            return;
        const snap = compatSnapshot ?? this._compat?.getSnapshot() ?? {};
        this._themeBridge.setConfig({
            enabled: this._settings.get_boolean('openbar-color-sync'),
            openbarActive: Boolean(snap.openbar),
            openbarDir: snap.openbarDir ?? null,
            customAccentHex: this._settings.get_string('accent-color'),
        });
    }

    _syncTopBarOptions(compatSnapshot = null) {
        if (!this._topBar || !this._settings)
            return;
        const snap = compatSnapshot ?? this._compat?.getSnapshot() ?? {};
        this._topBar.setOptions({
            integrationMode: this._settings.get_string('topbar-integration-mode'),
            autohideMode: this._settings.get_string('topbar-autohide-mode'),
            hoverMode: this._settings.get_string('topbar-autohide-hover-mode'),
            showInOverview: this._settings.get_boolean('topbar-autohide-show-overview'),
            animMs: this._settings.get_int('topbar-autohide-anim-ms'),
            externalHideTopBarActive: Boolean(snap.hidetopbar),
        });
    }

    _applySettings() {
        const s = this._settings;
        if (!s)
            return;

        this._syncTopBarOptions();

        const pillStyle = s.get_string('pill-style');
        const collisionMode = s.get_string('topbar-collision-mode');
        const topbarIntegrationMode = s.get_string('topbar-integration-mode');
        const mergedPillPreset = s.get_string('merged-pill-preset');
        const mergedClockRightClickGnome = s.get_boolean('merged-clock-right-click-gnome');
        const topMargin = s.get_int('top-margin');
        const hideInFullscreen = s.get_boolean('hide-in-fullscreen');
        const showIdlePill = s.get_boolean('show-idle-pill');
        const idleHandleEnabled = s.get_boolean('idle-handle-enabled');
        const idleHoverPeek = s.get_boolean('idle-hover-peek');
        const idleHoverDwellMs = s.get_int('idle-hover-dwell-ms');
        const expandedDefaultTab = s.get_string('expanded-default-tab');
        const tabOrder = s.get_strv('tab-order');

        this._island._syncEnvironment();
        this._island.setAppearance({
            pillStyle,
            collisionMode,
            topbarIntegrationMode,
            mergedClockRightClickGnome,
            topMargin,
            idleHoverDwellMs,
        });
        this._priority.setOptions({
            showIdlePill,
            idleHandleEnabled,
            idleHoverPeek,
            hideInFullscreen,
            topbarCollisionMode: collisionMode,
            topbarIntegrationMode,
            mergedPillPreset,
            expandedDefaultTab,
            tabOrder,
        });
        this._topBar.syncPanelGeometry();

        this._syncThemeBridge();

        this._osd.setEnabled(s.get_boolean('enable-osd'));

        this._mpris.setHideDelaySeconds(s.get_int('mpris-hide-delay'));
        this._mpris.setEnabled(s.get_boolean('enable-mpris'));

        this._privacy.setEnabled(s.get_boolean('enable-privacy'));

        this._notifications.setDurationMs(s.get_int('notification-duration'));
        this._notifications.setEnabled(s.get_boolean('enable-notifications'));

        this._power.setEnabled(s.get_boolean('enable-power'));

        this._timerManager.setEnabled(s.get_boolean('enable-timer'));

        this._resource.setThresholds(
            s.get_int('resource-cpu-threshold'),
            s.get_int('resource-ram-threshold')
        );
        this._resource.setEnabled(s.get_boolean('enable-resource-spike'));

        this._quickActions.setEnabled(s.get_boolean('enable-quick-actions'));

        this._clipboard.setOptions({
            autoPaste: s.get_boolean('clipboard-auto-paste'),
            pasteShortcut: s.get_string('clipboard-paste-shortcut'),
            ignorePasswords: s.get_boolean('clipboard-ignore-passwords'),
            maxItems: s.get_int('clipboard-max-items'),
        });
        this._clipboard.setEnabled(s.get_boolean('enable-clipboard'));

        this._dropShelf.setOptions({
            dragReveal: s.get_boolean('shelf-drag-reveal'),
            screenshotAutoStash: s.get_boolean('shelf-screenshot-auto-stash'),
        });
        this._dropShelf.setEnabled(s.get_boolean('enable-shelf'));

        this._bus.setEnabled(s.get_boolean('enable-dbus-service'));
    }

    disable() {
        for (const key of [
            'toggle-expand-shortcut',
            'quick-timer-shortcut',
            'quick-clipboard-shortcut',
            'quick-shelf-shortcut',
        ]) {
            try {
                Main.wm.removeKeybinding(key);
            } catch {
                // Already removed
            }
        }

        this._signals?.disconnectAll();

        this._bus?.destroy();
        this._clipboard?.destroy();
        this._dropShelf?.destroy();
        this._quickActions?.destroy();
        this._powerProfile?.destroy();
        this._resource?.destroy();
        this._notifications?.destroy();
        this._osd?.destroy();
        this._timerManager?.destroy();
        this._mpris?.destroy();
        this._privacy?.destroy();
        this._power?.destroy();
        this._island?.destroy();
        this._topBar?.destroy();
        this._themeBridge?.destroy();
        this._priority?.destroy();
        this._timers?.clearAll();

        this._bus = null;
        this._clipboard = null;
        this._dropShelf = null;
        this._quickActions = null;
        this._powerProfile = null;
        this._resource = null;
        this._notifications = null;
        this._osd = null;
        this._timerManager = null;
        this._mpris = null;
        this._privacy = null;
        this._power = null;
        this._island = null;
        this._topBar = null;
        this._themeBridge = null;
        this._compat = null;
        this._priority = null;
        this._timers = null;
        this._signals = null;
        this._settings = null;
    }
}
