import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { Weights } from '../core/PriorityManager.js';

const COOLDOWN_SEC = 60;

/**
 * Lightweight async /proc/stat & /proc/meminfo monitor with hysteresis
 * (requires 2 consecutive threshold breaches) and 60s alert cooldown.
 */
export class ResourceManager {
    constructor({ timers, priority }) {
        this._timers = timers;
        this._priority = priority;

        this._enabled = false;
        this._netHudEnabled = true;
        this._cpuThreshold = 90;
        this._ramThreshold = 90;

        this._pollId = 0;
        this._netPollId = 0;
        this._cancellable = new Gio.Cancellable();
        this._netCancellable = new Gio.Cancellable();
        this._prevCpu = null;
        this._prevNetSample = null;
        this._netWasActive = false;
        this._cpuStreak = 0;
        this._ramStreak = 0;
        this._lastAlertMonoSec = 0;
    }

    setNetworkHudEnabled(enabled) {
        const want = Boolean(enabled);
        if (want === this._netHudEnabled)
            return;
        this._netHudEnabled = want;
        if (want) {
            this._startNet();
        } else {
            this._stopNet();
            if (this._netWasActive) {
                this._netWasActive = false;
                this._priority.updateMeta({
                    netSpeed: { active: false, summary: '', rxStr: '', txStr: '', rxRate: 0, txRate: 0 },
                }, { inPlaceHint: true });
            }
        }
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

    setThresholds(cpuPct, ramPct) {
        this._cpuThreshold = Math.max(50, Math.min(99, cpuPct));
        this._ramThreshold = Math.max(50, Math.min(99, ramPct));
    }

    _start() {
        this._stop();
        this._cancellable = new Gio.Cancellable();
        this._prevCpu = null;
        this._cpuStreak = 0;
        this._ramStreak = 0;

        this._pollId = this._timers.setIntervalSeconds(4, () => {
            if (!this._enabled)
                return false;
            this._sampleAsync();
            return true;
        });

        if (this._netHudEnabled)
            this._startNet();
    }

    _sampleAsync() {
        const statFile = Gio.File.new_for_path('/proc/stat');
        const memFile = Gio.File.new_for_path('/proc/meminfo');

        statFile.load_contents_async(this._cancellable, (f, res) => {
            try {
                const [ok, bytes] = f.load_contents_finish(res);
                if (!ok || !this._enabled)
                    return;
                const cpuPct = this._parseCpuUsage(new TextDecoder().decode(bytes));
                if (cpuPct !== null)
                    this._handleCpuSample(cpuPct);
            } catch {
                // Ignore cancelled read
            }
        });

        memFile.load_contents_async(this._cancellable, (f, res) => {
            try {
                const [ok, bytes] = f.load_contents_finish(res);
                if (!ok || !this._enabled)
                    return;
                const ramPct = this._parseMemUsage(new TextDecoder().decode(bytes));
                if (ramPct !== null)
                    this._handleRamSample(ramPct);
            } catch {
                // Ignore cancelled read
            }
        });
    }

    _parseCpuUsage(text) {
        const firstLine = text.split('\n')[0];
        if (!firstLine?.startsWith('cpu '))
            return null;
        const parts = firstLine.trim().split(/\s+/).slice(1).map(Number);
        if (parts.length < 4)
            return null;

        const idle = (parts[3] || 0) + (parts[4] || 0);
        const total = parts.reduce((acc, v) => acc + (Number.isFinite(v) ? v : 0), 0);

        if (!this._prevCpu) {
            this._prevCpu = { idle, total };
            return null;
        }

        const diffTotal = total - this._prevCpu.total;
        const diffIdle = idle - this._prevCpu.idle;
        this._prevCpu = { idle, total };
        if (diffTotal <= 0)
            return null;

        return Math.round(((diffTotal - diffIdle) / diffTotal) * 100);
    }

    _parseMemUsage(text) {
        let totalKb = 0;
        let availKb = 0;
        for (const line of text.split('\n')) {
            if (line.startsWith('MemTotal:'))
                totalKb = Number.parseInt(line.split(/\s+/)[1], 10);
            else if (line.startsWith('MemAvailable:'))
                availKb = Number.parseInt(line.split(/\s+/)[1], 10);
            if (totalKb > 0 && availKb > 0)
                break;
        }
        if (!totalKb || !availKb)
            return null;
        return Math.round(((totalKb - availKb) / totalKb) * 100);
    }

    _handleCpuSample(cpuPct) {
        if (cpuPct >= this._cpuThreshold)
            this._cpuStreak++;
        else
            this._cpuStreak = 0;

        if (this._cpuStreak >= 2) {
            this._cpuStreak = 0;
            this._triggerWarning('CPU Load Spike', `Processor sustained at ${cpuPct}%`, `${cpuPct}%`);
        }
    }

    _handleRamSample(ramPct) {
        if (ramPct >= this._ramThreshold)
            this._ramStreak++;
        else
            this._ramStreak = 0;

        if (this._ramStreak >= 2) {
            this._ramStreak = 0;
            this._triggerWarning('Memory Pressure', `RAM usage sustained at ${ramPct}%`, `${ramPct}%`);
        }
    }

    _triggerWarning(title, body, badge) {
        const nowSec = Math.floor(GLib.get_monotonic_time() / 1_000_000);
        if (nowSec - this._lastAlertMonoSec < COOLDOWN_SEC)
            return;

        this._lastAlertMonoSec = nowSec;
        this._priority.pushTransient({
            kind: 'resource',
            weight: Weights.RESOURCE,
            coalesceKey: 'resource-spike',
            title,
            body,
            iconName: 'utilities-system-monitor-symbolic',
            iconColor: '#ef4444',
            badgeText: badge,
            badgeKind: 'error',
            alertStyle: 'critical',
            durationMs: 4000,
        });
    }

    _startNet() {
        this._stopNet();
        this._netCancellable = new Gio.Cancellable();
        this._prevNetSample = null;
        this._sampleNetAsync();
        this._netPollId = this._timers.setIntervalSeconds(2, () => {
            if (!this._netHudEnabled)
                return false;
            this._sampleNetAsync();
            return true;
        });
    }

    _stopNet() {
        this._netCancellable?.cancel();
        if (this._netPollId) {
            this._timers.clear(this._netPollId);
            this._netPollId = 0;
        }
        this._prevNetSample = null;
    }

    _sampleNetAsync() {
        const netFile = Gio.File.new_for_path('/proc/net/dev');
        netFile.load_contents_async(this._netCancellable, (f, res) => {
            try {
                const [ok, bytes] = f.load_contents_finish(res);
                if (!ok || !this._netHudEnabled)
                    return;
                const text = new TextDecoder().decode(bytes);
                this._parseNetDev(text);
            } catch {
                // Cancelled or missing
            }
        });
    }

    _parseNetDev(text) {
        let totalRx = 0;
        let totalTx = 0;
        const lines = text.split('\n');

        for (const line of lines) {
            const colonIdx = line.indexOf(':');
            if (colonIdx === -1)
                continue;

            const iface = line.slice(0, colonIdx).trim();
            if (iface === 'lo' ||
                iface.startsWith('docker') ||
                iface.startsWith('br-') ||
                iface.startsWith('veth') ||
                iface.startsWith('virbr'))
                continue;

            const data = line.slice(colonIdx + 1).trim().split(/\s+/);
            if (data.length < 9)
                continue;

            const rx = Number(data[0]) || 0;
            const tx = Number(data[8]) || 0;
            totalRx += rx;
            totalTx += tx;
        }

        const nowMono = GLib.get_monotonic_time();
        if (!this._prevNetSample) {
            this._prevNetSample = { timeMono: nowMono, rx: totalRx, tx: totalTx };
            return;
        }

        const dtSec = Math.max(0.5, (nowMono - this._prevNetSample.timeMono) / 1_000_000);
        const rxRate = Math.max(0, (totalRx - this._prevNetSample.rx) / dtSec);
        const txRate = Math.max(0, (totalTx - this._prevNetSample.tx) / dtSec);
        this._prevNetSample = { timeMono: nowMono, rx: totalRx, tx: totalTx };

        const thresholdEnter = rxRate >= 60 * 1024 || txRate >= 40 * 1024;
        const thresholdExit = rxRate < 25 * 1024 && txRate < 25 * 1024;
        const isActive = this._netWasActive ? !thresholdExit : thresholdEnter;

        if (isActive) {
            this._netWasActive = true;
            const rxStr = this._formatRate(rxRate);
            const txStr = this._formatRate(txRate);
            const summary = `↓ ${rxStr}  ↑ ${txStr}`;
            this._priority.updateMeta({
                netSpeed: {
                    active: true,
                    summary,
                    rxStr,
                    txStr,
                    rxRate: Math.round(rxRate),
                    txRate: Math.round(txRate),
                },
            }, { inPlaceHint: true });
        } else if (this._netWasActive) {
            this._netWasActive = false;
            this._priority.updateMeta({
                netSpeed: {
                    active: false,
                    summary: '',
                    rxStr: '',
                    txStr: '',
                    rxRate: 0,
                    txRate: 0,
                },
            }, { inPlaceHint: true });
        }
    }

    _formatRate(bytesPerSec) {
        if (!bytesPerSec || bytesPerSec < 1024)
            return `${Math.round(bytesPerSec || 0)} B/s`;
        if (bytesPerSec < 1024 * 1024)
            return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
        if (bytesPerSec < 1024 * 1024 * 1024)
            return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
        return `${(bytesPerSec / (1024 * 1024 * 1024)).toFixed(2)} GB/s`;
    }

    _stop() {
        this._cancellable.cancel();
        this._stopNet();
        if (this._pollId) {
            this._timers.clear(this._pollId);
            this._pollId = 0;
        }
        this._prevCpu = null;
        this._cpuStreak = 0;
        this._ramStreak = 0;
    }

    destroy() {
        this._stop();
    }
}
