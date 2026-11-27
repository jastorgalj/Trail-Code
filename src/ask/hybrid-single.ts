/**
 * Shared async orchestration for single-repo hybrid (lexical + semantic RRF).
 *
 * Extracted so both the MCP `callSingleTool` path (`src/mcp/tools.ts`) and
 * the CLI `--hybrid` path (`src/cli.ts`) share identical logic — including
 * the `in=` filter — rather than duplicating it.  Duplication was the root
 * cause of B1' (in= not applied to semantic-only hits in the two paths) and
 * B2'' (CLI --hybrid with index had no testable shared surface).
 *
 * Uses `searchSemantic` which respects `_setEmbedderForTest` — tests can
 * inject a fake embedder without spawning a child process.
 */

import { existsSync } from 'node:fs';
import { searchSemantic } from './semantic.js';
import { rrfFuseHits, type RrfGraphNode, type RrfSemanticHit } from './hybrid.js';
import type { AskHit } from './ask.js';

export type HybridSingleResult =
  | { kind: 'hits'; hits: AskHit[] }
  | { kind: 'no-index' }
  | { kind: 'unreadable' };

/**
 * Core orchestration: lexical hits + semantic search over their UNION via RRF.
 *
 * @param lexHits   - Already-computed lexical hits (over-fetched by caller).
 * @param query     - Original query string (passed to searchSemantic).
 * @param dbPath    - Absolute path to `embeddings.db`.
 * @param graphNodes - Graph nodes for materializing semantic-only hits.
 * @param limit     - Final hit count after RRF fusion.
 * @param inArg     - Optional in= prefix; semantic hits outside it are dropped.
 */
export async function runHybridSingleRepo(
  lexHits: AskHit[],
  query: string,
  dbPath: string,
  graphNodes: RrfGraphNode[],
  limit: number,
  inArg?: string,
): Promise<HybridSingleResult> {
  if (!existsSync(dbPath)) return { kind: 'no-index' };

  let semanticHits: RrfSemanticHit[];
  try {
    semanticHits = await searchSemantic(query, dbPath, Math.max(limit * 4, 20));
  } catch {
    return { kind: 'unreadable' };
  }

  const hits = rrfFuseHits(lexHits, semanticHits, graphNodes, limit, inArg);
  return { kind: 'hits', hits };
}
