#!/usr/bin/env gjs -m
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix?version=2.0';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';

const WINDOW_TITLE = '__bayisland_dnd_bridge__';

function sendMsg(obj) {
    print(JSON.stringify(obj));
}

function parseDropValue(value) {
    const uris = [];
    let text = null;

    if (!value)
        return { uris, text };

    if (typeof value.get_files === 'function') {
        for (const f of value.get_files()) {
            const u = f?.get_uri?.();
            if (u)
                uris.push(u);
        }
    } else if (typeof value.get_uri === 'function') {
        const u = value.get_uri();
        if (u)
            uris.push(u);
    } else if (typeof value === 'string') {
        const lines = value
            .split(/\r?\n/)
            .map(l => l.trim())
            .filter(Boolean);
        const uriLines = lines.filter(l => l.startsWith('file://'));
        if (uriLines.length > 0 && uriLines.length === lines.length)
            uris.push(...uriLines);
        else if (value.trim())
            text = value;
    }

    return { uris, text };
}

class DndBridgeApp {
    constructor() {
        this._app = new Gtk.Application({
            application_id: 'org.bayisland.DndBridge',
            flags: Gio.ApplicationFlags.NON_UNIQUE,
        });

        this._win = null;
        this._rootBox = null;
        this._dropBox = null;
        this._listBox = null;
        this._stdinStream = null;
        this._items = [];
        this._pendingShow = null;

        this._app.connect('activate', () => this._onActivate());
    }

    run() {
        return this._app.run([]);
    }

