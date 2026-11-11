import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import St from 'gi://St';

import { buildEqualizerWidget } from '../CompactView.js';
import { parseRgbaColor } from '../RingGauge.js';

function formatMediaTime(us) {
    if (!Number.isFinite(us) || us <= 0)
        return '0:00';
    const totalSec = Math.floor(us / 1_000_000);
    const mins = Math.floor(totalSec / 60);
    const secs = totalSec % 60;
    return `${mins}:${String(secs).padStart(2, '0')}`;
}

function formatRemainingTime(posUs, lenUs) {
    if (!Number.isFinite(lenUs) || lenUs <= 0)
        return '0:00';
    const remUs = Math.max(0, lenUs - Math.max(0, posUs || 0));
    const totalSec = Math.floor(remUs / 1_000_000);
    const mins = Math.floor(totalSec / 60);
    const secs = totalSec % 60;
    return `-${mins}:${String(secs).padStart(2, '0')}`;
}

export class MediaTab {
    constructor({ callbacks }) {
        this._cb = callbacks;
        this._root = null;
        this._lastPalette = null;

        this._scrubTrack = null;
        this._scrubFill = null;
        this._scrubKnob = null;
        this._scrubWidth = 342;

        this._elapsedLabel = null;
        this._remainingLabel = null;
        this._titleLabel = null;
        this._artistLabel = null;
        this._playIcon = null;
        this._eqBox = null;

        this._micBtn = null;
        this._volMuteIcon = null;
        this._volCanvas = null;
        this._volColor = parseRgbaColor('#38bdf8');
        this._lastVolFrac = 0;
        this._volPctLbl = null;
        this._devCol = null;
    }

