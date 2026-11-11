import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

const OPENBAR_UUID = 'openbar@neuromorph';
const OPENBAR_SCHEMA = 'org.gnome.shell.extensions.openbar';
const DEFAULT_ACCENT_HEX = '#93C5FD';

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
        return { r: 147, g: 197, b: 253, hex: DEFAULT_ACCENT_HEX };

    let clean = hexStr.trim().replace(/^#/, '');
    if (clean.length === 3)
        clean = clean.split('').map(c => `${c}${c}`).join('');
    if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(clean))
        return { r: 147, g: 197, b: 253, hex: DEFAULT_ACCENT_HEX };

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

export function ensureReadableAccentOnDark(r, g, b, minLum = 0.50) {
    if (relativeLuminance(r, g, b) >= minLum)
        return { r, g, b, css: `rgb(${r}, ${g}, ${b})` };

    let lo = 0;
    let hi = 1;
    let best = { r: 248, g: 250, b: 252 };
    for (let i = 0; i < 12; i++) {
        const mid = (lo + hi) * 0.5;
        const nr = clampByte(r + (248 - r) * mid);
        const ng = clampByte(g + (250 - g) * mid);
        const nb = clampByte(b + (252 - b) * mid);
        if (relativeLuminance(nr, ng, nb) >= minLum) {
            best = { r: nr, g: ng, b: nb };
            hi = mid;
        } else {
            lo = mid;
        }
    }
    return {
        ...best,
        css: `rgb(${best.r}, ${best.g}, ${best.b})`,
    };
}

