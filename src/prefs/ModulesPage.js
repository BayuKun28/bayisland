import Adw from 'gi://Adw';

import {
    MEDIA_CLOCK_POSITIONS,
    PASTE_SHORTCUTS,
    bindCombo,
    bindSwitch,
    bindSpin,
} from './PrefUtils.js';

export function buildModulesPage(settings, cleanups) {
    const page = new Adw.PreferencesPage({
        title: 'Modules',
        icon_name: 'applications-system-symbolic',
    });

    const hubGroup = new Adw.PreferencesGroup({
        title: 'Expanded Bento Hub (Home, Media, Power, Clip and Shelf)',
    });
    hubGroup.add(bindSwitch(
        settings,
        'enable-quick-actions',
        'Quick Actions, Calendar and Audio Switcher',
        'Wi-Fi, Bluetooth, Night Light, DND, Screenshot, Keep Awake, Calendar agenda, and audio outputs.'
    ));
    const homeBrightRow = bindSwitch(
        settings,
        'enable-home-brightness-slider',
        'Home Quick Actions Brightness Slider',
        'Show an inline screen brightness slider beneath the Quick Actions tiles on the Home tab.'
    );
    const syncQuickBrightSensitivity = () => {
        homeBrightRow.sensitive = settings.get_boolean('enable-quick-actions');
    };
    syncQuickBrightSensitivity();
    const sigQa = settings.connect('changed::enable-quick-actions', syncQuickBrightSensitivity);
    cleanups.push(() => settings.disconnect(sigQa));
    hubGroup.add(homeBrightRow);
    hubGroup.add(bindSwitch(
        settings,
        'enable-command-runner',
        'Quick Command Runner and Calculator Bar',
        'Show instant math calculator and shell command runner bar in Expanded Bento Hub.'
    ));
    hubGroup.add(bindSwitch(
        settings,
        'enable-clipboard',
        'Clipboard History Tab',
        'Record text copies with Search, Pin favorites, Incognito pause, and one-click paste.'
    ));
    hubGroup.add(bindSwitch(
        settings,
        'clipboard-auto-paste',
        'Auto-Paste on Entry Click',
        'Copy selected history entry and immediately paste it into your previously focused window.'
    ));

    const pasteRow = new Adw.ComboRow({
        title: 'Auto-Paste Keystroke',
        subtitle: 'Shift+Insert works reliably across both GNOME apps and terminals.',
    });
    bindCombo(settings, 'clipboard-paste-shortcut', PASTE_SHORTCUTS, pasteRow, cleanups);
    hubGroup.add(pasteRow);

    hubGroup.add(bindSwitch(
        settings,
        'clipboard-ignore-passwords',
        'Ignore Password Manager Entries',
        'Skip entries tagged with x-kde-passwordManagerHint privacy metadata.'
    ));
    hubGroup.add(bindSpin(
        settings,
        'clipboard-max-items',
        'Max Unpinned Clipboard Items',
        'Pinned entries never expire; unpinned history trims beyond this limit.',
        10, 200, 10
    ));
    hubGroup.add(bindSwitch(
        settings,
        'enable-shelf',
        'Drag and Drop File Shelf',
        'Stage temporary files and screenshots via Wayland drag-and-drop bridge or file copy.'
    ));
    hubGroup.add(bindSwitch(
        settings,
        'shelf-drag-reveal',
        'Reveal Drop Catcher on Drag',
        'Automatically morph into a drop zone when dragging files near the top-center handle.'
    ));
    hubGroup.add(bindSwitch(
        settings,
        'shelf-screenshot-auto-stash',
        'Auto-Stash New Screenshots',
        'Automatically stage newly saved GNOME screenshots into the Shelf tab.'
    ));
    page.add(hubGroup);

    const hwGroup = new Adw.PreferencesGroup({
        title: 'System, Hardware and Media',
    });
    hwGroup.add(bindSwitch(
        settings,
        'enable-osd',
        'Replace GNOME OSD',
        'Smooth morphing pill for Volume, Brightness, Mic Mute, Airplane Mode, and Caffeine.'
    ));
    hwGroup.add(bindSwitch(
        settings,
        'enable-workspace-glance',
        'Dynamic Workspace Glance',
        'Show a sleek transient banner on the Dynamic Island when switching virtual workspaces.'
    ));
    hwGroup.add(bindSwitch(
        settings,
        'enable-power',
        'Power and ThinkPad Battery Events',
        'AC plug/unplug cards, low battery alerts, and BAT0 charge threshold readout.'
    ));
    hwGroup.add(bindSwitch(
        settings,
        'enable-privacy',
        'Privacy Indicators (Cam and Mic)',
        'Real-time status pill via Shell.CameraMonitor and PipeWire/Pulse Gvc streams.'
    ));
    hwGroup.add(bindSwitch(
        settings,
        'enable-mpris',
        'Universal MPRIS Media Controller',
        'Album art, GPU-animated equalizer bars, multi-player switcher, and playback controls.'
    ));
    hwGroup.add(bindSpin(
        settings,
        'mpris-hide-delay',
        'Hide Paused Media After (seconds)',
        'Set to 0 to keep paused media visible indefinitely.',
        0, 300, 5
    ));

    const mediaClockRow = new Adw.ComboRow({
        title: 'Clock in Media Island',
        subtitle: 'Display the current time on the left or right side while media is playing in the island.',
    });
    bindCombo(settings, 'media-island-clock', MEDIA_CLOCK_POSITIONS, mediaClockRow, cleanups);
    hwGroup.add(mediaClockRow);

    hwGroup.add(bindSwitch(
        settings,
        'enable-audio-accessory-alert',
        'TWS, DAC and IEM Connection Pop-up',
        'Show Dynamic Island notification banner when Bluetooth TWS, USB DACs, or 3.5mm headphones connect.'
    ));

    page.add(hwGroup);

    const prodGroup = new Adw.PreferencesGroup({
        title: 'Notifications, Timer and Monitoring',
    });
    prodGroup.add(bindSwitch(
        settings,
        'enable-notifications',
        'Notification Peeking',
        'Render incoming notifications inside BayIsland while keeping two-way MessageTray sync.'
    ));
    prodGroup.add(bindSpin(
        settings,
        'notification-duration',
        'Notification Display Duration (ms)',
        'Hovering the pill freezes auto-dismiss until pointer leaves.',
        1500, 15000, 500
    ));
    prodGroup.add(bindSwitch(
        settings,
        'notification-dismiss-on-leave',
        'Dismiss on Cursor Leave',
        'Instantly dismiss notification banners once the mouse pointer hovers and leaves the dynamic island.'
    ));
    prodGroup.add(bindSwitch(
        settings,
        'enable-timer',
        'Built-in Timer and Pomodoro',
        'Countdown and 25m Pomodoro inside the pill and Home tab.'
    ));
    prodGroup.add(bindSwitch(
        settings,
        'enable-resource-spike',
        'Resource Spike Warning',
        'Alert on sustained high CPU or RAM usage (2 consecutive samples, 60s cooldown).'
    ));
    prodGroup.add(bindSwitch(
        settings,
        'enable-network-hud',
        'Network Speed Telemetry HUD',
        'Display real-time download and upload transfer rates in the island when active transfer is detected.'
    ));
    prodGroup.add(bindSpin(
        settings,
        'resource-cpu-threshold',
        'CPU Warning Threshold (%)',
        'Trigger spike warning when sustained CPU load meets this value.',
        50, 99, 1
    ));
    prodGroup.add(bindSpin(
        settings,
        'resource-ram-threshold',
        'RAM Warning Threshold (%)',
        'Trigger spike warning when memory usage meets this value.',
        50, 99, 1
    ));
    prodGroup.add(bindSwitch(
        settings,
        'enable-dbus-service',
        'D-Bus Service (org.bayisland.Shell)',
        'Allow terminal hooks and external scripts to send tasks, banners, shelf files, and timers.'
    ));
    page.add(prodGroup);

    return page;
}
