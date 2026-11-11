import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GnomeBluetooth from 'gi://GnomeBluetooth';
import Gvc from 'gi://Gvc';
import NM from 'gi://NM';
import Shell from 'gi://Shell';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';
import * as Screenshot from 'resource:///org/gnome/shell/ui/screenshot.js';
import * as Volume from 'resource:///org/gnome/shell/ui/status/volume.js';

import { IslandState, Weights } from '../core/PriorityManager.js';

const RFKILL_BUS = 'org.gnome.SettingsDaemon.Rfkill';
const RFKILL_PATH = '/org/gnome/SettingsDaemon/Rfkill';
const RFKILL_XML = `
<node>
  <interface name="org.gnome.SettingsDaemon.Rfkill">
    <property name="BluetoothAirplaneMode" type="b" access="readwrite"/>
    <property name="BluetoothHasAirplaneMode" type="b" access="read"/>
    <property name="BluetoothHardwareAirplaneMode" type="b" access="read"/>
  </interface>
</node>`;
const RfkillProxy = Gio.DBusProxy.makeProxyWrapper(RFKILL_XML);

const SESSION_BUS = 'org.gnome.SessionManager';
const SESSION_PATH = '/org/gnome/SessionManager';

function getDeviceDisplayName(dev) {
    const desc = (dev.get_description?.() || '').trim();
    const origin = (dev.get_origin?.() || '').trim();
    const isGenericOrigin = !origin || /^(built-in|internal|system)\s*audio$/i.test(origin);
    const isGenericDesc = !desc || /^(headset|headphones?|speakers?|output|analog output|digital output|line out(put)?)$/i.test(desc);

    if (!isGenericOrigin && isGenericDesc)
        return origin;
    if (!isGenericDesc)
        return desc;
    if (!isGenericOrigin)
        return origin;
    return desc || 'Headphones';
}

function classifyAudioDevice(dev) {
    const desc = (dev.get_description?.() || '').toLowerCase();
    const origin = (dev.get_origin?.() || '').toLowerCase();
    const port = (dev.get_port?.() || '').toLowerCase();
    const iconName = (dev.get_icon_name?.() || '').toLowerCase();

    // 1. TWS / Bluetooth
    const isBluetooth = origin.includes('bluetooth') ||
        port.includes('bluetooth') ||
        iconName.includes('bluetooth') ||
        iconName.includes('headset') ||
        port.includes('headset') ||
        /buds|airpods|freebuds|earfun|soundcore|tws|wireless/i.test(desc) ||
        /buds|airpods|freebuds|earfun|soundcore|tws|wireless/i.test(origin);

    if (isBluetooth) {
        return {
            type: 'tws',
            body: 'TWS Connected • Bluetooth Audio',
            icon: 'audio-headset-symbolic',
            iconColor: '#38bdf8',
        };
    }

    // 2. USB DAC / Hi-Fi Sound Card
    const isDac = origin.includes('usb') ||
        desc.includes('usb') ||
        /dac|fiio|moondrop|hifiman|audioquest|creative|focusrite|shanling|topping|hiby|ibasso|soundcard|hi-res/i.test(desc) ||
        /dac|fiio|moondrop|hifiman|audioquest|creative|focusrite|shanling|topping|hiby|ibasso|soundcard|hi-res/i.test(origin);

    if (isDac) {
        return {
            type: 'dac',
            body: 'DAC Connected • Hi-Res Audio',
            icon: 'audio-card-symbolic',
            iconColor: '#a78bfa',
        };
    }

    // 3. IEM / Headphone Jack (3.5mm)
    const isHeadphones = port.includes('headphone') ||
        desc.includes('headphone') ||
        desc.includes('earphone') ||
        desc.includes('iem');

    if (isHeadphones) {
        return {
            type: 'iem',
            body: 'IEM Plugged • Audio Jack',
            icon: 'audio-headphones-symbolic',
            iconColor: '#60a5fa',
        };
    }

    // Other non-speaker external audio
    const isSpeaker = port.includes('speaker') || desc.includes('speaker');
    if (!isSpeaker && !origin.includes('built-in')) {
        return {
            type: 'external',
            body: 'Audio Device Connected',
            icon: 'audio-headphones-symbolic',
            iconColor: '#38bdf8',
        };
    }

    return null;
}

