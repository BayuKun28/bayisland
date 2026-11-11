import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const PILL_STYLES = [
    { value: 'floating', label: 'Floating Pill (Recommended)' },
    { value: 'notch', label: 'Top Notch (Screen Edge)' },
];

const INTEGRATION_MODES = [
    { value: 'merged-pill', label: 'Merge with Top Bar Clock (Unified Pill)' },
    { value: 'separate', label: 'Separate (Floating Handle Below Top Bar)' },
];

const MERGED_PRESETS = [
    { value: 'hover-pill', label: 'Hover Pill Status (Battery + Clock + Profile + Badge)' },
    { value: 'minimal-clock', label: 'Minimal Clock (Expands to Pill on Hover)' },
    { value: 'handle-clock', label: 'Clock + Pastel Handle Accent (Expands on Hover)' },
];

const AUTOHIDE_MODES = [
    { value: 'disabled', label: 'Disabled (Always Keep GNOME Top Bar)' },
    { value: 'intellihide', label: 'Intellihide (Hide When Windows Touch Top Bar)' },
    { value: 'always', label: 'Always Hide GNOME Top Bar' },
];

const AUTOHIDE_HOVER_MODES = [
    { value: 'edges', label: 'Left & Right Screen Edges (Recommended for BayIsland)' },
    { value: 'full-width', label: 'Full Width Across Top Edge' },
    { value: 'off', label: 'Disabled (Overview / Super+S Only)' },
];

const COLLISION_MODES = [
    { value: 'drop-below', label: 'Option A: Drop Below Top Bar' },
    { value: 'hide-idle', label: 'Hide Idle Pill While Top Bar Shows' },
    { value: 'overlay', label: 'Overlay Top Center' },
];

const DEFAULT_TABS = [
    { value: 'auto', label: 'Smart Auto (Media if Playing, else Home)' },
    { value: 'home', label: 'Home (Clock, Calendar, Quick Actions, Notifications)' },
    { value: 'media', label: 'Media and Audio Output' },
    { value: 'power', label: 'Power and Battery Telemetry' },
    { value: 'clipboard', label: 'Clipboard History' },
    { value: 'shelf', label: 'Drag and Drop File Shelf' },
];

const DEFAULT_TAB_ORDER = ['home', 'media', 'power', 'clipboard', 'shelf'];

const TAB_ORDER_INFO = {
    home: {
        title: 'Home',
        subtitle: 'Clock, calendar, quick actions, focus timer, and notifications',
        icon: 'go-home-symbolic',
    },
    media: {
        title: 'Media',
        subtitle: 'Universal MPRIS playback controls and audio output switcher',
        icon: 'audio-x-generic-symbolic',
    },
    power: {
        title: 'Power',
        subtitle: 'Power profiles, battery telemetry, and thermal sensors',
        icon: 'battery-good-symbolic',
    },
    clipboard: {
        title: 'Clip',
        subtitle: 'Searchable clipboard history, favorites, and auto-paste',
        icon: 'edit-paste-symbolic',
    },
    shelf: {
        title: 'Shelf',
        subtitle: 'Drag and drop file stash and screenshot auto-capture',
        icon: 'folder-download-symbolic',
    },
};

const ACCENT_PRESETS = [
    { name: 'Pastel Blue', hex: '#93C5FD', darkCheck: true },
    { name: 'Sky', hex: '#38BDF8', darkCheck: true },
    { name: 'Blue', hex: '#3B82F6', darkCheck: false },
    { name: 'Emerald', hex: '#34D399', darkCheck: true },
    { name: 'Violet', hex: '#8B5CF6', darkCheck: false },
    { name: 'Rose', hex: '#F43F5E', darkCheck: false },
    { name: 'Coral', hex: '#FB923C', darkCheck: true },
    { name: 'Amber', hex: '#F59E0B', darkCheck: true },
    { name: 'Mono', hex: '#E2E8F0', darkCheck: true },
];