export function buildSolidPalette({
    r,
    g,
    b,
    pr = 10,
    pg = 12,
    pb = 17,
    integratedBgCss = 'rgba(24, 28, 38, 0.88)',
    integratedHoverBgCss = 'rgba(36, 42, 56, 0.96)',
    integratedBorderCss = '1px solid rgba(255, 255, 255, 0.10)',
    integratedFlat = true,
    integratedGlowCss = null,
    integratedOverviewBgCss = 'rgba(255, 255, 255, 0.10)',
    integratedOverviewHoverBgCss = 'rgba(255, 255, 255, 0.17)',
    integratedOverviewBorderCss = 'none',
    integratedOverviewFlat = true,
    integratedOverviewGlowCss = null,
    integratedRadiusPx = null,
    synced = false,
}) {
    const lum = relativeLuminance(r, g, b);
    const lightAccent = lum > 0.42;
    const accentFgCss = lightAccent ? '#090D16' : '#FFFFFF';
    const accentSubFgCss = lightAccent ? 'rgba(9, 13, 22, 0.72)' : 'rgba(255, 255, 255, 0.78)';
    const onDark = ensureReadableAccentOnDark(r, g, b, 0.50);

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
        accentOnDarkCss: onDark.css,
        accentHoverCss: `rgb(${hr}, ${hg}, ${hb})`,
        accentFgCss,
        accentSubFgCss,
        accentRgba: `rgba(${r}, ${g}, ${b}, 0.16)`,
        pillBgCss: `rgba(${pr}, ${pg}, ${pb}, 0.96)`,
        integratedBgCss,
        integratedHoverBgCss,
        integratedBorderCss,
        integratedFlat: Boolean(integratedFlat),
        integratedGlowCss,
        integratedOverviewBgCss,
        integratedOverviewHoverBgCss,
        integratedOverviewBorderCss,
        integratedOverviewFlat: Boolean(integratedOverviewFlat),
        integratedOverviewGlowCss,
        integratedRadiusPx,
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
        this._openbarDir = null;
        this._enabled = true;
        this._openbarActive = false;
        this._customAccentHex = DEFAULT_ACCENT_HEX;

        this._bindOpenBarSchema();
    }

    _lookupOpenBarSchema(openbarDir = null) {
        const defaultSource = Gio.SettingsSchemaSource.get_default();
        const candidates = [];
        if (openbarDir)
            candidates.push(GLib.build_filenamev([openbarDir, 'schemas']));
        candidates.push(GLib.build_filenamev([GLib.get_user_data_dir(), 'gnome-shell', 'extensions', OPENBAR_UUID, 'schemas']));
        candidates.push(GLib.build_filenamev(['/usr/share/gnome-shell/extensions', OPENBAR_UUID, 'schemas']));

        for (const dir of candidates) {
            try {
                const compiled = GLib.build_filenamev([dir, 'gschemas.compiled']);
                if (!GLib.file_test(compiled, GLib.FileTest.EXISTS))
                    continue;
                const dirSource = Gio.SettingsSchemaSource.new_from_directory(dir, defaultSource, false);
                const schema = dirSource?.lookup(OPENBAR_SCHEMA, true);
                if (schema)
                    return schema;
            } catch {
                // Try next schema location
            }
        }

        return defaultSource?.lookup(OPENBAR_SCHEMA, true) ?? null;
    }

    _bindOpenBarSchema(openbarDir = null) {
        if (this._openbarSettings)
            return true;
        try {
            const schema = this._lookupOpenBarSchema(openbarDir ?? this._openbarDir);
            if (!schema)
                return false;

            this._openbarSettings = new Gio.Settings({ settings_schema: schema });
            this._signals.connect(this._openbarSettings, 'changed', (_s, key) => {
                if ([
                    'accent-color',
                    'iscolor',
                    'bgcolor',
                    'isalpha',
                    'bgalpha',
                    'bartype',
                    'bcolor',
                    'balpha',
                    'bwidth',
                    'bradius',
                    'neon',
                    'shadow',
                    'set-overview',
                    'mscolor',
                ].includes(key))
                    this.emit('palette-changed', this.getPalette());
            });
            return true;
        } catch {
            this._openbarSettings = null;
            return false;
        }
    }

    setConfig({ enabled, openbarActive, openbarDir, customAccentHex }) {
        if (enabled !== undefined)
            this._enabled = Boolean(enabled);
        if (openbarActive !== undefined)
            this._openbarActive = Boolean(openbarActive);
        if (openbarDir !== undefined)
            this._openbarDir = openbarDir || null;
        if (customAccentHex !== undefined)
            this._customAccentHex = parseHexRgb(customAccentHex).hex;

        if (this._openbarActive && !this._openbarSettings)
            this._bindOpenBarSchema(this._openbarDir);

        this.emit('palette-changed', this.getPalette());
    }

    getPalette() {
        const customRgb = parseHexRgb(this._customAccentHex);

        if (!this._openbarActive || !this._openbarSettings)
            return buildSolidPalette({ r: customRgb.r, g: customRgb.g, b: customRgb.b, synced: false });

        try {
            const hasKey = key => Boolean(this._openbarSettings.settings_schema?.has_key?.(key));
            const accent = hasKey('accent-color') ? this._openbarSettings.get_strv('accent-color') : [];
            const useOpenBarAccent = this._enabled && accent.length >= 3;

            const ar = useOpenBarAccent ? rgbUnitToByte(accent[0], customRgb.r) : customRgb.r;
            const ag = useOpenBarAccent ? rgbUnitToByte(accent[1], customRgb.g) : customRgb.g;
            const ab = useOpenBarAccent ? rgbUnitToByte(accent[2], customRgb.b) : customRgb.b;

            let pr = 10;
            let pg = 12;
            let pb = 17;
            let integratedBgCss = 'rgba(24, 28, 38, 0.88)';
            let integratedHoverBgCss = 'rgba(36, 42, 56, 0.96)';
            let integratedBorderCss = '1px solid rgba(255, 255, 255, 0.10)';
            let integratedFlat = true;
            let integratedGlowCss = null;
            let integratedRadiusPx = null;

            const bartype = hasKey('bartype') ? this._openbarSettings.get_string('bartype') : 'Mainland';
            const isIslandBar = bartype === 'Islands' || bartype === 'Trilands';
            const neon = hasKey('neon') ? this._openbarSettings.get_boolean('neon') : false;
            const shadow = hasKey('shadow') ? this._openbarSettings.get_boolean('shadow') : false;
            const setOverview = hasKey('set-overview') ? this._openbarSettings.get_boolean('set-overview') : false;

            const iscolor = hasKey('iscolor') ? this._openbarSettings.get_strv('iscolor') : [];
            const bgcolor = hasKey('bgcolor') ? this._openbarSettings.get_strv('bgcolor') : [];
            const srcColor = isIslandBar
                ? (iscolor.length >= 3 ? iscolor : bgcolor)
                : (bgcolor.length >= 3 ? bgcolor : iscolor);

            if (srcColor.length >= 3) {
                const ir = rgbUnitToByte(srcColor[0], 33);
                const ig = rgbUnitToByte(srcColor[1], 58);
                const ib = rgbUnitToByte(srcColor[2], 61);
                if (this._enabled) {
                    pr = Math.round(10 * 0.72 + ir * 0.28);
                    pg = Math.round(12 * 0.72 + ig * 0.28);
                    pb = Math.round(17 * 0.72 + ib * 0.28);
                }

                const rawAlpha = isIslandBar
                    ? (hasKey('isalpha') ? this._openbarSettings.get_double('isalpha') : 0.95)
                    : (hasKey('bgalpha') ? this._openbarSettings.get_double('bgalpha') : 0.92);
                const pillAlpha = Math.max(0.76, Math.min(0.98, Number.isFinite(rawAlpha) ? rawAlpha : 0.94));

                if (relativeLuminance(ir, ig, ib) <= 0.30) {
                    const mr = isIslandBar ? ir : clampByte(ir + 10);
                    const mg = isIslandBar ? ig : clampByte(ig + 12);
                    const mb = isIslandBar ? ib : clampByte(ib + 15);
                    integratedBgCss = `rgba(${mr}, ${mg}, ${mb}, ${pillAlpha.toFixed(2)})`;
                    integratedHoverBgCss = `rgba(${clampByte(mr + 14)}, ${clampByte(mg + 15)}, ${clampByte(mb + 16)}, ${Math.min(0.98, pillAlpha + 0.03).toFixed(2)})`;
                } else {
                    // Light panel background fallback so crisp white clock text keeps strong contrast
                    integratedBgCss = 'rgba(20, 24, 34, 0.90)';
                    integratedHoverBgCss = 'rgba(32, 38, 52, 0.96)';
                }
            }

            if (hasKey('bwidth') && hasKey('bcolor') && hasKey('balpha')) {
                const bwidth = this._openbarSettings.get_double('bwidth');
                const bcolor = this._openbarSettings.get_strv('bcolor');
                const balpha = this._openbarSettings.get_double('balpha');
                const br = bcolor.length >= 3 ? rgbUnitToByte(bcolor[0], 192) : 192;
                const bg = bcolor.length >= 3 ? rgbUnitToByte(bcolor[1], 192) : 192;
                const bb = bcolor.length >= 3 ? rgbUnitToByte(bcolor[2], 192) : 192;
                if (Number.isFinite(bwidth) && bwidth < 0.4) {
                    integratedBorderCss = isIslandBar ? 'none' : '1px solid rgba(255, 255, 255, 0.08)';
                } else if (Number.isFinite(bwidth) && bwidth >= 0.4 && bcolor.length >= 3) {
                    const ba = Math.max(0.20, Math.min(0.92, Number.isFinite(balpha) ? balpha : 0.45));
                    integratedBorderCss = `${Math.min(2.0, bwidth).toFixed(1)}px solid rgba(${br}, ${bg}, ${bb}, ${ba.toFixed(2)})`;
                }
                if (isIslandBar && neon && bcolor.length >= 3)
                    integratedGlowCss = `0 0 5px 1px rgba(${br}, ${bg}, ${bb}, 0.52)`;
            }

            if (isIslandBar)
                integratedFlat = !neon;
            else
                integratedFlat = !shadow;

            if (hasKey('bradius')) {
                const bradius = this._openbarSettings.get_double('bradius');
                if (Number.isFinite(bradius) && bradius < 14)
                    integratedRadiusPx = Math.max(6, Math.round(bradius));
            }

            const integratedOverviewBgCss = setOverview
                ? integratedBgCss
                : 'rgba(255, 255, 255, 0.10)';
            const integratedOverviewHoverBgCss = setOverview
                ? integratedHoverBgCss
                : 'rgba(255, 255, 255, 0.17)';
            const integratedOverviewBorderCss = setOverview
                ? integratedBorderCss
                : 'none';
            const integratedOverviewFlat = setOverview ? integratedFlat : true;
            const integratedOverviewGlowCss = setOverview ? integratedGlowCss : null;

            return buildSolidPalette({
                r: ar,
                g: ag,
                b: ab,
                pr,
                pg,
                pb,
                integratedBgCss,
                integratedHoverBgCss,
                integratedBorderCss,
                integratedFlat,
                integratedGlowCss,
                integratedOverviewBgCss,
                integratedOverviewHoverBgCss,
                integratedOverviewBorderCss,
                integratedOverviewFlat,
                integratedOverviewGlowCss,
                integratedRadiusPx,
                synced: useOpenBarAccent,
            });
        } catch {
            return buildSolidPalette({ r: customRgb.r, g: customRgb.g, b: customRgb.b, synced: false });
        }
    }

    destroy() {
        this._openbarSettings = null;
    }
}
