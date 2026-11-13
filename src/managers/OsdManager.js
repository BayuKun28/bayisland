import Gio from 'gi://Gio';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { InjectionManager } from 'resource:///org/gnome/shell/extensions/extension.js';

import { Weights } from '../core/PriorityManager.js';

function classifyOsd(icon, label) {
    const names = [];
    if (icon instanceof Gio.ThemedIcon)
        names.push(...icon.get_names());
    else if (icon?.to_string)
        names.push(icon.to_string());

    const joined = `${names.join(' ')} ${label || ''}`.toLowerCase();

    if (joined.includes('microphone') || joined.includes('audio-input') || joined.includes('mic'))
        return { key: 'osd-mic', fallbackTitle: 'Microphone', iconColor: '#fb923c' };
    if (joined.includes('audio-volume') || joined.includes('volume') || joined.includes('speaker') || joined.includes('headphone') || joined.includes('headset') || joined.includes('sound'))
        return { key: 'osd-volume', fallbackTitle: 'Volume', iconColor: '#60a5fa' };
    if (joined.includes('brightness') && joined.includes('keyboard'))
        return { key: 'osd-kbd-brightness', fallbackTitle: 'Keyboard Light', iconColor: '#fde047' };
    if (joined.includes('brightness') || joined.includes('display'))
        return { key: 'osd-brightness', fallbackTitle: 'Brightness', iconColor: '#facc15' };
    if (joined.includes('airplane'))
        return { key: 'osd-airplane', fallbackTitle: 'Airplane Mode', iconColor: '#93c5fd' };
    if (joined.includes('caffeine') || joined.includes('cup'))
        return { key: 'osd-caffeine', fallbackTitle: 'Caffeine', iconColor: '#fbbf24' };

    return {
        key: `osd-${names[0] || label || 'generic'}`,
        fallbackTitle: label || 'System',
        iconColor: '#e5e7eb',
    };
}

/**
 * Replaces stock GNOME OsdWindowManager popups on the primary monitor
 * using GNOME 46's built-in InjectionManager.
 */
export class OsdManager {
    constructor(priority) {
        this._priority = priority;
        this._injection = new InjectionManager();
        this._enabled = false;
        this._workspaceGlanceEnabled = true;
        this._workspaceSigId = 0;
    }

    setEnabled(enabled) {
        const want = Boolean(enabled);
        if (want === this._enabled)
            return;

        if (want)
            this._hook();
        else
            this._unhook();
        this._enabled = want;
    }

    setWorkspaceGlanceEnabled(enabled) {
        const want = Boolean(enabled);
        if (want === this._workspaceGlanceEnabled)
            return;
        this._workspaceGlanceEnabled = want;
        if (this._enabled) {
            if (want)
                this._hookWorkspace();
            else
                this._unhookWorkspace();
        }
    }

    _hook() {
        const osdMgr = Main.osdWindowManager;
        if (!osdMgr)
            return;

        const self = this;
        this._injection.overrideMethod(osdMgr, 'show', originalShow => {
            return function (monitorIndex, icon, label, level, maxLevel) {
                const primaryIndex = Main.layoutManager.primaryIndex;
                const targetsPrimary = monitorIndex === -1 || monitorIndex === primaryIndex;

                if (targetsPrimary) {
                    self._handleOsd(icon, label, level, maxLevel);
                    // Suppress stock OSD on primary (or all if single monitor)
                    if (monitorIndex === -1) {
                        for (let i = 0; i < (this._osdWindows?.length ?? 0); i++) {
                            if (i === primaryIndex)
                                this._osdWindows[i]?.cancel();
                            else if (typeof this._showOsdWindow === 'function')
                                this._showOsdWindow(i, icon, label, level, maxLevel);
                        }
                        return;
                    }
                    for (const win of (this._osdWindows ?? []))
                        win?.cancel();
                    return;
                }

                originalShow?.apply(this, arguments);
            };
        });

        this._injection.overrideMethod(osdMgr, 'hideAll', originalHideAll => {
            return function () {
                originalHideAll?.apply(this, arguments);
                const model = self._priority.getModel();
                if (model?.transient?.kind === 'osd')
                    self._priority.dismissTransient(model.transient.id);
            };
        });

        if (this._workspaceGlanceEnabled)
            this._hookWorkspace();
    }

    _hookWorkspace() {
        this._unhookWorkspace();
        const wm = global.workspace_manager;
        if (!wm)
            return;
        this._workspaceSigId = wm.connect('active-workspace-changed', () => {
            this._handleWorkspaceChange();
        });
    }

    _unhookWorkspace() {
        if (this._workspaceSigId && global.workspace_manager) {
            try { global.workspace_manager.disconnect(this._workspaceSigId); } catch {}
        }
        this._workspaceSigId = 0;
    }

    _handleWorkspaceChange() {
        if (!this._enabled || !this._workspaceGlanceEnabled || !this._priority)
            return;
        const wm = global.workspace_manager;
        if (!wm)
            return;
        const nWorkspaces = wm.get_n_workspaces?.() ?? 1;
        if (nWorkspaces <= 1)
            return;
        const idx = wm.get_active_workspace_index?.() ?? 0;

        const dots = [];
        for (let i = 0; i < Math.min(8, nWorkspaces); i++)
            dots.push(i === idx ? '●' : '○');

        this._priority.pushTransient({
            kind: 'osd',
            weight: Weights.OSD,
            coalesceKey: 'workspace-glance',
            title: `Workspace ${idx + 1}`,
            body: dots.join(' '),
            icon: new Gio.ThemedIcon({ name: 'view-paged-symbolic' }),
            iconColor: '#38bdf8',
            durationMs: 1200,
        });
    }

    _handleOsd(icon, label, level, maxLevel) {
        if (!icon && !label)
            return;

        const resolvedIcon = icon || new Gio.ThemedIcon({ name: 'dialog-information-symbolic' });
        const meta = classifyOsd(resolvedIcon, label);
        const hasLevel = level !== null && level !== undefined;
        const normalizedMax = maxLevel !== null && maxLevel !== undefined ? maxLevel : 1;
        const stableTitle = (hasLevel && meta.key === 'osd-volume')
            ? meta.fallbackTitle
            : (label || meta.fallbackTitle);

        this._priority.pushTransient({
            kind: 'osd',
            weight: Weights.OSD,
            coalesceKey: meta.key,
            title: stableTitle,
            body: hasLevel ? null : (label ? meta.fallbackTitle : null),
            icon: resolvedIcon,
            iconColor: meta.iconColor,
            level: hasLevel ? level : null,
            maxLevel: hasLevel ? normalizedMax : null,
            durationMs: 1800,
        });
    }

    _unhook() {
        this._injection.clear();
        this._unhookWorkspace();
    }

    destroy() {
        this._unhook();
        this._enabled = false;
    }
}
