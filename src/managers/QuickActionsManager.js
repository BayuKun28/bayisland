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
            for (let i = 0; i < n; i++) {
                const dev = store.get_item(i);
                if (dev?.connected)
                    connectedNames.push(dev.alias || dev.name || 'Device');
            }
        } catch {
            // Ignore
        }

        this._state.btAvailable = hasAdapter && !hardwareBlocked;
        this._state.btEnabled = Boolean(this._btClient.default_adapter_powered);
        this._state.btConnectedNames = connectedNames;
        this._emitChanged();
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
                this._mixer.connect('active-output-update', (_c, id) => {
                    this._activeOutputId = id;
                    this._syncAudioDeviceList();
                })
            );
            this._rebuildAudioDevices();
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
            if (uiDev)
                this._outputs.set(uiDev.get_id(), uiDev);
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
    }

    _removeOutputDevice(id) {
        this._outputs.delete(id);
        if (this._activeOutputId === id)
            this._activeOutputId = null;
        this._syncAudioDeviceList();
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
            if (activeDev)
                this._activeOutputId = activeDev.get_id();
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
            list.push({
                id,
                label,
                iconName: dev.get_icon_name?.() || 'audio-speakers-symbolic',
                active: isActive,
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
        this._mixer = null;
    }

    destroy() {
        this._stop();
    }
}
