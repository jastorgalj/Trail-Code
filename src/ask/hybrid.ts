/**
 * Shared helper for single-repo hybrid (lexical + semantic RRF) fusion.
 *
 * Extracted so the MCP tool handler (`src/mcp/tools.ts`) and the CLI
 * (`src/cli.ts`) share identical `in=` filtering and materialisation logic
 * rather than duplicating it — the divergence caused the B1 bug (in= not
 * applied to semantic-only hits in those two paths).
 *
 * This module is intentionally separate from `fuse.ts` to avoid a circular
 * import: `fuse.ts` has zero imports, while this module needs `AskHit` from
 * `ask.ts`, which itself imports from `fuse.ts`.
 */

import type { AskHit } from './ask.js';
import { RRF_K } from './fuse.js';

/** Minimal node info needed to materialize a semantic-only AskHit. */
export interface RrfGraphNode {
  id: string;
  path: string;
  kind: string;
  span?: string;
  name: string;
  summary?: string | null;
  signature?: string | null;
  /** Optional scope label propagated to the materialized AskHit (e.g. child repo name). */
  scope?: string;
}

/** Minimal semantic hit descriptor (matches SemanticHit from semantic.ts). */
export interface RrfSemanticHit {
  node_id: string;
  file_path: string;
  score: number;
  snippet: string;
}

/**
 * Fuse lexical and semantic hits via RRF (k={@link RRF_K}) over their UNION.
 *
 * - Semantic hits whose `file_path` falls outside `inPrefix` are dropped
 *   before fusion (same semantics as the lexical `--in` filter).
 * - Semantic-only hits (not already in lexical results) are materialized from
 *   `graphNodes` and marked `[semantic]` in their title.
 * - Returns up to `limit` hits, sorted by descending RRF score.
 *
 * Pure and synchronous — no fs calls. Caller supplies the already-loaded graph nodes.
 */
export function rrfFuseHits(
  lexHits: AskHit[],
  semanticHits: RrfSemanticHit[],
  graphNodes: RrfGraphNode[],
  limit: number,
  inPrefix?: string,
): AskHit[] {
  /** Extract the file path from a pointer (strip `:Lx-Ly` suffix). */
  const hitFileKey = (ptr: string): string =>
    ptr.match(/^(.*):L\d+-L\d+$/)?.[1] ?? ptr;

  // Apply in= filter to semantic hits before fusion.
  // A semantic hit is in-scope iff its file_path equals the prefix exactly
  // or starts with the prefix followed by '/'.
  const filteredSemantic = inPrefix
    ? semanticHits.filter(
        (sh) =>
          sh.file_path === inPrefix ||
          sh.file_path.startsWith(inPrefix + '/'),
      )
    : semanticHits;

  // Build RRF scores (k=60, formula: 1/(k + rank + 1), 0-based ranks).
  const rrfScores = new Map<string, number>();
  for (let rank = 0; rank < lexHits.length; rank++) {
    const key = hitFileKey(lexHits[rank]!.pointer);
    rrfScores.set(key, (rrfScores.get(key) ?? 0) + 1 / (RRF_K + rank + 1));
  }
  for (let rank = 0; rank < filteredSemantic.length; rank++) {
    const key = filteredSemantic[rank]!.file_path;
    rrfScores.set(key, (rrfScores.get(key) ?? 0) + 1 / (RRF_K + rank + 1));
  }

  // Materialize semantic-only hits (file_path NOT already in lexical results).
  const lexicalKeySet = new Set(lexHits.map((h) => hitFileKey(h.pointer)));
  const extraHits: AskHit[] = [];
  for (let rank = 0; rank < filteredSemantic.length; rank++) {
    const sh = filteredSemantic[rank]!;
    if (lexicalKeySet.has(sh.file_path)) continue;
    const node = graphNodes.find((n) => n.id === sh.node_id);
    if (!node) continue;
    const pointer =
      node.kind === 'file' ? node.path : `${node.path}:${node.span}`;
    extraHits.push({
      kind: 'symbol',
      title: `${node.name} · ${node.kind} [semantic]`,
      pointer,
      snippet:
        sh.snippet ||
        node.summary?.split('\n')[0].trim() ||
        node.signature ||
        '',
      score: sh.score,
      ...(node.scope !== undefined ? { scope: node.scope } : {}),
    });
  }

  // Build union, sort by RRF descending (tie-break: pointer lexicographic), slice.
  const union = [...lexHits, ...extraHits];
  return union
    .sort((a, b) => {
      const kA = hitFileKey(a.pointer);
      const kB = hitFileKey(b.pointer);
      const diff = (rrfScores.get(kB) ?? 0) - (rrfScores.get(kA) ?? 0);
      return diff !== 0 ? diff : a.pointer.localeCompare(b.pointer);
    })
    .slice(0, limit);
}
