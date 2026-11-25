import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const EN_DAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const EN_MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Format elapsed or remaining seconds into mm:ss format.
 * @param {number} sec - Seconds
 * @returns {string} mm:ss formatted string
 */
export function formatClock(sec) {
    const s = Math.max(0, Math.floor(sec));
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return `${String(m).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
}

/**
 * Flatten multi-line text into clean single-line text (newlines -> space, collapse whitespace, trim).
 * @param {string} text
 * @returns {string}
 */
export function sanitizeSingleLine(text) {
    if (typeof text !== 'string')
        return '';
    return text.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Format media duration in minutes:seconds (e.g. 3:45 or -1:20).
 * @param {number} sec - Seconds
 * @param {boolean} negative - Whether to prefix with minus
 * @returns {string} Formatted media duration
 */
export function formatMediaDuration(sec, negative = false) {
    const s = Math.max(0, Math.floor(sec));
    const mins = Math.floor(s / 60);
    const secs = s % 60;
    const prefix = negative ? '-' : '';
    return `${prefix}${mins}:${String(secs).padStart(2, '0')}`;
}

/**
 * Generate a short localized peek date string: e.g. "Sat 15 Nov".
 * @param {GLib.DateTime} [customNow]
 * @returns {string}
 */
export function getPeekDateString(customNow = null) {
    const now = customNow || GLib.DateTime.new_now_local();
    const dow = now.get_day_of_week() % 7;
    const monthIdx = Math.max(0, Math.min(11, now.get_month() - 1));
    return `${EN_DAYS_SHORT[dow]} ${now.get_day_of_month()} ${EN_MONTHS_SHORT[monthIdx]}`;
}

/**
 * Generate a formatted clock string respecting GNOME 12h/24h preference.
 * @param {GLib.DateTime} [customNow]
 * @returns {string}
 */
export function getPeekClockString(customNow = null) {
    const now = customNow || GLib.DateTime.new_now_local();
    let use24h = true;
    try {
        const src = Gio.SettingsSchemaSource.get_default();
        const schema = src?.lookup('org.gnome.desktop.interface', true);
        if (schema) {
            const gs = new Gio.Settings({ settings_schema: schema });
            use24h = gs.get_string('clock-format') !== '12h';
        }
    } catch {
        use24h = true;
    }
    return (use24h ? now.format('%H:%M') : now.format('%I:%M %p')) || '00:00';
}

/**
 * Map power profile name to GNOME symbolic icon.
 * @param {string} profile
 * @returns {string}
 */
export function getProfileIconName(profile) {
    if (profile === 'power-saver')
        return 'power-profile-power-saver-symbolic';
    if (profile === 'performance')
        return 'power-profile-performance-symbolic';
    return 'power-profile-balanced-symbolic';
}
