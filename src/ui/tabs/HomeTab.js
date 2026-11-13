import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';
import * as Calendar from 'resource:///org/gnome/shell/ui/calendar.js';

import { formatNotificationContent } from '../../utils/NotifFormatter.js';

const EN_WEEKDAYS = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
const EN_DAY_INITIALS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const EN_MONTHS = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
];

function formatClock(sec) {
    const s = Math.max(0, Math.floor(sec));
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return `${String(m).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
}

function formatRelativeTime(tsMs) {
    const diffSec = Math.max(0, Math.floor((Date.now() - tsMs) / 1000));
    if (diffSec < 10)
        return 'just now';
    if (diffSec < 60)
        return `${diffSec}s`;
    const mins = Math.floor(diffSec / 60);
    if (mins < 60)
        return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24)
        return `${hrs}h`;
    return `${Math.floor(hrs / 24)}d`;
}

function getLocalClockStrings() {
    const now = GLib.DateTime.new_now_local();
    let use24h = true;
    try {
        const src = Gio.SettingsSchemaSource.get_default();
        const schema = src?.lookup('org.gnome.desktop.interface', true);
        if (schema) {
            const gs = new Gio.Settings({ settings_schema: schema });
            use24h = gs.get_string('clock-format') !== '12h';
        }
    } catch {
        use24h = true;
    }

    const timeStr = use24h ? now.format('%H:%M:%S') : now.format('%I:%M:%S %p');
    const dow = now.get_day_of_week() % 7;
    const monthIdx = Math.max(0, Math.min(11, now.get_month() - 1));
    return {
        weekday: EN_WEEKDAYS[dow],
        dayNum: String(now.get_day_of_month()),
        monthYear: `${EN_MONTHS[monthIdx]} ${now.get_year()}`,
        timeStr: timeStr || '00:00:00',
    };
}

function formatEventTime(ev) {
    try {
        const dt = GLib.DateTime.new_from_unix_local(Math.floor(ev.date.getTime() / 1000));
        return dt.format('%H:%M') || '';
    } catch {
        return '';
    }
}

function isSameLocalDay(a, b) {
    return a instanceof Date &&
        b instanceof Date &&
        a.getFullYear() === b.getFullYear() &&
        a.getMonth() === b.getMonth() &&
        a.getDate() === b.getDate();
}

function isRasterAvatarIcon(gicon) {
    if (!gicon)
        return false;
    if (gicon instanceof Gio.FileIcon || gicon instanceof Gio.BytesIcon)
        return true;
    if (gicon instanceof Gio.ThemedIcon) {
        const names = gicon.get_names?.() ?? [];
        return names.length > 0 && names.every(n => !n.endsWith('-symbolic'));
    }
    return false;
}

export class HomeTab {
    constructor({ callbacks, timers }) {
        this._cb = callbacks;
        this._timers = timers;

        this._root = null;
        this._weekdayLabel = null;
        this._dayLabel = null;
        this._monthYearLabel = null;
        this._clockLabel = null;
        this._clockTickId = 0;

        this._calendar = null;
        this._eventSource = null;
        this._calDateSigId = 0;
        this._calScrollSigId = 0;
        this._calEvSigId = 0;
        this._calStyleTimerId = 0;
        this._agendaBox = null;
        this._selectedDate = new Date();

        this._timerValueLabel = null;
        this._timerSubLabel = null;
        this._timerToggleBtn = null;
        this._qaHintLabel = null;
        this._quickBtns = {};

        this._feedBox = null;
        this._feedScroll = null;
        this._notifCountPill = null;
        this._clearAllBtn = null;
        this._lastHistory = null;
        this._lastPalette = null;
        this._isClearingFeed = false;
        this._heroRow = null;
        this._qaCard = null;
        this._timerCard = null;
        this._feedCard = null;

        // Scratchpad / Interactive To-Do
        this._activeFeedTab = 'notifications';
        this._scratchTasks = this._loadScratchpadTasks();
        this._scratchBox = null;
        this._scratchScroll = null;
        this._scratchEntry = null;
        this._scratchCountPill = null;
        this._clearTasksBtn = null;
        this._notifTabBtn = null;
        this._taskTabBtn = null;

        const pendingInitial = this._scratchTasks.filter(t => !t.done).length;
        if (pendingInitial > 0)
            this._cb.onTasksCountChanged?.(pendingInitial);
    }

    render(model, palette, quickSnapshot, notifHistory) {
        this.destroy();

        this._lastPalette = palette ?? null;
        this._lastHistory = notifHistory ?? { notifications: [], tasks: [], totalUnread: 0 };

        const acc = palette?.accentCss || '#93c5fd';
        const accOnDark = palette?.accentOnDarkCss || acc;

        const root = new St.BoxLayout({
            style_class: 'bayisland-bento-grid',
            x_expand: true,
            y_expand: true,
        });

        // Left Column (344px): Today Agenda + Borderless Calendar (top), Hardware Quick Actions (bottom)
        const leftCol = new St.BoxLayout({
            style_class: 'bayisland-home-left',
            vertical: true,
            x_expand: false,
            y_expand: true,
        });

        // 1. Editorial Hero Date + Side-by-Side Borderless Calendar
        const heroRow = new St.BoxLayout({
            style_class: 'bayisland-home-hero',
            x_expand: true,
        });

        const dateCol = new St.BoxLayout({
            vertical: true,
            style_class: 'bayisland-hero-date-col',
            y_align: Clutter.ActorAlign.START,
        });

        const nowStrings = getLocalClockStrings();
        this._weekdayLabel = new St.Label({
            text: nowStrings.weekday,
            style_class: 'bayisland-hero-weekday',
            style: `color: ${accOnDark};`,
        });
        this._dayLabel = new St.Label({
            text: nowStrings.dayNum,
            style_class: 'bayisland-hero-day',
        });
        this._monthYearLabel = new St.Label({
            text: nowStrings.monthYear,
            style_class: 'bayisland-hero-month',
        });
        this._clockLabel = new St.Label({
            text: nowStrings.timeStr,
            style_class: 'bayisland-hero-clock',
        });

        dateCol.add_child(this._weekdayLabel);
        dateCol.add_child(this._dayLabel);
        dateCol.add_child(this._monthYearLabel);
        dateCol.add_child(this._clockLabel);

        this._agendaBox = new St.BoxLayout({
            style_class: 'bayisland-agenda-box',
            vertical: true,
            x_expand: true,
        });
        dateCol.add_child(this._agendaBox);
        heroRow.add_child(dateCol);

        try {
            const calWrap = new St.BoxLayout({
                style_class: 'bayisland-calendar-wrap',
                vertical: true,
                x_expand: true,
            });
            if (!this._eventSource) {
                this._eventSource = new Calendar.DBusEventSource();
                this._calEvSigId = this._eventSource.connect('changed', () => {
                    this._refreshAgenda();
                    this._scheduleCalendarStyle();
                });
            }
            const cal = new Calendar.Calendar();
            this._calendar = cal;
            this._calendar.setEventSource(this._eventSource);
            cal.connect('destroy', () => {
                if (this._calendar === cal) {
                    this._calendar = null;
                    this._calDateSigId = 0;
                    this._calScrollSigId = 0;
                }
            });
            this._calDateSigId = this._calendar.connect('selected-date-changed', (_c, datetime) => {
                this._selectedDate = new Date(datetime.to_unix() * 1000);
                this._refreshAgenda();
                this._scheduleCalendarStyle();
            });
            this._calScrollSigId = this._calendar.connect('scroll-event', () => {
                this._scheduleCalendarStyle();
                return Clutter.EVENT_PROPAGATE;
            });
            if (this._selectedDate && !isSameLocalDay(this._selectedDate, new Date())) {
                try {
                    const unixSec = Math.floor(this._selectedDate.getTime() / 1000);
                    const gdt = GLib.DateTime.new_from_unix_local(unixSec);
                    if (gdt)
                        this._calendar.setDate(gdt, false);
                } catch {
                    // Best effort selected date restore
                }
            }
            calWrap.add_child(this._calendar);
            heroRow.add_child(calWrap);
            this._styleCalendar();
        } catch (e) {
            heroRow.add_child(new St.Label({
                text: `Calendar unavailable: ${e.message}`,
                style_class: 'bayisland-muted-sm',
            }));
        }

        this._refreshAgenda();
        this._heroRow = heroRow;
        leftCol.add_child(heroRow);
        leftCol.add_child(new St.Widget({ y_expand: true }));

        // 2. Hardware Quick Actions (6x1 Icon-Only Solid Active Squircles + Hover Label Hint)
        const qaCard = new St.BoxLayout({
            style_class: 'bayisland-bento-card',
            vertical: true,
            x_expand: true,
            style: 'spacing: 8px; padding: 10px 12px;',
        });
        this._qaCard = qaCard;

        const qaHeader = new St.BoxLayout({
            x_expand: true,
            style: 'spacing: 8px;',
            y_align: Clutter.ActorAlign.CENTER,
        });
        qaHeader.add_child(new St.Label({
            text: 'QUICK ACTIONS',
            style_class: 'bayisland-section-title',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._qaHintLabel = new St.Label({
            text: '',
            style_class: 'bayisland-qa-hint',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._qaHintLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        qaHeader.add_child(this._qaHintLabel);

        const settingsBtn = new St.Button({
            style_class: 'bayisland-mini-pill-btn',
            label: 'Settings',
            reactive: true,
            can_focus: false,
        });
        settingsBtn.connect('clicked', () => this._cb.onOpenSettingsApp?.('gnome-control-center.desktop'));
        qaHeader.add_child(settingsBtn);
        qaCard.add_child(qaHeader);

        const qa = quickSnapshot ?? {};
        const grid = new St.Widget({
            layout_manager: new Clutter.GridLayout({
                column_spacing: 7,
                row_spacing: 0,
                column_homogeneous: true,
            }),
            x_expand: true,
        });
        const gl = grid.layout_manager;

        this._quickBtns = {};
        const tiles = [
            {
                id: 'wifi',
                col: 0,
                icon: qa.wifiEnabled ? 'network-wireless-symbolic' : 'network-wireless-disabled-symbolic',
                label: qa.wifiEnabled ? `Wi-Fi: ${qa.wifiSsid || 'Connected'}` : 'Wi-Fi: Off',
                active: Boolean(qa.wifiEnabled),
                onClick: () => this._cb.onToggleWifi?.(),
            },
            {
                id: 'bt',
                col: 1,
                icon: qa.btEnabled ? 'bluetooth-active-symbolic' : 'bluetooth-disabled-symbolic',
                label: qa.btEnabled
                    ? `Bluetooth: ${qa.btConnectedNames?.length ? qa.btConnectedNames[0] : 'On'}`
                    : 'Bluetooth: Off',
                active: Boolean(qa.btEnabled),
                onClick: () => this._cb.onToggleBluetooth?.(),
            },
            {
                id: 'night',
                col: 2,
                icon: 'night-light-symbolic',
                label: `Night Light: ${qa.nightLight ? 'Active' : 'Off'}`,
                active: Boolean(qa.nightLight),
                onClick: () => this._cb.onToggleNightLight?.(),
            },
            {
                id: 'dnd',
                col: 3,
                icon: 'notifications-disabled-symbolic',
                label: `Do Not Disturb: ${qa.dnd ? 'Silenced' : 'Normal'}`,
                active: Boolean(qa.dnd),
                onClick: () => this._cb.onToggleDnd?.(),
            },
            {
                id: 'ss',
                col: 4,
                icon: 'applets-screenshooter-symbolic',
                label: 'Take Screenshot',
                active: false,
                onClick: () => this._cb.onTriggerScreenshot?.(),
            },
            {
                id: 'awake',
                col: 5,
                icon: 'my-caffeine-on-symbolic',
                fallbackIcon: 'preferences-desktop-screensaver-symbolic',
                label: `Keep Awake: ${qa.keepAwake ? 'Active' : 'Normal'}`,
                active: Boolean(qa.keepAwake),
                onClick: () => this._cb.onToggleKeepAwake?.(),
            },
        ];

        for (const t of tiles) {
            const tileBtn = this._buildQuickTile(t, palette);
            this._quickBtns[t.id] = tileBtn;
            gl.attach(tileBtn.btn, t.col, 0, 1, 1);
        }
        qaCard.add_child(grid);
        leftCol.add_child(qaCard);
        root.add_child(leftCol);

        // Right Column: Dedicated Focus Timer Card + Notifications & Tasks Stream
        const rightCol = new St.BoxLayout({
            style_class: 'bayisland-home-right',
            vertical: true,
            x_expand: true,
            y_expand: true,
        });
        this._timerCard = this._buildTimerCard(model.persistent.timer, palette);
        this._feedCard = this._buildFeedCard(palette);
        rightCol.add_child(this._timerCard);
        rightCol.add_child(this._feedCard);
        root.add_child(rightCol);

        this._root = root;

        this._clockTickId = this._timers.setIntervalSeconds(1, () => {
            if (!this._clockLabel)
                return false;
            const cur = getLocalClockStrings();
            this._clockLabel.text = cur.timeStr;
            if (this._weekdayLabel)
                this._weekdayLabel.text = cur.weekday;
            if (this._dayLabel)
                this._dayLabel.text = cur.dayNum;
            if (this._monthYearLabel)
                this._monthYearLabel.text = cur.monthYear;
            return true;
        });

        return root;
    }

    _scheduleCalendarStyle() {
        if (this._calStyleTimerId)
            this._timers?.clear(this._calStyleTimerId);
        this._calStyleTimerId = this._timers.setTimeout(0, () => {
            this._calStyleTimerId = 0;
            this._styleCalendar();
        });
    }

    _styleCalendar() {
        const cal = this._calendar;
        if (!cal)
            return;

        const acc = this._lastPalette?.accentCss || '#93c5fd';
        const fg = this._lastPalette?.accentFgCss || '#090d16';

        // Enforce 100% English month header regardless of system LC_TIME
        const sel = cal._selectedDate;
        const now = new Date();
        if (cal._monthLabel && sel instanceof Date) {
            cal._monthLabel.can_focus = false;
            cal._monthLabel.text = sel.getFullYear() === now.getFullYear()
                ? EN_MONTHS[sel.getMonth()]
                : `${EN_MONTHS[sel.getMonth()]} ${sel.getFullYear()}`;
        }

        if (cal._backButton)
            cal._backButton.can_focus = false;
        if (cal._forwardButton)
            cal._forwardButton.can_focus = false;

        try {
            const gl = cal.layout_manager;
            const weekStart = cal._weekStart ?? 0;
            const offsetCols = cal._useWeekdate ? 1 : 0;
            const rtl = cal.get_text_direction?.() === Clutter.TextDirection.RTL;
            if (!rtl && gl?.get_child_at) {
                for (let i = 0; i < 7; i++) {
                    const heading = gl.get_child_at(offsetCols + i, 1);
                    if (heading instanceof St.Label) {
                        heading.can_focus = false;
                        heading.text = EN_DAY_INITIALS[(weekStart + i) % 7];
                    }
                }
            }
        } catch {
            // Optional header override
        }

        for (const btn of (cal._buttons ?? [])) {
            btn.can_focus = false;
            const isToday = btn.has_style_class_name?.('calendar-today') || isSameLocalDay(btn._date, now);
            const isSelected = btn.has_style_pseudo_class?.('selected') || isSameLocalDay(btn._date, sel);
            if (isToday)
                btn.style = `background-color: ${acc}; background-image: none; color: ${fg} !important; font-weight: 700; border: none;`;
            else if (isSelected)
                btn.style = 'background-color: rgba(241, 245, 249, 0.92); background-image: none; color: #090d16 !important; font-weight: 700; border: none;';
            else
                btn.style = null;
        }
    }

    _buildQuickTile(spec, palette) {
        const acc = palette?.accentCss || '#93c5fd';
        const fg = palette?.accentFgCss || '#090d16';

        const icon = new St.Icon({
            icon_name: spec.icon,
            ...(spec.fallbackIcon ? { fallback_icon_name: spec.fallbackIcon } : {}),
            icon_size: 16,
            ...(spec.active ? { style: `color: ${fg};` } : {}),
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const btn = new St.Button({
            style_class: `bayisland-qa-tile${spec.active ? ' bayisland-qa-tile-active' : ''}`,
            ...(spec.active ? { style: `background-color: ${acc}; color: ${fg};` } : {}),
            accessible_name: spec.label,
            reactive: true,
            can_focus: false,
            track_hover: true,
            x_expand: true,
            height: 38,
            child: icon,
        });

        const tileRef = { btn, icon, label: spec.label };
        btn.connect('notify::hover', () => {
            if (!this._qaHintLabel)
                return;
            if (btn.hover) {
                this._qaHintLabel.text = tileRef.label || '';
            } else {
                const anyHovered = Object.values(this._quickBtns).some(t => t?.btn?.hover);
                if (!anyHovered)
                    this._qaHintLabel.text = '';
            }
        });
        btn.connect('clicked', () => spec.onClick?.());
        return tileRef;
    }

    updateQuickActions(quickSnapshot, palette) {
        if (palette)
            this._lastPalette = palette;
        if (!this._root || !this._quickBtns)
            return;

        const pal = palette ?? this._lastPalette;
        const acc = pal?.accentCss || '#93c5fd';
        const fg = pal?.accentFgCss || '#090d16';

        const qa = quickSnapshot ?? {};
        const updates = {
            wifi: {
                active: Boolean(qa.wifiEnabled),
                icon: qa.wifiEnabled ? 'network-wireless-symbolic' : 'network-wireless-disabled-symbolic',
                label: qa.wifiEnabled ? `Wi-Fi: ${qa.wifiSsid || 'Connected'}` : 'Wi-Fi: Off',
            },
            bt: {
                active: Boolean(qa.btEnabled),
                icon: qa.btEnabled ? 'bluetooth-active-symbolic' : 'bluetooth-disabled-symbolic',
                label: qa.btEnabled
                    ? `Bluetooth: ${qa.btConnectedNames?.length ? qa.btConnectedNames[0] : 'On'}`
                    : 'Bluetooth: Off',
            },
            night: {
                active: Boolean(qa.nightLight),
                icon: 'night-light-symbolic',
                label: `Night Light: ${qa.nightLight ? 'Active' : 'Off'}`,
            },
            dnd: {
                active: Boolean(qa.dnd),
                icon: 'notifications-disabled-symbolic',
                label: `Do Not Disturb: ${qa.dnd ? 'Silenced' : 'Normal'}`,
            },
            awake: {
                active: Boolean(qa.keepAwake),
                icon: 'my-caffeine-on-symbolic',
                label: `Keep Awake: ${qa.keepAwake ? 'Active' : 'Normal'}`,
            },
        };

        for (const [id, spec] of Object.entries(updates)) {
            const tile = this._quickBtns[id];
            if (!tile)
                continue;
            tile.label = spec.label;
            tile.icon.icon_name = spec.icon;
            tile.icon.style = spec.active ? `color: ${fg};` : null;
            tile.btn.accessible_name = spec.label;
            tile.btn.style_class = `bayisland-qa-tile${spec.active ? ' bayisland-qa-tile-active' : ''}`;
            tile.btn.style = spec.active ? `background-color: ${acc}; color: ${fg};` : null;
            if (tile.btn.hover && this._qaHintLabel)
                this._qaHintLabel.text = spec.label;
        }
    }

    _buildTimerCard(timer, palette) {
        const acc = palette?.accentCss || '#93c5fd';
        const accOnDark = palette?.accentOnDarkCss || acc;
        const fg = palette?.accentFgCss || '#090d16';

        const card = new St.BoxLayout({
            style_class: 'bayisland-bento-card',
            vertical: true,
            x_expand: true,
            style: 'spacing: 7px; padding: 10px 12px;',
        });

        const topRow = new St.BoxLayout({
            x_expand: true,
            style: 'spacing: 6px;',
            y_align: Clutter.ActorAlign.CENTER,
        });
        topRow.add_child(new St.Label({
            text: 'FOCUS TIMER',
            style_class: 'bayisland-section-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));

        const hasActive = Boolean(timer?.active);
        this._timerSubLabel = new St.Label({
            text: hasActive ? `${timer.label} • ${timer.running ? 'Run' : 'Paused'}` : 'Ready',
            style_class: 'bayisland-muted-xs',
            ...(hasActive && timer.running ? { style: `color: ${accOnDark}; font-weight: 700;` } : {}),
            y_align: Clutter.ActorAlign.CENTER,
        });
        topRow.add_child(this._timerSubLabel);
        card.add_child(topRow);

        const bottomRow = new St.BoxLayout({
            x_expand: true,
            style: 'spacing: 8px;',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._timerValueLabel = new St.Label({
            text: hasActive ? formatClock(timer.remainingSec ?? 0) : '00:00',
            style_class: 'bayisland-focus-clock',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        bottomRow.add_child(this._timerValueLabel);

        const btnRow = new St.BoxLayout({
            style: 'spacing: 5px;',
            y_align: Clutter.ActorAlign.CENTER,
        });

        if (hasActive) {
            this._timerToggleBtn = new St.Button({
                label: timer.running ? 'Pause' : 'Resume',
                style_class: 'bayisland-focus-btn bayisland-action-btn-primary',
                style: `background-color: ${acc}; color: ${fg};`,
                reactive: true,
                can_focus: false,
            });
            this._timerToggleBtn.connect('clicked', () => this._cb.onTimerTogglePause?.());
            btnRow.add_child(this._timerToggleBtn);

            const plusBtn = new St.Button({
                label: '+1m',
                style_class: 'bayisland-focus-btn',
                reactive: true,
                can_focus: false,
            });
            plusBtn.connect('clicked', () => this._cb.onTimerAddSeconds?.(60));
            btnRow.add_child(plusBtn);

            const stopBtn = new St.Button({
                label: 'Stop',
                style_class: 'bayisland-focus-btn',
                reactive: true,
                can_focus: false,
            });
            stopBtn.connect('clicked', () => this._cb.onTimerStop?.());
            btnRow.add_child(stopBtn);
        } else {
            const presets = [
                { sec: 300, label: '5m', mode: 'countdown', title: '5m Break', primary: false },
                { sec: 900, label: '15m', mode: 'countdown', title: '15m Focus', primary: false },
                { sec: 1500, label: '25m', mode: 'pomodoro', title: 'Pomodoro', primary: true },
            ];
            for (const p of presets) {
                const btn = new St.Button({
                    label: p.label,
                    style_class: `bayisland-focus-btn${p.primary ? ' bayisland-action-btn-primary' : ''}`,
                    ...(p.primary ? { style: `background-color: ${acc}; color: ${fg};` } : {}),
                    reactive: true,
                    can_focus: false,
                });
                btn.connect('clicked', () => this._cb.onTimerStart?.(p.sec, p.mode, p.title));
                btnRow.add_child(btn);
            }
        }
        bottomRow.add_child(btnRow);
        card.add_child(bottomRow);
        return card;
    }

    _loadScratchpadTasks() {
        try {
            const dirPath = GLib.build_filenamev([GLib.get_user_cache_dir(), 'bayisland']);
            const path = GLib.build_filenamev([dirPath, 'scratchpad.json']);
            const file = Gio.File.new_for_path(path);
            if (!file.query_exists(null))
                return [];
            const [, bytes] = file.load_contents(null);
            const str = new TextDecoder().decode(bytes);
            const data = JSON.parse(str);
            return Array.isArray(data) ? data : [];
        } catch {
            return [];
        }
    }

    _saveScratchpadTasks() {
        try {
            const dirPath = GLib.build_filenamev([GLib.get_user_cache_dir(), 'bayisland']);
            GLib.mkdir_with_parents(dirPath, 0o755);
            const path = GLib.build_filenamev([dirPath, 'scratchpad.json']);
            const file = Gio.File.new_for_path(path);
            const json = JSON.stringify(this._scratchTasks, null, 2);
            file.replace_contents(json, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        } catch {}
        this._updatePendingTaskCount();
    }

    _updatePendingTaskCount() {
        const pendingCount = this._scratchTasks.filter(t => !t.done).length;
        if (this._scratchCountPill) {
            this._scratchCountPill.text = String(pendingCount);
            this._scratchCountPill.visible = this._activeFeedTab === 'tasks' && pendingCount > 0;
        }
        this._cb.onTasksCountChanged?.(pendingCount);
    }

    _setFeedTab(tab, acc, fg) {
        this._activeFeedTab = tab;
        const isNotif = tab === 'notifications';

        if (this._notifTabBtn) {
            this._notifTabBtn.style_class = `bayisland-feed-seg-btn${isNotif ? ' bayisland-feed-seg-active' : ''}`;
            this._notifTabBtn.style = isNotif ? `background-color: ${acc}; color: ${fg};` : null;
        }
        if (this._taskTabBtn) {
            this._taskTabBtn.style_class = `bayisland-feed-seg-btn${!isNotif ? ' bayisland-feed-seg-active' : ''}`;
            this._taskTabBtn.style = !isNotif ? `background-color: ${acc}; color: ${fg};` : null;
        }

        if (this._notifCountPill)
            this._notifCountPill.visible = isNotif && (parseInt(this._notifCountPill.text || '0', 10) > 0);
        if (this._clearAllBtn)
            this._clearAllBtn.visible = isNotif && Boolean(this._feedBox?.get_children()?.length);

        if (this._scratchCountPill) {
            const pendingTasks = this._scratchTasks.filter(t => !t.done).length;
            this._scratchCountPill.visible = !isNotif && pendingTasks > 0;
        }
        if (this._clearTasksBtn)
            this._clearTasksBtn.visible = !isNotif && this._scratchTasks.some(t => t.done);

        if (this._scratchEntry)
            this._scratchEntry.visible = !isNotif;
        if (this._feedScroll)
            this._feedScroll.visible = isNotif;
        if (this._scratchScroll)
            this._scratchScroll.visible = !isNotif;
    }

    _populateScratchpad() {
        if (!this._scratchBox)
            return;
        this._scratchBox.destroy_all_children();

        const acc = this._lastPalette?.accentCss || '#93c5fd';
        if (this._scratchTasks.length === 0) {
            const empty = new St.BoxLayout({
                vertical: true,
                x_expand: true,
                y_expand: true,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                style: 'padding: 26px 0px; spacing: 6px;',
            });
            empty.add_child(new St.Icon({
                icon_name: 'view-list-bullet-symbolic',
                icon_size: 22,
                style: 'color: #475569;',
            }));
            empty.add_child(new St.Label({
                text: 'No tasks yet • Type above & press Enter',
                style_class: 'bayisland-muted-sm',
            }));
            this._scratchBox.add_child(empty);
            return;
        }

        for (const item of this._scratchTasks) {
            const row = new St.BoxLayout({
                style_class: 'bayisland-task-row',
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });

            const checkBtn = new St.Button({
                style_class: 'bayisland-icon-btn',
                reactive: true,
                can_focus: false,
                child: new St.Icon({
                    icon_name: item.done ? 'emblem-ok-symbolic' : 'checkbox-symbolic',
                    icon_size: 14,
                    style: item.done ? `color: ${acc};` : 'color: #64748b;',
                }),
            });
            checkBtn.connect('clicked', () => {
                item.done = !item.done;
                this._saveScratchpadTasks();
                this._populateScratchpad();
            });
            row.add_child(checkBtn);

            const textLbl = new St.Label({
                text: item.text,
                style: item.done
                    ? 'text-decoration: line-through; opacity: 0.55; color: #94a3b8; font-size: 11px;'
                    : 'color: #f8fafc; font-size: 11px; font-weight: 500;',
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            textLbl.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            row.add_child(textLbl);

            const delBtn = new St.Button({
                style_class: 'bayisland-icon-btn bayisland-icon-btn-del',
                reactive: true,
                can_focus: false,
                child: new St.Icon({
                    icon_name: 'window-close-symbolic',
                    icon_size: 11,
                }),
            });
            delBtn.connect('clicked', () => {
                this._scratchTasks = this._scratchTasks.filter(t => t.id !== item.id);
                this._saveScratchpadTasks();
                this._populateScratchpad();
            });
            row.add_child(delBtn);

            this._scratchBox.add_child(row);
        }

        if (this._clearTasksBtn)
            this._clearTasksBtn.visible = this._activeFeedTab === 'tasks' && this._scratchTasks.some(t => t.done);
    }

    _buildFeedCard(palette) {
        const acc = palette?.accentCss || '#93c5fd';
        const fg = palette?.accentFgCss || '#090d16';

        const card = new St.BoxLayout({
            style_class: 'bayisland-bento-card',
            vertical: true,
            x_expand: true,
            y_expand: true,
            style: 'spacing: 6px; padding: 10px 12px;',
        });

        const header = new St.BoxLayout({
            x_expand: true,
            style: 'spacing: 6px;',
            y_align: Clutter.ActorAlign.CENTER,
        });

        const segBox = new St.BoxLayout({
            style: 'spacing: 4px;',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._notifTabBtn = new St.Button({
            label: 'NOTIFICATIONS',
            style_class: `bayisland-feed-seg-btn${this._activeFeedTab === 'notifications' ? ' bayisland-feed-seg-active' : ''}`,
            style: this._activeFeedTab === 'notifications' ? `background-color: ${acc}; color: ${fg};` : null,
            reactive: true,
            can_focus: false,
        });
        this._taskTabBtn = new St.Button({
            label: 'TASKS',
            style_class: `bayisland-feed-seg-btn${this._activeFeedTab === 'tasks' ? ' bayisland-feed-seg-active' : ''}`,
            style: this._activeFeedTab === 'tasks' ? `background-color: ${acc}; color: ${fg};` : null,
            reactive: true,
            can_focus: false,
        });

        this._notifTabBtn.connect('clicked', () => this._setFeedTab('notifications', acc, fg));
        this._taskTabBtn.connect('clicked', () => this._setFeedTab('tasks', acc, fg));
        segBox.add_child(this._notifTabBtn);
        segBox.add_child(this._taskTabBtn);
        header.add_child(segBox);

        this._notifCountPill = new St.Label({
            text: '0',
            style_class: 'bayisland-count-pill',
            style: `background-color: ${acc}; color: ${fg};`,
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        header.add_child(this._notifCountPill);

        const pendingTasks = this._scratchTasks.filter(t => !t.done).length;
        this._scratchCountPill = new St.Label({
            text: String(pendingTasks),
            style_class: 'bayisland-count-pill',
            style: `background-color: ${acc}; color: ${fg};`,
            y_align: Clutter.ActorAlign.CENTER,
            visible: this._activeFeedTab === 'tasks' && pendingTasks > 0,
        });
        header.add_child(this._scratchCountPill);

        header.add_child(new St.Widget({ x_expand: true }));

        this._clearAllBtn = new St.Button({
            label: 'Clear',
            style_class: 'bayisland-mini-pill-btn',
            reactive: true,
            can_focus: false,
            visible: false,
        });
        this._clearAllBtn.connect('clicked', () => {
            if (this._isClearingFeed)
                return;
            this._isClearingFeed = true;
            this._clearAllBtn.reactive = false;

            const children = this._feedBox ? this._feedBox.get_children() : [];
            if (!children.length) {
                this._isClearingFeed = false;
                this._populateFeed();
                this._cb.onNotifClearAll?.();
                return;
            }

            let pending = children.length;
            const onDone = () => {
                pending--;
                if (pending <= 0) {
                    this._isClearingFeed = false;
                    this._populateFeed();
                    this._cb.onNotifClearAll?.();
                }
            };

            for (let i = 0; i < children.length; i++) {
                const child = children[i];
                child.ease({
                    translation_x: 70,
                    opacity: 0,
                    duration: 160 + Math.min(60, i * 20),
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onComplete: onDone,
                });
            }
        });
        header.add_child(this._clearAllBtn);

        this._clearTasksBtn = new St.Button({
            label: 'Clear Done',
            style_class: 'bayisland-mini-pill-btn',
            reactive: true,
            can_focus: false,
            visible: this._activeFeedTab === 'tasks' && this._scratchTasks.some(t => t.done),
        });
        this._clearTasksBtn.connect('clicked', () => {
            this._scratchTasks = this._scratchTasks.filter(t => !t.done);
            this._saveScratchpadTasks();
            this._populateScratchpad();
        });
        header.add_child(this._clearTasksBtn);
        card.add_child(header);

        // Task quick entry
        this._scratchEntry = new St.Entry({
            hint_text: '+ Add task (press Enter)…',
            style_class: 'bayisland-scratch-entry',
            can_focus: true,
            reactive: true,
            visible: this._activeFeedTab === 'tasks',
        });
        this._scratchEntry.clutter_text.connect('key-press-event', (_actor, event) => {
            const sym = event.get_key_symbol();
            if (sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter) {
                const text = (this._scratchEntry.get_text() || '').trim();
                if (text) {
                    this._scratchTasks.unshift({ id: Date.now(), text, done: false });
                    this._saveScratchpadTasks();
                    this._scratchEntry.set_text('');
                    this._populateScratchpad();
                }
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this._scratchEntry.connect('button-press-event', () => {
            this._cb.onAcquireTextModal?.(this._scratchEntry);
            return Clutter.EVENT_PROPAGATE;
        });
        this._scratchEntry.clutter_text.connect('key-focus-out', () => {
            this._cb.onReleaseTextModal?.();
        });
        card.add_child(this._scratchEntry);

        // Notifications Scroll
        this._feedScroll = new St.ScrollView({
            style_class: 'bayisland-scroll-view vfade',
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
            visible: this._activeFeedTab === 'notifications',
        });
        this._feedBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style: 'spacing: 5px;',
        });
        this._feedScroll.child = this._feedBox;
        card.add_child(this._feedScroll);

        // Scratchpad Tasks Scroll
        this._scratchScroll = new St.ScrollView({
            style_class: 'bayisland-scroll-view vfade',
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
            visible: this._activeFeedTab === 'tasks',
        });
        this._scratchBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style: 'spacing: 5px;',
        });
        this._scratchScroll.child = this._scratchBox;
        card.add_child(this._scratchScroll);

        this._populateFeed();
        this._populateScratchpad();
        this._updatePendingTaskCount();
        return card;
    }

    updateHistory(history, palette) {
        this._lastHistory = history;
        if (palette)
            this._lastPalette = palette;
        if (this._feedBox)
            this._populateFeed();
    }

    _populateFeed() {
        if (!this._feedBox)
            return;
        this._feedBox.destroy_all_children();

        const acc = this._lastPalette?.accentCss || '#93c5fd';
        const fg = this._lastPalette?.accentFgCss || '#090d16';

        const notifs = this._lastHistory?.notifications ?? [];
        const tasks = this._lastHistory?.tasks ?? [];
        const totalCount = notifs.length + tasks.length;

        if (this._notifCountPill) {
            this._notifCountPill.text = String(totalCount);
            this._notifCountPill.style = `background-color: ${acc}; color: ${fg};`;
            this._notifCountPill.visible = totalCount > 0;
        }
        if (this._clearAllBtn) {
            this._clearAllBtn.visible = totalCount > 0;
            this._clearAllBtn.reactive = true;
        }

        if (totalCount === 0) {
            const empty = new St.BoxLayout({
                vertical: true,
                x_expand: true,
                y_expand: true,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                style: 'padding: 26px 0px; spacing: 6px;',
            });
            empty.add_child(new St.Icon({
                icon_name: 'preferences-system-notifications-symbolic',
                icon_size: 22,
                style: 'color: #475569;',
            }));
            empty.add_child(new St.Label({
                text: 'All caught up',
                style_class: 'bayisland-muted-sm',
            }));
            empty.opacity = 180;
            this._feedBox.add_child(empty);
            empty.ease({
                opacity: 255,
                duration: 100,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
            return;
        }

        for (const n of notifs)
            this._feedBox.add_child(this._buildNotifCard(n));

        if (tasks.length > 0) {
            this._feedBox.add_child(new St.Label({
                text: 'TERMINAL TASK LOG',
                style_class: 'bayisland-section-title',
                style: notifs.length > 0 ? 'margin-top: 6px;' : '',
            }));
            for (const t of tasks)
                this._feedBox.add_child(this._buildTaskCard(t));
        }
    }

    _buildNotifCard(n) {
        const formatted = formatNotificationContent({
            title: n.title || 'Notification',
            body: n.body || '',
            sourceTitle: n.sourceTitle || '',
            kind: 'notification',
            maxTitleChars: 96,
            maxBodyChars: 240,
            maxSourceChars: 42,
        });
        const cleanTitle = formatted.title;
        const cleanBody = formatted.body;
        const cleanSource = formatted.metaLabel || formatted.rawSource;

        const card = new St.BoxLayout({
            style_class: `bayisland-notif-card${n.urgent ? ' bayisland-notif-card-urgent' : ''}`,
            vertical: true,
            x_expand: true,
            style: 'spacing: 4px;',
        });

        // 1. Compact single-line app/avatar/time bar + close button
        const topRow = new St.BoxLayout({
            x_expand: true,
            style: 'spacing: 6px;',
            y_align: Clutter.ActorAlign.CENTER,
        });

        const isAvatar = isRasterAvatarIcon(n.icon);
        if (isAvatar) {
            const avatarWrap = new St.Bin({
                style_class: 'bayisland-notif-avatar-wrap',
                clip_to_allocation: true,
                y_align: Clutter.ActorAlign.CENTER,
                child: new St.Icon({
                    gicon: n.icon,
                    icon_size: 14,
                }),
            });
            topRow.add_child(avatarWrap);
        } else {
            topRow.add_child(new St.Icon({
                ...(n.icon instanceof Gio.Icon
                    ? { gicon: n.icon }
                    : { icon_name: 'preferences-system-notifications-symbolic' }),
                icon_size: 15,
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }

        const sourceLbl = new St.Label({
            text: cleanSource || 'Notification',
            style_class: 'bayisland-notif-source',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        sourceLbl.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        topRow.add_child(sourceLbl);

        topRow.add_child(new St.Label({
            text: formatRelativeTime(n.timestampMs),
            style_class: 'bayisland-muted-xs',
            y_align: Clutter.ActorAlign.CENTER,
        }));

        const closeBtn = new St.Button({
            style_class: 'bayisland-icon-btn bayisland-icon-btn-del',
            reactive: true,
            can_focus: false,
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({ icon_name: 'window-close-symbolic', icon_size: 11 }),
        });
        closeBtn.connect('clicked', () => {
            closeBtn.reactive = false;
            card.ease({
                translation_x: 60,
                opacity: 0,
                duration: 150,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => {
                    this._cb.onNotifDismiss?.(n.id);
                },
            });
        });
        topRow.add_child(closeBtn);
        card.add_child(topRow);

        // 2. Full-width multi-line wrapped sender/title + body directly inside vertical card
        const contentCol = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style: 'spacing: 2px;',
        });

        const titleLbl = new St.Label({
            text: cleanTitle,
            style_class: 'bayisland-list-title',
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
        });
        titleLbl.clutter_text.line_wrap = true;
        titleLbl.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        titleLbl.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        contentCol.add_child(titleLbl);

        if (cleanBody) {
            const bodyLbl = new St.Label({
                text: cleanBody,
                style_class: 'bayisland-notif-body',
                x_expand: true,
                x_align: Clutter.ActorAlign.FILL,
            });
            bodyLbl.clutter_text.line_wrap = true;
            bodyLbl.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
            bodyLbl.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            contentCol.add_child(bodyLbl);
        }

        const contentBtn = new St.Button({
            style_class: 'bayisland-notif-body-btn',
            reactive: true,
            can_focus: false,
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            child: contentCol,
        });
        contentBtn.connect('clicked', () => this._cb.onNotifActivate?.(n.id));
        card.add_child(contentBtn);

        // 3. Stage-safe wrapped action pills
        if (n.actions?.length > 0) {
            const actionsWrap = new St.BoxLayout({
                vertical: true,
                x_expand: true,
                style: 'spacing: 4px; margin-top: 2px;',
            });

            let actRow = new St.BoxLayout({ style: 'spacing: 5px;' });
            let usedW = 0;
            const maxRowW = 280;

            for (const act of n.actions) {
                const aBtn = new St.Button({
                    label: act.label,
                    style_class: 'bayisland-mini-pill-btn',
                    reactive: true,
                    can_focus: false,
                });
                aBtn.connect('clicked', () => this._cb.onNotifAction?.(n.id, act.index));
                const estW = Math.ceil((act.label?.length || 4) * 7.2 + 24);

                if (usedW > 0 && (usedW + 5 + estW) > maxRowW) {
                    actionsWrap.add_child(actRow);
                    actRow = new St.BoxLayout({ style: 'spacing: 5px;' });
                    usedW = estW;
                } else {
                    usedW = usedW === 0 ? estW : (usedW + 5 + estW);
                }
                actRow.add_child(aBtn);
            }
            if (actRow.get_n_children() > 0)
                actionsWrap.add_child(actRow);

            card.add_child(actionsWrap);
        }

        return card;
    }

    _buildTaskCard(t) {
        const card = new St.BoxLayout({
            style_class: 'bayisland-list-card',
            x_expand: true,
            style: 'spacing: 8px;',
        });
        card.add_child(new St.Icon({
            icon_name: t.iconName,
            icon_size: 15,
            style: t.success ? 'color: #34d399;' : 'color: #f87171;',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        const col = new St.BoxLayout({ vertical: true, x_expand: true });
        const title = new St.Label({
            text: `${t.title} (${t.sourceTitle})`,
            style_class: 'bayisland-list-title',
        });
        title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        col.add_child(title);

        const body = new St.Label({
            text: t.body,
            style_class: 'bayisland-muted-xs',
        });
        body.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        col.add_child(body);
        card.add_child(col);

        card.add_child(new St.Label({
            text: formatRelativeTime(t.timestampMs),
            style_class: 'bayisland-muted-xs',
            y_align: Clutter.ActorAlign.CENTER,
        }));

        const delBtn = new St.Button({
            style_class: 'bayisland-icon-btn bayisland-icon-btn-del',
            reactive: true,
            can_focus: false,
            child: new St.Icon({ icon_name: 'window-close-symbolic', icon_size: 12 }),
        });
        delBtn.connect('clicked', () => {
            delBtn.reactive = false;
            card.ease({
                translation_x: 60,
                opacity: 0,
                duration: 150,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => {
                    this._cb.onNotifDismiss?.(t.id);
                },
            });
        });
        card.add_child(delBtn);
        return card;
    }

    _refreshAgenda() {
        if (!this._agendaBox)
            return;
        this._agendaBox.destroy_all_children();

        let events = [];
        try {
            if (this._eventSource?.hasCalendars) {
                const start = new Date(this._selectedDate);
                start.setHours(0, 0, 0, 0);
                const end = new Date(this._selectedDate);
                end.setHours(23, 59, 59, 999);
                events = this._eventSource.getEvents(start, end) ?? [];
            }
        } catch {
            events = [];
        }

        if (events.length === 0) {
            this._agendaBox.add_child(new St.Label({
                text: 'No events',
                style_class: 'bayisland-muted-xs',
            }));
            return;
        }

        for (const ev of events.slice(0, 2)) {
            const line = new St.Label({
                text: `• ${formatEventTime(ev)} ${ev.summary}`,
                style_class: 'bayisland-agenda-item',
            });
            line.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            this._agendaBox.add_child(line);
        }
    }

    updateInPlace(model) {
        if (!this._root)
            return false;
        const t = model.persistent?.timer;
        if (this._timerValueLabel && t?.active) {
            this._timerValueLabel.text = formatClock(t.remainingSec ?? 0);
            if (this._timerSubLabel) {
                const acc = this._lastPalette?.accentOnDarkCss || this._lastPalette?.accentCss || '#93c5fd';
                this._timerSubLabel.text = `${t.label} • ${t.running ? 'Run' : 'Paused'}`;
                this._timerSubLabel.style = t.running ? `color: ${acc}; font-weight: 700;` : null;
            }
            if (this._timerToggleBtn)
                this._timerToggleBtn.label = t.running ? 'Pause' : 'Resume';
        }
        return true;
    }

    destroy() {
        if (this._clockTickId) {
            this._timers?.clear(this._clockTickId);
            this._clockTickId = 0;
        }
        if (this._calStyleTimerId) {
            this._timers?.clear(this._calStyleTimerId);
            this._calStyleTimerId = 0;
        }
        if (this._calendar) {
            const cal = this._calendar;
            this._calendar = null;
            if (this._calDateSigId) {
                try { cal.disconnect(this._calDateSigId); } catch {}
                this._calDateSigId = 0;
            }
            if (this._calScrollSigId) {
                try { cal.disconnect(this._calScrollSigId); } catch {}
                this._calScrollSigId = 0;
            }
            try { cal.destroy(); } catch {}
        }
        this._weekdayLabel = null;
        this._dayLabel = null;
        this._monthYearLabel = null;
        this._clockLabel = null;
        this._agendaBox = null;
        this._timerValueLabel = null;
        this._timerSubLabel = null;
        this._timerToggleBtn = null;
        this._qaHintLabel = null;
        this._quickBtns = {};
        this._feedBox = null;
        this._notifCountPill = null;
        this._clearAllBtn = null;
        this._heroRow = null;
        this._qaCard = null;
        this._timerCard = null;
        this._feedCard = null;
        this._root = null;
    }

    disposePermanent() {
        this.destroy();
        if (this._calendar) {
            if (this._calDateSigId) {
                try { this._calendar.disconnect(this._calDateSigId); } catch {}
                this._calDateSigId = 0;
            }
            if (this._calScrollSigId) {
                try { this._calendar.disconnect(this._calScrollSigId); } catch {}
                this._calScrollSigId = 0;
            }
            try { this._calendar.destroy(); } catch {}
            this._calendar = null;
        }
        if (this._eventSource) {
            if (this._calEvSigId) {
                try { this._eventSource.disconnect(this._calEvSigId); } catch {}
                this._calEvSigId = 0;
            }
            try { GObject.signal_handlers_destroy(this._eventSource); } catch {}
            if (this._eventSource._initialized) {
                try { this._eventSource.destroy(); } catch {}
            }
            this._eventSource = null;
        }
    }
}
