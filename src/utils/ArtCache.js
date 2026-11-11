import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

let _promisified = false;
function ensurePromisified() {
    if (_promisified)
        return;
    _promisified = true;
    try {
        Gio._promisify(Soup.Session.prototype, 'send_and_read_async', 'send_and_read_finish');
        Gio._promisify(Gio.File.prototype, 'replace_contents_async', 'replace_contents_finish');
    } catch {
        // Ignore if already promisified elsewhere
    }
}

const MAX_CACHE_ENTRIES = 24;

/**
 * Asynchronous, bounded disk cache for MPRIS cover art URLs (http/https/file/data).
 */
export class ArtCache {
    constructor() {
        ensurePromisified();
        this._cacheDir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'bayisland', 'art']);
        this._ensureDir();
        this._session = new Soup.Session({ timeout: 5 });
        this._memIndex = new Map();
        this._cancellable = new Gio.Cancellable();
    }

    _ensureDir() {
        try {
            GLib.mkdir_with_parents(this._cacheDir, 0o755);
        } catch {
            // Best effort
        }
    }

    async resolveIcon(artUrl) {
        if (!artUrl || typeof artUrl !== 'string')
            return null;

        if (artUrl.startsWith('file://')) {
            const file = Gio.File.new_for_uri(artUrl);
            if (file.query_exists(null))
                return new Gio.FileIcon({ file });
            return null;
        }

        if (artUrl.startsWith('/')) {
            const file = Gio.File.new_for_path(artUrl);
            if (file.query_exists(null))
                return new Gio.FileIcon({ file });
            return null;
        }

        if (artUrl.startsWith('data:image/')) {
            const commaIdx = artUrl.indexOf(',');
            if (commaIdx !== -1 && artUrl.slice(0, commaIdx).includes(';base64')) {
                try {
                    const bytes = GLib.base64_decode(artUrl.slice(commaIdx + 1));
                    return new Gio.BytesIcon({ bytes: GLib.Bytes.new(bytes) });
                } catch {
                    return null;
                }
            }
            return null;
        }

        if (!artUrl.startsWith('http://') && !artUrl.startsWith('https://'))
            return null;

        const cachedPath = this._memIndex.get(artUrl);
        if (cachedPath) {
            const f = Gio.File.new_for_path(cachedPath);
            if (f.query_exists(null))
                return new Gio.FileIcon({ file: f });
            this._memIndex.delete(artUrl);
        }

        const hash = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, artUrl, -1);
        const targetPath = GLib.build_filenamev([this._cacheDir, hash]);
        const targetFile = Gio.File.new_for_path(targetPath);

        if (targetFile.query_exists(null)) {
            this._remember(artUrl, targetPath);
            return new Gio.FileIcon({ file: targetFile });
        }

        try {
            const msg = Soup.Message.new('GET', artUrl);
            if (!msg)
                return null;
            const bytes = await this._session.send_and_read_async(
                msg,
                GLib.PRIORITY_DEFAULT,
                this._cancellable
            );
            if (msg.get_status() !== Soup.Status.OK || !bytes || bytes.get_size() === 0)
                return null;

            // Cap art file size at 4 MB
            if (bytes.get_size() > 4 * 1024 * 1024)
                return null;

            await targetFile.replace_contents_async(
                bytes.get_data(),
                null,
                false,
                Gio.FileCreateFlags.REPLACE_DESTINATION,
                this._cancellable
            );

            this._remember(artUrl, targetPath);
            this._pruneOldFiles();
            return new Gio.FileIcon({ file: targetFile });
        } catch {
            return null;
        }
    }

    _remember(url, path) {
        this._memIndex.delete(url);
        this._memIndex.set(url, path);
        while (this._memIndex.size > MAX_CACHE_ENTRIES) {
            const oldestKey = this._memIndex.keys().next().value;
            this._memIndex.delete(oldestKey);
        }
    }

    _pruneOldFiles() {
        try {
            const dir = Gio.File.new_for_path(this._cacheDir);
            const enumerator = dir.enumerate_children(
                'standard::name,time::modified',
                Gio.FileQueryInfoFlags.NONE,
                null
            );
            const files = [];
            let info;
            while ((info = enumerator.next_file(null)) !== null) {
                files.push({
                    name: info.get_name(),
                    mtime: info.get_modification_date_time()?.to_unix() ?? 0,
                });
            }
            enumerator.close(null);

            if (files.length <= MAX_CACHE_ENTRIES)
                return;

            files.sort((a, b) => a.mtime - b.mtime);
            const toDelete = files.slice(0, files.length - MAX_CACHE_ENTRIES);
            for (const f of toDelete) {
                Gio.File.new_for_path(GLib.build_filenamev([this._cacheDir, f.name])).delete(null);
            }
        } catch {
            // Non-critical cleanup failure
        }
    }

    destroy() {
        this._cancellable.cancel();
        this._session.abort();
        this._memIndex.clear();
    }
}
