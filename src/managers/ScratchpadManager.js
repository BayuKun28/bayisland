import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

/**
 * ScratchpadManager manages persistent scratchpad tasks (to-do items)
 * stored in ~/.cache/bayisland/scratchpad.json.
 */
export class ScratchpadManager extends Signals.EventEmitter {
    constructor() {
        super();
        this._tasks = this._load();
    }

    getTasks() {
        return [...this._tasks];
    }

    getPendingCount() {
        return this._tasks.filter(t => !t.done).length;
    }

    hasDoneTasks() {
        return this._tasks.some(t => t.done);
    }

    addTask(text) {
        const clean = (text || '').trim();
        if (!clean)
            return null;
        const task = {
            id: Date.now(),
            text: clean,
            done: false,
        };
        this._tasks.unshift(task);
        this._save();
        return task;
    }

    toggleTask(id) {
        const item = this._tasks.find(t => t.id === id);
        if (!item)
            return false;
        item.done = !item.done;
        this._save();
        return true;
    }

    deleteTask(id) {
        const initialLen = this._tasks.length;
        this._tasks = this._tasks.filter(t => t.id !== id);
        if (this._tasks.length !== initialLen) {
            this._save();
            return true;
        }
        return false;
    }

    clearDone() {
        const initialLen = this._tasks.length;
        this._tasks = this._tasks.filter(t => !t.done);
        if (this._tasks.length !== initialLen) {
            this._save();
            return true;
        }
        return false;
    }

    _load() {
        try {
            const dirPath = GLib.build_filenamev([GLib.get_user_cache_dir(), 'bayisland']);
            const path = GLib.build_filenamev([dirPath, 'scratchpad.json']);
            const file = Gio.File.new_for_path(path);
            if (!file.query_exists(null))
                return [];
            const [, bytes] = file.load_contents(null);
            const str = new TextDecoder().decode(bytes);
            const data = JSON.parse(str);
            return Array.isArray(data) ? data : [];
        } catch {
            return [];
        }
    }

    _save() {
        try {
            const dirPath = GLib.build_filenamev([GLib.get_user_cache_dir(), 'bayisland']);
            GLib.mkdir_with_parents(dirPath, 0o755);
            const path = GLib.build_filenamev([dirPath, 'scratchpad.json']);
            const file = Gio.File.new_for_path(path);
            const bytes = new TextEncoder().encode(JSON.stringify(this._tasks, null, 2));
            file.replace_contents_async(
                bytes,
                null,
                false,
                Gio.FileCreateFlags.REPLACE_DESTINATION,
                null,
                (f, res) => {
                    try { f.replace_contents_finish(res); } catch {}
                }
            );
        } catch {}
        this.emit('changed', this.getPendingCount());
    }

    destroy() {
        this._tasks = [];
    }
}
