import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';
import { ExtensionState } from 'resource:///org/gnome/shell/misc/extensionUtils.js';

export const TRACKED_EXTENSIONS = {
    HIDETOPBAR: 'hidetopbar@mathieu.bidon.ca',
    OPENBAR: 'openbar@neuromorph',
    MEDIACONTROLS: 'mediacontrols@cliffniff.github.com',
    BLUR_MY_SHELL: 'blur-my-shell@aunetx',
    QUICK_SETTINGS_TWEAKS: 'quick-settings-tweaks@qwreey',
    CAFFEINE: 'caffeine@patapon.info',
};

/**
 * Inspects active GNOME Shell extensions at runtime so BayIsland
 * adapts cleanly to hidetopbar, openbar, blur-my-shell, etc.
 */
export class ExtensionCompat extends Signals.EventEmitter {
    constructor(signals) {
        super();
        this._signals = signals;
        this._snapshot = this._readSnapshot();

        this._signals.connect(Main.extensionManager, 'extension-state-changed', () => {
            this._snapshot = this._readSnapshot();
            this.emit('changed', this._snapshot);
        });
    }

    _isActive(uuid) {
        try {
            const ext = Main.extensionManager.lookup(uuid);
            return Boolean(ext && ext.state === ExtensionState.ACTIVE);
        } catch {
            return false;
        }
    }

    _readSnapshot() {
        let openbarDir = null;
        try {
            openbarDir = Main.extensionManager.lookup(TRACKED_EXTENSIONS.OPENBAR)?.dir?.get_path?.() ?? null;
        } catch {
            openbarDir = null;
        }
        return {
            hidetopbar: this._isActive(TRACKED_EXTENSIONS.HIDETOPBAR),
            openbar: this._isActive(TRACKED_EXTENSIONS.OPENBAR),
            openbarDir,
            mediacontrols: this._isActive(TRACKED_EXTENSIONS.MEDIACONTROLS),
            blurMyShell: this._isActive(TRACKED_EXTENSIONS.BLUR_MY_SHELL),
            quickSettingsTweaks: this._isActive(TRACKED_EXTENSIONS.QUICK_SETTINGS_TWEAKS),
            caffeine: this._isActive(TRACKED_EXTENSIONS.CAFFEINE),
        };
    }

    getSnapshot() {
        return this._snapshot;
    }
}
