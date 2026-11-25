import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Weights } from '../core/PriorityManager.js';

/**
 * ScreencastManager monitors GNOME Shell's native screen recording state
 * and manages elapsed time tracking for the live recording island capsule.
 */
export class ScreencastManager {
    constructor({ signals, timers, priority }) {
        this._signals = signals;
        this._timers = timers;
        this._priority = priority;
        this._enabled = false;
        this._tickerId = 0;
        this._startTime = 0;
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

    stopRecording() {
        try {
            Main.screenshotUI?.stopScreencast?.();
        } catch (e) {
            logError(e, 'BayIsland stopRecording failed');
        }
    }

    _start() {
        if (!Main.screenshotUI)
            return;

        this._signals.connect(Main.screenshotUI, 'notify::screencast-in-progress', () => {
            this._onStateChanged();
        });

        this._onStateChanged();
    }

    _onStateChanged() {
        if (!this._enabled || !Main.screenshotUI)
            return;

        const isRecording = Boolean(Main.screenshotUI.screencast_in_progress);
        if (isRecording) {
            this._startTime = Math.floor(Date.now() / 1000);
            this._priority.updatePersistent('recording', {
                active: true,
                elapsedSec: 0,
                startTime: this._startTime,
            });

            this._clearTicker();
            this._tickerId = this._timers.setInterval(1000, () => {
                const now = Math.floor(Date.now() / 1000);
                const elapsed = Math.max(0, now - this._startTime);
                this._priority.updatePersistent('recording', {
                    active: true,
                    elapsedSec: elapsed,
                }, { inPlaceHint: true });
            });
        } else {
            const wasActive = Boolean(this._priority.getModel()?.persistent?.recording?.active);
            this._clearTicker();
            this._priority.updatePersistent('recording', { active: false });

            if (wasActive) {
                this._priority.pushTransient({
                    kind: 'screencast',
                    weight: Weights.TASK,
                    title: 'Screencast Recorded',
                    body: 'Saved to Videos folder',
                    iconName: 'screencast-recorded-symbolic',
                    iconColor: '#ef4444',
                    durationMs: 3200,
                });
            }
        }
    }

    _clearTicker() {
        if (this._tickerId) {
            this._timers.clear(this._tickerId);
            this._tickerId = 0;
        }
    }

    _stop() {
        this._clearTicker();
        this._priority?.updatePersistent('recording', { active: false });
    }

    destroy() {
        this._stop();
        this._enabled = false;
    }
}
