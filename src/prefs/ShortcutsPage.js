import Adw from 'gi://Adw';

import { createShortcutRow } from './PrefUtils.js';

export function buildShortcutsPage(settings, window, cleanups) {
    const page = new Adw.PreferencesPage({
        title: 'Shortcuts and CLI',
        icon_name: 'preferences-desktop-keyboard-symbolic',
    });

    const keyGroup = new Adw.PreferencesGroup({
        title: 'Keyboard Shortcuts',
        description: 'Click a shortcut to rebind, or press Backspace inside the dialog to clear.',
    });

    keyGroup.add(createShortcutRow(
        settings,
        'toggle-expand-shortcut',
        '<Super><Alt>i',
        'Toggle Expanded Bento Hub',
        'Open or collapse BayIsland using your configured Default Tab.',
        window,
        cleanups
    ));
    keyGroup.add(createShortcutRow(
        settings,
        'quick-runner-shortcut',
        '<Super><Alt>r',
        'Quick Command Runner / Search Bar',
        'Open BayIsland and immediately focus the calculator and command runner entry.',
        window,
        cleanups
    ));
    keyGroup.add(createShortcutRow(
        settings,
        'quick-clipboard-shortcut',
        '<Super><Alt>v',
        'Quick Clipboard History Tab',
        'Open directly to BayIsland Clipboard History for search and click-to-paste.',
        window,
        cleanups
    ));
    keyGroup.add(createShortcutRow(
        settings,
        'quick-shelf-shortcut',
        '<Super><Alt>d',
        'Quick File Shelf Tab',
        'Open directly to the Drag and Drop Temporary File Shelf.',
        window,
        cleanups
    ));
    keyGroup.add(createShortcutRow(
        settings,
        'quick-timer-shortcut',
        '<Super><Alt>t',
        'Quick Home and Focus Timer',
        'Open directly to BayIsland Home tab with Calendar, Quick Actions, Notifications, and Timer.',
        window,
        cleanups
    ));
    keyGroup.add(createShortcutRow(
        settings,
        'minimize-persistent-shortcut',
        '<Super><Alt>h',
        'Minimize Persistent Island',
        'Minimize active media, mic, or timer to an ambient pill.',
        window,
        cleanups
    ));
    page.add(keyGroup);

    const cliGroup = new Adw.PreferencesGroup({
        title: 'Terminal Task Done and Automation',
        description: 'Add scripts/bayisland-shell-hook.sh to ~/.bashrc or ~/.zshrc for automatic build alerts and D-Bus control.',
    });

    cliGroup.add(new Adw.ActionRow({
        title: 'Shell Hook Script',
        subtitle: 'source /path/to/bayisland/scripts/bayisland-shell-hook.sh',
    }));
    cliGroup.add(new Adw.ActionRow({
        title: 'Terminal Task Test Command',
        subtitle: 'gdbus call --session -d org.bayisland.Shell -o /org/bayisland/Shell -m org.bayisland.Shell.NotifyTask "Build" "Cargo finished" true 18',
    }));
    cliGroup.add(new Adw.ActionRow({
        title: 'Stage File to Shelf via D-Bus',
        subtitle: 'gdbus call --session -d org.bayisland.Shell -o /org/bayisland/Shell -m org.bayisland.Shell.AddShelfFile "$PWD/file.pdf"',
    }));
    page.add(cliGroup);

    return page;
}
