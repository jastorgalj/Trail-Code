/**
 * Workspace federation — a "workspace" is a parent directory that holds two or
 * more immediate git-repo children and has no source graph of its own. Instead
 * of one mega-graph pooling every repo, each child keeps its OWN committable
 * `graft/` (byte-identical to building that child standalone), and the parent
 * holds a single `graft/workspace.json` index:
 *
 *   { "version": 1, "children": ["repoA", "repoB"] }
 *
 * Queries run at the parent federate across the children: `ask` fuses every
 * child's ranked hits with `fuseScopes`, reciprocal-rank fusion, so the big
 * repo can't drown the small one. Scopes INSIDE one repo no longer take that
 * path — they share corpus statistics and a normalization denominator, so they
 * are combined by score (see `ask/fuse.ts`). Separate child repositories have
 * no such shared scale, which is exactly the case rank fusion is for.
 * `grep`/`map`/`check`/`callers` run per child and merge, always labeled
 * `<child>/`.
 *
 * This module owns the pure/core pieces (the format, its readers/writers, graph
 * loading, and the federated command bodies that return renderable data). The
 * CLI print/exit wrappers and the per-child build orchestration live in
 * `workspace-cli.ts`; `mcp/tools.ts` calls the federate* functions directly.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, dirname, isAbsolute, relative as relativePath } from "node:path";
import { contextDirFor, CACHE_DIR } from "../context/node-file.js";
import { checkGraph } from "./check.js";
import { loadGraphCached } from "./load.js";
import { buildRepoMap, formatRepoMap } from "./map.js";
import { discoverWorkspaceChildren, pathUnderPrefix } from "./scopes.js";
import { normalizePathPrefix } from "../util/paths.js";
import {
  callersSavings,
  headerOf,
  hitLine,
  looseNoteFor,
} from "./traverse-cli.js";
import { edgeWalk, resolveSymbol, type Direction } from "./traverse.js";
import { wiringPath } from "./write.js";
import type { GraphV1 } from "./types.js";
import {
  ask,
  type AskHit,
  type AskRankingMetadata,
  type AskResult,
} from "../ask/ask.js";
import {
  fileFirstRoundRobin,
  roundRobinQueues,
} from "../ask/file-selection.js";
import { fuseScopes, STRONG_FLOOR, HIGH_FLOOR, type ScopedDoc } from "../ask/fuse.js";
import { grepGraph, type GrepGroup, type GrepResult } from "../search/grep.js";
import { formatGrepResult, zeroHitNote } from "../search/grep-cli.js";
import { withSavings, type Savings } from "../context/savings.js";
import { cmd } from "../brand.js";
import { searchSemantic } from "../ask/semantic.js";

/** The parent index written to `<parent>/graft/workspace.json`. Nodes/edges
 * never live at the parent — they live in each child's own `graft/`. */
export interface WorkspaceV1 {
  version: 1;
  /** Immediate child dir names that are git repos, sorted. */
  children: string[];
  /**
   * Dirs to skip during auto-discovery. Edit this list to permanently exclude
   * a repo from the workspace — `trail build` will preserve and respect it.
   * Paths are relative to the workspace root (e.g. `"Trail-Code"`, `"SDK"`).
   */
  excludeFromDiscovery?: string[];
  /**
   * Git remote URLs of shared knowledge repos (team docs, rules, glossaries).
   * `trail init` clones each one into the workspace root if it isn't already
   * present, wires it, and runs `trail build --include-md` on it automatically.
   * Committed to version control so every team member gets the same repos.
   *
   * Example: ["https://gitlab.com/detacoop/equipo-desarrolladores/detacoop-knowledge"]
   */
  knowledgeRepos?: string[];
}

const WORKSPACE_FILE = "workspace.json";
/** Committed file that stores shared workspace settings (knowledgeRepos).
 * Lives in .trail/ (committed) separate from .trail/cache/workspace.json (git-ignored). */
const KNOWLEDGE_REPOS_FILE = "knowledge-repos.json";

/** Absolute path to the knowledge-repos config for a workspace root. Always committed. */
export function knowledgeReposPath(root: string): string {
  return join(root, ".trail", KNOWLEDGE_REPOS_FILE);
}

/** Read the list of knowledge repo URLs for a workspace root. */
export function readKnowledgeRepos(root: string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(knowledgeReposPath(root), "utf8"));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch { return []; }
}

/** Write the list of knowledge repo URLs. Ensures .trail/ exists. */
export function writeKnowledgeRepos(root: string, urls: string[]): void {
  const dir = join(root, ".trail");
  mkdirSync(dir, { recursive: true });
  writeFileSync(knowledgeReposPath(root), JSON.stringify(urls, null, 2) + "\n");
}

/** Absolute path to the workspace index for a parent root (`<dir>/graft/workspace.json`). */
export function workspacePath(root: string, override?: string): string {
  return join(contextDirFor(root, override), WORKSPACE_FILE);
}

/** Read the workspace index, or null when the parent has none (not a workspace,
 * or unparseable/foreign json — treated the same as absent). */
export function readWorkspace(root: string, override?: string): WorkspaceV1 | null {
  const path = workspacePath(root, override);
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<WorkspaceV1>;
    if (parsed.version !== 1 || !Array.isArray(parsed.children)) return null;
    // knowledgeRepos: read from committed .trail/knowledge-repos.json first,
    // fall back to workspace.json for backward compatibility.
    const knowledgeRepos = readKnowledgeRepos(root).length > 0
      ? readKnowledgeRepos(root)
      : Array.isArray(parsed.knowledgeRepos) ? parsed.knowledgeRepos.map(String) : undefined;
    return {
      version: 1,
      children: parsed.children.map(String),
      excludeFromDiscovery: Array.isArray(parsed.excludeFromDiscovery)
        ? parsed.excludeFromDiscovery.map(String)
        : undefined,
      knowledgeRepos,
    };
  } catch {
    return null;
  }
}

/** Write the workspace index, sorting children for a stable, minimal git diff.
 * Preserves `excludeFromDiscovery` across rebuilds. */
