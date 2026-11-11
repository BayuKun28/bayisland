import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { Weights } from '../core/PriorityManager.js';

const UPOWER_BUS = 'org.freedesktop.UPower';
const UPOWER_PATH = '/org/freedesktop/UPower';
const DISPLAY_DEVICE_PATH = '/org/freedesktop/UPower/devices/DisplayDevice';

const UPOWER_XML = `
<node>
  <interface name="org.freedesktop.UPower">
    <property name="OnBattery" type="b" access="read"/>
  </interface>
</node>`;

const UPOWER_DEVICE_XML = `
<node>
  <interface name="org.freedesktop.UPower.Device">
    <property name="Percentage" type="d" access="read"/>
    <property name="State" type="u" access="read"/>
    <property name="TimeToFull" type="x" access="read"/>
    <property name="TimeToEmpty" type="x" access="read"/>
    <property name="IsPresent" type="b" access="read"/>
  </interface>
</node>`;

const UPowerProxy = Gio.DBusProxy.makeProxyWrapper(UPOWER_XML);
const UPowerDeviceProxy = Gio.DBusProxy.makeProxyWrapper(UPOWER_DEVICE_XML);

// UPower DeviceState enum
const DeviceState = {
    UNKNOWN: 0,
    CHARGING: 1,
    DISCHARGING: 2,
    EMPTY: 3,
    FULLY_CHARGED: 4,
    PENDING_CHARGE: 5,
    PENDING_DISCHARGE: 6,
};

