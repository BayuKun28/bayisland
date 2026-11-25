import Gio from 'gi://Gio';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import { buildAppearancePage } from './src/prefs/AppearancePage.js';
import { buildModulesPage } from './src/prefs/ModulesPage.js';
import { buildCompatPage } from './src/prefs/CompatPage.js';
import { buildShortcutsPage } from './src/prefs/ShortcutsPage.js';

/**
 * BayIsland Preferences Window Coordinator.
 * Delegates individual tab page constructions to modular page builders in src/prefs/.
 */
export default class BayIslandPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        window.set_default_size(660, 760);

        const settings = this.getSettings();
        const shellSettings = this._getShellSettings();
        const cleanups = [];

        window.connect('close-request', () => {
            for (const fn of cleanups) {
                try { fn(); } catch {}
            }
            return false;
        });

        window.add(buildAppearancePage(settings, window, cleanups, shellSettings));
        window.add(buildModulesPage(settings, cleanups));
        window.add(buildCompatPage(shellSettings, window));
        window.add(buildShortcutsPage(settings, window, cleanups));
    }

    _getShellSettings() {
        try {
            const source = Gio.SettingsSchemaSource.get_default();
            const schema = source?.lookup('org.gnome.shell', true);
            return schema ? new Gio.Settings({ settings_schema: schema }) : null;
        } catch {
            return null;
        }
    }
}
