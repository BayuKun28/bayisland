import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

export function buildCompatPage(shellSettings, window) {
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