/**
 * Non-destructive Quick Actions & Audio Output controller.
 * Communicates strictly over NM, GnomeBluetooth, Gvc, GSettings, and D-Bus
 * so Top Bar Quick Settings and quick-settings-tweaks remain untouched.
 */
export class QuickActionsManager extends Signals.EventEmitter {
    constructor({ signals, timers, priority, openPrefs }) {
        super();
        this._signals = signals;
        this._timers = timers;
        this._priority = priority;
        this._openPrefs = openPrefs;

        this._enabled = false;
        this._cancellable = new Gio.Cancellable();

        // Wi-Fi (NetworkManager)
        this._nmClient = null;
        this._nmIds = [];
        this._wifiDev = null;
        this._wifiDevIds = [];

        // Bluetooth
        this._btClient = null;
        this._btIds = [];
        this._btDeviceSigIds = new Map();
        this._btConnectedAddresses = new Set();
        this._btBootstrapped = false;
        this._rfkillProxy = null;
        this._rfkillSigId = 0;

        // GSettings
        this._colorSettings = null;
        this._colorSigId = 0;
        this._notifSettings = null;
        this._notifSigId = 0;

        // Session Keep-Awake inhibitor
        this._inhibitCookie = 0;

        // Audio mixer
        this._mixer = null;
        this._mixerIds = [];
        this._defaultSink = null;
        this._sinkSigIds = [];
        this._defaultSource = null;
        this._sourceSigIds = [];
        this._outputs = new Map();
        this._activeOutputId = null;

        // Audio accessory connection alerts (TWS, DAC, IEM)
        this._accessoryAlertsEnabled = true;
        this._bootstrapped = false;
        this._knownOutputIds = new Set();
        this._lastAlertTime = new Map();

        this._state = {
            wifiAvailable: false,
            wifiEnabled: false,
            wifiHardwareEnabled: true,
            wifiSsid: '',
            btAvailable: false,
            btEnabled: false,
            btConnectedNames: [],
            nightLight: false,
            dnd: false,
            keepAwake: false,
            volumeFraction: 0,
            volumeMuted: false,
            micMuted: false,
            outputs: [],
            activeOutputId: null,
        };
    }

    setEnabled(enabled) {
        const want = Boolean(enabled);
        if (want === this._enabled)
            return;
        this._enabled = want;
        if (want)
            this._start();
        else
            this._stop();
    }

    setAccessoryAlertsEnabled(enabled) {
        this._accessoryAlertsEnabled = Boolean(enabled);
    }

    getSnapshot() {
        return {
            ...this._state,
            btConnectedNames: [...this._state.btConnectedNames],
            outputs: [...this._state.outputs],
        };
    }

    toggleWifi() {
        if (!this._nmClient || !this._state.wifiHardwareEnabled)
            return;
        this._nmClient.wireless_enabled = !this._nmClient.wireless_enabled;
        this._syncWifi();
    }

    toggleBluetooth() {
        if (!this._btClient)
            return;
        const currentlyActive = Boolean(this._btClient.default_adapter_powered);
        if (this._rfkillProxy) {
            Gio.DBus.session.call(
                RFKILL_BUS,
                RFKILL_PATH,
                'org.freedesktop.DBus.Properties',
                'Set',
                new GLib.Variant('(ssv)', [
                    RFKILL_BUS,
                    'BluetoothAirplaneMode',
                    new GLib.Variant('b', currentlyActive),
                ]),
                null,
                Gio.DBusCallFlags.NONE,
                1500,
                null,
                () => {}
            );
        }
        try {
            this._btClient.default_adapter_powered = !currentlyActive;
        } catch {
            // Adapter property may be managed by rfkill transition
        }
        this._syncBluetooth();
    }

