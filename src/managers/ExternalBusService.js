import Gio from 'gi://Gio';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { Weights } from '../core/PriorityManager.js';

const BUS_NAME = 'org.bayisland.Shell';
const OBJECT_PATH = '/org/bayisland/Shell';

const INTERFACE_XML = `
<node>
  <interface name="org.bayisland.Shell">
    <method name="NotifyTask">
      <arg type="s" name="title" direction="in"/>
      <arg type="s" name="body" direction="in"/>
      <arg type="b" name="success" direction="in"/>
      <arg type="i" name="durationSec" direction="in"/>
    </method>
    <method name="ShowBanner">
      <arg type="s" name="title" direction="in"/>
      <arg type="s" name="body" direction="in"/>
      <arg type="s" name="iconName" direction="in"/>
      <arg type="i" name="durationMs" direction="in"/>
    </method>
    <method name="PreviewOsd">
      <arg type="s" name="iconName" direction="in"/>
      <arg type="s" name="label" direction="in"/>
      <arg type="d" name="level" direction="in"/>
    </method>
    <method name="StartTimer">
      <arg type="i" name="seconds" direction="in"/>
      <arg type="s" name="label" direction="in"/>
    </method>
    <method name="StopTimer"/>
    <method name="ToggleExpand"/>
    <method name="Collapse"/>
    <method name="ExpandTab">
      <arg type="s" name="tab" direction="in"/>
    </method>
    <method name="AddShelfFile">
      <arg type="s" name="uriOrPath" direction="in"/>
    </method>
    <method name="GetState">
      <arg type="s" name="stateJson" direction="out"/>
    </method>
  </interface>
</node>`;

/**
 * Session D-Bus service (org.bayisland.Shell) enabling Terminal Task Done,
 * external scripts, Shelf staging, and automated verification.
 */
export class ExternalBusService {
    constructor({ priority, timerManager, notifications, dropShelf, compat }) {
        this._priority = priority;
        this._timerManager = timerManager;
        this._notifications = notifications;
        this._dropShelf = dropShelf;
        this._compat = compat;

        this._enabled = false;
        this._dbusImpl = null;
        this._ownerId = 0;
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

    NotifyTask(title, body, success, durationSec) {
        const durText = durationSec > 0 ? `${durationSec}s` : (success ? 'OK' : 'FAIL');
        this._notifications?.recordTaskItem?.({ title, body, success, durationSec });
        this._priority.pushTransient({
            kind: 'task',
            weight: Weights.TASK,
            title: title || 'Terminal Task',
            body: body || (success ? 'Completed successfully' : 'Exited with error'),
            iconName: success ? 'emblem-ok-symbolic' : 'dialog-error-symbolic',
            iconColor: success ? '#34d399' : '#ef4444',
            badgeText: durText,
            badgeKind: success ? 'success' : 'error',
            alertStyle: success ? 'success' : 'critical',
            durationMs: 3600,
        });
    }

    ShowBanner(title, body, iconName, durationMs) {
        this._priority.pushTransient({
            kind: 'banner',
            weight: Weights.NOTIFICATION,
            title: title || 'BayIsland',
            body: body || '',
            iconName: iconName || 'dialog-information-symbolic',
            durationMs: durationMs > 0 ? durationMs : 3500,
        });
    }

    PreviewOsd(iconName, label, level) {
        let icon = null;
        if (iconName) {
            try {
                icon = Gio.Icon.new_for_string(iconName);
            } catch {}
        }
        const safeLevel = typeof level === 'number' && level >= 0 ? level : undefined;
        Main.osdWindowManager?.show(-1, icon, label || null, safeLevel, 1.0);
    }

    StartTimer(seconds, label) {
        this._timerManager.start(Math.max(1, seconds), 'countdown', label || 'Timer');
    }

    StopTimer() {
        this._timerManager.stop();
    }

    ToggleExpand() {
        this._priority.toggleExpand();
    }

    Collapse() {
        this._priority.collapse();
    }

    ExpandTab(tab) {
        this._priority.expand(tab || 'home');
    }

    AddShelfFile(uriOrPath) {
        if (uriOrPath)
            this._dropShelf?.addUris([uriOrPath], { source: 'dbus', showToast: true });
    }

    GetState() {
        const model = this._priority.getModel();
        return JSON.stringify({
            state: model.state,
            primary: model.primary ?? null,
            tab: model.tab ?? null,
            tabOrder: model.tabOrder ?? this._priority.getTabOrder?.() ?? null,
            transientKind: model.transient?.kind ?? null,
            transientTitle: model.transient?.title ?? null,
            mediaActive: Boolean(model.persistent?.media?.active),
            timerActive: Boolean(model.persistent?.timer?.active),
            privacy: model.persistent?.privacy ?? {},
            meta: model.meta ?? {},
            compat: this._compat.getSnapshot(),
        });
    }

    _start() {
        this._dbusImpl = Gio.DBusExportedObject.wrapJSObject(INTERFACE_XML, this);
        this._dbusImpl.export(Gio.DBus.session, OBJECT_PATH);
        this._ownerId = Gio.DBus.own_name(
            Gio.BusType.SESSION,
            BUS_NAME,
            Gio.BusNameOwnerFlags.REPLACE,
            null,
            null,
            null
        );
    }

    _stop() {
        if (this._ownerId) {
            try { Gio.DBus.unown_name(this._ownerId); } catch {}
            this._ownerId = 0;
        }
        if (this._dbusImpl) {
            try { this._dbusImpl.unexport(); } catch {}
            this._dbusImpl = null;
        }
    }

    destroy() {
        this._stop();
        this._enabled = false;
    }
}
