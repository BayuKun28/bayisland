import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import { IslandState } from '../core/PriorityManager.js';
import { ArtCache } from '../utils/ArtCache.js';

const DBUS_BUS = 'org.freedesktop.DBus';
const DBUS_PATH = '/org/freedesktop/DBus';
const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';

const DBUS_XML = `
<node>
  <interface name="org.freedesktop.DBus">
    <method name="ListNames">
      <arg type="as" direction="out"/>
    </method>
    <signal name="NameOwnerChanged">
      <arg type="s"/>
      <arg type="s"/>
      <arg type="s"/>
    </signal>
  </interface>
</node>`;

const MPRIS_XML = `
<node>
  <interface name="org.mpris.MediaPlayer2">
    <method name="Raise"/>
    <property name="Identity" type="s" access="read"/>
    <property name="DesktopEntry" type="s" access="read"/>
    <property name="CanRaise" type="b" access="read"/>
  </interface>
</node>`;

const MPRIS_PLAYER_XML = `
<node>
  <interface name="org.mpris.MediaPlayer2.Player">
    <method name="Next"/>
    <method name="Previous"/>
    <method name="Pause"/>
    <method name="PlayPause"/>
    <method name="Play"/>
    <method name="Seek">
      <arg type="x" direction="in"/>
    </method>
    <method name="SetPosition">
      <arg type="o" direction="in"/>
      <arg type="x" direction="in"/>
    </method>
    <signal name="Seeked">
      <arg type="x"/>
    </signal>
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="Position" type="x" access="read"/>
    <property name="CanGoNext" type="b" access="read"/>
    <property name="CanGoPrevious" type="b" access="read"/>
    <property name="CanPlay" type="b" access="read"/>
    <property name="CanPause" type="b" access="read"/>
    <property name="CanSeek" type="b" access="read"/>
  </interface>
</node>`;

const DBusProxy = Gio.DBusProxy.makeProxyWrapper(DBUS_XML);
const MprisRootProxy = Gio.DBusProxy.makeProxyWrapper(MPRIS_XML);
const MprisPlayerProxy = Gio.DBusProxy.makeProxyWrapper(MPRIS_PLAYER_XML);

/**
 * Universal MPRIS2 D-Bus controller with async album art caching,
 * pause auto-collapse timeout, and live position tracking when expanded.
 */
