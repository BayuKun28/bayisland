import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';
import { InjectionManager } from 'resource:///org/gnome/shell/extensions/extension.js';

import { Weights } from '../core/PriorityManager.js';

/**
 * Intercepts Main.messageTray._showNotification for BayIsland peeking
 * AND maintains a live two-way synchronized list of MessageTray notifications
 * plus recent Terminal Task Done entries without mutating DateMenu / Quick Settings.
 */
export class NotificationManager extends Signals.EventEmitter {
    constructor({ timers, priority }) {
        super();
        this._timers = timers;
        this._priority = priority;
        this._injection = new InjectionManager();

        this._enabled = false;
        this._durationMs = 4000;
        this._activeNotif = null;
        this._activeDestroyId = 0;
        this._nextQueueTimerId = 0;

        this._trayWatching = false;
        this._sourceAddedId = 0;
        this._sourceRemovedId = 0;
        this._trackedSources = new Map();
        this._liveItems = new Map(); // id -> record
        this._taskItems = [];
        this._nextItemId = 1;
    }

    startWatchingTray() {
        if (this._trayWatching)
            return;
        const tray = Main.messageTray;
        if (!tray)
            return;
        this._trayWatching = true;

        this._sourceAddedId = tray.connect('source-added', (_t, src) => this._trackSource(src));
        this._sourceRemovedId = tray.connect('source-removed', (_t, src) => this._untrackSource(src));
        for (const src of tray.getSources())
            this._trackSource(src);
        this._publishTrayMeta();
    }

    setEnabled(enabled) {
        const want = Boolean(enabled);
        if (want === this._enabled)
            return;
        this._enabled = want;

        if (want)
            this._hook();
        else
            this._unhook();
    }

    setDurationMs(ms) {
        this._durationMs = Math.max(1500, Math.round(ms));
    }

    recordTaskItem({ title, body, success, durationSec }) {
        this._taskItems.unshift({
            id: `task-${this._nextItemId++}`,
            kind: 'task',
            title: title || 'Terminal Task',
            body: body || (success ? 'Completed' : 'Failed'),
            sourceTitle: durationSec > 0 ? `CLI • ${durationSec}s` : 'CLI',
            iconName: success ? 'emblem-ok-symbolic' : 'dialog-error-symbolic',
            timestampMs: Date.now(),
            success: Boolean(success),
        });
        if (this._taskItems.length > 15)
            this._taskItems.length = 15;
        this._publishTrayMeta();
    }

    getHistory() {
        const notifs = [];
        for (const rec of this._liveItems.values()) {
            const n = rec.notif;
            notifs.push({
                id: rec.id,
                kind: 'notification',
                title: n.title || n.source?.title || 'Notification',
                body: n.bannerBodyText || n.body || '',
                sourceTitle: n.source?.title || '',
                icon: n.gicon ?? n.source?.icon ?? null,
                urgent: n.urgency === MessageTray.Urgency.CRITICAL,
                timestampMs: rec.timestampMs,
                actions: (n.actions ?? []).slice(0, 2).map((a, idx) => ({
                    index: idx,
                    label: a.label,
                })),
            });
        }
        notifs.sort((a, b) => b.timestampMs - a.timestampMs);

        return {
            notifications: notifs,
            tasks: [...this._taskItems],
            totalUnread: notifs.length,
        };
    }

    activateNotification(id) {
        const rec = this._liveItems.get(id);
        if (!rec)
            return;
        try {
            rec.notif.activate();
        } catch {
            // Ignore
        }
    }

    invokeAction(id, actionIdx) {
        const rec = this._liveItems.get(id);
        const act = rec?.notif?.actions?.[actionIdx];
        if (!act)
            return;
        try {
            act.activate();
        } catch {
            // Ignore
        }
    }

    dismissItem(id) {
        const taskIdx = this._taskItems.findIndex(t => t.id === id);
        if (taskIdx !== -1) {
            this._taskItems.splice(taskIdx, 1);
            this._publishTrayMeta();
            return;
        }
        const rec = this._liveItems.get(id);
        if (!rec)
            return;
        try {
            rec.notif.destroy(MessageTray.NotificationDestroyedReason.DISMISSED);
        } catch {
            this._removeLiveItem(id);
        }
    }

    clearAll() {
        this._taskItems = [];
        for (const rec of [...this._liveItems.values()]) {
            try {
                rec.notif.destroy(MessageTray.NotificationDestroyedReason.DISMISSED);
            } catch {
                // Handled by destroy signal or cleanup
            }
        }
        this._publishTrayMeta();
    }

    _trackSource(source) {
        if (!source || this._trackedSources.has(source))
            return;

        const notifAddedId = source.connect('notification-added', (_src, notif) => {
            this._trackNotification(notif);
        });
        const destroyId = source.connect('destroy', () => {
            this._untrackSource(source);
        });
        this._trackedSources.set(source, { notifAddedId, destroyId });

        for (const notif of (source.notifications ?? []))
            this._trackNotification(notif);
    }