function formatDuration(sec) {
    if (!Number.isFinite(sec) || sec <= 60)
        return null;
    const mins = Math.round(sec / 60);
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/**
 * Monitors UPower DisplayDevice on system D-Bus for charging/unplug/low-battery events,
 * and reads ThinkPad BAT0 charge_control_end_threshold in read-only mode.
 */
export class PowerManager {
    constructor({ signals, priority, onSnapshot }) {
        this._signals = signals;
        this._priority = priority;
        this._onSnapshot = onSnapshot;

        this._enabled = false;
        this._upowerProxy = null;
        this._deviceProxy = null;
        this._initialized = false;
        this._lastOnBattery = null;
        this._lastState = null;
        this._warned20 = false;
        this._warned10 = false;
        this._chargeThreshold = null;
        this._cancellable = new Gio.Cancellable();
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
            percentage: this._deviceProxy?.Percentage ?? 0,
            state: this._deviceProxy?.State ?? DeviceState.UNKNOWN,
            onBattery: Boolean(this._upowerProxy?.OnBattery),
            chargeThreshold: this._chargeThreshold,
        };
    }

    _start() {
        this._stop();
        this._cancellable = new Gio.Cancellable();
        this._readThinkPadThresholdAsync();

        this._upowerProxy = new UPowerProxy(
            Gio.DBus.system,
            UPOWER_BUS,
            UPOWER_PATH,
            (proxy, err) => {
                if (err || !this._enabled)
                    return;
                this._lastOnBattery = Boolean(proxy.OnBattery);
                this._signals.connect(proxy, 'g-properties-changed', () => this._onPowerChanged());
                this._emitSnapshot();
            }
        );

        this._deviceProxy = new UPowerDeviceProxy(
            Gio.DBus.system,
            UPOWER_BUS,
            DISPLAY_DEVICE_PATH,
            (proxy, err) => {
                if (err || !this._enabled)
                    return;
                this._lastState = proxy.State;
                this._initialized = true;
                this._signals.connect(proxy, 'g-properties-changed', () => this._onPowerChanged());
                this._emitSnapshot();
            }
        );
    }

    _readThinkPadThresholdAsync() {
        const file = Gio.File.new_for_path('/sys/class/power_supply/BAT0/charge_control_end_threshold');
        if (!file.query_exists(null))
            return;
        file.load_contents_async(this._cancellable, (f, res) => {
            try {
                const [ok, bytes] = f.load_contents_finish(res);
                if (!ok)
                    return;
                const val = Number.parseInt(new TextDecoder().decode(bytes).trim(), 10);
                if (Number.isFinite(val) && val > 0 && val < 100) {
                    this._chargeThreshold = val;
                    this._emitSnapshot();
                }
            } catch {
                // Ignore if cancelled or unreadable
            }
        });
    }

    _emitSnapshot() {
        const snap = this.getSnapshot();
        this._priority?.updateMeta({
            powerPct: Math.round(snap.percentage ?? 0),
            onBattery: snap.onBattery,
            charging: snap.state === DeviceState.CHARGING || snap.state === DeviceState.PENDING_CHARGE,
        }, { inPlaceHint: true });
        this._onSnapshot?.(snap);
    }

    _onPowerChanged() {
        if (!this._enabled || !this._deviceProxy || !this._upowerProxy)
            return;

        this._emitSnapshot();

        const pct = Math.round(this._deviceProxy.Percentage ?? 0);
        const state = this._deviceProxy.State ?? DeviceState.UNKNOWN;
        const onBattery = Boolean(this._upowerProxy.OnBattery);

        if (!this._initialized) {
            this._lastOnBattery = onBattery;
            this._lastState = state;
            this._initialized = true;
            return;
        }

        const powerSourceChanged = this._lastOnBattery !== null && onBattery !== this._lastOnBattery;
        this._lastOnBattery = onBattery;
        this._lastState = state;

        if (powerSourceChanged) {
            this._readThinkPadThresholdAsync();
            if (!onBattery) {
                this._warned20 = false;
                this._warned10 = false;
                const ttf = formatDuration(this._deviceProxy.TimeToFull);
                const thresholdNote = this._chargeThreshold ? ` • Cap ${this._chargeThreshold}%` : '';
                this._priority.pushTransient({
                    kind: 'power',
                    weight: Weights.POWER,
                    coalesceKey: 'power-ac',
                    title: state === DeviceState.FULLY_CHARGED ? 'Fully Charged' : 'Charging Connected',
                    body: `${ttf ? `${ttf} to full` : 'AC Power'}${thresholdNote}`,
                    iconName: 'battery-good-charging-symbolic',
                    iconColor: '#4ade80',
                    level: pct / 100,
                    maxLevel: 1,
                    alertStyle: 'power',
                    durationMs: 2800,
                });
            } else {
                const tte = formatDuration(this._deviceProxy.TimeToEmpty);
                this._priority.pushTransient({
                    kind: 'power',
                    weight: Weights.POWER,
                    coalesceKey: 'power-ac',
                    title: 'On Battery Power',
                    body: tte ? `${tte} remaining` : 'AC disconnected',
                    iconName: 'battery-good-symbolic',
                    iconColor: '#facc15',
                    level: pct / 100,
                    maxLevel: 1,
                    durationMs: 2400,
                });
            }
            return;
        }

        if (onBattery && pct > 0) {
            if (pct <= 10 && !this._warned10) {
                this._warned10 = true;
                this._priority.pushTransient({
                    kind: 'power',
                    weight: Weights.ALARM,
                    coalesceKey: 'power-low',
                    title: `Critical Battery (${pct}%)`,
                    body: 'Connect ThinkPad USB-C charger soon',
                    iconName: 'battery-caution-symbolic',
                    iconColor: '#ef4444',
                    badgeText: 'LOW',
                    badgeKind: 'error',
                    alertStyle: 'critical',
                    durationMs: 6000,
                });
            } else if (pct <= 20 && !this._warned20) {
                this._warned20 = true;
                this._priority.pushTransient({
                    kind: 'power',
                    weight: Weights.POWER,
                    coalesceKey: 'power-low',
                    title: `Low Battery (${pct}%)`,
                    body: formatDuration(this._deviceProxy.TimeToEmpty) ?? 'Battery running low',
                    iconName: 'battery-low-symbolic',
                    iconColor: '#fb923c',
                    badgeText: `${pct}%`,
                    badgeKind: 'warn',
                    durationMs: 4000,
                });
            }
        }
    }

    _stop() {
        this._cancellable?.cancel();
        this._upowerProxy = null;
        this._deviceProxy = null;
        this._initialized = false;
        this._lastOnBattery = null;
        this._lastState = null;
    }

    destroy() {
        this._cancellable.cancel();
        this._stop();
    }
}
