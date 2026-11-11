import Gio from 'gi://Gio';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

const OPENBAR_SCHEMA = 'org.gnome.shell.extensions.openbar';
const DEFAULT_ACCENT_HEX = '#38BDF8';

function rgbUnitToByte(strVal, fallback) {
    const parsed = Number.parseFloat(strVal);
    if (!Number.isFinite(parsed))
        return fallback;
    return Math.max(0, Math.min(255, Math.round(parsed * 255)));
}

function clampByte(v) {
    return Math.max(0, Math.min(255, Math.round(v)));
}

export function parseHexRgb(hexStr) {
    if (typeof hexStr !== 'string')
        return { r: 56, g: 189, b: 248, hex: DEFAULT_ACCENT_HEX };

    let clean = hexStr.trim().replace(/^#/, '');
    if (clean.length === 3)
        clean = clean.split('').map(c => `${c}${c}`).join('');
    if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(clean))
        return { r: 56, g: 189, b: 248, hex: DEFAULT_ACCENT_HEX };

    const r = Number.parseInt(clean.slice(0, 2), 16);
    const g = Number.parseInt(clean.slice(2, 4), 16);
    const b = Number.parseInt(clean.slice(4, 6), 16);
    return {
        r,
        g,
        b,
        hex: `#${clean.slice(0, 6).toUpperCase()}`,
    };
}

function linearChannel(c) {
    const srgb = c / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : Math.pow((srgb + 0.055) / 1.055, 2.4);
}

export function relativeLuminance(r, g, b) {
    return 0.2126 * linearChannel(r) + 0.7152 * linearChannel(g) + 0.0722 * linearChannel(b);
}

export function buildSolidPalette({ r, g, b, pr = 10, pg = 12, pb = 17, synced = false }) {
    const lum = relativeLuminance(r, g, b);
    const lightAccent = lum > 0.42;
    const accentFgCss = lightAccent ? '#090D16' : '#FFFFFF';
    const accentSubFgCss = lightAccent ? 'rgba(9, 13, 22, 0.72)' : 'rgba(255, 255, 255, 0.78)';

    // Subtle opaque hover shift so active solid buttons respond cleanly
    const delta = lightAccent ? -16 : 18;
    const hr = clampByte(r + delta);
    const hg = clampByte(g + delta);
    const hb = clampByte(b + delta);

    const toHex = n => n.toString(16).padStart(2, '0').toUpperCase();

    return {
        synced: Boolean(synced),
        accentHex: `#${toHex(r)}${toHex(g)}${toHex(b)}`,
        accentCss: `rgb(${r}, ${g}, ${b})`,
        accentHoverCss: `rgb(${hr}, ${hg}, ${hb})`,
        accentFgCss,
        accentSubFgCss,
        accentRgba: `rgba(${r}, ${g}, ${b}, 0.16)`,
        pillBgCss: `rgba(${pr}, ${pg}, ${pb}, 0.96)`,
        surfaceCss: 'rgba(255, 255, 255, 0.048)',
    };
}

/**
 * Resolves BayIsland's complete UI palette from either OpenBar GSettings (read-only)
 * or the user's configured custom solid Accent Color, guaranteeing WCAG contrast
 * for solid-fill active tabs, Quick Actions, controls, and calendar markers.
 */
export class ThemeBridge extends Signals.EventEmitter {
    constructor(signals) {
        super();
        this._signals = signals;
        this._openbarSettings = null;
        this._enabled = true;
        this._openbarActive = false;
        this._customAccentHex = DEFAULT_ACCENT_HEX;

        this._bindOpenBarSchema();
    }

    _bindOpenBarSchema() {
        try {
            const source = Gio.SettingsSchemaSource.get_default();
            const schema = source?.lookup(OPENBAR_SCHEMA, true);
            if (!schema)
                return;

            this._openbarSettings = new Gio.Settings({ settings_schema: schema });
            this._signals.connect(this._openbarSettings, 'changed', (_s, key) => {
                if (['accent-color', 'iscolor', 'mscolor', 'bcolor', 'balpha'].includes(key))
                    this.emit('palette-changed', this.getPalette());
            });
        } catch {
            this._openbarSettings = null;
        }
    }

    setConfig({ enabled, openbarActive, customAccentHex }) {
        if (enabled !== undefined)
            this._enabled = Boolean(enabled);
        if (openbarActive !== undefined)
            this._openbarActive = Boolean(openbarActive);
        if (customAccentHex !== undefined)
            this._customAccentHex = parseHexRgb(customAccentHex).hex;

        this.emit('palette-changed', this.getPalette());
    }

    getPalette() {
        const customRgb = parseHexRgb(this._customAccentHex);

        if (!this._enabled || !this._openbarActive || !this._openbarSettings)
            return buildSolidPalette({ r: customRgb.r, g: customRgb.g, b: customRgb.b, synced: false });

        try {
            const accent = this._openbarSettings.get_strv('accent-color');
            const iscolor = this._openbarSettings.get_strv('iscolor');
            if (accent.length < 3)
                return buildSolidPalette({ r: customRgb.r, g: customRgb.g, b: customRgb.b, synced: false });

            const ar = rgbUnitToByte(accent[0], customRgb.r);
            const ag = rgbUnitToByte(accent[1], customRgb.g);
            const ab = rgbUnitToByte(accent[2], customRgb.b);

            let pr = 10;
            let pg = 12;
            let pb = 17;
            if (iscolor.length >= 3) {
                const ir = rgbUnitToByte(iscolor[0], 33);
                const ig = rgbUnitToByte(iscolor[1], 58);
                const ib = rgbUnitToByte(iscolor[2], 61);
                pr = Math.round(10 * 0.72 + ir * 0.28);
                pg = Math.round(12 * 0.72 + ig * 0.28);
                pb = Math.round(17 * 0.72 + ib * 0.28);
            }

            return buildSolidPalette({ r: ar, g: ag, b: ab, pr, pg, pb, synced: true });
        } catch {
            return buildSolidPalette({ r: customRgb.r, g: customRgb.g, b: customRgb.b, synced: false });
        }
    }

    destroy() {
        this._openbarSettings = null;
    }
}
