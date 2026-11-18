/**
 * One line that redraws in place while a long build runs:
 *
 *     parsing 412/1,204 files · 12s · src/graph/extract.ts
 *
 * A *progress report*, not a per-file log: an update that lands within
 * `minIntervalMs` of the previous draw is dropped, so a 5,000-file build writes a
 * few dozen frames instead of 5,000 lines, and the count it leaves on screen is
 * the latest one. The last item of a phase always draws, so the total is never a
 * stale number.
 *
 * Only on a TTY — piped or redirected (CI, `> build.log`), every method is a
 * no-op and the caller's own summary is the whole story. The one exception is a
 * parent that asked for it: `GRAFT_PROGRESS=1` keeps the line coming through a
 * pipe, which is how `trail init` drives its own spinner from a child build's
 * output.
 */
export interface ProgressLine {
  /** Redraw the line. `index` is 0-based; omit `total` when the caller doesn't
   * know it yet, and `file` when there's nothing more specific than the count. */
  update(label: string, index: number, total?: number, file?: string): void;
  /** Erase the line, leaving the cursor at column 0. Safe to call more than once. */
  stop(): void;
  /** True while this line is actually being drawn (a TTY and not stopped). */
  readonly active: boolean;
}

export function startProgressLine(
  opts: {
    stream?: NodeJS.WriteStream;
    enabled?: boolean;
    minIntervalMs?: number;
    /** Injectable clock, for tests that need a deterministic elapsed time. */
    now?: () => number;
  } = {},
): ProgressLine {
  const out = opts.stream ?? process.stderr;
  const enabled = opts.enabled ?? (Boolean(out.isTTY) || process.env.GRAFT_PROGRESS === "1");
  const now = opts.now ?? Date.now;
  const minMs = opts.minIntervalMs ?? 120;
  const started = now();
  let last = -Infinity;
  let drawn = false;
  let stopped = false;
  const width = () => Math.max(20, (out.columns || 100) - 1);

  return {
    get active() {
      return enabled && !stopped;
    },
    update(label, index, total, file) {
      if (!enabled || stopped) return;
      const t = now();
      const lastItem = total !== undefined && index + 1 >= total;
      if (!lastItem && t - last < minMs) return;
      last = t;
      const count = (index + 1).toLocaleString("en-US");
      const of = total !== undefined && total > 0 ? `/${total.toLocaleString("en-US")} files` : " files";
      const secs = Math.round((t - started) / 1000);
      const tail = file ? ` · ${file.replace(/\\/g, "/")}` : "";
      const line = `${label} ${count}${of} · ${secs}s${tail}`;
      out.write(`\r\x1b[2K${line.length > width() ? line.slice(0, width()) : line}`);
      drawn = true;
    },
    stop() {
      if (!enabled || stopped) return;
      stopped = true;
      if (drawn) out.write("\r\x1b[2K");
      drawn = false;
    },
  };
}
