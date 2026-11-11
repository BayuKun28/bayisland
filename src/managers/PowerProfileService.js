import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

const PP_BUS = 'net.hadess.PowerProfiles';
const PP_PATH = '/net/hadess/PowerProfiles';

const PP_XML = `
<node>
  <interface name="net.hadess.PowerProfiles">
    <property name="ActiveProfile" type="s" access="readwrite"/>
    <property name="PerformanceInhibited" type="s" access="read"/>
    <property name="PerformanceDegraded" type="s" access="read"/>
    <property name="Profiles" type="aa{sv}" access="read"/>
    <property name="Version" type="s" access="read"/>
  </interface>
</node>`;

const PowerProfilesProxy = Gio.DBusProxy.makeProxyWrapper(PP_XML);

const BAT0_DIR = '/sys/class/power_supply/BAT0';

function readTextAsync(path, cancellable) {
    return new Promise(resolve => {
        const file = Gio.File.new_for_path(path);
        if (!file.query_exists(null)) {
            resolve(null);
            return;
        }
        file.load_contents_async(cancellable, (f, res) => {
            try {
                const [ok, bytes] = f.load_contents_finish(res);
                resolve(ok ? new TextDecoder().decode(bytes).trim() : null);
            } catch {
                resolve(null);
            }
        });
    });
}

function parseIntOrNull(str) {
    if (str === null || str === undefined || str === '')
        return null;
    const n = Number.parseInt(str, 10);
    return Number.isFinite(n) ? n : null;
}

function queryRootDiskAsync(cancellable) {
    return new Promise(resolve => {
        try {
            const root = Gio.File.new_for_path('/');
            root.query_filesystem_info_async(
                'filesystem::free,filesystem::size',
                GLib.PRIORITY_DEFAULT,
                cancellable,
                (f, res) => {
                    try {
                        const info = f.query_filesystem_info_finish(res);
                        const freeBytes = info.get_attribute_uint64('filesystem::free');
                        const totalBytes = info.get_attribute_uint64('filesystem::size');
                        if (!totalBytes || totalBytes <= 0) {
                            resolve(null);
                            return;
                        }
                        const gb = 1024 * 1024 * 1024;
                        const usedPct = Math.round(((totalBytes - freeBytes) / totalBytes) * 100);
                        resolve({
                            diskPct: Math.max(0, Math.min(100, usedPct)),
                            diskFreeGb: Math.round(freeBytes / gb),
                            diskTotalGb: Math.round(totalBytes / gb),
                        });
                    } catch {
                        resolve(null);
                    }
                }
            );
        } catch {
            resolve(null);
        }
    });
}

function formatUptime(raw) {
    if (!raw)
        return '—';
    const secs = Number.parseFloat(raw.split(/\s+/)[0]);
    if (!Number.isFinite(secs) || secs < 0)
        return '—';
    const totalMins = Math.floor(secs / 60);
    const days = Math.floor(totalMins / (60 * 24));
    const hrs = Math.floor((totalMins % (60 * 24)) / 60);
    const mins = totalMins % 60;
    if (days > 0)
        return `${days}d ${hrs}h`;
    if (hrs > 0)
        return `${hrs}h ${mins}m`;
    return `${mins}m`;
}

/**
 * Integrates with net.hadess.PowerProfiles (power-saver / balanced / performance)
 * and reads ThinkPad BAT0 + hwmon thermal/fan sensors strictly on-demand when PowerTab is open.
 */
