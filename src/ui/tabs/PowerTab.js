import Clutter from 'gi://Clutter';
import St from 'gi://St';

import { createRingGauge } from '../RingGauge.js';

export class PowerTab {
    constructor({ callbacks }) {
        this._cb = callbacks;
        this._root = null;
        this._driverLabel = null;
        this._modeBtns = {};
        this._cards = null;
    }

    render(_model, palette, powerSnapshot, profileSnapshot) {
        this.destroy();

        const acc = palette?.accentCss || '#93c5fd';
        const fg = palette?.accentFgCss || '#090d16';
        const pp = profileSnapshot ?? {};

        const root = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_expand: true,
            style: 'spacing: 10px;',
        });

        // 1. Power Mode Selector Bar
        const profileCard = new St.BoxLayout({
            style_class: 'bayisland-bento-card',
            vertical: true,
            x_expand: true,
            style: 'spacing: 7px; padding: 10px 14px;',
        });

        const ppTop = new St.BoxLayout({ x_expand: true, style: 'spacing: 8px;' });
        ppTop.add_child(new St.Label({
            text: 'POWER MODE',
            style_class: 'bayisland-section-title',
            y_align: Clutter.ActorAlign.CENTER,
        }));

        const drvText = pp.cpuDriver ? `Driver: ${pp.cpuDriver}` : 'power-profiles-daemon';
        this._driverLabel = new St.Label({
            text: pp.inhibitedReason ? `Inhibited (${pp.inhibitedReason})` : drvText,
            style_class: 'bayisland-muted-sm',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        ppTop.add_child(this._driverLabel);

        const bhcBtn = new St.Button({
            label: 'Power Settings',
            style_class: 'bayisland-mini-pill-btn',
            reactive: true,
            can_focus: false,
        });
        bhcBtn.connect('clicked', () => this._cb.onOpenSettingsApp?.('gnome-power-panel.desktop'));
        ppTop.add_child(bhcBtn);
        profileCard.add_child(ppTop);

        const segRow = new St.BoxLayout({
            style_class: 'bayisland-segment-row',
            x_expand: true,
        });

        const modes = [
            { id: 'power-saver', label: 'Power Saver', icon: 'power-profile-power-saver-symbolic' },
            { id: 'balanced', label: 'Balanced', icon: 'power-profile-balanced-symbolic' },
            { id: 'performance', label: 'Performance', icon: 'power-profile-performance-symbolic' },
        ];
        const availableSet = new Set(pp.profiles ?? modes.map(m => m.id));

        this._modeBtns = {};
        for (const m of modes) {
            const isActive = pp.activeProfile === m.id;
            const supported = availableSet.has(m.id);

            const btn = new St.Button({
                style_class: `bayisland-segment-btn${isActive ? ' bayisland-segment-btn-active' : ''}`,
                ...(isActive ? { style: `background-color: ${acc}; color: ${fg};` } : {}),
                reactive: supported,
                can_focus: false,
                x_expand: true,
            });
            const inner = new St.BoxLayout({
                style: 'spacing: 6px;',
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            });
            const iconActor = new St.Icon({
                icon_name: m.icon,
                icon_size: 14,
                ...(isActive ? { style: `color: ${fg};` } : {}),
            });
            const lblActor = new St.Label({
                text: m.label,
                ...(isActive ? { style: `color: ${fg}; font-weight: 700;` } : {}),
            });
            inner.add_child(iconActor);
            inner.add_child(lblActor);
            btn.set_child(inner);
            btn.connect('clicked', () => this._cb.onSetPowerProfile?.(m.id));
            this._modeBtns[m.id] = { btn, iconActor, lblActor, supported };
            segRow.add_child(btn);
        }
        profileCard.add_child(segRow);
        root.add_child(profileCard);

        // 2. 2x2 Minimalist Telemetry Ring Bento Grid (inspired by Reference Image 3)
        const bentoGrid = new St.Widget({
            layout_manager: new Clutter.GridLayout({
                column_spacing: 10,
                row_spacing: 10,
                column_homogeneous: true,
                row_homogeneous: true,
            }),
            x_expand: true,
            y_expand: true,
        });
        const gl = bentoGrid.layout_manager;

        this._cards = {
            battery: this._createRingCard('Battery', 'battery-good-symbolic'),
            cpu: this._createRingCard('CPU', 'utilities-system-monitor-symbolic', 'computer-symbolic'),
            memory: this._createRingCard('Memory', 'computer-symbolic'),
            storage: this._createRingCard('Disk', 'drive-harddisk-symbolic'),
        };

        gl.attach(this._cards.battery.card, 0, 0, 1, 1);
        gl.attach(this._cards.cpu.card, 1, 0, 1, 1);
        gl.attach(this._cards.memory.card, 0, 1, 1, 1);
        gl.attach(this._cards.storage.card, 1, 1, 1, 1);

        root.add_child(bentoGrid);
        this._root = root;

        this.updateSnapshot(_model, palette, powerSnapshot, profileSnapshot);
        return root;
    }

    _createRingCard(title, iconName, fallbackIconName = null) {
        const card = new St.BoxLayout({
            style_class: 'bayisland-ring-card',
            x_expand: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const icon = new St.Icon({
            icon_name: iconName,
            ...(fallbackIconName ? { fallback_icon_name: fallbackIconName } : {}),
            icon_size: 15,
            style: 'color: #cbd5e1;',
        });

        const ring = createRingGauge({
            size: 48,
            strokeWidth: 4.4,
            fraction: 0,
            colorCss: '#93c5fd',
            centerChild: icon,
        });
        card.add_child(ring.actor);

        const textCol = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'spacing: 2px;',
        });
        textCol.add_child(new St.Label({
            text: title,
            style_class: 'bayisland-ring-title',
        }));

        const metricLbl = new St.Label({
            text: '—',
            style_class: 'bayisland-ring-metric',
        });
        const subLbl = new St.Label({
            text: '—',
            style_class: 'bayisland-ring-sub',
        });
        const extraLbl = new St.Label({
            text: '',
            style_class: 'bayisland-muted-xs',
            visible: false,
        });

        textCol.add_child(metricLbl);
        textCol.add_child(subLbl);
        textCol.add_child(extraLbl);
        card.add_child(textCol);

        return { card, icon, ring, metricLbl, subLbl, extraLbl };
    }

    updateSnapshot(_model, palette, powerSnapshot, profileSnapshot) {
        if (!this._root || !this._cards)
            return false;

        const acc = palette?.accentCss || '#93c5fd';
        const fg = palette?.accentFgCss || '#090d16';
        const pp = profileSnapshot ?? {};
        const bat = pp.battery ?? {};
        const thermal = pp.thermal ?? {};
        const sys = pp.system ?? {};

        // Update Power Mode buttons cleanly in-place
        if (this._driverLabel) {
            const drvText = pp.cpuDriver ? `Driver: ${pp.cpuDriver}` : 'power-profiles-daemon';
            this._driverLabel.text = pp.inhibitedReason ? `Inhibited (${pp.inhibitedReason})` : drvText;
        }
        const availableSet = new Set(pp.profiles ?? Object.keys(this._modeBtns));
        for (const [id, entry] of Object.entries(this._modeBtns)) {
            const isActive = pp.activeProfile === id;
            entry.btn.reactive = availableSet.has(id);
            entry.btn.style_class = `bayisland-segment-btn${isActive ? ' bayisland-segment-btn-active' : ''}`;
            entry.btn.style = isActive ? `background-color: ${acc}; color: ${fg};` : null;
            entry.iconActor.style = isActive ? `color: ${fg};` : null;
            entry.lblActor.style = isActive ? `color: ${fg}; font-weight: 700;` : null;
        }

        // 1. Battery Ring
        const batPct = Math.max(0, Math.min(100, Math.round(bat.capacity ?? powerSnapshot?.percentage ?? 0)));
        const onBat = Boolean(powerSnapshot?.onBattery);
        const batColor = (onBat && batPct <= 20) ? '#ef4444' : '#34d399';
        const statusStr = bat.status && bat.status !== 'Unknown'
            ? bat.status
            : (onBat ? 'Discharging' : 'AC Connected');
        const wattsStr = bat.powerWatts !== null && bat.powerWatts !== undefined ? ` • ${bat.powerWatts.toFixed(1)}W` : '';
        const thrStr = bat.endThreshold ? `Cap ${bat.startThreshold ?? '?'}–${bat.endThreshold}%` : '';
        const healthStr = bat.healthPct !== null && bat.healthPct !== undefined ? `Health ${bat.healthPct}%` : '';
        const cycleStr = bat.cycleCount !== null && bat.cycleCount !== undefined ? `${bat.cycleCount} cycles` : '';
        const batExtraParts = [thrStr, healthStr || cycleStr].filter(Boolean);

        this._cards.battery.icon.icon_name = !onBat ? 'battery-good-charging-symbolic' : 'battery-good-symbolic';
        this._cards.battery.ring.setValues({ fraction: batPct / 100, colorCss: batColor });
        this._cards.battery.metricLbl.text = `${batPct}%`;
        this._cards.battery.subLbl.text = `${statusStr}${wattsStr}`;
        if (batExtraParts.length > 0) {
            this._cards.battery.extraLbl.text = batExtraParts.join(' • ');
            this._cards.battery.extraLbl.visible = true;
        } else {
            this._cards.battery.extraLbl.visible = false;
        }

        // 2. CPU & Thermal Ring
        const cpuPct = Math.max(0, Math.min(100, Math.round(sys.cpuPct ?? 0)));
        const cpuColor = cpuPct >= 90 ? '#ef4444' : (cpuPct >= 75 ? '#fbbf24' : acc);
        const tempStr = thermal.cpuTempC !== null && thermal.cpuTempC !== undefined
            ? `CPU ${thermal.cpuTempC}°C`
            : (cpuPct < 10 ? 'Idle' : 'Active');
        const nvmeStr = thermal.nvmeTempC !== null && thermal.nvmeTempC !== undefined
            ? ` • NVMe ${thermal.nvmeTempC}°C`
            : '';

        this._cards.cpu.ring.setValues({ fraction: cpuPct / 100, colorCss: cpuColor });
        this._cards.cpu.metricLbl.text = `${cpuPct}%`;
        this._cards.cpu.subLbl.text = `${tempStr}${nvmeStr}`;
        if (thermal.fanRpm !== null && thermal.fanRpm !== undefined) {
            this._cards.cpu.extraLbl.text = `Fan ${thermal.fanRpm} RPM`;
            this._cards.cpu.extraLbl.visible = true;
        } else {
            this._cards.cpu.extraLbl.visible = false;
        }

        // 3. Memory Ring
        const memPct = Math.max(0, Math.min(100, Math.round(sys.memPct ?? 0)));
        const memColor = memPct >= 90 ? '#ef4444' : acc;
        this._cards.memory.ring.setValues({ fraction: memPct / 100, colorCss: memColor });
        this._cards.memory.metricLbl.text = `${memPct}%`;
        this._cards.memory.subLbl.text = sys.memTotalGb > 0
            ? `${sys.memUsedGb} / ${sys.memTotalGb} GB`
            : 'Reading…';
        this._cards.memory.extraLbl.visible = false;

        // 4. Storage & Uptime Ring
        const diskPct = Math.max(0, Math.min(100, Math.round(sys.diskPct ?? 0)));
        const diskColor = diskPct >= 90 ? '#ef4444' : acc;
        this._cards.storage.ring.setValues({ fraction: diskPct / 100, colorCss: diskColor });
        this._cards.storage.metricLbl.text = sys.diskTotalGb > 0 ? `${sys.diskFreeGb} GB` : '—';
        this._cards.storage.subLbl.text = sys.diskTotalGb > 0
            ? `free of ${sys.diskTotalGb} GB`
            : 'Reading…';
        if (sys.uptimeLabel && sys.uptimeLabel !== '—') {
            this._cards.storage.extraLbl.text = `Up ${sys.uptimeLabel}`;
            this._cards.storage.extraLbl.visible = true;
        } else {
            this._cards.storage.extraLbl.visible = false;
        }

        return true;
    }

    destroy() {
        this._modeBtns = {};
        this._driverLabel = null;
        this._cards = null;
        this._root = null;
    }
}
