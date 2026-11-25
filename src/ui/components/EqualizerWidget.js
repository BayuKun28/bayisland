import Clutter from 'gi://Clutter';
import St from 'gi://St';

/**
 * Builds an animated or static audio equalizer bar widget.
 * @param {number} barCount - Number of equalizer vertical bars
 * @param {string} accentCss - CSS color string for the bars
 * @returns {{ eqBox: St.BoxLayout, bars: St.Widget[] }}
 */
export function buildEqualizerWidget(barCount = 4, accentCss = '#93c5fd') {
    const eqBox = new St.BoxLayout({
        style_class: 'bayisland-eq-box',
        y_align: Clutter.ActorAlign.CENTER,
    });
    const bars = [];
    for (let i = 0; i < barCount; i++) {
        const bar = new St.Widget({
            style_class: 'bayisland-eq-bar',
            style: `background-color: ${accentCss};`,
            y_align: Clutter.ActorAlign.END,
        });
        bars.push(bar);
        eqBox.add_child(bar);
    }
    return { eqBox, bars };
}