    toggleNightLight() {
        if (!this._colorSettings)
            return;
        const next = !this._colorSettings.get_boolean('night-light-enabled');
        this._colorSettings.set_boolean('night-light-enabled', next);
    }

    toggleDnd() {
        if (!this._notifSettings)
            return;
        // DND = !show-banners
        const curShowBanners = this._notifSettings.get_boolean('show-banners');
        this._notifSettings.set_boolean('show-banners', !curShowBanners);
    }

    toggleKeepAwake() {
        if (this._inhibitCookie) {
            const cookie = this._inhibitCookie;
            this._inhibitCookie = 0;
            this._state.keepAwake = false;
            this._emitChanged();
            Gio.DBus.session.call(
                SESSION_BUS,
                SESSION_PATH,
                SESSION_BUS,
                'Uninhibit',
                new GLib.Variant('(u)', [cookie]),
                null,
                Gio.DBusCallFlags.NONE,
                1500,
                null,
                () => {}
            );
            return;
        }

        Gio.DBus.session.call(
            SESSION_BUS,
            SESSION_PATH,
            SESSION_BUS,
            'Inhibit',
            new GLib.Variant('(susu)', [
                'bayisland@baydev',
                0,
                'BayIsland Keep Awake active',
                4 | 8, // suspend + idle
            ]),
            new GLib.VariantType('(u)'),
            Gio.DBusCallFlags.NONE,
            2000,
            this._cancellable,
            (conn, res) => {
                try {
                    const out = conn.call_finish(res);
                    const [cookie] = out.deepUnpack();
                    if (!this._enabled) {
                        Gio.DBus.session.call(SESSION_BUS, SESSION_PATH, SESSION_BUS, 'Uninhibit',
                            new GLib.Variant('(u)', [cookie]), null, Gio.DBusCallFlags.NONE, 1000, null, () => {});
                        return;
                    }
                    this._inhibitCookie = cookie;
                    this._state.keepAwake = true;
                    this._emitChanged();
                } catch (e) {
                    logError(e, 'BayIsland Keep Awake inhibit failed');
                }
            }
        );
    }

    triggerScreenshot() {
        this._priority?.collapse();
        this._timers?.setTimeout(180, () => {
            try {
                Screenshot.showScreenshotUI();
            } catch (e) {
                logError(e, 'BayIsland Screenshot UI failed');
            }
        });
    }

    openSettingsApp(desktopId) {
        this._priority?.collapse();
        try {
            const app = Shell.AppSystem.get_default().lookup_app(desktopId);
            if (app) {
                app.activate();
                return;
            }
            const info = Gio.DesktopAppInfo.new(desktopId);
            info?.launch([], global.create_app_launch_context(0, -1));
        } catch (e) {
            logError(e, `Failed to launch ${desktopId}`);
        }
    }

    openExtensionPrefs() {
        this._priority?.collapse();
        try {
            this._openPrefs?.();
        } catch (e) {
            logError(e, 'Failed to open BayIsland prefs');
        }
    }

    setOutputVolume(fraction) {
        if (!this._mixer || !this._defaultSink)
            return 0;
        const clamped = Math.max(0, Math.min(1, fraction));
        const maxNorm = this._mixer.get_vol_max_norm();
        this._defaultSink.volume = Math.round(clamped * maxNorm);
        this._defaultSink.push_volume();
        if (clamped > 0 && this._defaultSink.is_muted)
            this._defaultSink.change_is_muted(false);
        this._syncAudioStreams();
        return clamped;
    }