export class MprisManager {
    constructor({ timers, priority }) {
        this._timers = timers;
        this._priority = priority;
        this._artCache = new ArtCache();

        this._enabled = false;
        this._hideDelaySec = 15;
        this._dbusProxy = null;
        this._dbusSignalId = 0;
        this._players = new Map();
        this._activeBusName = null;

        this._pauseTimerId = 0;
        this._collapsedAfterPause = false;
        this._positionTickId = 0;
        this._posSyncUs = 0;
        this._posSyncMonoUs = 0;
        this._artSeq = 0;
        this._cachedArtUrl = '';
        this._cachedArtIcon = null;
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

    setHideDelaySeconds(sec) {
        this._hideDelaySec = Math.max(0, Math.round(sec));
        this._reconcileActivePlayer(false);
    }

    selectPlayer(busName) {
        const target = this._players.get(busName);
        if (!target)
            return;
        this._activeBusName = busName;
        this._collapsedAfterPause = false;
        this._posSyncUs = Number(target.playerProxy?.Position) || 0;
        this._posSyncMonoUs = GLib.get_monotonic_time();
        this._syncPositionAsync(target);
        this._loadArt(target.artUrl);
        this._publish(false);
    }

    getPlayersSnapshot() {
        const list = [];
        for (const entry of this._players.values()) {
            if (entry.status === 'Stopped' && !entry.title)
                continue;
            list.push({
                busName: entry.busName,
                identity: entry.identity,
                status: entry.status,
                title: entry.title,
                active: entry.busName === this._activeBusName,
            });
        }
        return list;
    }

    playPause() {
        const p = this._players.get(this._activeBusName);
        p?.playerProxy?.PlayPauseAsync().catch(() => {});
    }

    next() {
        const p = this._players.get(this._activeBusName);
        p?.playerProxy?.NextAsync().catch(() => {});
    }

    previous() {
        const p = this._players.get(this._activeBusName);
        p?.playerProxy?.PreviousAsync().catch(() => {});
    }

    raise() {
        const p = this._players.get(this._activeBusName);
        if (!p)
            return;
        if (p.app)
            p.app.activate();
        else if (p.rootProxy?.CanRaise)
            p.rootProxy.RaiseAsync().catch(() => {});
    }

    seekToFraction(fraction) {
        const p = this._players.get(this._activeBusName);
        if (!p?.playerProxy || !p.lengthUs || p.lengthUs <= 0)
            return;

        const targetUs = Math.max(0, Math.min(p.lengthUs, Math.round(p.lengthUs * fraction)));
        const currentUs = this._estimatePositionUs(p);
        this._posSyncUs = targetUs;
        this._posSyncMonoUs = GLib.get_monotonic_time();

        if (p.trackId && p.trackId.startsWith('/')) {
            p.playerProxy.SetPositionAsync(p.trackId, targetUs).catch(() => {
                p.playerProxy.SeekAsync(targetUs - currentUs).catch(() => {});
            });
        } else {
            p.playerProxy.SeekAsync(targetUs - currentUs).catch(() => {});
        }
        this._publish(true);
    }

    _start() {
        this._dbusProxy = new DBusProxy(
            Gio.DBus.session,
            DBUS_BUS,
            DBUS_PATH,
            (proxy, err) => {
                if (err || !this._enabled)
                    return;
                this._dbusSignalId = proxy.connectSignal('NameOwnerChanged',
                    (_p, _sender, [name, oldOwner, newOwner]) => {
                        if (!name.startsWith(MPRIS_PREFIX))
                            return;
                        if (!newOwner)
                            this._removePlayer(name);
                        else if (!oldOwner)
                            this._addPlayer(name);
                    });

                proxy.ListNamesAsync().then(([names]) => {
                    if (!this._enabled)
                        return;
                    for (const name of names) {
                        if (name.startsWith(MPRIS_PREFIX))
                            this._addPlayer(name);
                    }
                }).catch(() => {});
            }
        );

        this._positionTickId = this._timers.setIntervalSeconds(1, () => {
            if (!this._enabled)
                return false;
            const model = this._priority.getModel();
            const p = this._players.get(this._activeBusName);
            if (model.state === IslandState.EXPANDED_MODAL && model.tab === 'media' && p?.status === 'Playing')
                this._publish(true);
            return true;
        });
    }

    _addPlayer(busName) {
        if (this._players.has(busName))
            return;

        const entry = {
            busName,
            rootProxy: null,
            playerProxy: null,
            rootPropId: 0,
            playerPropId: 0,
            seekedId: 0,
            app: null,
            identity: busName.replace(MPRIS_PREFIX, ''),
            status: 'Stopped',
            title: '',
            artist: '',
            artUrl: '',
            trackId: '',
            lengthUs: 0,
            canSeek: false,
            canGoNext: true,
            canGoPrevious: true,
            lastUpdatedMono: GLib.get_monotonic_time(),
        };
        this._players.set(busName, entry);

        entry.rootProxy = new MprisRootProxy(
            Gio.DBus.session,
            busName,
            '/org/mpris/MediaPlayer2',
            (proxy, err) => {
                if (err || !this._players.has(busName))
                    return;
                this._readRootProps(entry);
                entry.rootPropId = proxy.connect('g-properties-changed', () => {
                    this._readRootProps(entry);
                });
            }
        );

        entry.playerProxy = new MprisPlayerProxy(
            Gio.DBus.session,
            busName,
            '/org/mpris/MediaPlayer2',
            (proxy, err) => {
                if (err || !this._players.has(busName))
                    return;
                this._readPlayerProps(entry);
                entry.playerPropId = proxy.connect('g-properties-changed', (_p, changed) => {
                    const keys = changed?.deepUnpack ? Object.keys(changed.deepUnpack()) : [];
                    this._readPlayerProps(entry, keys);
                });
                entry.seekedId = proxy.connectSignal('Seeked', (_p, _sender, [posUs]) => {
                    if (busName === this._activeBusName) {
                        this._posSyncUs = Number(posUs) || 0;
                        this._posSyncMonoUs = GLib.get_monotonic_time();
                        this._publish(true);
                    }
                });
            }
        );
    }

    _readRootProps(entry) {
        if (!entry.rootProxy)
            return;
        if (entry.rootProxy.Identity)
            entry.identity = entry.rootProxy.Identity;
        if (entry.rootProxy.DesktopEntry) {
            try {
                entry.app = Shell.AppSystem.get_default().lookup_app(`${entry.rootProxy.DesktopEntry}.desktop`);
            } catch {
                entry.app = null;
            }
        }
        if (entry.busName === this._activeBusName)
            this._publish(true);
    }

    _readPlayerProps(entry, changedKeys = []) {
        const proxy = entry.playerProxy;
        if (!proxy)
            return;

        const prevStatus = entry.status;
        const prevTitle = entry.title;
        const prevArtUrl = entry.artUrl;

        entry.status = proxy.PlaybackStatus || 'Stopped';
        entry.canSeek = Boolean(proxy.CanSeek);
        entry.canGoNext = proxy.CanGoNext !== false;
        entry.canGoPrevious = proxy.CanGoPrevious !== false;
        entry.lastUpdatedMono = GLib.get_monotonic_time();

        const rawMeta = proxy.Metadata || {};
        const meta = {};
        for (const k of Object.keys(rawMeta))
            meta[k] = rawMeta[k]?.deepUnpack ? rawMeta[k].deepUnpack() : rawMeta[k];

        entry.title = typeof meta['xesam:title'] === 'string' && meta['xesam:title']
            ? meta['xesam:title']
            : entry.identity;

        const artists = meta['xesam:artist'];
        entry.artist = Array.isArray(artists) && artists.length > 0
            ? artists.filter(Boolean).join(', ')
            : entry.identity;

        entry.artUrl = typeof meta['mpris:artUrl'] === 'string' ? meta['mpris:artUrl'] : '';
        entry.trackId = typeof meta['mpris:trackid'] === 'string' ? meta['mpris:trackid'] : '';
        entry.lengthUs = Number(meta['mpris:length']) || 0;

        if (entry.status === 'Playing' && (prevStatus !== 'Playing' || prevTitle !== entry.title))
            this._collapsedAfterPause = false;

        // Refresh actual D-Bus Position when track or playback state changes
        if (entry.busName === this._activeBusName || entry.status === 'Playing') {
            this._syncPositionAsync(entry);
        }

        if (entry.artUrl !== prevArtUrl && entry.busName === this._activeBusName)
            this._loadArt(entry.artUrl);

        const onlyPosition = changedKeys.length > 0 && changedKeys.every(k => k === 'Position');
        this._reconcileActivePlayer(onlyPosition || (prevStatus === entry.status && prevTitle === entry.title));
    }

    _syncPositionAsync(entry) {
        if (!entry?.busName)
            return;
        Gio.DBus.session.call(
            entry.busName,
            '/org/mpris/MediaPlayer2',
            'org.freedesktop.DBus.Properties',
            'Get',
            new GLib.Variant('(ss)', ['org.mpris.MediaPlayer2.Player', 'Position']),
            new GLib.VariantType('(v)'),
            Gio.DBusCallFlags.NONE,
            1000,
            null,
            (conn, res) => {
                try {
                    const out = conn.call_finish(res);
                    const val = out?.recursiveUnpack?.()[0];
                    if (entry.busName === this._activeBusName && Number.isFinite(Number(val))) {
                        this._posSyncUs = Number(val);
                        this._posSyncMonoUs = GLib.get_monotonic_time();
                        this._publish(true);
                    }
                } catch {
                    // Some players do not implement Position
                }
            }
        );
    }

    _estimatePositionUs(entry) {
        if (!entry)
            return 0;
        if (entry.status !== 'Playing')
            return this._posSyncUs;
        const deltaUs = GLib.get_monotonic_time() - this._posSyncMonoUs;
        return Math.max(0, this._posSyncUs + Math.max(0, deltaUs));
    }

    async _loadArt(artUrl) {
        const seq = ++this._artSeq;
        if (!artUrl) {
            this._cachedArtUrl = '';
            this._cachedArtIcon = null;
            this._publish(false);
            return;
        }
        if (artUrl === this._cachedArtUrl && this._cachedArtIcon)
            return;

        const icon = await this._artCache.resolveIcon(artUrl);
        if (!this._enabled || seq !== this._artSeq)
            return;

        this._cachedArtUrl = artUrl;
        this._cachedArtIcon = icon;
        this._publish(false);
    }

    _pickActivePlayer() {
        let best = null;
        for (const entry of this._players.values()) {
            if (entry.status === 'Stopped' && !entry.title)
                continue;
            if (!best) {
                best = entry;
                continue;
            }
            if (best.status !== 'Playing' && entry.status === 'Playing') {
                best = entry;
            } else if (best.status === entry.status && entry.lastUpdatedMono > best.lastUpdatedMono) {
                best = entry;
            }
        }
        return best;
    }

    _reconcileActivePlayer(inPlaceHint) {
        if (!this._enabled)
            return;

        const best = this._pickActivePlayer();
        const nextBus = best?.busName ?? null;
        const switched = nextBus !== this._activeBusName;
        this._activeBusName = nextBus;

        if (!best || best.status === 'Stopped') {
            this._clearPauseTimer();
            this._collapsedAfterPause = false;
            this._priority.updatePersistent('media', { active: false });
            return;
        }

        if (switched) {
            this._collapsedAfterPause = false;
            this._posSyncUs = Number(best.playerProxy?.Position) || 0;
            this._posSyncMonoUs = GLib.get_monotonic_time();
            this._syncPositionAsync(best);
            this._loadArt(best.artUrl);
        }

        if (best.status === 'Playing') {
            this._clearPauseTimer();
            this._collapsedAfterPause = false;
            this._publish(inPlaceHint && !switched);
            return;
        }

        // Paused: start collapse countdown if configured
        if (this._hideDelaySec > 0 && !this._collapsedAfterPause && !this._pauseTimerId) {
            this._pauseTimerId = this._timers.setTimeout(this._hideDelaySec * 1000, () => {
                this._pauseTimerId = 0;
                const current = this._players.get(this._activeBusName);
                if (current && current.status !== 'Playing') {
                    this._collapsedAfterPause = true;
                    this._priority.updatePersistent('media', { active: false });
                }
            });
        }

        this._publish(inPlaceHint && !switched);
    }

    _publish(inPlaceHint) {
        const entry = this._players.get(this._activeBusName);
        if (!this._enabled || !entry || entry.status === 'Stopped' || this._collapsedAfterPause) {
            this._priority.updatePersistent('media', { active: false });
            return;
        }

        this._priority.updatePersistent('media', {
            active: true,
            busName: entry.busName,
            status: entry.status,
            title: entry.title || entry.identity,
            artist: entry.artist || entry.identity,
            playerName: entry.identity,
            players: this.getPlayersSnapshot(),
            app: entry.app,
            artIcon: this._cachedArtUrl === entry.artUrl ? this._cachedArtIcon : null,
            positionUs: this._estimatePositionUs(entry),
            lengthUs: entry.lengthUs,
            canSeek: entry.canSeek,
            canGoNext: entry.canGoNext,
            canGoPrevious: entry.canGoPrevious,
        }, { inPlaceHint });
    }

    _clearPauseTimer() {
        if (this._pauseTimerId) {
            this._timers.clear(this._pauseTimerId);
            this._pauseTimerId = 0;
        }
    }

    _removePlayer(busName) {
        const entry = this._players.get(busName);
        if (!entry)
            return;
        if (entry.rootProxy && entry.rootPropId) {
            try { entry.rootProxy.disconnect(entry.rootPropId); } catch {}
        }
        if (entry.playerProxy && entry.playerPropId) {
            try { entry.playerProxy.disconnect(entry.playerPropId); } catch {}
        }
        if (entry.playerProxy && entry.seekedId) {
            try { entry.playerProxy.disconnectSignal(entry.seekedId); } catch {}
        }
        entry.rootProxy = null;
        entry.playerProxy = null;
        this._players.delete(busName);

        if (this._activeBusName === busName) {
            this._activeBusName = null;
            this._reconcileActivePlayer(false);
        }
    }

    _stop() {
        this._clearPauseTimer();
        if (this._positionTickId) {
            this._timers.clear(this._positionTickId);
            this._positionTickId = 0;
        }
        if (this._dbusProxy && this._dbusSignalId) {
            try { this._dbusProxy.disconnectSignal(this._dbusSignalId); } catch {}
            this._dbusSignalId = 0;
        }
        this._dbusProxy = null;

        for (const name of [...this._players.keys()])
            this._removePlayer(name);

        this._activeBusName = null;
        this._priority.updatePersistent('media', { active: false });
    }

    destroy() {
        this._stop();
        this._artCache.destroy();
    }
}
