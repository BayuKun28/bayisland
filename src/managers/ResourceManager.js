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
        this._cpuThreshold = 90;
        this._ramThreshold = 90;

        this._pollId = 0;
        this._cancellable = new Gio.Cancellable();
        this._prevCpu = null;
        this._cpuStreak = 0;
        this._ramStreak = 0;
        this._lastAlertMonoSec = 0;
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

    _stop() {
        this._cancellable.cancel();
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
