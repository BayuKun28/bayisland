import Clutter from 'gi://Clutter';

/**
 * Smooth 60 FPS Clutter transition coordinator for BayIsland.
 * Handles compact pills, subtle idle bar, hover peek, drop catch, and 5-tab bento Hub.
 */
export class MorphEngine {
    constructor(shellActor, contentBin, timers) {
        this._shell = shellActor;
        this._contentBin = contentBin;
        this._timers = timers;

        this._eqBars = [];
        this._eqTimerId = 0;
        this._eqActive = false;

        this._lastWidth = 0;
        this._lastHeight = 0;
        this._lastX = 0;
        this._lastY = 0;
        this._visible = false;
        this._morphSeq = 0;
        this._pendingSettledCb = null;
        this._pendingSettledSeq = 0;
    }

    _flushPendingSettled(seq) {
        if (!this._pendingSettledCb || seq !== this._pendingSettledSeq || seq !== this._morphSeq)
            return;
        if (this._shell.get_transition('width') ||
            this._shell.get_transition('height') ||
            this._shell.get_transition('opacity') ||
            this._shell.get_transition('x') ||
            this._shell.get_transition('y'))
            return;

        const cb = this._pendingSettledCb;
        this._pendingSettledCb = null;
        cb();
    }

    registerEqBars(bars) {
        this._eqBars = Array.isArray(bars) ? bars : [];
        for (const bar of this._eqBars)
            bar.set_pivot_point(0.5, 1.0);
        if (this._eqActive)
            this._startEqLoop();
    }