    _untrackSource(source) {
        const entry = this._trackedSources.get(source);
        if (!entry)
            return;
        try { source.disconnect(entry.notifAddedId); } catch {}
        try { source.disconnect(entry.destroyId); } catch {}
        this._trackedSources.delete(source);
    }

    _trackNotification(notif) {
        if (!notif)
            return;
        for (const rec of this._liveItems.values()) {
            if (rec.notif === notif) {
                rec.timestampMs = Date.now();
                this._publishTrayMeta();
                return;
            }
        }

        const id = `notif-${this._nextItemId++}`;
        const destroyId = notif.connect('destroy', () => {
            this._removeLiveItem(id);
        });
        this._liveItems.set(id, {
            id,
            notif,
            destroyId,
            timestampMs: Date.now(),
        });
        this._publishTrayMeta();
    }

    _removeLiveItem(id) {
        const rec = this._liveItems.get(id);
        if (!rec)
            return;
        if (rec.destroyId) {
            try { rec.notif.disconnect(rec.destroyId); } catch {}
        }
        this._liveItems.delete(id);
        this._publishTrayMeta();
    }

    _publishTrayMeta() {
        const count = this._liveItems.size;
        this._priority?.updateMeta({ unreadNotifs: count }, { inPlaceHint: true });
        this.emit('changed', this.getHistory());
    }

    _hook() {
        const tray = Main.messageTray;
        if (!tray)
            return;

        const self = this;
        this._injection.overrideMethod(tray, '_showNotification', () => {
            return function () {
                const notification = this._notificationQueue.shift();
                this.emit('queue-changed');
                if (!notification)
                    return;

                self._trackNotification(notification);
                notification.acknowledged = true;
                try {
                    notification.playSound();
                } catch {
                    // Best effort
                }

                self._presentNotification(notification);
            };
        });
    }

    _presentNotification(notification) {
        this._clearActiveNotif();
        this._activeNotif = notification;

        const actions = (notification.actions ?? []).slice(0, 2).map(act => ({
            label: act.label,
            primary: false,
            callback: () => {
                try {
                    act.activate();
                } catch {
                    // Ignore
                }
            },
        }));

        actions.push({
            label: 'Clear',
            callback: () => {
                try {
                    notification.destroy(MessageTray.NotificationDestroyedReason.DISMISSED);
                } catch {
                    // Ignore
                }
            },
        });

        const isCritical = notification.urgency === MessageTray.Urgency.CRITICAL;
        const icon = notification.gicon ?? notification.source?.icon ?? null;
        const transientId = this._priority.pushTransient({
            kind: 'notification',
            weight: isCritical ? Weights.ALARM : Weights.NOTIFICATION,
            title: notification.title || notification.source?.title || 'Notification',
            body: notification.bannerBodyText || notification.body || '',
            icon,
            iconName: icon ? undefined : 'preferences-system-notifications-symbolic',
            alertStyle: isCritical ? 'critical' : undefined,
            durationMs: isCritical ? Math.max(6000, this._durationMs) : this._durationMs,
            actions,
            onActivate: () => {
                try {
                    notification.activate();
                } catch {
                    // Ignore
                }
            },
            onDismiss: () => {
                this._clearActiveNotif();
                if (this._enabled && Main.messageTray?.queueCount > 0 && !this._nextQueueTimerId) {
                    this._nextQueueTimerId = this._timers.setTimeout(180, () => {
                        this._nextQueueTimerId = 0;
                        if (this._enabled)
                            Main.messageTray?._updateState?.();
                    });
                }
            },
        });

        if (transientId !== null) {
            this._activeDestroyId = notification.connect('destroy', () => {
                this._activeDestroyId = 0;
                this._activeNotif = null;
                this._priority.dismissTransient(transientId);
            });
        }
    }

    _clearActiveNotif() {
        if (this._activeNotif && this._activeDestroyId) {
            try {
                this._activeNotif.disconnect(this._activeDestroyId);
            } catch {
                // Already destroyed
            }
        }
        this._activeNotif = null;
        this._activeDestroyId = 0;
    }

    _unhook() {
        if (this._nextQueueTimerId) {
            this._timers.clear(this._nextQueueTimerId);
            this._nextQueueTimerId = 0;
        }
        this._clearActiveNotif();
        this._injection.clear();
    }

    _stopWatchingTray() {
        this._trayWatching = false;
        const tray = Main.messageTray;
        if (tray) {
            if (this._sourceAddedId) {
                try { tray.disconnect(this._sourceAddedId); } catch {}
                this._sourceAddedId = 0;
            }
            if (this._sourceRemovedId) {
                try { tray.disconnect(this._sourceRemovedId); } catch {}
                this._sourceRemovedId = 0;
            }
        }
        for (const src of [...this._trackedSources.keys()])
            this._untrackSource(src);
        for (const rec of this._liveItems.values()) {
            try { rec.notif.disconnect(rec.destroyId); } catch {}
        }
        this._liveItems.clear();
        this._taskItems = [];
    }

    destroy() {
        this._unhook();
        this._stopWatchingTray();
        this._enabled = false;
    }
}
