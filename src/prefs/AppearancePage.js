import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {
    PILL_STYLES,
    INTEGRATION_MODES,
    MERGED_PRESETS,
    AUTOHIDE_MODES,
    AUTOHIDE_HOVER_MODES,
    COLLISION_MODES,
    MONITOR_MODES,
    FULLSCREEN_IDLE_MODES,
    DEFAULT_TABS,
    DEFAULT_TAB_ORDER,
    TAB_ORDER_INFO,
    ACCENT_PRESETS,
    normalizeAccentHex,
    rgbaToHex,
    normalizeTabOrder,
    bindCombo,
    bindSwitch,
    bindSpin,
} from './PrefUtils.js';

export function buildAppearancePage(settings, window, cleanups, shellSettings) {
    const page = new Adw.PreferencesPage({
        title: 'Appearance',
        icon_name: 'preferences-desktop-appearance-symbolic',
    });

    // 0. Session Restart Notice
    const noticeGroup = new Adw.PreferencesGroup({
        visible: false,
    });
    const reloadNoticeRow = new Adw.ActionRow({
        title: 'Log Out and Back In Required for Top Bar Changes',
        subtitle: 'Active GNOME Shell still runs an older BayIsland build in Wayland RAM. Saved Top Bar Merge and Autohide settings will activate immediately after logging out and back in.',
    });
    reloadNoticeRow.add_prefix(new Gtk.Image({ icon_name: 'dialog-warning-symbolic' }));
    if (GLib.find_program_in_path('gnome-session-quit')) {
        const logoutBtn = new Gtk.Button({
            label: 'Log Out...',
            valign: Gtk.Align.CENTER,
            css_classes: ['suggested-action'],
        });
        logoutBtn.connect('clicked', () => {
            try {
                Gio.Subprocess.new(['gnome-session-quit', '--logout'], Gio.SubprocessFlags.NONE);
            } catch {
                window.add_toast?.(new Adw.Toast({ title: 'Log out from Ubuntu power menu to reload BayIsland.' }));
            }
        });
        reloadNoticeRow.add_suffix(logoutBtn);
    }
    noticeGroup.add(reloadNoticeRow);
    page.add(noticeGroup);

    // 1. Top Bar Integration & Built-in Autohide
    const topBarGroup = new Adw.PreferencesGroup({
        title: 'Top Bar Integration and Autohide',
        description: 'Merge BayIsland into GNOME Top Bar center clock, separate them, or manage Top Bar autohide cleanly.',
    });

    const integrationRow = new Adw.ComboRow({
        title: 'Top Bar Clock Mode',
        subtitle: 'Merge BayIsland into Top Bar center clock when visible, or float separately. Always falls back to the pastel Idle Handle when Top Bar hides.',
    });
    bindCombo(settings, 'topbar-integration-mode', INTEGRATION_MODES, integrationRow, cleanups);
    topBarGroup.add(integrationRow);

    const mergedPresetRow = new Adw.ComboRow({
        title: 'Integrated Pill Layout',
        subtitle: 'Choose full Hover Pill status, Minimal Clock, or Clock with bottom pastel handle.',
    });
    bindCombo(settings, 'merged-pill-preset', MERGED_PRESETS, mergedPresetRow, cleanups);
    topBarGroup.add(mergedPresetRow);

    const rightClickRow = bindSwitch(
        settings,
        'merged-clock-right-click-gnome',
        'Right-Click Pill Opens GNOME Calendar',
        'Left-click opens BayIsland Hub; right-click toggles GNOME native calendar and notifications popover.'
    );
    topBarGroup.add(rightClickRow);

    const autohideRow = new Adw.ComboRow({
        title: 'Built-in Top Bar Autohide',
        subtitle: 'Hide or reveal GNOME Top Bar directly inside BayIsland without needing third-party hidetopbar.',
    });
    bindCombo(settings, 'topbar-autohide-mode', AUTOHIDE_MODES, autohideRow, cleanups);
    topBarGroup.add(autohideRow);

    const hoverZoneRow = new Adw.ComboRow({
        title: 'Top Edge Reveal Zone',
        subtitle: 'Edges keeps top-center unobstructed so BayIsland idle hover never fights Top Bar reveal.',
    });
    bindCombo(settings, 'topbar-autohide-hover-mode', AUTOHIDE_HOVER_MODES, hoverZoneRow, cleanups);
    topBarGroup.add(hoverZoneRow);

    const showOverviewRow = bindSwitch(
        settings,
        'topbar-autohide-show-overview',
        'Show Hidden Top Bar in Overview',
        'Keep Top Bar visible when Overview or App Grid is open.'
    );
    topBarGroup.add(showOverviewRow);

    const animMsRow = bindSpin(
        settings,
        'topbar-autohide-anim-ms',
        'Top Bar Slide Animation (ms)',
        'Slide duration when autohiding or revealing GNOME Top Bar.',
        0, 500, 25
    );
    topBarGroup.add(animMsRow);

    const conflictRow = new Adw.ActionRow({
        title: 'External Hide Top Bar Active',
        subtitle: 'hidetopbar@mathieu.bidon.ca is currently enabled — BayIsland yields built-in autohide until disabled.',
        visible: false,
    });
    conflictRow.add_prefix(new Gtk.Image({ icon_name: 'dialog-warning-symbolic' }));
    const disableExtBtn = new Gtk.Button({
        label: 'Disable External',
        valign: Gtk.Align.CENTER,
        css_classes: ['destructive-action'],
    });
    disableExtBtn.connect('clicked', () => {
        Gio.DBus.session.call(
            'org.gnome.Shell.Extensions',
            '/org/gnome/Shell/Extensions',
            'org.gnome.Shell.Extensions',
            'DisableExtension',
            new GLib.Variant('(s)', ['hidetopbar@mathieu.bidon.ca']),
            null,
            Gio.DBusCallFlags.NO_AUTO_START,
            1500,
            null,
            (conn, res) => {
                try {
                    conn.call_finish(res);
                    conflictRow.visible = false;
                    window.add_toast?.(new Adw.Toast({ title: 'Disabled external Hide Top Bar — BayIsland autohide is active.' }));
                } catch {
                    window.add_toast?.(new Adw.Toast({ title: 'Could not disable hidetopbar via D-Bus.' }));
                }
            }
        );
    });
    conflictRow.add_suffix(disableExtBtn);
    topBarGroup.add(conflictRow);

    const probeCancel = new Gio.Cancellable();
    cleanups.push(() => probeCancel.cancel());
    try {
        Gio.DBus.session.call(
            'org.bayisland.Shell',
            '/org/bayisland/Shell',
            'org.bayisland.Shell',
            'GetState',
            null,
            new GLib.VariantType('(s)'),
            Gio.DBusCallFlags.NO_AUTO_START,
            600,
            probeCancel,
            (conn, res) => {
                if (probeCancel.is_cancelled())
                    return;
                try {
                    const out = conn.call_finish(res);
                    const jsonStr = out?.deepUnpack?.()?.[0];
                    if (!jsonStr)
                        return;
                    const stateObj = JSON.parse(jsonStr);
                    if (stateObj && !Object.prototype.hasOwnProperty.call(stateObj, 'topbarIntegrationMode'))
                        noticeGroup.visible = true;
                } catch {
                    // Older/disabled shell or non-JSON response
                }
            }
        );
    } catch {
        // Best effort session probe
    }

    page.add(topBarGroup);

    // 2. Shape & Spacing
    const shapeGroup = new Adw.PreferencesGroup({
        title: 'Shape and Separate Mode Spacing',
        description: 'Configure BayIsland floating capsule style and spacing relative to Top Bar or screen edge.',
    });

    const styleRow = new Adw.ComboRow({
        title: 'Island Style',
        subtitle: 'Floating capsule below top bezel or screen-edge notch.',
    });
    bindCombo(settings, 'pill-style', PILL_STYLES, styleRow, cleanups);
    shapeGroup.add(styleRow);

    const collisionRow = new Adw.ComboRow({
        title: 'Top Bar Collision Behavior (Separate Mode)',
        subtitle: 'Used in Separate mode when GNOME Top Bar is visible.',
    });
    bindCombo(settings, 'topbar-collision-mode', COLLISION_MODES, collisionRow, cleanups);
    shapeGroup.add(collisionRow);

    const monitorRow = new Adw.ComboRow({
        title: 'Target Monitor (Separate Mode)',
        subtitle: 'Choose primary monitor or follow the currently active monitor.',
    });
    bindCombo(settings, 'monitor-mode', MONITOR_MODES, monitorRow, cleanups);
    shapeGroup.add(monitorRow);

    shapeGroup.add(bindSpin(
        settings,
        'top-margin',
        'Vertical Margin (px)',
        'Gap from top edge or below visible Top Bar.',
        0, 48, 1
    ));

    shapeGroup.add(bindSpin(
        settings,
        'expanded-top-margin',
        'Expanded Modal Top Gap (px)',
        'Vertical offset for the expanded modal from screen top or Top Bar.',
        0, 64, 1
    ));

    const defaultTabRow = new Adw.ComboRow({
        title: 'Default Expanded Hub Tab',
        subtitle: 'Tab opened when clicking the idle bar, integrated pill, or pressing Super+Alt+I.',
    });
    bindCombo(settings, 'expanded-default-tab', DEFAULT_TABS, defaultTabRow, cleanups);
    shapeGroup.add(defaultTabRow);

    page.add(shapeGroup);

    const isExternalHideTopBarActive = () => {
        if (!shellSettings)
            return false;
        try {
            const enabled = new Set(shellSettings.get_strv('enabled-extensions') ?? []);
            const disabled = new Set(shellSettings.get_strv('disabled-extensions') ?? []);
            return enabled.has('hidetopbar@mathieu.bidon.ca') && !disabled.has('hidetopbar@mathieu.bidon.ca');
        } catch {
            return false;
        }
    };

    const syncTopBarSensitivity = () => {
        const merged = settings.get_string('topbar-integration-mode') === 'merged-pill';
        const autohideOn = settings.get_string('topbar-autohide-mode') !== 'disabled';
        mergedPresetRow.sensitive = merged;
        rightClickRow.sensitive = merged;
        collisionRow.sensitive = !merged;
        hoverZoneRow.sensitive = autohideOn;
        showOverviewRow.sensitive = autohideOn;
        animMsRow.sensitive = autohideOn;
        conflictRow.visible = autohideOn && isExternalHideTopBarActive();
    };
    syncTopBarSensitivity();
    const sigInt = settings.connect('changed::topbar-integration-mode', syncTopBarSensitivity);
    const sigAuto = settings.connect('changed::topbar-autohide-mode', syncTopBarSensitivity);
    cleanups.push(() => {
        settings.disconnect(sigInt);
        settings.disconnect(sigAuto);
    });
    if (shellSettings) {
        const sigEn = shellSettings.connect('changed::enabled-extensions', syncTopBarSensitivity);
        const sigDis = shellSettings.connect('changed::disabled-extensions', syncTopBarSensitivity);
        cleanups.push(() => {
            shellSettings.disconnect(sigEn);
            shellSettings.disconnect(sigDis);
        });
    }

    // 3. Theme & Custom Accent Color
    const themeGroup = new Adw.PreferencesGroup({
        title: 'Theme and Accent Color',
        description: 'Pick a solid fill accent for active tabs, Quick Actions, controls, and today highlight.',
    });

    const display = Gdk.Display.get_default();
    if (display) {
        const cssRules = ACCENT_PRESETS.map((p, idx) => `
            button.bayisland-swatch-${idx} {
                min-width: 26px;
                min-height: 26px;
                padding: 0px;
                border-radius: 999px;
                background-color: ${p.hex};
                background-image: none;
                color: ${p.darkCheck ? '#090D16' : '#FFFFFF'};
                border: none;
                box-shadow: none;
            }
            button.bayisland-swatch-${idx}:hover {
                opacity: 0.9;
            }
        `).join('\n');
        const provider = new Gtk.CssProvider();
        provider.load_from_data(cssRules, -1);
        Gtk.StyleContext.add_provider_for_display(
            display,
            provider,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
        );
        cleanups.push(() => Gtk.StyleContext.remove_provider_for_display(display, provider));
    }

    const applyAccentHex = (hex, fromUser = true) => {
        const norm = normalizeAccentHex(hex);
        if (normalizeAccentHex(settings.get_string('accent-color')) !== norm)
            settings.set_string('accent-color', norm);
        if (fromUser && settings.get_boolean('openbar-color-sync')) {
            settings.set_boolean('openbar-color-sync', false);
            window.add_toast?.(new Adw.Toast({
                title: 'Custom accent applied (OpenBar sync disabled)',
            }));
        }
    };

    const presetRow = new Adw.ActionRow({
        title: 'Accent Presets',
        subtitle: 'One-click solid color presets for BayIsland active elements.',
    });
    const swatchBox = new Gtk.Box({
        spacing: 6,
        valign: Gtk.Align.CENTER,
    });
    const swatchButtons = [];
    ACCENT_PRESETS.forEach((p, idx) => {
        const checkIcon = new Gtk.Image({
            icon_name: 'object-select-symbolic',
            pixel_size: 14,
            visible: false,
        });
        const btn = new Gtk.Button({
            tooltip_text: `${p.name} (${p.hex})`,
            valign: Gtk.Align.CENTER,
            css_classes: ['circular', `bayisland-swatch-${idx}`],
            child: checkIcon,
        });
        btn.connect('clicked', () => applyAccentHex(p.hex, true));
        swatchBox.append(btn);
        swatchButtons.push({ hex: p.hex, checkIcon });
    });
    presetRow.add_suffix(swatchBox);
    themeGroup.add(presetRow);

    const customColorRow = new Adw.ActionRow({
        title: 'Custom Accent Color',
        subtitle: 'Select any color (automatically turns off OpenBar sync when changed).',
    });
    const colorDialog = new Gtk.ColorDialog({
        with_alpha: false,
        title: 'Select BayIsland Accent Color',
    });
    const colorBtn = new Gtk.ColorDialogButton({
        dialog: colorDialog,
        valign: Gtk.Align.CENTER,
    });
    customColorRow.add_suffix(colorBtn);
    customColorRow.activatable_widget = colorBtn;
    themeGroup.add(customColorRow);

    let syncingColor = false;
    const syncColorControls = () => {
        const curHex = normalizeAccentHex(settings.get_string('accent-color'));
        for (const sw of swatchButtons)
            sw.checkIcon.visible = sw.hex === curHex;

        syncingColor = true;
        const rgba = new Gdk.RGBA();
        if (!rgba.parse(curHex))
            rgba.parse('#93C5FD');
        colorBtn.set_rgba(rgba);
        syncingColor = false;
    };
    syncColorControls();

    const accentSigId = settings.connect('changed::accent-color', syncColorControls);
    cleanups.push(() => settings.disconnect(accentSigId));

    colorBtn.connect('notify::rgba', () => {
        if (syncingColor)
            return;
        const rgba = colorBtn.get_rgba();
        if (rgba)
            applyAccentHex(rgbaToHex(rgba), true);
    });

    themeGroup.add(bindSwitch(
        settings,
        'openbar-color-sync',
        'Sync Accent Palette with OpenBar',
        'When enabled, reads OpenBar accent color automatically whenever OpenBar is active.'
    ));
    page.add(themeGroup);

    // 4. Reorderable Hub Tabs
    const orderGroup = new Adw.PreferencesGroup({
        title: 'Hub Tab Order',
        description: 'Customize left-to-right tab placement in the expanded BayIsland Hub.',
    });

    const resetOrderBtn = new Gtk.Button({
        label: 'Reset Order',
        valign: Gtk.Align.CENTER,
        css_classes: ['flat'],
    });
    resetOrderBtn.connect('clicked', () => {
        settings.set_strv('tab-order', [...DEFAULT_TAB_ORDER]);
    });
    orderGroup.set_header_suffix(resetOrderBtn);

    let orderRows = [];
    const rebuildOrderRows = () => {
        for (const row of orderRows)
            orderGroup.remove(row);
        orderRows = [];

        const curOrder = normalizeTabOrder(settings.get_strv('tab-order'));
        curOrder.forEach((tabId, idx) => {
            const info = TAB_ORDER_INFO[tabId];
            if (!info)
                return;

            const row = new Adw.ActionRow({
                title: `${idx + 1}. ${info.title}`,
                subtitle: info.subtitle,
            });
            row.add_prefix(new Gtk.Image({ icon_name: info.icon }));

            const ctrlBox = new Gtk.Box({
                spacing: 4,
                valign: Gtk.Align.CENTER,
            });

            const upBtn = new Gtk.Button({
                icon_name: 'go-up-symbolic',
                tooltip_text: 'Move left',
                sensitive: idx > 0,
                css_classes: ['flat'],
            });
            upBtn.connect('clicked', () => {
                const next = normalizeTabOrder(settings.get_strv('tab-order'));
                if (idx > 0 && idx < next.length) {
                    [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
                    settings.set_strv('tab-order', next);
                }
            });

            const downBtn = new Gtk.Button({
                icon_name: 'go-down-symbolic',
                tooltip_text: 'Move right',
                sensitive: idx < curOrder.length - 1,
                css_classes: ['flat'],
            });
            downBtn.connect('clicked', () => {
                const next = normalizeTabOrder(settings.get_strv('tab-order'));
                if (idx >= 0 && idx < next.length - 1) {
                    [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
                    settings.set_strv('tab-order', next);
                }
            });

            ctrlBox.append(upBtn);
            ctrlBox.append(downBtn);
            row.add_suffix(ctrlBox);

            orderGroup.add(row);
            orderRows.push(row);
        });
    };

    rebuildOrderRows();
    const orderSigId = settings.connect('changed::tab-order', rebuildOrderRows);
    cleanups.push(() => settings.disconnect(orderSigId));
    page.add(orderGroup);

    // 5. Idle Handle & Visibility
    const idleGroup = new Adw.PreferencesGroup({
        title: 'Idle Grab Handle and Visibility',
        description: 'Keep an unobtrusive top-center line so BayIsland is always reachable with hover or click.',
    });
    idleGroup.add(bindSwitch(
        settings,
        'idle-handle-enabled',
        'Show Idle Grab Handle Bar',
        'Pastel-blue top-center line that stays visible even when HideTopBar hides the Top Bar over maximized/fullscreen apps.'
    ));
    const fullscreenIdleRow = new Adw.ComboRow({
        title: 'Fullscreen Pill Line Behavior',
        subtitle: 'Keep the pill line visible in fullscreen, or hide it when no notifications remain and reveal on hover.',
    });
    bindCombo(settings, 'idle-handle-fullscreen-mode', FULLSCREEN_IDLE_MODES, fullscreenIdleRow, cleanups);
    idleGroup.add(fullscreenIdleRow);
    idleGroup.add(bindSwitch(
        settings,
        'idle-hover-peek',
        'Hover Dwell Reveals Status Peek',
        'Morph idle bar into a quick clock, power profile, battery, and notification pill on hover.'
    ));
    idleGroup.add(bindSpin(
        settings,
        'idle-hover-dwell-ms',
        'Hover Dwell Delay (ms)',
        'Delay before expanding the idle handle to avoid accidental triggers.',
        50, 600, 10
    ));
    idleGroup.add(bindSwitch(
        settings,
        'show-idle-pill',
        'Fallback Ambient Dot',
        'Show minimal ambient dot if the Idle Grab Handle Bar is turned off.'
    ));
    idleGroup.add(bindSwitch(
        settings,
        'hide-in-fullscreen',
        'Hide Completely in Fullscreen',
        'Keep BayIsland hidden during fullscreen apps/videos (disable to still show OSD alerts).'
    ));

    const syncIdleSensitivity = () => {
        const handleOn = settings.get_boolean('idle-handle-enabled');
        const hideFs = settings.get_boolean('hide-in-fullscreen');
        fullscreenIdleRow.sensitive = handleOn && !hideFs;
    };
    syncIdleSensitivity();
    const sigHandle = settings.connect('changed::idle-handle-enabled', syncIdleSensitivity);
    const sigHideFs = settings.connect('changed::hide-in-fullscreen', syncIdleSensitivity);
    cleanups.push(() => {
        settings.disconnect(sigHandle);
        settings.disconnect(sigHideFs);
    });
    page.add(idleGroup);

    return page;
}
