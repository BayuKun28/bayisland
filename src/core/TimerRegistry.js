import GLib from 'gi://GLib';

/**
 * Tracks GLib timers/idles and cleans them all up on disable().
 */
export class TimerRegistry {
    constructor() {
        this._sources = new Set();
    }

    setTimeout(a, b) {
        const ms = typeof a === 'number' ? a : (typeof b === 'number' ? b : 0);
        const callback = typeof a === 'function' ? a : b;
        const delay = Math.max(0, Math.round(ms));
        let id = 0;
        id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._sources.delete(id);
            if (typeof callback === 'function')
                callback();
            return GLib.SOURCE_REMOVE;
        });
        this._sources.add(id);
        return id;
    }

    setInterval(a, b) {
        const ms = typeof a === 'number' ? a : (typeof b === 'number' ? b : 16);
        const callback = typeof a === 'function' ? a : b;
        const interval = Math.max(16, Math.round(ms));
        let id = 0;
        id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, interval, () => {
            let keep = true;
            if (typeof callback === 'function')
                keep = callback();
            if (keep === GLib.SOURCE_REMOVE || keep === false) {
                this._sources.delete(id);
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
        this._sources.add(id);
        return id;
    }

    setIntervalSeconds(seconds, callback) {
        const interval = Math.max(1, Math.round(seconds));
        let id = 0;
        id = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, interval, () => {
            const keep = callback();
            if (keep === GLib.SOURCE_REMOVE || keep === false) {
                this._sources.delete(id);
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
        this._sources.add(id);
        return id;
    }

    clear(id) {
        if (!id)
            return;
        if (this._sources.has(id)) {
            this._sources.delete(id);
            GLib.source_remove(id);
        }
    }

    clearAll() {
        for (const id of this._sources) {
            try {
                GLib.source_remove(id);
            } catch {
                // Already removed
            }
        }
        this._sources.clear();
    }
}
