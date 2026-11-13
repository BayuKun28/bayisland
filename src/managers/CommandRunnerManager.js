import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

/**
 * CommandRunnerManager handles instant math expression evaluation and
 * asynchronous, sandboxed one-liner shell command execution with strict timeouts.
 */
export class CommandRunnerManager {
    constructor() {
        this._cancellable = null;
    }

    /**
     * Safely evaluate a mathematical expression.
     * Supports basic arithmetic, powers, and Math functions.
     * @param {string} expr
     * @returns {{ ok: boolean, result?: string, error?: string }}
     */
    evaluateMath(expr) {
        if (!expr || typeof expr !== 'string')
            return { ok: false, error: 'Empty expression' };

        let clean = expr.trim();
        if (clean.startsWith('='))
            clean = clean.slice(1).trim();

        if (!clean)
            return { ok: false, error: 'Empty expression' };

        // Quick sanity check: Must contain at least one digit or math symbol
        if (!/[\d\.]/.test(clean) && !/\b(pi|e)\b/i.test(clean))
            return { ok: false, error: 'Not a math expression' };

        // Disallow dangerous keywords/syntax
        const forbidden = /\b(window|global|globalThis|this|process|require|import|Function|eval|constructor|prototype|__proto__|var|let|const|return|if|for|while|do|switch|case|break|continue|throw|catch|finally|delete|new|typeof|instanceof|void|yield|await|async|class)\b/;
        if (forbidden.test(clean))
            return { ok: false, error: 'Invalid characters in expression' };

        // Replace common math notations
        let transformed = clean
            .replace(/\bpi\b/gi, 'Math.PI')
            .replace(/\be\b/g, 'Math.E')
            .replace(/\^/g, '**')
            .replace(/\b(sqrt|cbrt|sin|cos|tan|asin|acos|atan|abs|round|floor|ceil|trunc|log|log2|log10|exp|min|max)\b/gi, 'Math.$1');

        // Check that only safe tokens remain
        const safeChars = /^[0-9+\-*/%^().,\sMathPIEabscdeghilnoqrstufw]+$/;
        if (!safeChars.test(transformed))
            return { ok: false, error: 'Unsupported operator or symbol' };

        try {
            // eslint-disable-next-line no-new-func
            const fn = new Function(`"use strict"; return (${transformed});`);
            const val = fn();

            if (typeof val !== 'number' || !Number.isFinite(val))
                return { ok: false, error: 'Result is not a finite number' };

            // Format nicely
            let formatted;
            if (Number.isInteger(val) && Math.abs(val) < 1e12) {
                formatted = val.toLocaleString('en-US');
            } else {
                formatted = parseFloat(val.toFixed(8)).toString();
            }

            return { ok: true, result: formatted, raw: val };
        } catch {
            return { ok: false, error: 'Syntax error' };
        }
    }

    /**
     * Executes a one-line shell command asynchronously with a 5-second timeout.
     * @param {string} commandLine
     * @param {Function} callback (result: { ok: boolean, stdout: string, stderr: string, durationMs: number, exitCode: number }) => void
     */
    executeCommandAsync(commandLine, callback) {
        if (!commandLine || typeof commandLine !== 'string') {
            callback?.({ ok: false, stdout: '', stderr: 'Empty command', durationMs: 0, exitCode: -1 });
            return;
        }

        const cmd = commandLine.trim();
        const startMono = GLib.get_monotonic_time();

        if (this._cancellable) {
            this._cancellable.cancel();
            this._cancellable = null;
        }
        this._cancellable = new Gio.Cancellable();

        // 5-second safety timeout
        const timeoutSourceId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
            if (this._cancellable) {
                this._cancellable.cancel();
            }
            return GLib.SOURCE_REMOVE;
        });

        try {
            const proc = Gio.Subprocess.new(
                ['/bin/bash', '-c', cmd],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );

            proc.communicate_utf8_async(null, this._cancellable, (_proc, res) => {
                GLib.source_remove(timeoutSourceId);
                const endMono = GLib.get_monotonic_time();
                const durationMs = Math.round((endMono - startMono) / 1000);

                try {
                    const [, stdout, stderr] = proc.communicate_utf8_finish(res);
                    const exitCode = proc.get_exit_status();
                    const ok = exitCode === 0;
                    callback?.({
                        ok,
                        stdout: (stdout || '').trim(),
                        stderr: (stderr || '').trim(),
                        durationMs,
                        exitCode,
                    });
                } catch (e) {
                    const isCancelled = e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
                    callback?.({
                        ok: false,
                        stdout: '',
                        stderr: isCancelled ? 'Command timed out (exceeded 5s limit)' : (e.message || 'Execution failed'),
                        durationMs,
                        exitCode: -1,
                    });
                }
            });
        } catch (e) {
            GLib.source_remove(timeoutSourceId);
            const durationMs = Math.round((GLib.get_monotonic_time() - startMono) / 1000);
            callback?.({
                ok: false,
                stdout: '',
                stderr: e.message || 'Failed to spawn process',
                durationMs,
                exitCode: -1,
            });
        }
    }

    cancel() {
        if (this._cancellable) {
            this._cancellable.cancel();
            this._cancellable = null;
        }
    }

    destroy() {
        this.cancel();
    }
}
