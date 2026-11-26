import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

export const PILL_STYLES = [
    { value: 'floating', label: 'Floating Pill (Recommended)' },
    { value: 'notch', label: 'Top Notch (Screen Edge)' },
];

export const INTEGRATION_MODES = [
    { value: 'merged-pill', label: 'Merge with Top Bar Clock (Unified Pill)' },
    { value: 'separate', label: 'Separate (Floating Handle Below Top Bar)' },
];

export const MERGED_PRESETS = [
    { value: 'hover-pill', label: 'Hover Pill Status (Battery + Clock + Profile + Badge)' },
    { value: 'minimal-clock', label: 'Minimal Clock (Expands to Pill on Hover)' },
    { value: 'handle-clock', label: 'Clock + Pastel Handle Accent (Expands on Hover)' },
];

export const AUTOHIDE_MODES = [
    { value: 'disabled', label: 'Disabled (Always Keep GNOME Top Bar)' },
    { value: 'intellihide', label: 'Intellihide (Hide When Windows Touch Top Bar)' },
    { value: 'always', label: 'Always Hide GNOME Top Bar' },
];

export const AUTOHIDE_HOVER_MODES = [
    { value: 'edges', label: 'Left & Right Screen Edges (Recommended for BayIsland)' },
    { value: 'full-width', label: 'Full Width Across Top Edge' },
    { value: 'off', label: 'Disabled (Overview / Super+S Only)' },
];

export const COLLISION_MODES = [
    { value: 'drop-below', label: 'Option A: Drop Below Top Bar' },
    { value: 'hide-idle', label: 'Hide Idle Pill While Top Bar Shows' },
    { value: 'overlay', label: 'Overlay Top Center' },
];

export const MONITOR_MODES = [
    { value: 'primary', label: 'Primary Monitor (Default)' },
    { value: 'active', label: 'Active Monitor (Follow Focus in Separate Mode)' },
];

export const FULLSCREEN_IDLE_MODES = [
    { value: 'visible', label: 'Keep Pill Line Visible (Default)' },
    { value: 'hover-only', label: 'Hide When Clear (Show if Unread Notifs / Hover)' },
];

export const DEFAULT_TABS = [
    { value: 'auto', label: 'Smart Auto (Media if Playing, else Home)' },
    { value: 'home', label: 'Home (Clock, Calendar, Quick Actions, Notifications)' },
    { value: 'media', label: 'Media and Audio Output' },
    { value: 'power', label: 'Power and Battery Telemetry' },
    { value: 'clipboard', label: 'Clipboard History' },
    { value: 'shelf', label: 'Drag and Drop File Shelf' },
];

export const MEDIA_CLOCK_POSITIONS = [
    { value: 'none', label: 'Disabled (Media Only)' },
    { value: 'left', label: 'Left Side of Media Island' },
    { value: 'right', label: 'Right Side of Media Island' },
];

export const DEFAULT_TAB_ORDER = ['home', 'media', 'power', 'clipboard', 'shelf'];

export const TAB_ORDER_INFO = {
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

export const ACCENT_PRESETS = [
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

export const PASTE_SHORTCUTS = [
    { value: 'shift-insert', label: 'Shift+Insert (Works in Apps and Terminal)' },
    { value: 'ctrl-v', label: 'Ctrl+V (Standard Desktop Apps)' },
];

export function normalizeAccentHex(raw) {
    if (typeof raw !== 'string')
        return '#93C5FD';
    let clean = raw.trim().replace(/^#/, '');
    if (clean.length === 3)
        clean = clean.split('').map(c => `${c}${c}`).join('');
    if (!/^[0-9a-fA-F]{6}$/.test(clean))
        return '#93C5FD';
    return `#${clean.toUpperCase()}`;
}

export function rgbaToHex(rgba) {
    const toHex = f => Math.max(0, Math.min(255, Math.round(f * 255)))
        .toString(16)
        .padStart(2, '0')
        .toUpperCase();
    return `#${toHex(rgba.red)}${toHex(rgba.green)}${toHex(rgba.blue)}`;
}

export function normalizeTabOrder(raw) {
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

export function bindCombo(settings, key, options, row, cleanups) {
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

export function bindSwitch(settings, key, title, subtitle) {
    const row = new Adw.SwitchRow({ title, subtitle });
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

export function bindSpin(settings, key, title, subtitle, lower, upper, step) {
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

export function createShortcutRow(settings, key, defaultAccel, title, subtitle, parentWindow, cleanups) {
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
        promptShortcut(parentWindow, title, newAccel => {
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

export function promptShortcut(parent, title, onDone) {
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
