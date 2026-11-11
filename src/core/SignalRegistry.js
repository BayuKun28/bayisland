import Gio from 'gi://Gio';

/**
 * Tracks GObject signal connections and D-Bus signal subscriptions
 * so disable() guarantees zero lingering callbacks or leaks.
 */
export class SignalRegistry {
    constructor() {
        this._signals = [];
        this._dbusSubs = [];
    }

    connect(obj, signalName, handler) {
        if (!obj || typeof obj.connect !== 'function')
            return 0;

        const id = obj.connect(signalName, handler);
        const entry = { obj, id, destroyId: 0 };

        // Guard against calling obj.disconnect() after a Clutter/GObject actor is disposed
        if (typeof obj.connect === 'function' && obj.constructor?.$gtype) {
            try {
                entry.destroyId = obj.connect('destroy', () => {
                    entry.id = 0;
                    entry.destroyId = 0;
                    entry.obj = null;
                });
            } catch {
                // Non-Clutter GObjects (e.g., Gio.Settings, Meta.Display) may not have 'destroy'
            }
        }

        this._signals.push(entry);
        return id;
    }

    subscribeDBus(connection, sender, iface, member, objectPath, arg0, flags, handler) {
        const bus = connection ?? Gio.DBus.session;
        const id = bus.signal_subscribe(
            sender ?? null,
            iface ?? null,
            member ?? null,
            objectPath ?? null,
            arg0 ?? null,
            flags ?? Gio.DBusSignalFlags.NONE,
            handler
        );
        this._dbusSubs.push({ bus, id });
        return id;
    }

    disconnectAll() {
        for (const entry of this._signals) {
            if (!entry.obj)
                continue;
            try {
                if (entry.destroyId)
                    entry.obj.disconnect(entry.destroyId);
                if (entry.id)
                    entry.obj.disconnect(entry.id);
            } catch {
                // Object already disposed
            }
            entry.obj = null;
            entry.id = 0;
            entry.destroyId = 0;
        }
        this._signals = [];

        for (const sub of this._dbusSubs) {
            try {
                sub.bus.signal_unsubscribe(sub.id);
            } catch {
                // Ignore cleanup failure
            }
        }
        this._dbusSubs = [];
    }
}