    render(model, palette, quickSnapshot) {
        this.destroy();

        this._lastPalette = palette ?? null;
        const acc = palette?.accentCss || '#38bdf8';
        const fg = palette?.accentFgCss || '#090d16';

        const media = model.persistent.media;
        const qa = quickSnapshot ?? {};

        const root = new St.BoxLayout({
            style_class: 'bayisland-bento-grid',
            x_expand: true,
            y_expand: true,
        });

        // Left Column (374px): Compact Landscape Now Playing Stage
        const playerCard = new St.BoxLayout({
            style_class: 'bayisland-bento-card bayisland-media-stage',
            vertical: true,
            x_expand: false,
            y_expand: true,
        });

        if (!media?.active) {
            const empty = new St.BoxLayout({
                vertical: true,
                x_expand: true,
                y_expand: true,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                style: 'spacing: 8px;',
            });
            empty.add_child(new St.Icon({
                icon_name: 'audio-x-generic-symbolic',
                icon_size: 32,
                style: 'color: #475569;',
            }));
            empty.add_child(new St.Label({
                text: 'No active media player',
                style_class: 'bayisland-media-artist',
            }));
            empty.add_child(new St.Label({
                text: 'Audio controls appear when playback starts',
                style_class: 'bayisland-muted-xs',
            }));
            playerCard.add_child(empty);
        } else {
            // Top source indicator + inline multi-player switcher + equalizer
            const srcRow = new St.BoxLayout({
                x_expand: true,
                style: 'spacing: 6px;',
                y_align: Clutter.ActorAlign.CENTER,
            });
            srcRow.add_child(new St.Widget({
                style_class: 'bayisland-media-source-dot',
                style: `background-color: ${acc};`,
                y_align: Clutter.ActorAlign.CENTER,
            }));
            srcRow.add_child(new St.Label({
                text: (media.playerName || 'MEDIA').toUpperCase(),
                style_class: 'bayisland-media-player',
                style: `color: ${acc};`,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            }));

            if (Array.isArray(media.players) && media.players.length > 1) {
                for (const pl of media.players.slice(0, 3)) {
                    const pBtn = new St.Button({
                        label: pl.identity,
                        style_class: `bayisland-mini-pill-btn${pl.active ? ' bayisland-mini-pill-btn-active' : ''}`,
                        ...(pl.active ? { style: `background-color: ${acc}; color: ${fg};` } : {}),
                        reactive: true,
                        can_focus: false,
                        y_align: Clutter.ActorAlign.CENTER,
                    });
                    pBtn.connect('clicked', () => this._cb.onMediaSelectPlayer?.(pl.busName));
                    srcRow.add_child(pBtn);
                }
            }

            const { eqBox, bars } = buildEqualizerWidget(4, acc);
            this._eqBox = eqBox;
            this._eqBox.visible = media.status === 'Playing';
            const waveHeights = [6, 12, 8, 11];
            bars.forEach((bar, idx) => {
                bar.height = waveHeights[idx % waveHeights.length];
            });
            srcRow.add_child(eqBox);
            playerCard.add_child(srcRow);

            // Hero Artwork (84x84) + Title / Artist
            const heroRow = new St.BoxLayout({
                x_expand: true,
                style: 'spacing: 14px;',
                y_align: Clutter.ActorAlign.CENTER,
            });

            const artBtn = new St.Button({
                reactive: true,
                can_focus: false,
                style_class: 'bayisland-art-hero',
                clip_to_allocation: true,
                child: new St.Icon({
                    ...(media.artIcon
                        ? { gicon: media.artIcon }
                        : { icon_name: 'audio-x-generic-symbolic' }),
                    icon_size: media.artIcon ? 84 : 38,
                }),
            });
            artBtn.connect('clicked', () => this._cb.onMediaRaise?.());
            heroRow.add_child(artBtn);

            const textCol = new St.BoxLayout({
                vertical: true,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
                style: 'spacing: 3px;',
            });

            this._titleLabel = new St.Label({
                text: media.title || 'Unknown Title',
                style_class: 'bayisland-media-title-hero',
            });
            this._titleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            textCol.add_child(this._titleLabel);

            this._artistLabel = new St.Label({
                text: media.artist || 'Unknown Artist',
                style_class: 'bayisland-media-artist',
            });
            this._artistLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            textCol.add_child(this._artistLabel);
            heroRow.add_child(textCol);

            playerCard.add_child(heroRow);

            // Scrubber Bar + Elapsed / Negative Remaining Labels
            const len = media.lengthUs > 0 ? media.lengthUs : 0;
            const pos = Math.max(0, Math.min(len || 0, media.positionUs || 0));
            const ratio = len > 0 ? pos / len : 0;
            const fillW = Math.max(6, Math.round(this._scrubWidth * ratio));

            const scrubCol = new St.BoxLayout({
                vertical: true,
                x_expand: true,
                style: 'spacing: 5px;',
            });

            this._scrubTrack = new St.Widget({
                style_class: 'bayisland-scrub-hitbox',
                width: this._scrubWidth,
                height: 14,
                layout_manager: new Clutter.BinLayout(),
                reactive: Boolean(media.canSeek && len > 0),
                clip_to_allocation: false,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._scrubTrack.add_child(new St.Widget({
                style_class: 'bayisland-scrub-track',
                width: this._scrubWidth,
                x_align: Clutter.ActorAlign.START,
                y_align: Clutter.ActorAlign.CENTER,
            }));
            this._scrubFill = new St.Widget({
                style_class: 'bayisland-scrub-fill',
                style: `background-color: ${acc};`,
                width: fillW,
                x_align: Clutter.ActorAlign.START,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._scrubKnob = new St.Widget({
                style_class: 'bayisland-scrub-knob',
                style: `background-color: #ffffff; margin-left: ${Math.max(0, Math.min(this._scrubWidth - 10, fillW - 5))}px;`,
                x_align: Clutter.ActorAlign.START,
                y_align: Clutter.ActorAlign.CENTER,
                visible: len > 0,
            });
            this._scrubTrack.add_child(this._scrubFill);
            this._scrubTrack.add_child(this._scrubKnob);

            if (media.canSeek && len > 0) {
                this._scrubTrack.connect('button-press-event', (_a, ev) => {
                    const [evX] = ev.get_coords();
                    const [trackX] = this._scrubTrack.get_transformed_position();
                    const w = this._scrubTrack.width || this._scrubWidth;
                    const frac = Math.max(0, Math.min(1, (evX - trackX) / w));
                    const nextFill = Math.max(6, Math.round(w * frac));
                    this._scrubFill.width = nextFill;
                    if (this._scrubKnob)
                        this._scrubKnob.style = `background-color: #ffffff; margin-left: ${Math.max(0, Math.min(w - 10, nextFill - 5))}px;`;
                    this._cb.onMediaSeek?.(frac);
                    return Clutter.EVENT_STOP;
                });
            }
            scrubCol.add_child(this._scrubTrack);

            const timeRow = new St.BoxLayout({ x_expand: true });
            this._elapsedLabel = new St.Label({
                text: formatMediaTime(pos),
                style_class: 'bayisland-time-label',
                x_expand: true,
            });
            this._remainingLabel = new St.Label({
                text: formatRemainingTime(pos, len),
                style_class: 'bayisland-time-label',
            });
            timeRow.add_child(this._elapsedLabel);
            timeRow.add_child(this._remainingLabel);
            scrubCol.add_child(timeRow);
            playerCard.add_child(scrubCol);

            // Centered Transport Row (Circular Hero Play Button)
            const ctrlRow = new St.BoxLayout({
                style_class: 'bayisland-ctrl-row-hero',
                x_expand: true,
                y_expand: true,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            });
            const prevBtn = new St.Button({
                style_class: 'bayisland-ctrl-btn',
                reactive: media.canGoPrevious !== false,
                can_focus: false,
                child: new St.Icon({ icon_name: 'media-skip-backward-symbolic', icon_size: 16 }),
            });
            prevBtn.connect('clicked', () => this._cb.onMediaPrev?.());
            ctrlRow.add_child(prevBtn);

            this._playIcon = new St.Icon({
                icon_name: media.status === 'Playing'
                    ? 'media-playback-pause-symbolic'
                    : 'media-playback-start-symbolic',
                icon_size: 19,
                style: `color: ${fg};`,
            });
            const playBtn = new St.Button({
                style_class: 'bayisland-ctrl-btn bayisland-ctrl-btn-play-hero',
                style: `background-color: ${acc}; color: ${fg};`,
                reactive: true,
                can_focus: false,
                child: this._playIcon,
            });
            playBtn.connect('clicked', () => this._cb.onMediaPlayPause?.());
            ctrlRow.add_child(playBtn);

            const nextBtn = new St.Button({
                style_class: 'bayisland-ctrl-btn',
                reactive: media.canGoNext !== false,
                can_focus: false,
                child: new St.Icon({ icon_name: 'media-skip-forward-symbolic', icon_size: 16 }),
            });
            nextBtn.connect('clicked', () => this._cb.onMediaNext?.());
            ctrlRow.add_child(nextBtn);
            playerCard.add_child(ctrlRow);
        }
        root.add_child(playerCard);

        // Right Column: Audio Output & Volume Mixer
        const audioCard = new St.BoxLayout({
            style_class: 'bayisland-bento-card',
            vertical: true,
            x_expand: true,
            y_expand: true,
            style: 'spacing: 10px;',
        });

        const audHead = new St.BoxLayout({ x_expand: true, style: 'spacing: 6px;' });
        audHead.add_child(new St.Label({
            text: 'AUDIO MIXER',
            style_class: 'bayisland-section-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));

        this._micBtn = new St.Button({
            label: qa.micMuted ? 'Mic Muted' : 'Mic Live',
            style_class: `bayisland-mini-pill-btn${qa.micMuted ? ' bayisland-mini-pill-btn-warn' : ''}`,
            reactive: true,
            can_focus: false,
        });
        this._micBtn.connect('clicked', () => this._cb.onToggleMicMute?.());
        audHead.add_child(this._micBtn);
        audioCard.add_child(audHead);

        // Volume row
        const volRow = new St.BoxLayout({ x_expand: true, style: 'spacing: 8px;' });
        this._volMuteIcon = new St.Icon({
            icon_name: qa.volumeMuted ? 'audio-volume-muted-symbolic' : 'audio-volume-high-symbolic',
            icon_size: 14,
        });
        const muteBtn = new St.Button({
            style_class: 'bayisland-icon-btn',
            reactive: true,
            can_focus: false,
            child: this._volMuteIcon,
        });
        muteBtn.connect('clicked', () => this._cb.onToggleOutputMute?.());
        volRow.add_child(muteBtn);

        const volFrac = Math.max(0, Math.min(1, qa.volumeFraction ?? 0));
        this._lastVolFrac = volFrac;
        this._volColor = parseRgbaColor(acc);
        this._volCanvas = new St.DrawingArea({
            style_class: 'bayisland-scrub-hitbox',
            height: 14,
            x_expand: true,
            reactive: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._volCanvas.connect('repaint', da => {
            const cr = da.get_context();
            try {
                const [w, h] = da.get_surface_size();
                if (w <= 6 || h <= 0)
                    return;
                const barH = 5;
                const capR = barH / 2;
                const cy = h / 2;
                const frac = Math.max(0, Math.min(1, this._lastVolFrac));
                const c = this._volColor;

                cr.setAntialias(Cairo.Antialias.BEST);
                cr.setLineCap(Cairo.LineCap.ROUND);
                cr.setLineWidth(barH);

                // Background track
                cr.setSourceRGBA(1, 1, 1, 0.14);
                cr.moveTo(capR, cy);
                cr.lineTo(w - capR, cy);
                cr.stroke();

                // Active fill
                if (frac > 0.005) {
                    const endX = Math.max(capR + 1, Math.min(w - capR, capR + (w - 2 * capR) * frac));
                    cr.setSourceRGBA(c.r, c.g, c.b, c.a);
                    cr.moveTo(capR, cy);
                    cr.lineTo(endX, cy);
                    cr.stroke();
                }
            } finally {
                cr.$dispose();
            }
        });
        this._volCanvas.connect('button-press-event', (_a, ev) => {
            const [evX] = ev.get_coords();
            const [tx] = this._volCanvas.get_transformed_position();
            const tw = Math.max(1, this._volCanvas.width);
            const frac = Math.max(0, Math.min(1, (evX - tx) / tw));
            this._lastVolFrac = frac;
            this._volCanvas.queue_repaint();
            this._cb.onSetOutputVolume?.(frac);
            return Clutter.EVENT_STOP;
        });
        volRow.add_child(this._volCanvas);

        this._volPctLbl = new St.Label({
            text: qa.volumeMuted ? 'Mute' : `${Math.round(volFrac * 100)}%`,
            style_class: 'bayisland-kv-val',
            style: 'min-width: 36px; text-align: right;',
            y_align: Clutter.ActorAlign.CENTER,
        });
        volRow.add_child(this._volPctLbl);
        audioCard.add_child(volRow);

        audioCard.add_child(new St.Label({
            text: 'OUTPUT DEVICE',
            style_class: 'bayisland-section-title',
            style: 'margin-top: 2px;',
        }));

        const devScroll = new St.ScrollView({
            style_class: 'bayisland-scroll-view vfade',
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
        });
        this._devCol = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style: 'spacing: 5px;',
        });
        this._rebuildDevCol(qa, palette);
        devScroll.child = this._devCol;
        audioCard.add_child(devScroll);

        root.add_child(audioCard);
        this._root = root;
        return root;
    }

    _rebuildDevCol(qa, palette = this._lastPalette) {
        if (!this._devCol)
            return;
        this._devCol.destroy_all_children();
        const acc = palette?.accentCss || '#38bdf8';
        const fg = palette?.accentFgCss || '#090d16';

        const outputs = Array.isArray(qa.outputs) ? qa.outputs.slice(0, 6) : [];
        if (outputs.length === 0) {
            this._devCol.add_child(new St.Label({
                text: 'No output devices',
                style_class: 'bayisland-muted-sm',
            }));
            return;
        }

        for (const dev of outputs) {
            const btn = new St.Button({
                style_class: `bayisland-output-btn${dev.active ? ' bayisland-output-btn-active' : ''}`,
                ...(dev.active ? { style: `background-color: ${acc}; color: ${fg};` } : {}),
                reactive: true,
                can_focus: false,
                x_expand: true,
            });
            const row = new St.BoxLayout({ style: 'spacing: 8px;', y_align: Clutter.ActorAlign.CENTER });
            row.add_child(new St.Icon({
                icon_name: dev.label.toLowerCase().includes('head') ? 'audio-headphones-symbolic' : 'audio-speakers-symbolic',
                icon_size: 14,
                ...(dev.active ? { style: `color: ${fg};` } : {}),
            }));
            const lbl = new St.Label({
                text: dev.label,
                x_expand: true,
                ...(dev.active ? { style: `color: ${fg}; font-weight: 700;` } : {}),
            });
            lbl.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            row.add_child(lbl);
            btn.set_child(row);
            btn.connect('clicked', () => this._cb.onSelectOutputDevice?.(dev.id));
            this._devCol.add_child(btn);
        }
    }

    updateQuickActions(quickSnapshot, palette) {
        if (palette)
            this._lastPalette = palette;
        if (!this._root)
            return;
        const pal = palette ?? this._lastPalette;
        const acc = pal?.accentCss || '#38bdf8';

        const qa = quickSnapshot ?? {};
        if (this._micBtn) {
            this._micBtn.label = qa.micMuted ? 'Mic Muted' : 'Mic Live';
            this._micBtn.style_class = `bayisland-mini-pill-btn${qa.micMuted ? ' bayisland-mini-pill-btn-warn' : ''}`;
        }
        const volFrac = Math.max(0, Math.min(1, qa.volumeFraction ?? 0));
        this._lastVolFrac = volFrac;
        this._volColor = parseRgbaColor(acc, this._volColor);
        if (this._volMuteIcon) {
            this._volMuteIcon.icon_name = qa.volumeMuted
                ? 'audio-volume-muted-symbolic'
                : 'audio-volume-high-symbolic';
        }
        this._volCanvas?.queue_repaint();
        if (this._volPctLbl)
            this._volPctLbl.text = qa.volumeMuted ? 'Mute' : `${Math.round(volFrac * 100)}%`;
        this._rebuildDevCol(qa, pal);
    }

    updateInPlace(model) {
        const m = model.persistent.media;
        if (!this._root || !m?.active)
            return false;

        if (this._titleLabel)
            this._titleLabel.text = m.title || 'Unknown Title';
        if (this._artistLabel)
            this._artistLabel.text = m.artist || '';
        if (this._playIcon) {
            this._playIcon.icon_name = m.status === 'Playing'
                ? 'media-playback-pause-symbolic'
                : 'media-playback-start-symbolic';
        }
        if (this._eqBox)
            this._eqBox.visible = m.status === 'Playing';

        const len = m.lengthUs > 0 ? m.lengthUs : 0;
        const pos = Math.max(0, Math.min(len || 0, m.positionUs || 0));
        const ratio = len > 0 ? pos / len : 0;
        const trackW = this._scrubTrack?.width > 40 ? this._scrubTrack.width : this._scrubWidth;
        const fillW = Math.max(6, Math.round(trackW * ratio));
        if (this._scrubFill)
            this._scrubFill.width = fillW;
        if (this._scrubKnob) {
            this._scrubKnob.visible = len > 0;
            this._scrubKnob.style = `background-color: #ffffff; margin-left: ${Math.max(0, Math.min(trackW - 10, fillW - 5))}px;`;
        }
        if (this._elapsedLabel)
            this._elapsedLabel.text = formatMediaTime(pos);
        if (this._remainingLabel)
            this._remainingLabel.text = formatRemainingTime(pos, len);
        return true;
    }

    destroy() {
        this._scrubTrack = null;
        this._scrubFill = null;
        this._scrubKnob = null;
        this._elapsedLabel = null;
        this._remainingLabel = null;
        this._titleLabel = null;
        this._artistLabel = null;
        this._playIcon = null;
        this._eqBox = null;
        this._micBtn = null;
        this._volMuteIcon = null;
        this._volCanvas = null;
        this._volPctLbl = null;
        this._devCol = null;
        this._root = null;
    }
}