    stepVolume(delta, { showOsd = false } = {}) {
        if (!this._mixer || !this._defaultSink)
            return;
        const maxNorm = this._mixer.get_vol_max_norm();
        const cur = this._defaultSink.is_muted ? 0 : (this._defaultSink.volume / maxNorm);
        const next = this.setOutputVolume(cur + delta);
        if (showOsd && this._priority && this._priority.getModel()?.state !== IslandState.EXPANDED_MODAL) {
            const muted = next <= 0.001 || Boolean(this._defaultSink.is_muted);
            const iconName = muted
                ? 'audio-volume-muted-symbolic'
                : (next < 0.34 ? 'audio-volume-low-symbolic' : (next < 0.67 ? 'audio-volume-medium-symbolic' : 'audio-volume-high-symbolic'));
            this._priority.pushTransient({
                kind: 'osd',
                weight: Weights.OSD,
                coalesceKey: 'osd-volume',
                title: 'Volume',
                body: null,
                icon: new Gio.ThemedIcon({ name: iconName }),
                iconColor: '#60a5fa',
                level: next,
                maxLevel: 1,
                durationMs: 1400,
            });
        }
    }

    toggleOutputMute() {
        if (!this._defaultSink)
            return;
        this._defaultSink.change_is_muted(!this._defaultSink.is_muted);
    }

    toggleMicMute() {
        if (!this._defaultSource)
            return;
        this._defaultSource.change_is_muted(!this._defaultSource.is_muted);
    }

    selectOutputDevice(deviceId) {
        if (!this._mixer)
            return;
        const dev = this._mixer.lookup_output_id(deviceId);
        if (dev)
            this._mixer.change_output(dev);
    }

    _start() {
        this._cancellable = new Gio.Cancellable();
        this._initGSettings();
        this._initWifi();
        this._initBluetooth();
        this._initAudio();
    }

    _initGSettings() {
        const schemaSrc = Gio.SettingsSchemaSource.get_default();
        const colorSchema = schemaSrc?.lookup('org.gnome.settings-daemon.plugins.color', true);
        if (colorSchema) {
            this._colorSettings = new Gio.Settings({ settings_schema: colorSchema });
            this._state.nightLight = this._colorSettings.get_boolean('night-light-enabled');
            this._colorSigId = this._colorSettings.connect('changed::night-light-enabled', () => {
                this._state.nightLight = Boolean(this._colorSettings?.get_boolean('night-light-enabled'));
                this._emitChanged();
            });
        }

        const notifSchema = schemaSrc?.lookup('org.gnome.desktop.notifications', true);
        if (notifSchema) {
            this._notifSettings = new Gio.Settings({ settings_schema: notifSchema });
            this._state.dnd = !this._notifSettings.get_boolean('show-banners');
            this._priority?.updateMeta({ dnd: this._state.dnd }, { inPlaceHint: true });
            this._notifSigId = this._notifSettings.connect('changed::show-banners', () => {
                this._state.dnd = !this._notifSettings?.get_boolean('show-banners');
                this._priority?.updateMeta({ dnd: this._state.dnd }, { inPlaceHint: true });
                this._emitChanged();
            });
        }
    }

    _initWifi() {
        try {
            NM.Client.new_async(this._cancellable, (_obj, res) => {
                try {
                    const client = NM.Client.new_finish(res);
                    if (!this._enabled)
                        return;
                    this._nmClient = client;
                    this._nmIds.push(
                        client.connect('notify::wireless-enabled', () => this._syncWifi()),
                        client.connect('notify::wireless-hardware-enabled', () => this._syncWifi()),
                        client.connect('notify::active-connections', () => this._syncWifi()),
                        client.connect('device-added', () => this._syncWifi()),
                        client.connect('device-removed', () => this._syncWifi())
                    );
                    this._syncWifi();
                } catch {
                    // NM absent or cancelled
                }
            });
        } catch {
            // Ignore
        }
    }

