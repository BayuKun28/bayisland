import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import St from 'gi://St';

import { buildEqualizerWidget } from './CompactView.js';

function formatClock(sec) {
    const s = Math.max(0, Math.floor(sec));
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return `${String(m).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
}

/**
 * Renders SPLIT_PILL when 2 persistent tasks are active simultaneously
 * (e.g. Media + Timer, or Media + Privacy, or Timer + Privacy).
 */
export class SplitView {
    constructor({ onExpandTab }) {
        this._onExpandTab = onExpandTab;
        this._root = null;
        this._timerLabel = null;
        this._mediaLabel = null;
        this._eqBars = [];
    }

    getPreferredSize() {
        return { width: 304, height: 36 };
    }

    getEqBars() {
        return this._eqBars;
    }

    render(model, palette) {
        this._eqBars = [];
        this._timerLabel = null;
        this._mediaLabel = null;

        const root = new St.BoxLayout({
            style_class: 'bayisland-split-root',
            x_expand: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const { media, timer, privacy } = model.persistent;

        // Left wing
        const leftBtn = new St.Button({
            style_class: 'bayisland-split-wing',
            reactive: true,
            can_focus: false,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        leftBtn.connect('clicked', () => this._onExpandTab?.(model.left));

        const leftBox = new St.BoxLayout({
            style: 'spacing: 6px;',
            y_align: Clutter.ActorAlign.CENTER,
        });

        if (model.left === 'media') {
            leftBox.add_child(new St.Bin({
                style_class: 'bayisland-art-mini',
                clip_to_allocation: true,
                y_align: Clutter.ActorAlign.CENTER,
                child: new St.Icon({
                    ...(media.artIcon
                        ? { gicon: media.artIcon }
                        : { icon_name: 'audio-x-generic-symbolic' }),
                    icon_size: 18,
                }),
            }));
            this._mediaLabel = new St.Label({
                text: media.title || 'Media',
                style_class: 'bayisland-compact-title',
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._mediaLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            leftBox.add_child(this._mediaLabel);

            const { eqBox, bars } = buildEqualizerWidget(3, palette?.accentCss ?? '#93c5fd');
            this._eqBars = bars;
            leftBox.add_child(eqBox);
        } else {
            leftBox.add_child(new St.Icon({
                icon_name: 'alarm-symbolic',
                icon_size: 14,
                style: 'color: #fbbf24;',
                y_align: Clutter.ActorAlign.CENTER,
            }));
            this._timerLabel = new St.Label({
                text: formatClock(timer.remainingSec ?? 0),
                style_class: 'bayisland-timer-pill-text',
                y_align: Clutter.ActorAlign.CENTER,
            });
            leftBox.add_child(this._timerLabel);
        }

        leftBtn.set_child(leftBox);
        root.add_child(leftBtn);

        // Divider
        root.add_child(new St.Widget({
            style_class: 'bayisland-split-divider',
            y_align: Clutter.ActorAlign.CENTER,
        }));

        // Right wing
        const rightBtn = new St.Button({
            style_class: 'bayisland-split-wing',
            reactive: true,
            can_focus: false,
            y_align: Clutter.ActorAlign.CENTER,
        });
        rightBtn.connect('clicked', () => this._onExpandTab?.(model.right === 'timer' ? 'home' : 'power'));

        const rightBox = new St.BoxLayout({
            style: 'spacing: 5px;',
            y_align: Clutter.ActorAlign.CENTER,
        });

        if (model.right === 'timer') {
            rightBox.add_child(new St.Icon({
                icon_name: 'alarm-symbolic',
                icon_size: 14,
                style: 'color: #fbbf24;',
                y_align: Clutter.ActorAlign.CENTER,
            }));
            this._timerLabel = new St.Label({
                text: formatClock(timer.remainingSec ?? 0),
                style_class: 'bayisland-timer-pill-text',
                y_align: Clutter.ActorAlign.CENTER,
            });
            rightBox.add_child(this._timerLabel);
        } else {
            if (privacy.camera) {
                rightBox.add_child(new St.Widget({
                    style_class: 'bayisland-privacy-dot bayisland-privacy-dot-cam',
                    y_align: Clutter.ActorAlign.CENTER,
                }));
            }
            if (privacy.mic) {
                rightBox.add_child(new St.Widget({
                    style_class: 'bayisland-privacy-dot bayisland-privacy-dot-mic',
                    y_align: Clutter.ActorAlign.CENTER,
                }));
            }
            rightBox.add_child(new St.Label({
                text: privacy.camera && privacy.mic ? 'Cam+Mic' : (privacy.camera ? 'Cam' : 'Mic'),
                style_class: 'bayisland-privacy-label',
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }

        rightBtn.set_child(rightBox);
        root.add_child(rightBtn);

        this._root = root;
        return root;
    }

    updateInPlace(model) {
        if (!this._root)
            return false;
        if (this._timerLabel && model.persistent.timer?.active)
            this._timerLabel.text = formatClock(model.persistent.timer.remainingSec ?? 0);
        if (this._mediaLabel && model.persistent.media?.active)
            this._mediaLabel.text = model.persistent.media.title || 'Media';
        return true;
    }
}