    setEqualizerPlaying(playing) {
        const next = Boolean(playing);
        if (this._eqActive === next)
            return;
        this._eqActive = next;

        if (next) {
            this._startEqLoop();
        } else {
            this._stopEqLoop();
            for (const bar of this._eqBars) {
                bar.remove_all_transitions();
                bar.ease({
                    scale_y: 0.28,
                    duration: 160,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            }
        }
    }

    _startEqLoop() {
        this._stopEqLoop();
        if (this._eqBars.length === 0)
            return;

        const tick = () => {
            if (!this._eqActive || !this._visible)
                return false;

            this._eqBars.forEach((bar, idx) => {
                const base = idx % 2 === 0 ? 0.35 : 0.45;
                const amp = base + Math.random() * (1.0 - base);
                bar.ease({
                    scale_y: amp,
                    duration: 160,
                    mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
                });
            });
            return true;
        };

        tick();
        this._eqTimerId = this._timers.setInterval(180, tick);
    }

    _stopEqLoop() {
        if (this._eqTimerId) {
            this._timers.clear(this._eqTimerId);
            this._eqTimerId = 0;
        }
    }

    morphTo({ x, y, width, height, visible, isExpanding, inPlaceOnly, onHidden, onSettled }) {
        const seq = ++this._morphSeq;

        if (!visible) {
            this._pendingSettledCb = null;
            if (!this._visible) {
                this._shell.opacity = 0;
                this._shell.hide();
                onHidden?.();
                return;
            }

            this._visible = false;
            this._stopEqLoop();
            this._shell.remove_all_transitions();
            this._shell.ease({
                opacity: 0,
                y: Math.max(0, y - 6),
                duration: 190,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => {
                    if (!this._visible && seq === this._morphSeq) {
                        this._shell.hide();
                        this._lastWidth = 0;
                        this._lastHeight = 0;
                        onHidden?.();
                    }
                },
            });
            return;
        }

        const wasHidden = !this._visible;
        this._visible = true;
        this._pendingSettledCb = onSettled || null;
        this._pendingSettledSeq = seq;
        const isLargeTarget = width >= 380 || height >= 120;

        if (wasHidden) {
            const startW = Math.max(48, Math.round(width * 0.65));
            const startH = Math.max(10, Math.round(height * 0.72));
            const startX = Math.round(x + (width - startW) / 2);
            const startY = Math.max(0, y - 3);

            this._shell.remove_all_transitions();
            this._shell.set_position(startX, startY);
            this._shell.set_size(startW, startH);
            this._shell.opacity = 0;
            this._shell.show();
            this._contentBin.remove_all_transitions();
            this._contentBin.opacity = 255;

            this._shell.ease({
                opacity: 255,
                width,
                height,
                x,
                y,
                duration: isLargeTarget ? 280 : 250,
                mode: isLargeTarget
                    ? Clutter.AnimationMode.EASE_OUT_CUBIC
                    : Clutter.AnimationMode.EASE_OUT_BACK,
                onComplete: () => {
                    if (seq === this._morphSeq && this._pendingSettledCb) {
                        const cb = this._pendingSettledCb;
                        this._pendingSettledCb = null;
                        cb();
                    }
                    if (this._eqActive)
                        this._startEqLoop();
                },
            });
        } else {
            const sizeChanged =
                Math.abs(this._lastWidth - width) > 1 ||
                Math.abs(this._lastHeight - height) > 1;
            const posChanged =
                Math.abs(this._lastX - x) > 1 ||
                Math.abs(this._lastY - y) > 1;
            const geomChanged = sizeChanged || posChanged;

            if (geomChanged) {
                this._shell.remove_all_transitions();
                const easeTarget = sizeChanged
                    ? { width, height, x, y, opacity: 255 }
                    : { x, y, opacity: 255 };
                this._shell.ease({
                    ...easeTarget,
                    duration: isLargeTarget ? 280 : (isExpanding ? 260 : 220),
                    mode: isExpanding || isLargeTarget
                        ? Clutter.AnimationMode.EASE_OUT_CUBIC
                        : Clutter.AnimationMode.EASE_OUT_QUAD,
                    onComplete: () => {
                        if (seq === this._morphSeq && this._pendingSettledCb) {
                            const cb = this._pendingSettledCb;
                            this._pendingSettledCb = null;
                            cb();
                        }
                    },
                });
            } else {
                this._shell.opacity = 255;
                if (this._pendingSettledCb) {
                    const cb = this._pendingSettledCb;
                    this._pendingSettledCb = null;
                    cb();
                }
            }

            if (!inPlaceOnly) {
                this._contentBin.remove_all_transitions();
                this._contentBin.opacity = 0;
                this._contentBin.ease({
                    opacity: 255,
                    duration: 150,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            }

            if (this._eqActive && !this._eqTimerId)
                this._startEqLoop();
        }

        this._lastX = x;
        this._lastY = y;
        this._lastWidth = width;
        this._lastHeight = height;
    }

    snapPosition({ x, y }) {
        if (!this._visible)
            return;

        if (!this._shell.get_transition('opacity') && this._shell.opacity < 255)
            this._shell.opacity = 255;
        if (!this._contentBin.get_transition('opacity') && this._contentBin.opacity < 255)
            this._contentBin.opacity = 255;

        if (Math.abs(this._lastX - x) <= 1 && Math.abs(this._lastY - y) <= 1)
            return;

        this._shell.remove_transition('x');
        this._shell.remove_transition('y');
        this._shell.set_position(x, y);
        this._lastX = x;
        this._lastY = y;
        this._flushPendingSettled(this._morphSeq);
    }

    glidePosition({ x, y }) {
        if (!this._visible)
            return;

        if (!this._shell.get_transition('opacity') && this._shell.opacity < 255)
            this._shell.opacity = 255;
        if (!this._contentBin.get_transition('opacity') && this._contentBin.opacity < 255)
            this._contentBin.opacity = 255;

        if (Math.abs(this._lastX - x) <= 1 && Math.abs(this._lastY - y) <= 1)
            return;

        this._lastX = x;
        this._lastY = y;
        const seq = this._morphSeq;
        this._shell.ease({
            x,
            y,
            duration: 210,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onComplete: () => this._flushPendingSettled(seq),
        });
    }

    destroy() {
        this._pendingSettledCb = null;
        this._stopEqLoop();
        this._eqBars = [];
    }
}