    _syncWifi() {
        if (!this._nmClient)
            return;

        for (const id of this._wifiDevIds) {
            try { this._wifiDev?.disconnect(id); } catch {}
        }
        this._wifiDevIds = [];
        this._wifiDev = null;

        const devices = this._nmClient.get_devices?.() ?? [];
        const wifiDev = devices.find(d => d.get_device_type?.() === NM.DeviceType.WIFI) ?? null;
        this._wifiDev = wifiDev;

        if (wifiDev) {
            this._wifiDevIds.push(
                wifiDev.connect('notify::active-access-point', () => this._syncWifi()),
                wifiDev.connect('notify::state', () => this._syncWifi())
            );
        }

        let ssid = '';
        try {
            const ap = wifiDev?.get_active_access_point?.();
            const raw = ap?.get_ssid?.();
            if (raw)
                ssid = NM.utils_ssid_to_utf8(raw.get_data?.() ?? raw) || '';
        } catch {
            ssid = '';
        }

        this._state.wifiAvailable = Boolean(wifiDev);
        this._state.wifiEnabled = Boolean(this._nmClient.wireless_enabled);
        this._state.wifiHardwareEnabled = Boolean(this._nmClient.wireless_hardware_enabled);
        this._state.wifiSsid = ssid;
        this._emitChanged();
    }

    _initBluetooth() {
        try {
            this._btClient = new GnomeBluetooth.Client();
            this._btIds.push(
                this._btClient.connect('notify::default-adapter', () => this._syncBluetooth()),
                this._btClient.connect('notify::default-adapter-powered', () => this._syncBluetooth()),
                this._btClient.connect('notify::default-adapter-state', () => this._syncBluetooth()),
                this._btClient.connect('device-added', () => this._syncBluetooth()),
                this._btClient.connect('device-removed', () => this._syncBluetooth())
            );
            this._syncBluetooth();
            if (this._timers) {
                this._timers.setTimeout(1500, () => {
                    this._btBootstrapped = true;
                });
            } else {
                this._btBootstrapped = true;
            }
        } catch {
            this._btClient = null;
        }

        this._rfkillProxy = new RfkillProxy(
            Gio.DBus.session,
            RFKILL_BUS,
            RFKILL_PATH,
            (proxy, err) => {
                if (err || !this._enabled)
                    return;
                this._rfkillSigId = proxy.connect('g-properties-changed', () => this._syncBluetooth());
                this._syncBluetooth();
            }
        );
    }

    _syncBluetooth() {
        if (!this._btClient)
            return;

        const hasAdapter = Boolean(this._btClient.default_adapter);
        const hardwareBlocked = Boolean(this._rfkillProxy?.BluetoothHardwareAirplaneMode);
        const connectedNames = [];

        try {
            const store = this._btClient.get_devices();
            const n = store?.get_n_items?.() ?? 0;
            const currentConnected = new Set();
            const seenAddresses = new Set();

            for (let i = 0; i < n; i++) {
                const dev = store.get_item(i);
                if (!dev)
                    continue;

                const addr = dev.address || dev.name;
                if (addr)
                    seenAddresses.add(addr);

                if (addr && !this._btDeviceSigIds.has(addr)) {
                    const sid = dev.connect('notify::connected', () => this._syncBluetooth());
                    this._btDeviceSigIds.set(addr, { dev, sid });
                }

                if (dev.connected) {
                    const name = dev.alias || dev.name || 'Device';
                    connectedNames.push(name);
                    if (addr)
                        currentConnected.add(addr);

                    // Check if newly connected Bluetooth audio accessory
                    if (this._btBootstrapped && addr && !this._btConnectedAddresses.has(addr)) {
                        this._checkAndNotifyBtAccessory(dev);
                    }
                }
            }

            // Prune un-paired/removed devices from signal registry
            for (const [addr, { dev, sid }] of this._btDeviceSigIds.entries()) {
                if (!seenAddresses.has(addr)) {
                    try { dev?.disconnect(sid); } catch {}
                    this._btDeviceSigIds.delete(addr);
                }
            }

            this._btConnectedAddresses = currentConnected;
        } catch {
            // Ignore
        }

        this._state.btAvailable = hasAdapter && !hardwareBlocked;
        this._state.btEnabled = Boolean(this._btClient.default_adapter_powered);
        this._state.btConnectedNames = connectedNames;
        this._emitChanged();
    }

