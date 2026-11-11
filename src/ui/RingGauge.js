import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import St from 'gi://St';

export function parseRgbaColor(css, fallback = { r: 0.22, g: 0.74, b: 0.97, a: 1 }) {
    if (typeof css !== 'string')
        return fallback;

    const str = css.trim();
    if (str.startsWith('#')) {
        let hex = str.slice(1);
        if (hex.length === 3)
            hex = hex.split('').map(c => `${c}${c}`).join('');
        if (/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(hex)) {
            return {
                r: Number.parseInt(hex.slice(0, 2), 16) / 255,
                g: Number.parseInt(hex.slice(2, 4), 16) / 255,
                b: Number.parseInt(hex.slice(4, 6), 16) / 255,
                a: hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1,
            };
        }
    }

    const rgbMatch = str.match(/^rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)(?:\s*,\s*([0-9.]+))?\s*\)$/i);
    if (rgbMatch) {
        return {
            r: Math.max(0, Math.min(1, Number.parseFloat(rgbMatch[1]) / 255)),
            g: Math.max(0, Math.min(1, Number.parseFloat(rgbMatch[2]) / 255)),
            b: Math.max(0, Math.min(1, Number.parseFloat(rgbMatch[3]) / 255)),
            a: rgbMatch[4] !== undefined ? Math.max(0, Math.min(1, Number.parseFloat(rgbMatch[4]))) : 1,
        };
    }

    return fallback;
}

/**
 * Hardware-composited antialiased Cairo circular progress ring (St.DrawingArea + St.Widget BinLayout).
 */
export function createRingGauge({
    size = 48,
    strokeWidth = 4.5,
    fraction = 0,
    colorCss = '#38bdf8',
    trackCss = 'rgba(255, 255, 255, 0.11)',
    centerChild = null,
} = {}) {
    const state = {
        fraction: Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0)),
        color: parseRgbaColor(colorCss),
        track: parseRgbaColor(trackCss, { r: 1, g: 1, b: 1, a: 0.11 }),
        strokeWidth,
    };

    const container = new St.Widget({
        width: size,
        height: size,
        layout_manager: new Clutter.BinLayout(),
        y_align: Clutter.ActorAlign.CENTER,
        x_align: Clutter.ActorAlign.CENTER,
    });

    const area = new St.DrawingArea({
        width: size,
        height: size,
        x_expand: true,
        y_expand: true,
    });

    area.connect('repaint', da => {
        const cr = da.get_context();
        try {
            const [w, h] = da.get_surface_size();
            if (w <= 0 || h <= 0)
                return;

            const scaleRatio = Math.min(w, h) / Math.max(1, size);
            const sw = Math.max(1.5, state.strokeWidth * scaleRatio);
            const cx = w / 2;
            const cy = h / 2;
            const radius = Math.max(2, Math.min(w, h) / 2 - sw / 2 - 0.5);

            cr.setAntialias(Cairo.Antialias.BEST);
            cr.setLineWidth(sw);
            cr.setLineCap(Cairo.LineCap.ROUND);

            // Background track ring
            cr.setSourceRGBA(state.track.r, state.track.g, state.track.b, state.track.a);
            cr.arc(cx, cy, radius, 0, Math.PI * 2);
            cr.stroke();

            // Active progress arc
            if (state.fraction > 0.005) {
                const start = -Math.PI / 2;
                const sweep = state.fraction >= 0.998
                    ? Math.PI * 2
                    : start + Math.PI * 2 * state.fraction;
                cr.setSourceRGBA(state.color.r, state.color.g, state.color.b, state.color.a);
                if (state.fraction >= 0.998)
                    cr.arc(cx, cy, radius, 0, Math.PI * 2);
                else
                    cr.arc(cx, cy, radius, start, sweep);
                cr.stroke();
            }
        } finally {
            cr.$dispose();
        }
    });

    container.add_child(area);

    if (centerChild) {
        centerChild.x_align = Clutter.ActorAlign.CENTER;
        centerChild.y_align = Clutter.ActorAlign.CENTER;
        container.add_child(centerChild);
    }

    return {
        actor: container,
        setValues({ fraction: nextFrac, colorCss: nextColor, trackCss: nextTrack } = {}) {
            if (nextFrac !== undefined && Number.isFinite(nextFrac))
                state.fraction = Math.max(0, Math.min(1, nextFrac));
            if (nextColor !== undefined)
                state.color = parseRgbaColor(nextColor, state.color);
            if (nextTrack !== undefined)
                state.track = parseRgbaColor(nextTrack, state.track);
            area.queue_repaint();
        },
    };
}