const PASTE_SHORTCUTS = [
    { value: 'shift-insert', label: 'Shift+Insert (Works in Apps and Terminal)' },
    { value: 'ctrl-v', label: 'Ctrl+V (Standard Desktop Apps)' },
];

function normalizeAccentHex(raw) {
    if (typeof raw !== 'string')
        return '#93C5FD';
    let clean = raw.trim().replace(/^#/, '');
    if (clean.length === 3)
        clean = clean.split('').map(c => `${c}${c}`).join('');
    if (!/^[0-9a-fA-F]{6}$/.test(clean))
        return '#93C5FD';
    return `#${clean.toUpperCase()}`;
}

function rgbaToHex(rgba) {
    const toHex = f => Math.max(0, Math.min(255, Math.round(f * 255)))
        .toString(16)
        .padStart(2, '0')
        .toUpperCase();
    return `#${toHex(rgba.red)}${toHex(rgba.green)}${toHex(rgba.blue)}`;
}

function normalizeTabOrder(raw) {
    const out = [];
    if (Array.isArray(raw)) {
        for (const item of raw) {
            if (typeof item !== 'string')
                continue;
            const id = item === 'status' ? 'power' : item;
            if (DEFAULT_TAB_ORDER.includes(id) && !out.includes(id))
                out.push(id);
        }
    }
    for (const defId of DEFAULT_TAB_ORDER) {
        if (!out.includes(defId))
            out.push(defId);
    }
    return out;
}

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

        window.add(this._buildAppearancePage(settings, window, cleanups, shellSettings));
        window.add(this._buildModulesPage(settings, cleanups));
        window.add(this._buildCompatPage(shellSettings, window));
        window.add(this._buildShortcutsPage(settings, window, cleanups));
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

    _bindCombo(settings, key, options, row, cleanups) {
        const model = new Gtk.StringList();
        for (const opt of options)
            model.append(opt.label);
        row.set_model(model);

        const syncFromSettings = () => {
            const cur = settings.get_string(key);
            const idx = options.findIndex(o => o.value === cur);
            const target = idx >= 0 ? idx : 0;
            if (row.selected !== target)
                row.selected = target;
        };

        syncFromSettings();
        const sigId = settings.connect(`changed::${key}`, syncFromSettings);
        cleanups.push(() => settings.disconnect(sigId));

        row.connect('notify::selected', () => {
            const opt = options[row.selected];
            if (opt && settings.get_string(key) !== opt.value)
                settings.set_string(key, opt.value);
        });
    }

    _bindSwitch(settings, key, title, subtitle) {
        const row = new Adw.SwitchRow({ title, subtitle });
        settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }

    _bindSpin(settings, key, title, subtitle, lower, upper, step) {
        const adj = new Gtk.Adjustment({
            lower,
            upper,
            step_increment: step,
            page_increment: step * 5,
            value: settings.get_int(key),
        });
        const row = new Adw.SpinRow({
            title,
            subtitle,
            adjustment: adj,
            numeric: true,
        });
        settings.bind(key, adj, 'value', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }

    _buildAppearancePage(settings, window, cleanups, shellSettings) {
        const page = new Adw.PreferencesPage({
            title: 'Appearance',
            icon_name: 'preferences-desktop-appearance-symbolic',
        });

        // 1. Top Bar Integration & Built-in Autohide
        const topBarGroup = new Adw.PreferencesGroup({
            title: 'Top Bar Integration and Autohide',
            description: 'Merge BayIsland into GNOME Top Bar center clock, separate them, or manage Top Bar autohide cleanly.',
        });

        const integrationRow = new Adw.ComboRow({
            title: 'Top Bar Clock Mode',
            subtitle: 'Merge BayIsland into Top Bar center clock when visible, or float separately. Always falls back to the pastel Idle Handle when Top Bar hides.',
        });
        this._bindCombo(settings, 'topbar-integration-mode', INTEGRATION_MODES, integrationRow, cleanups);
        topBarGroup.add(integrationRow);

        const mergedPresetRow = new Adw.ComboRow({
            title: 'Integrated Pill Layout',
            subtitle: 'Choose full Hover Pill status, Minimal Clock, or Clock with bottom pastel handle.',
        });
        this._bindCombo(settings, 'merged-pill-preset', MERGED_PRESETS, mergedPresetRow, cleanups);
        topBarGroup.add(mergedPresetRow);

        const rightClickRow = this._bindSwitch(
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
        this._bindCombo(settings, 'topbar-autohide-mode', AUTOHIDE_MODES, autohideRow, cleanups);
        topBarGroup.add(autohideRow);

        const hoverZoneRow = new Adw.ComboRow({
            title: 'Top Edge Reveal Zone',
            subtitle: 'Edges keeps top-center unobstructed so BayIsland idle hover never fights Top Bar reveal.',
        });
        this._bindCombo(settings, 'topbar-autohide-hover-mode', AUTOHIDE_HOVER_MODES, hoverZoneRow, cleanups);
        topBarGroup.add(hoverZoneRow);

        const showOverviewRow = this._bindSwitch(
            settings,
            'topbar-autohide-show-overview',
            'Show Hidden Top Bar in Overview',
            'Keep Top Bar visible when Overview or App Grid is open.'
        );
        topBarGroup.add(showOverviewRow);

        const animMsRow = this._bindSpin(
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
        this._bindCombo(settings, 'pill-style', PILL_STYLES, styleRow, cleanups);
        shapeGroup.add(styleRow);

        const collisionRow = new Adw.ComboRow({
            title: 'Top Bar Collision Behavior (Separate Mode)',
            subtitle: 'Used in Separate mode when GNOME Top Bar is visible.',
        });
        this._bindCombo(settings, 'topbar-collision-mode', COLLISION_MODES, collisionRow, cleanups);
        shapeGroup.add(collisionRow);

        shapeGroup.add(this._bindSpin(
            settings,
            'top-margin',
            'Vertical Margin (px)',
            'Gap from top edge or below visible Top Bar.',
            0, 48, 1
        ));

        const defaultTabRow = new Adw.ComboRow({
            title: 'Default Expanded Hub Tab',
            subtitle: 'Tab opened when clicking the idle bar, integrated pill, or pressing Super+Alt+I.',
        });
        this._bindCombo(settings, 'expanded-default-tab', DEFAULT_TABS, defaultTabRow, cleanups);
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

        themeGroup.add(this._bindSwitch(
            settings,
            'openbar-color-sync',
            'Sync Accent Palette with OpenBar',
            'When enabled, reads OpenBar accent color automatically whenever OpenBar is active.'
        ));
        page.add(themeGroup);

        // 3. Reorderable Hub Tabs
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

        // 4. Idle Handle & Visibility
        const idleGroup = new Adw.PreferencesGroup({
            title: 'Idle Grab Handle and Visibility',
            description: 'Keep an unobtrusive top-center line so BayIsland is always reachable with hover or click.',
        });
        idleGroup.add(this._bindSwitch(
            settings,
            'idle-handle-enabled',
            'Show Idle Grab Handle Bar',
            'Pastel-blue top-center line that stays visible even when HideTopBar hides the Top Bar over maximized/fullscreen apps.'
        ));
        idleGroup.add(this._bindSwitch(
            settings,
            'idle-hover-peek',
            'Hover Dwell Reveals Status Peek',
            'Morph idle bar into a quick clock, power profile, battery, and notification pill on hover.'
        ));
        idleGroup.add(this._bindSpin(
            settings,
            'idle-hover-dwell-ms',
            'Hover Dwell Delay (ms)',
            'Delay before expanding the idle handle to avoid accidental triggers.',
            50, 600, 10
        ));
        idleGroup.add(this._bindSwitch(
            settings,
            'show-idle-pill',
            'Fallback Ambient Dot',
            'Show minimal ambient dot if the Idle Grab Handle Bar is turned off.'
        ));
        idleGroup.add(this._bindSwitch(
            settings,
            'hide-in-fullscreen',
            'Hide Completely in Fullscreen',
            'Keep BayIsland hidden during fullscreen apps/videos (disable to still show OSD alerts).'
        ));
        page.add(idleGroup);

        return page;
    }

    _buildModulesPage(settings, cleanups) {
        const page = new Adw.PreferencesPage({
            title: 'Modules',
            icon_name: 'applications-system-symbolic',
        });

        const hubGroup = new Adw.PreferencesGroup({
            title: 'Expanded Bento Hub (Home, Media, Power, Clip and Shelf)',
        });
        hubGroup.add(this._bindSwitch(
            settings,
            'enable-quick-actions',
            'Quick Actions, Calendar and Audio Switcher',
            'Wi-Fi, Bluetooth, Night Light, DND, Screenshot, Keep Awake, Calendar agenda, and audio outputs.'
        ));
        hubGroup.add(this._bindSwitch(
            settings,
            'enable-clipboard',
            'Clipboard History Tab',
            'Record text copies with Search, Pin favorites, Incognito pause, and one-click paste.'
        ));
        hubGroup.add(this._bindSwitch(
            settings,
            'clipboard-auto-paste',
            'Auto-Paste on Entry Click',
            'Copy selected history entry and immediately paste it into your previously focused window.'
        ));

        const pasteRow = new Adw.ComboRow({
            title: 'Auto-Paste Keystroke',
            subtitle: 'Shift+Insert works reliably across both GNOME apps and terminals.',
        });
        this._bindCombo(settings, 'clipboard-paste-shortcut', PASTE_SHORTCUTS, pasteRow, cleanups);
        hubGroup.add(pasteRow);

        hubGroup.add(this._bindSwitch(
            settings,
            'clipboard-ignore-passwords',
            'Ignore Password Manager Entries',
            'Skip entries tagged with x-kde-passwordManagerHint privacy metadata.'
        ));
        hubGroup.add(this._bindSpin(
            settings,
            'clipboard-max-items',
            'Max Unpinned Clipboard Items',
            'Pinned entries never expire; unpinned history trims beyond this limit.',
            10, 200, 10
        ));
        hubGroup.add(this._bindSwitch(
            settings,
            'enable-shelf',
            'Drag and Drop File Shelf',
            'Stage temporary files and screenshots via Wayland drag-and-drop bridge or file copy.'
        ));
        hubGroup.add(this._bindSwitch(
            settings,
            'shelf-drag-reveal',
            'Reveal Drop Catcher on Drag',
            'Automatically morph into a drop zone when dragging files near the top-center handle.'
        ));
        hubGroup.add(this._bindSwitch(
            settings,
            'shelf-screenshot-auto-stash',
            'Auto-Stash New Screenshots',
            'Automatically stage newly saved GNOME screenshots into the Shelf tab.'
        ));
        page.add(hubGroup);

        const hwGroup = new Adw.PreferencesGroup({
            title: 'System, Hardware and Media',
        });
        hwGroup.add(this._bindSwitch(
            settings,
            'enable-osd',
            'Replace GNOME OSD',
            'Smooth morphing pill for Volume, Brightness, Mic Mute, Airplane Mode, and Caffeine.'
        ));
        hwGroup.add(this._bindSwitch(
            settings,
            'enable-power',
            'Power and ThinkPad Battery Events',
            'AC plug/unplug cards, low battery alerts, and BAT0 charge threshold readout.'
        ));
        hwGroup.add(this._bindSwitch(
            settings,
            'enable-privacy',
            'Privacy Indicators (Cam and Mic)',
            'Real-time status pill via Shell.CameraMonitor and PipeWire/Pulse Gvc streams.'
        ));
        hwGroup.add(this._bindSwitch(
            settings,
            'enable-mpris',
            'Universal MPRIS Media Controller',
            'Album art, GPU-animated equalizer bars, multi-player switcher, and playback controls.'
        ));
        hwGroup.add(this._bindSpin(
            settings,
            'mpris-hide-delay',
            'Hide Paused Media After (seconds)',
            'Set to 0 to keep paused media visible indefinitely.',
            0, 300, 5
        ));
        page.add(hwGroup);

        const prodGroup = new Adw.PreferencesGroup({
            title: 'Notifications, Timer and Monitoring',
        });
        prodGroup.add(this._bindSwitch(
            settings,
            'enable-notifications',
            'Notification Peeking',
            'Render incoming notifications inside BayIsland while keeping two-way MessageTray sync.'
        ));
        prodGroup.add(this._bindSpin(
            settings,
            'notification-duration',
            'Notification Display Duration (ms)',
            'Hovering the pill freezes auto-dismiss until pointer leaves.',
            1500, 15000, 500
        ));
        prodGroup.add(this._bindSwitch(
            settings,
            'enable-timer',
            'Built-in Timer and Pomodoro',
            'Countdown and 25m Pomodoro inside the pill and Home tab.'
        ));
        prodGroup.add(this._bindSwitch(
            settings,
            'enable-resource-spike',
            'Resource Spike Warning',
            'Alert on sustained high CPU or RAM usage (2 consecutive samples, 60s cooldown).'
        ));
        prodGroup.add(this._bindSpin(
            settings,
            'resource-cpu-threshold',
            'CPU Warning Threshold (%)',
            'Trigger spike warning when sustained CPU load meets this value.',
            50, 99, 1
        ));
        prodGroup.add(this._bindSpin(
            settings,
            'resource-ram-threshold',
            'RAM Warning Threshold (%)',
            'Trigger spike warning when memory usage meets this value.',
            50, 99, 1
        ));
        prodGroup.add(this._bindSwitch(
            settings,
            'enable-dbus-service',
            'D-Bus Service (org.bayisland.Shell)',
            'Allow terminal hooks and external scripts to send tasks, banners, shelf files, and timers.'
        ));
        page.add(prodGroup);

        return page;
    }

    _buildCompatPage(shellSettings, window) {
        const page = new Adw.PreferencesPage({
            title: 'Compatibility',
            icon_name: 'preferences-other-symbolic',
        });

        const enabledSet = new Set(shellSettings?.get_strv('enabled-extensions') ?? []);
        const disabledSet = new Set(shellSettings?.get_strv('disabled-extensions') ?? []);

        const detectStatus = (uuid, activeDesc, inactiveDesc) => {
            if (enabledSet.has(uuid) && !disabledSet.has(uuid))
                return { active: true, text: activeDesc };
            return { active: false, text: inactiveDesc };
        };

        const group = new Adw.PreferencesGroup({
            title: 'Installed Extension Coexistence',
            description: 'Live check against org.gnome.shell enabled-extensions.',
        });

        const checks = [
            [
                'Hide Top Bar (hidetopbar@mathieu.bidon.ca)',
                detectStatus(
                    'hidetopbar@mathieu.bidon.ca',
                    'Active — BayIsland yields built-in autohide cleanly, clears y=0..4 for idle bar, and drops below visible Top Bar.',
                    'Inactive (Built-in Intellihide / Always Hide available on the Appearance tab)'
                ),
            ],
            [
                'OpenBar (openbar@neuromorph)',
                detectStatus('openbar@neuromorph', 'Active — Accent palette sync supported.', 'Inactive'),
            ],
            [
                'Blur my Shell (blur-my-shell@aunetx)',
                detectStatus('blur-my-shell@aunetx', 'Active — Isolated via .bayisland-* CSS classes.', 'Inactive'),
            ],
            [
                'Clipboard History (clipboard-history@alexsaveau.dev)',
                detectStatus('clipboard-history@alexsaveau.dev', 'Active — Coexisting cleanly; disable anytime if you prefer BayIsland Clip tab.', 'Inactive'),
            ],
            [
                'Battery Health Charging (Battery-Health-Charging@maniacx.github.com)',
                detectStatus('Battery-Health-Charging@maniacx.github.com', 'Active — BayIsland Power tab keeps BAT0 thresholds strictly read-only.', 'Inactive'),
            ],
            [
                'Quick Settings Tweaks (quick-settings-tweaks@qwreey)',
                detectStatus('quick-settings-tweaks@qwreey', 'Active — Two-way MessageTray notification sync without altering Quick Settings.', 'Inactive'),
            ],
            [
                'Media Controls (mediacontrols@cliffniff.github.com)',
                detectStatus('mediacontrols@cliffniff.github.com', 'Active — Warning: may show duplicate MPRIS widget.', 'Disabled (Recommended)'),
            ],
            [
                'Caffeine (caffeine@patapon.info)',
                detectStatus('caffeine@patapon.info', 'Active — OSD notifications forwarded cleanly.', 'Inactive'),
            ],
        ];

        for (const [title, status] of checks) {
            const row = new Adw.ActionRow({
                title,
                subtitle: status.text,
            });
            row.add_prefix(new Gtk.Image({
                icon_name: status.active ? 'emblem-ok-symbolic' : 'radio-symbolic',
            }));
            group.add(row);
        }
        page.add(group);

        const testGroup = new Adw.PreferencesGroup({
            title: 'Live Diagnostics',
            description: 'Send a live test banner via org.bayisland.Shell if BayIsland is currently running.',
        });

        const testRow = new Adw.ActionRow({
            title: 'Preview Dynamic Island Banner',
            subtitle: 'Calls org.bayisland.Shell.ShowBanner on session D-Bus.',
        });
        const testBtn = new Gtk.Button({
            label: 'Send Test Banner',
            valign: Gtk.Align.CENTER,
            css_classes: ['suggested-action'],
        });
        testBtn.connect('clicked', () => {
            Gio.DBus.session.call(
                'org.bayisland.Shell',
                '/org/bayisland/Shell',
                'org.bayisland.Shell',
                'ShowBanner',
                new GLib.Variant('(sssi)', ['BayIsland Ready', '5-Tab Hub, Clipboard, Shelf, and Power ready', 'emblem-ok-symbolic', 3000]),
                null,
                Gio.DBusCallFlags.NO_AUTO_START,
                1500,
                null,
                (conn, res) => {
                    try {
                        conn.call_finish(res);
                        window.add_toast?.(new Adw.Toast({ title: 'Test banner dispatched to BayIsland.' }));
                    } catch {
                        window.add_toast?.(new Adw.Toast({ title: 'BayIsland D-Bus not active in current session.' }));
                    }
                }
            );
        });
        testRow.add_suffix(testBtn);
        testGroup.add(testRow);
        page.add(testGroup);

        return page;
    }

    _buildShortcutsPage(settings, window, cleanups) {
        const page = new Adw.PreferencesPage({
            title: 'Shortcuts and CLI',
            icon_name: 'preferences-desktop-keyboard-symbolic',
        });

        const keyGroup = new Adw.PreferencesGroup({
            title: 'Keyboard Shortcuts',
            description: 'Click a shortcut to rebind, or press Backspace inside the dialog to clear.',
        });

        keyGroup.add(this._createShortcutRow(
            settings,
            'toggle-expand-shortcut',
            '<Super><Alt>i',
            'Toggle Expanded Bento Hub',
            'Open or collapse BayIsland using your configured Default Tab.',
            window,
            cleanups
        ));
        keyGroup.add(this._createShortcutRow(
            settings,
            'quick-clipboard-shortcut',
            '<Super><Alt>v',
            'Quick Clipboard History Tab',
            'Open directly to BayIsland Clipboard History for search and click-to-paste.',
            window,
            cleanups
        ));
        keyGroup.add(this._createShortcutRow(
            settings,
            'quick-shelf-shortcut',
            '<Super><Alt>d',
            'Quick File Shelf Tab',
            'Open directly to the Drag and Drop Temporary File Shelf.',
            window,
            cleanups
        ));
        keyGroup.add(this._createShortcutRow(
            settings,
            'quick-timer-shortcut',
            '<Super><Alt>t',
            'Quick Home and Focus Timer',
            'Open directly to BayIsland Home tab with Calendar, Quick Actions, Notifications, and Timer.',
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

    _createShortcutRow(settings, key, defaultAccel, title, subtitle, parentWindow, cleanups) {
        const row = new Adw.ActionRow({ title, subtitle });

        const box = new Gtk.Box({
            spacing: 6,
            valign: Gtk.Align.CENTER,
        });

        const shortcutBtn = new Gtk.Button({
            css_classes: ['flat'],
        });
        const accelLabel = new Gtk.ShortcutLabel({
            disabled_text: 'Disabled',
        });
        shortcutBtn.set_child(accelLabel);

        const syncAccel = () => {
            const list = settings.get_strv(key);
            accelLabel.set_accelerator(list[0] ?? '');
        };
        syncAccel();
        const sigId = settings.connect(`changed::${key}`, syncAccel);
        cleanups.push(() => settings.disconnect(sigId));

        shortcutBtn.connect('clicked', () => {
            this._promptShortcut(parentWindow, title, newAccel => {
                settings.set_strv(key, newAccel ? [newAccel] : []);
            });
        });

        const resetBtn = new Gtk.Button({
            icon_name: 'edit-undo-symbolic',
            tooltip_text: `Reset to ${defaultAccel}`,
            css_classes: ['flat'],
        });
        resetBtn.connect('clicked', () => settings.set_strv(key, [defaultAccel]));

        box.append(shortcutBtn);
        box.append(resetBtn);
        row.add_suffix(box);
        row.activatable_widget = shortcutBtn;
        return row;
    }

    _promptShortcut(parent, title, onDone) {
        const dialog = new Adw.Window({
            transient_for: parent,
            modal: true,
            title: `Set Shortcut — ${title}`,
            default_width: 360,
            default_height: 180,
            resizable: false,
        });

        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            margin_top: 24,
            margin_bottom: 24,
            margin_start: 24,
            margin_end: 24,
            valign: Gtk.Align.CENTER,
        });
        box.append(new Gtk.Label({
            label: 'Press a new key combination now…',
            css_classes: ['title-4'],
        }));
        box.append(new Gtk.Label({
            label: 'Press Esc to cancel, or Backspace to disable shortcut.',
            css_classes: ['dim-label'],
        }));
        dialog.set_content(box);

        const controller = new Gtk.EventControllerKey();
        controller.connect('key-pressed', (_ctrl, keyval, _keycode, state) => {
            const mask = state & Gtk.accelerator_get_default_mod_mask();
            if (mask === 0 && keyval === Gdk.KEY_Escape) {
                dialog.close();
                return Gdk.EVENT_STOP;
            }
            if (mask === 0 && keyval === Gdk.KEY_BackSpace) {
                onDone('');
                dialog.close();
                return Gdk.EVENT_STOP;
            }
            if (!Gtk.accelerator_valid(keyval, mask))
                return Gdk.EVENT_STOP;

            const accel = Gtk.accelerator_name(keyval, mask);
            if (accel) {
                onDone(accel);
                dialog.close();
            }
            return Gdk.EVENT_STOP;
        });
        dialog.add_controller(controller);
        dialog.present();
    }
}