    _checkAndNotifyBtAccessory(dev) {
        if (!this._accessoryAlertsEnabled || !this._priority)
            return;

        const devType = dev.type;
        const icon = (dev.icon || '').toLowerCase();
        const name = (dev.alias || dev.name || '').trim();
        const nameLower = name.toLowerCase();

        // Audio devices: HEADSET (32), HEADPHONES (64), OTHER_AUDIO (128) or audio icon or known audio names
        const isAudioType = devType === 32 || devType === 64 || devType === 128 ||
            icon.includes('audio') || icon.includes('headset') || icon.includes('headphones');
        const isAudioName = /buds|airpods|freebuds|earfun|soundcore|tws|wireless|wh-|wf-|headphone|headset|iem/i.test(nameLower);

        if (!isAudioType && !isAudioName)
            return;

        const addr = dev.address || name;
        const now = GLib.get_monotonic_time();
        const last = Math.max(
            this._lastAlertTime.get(addr) || 0,
            name ? (this._lastAlertTime.get(name) || 0) : 0
        );
        if ((now - last) < 4000000)
            return;
        this._lastAlertTime.set(addr, now);
        if (name)
            this._lastAlertTime.set(name, now);

        const batteryPct = Math.round(Number(dev.battery_percentage) || 0);
        const body = (batteryPct > 0 && batteryPct <= 100)
            ? `TWS Connected • ${batteryPct}% Battery`
            : 'TWS Connected • Bluetooth Audio';

        this._priority.pushTransient({
            kind: 'accessory',
            weight: Weights.ACCESSORY,
            coalesceKey: `accessory-bt-${addr}`,
            title: name || 'Bluetooth Audio',
            body,
            icon: new Gio.ThemedIcon({ name: 'audio-headset-symbolic' }),
            iconName: 'audio-headset-symbolic',
            iconColor: '#38bdf8',
            durationMs: 3600,
            onActivate: () => {
                this._priority.expand('media');
            },
            onClick: () => {
                this._priority.expand('media');
            },
        });
    }

    _initAudio() {
        try {
            this._mixer = Volume.getMixerControl();
            this._mixerIds.push(
                this._mixer.connect('state-changed', () => this._rebuildAudioDevices()),
                this._mixer.connect('default-sink-changed', () => this._bindDefaultSink()),
                this._mixer.connect('default-source-changed', () => this._bindDefaultSource()),
                this._mixer.connect('output-added', (_c, id) => this._addOutputDevice(id)),
                this._mixer.connect('output-removed', (_c, id) => this._removeOutputDevice(id)),
                this._mixer.connect('active-output-update', (_c, id) => this._onActiveOutputUpdate(id))
            );
            this._rebuildAudioDevices();
            if (this._timers) {
                this._timers.setTimeout(1500, () => {
                    this._bootstrapped = true;
                });
            } else {
                this._bootstrapped = true;
            }
        } catch {
            this._mixer = null;
        }
    }

    _rebuildAudioDevices() {
        this._outputs.clear();
        if (!this._mixer || this._mixer.get_state() !== Gvc.MixerControlState.READY)
            return;

        // Discover existing output IDs safely up to reasonable scan or default sink stream
        const sinks = this._mixer.get_sinks?.() ?? [];
        for (const sink of sinks) {
            const uiDev = this._mixer.lookup_device_from_stream?.(sink);
            if (uiDev) {
                const id = uiDev.get_id();
                this._outputs.set(id, uiDev);
                if (this._bootstrapped && !this._knownOutputIds.has(id)) {
                    this._knownOutputIds.add(id);
                    this._checkAndNotifyAccessory(uiDev);
                } else {
                    this._knownOutputIds.add(id);
                }
            }
        }
        this._bindDefaultSink();
        this._bindDefaultSource();
        this._syncAudioDeviceList();
    }

    _addOutputDevice(id) {
        const dev = this._mixer?.lookup_output_id(id);
        if (!dev)
            return;
        this._outputs.set(id, dev);
        this._syncAudioDeviceList();

        if (this._bootstrapped && !this._knownOutputIds.has(id)) {
            this._knownOutputIds.add(id);
            this._checkAndNotifyAccessory(dev);
        } else {
            this._knownOutputIds.add(id);
        }
    }

