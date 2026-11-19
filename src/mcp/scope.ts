import { statSync } from 'node:fs';

export interface ResolveScopeOpts {
  /**
   * When true the drive-letter / root prefix comparison is case-insensitive.
   * Default: `process.platform === 'win32'`
   */
  caseInsensitive?: boolean;
  /**
   * Returns true iff the path exists AND is a directory.
   * Default: `statSync(abs).isDirectory()` (false on error).
   * Injectable so unit tests can exercise every branch on any OS.
   */
  isDir?: (abs: string) => boolean;
}

/**
 * Resolve `pathArg` against `serverRoot` and return the `in` value the caller
 * should pass on each narrowed query.
 *
 * Rules (D5), applied in order:
 *  1. Normalize both paths: `\` → `/`, strip trailing slashes.
 *  2. If path == root (case-insensitive when `caseInsensitive`), or empty → whole workspace.
 *  3. If path is not under root (same case rule) → error.
 *  4. If any segment of path equals `..` → error.
 *  5. If the path is not an existing directory → error.
 *  6. Return `rel` = path minus the root prefix, in the caller's original case.
 */
export function resolveScope(
  serverRoot: string,
  pathArg: unknown,
  opts: ResolveScopeOpts = {},
): { text: string; ok: boolean } {
  const ci = opts.caseInsensitive ?? (process.platform === 'win32');
  const isDirFn: (abs: string) => boolean =
    opts.isDir ??
    ((abs: string) => {
      try {
        return statSync(abs).isDirectory();
      } catch {
        return false;
      }
    });

  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const srv = norm(String(serverRoot));
  const p   = norm(String(pathArg ?? ''));

  const loSrv = ci ? srv.toLowerCase() : srv;
  const loP   = ci ? p.toLowerCase()   : p;

  const suffix = 'this server keeps no per-session scope, so the value must travel in each call';

  // Rule 2: path equals root (or empty string) → whole workspace
  if (loP === loSrv || p === '') {
    return { ok: true, text: `scope: whole workspace — omit "in" on every call (${suffix})` };
  }

  // Rule 3: path is not under root
  if (!loP.startsWith(loSrv + '/')) {
    return { ok: false, text: `path "${p}" is not under the server workspace "${srv}" — no scope resolved` };
  }

  // Rule 4: any segment equals ".."
  if (p.split('/').some((seg) => seg === '..')) {
    return { ok: false, text: `path "${p}" contains ".." segments` };
  }

  const rel = p.slice(srv.length + 1);

  // Rule 5: must be an existing directory
  if (!isDirFn(p)) {
    return { ok: false, text: `path "${p}" is not an existing directory` };
  }

  // Rule 6: success
  return { ok: true, text: `scope: ${rel} — pass in: "${rel}" on each call you want narrowed to it (${suffix})` };
}