export function writeWorkspace(root: string, ws: WorkspaceV1, override?: string): string {
  const dir = contextDirFor(root, override);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, WORKSPACE_FILE);
  const sorted: WorkspaceV1 = { version: 1, children: [...ws.children].sort() };
  if (ws.excludeFromDiscovery && ws.excludeFromDiscovery.length > 0)
    sorted.excludeFromDiscovery = [...ws.excludeFromDiscovery].sort();
  if (ws.knowledgeRepos && ws.knowledgeRepos.length > 0)
    sorted.knowledgeRepos = [...ws.knowledgeRepos];
  writeFileSync(path, JSON.stringify(sorted, null, 2) + "\n");
  return path;
}

/** A parent is a workspace BUILD target when it has no own `.git` and ≥2 git
 * children — or it was already split (a `workspace.json` is present). The
 * no-own-`.git` guard keeps a normal repo with git submodules from being
 * mistaken for a workspace. */
/**
 * Walk up from `dir` to find the nearest directory with knowledgeRepos configured
 * (.trail/knowledge-repos.json). Works for repos, workspaces, and plain folders.
 * Falls back to the first workspace found if none has knowledgeRepos.
 */
export function findWorkspaceRoot(dir: string): string | null {
  let current = resolve(dir);
  let firstWorkspace: string | null = null;
  for (let i = 0; i < 8; i++) {
    // Check for committed knowledge-repos.json first (works in any git repo).
    if (readKnowledgeRepos(current).length > 0) return current;
    const ws = readWorkspace(current);
    if (ws) {
      if (!firstWorkspace) firstWorkspace = current;
      if (ws.knowledgeRepos && ws.knowledgeRepos.length > 0) return current;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return firstWorkspace;
}

export function isWorkspaceBuildRoot(root: string, override?: string): boolean {
  if (readWorkspace(root, override)) return true;
  if (existsSync(join(root, ".git"))) return false;
  return discoverWorkspaceChildren(root).length >= 2;
}

/** True when the parent has a mega-graph from an older single-graph build
 * (`graft/.graph/wiring.json`) — the thing a workspace build migrates away. */
export function hasMegaGraph(root: string, override?: string): boolean {
  return existsSync(wiringPath(contextDirFor(root, override)));
}

/** The EXACT split warning printed once, when a mega-graph parent is first
 * built as a workspace. Templated on the child list so it names the real repos. */
export function migrationNote(children: string[]): string {
  const dirs = children.map((c) => `${c}/graft/`).join(", ");
  return (
    `⚠ this folder contains ${children.length} separate git repos — splitting: ` +
    `each repo now gets its own committable graft/ (${dirs}); the combined graph ` +
    `here is replaced by a workspace index. Queries from here now search all repos, fairly.`
  );
}

/** Remove the parent's entire `graft/` tree — the mega-graph, its `.cache`, and
 * any stale cards — so after `writeWorkspace` the parent holds ONLY
 * workspace.json. Child graphs live in sibling `<child>/graft/`, never under
 * this dir, so they are untouched. */
export function clearParentGraft(root: string, override?: string): void {
  rmSync(contextDirFor(root, override), { recursive: true, force: true });
}

export interface LoadedChild {
  child: string;
  graph: GraphV1;
}

export interface WorkspaceGraphs {
  /** Children (from workspace.json when present, else discovered) that have a
   * built graph, in sorted child order. */
  loaded: LoadedChild[];
  /** Listed children with no built graph yet — surfaced, never silently skipped. */
  missing: string[];
}

/** Los hijos de un workspace: los de `workspace.json` cuando existe, si no la
 * discovery viva de git-children (un workspace aún sin construir). */
function workspaceChildList(root: string, override?: string): string[] {
  const ws = readWorkspace(root, override);
  return (ws ? ws.children : discoverWorkspaceChildren(root)).slice().sort();
}

/** Carga el grafo de cada hijo vía `loadGraphCached`. Un hijo sin grafo construido
 * se cuenta en `missing`, no se descarta. */
export function loadWorkspaceGraphs(root: string, override?: string): WorkspaceGraphs {
  const loaded: LoadedChild[] = [];
  const missing: string[] = [];
  for (const child of workspaceChildList(root, override)) {
    const graph = loadGraphCached(contextDirFor(join(root, child)));
    if (graph) loaded.push({ child, graph });
    else missing.push(child);
  }
  return { loaded, missing };
}

// ── Worktrees enlazados dentro de un hijo ─────────────────────────────────────

/** Carpeta donde el harness (y el README) crea los worktrees de un repo. */
const WORKTREES_DIR = ".worktrees";

/** ¿`dir/.git` es un ARCHIVO (puntero a un worktree enlazado)? Mismo criterio que
 * `scopes.ts` usa para no contar un worktree como repo independiente. */
function isLinkedWorktreeDir(dir: string): boolean {
  try {
    return statSync(join(dir, ".git")).isFile();
  } catch {
    return false;
  }
}

/** Un worktree enlazado de un hijo, con el resto del path como sub-prefijo. */
export interface WorktreeInScope {
  /** Path del worktree relativo al workspace: `backend/.worktrees/feature-x`. */
  child: string;
  /** Resto del `in` DENTRO del worktree (el grafo del worktree se enraiza ahí). */
  subpath?: string;
}

/**
 * Resuelve un `in` que apunta DENTRO de un worktree enlazado de un hijo conocido
 * — `<hijo>/.worktrees/<rama>` y cualquier cosa debajo — a ese worktree, o null
 * cuando no lo es (que es el caso común y no un error).
 *
 * Un worktree no es un hijo del workspace (comparte repo con su checkout
 * principal), así que sin esto el `in` no matchea ningún hijo y la consulta
 * responde "no workspace repo". El path puede venir relativo al workspace o
 * absoluto; se acepta también la ruta del worktree sin sub-prefijo.
 */
export function resolveWorktreeIn(
  root: string,
  inArg: string,
  override?: string,
): WorktreeInScope | null {
  const absRoot = resolve(root);
  // Absoluto → relativo al workspace (solo si está adentro); si no, no matchea.
  // La comparación es posix a ambos lados porque `normalizePathPrefix` ya convirtió
  // el `in`, y en Windows `resolve()` devuelve separadores nativos.
  let normalized = normalizePathPrefix(inArg);
  if (isAbsolute(inArg)) {
    const absRootPosix = normalizePathPrefix(absRoot);
    if (!normalized.startsWith(`${absRootPosix}/`)) return null;
    normalized = normalizePathPrefix(relativePath(absRoot, inArg));
  }
  if (!normalized || !normalized.includes(`/${WORKTREES_DIR}/`)) return null;

  const child = workspaceChildList(root, override)
    .filter((c) => normalized === c || normalized.startsWith(`${c}/`))
    .sort((a, b) => b.length - a.length)[0];
  if (!child) return null;

  const segments = normalized.slice(child.length + 1).split("/");
  // `<hijo>/.worktrees/<rama>` — dos segmentos como mínimo; `.worktrees` solo no es
  // un worktree, y un nombre con `/` de más pertenece al sub-prefijo.
  if (segments[0] !== WORKTREES_DIR || segments.length < 2 || !segments[1]) return null;
  const wtRel = `${child}/${WORKTREES_DIR}/${segments[1]}`;
  if (!isLinkedWorktreeDir(join(absRoot, wtRel))) return null;
  return { child: wtRel, subpath: segments.slice(2).join("/") || undefined };
}

/** `loadWorkspaceGraphs` más el worktree que nombra `inArg`, con el `in` ya
 * normalizado contra la lista de hijos (absoluto → relativo). El grafo del
 * worktree lo siembra/refresca el gate de la query (`ensureFreshWorktreeIn`);
 * acá solo se lee, y si aún no existe se suma a `missing` para que la respuesta
 * lo diga en vez de inventar cero resultados. */
export function workspaceGraphsForIn(
  root: string,
  override: string | undefined,
  inArg: string | undefined,
): { graphs: WorkspaceGraphs; in: string | undefined } {
  const graphs = loadWorkspaceGraphs(root, override);
  if (!inArg) return { graphs, in: inArg };
  const wt = resolveWorktreeIn(root, inArg, override);
  if (!wt) return { graphs, in: inArg };
  if (!graphs.loaded.some((l) => l.child === wt.child) && !graphs.missing.includes(wt.child)) {
    const graph = loadGraphCached(contextDirFor(join(resolve(root), wt.child)));
    if (graph) {
      graphs.loaded.push({ child: wt.child, graph });
      graphs.loaded.sort((a, b) => a.child.localeCompare(b.child));
    } else {
      graphs.missing.push(wt.child);
    }
  }
  return { graphs, in: wt.subpath ? `${wt.child}/${wt.subpath}` : wt.child };
}

/** "2 of 3 workspace repos have graphs; run graft build to cover repoC" — the
 * coverage line federated commands append when some listed child is unbuilt.
 * Empty string when every child has a graph. */
export function coverageNote(g: WorkspaceGraphs): string {
  if (g.missing.length === 0) return "";
  const total = g.loaded.length + g.missing.length;
  return `${g.loaded.length} of ${total} workspace repos have graphs; run ${cmd("graft build")} to cover ${g.missing.join(", ")}`;
}

// ── Resolvedor único de `in` para las cuatro funciones federadas ──────────────

/** Un hijo al que un valor `in` resuelve, con su sub-prefijo relativo. */
export interface WorkspaceInTarget {
  child: string;
  childIn?: string;
}

/** Resultado de `resolveWorkspaceIn`: éxito con lista de destinos, o error. */
export type WorkspaceInResolution =
  | { ok: true; narrowed: boolean; targets: WorkspaceInTarget[] }
  | { ok: false; message: string };

/**
 * Resuelve `inArg` contra la lista de hijos, aplicando las reglas del change
 * in-uniforme-workspace (D1–D5). Pura: no lee disco.
 *
 * Reglas (en orden):
 *  1. `inArg` vacío / normaliza a cadena vacía → todos los hijos, sin sub-prefijo.
 *  2. `inArg` igual a un hijo, o `inArg` empieza con `<hijo>/` → ese hijo
 *     (el de path más largo si varios coinciden), con el resto como `childIn`.
 *     Coincidencia por segmento, no por prefijo de texto.
 *  3. `inArg` es ancestro de uno o más hijos (algún hijo empieza con `<inArg>/`)
 *     → todos esos hijos, sin sub-prefijo.
 *  4. Ninguna regla → error con texto `no workspace repo matching "<in>" — repos: …`.
 */
export function resolveWorkspaceIn(
  children: readonly string[],
  inArg: string | undefined,
): WorkspaceInResolution {
  // Regla 1: ausente / vacío → todos los hijos
  if (!inArg) {
    return { ok: true, narrowed: false, targets: [...children].map((c) => ({ child: c })) };
  }
  const normalized = normalizePathPrefix(inArg);
  if (!normalized) {
    return { ok: true, narrowed: false, targets: [...children].map((c) => ({ child: c })) };
  }

  const sorted = [...children].sort();

  // Regla 2: hijo exacto o sub-prefijo dentro de un hijo (el más largo gana)
  const childMatch = sorted
    .filter((c) => normalized === c || normalized.startsWith(c + '/'))
    .sort((a, b) => b.length - a.length)[0];
  if (childMatch) {
    const remaining = normalized.slice(childMatch.length).replace(/^\//, '');
    return {
      ok: true,
      narrowed: true,
      targets: [{ child: childMatch, childIn: remaining || undefined }],
    };
  }

  // Regla 3: grupo — `normalized` es ancestro de al menos un hijo
  const groupMatches = sorted.filter((c) => c.startsWith(normalized + '/'));
  if (groupMatches.length > 0) {
    return {
      ok: true,
      narrowed: true,
      targets: groupMatches.map((c) => ({ child: c })),
    };
  }

  // Regla 4: sin coincidencia
  return {
    ok: false,
    message: `no workspace repo matching "${normalized}" — repos: ${sorted.join(', ')}`,
  };
}

/** Un hijo en alcance que tiene grafo cargado, con su sub-prefijo relativo. */
export interface ScopedChild {
  child: string;
  graph: GraphV1;
  childIn?: string;
}

/** Resultado de `scopeWorkspaceGraphs`: hijos cargados en alcance + hijos sin grafo. */
export type ScopedWorkspace =
  | { ok: true; narrowed: boolean; children: ScopedChild[]; missing: string[] }
  | { ok: false; message: string };

/**
 * Aplica `resolveWorkspaceIn` a un `WorkspaceGraphs`. Valida que el sub-prefijo
 * exista en el grafo del hijo único cuando corresponde.
 * `children` = destinos con grafo; `missing` = destinos sin grafo.
 */
export function scopeWorkspaceGraphs(
  wg: WorkspaceGraphs,
  inArg: string | undefined,
): ScopedWorkspace {
  const allChildren = [...wg.loaded.map((l) => l.child), ...wg.missing].sort();
  const resolution = resolveWorkspaceIn(allChildren, inArg);
  if (!resolution.ok) return { ok: false, message: resolution.message };

  const children: ScopedChild[] = [];
  const missing: string[] = [];
  const normalizedIn = inArg ? normalizePathPrefix(inArg) : '';

  for (const target of resolution.targets) {
    const loaded = wg.loaded.find((l) => l.child === target.child);
    if (loaded) {
      // Validar sub-prefijo en el grafo del hijo
      if (target.childIn) {
        if (!loaded.graph.nodes.some((n) => pathUnderPrefix(n.path, target.childIn!))) {
          return {
            ok: false,
            message: `nothing indexed under "${normalizedIn}/" in workspace repo ${target.child}`,
          };
        }
      }
      children.push({ child: target.child, graph: loaded.graph, childIn: target.childIn });
    } else {
      missing.push(target.child);
    }
  }

  return { ok: true, narrowed: resolution.narrowed, children, missing };
}

// ─────────────────────────────────────────────────────────────────────────────


/** Prefix a hit pointer with its child dir so a `path:span` (or concept path
 * list) opens correctly from the parent. Leaves free-text fragments alone. */
function prefixPointer(child: string, pointer: string): string {
  return pointer
    .split(",")
    .map((part) => {
      const t = part.trim();
      if (!t || t.includes(" ")) return part;
      return `${child}/${t}`;
    })
    .join(", ");
}

/** The exact child-relative file owning a lexical symbol hit. File nodes use a
 * bare path; definition hits append `:Lx-Ly`. */
function hitFile(pointer: string): string {
  return pointer.match(/^(.*):L\d+-L\d+$/)?.[1] ?? pointer;
}

export interface FederateAskOptions {
  limit?: number;
  source?: boolean;
  full?: boolean;
  graphRank?: boolean;
  /** Narrow to one child (`repoA`) or a sub-scope within it (`repoA/backend`).
   * A prefix matching NO child throws, listing the repos. */
  in?: string;
  /** @internal File-level child RRF plus an exact workspace baseline top lock. */
  fileTopLock?: boolean;
}

interface ChildRun {
  child: string;
  hits: AskHit[];
  /** The child's top-hit idf-weighted matched share over name+path+body — a
   * RAW, cross-child-comparable magnitude (NOT per-child normalized). */
  coverage: number;
  /** Same, but over name+path ONLY (body dropped) — the match-STRENGTH signal.
   * A body-only incidental collision has `coverageStrong === 0`. */
  coverageStrong: number;
  /** Exact baseline top-hit coverage used only to compute the workspace top lock. */
  baselineCoverage: number;
  baselineCoverageStrong: number;
  /** Present only for the internal file-aware path. */
  ranking?: AskRankingMetadata;
}

// STRONG_FLOOR / HIGH_FLOOR (a child federates if its top hit matched a
// query term in a NAME/PATH field ≥ STRONG_FLOOR, OR its overall name+path+
// body coverage is broad enough to be real even body-only, ≥ HIGH_FLOOR) are
// defined ONCE in `../ask/fuse.js` and imported here. This is now their only
// caller: a share-of-the-query threshold is the best available signal when the
// candidates carry no common score scale, which is the situation across child
// repositories. `rankScopesAndFuse` used to gate on them for the same reason
// and no longer needs to — within one repo the scores are comparable, so a
// weak scope is held back by scoring low rather than by a strength floor.

/**
 * Federated `ask` across a workspace: run each child's own ask pipeline, then
 * fuse ALL the children's scope lists with `fuseScopes` (reciprocal rank). Each
 * child contributes one fusion scope per intra-child scope, labeled
 * `<child>/<scope>` (or just `<child>` for a child's root scope), so a big repo
 * can't drown a small one — rank positions are comparable across repos where
 * raw scores are not.
 *
 * Rank fusion is still right HERE, and only here: each child was scored against
 * its own corpus, so cross-child scores share no scale. Within a single repo
 * that is no longer true — `rankScopesAndFuse` gives every scope the same
 * statistics and the same denominator and combines them by score.
 *
 * Returns a normal `AskResult`; `formatAsk` renders it unchanged, labeling each
 * hit `[<child>/…]` via the standard multi-scope path.
 */
export function federateAsk(
  root: string,
  override: string | undefined,
  query: string,
  opts: FederateAskOptions = {},
): AskResult {
  const { graphs: wg, in: inArg } = workspaceGraphsForIn(root, override, opts.in);
  const limit = opts.limit ?? 8;
  const fileTopLock = opts.fileTopLock ?? true;

  // `--in` uniforme: el resolvedor común valida, normaliza y distribuye el
  // sub-prefijo a cada hijo en alcance.
  const scoped = scopeWorkspaceGraphs(wg, inArg);
  if (!scoped.ok) {
    throw new Error(scoped.message);
  }
  // Bypass de compuerta: solo cuando `in` acota a exactamente UN hijo.
  const bypassGate = scoped.narrowed && scoped.children.length + scoped.missing.length === 1;

  // Pass 1: run each child's ask; keep its hits + RAW top-hit coverage.
  const runs: ChildRun[] = [];
  for (const { child, childIn } of scoped.children) {
    let r: AskResult;
    try {
      // Over-fetch per child so cross-child fusion has enough candidates to
      // rank before the final `limit` slice.
      r = ask(join(root, child), query, {
        limit: Math.max(limit * 4, 20),
        source: opts.source,
        full: opts.full,
        graphRank: opts.graphRank,
        in: childIn,
        // The parent owns the final cross-repo ranking. Selecting inside each
        // child would be undone by fusion and could truncate a hybrid list.
        fileFirst: false,
        fileComplement: fileTopLock,
        includeRankingMetadata: fileTopLock,
      });
    } catch {
      continue; // corrupt child, or a sub-scope --in matching nothing here
    }
    if (r.hits.length === 0) continue;
    const topGroup = r.ranking?.groups[0];
    runs.push({
      child,
      hits: r.hits,
      coverage: topGroup?.coverage ?? r.coverage ?? 0,
      coverageStrong: topGroup?.coverageStrong ?? r.coverageStrong ?? 0,
      baselineCoverage: r.ranking?.baselineCoverage ?? r.coverage ?? 0,
      baselineCoverageStrong:
        r.ranking?.baselineCoverageStrong ?? r.coverageStrong ?? 0,
      ranking: r.ranking,
    });
  }

  // Cross-child participation gate on match STRENGTH, not a lenient ratio.
  // Per-child hit scores are each per-child-normalized (top ~1.0 everywhere),
  // so feeding them to fuseScopes makes its gate vacuous across repos — a junk
  // body-token collision would federate beside another repo's genuine hits.
  // Gate: a child federates iff its top hit matched a query term in a NAME/PATH
  // field (coverageStrong ≥ STRONG_FLOOR — not just an incidental body token)
  // OR its overall coverage is broad enough to be real (≥ HIGH_FLOOR). A
  // body-only collision has coverageStrong 0 and coverage ~0.3 → gated to
  // alsoMatched. Both floors are absolute + scale-invariant (see their docs).
  // The gate is a cross-child FAIRNESS mechanism: it stops a weak body-token
  // collision in one repo from federating beside another repo's genuine hits.
  // An explicit single-child `--in` removes all cross-child competition — the
  // caller has already chosen the scope — so the gate must NOT apply there, or
  // the `also matched: <child> — narrow with --in <child>` hint would lead to an
  // empty result for exactly the weak child it points at. With one child
  // selected, its run survives, matching a standalone child ask. A folder-wide
  // `--in` (several children) still competes, so the gate stays on.
  const gatedOut: { scope: string; bestId: string }[] = [];
  const survivors: ChildRun[] = [];
  const baselineSurvivors: ChildRun[] = [];
  for (const run of runs) {
    const baselineEligible =
      bypassGate ||
      run.baselineCoverageStrong >= STRONG_FLOOR ||
      run.baselineCoverage >= HIGH_FLOOR;
    const fileEligible =
      bypassGate ||
      run.coverageStrong >= STRONG_FLOOR ||
      run.coverage >= HIGH_FLOOR;
    if (baselineEligible) baselineSurvivors.push(run);
    // Distributed file evidence may admit a child, but the exact baseline
    // top lock must never resurrect a child that the final stream calls gated
    // out. The production survivor set is therefore the union of both gates;
    // baselineSurvivors remains the strict baseline subset used only to choose the
    // locked pointer.
    if (baselineEligible || fileEligible) survivors.push(run);
    else {
      const best = run.ranking?.groups[0]?.hits[0] ?? run.hits[0];
      gatedOut.push({ scope: run.child, bestId: prefixPointer(run.child, best.pointer) });
    }
  }

  if (fileTopLock) {
    type WorkspaceGroup = {
      key: string;
      child: string;
      hits: AskHit[];
      baselineHits: AskHit[];
    };
    const qualifyHit = (
      child: string,
      hit: AskHit,
      score = hit.score,
      scope = hit.scope ? `${child}/${hit.scope}` : child,
    ): AskHit => ({
      ...hit,
      score,
      scope,
      pointer: prefixPointer(child, hit.pointer),
    });
    const sameHit = (a: AskHit, b: AskHit): boolean =>
      a.kind === b.kind && a.pointer === b.pointer && a.title === b.title;

    // Baseline workspace stream: reproduce the all-span RRF exactly so the
    // final lock owns the same concrete pointer and fused score as the baseline.
    const baselineDocs: ScopedDoc[] = [];
    const baselineBack = new Map<
      string,
      { child: string; group: string; hit: AskHit }
    >();
    for (const run of baselineSurvivors) {
      const entries = run.ranking?.baseline ?? run.hits.map((hit, index) => ({
        group: `singleton:${index}`,
        hit,
      }));
      entries.forEach((entry, index) => {
        // Keep the legacy id shape so equal-score baseline ties remain exact.
        const id = `${run.child} ${index}`;
        const scope = entry.hit.scope
          ? `${run.child}/${entry.hit.scope}`
          : run.child;
        baselineDocs.push({ id, scope, score: entry.hit.score });
        baselineBack.set(id, {
          child: run.child,
          group: `${run.child}\0${entry.group}`,
          hit: entry.hit,
        });
      });
    }
    const baselineFused = fuseScopes(baselineDocs);
    const baselineTopRanked = baselineFused.ranked[0];
    const baselineTopBack = baselineTopRanked
      ? baselineBack.get(baselineTopRanked.id)
      : undefined;
    const baselineTop = baselineTopRanked && baselineTopBack
      ? qualifyHit(
          baselineTopBack.child,
          baselineTopBack.hit,
          baselineTopRanked.score,
          baselineTopRanked.scope,
        )
      : undefined;

    // File-aware workspace stream: exactly one leader per child/file (concepts stay
    // singleton groups) participates in RRF. Span queues remain in a side map
    // and cannot consume reciprocal-rank positions.
    const fileDocs: ScopedDoc[] = [];
    const fileBack = new Map<string, WorkspaceGroup>();
    for (const run of survivors) {
      const groups = run.ranking?.groups ?? run.hits.map((hit, index) => ({
        key: `singleton:${index}`,
        hits: [hit],
        baselineHits: [hit],
        coverage: 0,
        coverageStrong: 0,
      }));
      groups.forEach((group, index) => {
        const leader = group.hits[0];
        if (!leader) return;
        const id = `${run.child} file ${String(index).padStart(8, "0")}`;
        const scope = leader.scope ? `${run.child}/${leader.scope}` : run.child;
        const key = `${run.child}\0${group.key}`;
        fileDocs.push({ id, scope, score: leader.score });
        fileBack.set(id, {
          key,
          child: run.child,
          hits: group.hits,
          baselineHits: group.baselineHits ?? [leader],
        });
      });
    }
    const fileFused = fuseScopes(fileDocs);
    const rankedGroups: WorkspaceGroup[] = fileFused.ranked.flatMap((ranked) => {
      const group = fileBack.get(ranked.id);
      if (!group) return [];
      return [{
        ...group,
        // These spans are projections of one cross-child file document. Keep
        // their public score on that same RRF scale; child-local tail scores are
        // not comparable after workspace fusion and downstream re-sorting would
        // otherwise silently undo the file ordering.
        hits: group.hits.map((hit) =>
          qualifyHit(
            group.child,
            hit,
            ranked.score,
            hit.scope ? `${group.child}/${hit.scope}` : group.child,
          ),
        ),
        baselineHits: group.baselineHits.map((hit) => qualifyHit(group.child, hit)),
      }];
    });

    let projectedGroups = rankedGroups;
    if (baselineTop && baselineTopBack) {
      const key = baselineTopBack.group;
      const existing = rankedGroups.find((group) => group.key === key);
      const baselineQueue = existing?.baselineHits ?? [baselineTop];
      const projectedScore = existing?.hits[0]?.score ?? baselineTop.score;
      const locked: WorkspaceGroup = existing
        ? {
            ...existing,
            hits: [
              baselineTop,
              ...baselineQueue
                .filter((hit) => !sameHit(hit, baselineTop))
                .map((hit) => ({ ...hit, score: projectedScore })),
            ],
          }
        : {
            key,
            child: baselineTopBack.child,
            hits: [baselineTop],
            baselineHits: [baselineTop],
          };
      projectedGroups = [
        locked,
        ...rankedGroups.filter((group) => group.key !== key),
      ];
    }

    const hits = roundRobinQueues(
      projectedGroups.map((group) => group.hits),
      limit,
    );
    const unmatched = [...fileFused.alsoMatched, ...gatedOut];
    const note = coverageNote(wg);
    const result: AskResult = {
      query,
      mode: hits.length ? "lexical" : "empty",
      hits,
    };
    if (hits.length) {
      const lockedScope = baselineTop?.scope;
      const federated = [
        ...new Set([
          ...(lockedScope ? [lockedScope] : []),
          ...fileFused.federated,
        ]),
      ];
      const federatedSet = new Set(federated);
      result.scopes = {
        federated,
        alsoMatched: unmatched.filter((match) => !federatedSet.has(match.scope)),
      };
    } else {
      result.note = `no matching nodes across ${wg.loaded.length} workspace repo(s) — try different words, or \`${cmd("graft build")}\` at a child`;
    }
    if (hits.length === 0 && note) result.note = result.note ? `${result.note}\n${note}` : note;
    return result;
  }

  // Fuse the survivors' scope lists (within-child fusion is left untouched —
  // each child already ran its own per-scope RRF).
  const docs: ScopedDoc[] = [];
  const back = new Map<string, { child: string; hit: AskHit }>();
  for (const { child, hits } of survivors) {
    hits.forEach((hit, i) => {
      const scope = hit.scope ? `${child}/${hit.scope}` : child;
      const id = `${child} ${i}`;
      docs.push({ id, scope, score: hit.score });
      back.set(id, { child, hit });
    });
  }

  const fused = fuseScopes(docs);
  const rankedHits = fused.ranked.map((rd) => {
    const { child, hit } = back.get(rd.id)!;
    const value: AskHit = {
      ...hit,
      score: rd.score,
      scope: rd.scope,
      pointer: prefixPointer(child, hit.pointer),
    };
    return {
      // Lexical symbols share a file queue. Concepts and structural neighbours
      // remain singleton partitions, so this lexical selection layer cannot
      // reorder `who calls` / `dependencies of` answers.
      group: hit.kind === "symbol"
        ? `file:${child}/${hitFile(hit.pointer)}`
        : `singleton:${child}:${rd.id}`,
      value,
    };
  });
  const hits = fileFirstRoundRobin(rankedHits, limit);

  const alsoMatched = [...fused.alsoMatched, ...gatedOut];
  const note = coverageNote(wg);
  const result: AskResult = { query, mode: hits.length ? "lexical" : "empty", hits };
  if (hits.length) {
    const federated = fused.federated.length ? fused.federated : [...new Set(hits.map((h) => h.scope!))];
    result.scopes = { federated, alsoMatched };
  } else {
    result.note = `no matching nodes across ${wg.loaded.length} workspace repo(s) — try different words, or \`${cmd("graft build")}\` at a child`;
  }
  if (hits.length === 0 && note) result.note = result.note ? `${result.note}\n${note}` : note;
  return result;
}

/** Merge every child's `GrepResult` into one, prefixing group paths with the
 * child dir and re-sorting by coupling (inDegree desc, path asc) across repos.
 * In-degree stays each child's own — it comes from that child's graph.
 *
 * `in` narrows exactly like the other federated commands (`resolveWorkspaceIn`
 * — one child plus a child-relative subpath, or a folder of children), so
 * `find_all` no longer reads every repo while ignoring the scope it was given.
 * A child with nothing indexed under the subpath is skipped, never fatal. */
export function federateGrep(
  root: string,
  override: string | undefined,
  pattern: string,
  opts: { ignoreCase?: boolean; fixed?: boolean; in?: string; maxHits?: number } = {},
): { result: GrepResult; coverage: string } {
  const { graphs: wg, in: inArg } = workspaceGraphsForIn(root, override, opts.in);

  const scoped = scopeWorkspaceGraphs(wg, inArg);
  if (!scoped.ok) {
    throw new Error(scoped.message);
  }

  const groups: GrepGroup[] = [];
  let filesSearched = 0;
  let totalHits = 0;
  const truncated = { files: 0, hits: 0 };
  let savedFiles = 0;
  let savedChars = 0;

  for (const { child, graph, childIn } of scoped.children) {
    const r = grepGraph(graph, join(root, child), pattern, {
      ignoreCase: opts.ignoreCase,
      fixed: opts.fixed,
      in: childIn,
      maxHits: opts.maxHits,
    });
    filesSearched += r.filesSearched;
    totalHits += r.totalHits;
    truncated.files += r.truncated.files;
    truncated.hits += r.truncated.hits;
    if (r.saved) {
      savedFiles += r.saved.files;
      savedChars += r.saved.baselineChars;
    }
    for (const g of r.groups) {
      groups.push({
        ...g,
        path: `${child}/${g.path}`,
        symbol: g.symbol ? { ...g.symbol, path: `${child}/${g.symbol.path}` } : null,
      });
    }
  }

  groups.sort((a, b) => b.inDegree - a.inDegree || a.path.localeCompare(b.path));
  // Each child capped itself at `maxHits`; that still lets a workspace answer
  // grow to children × maxHits (29 repos × 300 = ~8,700 hits, 115 KB — issue
  // #18). So the cap is applied again over the MERGED, coupling-ranked list:
  // the kept hits are the most-depended-on ones, and the remainder is counted
  // into truncated.hits rather than silently dropped.
  let keptGroups = groups;
  let keptHits = totalHits;
  if (opts.maxHits !== undefined) {
    keptGroups = [];
    let budget = opts.maxHits;
    for (const g of groups) {
      if (budget >= g.hits.length) {
        keptGroups.push(g);
        budget -= g.hits.length;
        continue;
      }
      if (budget > 0) keptGroups.push({ ...g, hits: g.hits.slice(0, budget) });
      budget = 0;
    }
    keptHits = keptGroups.reduce((n, g) => n + g.hits.length, 0);
    truncated.hits += totalHits - keptHits;
  }
  const saved: Savings | undefined = savedChars > 0 ? { files: savedFiles, baselineChars: savedChars } : undefined;
  const result: GrepResult = { pattern, filesSearched, totalHits: keptHits, groups: keptGroups, truncated, saved };
  return { result, coverage: coverageNote(wg) };
}

/** One `graft map` section per child (each child's own map, budget split evenly
 * across the loaded children), joined under `<child>/` headers. */
export function federateMap(
  root: string,
  override: string | undefined,
  opts: { maxDirs?: number } = {},
): string {
  const wg = loadWorkspaceGraphs(root, override);
  const perChild = opts.maxDirs !== undefined && wg.loaded.length > 0
    ? Math.max(1, Math.floor(opts.maxDirs / wg.loaded.length))
    : undefined;

  const sections = wg.loaded.map(({ child, graph }) => {
    const map = buildRepoMap(graph, perChild !== undefined ? { maxDirs: perChild } : {});
    return `## ${child}/\n${formatRepoMap(map).trimEnd()}`;
  });
  const head = `workspace map — ${wg.loaded.length} repo(s)`;
  const parts = [head, "", sections.join("\n\n")];
  const cov = coverageNote(wg);
  if (cov) parts.push("", cov);
  return parts.join("\n") + "\n";
}

/** Per-child drift status. `ok` is false when any BUILT child is stale — an
 * unbuilt child is surfaced (coverage), never a failure. */
export async function federateCheck(
  root: string,
  override?: string,
): Promise<{ text: string; ok: boolean }> {
  const wg = loadWorkspaceGraphs(root, override);
  const lines = [`workspace check — ${wg.loaded.length + wg.missing.length} repo(s)`, ""];
  let ok = true;
  for (const { child } of wg.loaded) {
    const g = await checkGraph(join(root, child));
    if (g.ok) {
      lines.push(`${child}/: OK`);
    } else {
      ok = false;
      const bits: string[] = [];
      if (g.added.length) bits.push(`${g.added.length} added`);
      if (g.removed.length) bits.push(`${g.removed.length} removed`);
      if (g.changed.length) bits.push(`${g.changed.length} changed`);
      if (g.stale.length) bits.push(`${g.stale.length} stale`);
      lines.push(`${child}/: STALE (${bits.join(", ")})`);
    }
  }
  for (const child of wg.missing) lines.push(`${child}/: not built (run ${cmd("graft build")})`);
  const cov = coverageNote(wg);
  if (cov) lines.push("", cov);
  return { text: lines.join("\n") + "\n", ok };
}

/** Resolve a symbol across every child, grouped per child. Reuses the shared
 * traverse-cli formatters so each block reads exactly like `graft callers`.
 *
 * `in` goes through `resolveWorkspaceIn`: the child-relative remainder is what
 * each child's `resolveSymbol` sees, and a child missing that sub-path is
 * skipped rather than throwing `nothing indexed` and aborting the call. */
export function federateCallers(
  root: string,
  override: string | undefined,
  symbol: string,
  opts: { direction?: Direction; depth?: number; in?: string } = {},
): { text: string; found: boolean } {
  const { graphs: wg, in: inArg } = workspaceGraphsForIn(root, override, opts.in);
  const direction: Direction = opts.direction ?? "in";
  const depth = opts.depth && opts.depth >= 1 ? Math.floor(opts.depth) : 1;
  const showDepth = depth > 1;

  const scoped = scopeWorkspaceGraphs(wg, inArg);
  if (!scoped.ok) {
    return { text: scoped.message, found: false };
  }

  const blocks: string[] = [];
  let found = false;
  for (const { child, graph, childIn } of scoped.children) {
    const matches = resolveSymbol(graph, symbol, childIn ? { in: childIn } : {});
    if (matches.length === 0) continue;
    found = true;
    const results = matches.map((m) => ({ symbol: m, hits: edgeWalk(graph, m, direction, depth) }));
    const lines = [`## ${child}/`];
    for (const { symbol: sym, hits } of results) {
      lines.push(headerOf(sym));
      if (hits.length === 0) lines.push(looseNoteFor(direction, sym.name, matches.length));
      else for (const h of hits) lines.push(hitLine(direction, h, showDepth));
    }
    const body = lines.join("\n");
    blocks.push(withSavings(body, callersSavings(graph, results)));
  }

  const cov = coverageNote(wg);
  if (!found) {
    const inScope = scoped.children.length + scoped.missing.length;
    const base = `no symbol "${symbol}" in any of the ${inScope} workspace repo(s) — check spelling or run ${cmd("graft build")}`;
    return { text: cov ? `${base}\n${cov}` : base, found: false };
  }
  let text = blocks.join("\n\n");
  return { text, found: true };
}

/**
 * Split a parent into a workspace: build each git child (via the supplied
 * `buildChild` callback, so this stays free of any engine/LLM dependency),
 * then REPLACE the parent's `graft/` with just `workspace.json`. `onStart`
 * fires once — before any child is built — carrying whether this build is a
 * mega-graph migration, so the caller can print the one-time split warning
 * first, exactly as the spec requires.
 *
 * The child build writes into `<child>/graft/` and is byte-identical to
 * building that child standalone (`buildChild` is just `buildGraph(childDir)`),
 * because nothing about the parent path enters the child's build.
 */
export async function splitWorkspace(
  root: string,
  override: string | undefined,
  buildChild: (childDir: string, childName: string) => Promise<void>,
  onStart?: (info: { children: string[]; migrated: boolean }) => void,
): Promise<{ children: string[]; migrated: boolean }> {
  // Preserve user-configured exclusions across rebuilds.
  const existing = readWorkspace(root, override);
  const excluded = existing?.excludeFromDiscovery ?? [];
  // Match exact name OR prefix (e.g. "Biometria" excludes "Biometria/frontend")
  const isExcluded = (child: string) =>
    excluded.some((e) => child === e || child.startsWith(`${e}/`));
  const discovered = discoverWorkspaceChildren(root)
    .filter((c) => !isExcluded(c))
    .sort();
  const migrated = hasMegaGraph(root, override);
  onStart?.({ children: discovered, migrated });
  for (const child of discovered) await buildChild(join(root, child), child);
  clearParentGraft(root, override);
  writeWorkspace(root, { version: 1, children: discovered, excludeFromDiscovery: existing?.excludeFromDiscovery }, override);
  return { children: discovered, migrated };
}

export { formatGrepResult, zeroHitNote };

/**
 * Federated semantic search across workspace children.
 *
 * Uses `embeddingsDbPath(contextDirFor(<root>/<child>))` — the same location
 * where `trail build` writes the index — so it works for both trail-layout
 * repos (`.trail/cache/.cache/embeddings.db`) and legacy graft-layout repos
 * (`graft/.cache/embeddings.db`).
 *
 * `inScope` narrows exactly like every other federated tool — it goes through
 * `resolveWorkspaceIn`: a child path plus an optional child-relative subpath,
 * or a folder that holds children. The subpath filters hits by segment-aware
 * prefix; an `in` naming nothing is `isError: true`.
 *
 * Errors (missing index, failed search) are reported, not swallowed.
 */
export interface SemanticFederation {
  /** Single-channel rendering (MCP has only text): hits, coverage, failures. */
  text: string;
  isError: boolean;
  /** The hits block — or the one line explaining why there is no hit list. */
  answer: string;
  /** Coverage lines: selected children that have no index. */
  notes: string[];
  /** Per-child failures. Diagnostics, never counted as results. */
  errors: string[];
  /** Hits kept after `limit`; 0 means nothing matched. */
  found: number;
}

export async function federateSemantic(
  root: string,
  override: string | undefined,
  query: string,
  limit: number,
  inScope?: string,
): Promise<SemanticFederation> {
  const { graphs: wg, in: inArg } = workspaceGraphsForIn(root, override, inScope);

  // ── Resolve scope from `in` using the shared resolver ───────────────────
  const scoped = scopeWorkspaceGraphs(wg, inArg);
  if (!scoped.ok) {
    return { text: scoped.message, isError: true, answer: scoped.message, notes: [], errors: [], found: 0 };
  }
  // Children in scope (loaded + missing), sorted for determinism
  const selectedChildren = [...scoped.children.map((c) => c.child), ...scoped.missing].sort();
  // sub-prefijo relativo al hijo único cuando `in` apunta dentro de él
  const subpath = scoped.children.find((c) => c.childIn !== undefined)?.childIn;

  // ── Classify children by index presence ───────────────────────────────────
  const noIndex: string[] = [];
  const withIndex: string[] = [];
  for (const child of selectedChildren) {
    const dbPath = join(contextDirFor(join(root, child)), CACHE_DIR, 'embeddings.db');
    if (existsSync(dbPath)) withIndex.push(child);
    else noIndex.push(child);
  }

  if (withIndex.length === 0) {
    const diagnosis = `0 of ${selectedChildren.length} workspace repos have a semantic index; run trail build to cover ${selectedChildren.join(', ')}`;
    return { text: diagnosis, isError: true, answer: diagnosis, notes: [], errors: [], found: 0 };
  }

  // ── Search each indexed child ──────────────────────────────────────────────
  interface Hit {
    child: string;
    node_id: string;
    file_path: string;
    symbol: string;
    score: number;
    snippet: string;
  }

  const allHits: Hit[] = [];
  const failLines: string[] = [];
  let successCount = 0;
  const k = subpath !== undefined ? limit * 10 : limit * 2;

  for (const child of withIndex) {
    const dbPath = join(contextDirFor(join(root, child)), CACHE_DIR, 'embeddings.db');
    try {
      const hits = await searchSemantic(query, dbPath, k);
      successCount++;
      for (const h of hits) {
        if (
          subpath !== undefined &&
          h.file_path !== subpath &&
          !h.file_path.startsWith(subpath + '/')
        ) {
          continue;
        }
        allHits.push({
          child,
          node_id: h.node_id,
          file_path: `[${child}/]${h.file_path}`,
          symbol: h.symbol,
          score: h.score,
          snippet: h.snippet,
        });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      failLines.push(`semantic search failed in ${child}: ${msg.split('\n')[0]}`);
    }
  }

  // ── Compose response ───────────────────────────────────────────────────────
  const coverageLine =
    noIndex.length > 0
      ? `${withIndex.length} of ${selectedChildren.length} workspace repos have a semantic index; run trail build to cover ${noIndex.join(', ')}`
      : undefined;
  const extraLines: string[] = [...(coverageLine ? [coverageLine] : []), ...failLines];

  const isError = successCount === 0;

  allHits.sort((a, b) => b.score - a.score);
  const top = allHits.slice(0, limit);

  const hitText =
    top.length > 0
      ? top
          .map((h, i) => `${i + 1}. ${h.file_path} · ${h.symbol}  (score: ${h.score})\n   ${h.snippet}`)
          .join('\n\n')
      : 'no semantic matches found across workspace children';

  const text =
    extraLines.length > 0 ? `${hitText}\n\n${extraLines.join('\n')}` : hitText;

  return {
    text,
    isError,
    answer: hitText,
    notes: coverageLine ? [coverageLine] : [],
    errors: failLines,
    found: top.length,
  };
}