    _removeOutputDevice(id) {
        this._outputs.delete(id);
        this._knownOutputIds.delete(id);
        this._lastAlertTime.delete(id);
        if (this._activeOutputId === id)
            this._activeOutputId = null;
        this._syncAudioDeviceList();
    }

    _onActiveOutputUpdate(id) {
        const prevId = this._activeOutputId;
        this._activeOutputId = id;
        this._syncAudioDeviceList();

        if (prevId && prevId !== id) {
            this._lastAlertTime.delete(prevId);
            this._lastAlertTime.delete(id);
        }

        if (this._bootstrapped && id !== prevId) {
            const dev = this._mixer?.lookup_output_id(id);
            if (dev)
                this._checkAndNotifyAccessory(dev);
        }
    }

    _checkAndNotifyAccessory(dev) {
        if (!this._accessoryAlertsEnabled || !this._bootstrapped || !dev || !this._priority)
            return;

        const id = dev.get_id?.();
        if (id === null || id === undefined)
            return;

        const classification = classifyAudioDevice(dev);
        if (!classification)
            return;

        const origin = (dev.get_origin?.() || '').trim();
        const desc = (dev.get_description?.() || '').trim();

        const now = GLib.get_monotonic_time();
        const last = Math.max(
            this._lastAlertTime.get(id) || 0,
            origin ? (this._lastAlertTime.get(origin) || 0) : 0,
            desc ? (this._lastAlertTime.get(desc) || 0) : 0
        );
        // 4 seconds cooldown per device ID/name
        if ((now - last) < 4000000)
            return;
        this._lastAlertTime.set(id, now);
        if (origin)
            this._lastAlertTime.set(origin, now);
        if (desc)
            this._lastAlertTime.set(desc, now);

        const displayName = getDeviceDisplayName(dev);
        const title = (classification.type === 'iem' && (displayName === 'Headphones' || displayName === 'Headphones (Built-in Audio)'))
            ? 'Headphones Connected'
            : displayName;

        this._priority.pushTransient({
            kind: 'accessory',
            weight: Weights.ACCESSORY,
            coalesceKey: `accessory-${id}`,
            title,
            body: classification.body,
            icon: new Gio.ThemedIcon({ name: classification.icon }),
            iconName: classification.icon,
            iconColor: classification.iconColor,
            durationMs: 3600,
            onActivate: () => {
                this._priority.expand('media');
            },
            onClick: () => {
                this._priority.expand('media');
            },
        });
    }

    _bindDefaultSink() {
        for (const sid of this._sinkSigIds) {
            try { this._defaultSink?.disconnect(sid); } catch {}
        }
        this._sinkSigIds = [];

        this._defaultSink = this._mixer?.get_default_sink() ?? null;
        if (this._defaultSink) {
            this._sinkSigIds.push(
                this._defaultSink.connect('notify::volume', () => this._syncAudioStreams()),
                this._defaultSink.connect('notify::is-muted', () => this._syncAudioStreams())
            );
            const activeDev = this._mixer?.lookup_device_from_stream?.(this._defaultSink);
            if (activeDev) {
                const prevId = this._activeOutputId;
                const newId = activeDev.get_id();
                this._activeOutputId = newId;
                if (this._bootstrapped && prevId !== null && prevId !== newId) {
                    this._lastAlertTime.delete(newId);
                    this._checkAndNotifyAccessory(activeDev);
                }
            }
        }
        this._syncAudioStreams();
        this._syncAudioDeviceList();
    }

    _bindDefaultSource() {
        for (const sid of this._sourceSigIds) {
            try { this._defaultSource?.disconnect(sid); } catch {}
        }
        this._sourceSigIds = [];

        this._defaultSource = this._mixer?.get_default_source() ?? null;
        if (this._defaultSource) {
            this._sourceSigIds.push(
                this._defaultSource.connect('notify::is-muted', () => this._syncAudioStreams())
            );
        }
        this._syncAudioStreams();
    }

