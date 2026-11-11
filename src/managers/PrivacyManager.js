import Gvc from 'gi://Gvc';
import Shell from 'gi://Shell';
import * as Volume from 'resource:///org/gnome/shell/ui/status/volume.js';

const SKIPPED_MIC_APPS = new Set([
    'org.gnome.VolumeControl',
    'org.PulseAudio.pavucontrol',
]);

/**
 * Monitors real-time Camera (Shell.CameraMonitor) and Microphone (Gvc.MixerControl)
 * usage with zero polling.
 */
export class PrivacyManager {
    constructor({ signals, priority }) {
        this._signals = signals;
        this._priority = priority;
        this._enabled = false;

        this._cameraMonitor = null;
        this._mixerControl = null;
        this._defaultSource = null;
        this._sourceMutedId = 0;

        this._cameraActive = false;
        this._micActive = false;
        this._micMuted = false;
    }

    setEnabled(enabled) {
        const want = Boolean(enabled);
        if (want === this._enabled)
            return;
        this._enabled = want;

        if (want)
            this._start();
        else
            this._stop();
    }

    _start() {
        try {
            this._cameraMonitor = new Shell.CameraMonitor();
            this._cameraActive = Boolean(this._cameraMonitor.cameras_in_use);
            this._signals.connect(this._cameraMonitor, 'notify::cameras-in-use', () => {
                this._cameraActive = Boolean(this._cameraMonitor.cameras_in_use);
                this._publish();
            });
        } catch {
            this._cameraMonitor = null;
        }

        try {
            this._mixerControl = Volume.getMixerControl();
            this._signals.connect(this._mixerControl, 'state-changed', () => this._evaluateMic());
            this._signals.connect(this._mixerControl, 'default-source-changed', () => this._bindDefaultSource());
            this._signals.connect(this._mixerControl, 'stream-added', () => this._evaluateMic());
            this._signals.connect(this._mixerControl, 'stream-removed', () => this._evaluateMic());
            this._bindDefaultSource();
            this._evaluateMic();
        } catch {
            this._mixerControl = null;
        }

        this._publish();
    }

    _bindDefaultSource() {
        if (this._defaultSource && this._sourceMutedId) {
            try {
                this._defaultSource.disconnect(this._sourceMutedId);
            } catch {
                // Ignore
            }
            this._sourceMutedId = 0;
        }

        this._defaultSource = this._mixerControl?.get_default_source() ?? null;
        if (this._defaultSource) {
            this._micMuted = Boolean(this._defaultSource.is_muted);
            this._sourceMutedId = this._defaultSource.connect('notify::is-muted', () => {
                this._micMuted = Boolean(this._defaultSource?.is_muted);
                this._publish();
            });
        }
        this._evaluateMic();
    }

    _evaluateMic() {
        if (!this._mixerControl || this._mixerControl.get_state() !== Gvc.MixerControlState.READY) {
            this._micActive = false;
            this._publish();
            return;
        }

        const outputs = this._mixerControl.get_source_outputs();
        this._micActive = outputs.some(stream => {
            const appId = stream.get_application_id?.();
            return !SKIPPED_MIC_APPS.has(appId);
        });
        this._micMuted = Boolean(this._defaultSource?.is_muted);
        this._publish();
    }

    _publish() {
        if (!this._enabled) {
            this._priority.updatePersistent('privacy', { active: false, camera: false, mic: false });
            return;
        }

        this._priority.updatePersistent('privacy', {
            active: this._cameraActive || this._micActive,
            camera: this._cameraActive,
            mic: this._micActive,
            micMuted: this._micMuted,
        });
    }

    _stop() {
        if (this._defaultSource && this._sourceMutedId) {
            try {
                this._defaultSource.disconnect(this._sourceMutedId);
            } catch {
                // Ignore
            }
            this._sourceMutedId = 0;
        }
        this._defaultSource = null;
        this._cameraMonitor = null;
        this._mixerControl = null;
        this._cameraActive = false;
        this._micActive = false;
        this._priority.updatePersistent('privacy', { active: false, camera: false, mic: false });
    }

    destroy() {
        this._stop();
    }
}
