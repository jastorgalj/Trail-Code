/**
 * Where "here" is when a query names no directory. An agent session — or a plain
 * shell — started in a subdirectory of an indexed repo should still find the
 * graph, so the implicit root is the nearest ANCESTOR holding a graft index:
 * either a repo's own wiring graph (`graft/.graph/wiring.json`) or a workspace
 * parent's children index (`graft/workspace.json`). Nothing indexed anywhere
 * above → the start dir itself, so `graft build` in a fresh repo still means
 * "here" and no command silently retargets a sibling tree.
 *
 * Only the IMPLICIT case walks. An explicit `[dir]` argument is taken at face
 * value, and a `--dir` override short-circuits entirely: `contextDirFor` returns
 * an override verbatim and ignores the root it is handed, so every ancestor
 * would report the same context dir and the walk would answer "level 0" for a
 * dir that isn't the repo.
 */
import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { contextDirFor } from "../context/node-file.js";
import { wiringPath } from "./write.js";
import { workspacePath } from "./workspace.js";

/** True when `dir` is a graft root of either shape — a built repo or a workspace parent. */
export function hasGraftIndex(dir: string): boolean {
  return existsSync(wiringPath(contextDirFor(dir))) || existsSync(workspacePath(dir));
}

export interface RootResolution {
  /** Absolute dir to run the command against. */
  root: string;
  /** Directory levels walked up; 0 when the start dir was already the root (the common case). */
  levels: number;
}

/** The nearest ancestor of `start` (inclusive) that holds a graft index, else `start`. */
export function nearestGraftRoot(start: string, override?: string): RootResolution {
  const from = resolve(start);
  if (override) return { root: from, levels: 0 };
  let dir = from;
  for (let levels = 0; ; levels++) {
    if (hasGraftIndex(dir)) return { root: dir, levels };
    const up = dirname(dir);
    if (up === dir) return { root: from, levels: 0 }; // hit the filesystem root, nothing indexed
    dir = up;
  }
}

/**
 * Checks whether `dir` is a valid directory root before any effect runs.
 * - `"missing"`:  the path does not exist (stat raises ENOENT or ENOTDIR from path traversal).
 * - `"not-dir"`:  the path exists but is not a directory (file, pipe, …).
 * - `null`:       the path is a valid directory, or stat raised an unexpected error
 *                 (e.g. EACCES) — preserve today's behavior and let the command
 *                 surface its own error.
 *
 * Uses `statSync` (follows symlinks) so a symlink-to-directory is accepted.
 * Note: EACCES is not portable on Windows and is documented as not tested.
 */
export function rootProblem(dir: string): "missing" | "not-dir" | null {
  try {
    const st = statSync(resolve(dir));
    return st.isDirectory() ? null : "not-dir";
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return "missing";
    return null;
  }
}
