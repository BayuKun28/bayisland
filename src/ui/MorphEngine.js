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
        this._collapsing = false;
        this._destroyed = false;
        this._morphSeq = 0;
        this._pendingSettledCb = null;
        this._pendingSettledSeq = 0;
        this._cornerTimerId = 0;

        this._shellDestroyId = this._shell.connect('destroy', () => {
            this._onActorsDestroyed();
        });
        this._binDestroyId = this._contentBin.connect('destroy', () => {
            this._contentBin = null;
            this._binDestroyId = 0;
        });
    }

    _onActorsDestroyed() {
        this._shellDestroyId = 0;
        this._binDestroyId = 0;
        this._destroyed = true;
        this._visible = false;
        this._collapsing = false;
        this._morphSeq++;
        this._pendingSettledCb = null;
        this._stopEqLoop();
        this._clearCornerStages();
        this._eqBars = [];
        this._shell = null;
        this._contentBin = null;
    }

    _clearCornerStages() {
        if (this._cornerTimerId) {
            this._timers.clear(this._cornerTimerId);
            this._cornerTimerId = 0;
        }
        if (!this._shell)
            return;
        for (const cls of ['bayisland-corner-morph-stage1', 'bayisland-corner-morph-stage2', 'bayisland-corner-morph-stage3', 'bayisland-corner-morph-pill']) {
            if (this._shell.has_style_class_name?.(cls))
                this._shell.remove_style_class_name(cls);
        }
    }

    _applyCornerStage(stageClass) {
        if (!this._shell)
            return;
        for (const cls of ['bayisland-corner-morph-stage1', 'bayisland-corner-morph-stage2', 'bayisland-corner-morph-stage3', 'bayisland-corner-morph-pill']) {
            if (cls === stageClass) {
                if (!this._shell.has_style_class_name?.(cls))
                    this._shell.add_style_class_name(cls);
            } else if (this._shell.has_style_class_name?.(cls)) {
                this._shell.remove_style_class_name(cls);
            }
        }
    }

    _animateSquircleExpand() {
        this._clearCornerStages();
        this._applyCornerStage('bayisland-corner-morph-stage1');
        let stage = 1;
        this._cornerTimerId = this._timers.setInterval(65, () => {
            if (this._destroyed || !this._shell)
                return false;
            stage++;
            if (stage === 2) {
                this._applyCornerStage('bayisland-corner-morph-stage2');
                return true;
            } else if (stage === 3) {
                this._applyCornerStage('bayisland-corner-morph-stage3');
                return true;
            } else {
                this._clearCornerStages();
                return false;
            }
        });
    }

    _animateSquircleCollapse() {
        this._clearCornerStages();
        this._applyCornerStage('bayisland-corner-morph-stage3');
        let stage = 3;
        this._cornerTimerId = this._timers.setInterval(38, () => {
            if (this._destroyed || !this._shell)
                return false;
            stage--;
            if (stage === 2) {
                this._applyCornerStage('bayisland-corner-morph-stage2');
                return true;
            } else if (stage === 1) {
                this._applyCornerStage('bayisland-corner-morph-stage1');
                return true;
            } else if (stage === 0) {
                this._applyCornerStage('bayisland-corner-morph-pill');
                return true;
            } else {
                this._clearCornerStages();
                return false;
            }
        });
    }

    isVisible() {
        return this._visible && !this._destroyed;
    }

    isCollapsing() {
        return this._collapsing && !this._destroyed;
    }

    _flushPendingSettled(seq) {
        if (this._destroyed || !this._shell || !this._pendingSettledCb || seq !== this._pendingSettledSeq || seq !== this._morphSeq)
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
        if (this._destroyed) {
            this._eqBars = [];
            return;
        }
        this._eqBars = Array.isArray(bars) ? bars : [];
        for (const bar of this._eqBars)
            bar.set_pivot_point(0.5, 1.0);
        if (this._eqActive)
            this._startEqLoop();
    }

    setEqualizerPlaying(playing) {
        if (this._destroyed)
            return;
        const next = Boolean(playing);
        if (this._eqActive === next)
            return;
        this._eqActive = next;

        if (next) {
            this._startEqLoop();
        } else {
            this._stopEqLoop();
            for (const bar of this._eqBars) {
                try {
                    if (!bar.get_stage?.())
                        continue;
                    bar.remove_all_transitions();
                    bar.ease({
                        scale_y: 0.28,
                        duration: 160,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    });
                } catch {
                    // Bar already disposed
                }
            }
        }
    }

    _startEqLoop() {
        this._stopEqLoop();
        if (this._destroyed || this._eqBars.length === 0)
            return;

        const tick = () => {
            if (this._destroyed || !this._eqActive || !this._visible)
                return false;

            this._eqBars.forEach((bar, idx) => {
                try {
                    if (!bar.get_stage?.())
                        return;
                    const base = idx % 2 === 0 ? 0.35 : 0.45;
                    const amp = base + Math.random() * (1.0 - base);
                    bar.ease({
                        scale_y: amp,
                        duration: 160,
                        mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
                    });
                } catch {
                    // Bar already disposed
                }
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

    morphTo({
        x,
        y,
        width,
        height,
        visible,
        isExpanding,
        inPlaceOnly,
        fadeDelayMs = 0,
        fadeDurationMs = 150,
        onHidden,
        onSettled,
    }) {
        if (this._destroyed || !this._shell || !this._contentBin)
            return;
        const seq = ++this._morphSeq;
        this._collapsing = false;

        if (!visible) {
            this._pendingSettledCb = null;
            this._clearCornerStages();
            if (!this._visible) {
                this._shell.opacity = 0;
                this._shell.hide();
                onHidden?.();
                return;
            }

            this._visible = false;
            this._stopEqLoop();
            this._shell.remove_all_transitions();
            this._contentBin.remove_all_transitions();
            this._shell.ease({
                opacity: 0,
                y: Math.max(0, y - 6),
                duration: 180,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => {
                    if (!this._destroyed && this._shell && !this._visible && seq === this._morphSeq) {
                        this._shell.hide();
                        this._lastWidth = 0;
                        this._lastHeight = 0;
                        onHidden?.();
                    }
                },
            });
            return;
        }

        const wasHidden = !this._visible || !this._shell.visible;
        this._visible = true;
        this._pendingSettledCb = onSettled || null;
        this._pendingSettledSeq = seq;
        const isLargeTarget = width >= 360 || height >= 90;
        const isCompactHandle = height <= 24 && width <= 190;

        if (wasHidden) {
            const startW = Math.max(48, Math.round(width * 0.65));
            const startH = Math.max(10, Math.round(height * 0.72));
            const startX = Math.round(x + (width - startW) / 2);
            const startY = Math.max(0, y - 2);

            this._shell.remove_all_transitions();
            this._shell.set_position(startX, startY);
            this._shell.set_size(startW, startH);
            this._shell.opacity = 0;
            this._shell.show();
            this._contentBin.remove_all_transitions();
            if (isLargeTarget) {
                this._contentBin.opacity = 0;
                this._contentBin.ease({
                    opacity: 255,
                    delay: Math.max(30, fadeDelayMs),
                    duration: Math.max(120, fadeDurationMs),
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            } else {
                this._contentBin.opacity = 255;
            }

            if (isLargeTarget)
                this._animateSquircleExpand();

            this._shell.ease({
                opacity: 255,
                width,
                height,
                x,
                y,
                duration: isLargeTarget ? 260 : 220,
                mode: (isLargeTarget || isCompactHandle)
                    ? Clutter.AnimationMode.EASE_OUT_CUBIC
                    : Clutter.AnimationMode.EASE_OUT_BACK,
                onComplete: () => {
                    if (seq === this._morphSeq) {
                        this._clearCornerStages();
                        if (this._pendingSettledCb) {
                            const cb = this._pendingSettledCb;
                            this._pendingSettledCb = null;
                            cb();
                        }
                    }
                    if (this._eqActive)
                        this._startEqLoop();
                },
            });
        } else {
            const sizeChanged =
                Math.abs(this._lastWidth - width) > 0.5 ||
                Math.abs(this._lastHeight - height) > 0.5;
            const posChanged =
                Math.abs(this._lastX - x) > 0.5 ||
                Math.abs(this._lastY - y) > 0.5;
            const geomChanged = sizeChanged || posChanged;

            if (geomChanged) {
                if (isLargeTarget && isExpanding)
                    this._animateSquircleExpand();

                this._shell.remove_all_transitions();
                const easeTarget = sizeChanged
                    ? { width, height, x, y, opacity: 255 }
                    : { x, y, opacity: 255 };
                this._shell.ease({
                    ...easeTarget,
                    duration: isExpanding ? 245 : (isLargeTarget ? 195 : 190),
                    mode: isExpanding || isLargeTarget
                        ? Clutter.AnimationMode.EASE_OUT_CUBIC
                        : Clutter.AnimationMode.EASE_OUT_QUAD,
                    onComplete: () => {
                        if (seq === this._morphSeq) {
                            this._clearCornerStages();
                            if (this._pendingSettledCb) {
                                const cb = this._pendingSettledCb;
                                this._pendingSettledCb = null;
                                cb();
                            }
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
                    delay: Math.max(0, fadeDelayMs),
                    duration: Math.max(100, fadeDurationMs),
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            } else if (!this._contentBin.get_transition('opacity') && this._contentBin.opacity < 255) {
                this._contentBin.opacity = 255;
            }

            if (this._eqActive && !this._eqTimerId)
                this._startEqLoop();
        }

        this._lastX = x;
        this._lastY = y;
        this._lastWidth = width;
        this._lastHeight = height;
    }

    collapseToIdleBar({ shrinkRect, targetRect, onMidSwap, onComplete }) {
        if (this._destroyed || !this._shell || !this._contentBin)
            return;
        const seq = ++this._morphSeq;
        this._pendingSettledCb = null;
        this._stopEqLoop();

        if (!this._visible || !this._shell.visible) {
            this._collapsing = false;
            this._visible = true;
            onMidSwap?.();
            if (this._destroyed || !this._shell || !this._contentBin)
                return;
            this._shell.set_position(targetRect.x, targetRect.y);
            this._shell.set_size(targetRect.width, targetRect.height);
            this._shell.opacity = 255;
            this._shell.show();
            this._contentBin.remove_all_transitions();
            this._contentBin.opacity = 255;
            this._lastX = targetRect.x;
            this._lastY = targetRect.y;
            this._lastWidth = targetRect.width;
            this._lastHeight = targetRect.height;
            onComplete?.();
            return;
        }

        this._visible = true;
        this._collapsing = true;
        this._lastX = shrinkRect.x;
        this._lastY = shrinkRect.y;
        this._lastWidth = shrinkRect.width;
        this._lastHeight = shrinkRect.height;

        this._contentBin.remove_all_transitions();
        this._contentBin.ease({
            opacity: 0,
            duration: 95,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        this._animateSquircleCollapse();

        this._shell.remove_all_transitions();
        this._shell.ease({
            x: shrinkRect.x,
            y: shrinkRect.y,
            width: shrinkRect.width,
            height: shrinkRect.height,
            opacity: 255,
            duration: 145,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onComplete: () => {
                this._clearCornerStages();
                if (this._destroyed || !this._shell || !this._contentBin || seq !== this._morphSeq || !this._visible) {
                    this._collapsing = false;
                    return;
                }

                this._collapsing = false;
                onMidSwap?.();
                if (this._destroyed || !this._shell || !this._contentBin)
                    return;

                this._shell.set_position(targetRect.x, targetRect.y);
                this._shell.set_size(targetRect.width, targetRect.height);
                this._lastX = targetRect.x;
                this._lastY = targetRect.y;
                this._lastWidth = targetRect.width;
                this._lastHeight = targetRect.height;

                this._contentBin.remove_all_transitions();
                this._contentBin.opacity = 0;
                this._contentBin.ease({
                    opacity: 255,
                    duration: 120,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onComplete: () => {
                        if (!this._destroyed && this._shell && seq === this._morphSeq && this._visible)
                            onComplete?.();
                    },
                });
            },
        });
    }

    snapPosition({ x, y }) {
        if (this._destroyed || !this._shell || !this._contentBin || !this._visible)
            return;

        if (!this._shell.get_transition('opacity') && this._shell.opacity < 255)
            this._shell.opacity = 255;
        if (!this._contentBin.get_transition('opacity') && this._contentBin.opacity < 255)
            this._contentBin.opacity = 255;

        if (Math.abs(this._lastX - x) <= 0.5 && Math.abs(this._lastY - y) <= 0.5)
            return;

        this._shell.remove_transition('x');
        this._shell.remove_transition('y');
        this._shell.set_position(x, y);
        this._lastX = x;
        this._lastY = y;
        this._flushPendingSettled(this._morphSeq);
    }

    glidePosition({ x, y }) {
        if (this._destroyed || !this._shell || !this._contentBin || !this._visible)
            return;

        if (!this._shell.get_transition('opacity') && this._shell.opacity < 255)
            this._shell.opacity = 255;
        if (!this._contentBin.get_transition('opacity') && this._contentBin.opacity < 255)
            this._contentBin.opacity = 255;

        if (Math.abs(this._lastX - x) <= 0.5 && Math.abs(this._lastY - y) <= 0.5)
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
        this._destroyed = true;
        this._visible = false;
        this._morphSeq++;
        this._collapsing = false;
        this._pendingSettledCb = null;
        this._stopEqLoop();
        this._clearCornerStages();
        this._eqBars = [];

        if (this._shellDestroyId && this._shell) {
            try { this._shell.disconnect(this._shellDestroyId); } catch {}
        }
        this._shellDestroyId = 0;

        if (this._binDestroyId && this._contentBin) {
            try { this._contentBin.disconnect(this._binDestroyId); } catch {}
        }
        this._binDestroyId = 0;

        try { this._shell?.remove_all_transitions?.(); } catch {}
        try { this._contentBin?.remove_all_transitions?.(); } catch {}
        this._shell = null;
        this._contentBin = null;
    }
}
