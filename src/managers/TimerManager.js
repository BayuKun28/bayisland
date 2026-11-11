import GLib from 'gi://GLib';

import { Weights } from '../core/PriorityManager.js';

/**
 * Monotonic countdown & Pomodoro timer engine.
 */
export class TimerManager {
    constructor({ timers, priority }) {
        this._timers = timers;
        this._priority = priority;

        this._enabled = true;
        this._active = false;
        this._running = false;
        this._mode = 'countdown';
        this._label = 'Timer';
        this._totalSec = 0;
        this._remainingSec = 0;
        this._targetMonoUs = 0;
        this._tickId = 0;
    }

    setEnabled(enabled) {
        this._enabled = Boolean(enabled);
        if (!this._enabled)
            this.stop();
    }

    start(seconds, mode = 'countdown', label = 'Timer') {
        if (!this._enabled)
            return;
        const sec = Math.max(1, Math.round(seconds));
        this._active = true;
        this._running = true;
        this._mode = mode;
        this._label = label || 'Timer';
        this._totalSec = sec;
        this._remainingSec = sec;
        this._targetMonoUs = GLib.get_monotonic_time() + sec * 1_000_000;

        this._startTicker();
        this._publish(false);
    }

    togglePause() {
        if (!this._active)
            return;

        if (this._running) {
            this._syncRemaining();
            this._running = false;
            this._stopTicker();
        } else {
            this._running = true;
            this._targetMonoUs = GLib.get_monotonic_time() + this._remainingSec * 1_000_000;
            this._startTicker();
        }
        this._publish(true);
    }

    addSeconds(deltaSec) {
        if (!this._active)
            return;
        this._syncRemaining();
        this._remainingSec = Math.max(1, this._remainingSec + deltaSec);
        this._totalSec = Math.max(this._totalSec, this._remainingSec);
        if (this._running)
            this._targetMonoUs = GLib.get_monotonic_time() + this._remainingSec * 1_000_000;
        this._publish(true);
    }

    stop() {
        this._stopTicker();
        this._active = false;
        this._running = false;
        this._remainingSec = 0;
        this._priority.updatePersistent('timer', { active: false });
    }

    _startTicker() {
        this._stopTicker();
        this._tickId = this._timers.setInterval(500, () => {
            if (!this._active || !this._running)
                return false;

            const prev = this._remainingSec;
            this._syncRemaining();

            if (this._remainingSec <= 0) {
                this._onFinished();
                return false;
            }
            if (this._remainingSec !== prev)
                this._publish(true);
            return true;
        });
    }

    _syncRemaining() {
        if (!this._running)
            return;
        const diffUs = this._targetMonoUs - GLib.get_monotonic_time();
        this._remainingSec = Math.max(0, Math.ceil(diffUs / 1_000_000));
    }

    _onFinished() {
        const finishedLabel = this._label;
        const wasPomodoro = this._mode === 'pomodoro';
        this.stop();

        try {
            global.display.get_sound_player()?.play_from_theme('alarm-clock-elapsed', finishedLabel, null);
        } catch {
            // Optional sound
        }

        this._priority.pushTransient({
            kind: 'alarm',
            weight: Weights.ALARM,
            coalesceKey: 'timer-alarm',
            title: `${finishedLabel} Finished`,
            body: wasPomodoro ? 'Take a 5m break or dismiss' : 'Countdown completed',
            iconName: 'alarm-symbolic',
            iconColor: '#fbbf24',
            badgeText: 'DONE',
            badgeKind: 'warn',
            alertStyle: 'critical',
            sticky: true,
            actions: [
                {
                    label: '+5m Break',
                    primary: true,
                    callback: () => this.start(300, 'countdown', 'Break'),
                },
                {
                    label: 'Dismiss',
                    callback: () => {},
                },
            ],
        });
    }

    _publish(inPlaceHint) {
        if (!this._active) {
            this._priority.updatePersistent('timer', { active: false });
            return;
        }
        this._priority.updatePersistent('timer', {
            active: true,
            running: this._running,
            mode: this._mode,
            label: this._label,
            totalSec: this._totalSec,
            remainingSec: this._remainingSec,
        }, { inPlaceHint });
    }

    _stopTicker() {
        if (this._tickId) {
            this._timers.clear(this._tickId);
            this._tickId = 0;
        }
    }

    destroy() {
        this._stopTicker();
        this._active = false;
    }
}