export class PowerProfileService extends Signals.EventEmitter {
    constructor({ signals, timers, priority }) {
        super();
        this._signals = signals;
        this._timers = timers;
        this._priority = priority;

        this._enabled = false;
        this._proxy = null;
        this._propSigId = 0;
        this._cancellable = new Gio.Cancellable();

        this._liveActive = false;
        this._liveTimerId = 0;
        this._hwmonMap = null;
        this._hwmonPromise = null;
        this._prevCpuSample = null;

        this._state = {
            available: false,
            activeProfile: 'balanced',
            profiles: ['power-saver', 'balanced', 'performance'],
            cpuDriver: 'unknown',
            inhibitedReason: '',
            degradedReason: '',
            battery: {
                present: false,
                capacity: null,
                status: 'Unknown',
                cycleCount: null,
                energyFullWh: null,
                energyDesignWh: null,
                healthPct: null,
                powerWatts: null,
                voltageVolts: null,
                model: '',
                manufacturer: '',
                startThreshold: null,
                endThreshold: null,
            },
            thermal: {
                cpuTempC: null,
                nvmeTempC: null,
                chassisTempC: null,
                fanRpm: null,
            },
            system: {
                cpuPct: 0,
                memPct: 0,
                memUsedGb: 0,
                memTotalGb: 0,
                diskPct: 0,
                diskFreeGb: 0,
                diskTotalGb: 0,
                uptimeLabel: '—',
            },
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
        return this._state;
    }

    setActiveProfile(profile) {
        if (!this._proxy || !['power-saver', 'balanced', 'performance'].includes(profile))
            return;

        this._state.activeProfile = profile;
        this._priority?.updateMeta({ powerProfile: profile }, { inPlaceHint: true });
        this.emit('changed', this._state);

        Gio.DBus.system.call(
            PP_BUS,
            PP_PATH,
            'org.freedesktop.DBus.Properties',
            'Set',
            new GLib.Variant('(ssv)', [
                PP_BUS,
                'ActiveProfile',
                new GLib.Variant('s', profile),
            ]),
            null,
            Gio.DBusCallFlags.NONE,
            2000,
            this._cancellable,
            (conn, res) => {
                try {
                    conn.call_finish(res);
                } catch (e) {
                    logError(e, 'BayIsland failed to switch power profile');
                }
            }
        );
    }

    cycleProfile() {
        const avail = this._state.profiles.length > 0
            ? this._state.profiles
            : ['power-saver', 'balanced', 'performance'];
        const curIdx = avail.indexOf(this._state.activeProfile);
        const next = avail[(curIdx + 1) % avail.length];
        this.setActiveProfile(next);
    }

    setLiveMonitoring(active) {
        const want = Boolean(active && this._enabled);
        if (want === this._liveActive)
            return;
        this._liveActive = want;

        if (this._liveTimerId) {
            this._timers.clear(this._liveTimerId);
            this._liveTimerId = 0;
        }

        if (want) {
            this.refreshTelemetryAsync().catch(() => {});
            this._liveTimerId = this._timers.setIntervalSeconds(2, () => {
                if (!this._liveActive)
                    return false;
                this.refreshTelemetryAsync().catch(() => {});
                return true;
            });
        }
    }

    _start() {
        this._cancellable = new Gio.Cancellable();
        this._proxy = new PowerProfilesProxy(
            Gio.DBus.system,
            PP_BUS,
            PP_PATH,
            (proxy, err) => {
                if (err || !this._enabled)
                    return;
                this._state.available = true;
                this._syncProxyProps(proxy);
                this._propSigId = proxy.connect('g-properties-changed', () => {
                    this._syncProxyProps(proxy);
                });
            }
        );
        this.refreshTelemetryAsync().catch(() => {});
    }

    _syncProxyProps(proxy) {
        if (!proxy)
            return;
        const active = proxy.ActiveProfile || 'balanced';
        this._state.activeProfile = active;
        this._state.inhibitedReason = proxy.PerformanceInhibited || '';
        this._state.degradedReason = proxy.PerformanceDegraded || '';

        const rawProfiles = proxy.Profiles || [];
        if (Array.isArray(rawProfiles) && rawProfiles.length > 0) {
            const parsed = [];
            for (const item of rawProfiles) {
                const unpacked = item?.deepUnpack ? item.deepUnpack() : item;
                const name = unpacked?.Profile?.deepUnpack ? unpacked.Profile.deepUnpack() : unpacked?.Profile;
                const drv = unpacked?.CpuDriver?.deepUnpack ? unpacked.CpuDriver.deepUnpack() : unpacked?.CpuDriver;
                if (typeof name === 'string')
                    parsed.push(name);
                if (typeof drv === 'string' && drv)
                    this._state.cpuDriver = drv;
            }
            if (parsed.length > 0)
                this._state.profiles = parsed;
        }

        this._priority?.updateMeta({ powerProfile: active }, { inPlaceHint: true });
        this.emit('changed', this._state);
    }

    async _discoverHwmonMap() {
        if (this._hwmonMap)
            return this._hwmonMap;
        if (this._hwmonPromise)
            return this._hwmonPromise;

        this._hwmonPromise = (async () => {
            const map = {};
            try {
                const dir = Gio.File.new_for_path('/sys/class/hwmon');
                if (!dir.query_exists(null))
                    return map;

                const entries = [];
                const enumerator = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
                let info;
                while ((info = enumerator.next_file(null)) !== null)
                    entries.push(info.get_name());
                enumerator.close(null);

                const names = await Promise.all(
                    entries.map(entry => readTextAsync(`/sys/class/hwmon/${entry}/name`, this._cancellable))
                );
                entries.forEach((entry, idx) => {
                    if (names[idx])
                        map[names[idx]] = `/sys/class/hwmon/${entry}`;
                });
            } catch {
                // Ignore sysfs enumeration error
            }
            this._hwmonMap = map;
            this._hwmonPromise = null;
            return map;
        })();

        return this._hwmonPromise;
    }

    async refreshTelemetryAsync() {
        if (!this._enabled)
            return;

        const cancel = this._cancellable;
        const batKeys = [
            'capacity', 'status', 'cycle_count', 'energy_full',
            'energy_full_design', 'power_now', 'voltage_now',
            'model_name', 'manufacturer',
            'charge_control_start_threshold', 'charge_control_end_threshold',
        ];

        const hwmon = await this._discoverHwmonMap();
        if (!this._enabled || cancel.is_cancelled())
            return;

        const [batValues, cpuRaw, nvmeRaw, tpRaw, fanRaw, procStatRaw, procMemRaw, procUptimeRaw, diskInfo] = await Promise.all([
            Promise.all(batKeys.map(k => readTextAsync(`${BAT0_DIR}/${k}`, cancel))),
            hwmon.coretemp ? readTextAsync(`${hwmon.coretemp}/temp1_input`, cancel) : null,
            hwmon.nvme ? readTextAsync(`${hwmon.nvme}/temp1_input`, cancel) : null,
            hwmon.thinkpad ? readTextAsync(`${hwmon.thinkpad}/temp1_input`, cancel) : null,
            hwmon.thinkpad ? readTextAsync(`${hwmon.thinkpad}/fan1_input`, cancel) : null,
            readTextAsync('/proc/stat', cancel),
            readTextAsync('/proc/meminfo', cancel),
            readTextAsync('/proc/uptime', cancel),
            queryRootDiskAsync(cancel),
        ]);

        if (!this._enabled || cancel.is_cancelled())
            return;

        const bat = Object.fromEntries(batKeys.map((k, idx) => [k, batValues[idx]]));
        const cap = parseIntOrNull(bat.capacity);
        const cycles = parseIntOrNull(bat.cycle_count);
        const eFull = parseIntOrNull(bat.energy_full);
        const eDesign = parseIntOrNull(bat.energy_full_design);
        const powerUw = parseIntOrNull(bat.power_now);
        const voltUv = parseIntOrNull(bat.voltage_now);
        const startThr = parseIntOrNull(bat.charge_control_start_threshold);
        const endThr = parseIntOrNull(bat.charge_control_end_threshold);

        const energyFullWh = eFull ? +(eFull / 1_000_000).toFixed(2) : null;
        const energyDesignWh = eDesign ? +(eDesign / 1_000_000).toFixed(2) : null;
        const healthPct = (eFull && eDesign && eDesign > 0)
            ? +Math.min(100, (eFull / eDesign) * 100).toFixed(1)
            : null;

        const cpuMc = parseIntOrNull(cpuRaw);
        const nvmeMc = parseIntOrNull(nvmeRaw);
        const tpMc = parseIntOrNull(tpRaw);
        const fan = parseIntOrNull(fanRaw);

        this._state.battery = {
            present: cap !== null,
            capacity: cap,
            status: bat.status || 'Unknown',
            cycleCount: cycles,
            energyFullWh,
            energyDesignWh,
            healthPct,
            powerWatts: powerUw !== null ? +(Math.abs(powerUw) / 1_000_000).toFixed(2) : null,
            voltageVolts: voltUv !== null ? +(voltUv / 1_000_000).toFixed(2) : null,
            model: bat.model_name || '',
            manufacturer: bat.manufacturer || '',
            startThreshold: startThr,
            endThreshold: endThr,
        };

        this._state.thermal = {
            cpuTempC: cpuMc !== null ? Math.round(cpuMc / 1000) : null,
            nvmeTempC: nvmeMc !== null ? Math.round(nvmeMc / 1000) : null,
            chassisTempC: tpMc !== null && tpMc > 0 ? Math.round(tpMc / 1000) : null,
            fanRpm: fan !== null ? fan : null,
        };

        let cpuPct = this._state.system.cpuPct ?? 0;
        if (procStatRaw) {
            const firstLine = procStatRaw.split('\n')[0];
            if (firstLine?.startsWith('cpu ')) {
                const nums = firstLine.trim().split(/\s+/).slice(1).map(Number);
                if (nums.length >= 4) {
                    const idle = (nums[3] || 0) + (nums[4] || 0);
                    const total = nums.reduce((acc, v) => acc + (Number.isFinite(v) ? v : 0), 0);
                    if (this._prevCpuSample) {
                        const dt = total - this._prevCpuSample.total;
                        const di = idle - this._prevCpuSample.idle;
                        if (dt > 0)
                            cpuPct = Math.max(0, Math.min(100, Math.round(((dt - di) / dt) * 100)));
                    }
                    this._prevCpuSample = { idle, total };
                }
            }
        }

        let memPct = this._state.system.memPct ?? 0;
        let memUsedGb = this._state.system.memUsedGb ?? 0;
        let memTotalGb = this._state.system.memTotalGb ?? 0;
        if (procMemRaw) {
            let totalKb = 0;
            let availKb = 0;
            for (const line of procMemRaw.split('\n')) {
                if (line.startsWith('MemTotal:'))
                    totalKb = Number.parseInt(line.split(/\s+/)[1], 10);
                else if (line.startsWith('MemAvailable:'))
                    availKb = Number.parseInt(line.split(/\s+/)[1], 10);
                if (totalKb > 0 && availKb > 0)
                    break;
            }
            if (totalKb > 0 && availKb >= 0) {
                const usedKb = Math.max(0, totalKb - availKb);
                memPct = Math.max(0, Math.min(100, Math.round((usedKb / totalKb) * 100)));
                memUsedGb = +(usedKb / (1024 * 1024)).toFixed(1);
                memTotalGb = +(totalKb / (1024 * 1024)).toFixed(1);
            }
        }

        this._state.system = {
            cpuPct,
            memPct,
            memUsedGb,
            memTotalGb,
            diskPct: diskInfo?.diskPct ?? this._state.system.diskPct ?? 0,
            diskFreeGb: diskInfo?.diskFreeGb ?? this._state.system.diskFreeGb ?? 0,
            diskTotalGb: diskInfo?.diskTotalGb ?? this._state.system.diskTotalGb ?? 0,
            uptimeLabel: formatUptime(procUptimeRaw),
        };

        this.emit('changed', this._state);
    }

    _stop() {
        this.setLiveMonitoring(false);
        this._cancellable?.cancel();
        if (this._proxy && this._propSigId) {
            try { this._proxy.disconnect(this._propSigId); } catch {}
            this._propSigId = 0;
        }
        this._proxy = null;
        this._hwmonMap = null;
        this._hwmonPromise = null;
        this._prevCpuSample = null;
    }

    destroy() {
        this._stop();
    }
}