    _syncAudioStreams() {
        if (!this._mixer)
            return;
        const maxNorm = this._mixer.get_vol_max_norm() || 65536;
        if (this._defaultSink) {
            this._state.volumeMuted = Boolean(this._defaultSink.is_muted);
            this._state.volumeFraction = this._state.volumeMuted
                ? 0
                : Math.max(0, Math.min(1, this._defaultSink.volume / maxNorm));
        }
        if (this._defaultSource)
            this._state.micMuted = Boolean(this._defaultSource.is_muted);

        this._emitChanged();
    }

    _syncAudioDeviceList() {
        const list = [];
        const activeStreamId = this._defaultSink?.get_id?.() ?? null;
        for (const [id, dev] of this._outputs.entries()) {
            const origin = dev.get_origin?.();
            const desc = dev.get_description?.() || 'Output';
            const label = origin ? `${desc} (${origin})` : desc;
            const isActive = this._activeOutputId === id ||
                (activeStreamId !== null && dev.get_stream_id?.() === activeStreamId);
            if (isActive)
                this._activeOutputId = id;
            const classification = classifyAudioDevice(dev);
            list.push({
                id,
                label,
                iconName: dev.get_icon_name?.() || 'audio-speakers-symbolic',
                active: isActive,
                deviceType: classification ? classification.type : null,
            });
        }
        this._state.outputs = list;
        this._state.activeOutputId = this._activeOutputId;
        this._emitChanged();
    }

    _emitChanged() {
        this.emit('changed', this.getSnapshot());
    }

    _stop() {
        this._cancellable?.cancel();

        if (this._inhibitCookie) {
            const cookie = this._inhibitCookie;
            this._inhibitCookie = 0;
            this._state.keepAwake = false;
            try {
                Gio.DBus.session.call(
                    SESSION_BUS, SESSION_PATH, SESSION_BUS, 'Uninhibit',
                    new GLib.Variant('(u)', [cookie]),
                    null, Gio.DBusCallFlags.NONE, 1000, null, () => {}
                );
            } catch {}
        }

        if (this._colorSettings && this._colorSigId) {
            try { this._colorSettings.disconnect(this._colorSigId); } catch {}
            this._colorSigId = 0;
        }
        this._colorSettings = null;

        if (this._notifSettings && this._notifSigId) {
            try { this._notifSettings.disconnect(this._notifSigId); } catch {}
            this._notifSigId = 0;
        }
        this._notifSettings = null;

        for (const id of this._wifiDevIds) {
            try { this._wifiDev?.disconnect(id); } catch {}
        }
        this._wifiDevIds = [];
        this._wifiDev = null;

        for (const id of this._nmIds) {
            try { this._nmClient?.disconnect(id); } catch {}
        }
        this._nmIds = [];
        this._nmClient = null;

        for (const id of this._btIds) {
            try { this._btClient?.disconnect(id); } catch {}
        }
        this._btIds = [];

        for (const { dev, sid } of this._btDeviceSigIds.values()) {
            try { dev?.disconnect(sid); } catch {}
        }
        this._btDeviceSigIds.clear();
        this._btConnectedAddresses.clear();
        this._btBootstrapped = false;
        this._btClient = null;

        if (this._rfkillProxy && this._rfkillSigId) {
            try { this._rfkillProxy.disconnect(this._rfkillSigId); } catch {}
            this._rfkillSigId = 0;
        }
        this._rfkillProxy = null;

        for (const id of this._sinkSigIds) {
            try { this._defaultSink?.disconnect(id); } catch {}
        }
        this._sinkSigIds = [];
        this._defaultSink = null;

        for (const id of this._sourceSigIds) {
            try { this._defaultSource?.disconnect(id); } catch {}
        }
        this._sourceSigIds = [];
        this._defaultSource = null;

        for (const id of this._mixerIds) {
            try { this._mixer?.disconnect(id); } catch {}
        }
        this._mixerIds = [];
        this._outputs.clear();
        this._bootstrapped = false;
        this._knownOutputIds.clear();
        this._lastAlertTime.clear();
        this._mixer = null;
    }

    destroy() {
        this._stop();
    }
}