    _onActivate() {
        this._app.hold();

        const css = new Gtk.CssProvider();
        css.load_from_data(`
            window.bayisland-bridge,
            window.bayisland-bridge box,
            window.bayisland-bridge scrolledwindow {
                background-color: rgba(15, 23, 42, 0.01);
                background-image: none;
                box-shadow: none;
                border: none;
                color: transparent;
            }
        `, -1);
        Gtk.StyleContext.add_provider_for_display(
            Gdk.Display.get_default(),
            css,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
        );

        this._win = new Gtk.ApplicationWindow({
            application: this._app,
            title: WINDOW_TITLE,
            decorated: false,
            resizable: false,
            focusable: false,
            can_focus: false,
            focus_on_click: false,
            default_width: 280,
            default_height: 64,
        });
        this._win.add_css_class('bayisland-bridge');

        const winMotion = new Gtk.EventControllerMotion();
        winMotion.connect('enter', () => sendMsg({ event: 'pointer-enter' }));
        winMotion.connect('leave', () => sendMsg({ event: 'pointer-leave' }));
        this._win.add_controller(winMotion);

        this._rootBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            hexpand: true,
            vexpand: true,
        });

        // Upper/Full drop catcher widget
        this._dropBox = new Gtk.Box({
            hexpand: true,
            vexpand: false,
            height_request: 72,
        });
        this._attachDropTarget(this._dropBox);
        this._rootBox.append(this._dropBox);

        // Transparent drag-source rows aligned over BayIsland's Shelf rows
        this._listBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            hexpand: true,
            vexpand: true,
            spacing: 6,
        });
        this._attachDropTarget(this._listBox);
        this._rootBox.append(this._listBox);

        this._win.set_child(this._rootBox);
        this._startStdinReader();

        if (this._pendingShow)
            this._applyShow(this._pendingShow);

        sendMsg({ event: 'ready' });
    }

    _attachDropTarget(widget) {
        const dropTarget = Gtk.DropTarget.new(GObject.TYPE_NONE, Gdk.DragAction.COPY);
        dropTarget.set_gtypes([Gdk.FileList.$gtype, Gio.File.$gtype, GObject.TYPE_STRING]);

        dropTarget.connect('enter', () => {
            sendMsg({ event: 'drag-enter' });
            return Gdk.DragAction.COPY;
        });

        dropTarget.connect('motion', () => Gdk.DragAction.COPY);

        dropTarget.connect('leave', () => {
            sendMsg({ event: 'drag-leave' });
        });

        dropTarget.connect('drop', (_target, value) => {
            const { uris, text } = parseDropValue(value);
            if (uris.length > 0 || text) {
                sendMsg({ event: 'drop', uris, text });
                return true;
            }
            return false;
        });

        widget.add_controller(dropTarget);
    }

    _rebuildDragRows(items, rowHeight = 46, dragZoneWidth = 370) {
        let child = this._listBox.get_first_child();
        while (child) {
            const next = child.get_next_sibling();
            this._listBox.remove(child);
            child = next;
        }

        for (const item of (items || [])) {
            const rowHandle = new Gtk.Box({
                height_request: rowHeight,
                width_request: dragZoneWidth,
                halign: Gtk.Align.START,
                hexpand: false,
            });

            const dragSource = new Gtk.DragSource({
                actions: Gdk.DragAction.COPY,
            });
            dragSource.connect('prepare', () => {
                try {
                    if (item.uri) {
                        const fileList = Gdk.FileList.new_from_array([Gio.File.new_for_uri(item.uri)]);
                        return Gdk.ContentProvider.new_for_value(fileList);
                    }
                    if (item.text)
                        return Gdk.ContentProvider.new_for_value(item.text);
                } catch {
                    return null;
                }
                return null;
            });
            dragSource.connect('drag-begin', (_src, drag) => {
                sendMsg({ event: 'drag-out-begin', id: item.id });
                try {
                    const iconTheme = Gtk.IconTheme.get_for_display(Gdk.Display.get_default());
                    const iconName = item.iconName || 'text-x-generic-symbolic';
                    if (iconTheme.has_icon(iconName)) {
                        const paintable = iconTheme.lookup_icon(iconName, null, 36, 1, Gtk.TextDirection.NONE, 0);
                        Gtk.DragIcon.set_from_paintable(drag, paintable, 18, 18);
                    }
                } catch {
                    // Optional icon
                }
            });
            dragSource.connect('drag-end', () => {
                sendMsg({ event: 'drag-out-end', id: item.id });
            });

            rowHandle.add_controller(dragSource);
            this._listBox.append(rowHandle);
        }
    }

    _applyShow(cmd) {
        if (!this._win) {
            this._pendingShow = cmd;
            return;
        }

        const width = Math.max(80, Math.round(cmd.width || 320));
        const height = Math.max(40, Math.round(cmd.height || 64));
        const dropHeight = Math.max(36, Math.round(cmd.dropHeight ?? height));

        this._dropBox.set_size_request(width, dropHeight);
        this._listBox.visible = cmd.mode === 'shelf';
        if (cmd.mode === 'shelf')
            this._rebuildDragRows(cmd.items || [], cmd.rowHeight || 46, cmd.dragZoneWidth || (width - 140));
        else
            this._rebuildDragRows([]);

        this._win.set_default_size(width, height);
        this._win.set_size_request(width, height);
        this._win.show();
        this._win.present();
        sendMsg({
            event: 'shown',
            x: Math.round(cmd.x || 0),
            y: Math.round(cmd.y || 0),
            width,
            height,
        });
    }

    _openFilePicker() {
        try {
            const dialog = new Gtk.FileDialog({
                title: 'Add Files to BayIsland Shelf',
                modal: true,
            });
            sendMsg({ event: 'picker-open' });
            dialog.open_multiple(null, null, (dlg, res) => {
                try {
                    const files = dlg.open_multiple_finish(res);
                    const uris = [];
                    const n = files?.get_n_items?.() ?? 0;
                    for (let i = 0; i < n; i++) {
                        const f = files.get_item(i);
                        const u = f?.get_uri?.();
                        if (u)
                            uris.push(u);
                    }
                    sendMsg({ event: 'picker-result', uris });
                } catch {
                    sendMsg({ event: 'picker-result', uris: [] });
                }
            });
        } catch {
            sendMsg({ event: 'picker-result', uris: [] });
        }
    }

    _handleCommand(line) {
        if (!line)
            return;
        let msg;
        try {
            msg = JSON.parse(line);
        } catch {
            return;
        }

        switch (msg.cmd) {
        case 'show':
            this._applyShow(msg);
            break;
        case 'update-items':
            if (this._win?.visible)
                this._rebuildDragRows(msg.items || [], msg.rowHeight || 46, msg.dragZoneWidth || 380);
            break;
        case 'hide':
            if (this._win)
                this._win.hide();
            break;
        case 'pick-files':
            this._openFilePicker();
            break;
        case 'quit':
            this._app.release();
            this._app.quit();
            break;
        }
    }

    _startStdinReader() {
        const unixIn = new GioUnix.InputStream({ fd: 0, close_fd: false });
        this._stdinStream = new Gio.DataInputStream({ base_stream: unixIn });

        const readNext = () => {
            this._stdinStream.read_line_async(GLib.PRIORITY_DEFAULT, null, (stream, res) => {
                try {
                    const [line] = stream.read_line_finish_utf8(res);
                    if (line === null) {
                        this._app.quit();
                        return;
                    }
                    this._handleCommand(line.trim());
                    readNext();
                } catch {
                    this._app.quit();
                }
            });
        };
        readNext();
    }
}

const app = new DndBridgeApp();
app.run();
