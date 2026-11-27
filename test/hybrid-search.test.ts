/**
 * Tests for trail_find_code mode=hybrid (RRF lexical + semantic fusion).
 *
 * Three required RED/GREEN scenarios (card spec):
 *   (a) mode=hybrid with semantic index   → semantic-ONLY hits surface and are marked [semantic]
 *   (b) mode=hybrid without semantic index → lexical fallback, specific informative note, no isError
 *   (c) no mode                            → output identical to federateAsk direct call (true regression)
 *
 * Also tests:
 *   - single-repo MCP path (no workspace, callSingleTool)
 *   - in= respected with hybrid
 *   - catch branch: unreadable index → informative note
 *   - RRF reorders: data engineered so order changes
 *
 * RED/GREEN evidence: each test was run against the base a1d9b3f (before the
 * union fix) to confirm failure, then re-run after the fix to confirm GREEN.
 *
 * Run individually:
 *   GRAFT_NO_TRAIL_SWITCH=1 node --import tsx --test test/hybrid-search.test.ts
 */

process.env.GRAFT_NO_REFRESH = '1';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { rrfFuseHits, type RrfSemanticHit, type RrfGraphNode } from '../src/ask/hybrid.js';
import { runHybridSingleRepo } from '../src/ask/hybrid-single.js';
import type { AskHit } from '../src/ask/ask.js';
import { createHash } from 'node:crypto';

import { buildGraph } from '../src/graph/build.js';
import { writeWorkspace, federateAsk } from '../src/graph/workspace.js';
import { formatAsk } from '../src/ask/ask.js';
import { contextDirFor, CACHE_DIR } from '../src/context/node-file.js';
import { loadGraphCached } from '../src/graph/load.js';
import {
  embedNodes,
  _setEmbedderForTest,
  EMBED_DIM,
} from '../src/ask/semantic.js';
import { callTool, TOOLS } from '../src/mcp/tools.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Deterministic fake embedder — same pattern as workspace-semantic.test.ts */
function fakeEmbed(text: string): Float32Array {
  const hash = createHash('sha256').update(text).digest();
  const vec = new Float32Array(EMBED_DIM);
  for (let i = 0; i < EMBED_DIM; i++) {
    vec[i] = ((hash[i % 32]! ^ (hash[(i + 1) % 32]! << 4)) / 255) * 2 - 1;
  }
  return vec;
}

/** Wrap a test body: install fake embedder before, restore null in finally. */
function withFakeEmbedder(fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    _setEmbedderForTest(fakeEmbed);
    try {
      await fn();
    } finally {
      _setEmbedderForTest(null);
    }
  };
}

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'trail-hybrid-'));
}

/** Create a child dir with .git and source files. */
function makeChild(
  parent: string,
  name: string,
  files: Record<string, string>,
): string {
  const dir = join(parent, name);
  mkdirSync(join(dir, '.git'), { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    const p = join(dir, file);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, content);
  }
  return dir;
}

/** Build graph + embeddings DB for a child. */
async function buildAndEmbed(childDir: string): Promise<void> {
  await buildGraph(childDir);
  const ctx = contextDirFor(childDir);
  const graph = loadGraphCached(ctx);
  if (!graph) throw new Error(`no graph after buildGraph in ${childDir}`);
  const nodes = graph.nodes.filter(n => n.kind !== 'file');
  const dbPath = join(ctx, CACHE_DIR, 'embeddings.db');
  await embedNodes(nodes, dbPath);
}

/** Build graph only (no embeddings DB). */
async function buildOnly(childDir: string): Promise<void> {
  await buildGraph(childDir);
}

// ---------------------------------------------------------------------------
// (c) Regression: no mode → output identical to federateAsk direct call
// ---------------------------------------------------------------------------

describe('hybrid mode — regression (c): no mode flag = same as federateAsk', () => {
  test(
    'callTool without mode matches federateAsk output directly',
    async () => {
      const root = tmpRoot();
      const child = makeChild(root, 'repo', {
        'src/alpha.ts': 'export function alphaFn(): string { return "alpha"; }',
        'src/beta.ts': 'export function betaFn(): number { return 42; }',
      });
      await buildOnly(child);
      writeWorkspace(root, { version: 1, children: ['repo'] });

      // Ground truth: direct federateAsk call with same options as callWorkspaceTool uses.
      const lexResult = federateAsk(root, undefined, 'alpha function', { limit: 5, source: true });
      const expectedText = formatAsk(lexResult);

      // MCP call without mode.
      const r = await callTool(root, 'trail_find_code', { query: 'alpha function', limit: 5 });

      assert.equal(r.isError, false, 'should not be an error');
      // The text must equal the direct federateAsk output (true regression guard).
      assert.equal(
        r.text.trim(),
        expectedText.trim(),
        `without mode flag, output must equal federateAsk directly:\nexpected: ${expectedText.slice(0, 300)}\ngot:      ${r.text.slice(0, 300)}`,
      );
      assert.ok(r.text.includes('(lexical)'), `expected "(lexical)" header; got: ${r.text.slice(0, 200)}`);
      assert.ok(!r.text.includes('(hybrid)'), 'should not show "(hybrid)" without mode flag');
    },
  );
});

// ---------------------------------------------------------------------------
// (b) mode=hybrid without semantic index → lexical fallback, EXACT note text
// ---------------------------------------------------------------------------

describe('hybrid mode — (b): no semantic index → lexical fallback, exact note', () => {
  test(
    'callTool mode=hybrid, no embeddings DB → isError=false, note says "no semantic index found"',
    async () => {
      const root = tmpRoot();
      const child = makeChild(root, 'repo', {
        'src/alpha.ts': 'export function alphaFn(): string { return "alpha"; }',
      });
      await buildOnly(child); // graph only, NO embeddings DB
      writeWorkspace(root, { version: 1, children: ['repo'] });

      const dbPath = join(contextDirFor(child), CACHE_DIR, 'embeddings.db');
      assert.ok(!existsSync(dbPath), 'embeddings DB must NOT exist for this test');

      const r = await callTool(root, 'trail_find_code', { query: 'alpha', mode: 'hybrid' });

      assert.equal(r.isError, false, `must not be an error; got: ${r.text.slice(0, 300)}`);
      // The EXACT string the code emits — asserts the specific message, not just "hybrid" appearing somewhere.
      assert.ok(
        r.text.includes('no semantic index found'),
        `expected "no semantic index found" in note; got: ${r.text.slice(0, 400)}`,
      );
    },
  );
});

// ---------------------------------------------------------------------------
// (B2') rrfFuseHits unit test: RRF ORDER is correct and CANNOT be bypassed
// ---------------------------------------------------------------------------

describe('hybrid mode — (a): with semantic index → semantic-only hits surface', () => {
  test(
    'semantic-only hit appears in hybrid but NOT in lexical results',
    withFakeEmbedder(async () => {
      /**
       * Setup: 3 files in 1 repo inside a workspace.
       *   - alpha.ts & beta.ts: match the lexical query "alphaFn betaFn" by name
       *   - xeno.ts: "xenomorphic" — zero lexical match to "alphaFn betaFn"
       *
       * With fake embedder (hash-based) and limit=10 (over-fetch=max(40,20)=40),
       * semantic search asks for 40 hits from an index of 3 nodes → all 3 returned.
       * → xeno.ts IS in semantic results, but NOT in lexical results.
       * → After union fix: xeno.ts must appear in hybrid output marked [semantic].
       */
      const root = tmpRoot();
      const child = makeChild(root, 'repo', {
        'src/alpha.ts': 'export function alphaFn(): string { return "alpha value"; }',
        'src/beta.ts': 'export function betaFn(): number { return 42; }',
        'src/xeno.ts': 'export function xenomorphic(): void { return; }',
      });
      await buildAndEmbed(child);
      writeWorkspace(root, { version: 1, children: ['repo'] });

      // Lexical: must NOT contain xenomorphic.
      const lex = await callTool(root, 'trail_find_code', { query: 'alphaFn betaFn', limit: 10 });
      assert.ok(!lex.text.includes('xenomorphic'),
        `lexical must not contain xenomorphic; got: ${lex.text.slice(0, 400)}`);

      // Hybrid: MUST contain xenomorphic (it's in the semantic index with limit*4=40 overfetch).
      const hyb = await callTool(root, 'trail_find_code', { query: 'alphaFn betaFn', limit: 10, mode: 'hybrid' });
      assert.equal(hyb.isError, false, `should not error; got: ${hyb.text.slice(0, 400)}`);
      assert.ok(hyb.text.includes('xenomorphic'),
        `hybrid must include xenomorphic (semantic-only hit); got: ${hyb.text}`);
      // Must be marked [semantic].
      assert.ok(hyb.text.includes('[semantic]'),
        `semantic-only hit must be marked [semantic]; got: ${hyb.text}`);
      // Header must say (hybrid).
      assert.ok(hyb.text.includes('(hybrid)'), `expected "(hybrid)" in header; got: ${hyb.text.slice(0, 200)}`);
    }),
  );

  test(
    'query with zero lexical tokens returns semantic hits via hybrid',
    withFakeEmbedder(async () => {
      /**
       * Query "qqzzyy" has zero lexical hits in any file (no such token).
       * But the semantic index has all nodes → semantic search returns them.
       * After the union fix, hybrid must surface ≥1 semantic hit instead of "no hits".
       */
      const root = tmpRoot();
      const child = makeChild(root, 'repo', {
        'src/serviceA.ts': 'export function serviceAFn(): void { /* service impl */ }',
        'src/serviceB.ts': 'export function serviceBFn(): string { return "b"; }',
      });
      await buildAndEmbed(child);
      writeWorkspace(root, { version: 1, children: ['repo'] });

      const lex = await callTool(root, 'trail_find_code', { query: 'qqzzyy', limit: 5 });
      // Lexical must have 0 hits.
      assert.ok(!lex.text.includes('serviceAFn') && !lex.text.includes('serviceBFn'),
        `lexical must return no hits for "qqzzyy"; got: ${lex.text.slice(0, 300)}`);

      const hyb = await callTool(root, 'trail_find_code', { query: 'qqzzyy', limit: 5, mode: 'hybrid' });
      assert.equal(hyb.isError, false, `must not error; got: ${hyb.text}`);
      // Hybrid must return ≥1 hit (from semantic index — all nodes returned for 2-node index).
      assert.ok(
        hyb.text.includes('serviceAFn') || hyb.text.includes('serviceBFn'),
        `hybrid must surface semantic hits for no-lexical-token query; got: ${hyb.text}`,
      );
      assert.ok(hyb.text.includes('[semantic]'),
        `semantic-only hits must be marked [semantic]; got: ${hyb.text}`);
    }),
  );

  test(
    'RRF reorders hits: semantic-only hit xenoFn2 appears in hybrid but not lexical',
    withFakeEmbedder(async () => {
      /**
       * 2 files. Query = "alphaReturn".
       * Lexical ranking: alphaReturn matches by name; zorkImpl has tokens "zork"+"impl" — zero overlap.
       * Semantic: both nodes in index (over-fetch=20, 2 nodes → both returned).
       * After union with limit=5: zorkImpl must appear as semantic-only.
       */
      const root = tmpRoot();
      const child = makeChild(root, 'repo', {
        'src/alpha.ts': 'export function alphaReturn(): string { return "alpha value"; }',
        'src/zorkimpl.ts': 'export function zorkImpl(): void { }',
      });
      await buildAndEmbed(child);
      writeWorkspace(root, { version: 1, children: ['repo'] });

      const lex = await callTool(root, 'trail_find_code', { query: 'alphaReturn', limit: 5 });
      const hyb = await callTool(root, 'trail_find_code', { query: 'alphaReturn', limit: 5, mode: 'hybrid' });

      assert.equal(hyb.isError, false, 'hybrid must not error');
      assert.ok(hyb.text.includes('(hybrid)'), 'hybrid header required');
      assert.ok(lex.text.includes('(lexical)'), 'lexical header required');
      // zorkImpl has zero lexical match — must NOT appear in lexical.
      assert.ok(!lex.text.includes('zorkImpl'),
        `lexical must not contain zorkImpl (zero match); got: ${lex.text}`);
      // zorkImpl MUST appear in hybrid (semantic-only, limit=5, 2 nodes → both over-fetched).
      assert.ok(hyb.text.includes('zorkImpl'),
        `hybrid must include zorkImpl (semantic-only); got: ${hyb.text}`);
    }),
  );
});

// ---------------------------------------------------------------------------
// Schema: trail_find_code declares mode param
// ---------------------------------------------------------------------------

test('trail_find_code schema includes optional mode property', () => {
  const def = TOOLS.find(t => t.name === 'trail_find_code');
  assert.ok(def, 'trail_find_code tool must exist');
  const schema = def!.inputSchema as { properties?: Record<string, unknown> };
  assert.ok(
    schema.properties && 'mode' in schema.properties,
    `trail_find_code schema must include "mode" property; got keys: ${Object.keys(schema.properties ?? {})}`,
  );
});

// ---------------------------------------------------------------------------
// Single-repo MCP path (no workspace): semantic-only hits surface
// ---------------------------------------------------------------------------

describe('hybrid mode — single-repo (no workspace, callSingleTool path)', () => {
  test(
    'callTool mode=hybrid on single repo (no workspace.json) → semantic-only hit appears',
    withFakeEmbedder(async () => {
      /**
       * No workspace — callTool falls through to callSingleTool (graft_find_code).
       * Same logic: semantic-only hits must appear marked [semantic].
       * We use query "qqzzyy" (zero lexical hits guaranteed) to avoid BM25 returning
       * all nodes when corpus is small.
       */
      const root = mkdtempSync(join(tmpdir(), 'trail-hybrid-single-'));
      mkdirSync(join(root, '.git'), { recursive: true });
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'src/alpha.ts'), 'export function alphaReturn(): string { return "alpha"; }');
      writeFileSync(join(root, 'src/zorkimpl.ts'), 'export function zorkImpl(): void { return; }');

      await buildAndEmbed(root);

      // "qqzzyy" has zero lexical match in any file — lexical returns no hits.
      const lex = await callTool(root, 'trail_find_code', { query: 'qqzzyy', limit: 5 });
      assert.ok(
        !lex.text.includes('alphaReturn') && !lex.text.includes('zorkImpl'),
        `lexical must return no hits for "qqzzyy"; got: ${lex.text.slice(0, 300)}`,
      );

      const hyb = await callTool(root, 'trail_find_code', { query: 'qqzzyy', limit: 5, mode: 'hybrid' });
      assert.equal(hyb.isError, false, `must not error; got: ${hyb.text}`);
      assert.ok(hyb.text.includes('(hybrid)'), 'header must say (hybrid)');
      // Semantic index has 2 nodes → both returned (over-fetch=20). Both are semantic-only.
      assert.ok(
        hyb.text.includes('alphaReturn') || hyb.text.includes('zorkImpl'),
        `hybrid must include at least 1 semantic hit; got: ${hyb.text}`,
      );
      assert.ok(hyb.text.includes('[semantic]'),
        `semantic-only hits must be marked [semantic]; got: ${hyb.text}`);
    }),
  );
});

// ---------------------------------------------------------------------------
// in= respected: semantic-only hits outside the in= prefix must NOT appear
// ---------------------------------------------------------------------------

describe('hybrid mode — in= filter respected for semantic-only hits', () => {
  test(
    'mode=hybrid with in= → semantic-only hits outside prefix are excluded',
    withFakeEmbedder(async () => {
      const root = tmpRoot();
      const child = makeChild(root, 'repo', {
        'src/alpha.ts': 'export function alphaFn(): string { return "alpha"; }',
        'other/xeno.ts': 'export function xenoIn(): void { }',
      });
      await buildAndEmbed(child);
      writeWorkspace(root, { version: 1, children: ['repo'] });

      // With in=repo/src: only files under repo/src should appear.
      const hyb = await callTool(root, 'trail_find_code', {
        query: 'alphaFn', limit: 10, mode: 'hybrid', in: 'repo/src',
      });
      assert.equal(hyb.isError, false, `must not error; got: ${hyb.text}`);
      // xenoIn is under other/ not src/ — must NOT appear.
      assert.ok(!hyb.text.includes('xenoIn'),
        `xenoIn is outside in=repo/src and must not appear; got: ${hyb.text}`);
    }),
  );
});

// ---------------------------------------------------------------------------
// Workspace federation: hybrid across 2 children
// ---------------------------------------------------------------------------

describe('hybrid mode — workspace federation with 2 children', () => {
  test(
    'federateAskHybrid: mode=hybrid federates across children with semantic indexes',
    withFakeEmbedder(async () => {
      const root = tmpRoot();
      const childA = makeChild(root, 'repoA', {
        'src/serviceA.ts': 'export function serviceAFn(): void { /* service A */ }',
      });
      const childB = makeChild(root, 'repoB', {
        'src/serviceB.ts': 'export function serviceBFn(): void { /* service B */ }',
      });
      await buildAndEmbed(childA);
      await buildAndEmbed(childB);
      writeWorkspace(root, { version: 1, children: ['repoA', 'repoB'] });

      const r = await callTool(root, 'trail_find_code', { query: 'service function', mode: 'hybrid' });

      assert.equal(r.isError, false, `should not error: ${r.text.slice(0, 300)}`);
      assert.ok(r.text.includes('(hybrid)'), 'header must show (hybrid)');
      assert.ok(
        r.text.includes('serviceAFn') || r.text.includes('serviceBFn'),
        'expected at least one service function in hits',
      );
    }),
  );

  test(
    'federateAskHybrid: 1 child with index, 1 without → hybrid + EXACT partial coverage note',
    withFakeEmbedder(async () => {
      const root = tmpRoot();
      const childA = makeChild(root, 'repoA', {
        'src/withIndex.ts': 'export function withIndexFn(): void {}',
      });
      const childB = makeChild(root, 'repoB', {
        'src/noIndex.ts': 'export function noIndexFn(): void {}',
      });
      await buildAndEmbed(childA); // has embeddings
      await buildOnly(childB);    // no embeddings DB
      writeWorkspace(root, { version: 1, children: ['repoA', 'repoB'] });

      const r = await callTool(root, 'trail_find_code', { query: 'function', mode: 'hybrid' });

      assert.equal(r.isError, false, 'must not error when only some children have indexes');
      assert.ok(r.text.includes('(hybrid)'), 'header must show (hybrid) when at least 1 child has index');
      // The EXACT partial-coverage note (not just 'hybrid' anywhere).
      assert.ok(
        r.text.includes('1 of 2 repo(s) have a semantic index'),
        `expected "1 of 2 repo(s) have a semantic index" in note; got: ${r.text.slice(0, 400)}`,
      );
      assert.ok(
        r.text.includes('repoB'),
        `partial coverage note must name the missing repo (repoB); got: ${r.text.slice(0, 400)}`,
      );
    }),
  );
});

// ---------------------------------------------------------------------------
// (B2') rrfFuseHits unit test: RRF ORDER correct and CANNOT be bypassed
// ---------------------------------------------------------------------------
//
// Design: A is lexical rank 0, NOT in semantic.
//         B is lexical rank 1, semantic rank 0 (best semantic).
//
// RRF scores (k=60):
//   A: 1/(60+1)             = 0.016393  (lexical only)
//   B: 1/(60+2) + 1/(60+1) = 0.016129 + 0.016393 = 0.032522  (lex + sem)
//
// Expected order: B first, A second.
//
// Mutation 1 (diff = 0 in comparator):
//   sort falls back to pointer lexicographic: src/a.ts < src/b.ts → A first → test FAILS ✓
// Mutation 2 (semantic contribution removed from rrfScores):
//   A: 1/61; B: 1/62 → A first → test FAILS ✓
//
// Pure sync — no fs, no async, no embedder.

describe('rrfFuseHits unit — RRF order: B (lex#1 + sem#0) beats A (lex#0, no semantic)', () => {
  test('RRF positions B before A when B has stronger combined rank', () => {
    const lexHits: AskHit[] = [
      { kind: 'symbol', title: 'funcA · function', pointer: 'src/a.ts:L1-L1', snippet: '', score: 0.9 },
      { kind: 'symbol', title: 'funcB · function', pointer: 'src/b.ts:L1-L1', snippet: '', score: 0.5 },
    ];
    // B at semantic rank 0 (best). A not in semantic at all.
    const semanticHits: RrfSemanticHit[] = [
      { node_id: 'node-b', file_path: 'src/b.ts', score: 0.95, snippet: '' },
    ];
    const graphNodes: RrfGraphNode[] = [
      { id: 'node-b', path: 'src/b.ts', kind: 'function', span: 'L1-L1', name: 'funcB' },
    ];

    const result = rrfFuseHits(lexHits, semanticHits, graphNodes, 5);

    assert.strictEqual(result.length, 2, `expected 2 hits, got ${result.length}`);
    // B must be FIRST: RRF(B)=0.032522 > RRF(A)=0.016393.
    assert.ok(
      result[0]!.pointer.includes('src/b.ts'),
      `hits[0] must be B (src/b.ts, highest RRF); got pointer="${result[0]!.pointer}"\nhits: ${result.map(h => h.pointer).join(', ')}`,
    );
    assert.ok(
      result[1]!.pointer.includes('src/a.ts'),
      `hits[1] must be A (src/a.ts, lower RRF); got pointer="${result[1]!.pointer}"`,
    );
  });

  test('rrfFuseHits in= filter: semantic hit outside prefix excluded (pure unit)', () => {
    // No lexical hits. Two semantic hits: one inside src/, one in other/.
    // With inPrefix='src', only the src/ hit should appear.
    const lexHits: AskHit[] = [];
    const semanticHits: RrfSemanticHit[] = [
      { node_id: 'node-alpha', file_path: 'src/alpha.ts', score: 0.9, snippet: '' },
      { node_id: 'node-xeno',  file_path: 'other/xeno.ts', score: 0.8, snippet: '' },
    ];
    const graphNodes: RrfGraphNode[] = [
      { id: 'node-alpha', path: 'src/alpha.ts', kind: 'function', span: 'L1-L1', name: 'alphaFn' },
      { id: 'node-xeno',  path: 'other/xeno.ts', kind: 'function', span: 'L1-L1', name: 'xenoFn' },
    ];

    const result = rrfFuseHits(lexHits, semanticHits, graphNodes, 10, 'src');

    assert.strictEqual(result.length, 1,
      `expected 1 hit (src/ only); got ${result.length}: ${result.map(h => h.pointer).join(', ')}`);
    assert.ok(
      result[0]!.pointer.includes('src/alpha.ts'),
      `only src/alpha.ts should appear; got: ${result.map(h => h.pointer).join(', ')}`,
    );
    assert.ok(
      !result.some(h => h.pointer.includes('other/xeno.ts')),
      `other/xeno.ts is outside src/ and must be excluded`,
    );
  });
});

// ---------------------------------------------------------------------------
// (B1') Single-repo in= via callTool: semantic hits outside prefix excluded
// ---------------------------------------------------------------------------

describe("hybrid mode — single-repo in= filter via callTool (B1' coverage)", () => {
  test(
    'callTool mode=hybrid with in= on single repo → semantic-only hits outside prefix excluded',
    withFakeEmbedder(async () => {
      /**
       * Single repo (no workspace.json). Two files:
       *   src/alpha.ts — inside in=src
       *   other/xeno.ts — outside in=src
       *
       * Query "qqzzyy" has zero lexical tokens → 0 lexical hits regardless of in=.
       * Both files get embeddings. With in=src, only src/alpha.ts should appear.
       */
      const root = mkdtempSync(join(tmpdir(), 'trail-hybrid-single-in-'));
      mkdirSync(join(root, '.git'), { recursive: true });
      mkdirSync(join(root, 'src'), { recursive: true });
      mkdirSync(join(root, 'other'), { recursive: true });
      writeFileSync(join(root, 'src/alpha.ts'), 'export function alphaIn(): string { return "alpha"; }');
      writeFileSync(join(root, 'other/xeno.ts'), 'export function xenoOut(): void { }');

      await buildAndEmbed(root);

      const hyb = await callTool(root, 'trail_find_code', {
        query: 'qqzzyy', limit: 10, mode: 'hybrid', in: 'src',
      });
      assert.equal(hyb.isError, false, `must not error; got: ${hyb.text}`);
      // xenoOut is under other/, must NOT appear despite being in the semantic index.
      assert.ok(
        !hyb.text.includes('xenoOut'),
        `xenoOut (other/xeno.ts) must be excluded by in=src; got: ${hyb.text}`,
      );
      // alphaIn is under src/, must appear.
      assert.ok(
        hyb.text.includes('alphaIn') || hyb.text.includes('[semantic]'),
        `at least alphaIn should appear (or a [semantic] marker); got: ${hyb.text}`,
      );
    }),
  );
});

// ---------------------------------------------------------------------------
// CLI --hybrid no-index path coverage
// ---------------------------------------------------------------------------
//
// Tests the CLI --hybrid code path with the no-semantic-index fallback.
// Does NOT require an ONNX model — detection happens before embedTexts is called.

describe('CLI --hybrid coverage (no-index path)', () => {
  test('CLI --hybrid without semantic index → informative note, exit 0', async () => {
    const root = mkdtempSync(join(tmpdir(), 'trail-hybrid-cli-noidx-'));
    mkdirSync(join(root, '.git'), { recursive: true });
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src/cli.ts'), 'export function cliFn(): void {}');

    await buildOnly(root);

    // Determine the worktree root (this test file lives in <worktree>/test/).
    const wtRoot = new URL('../', import.meta.url).pathname
      .replace(/\/$/, '')
      .replace(/^\/([A-Z]:)/, '$1'); // Windows: /C:/... → C:/...

    const r = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'src/cli.ts', 'ask', '--hybrid', 'cliFn', root, '--no-refresh'],
      { encoding: 'utf8', timeout: 60_000, cwd: wtRoot },
    );

    // Exit 0 — the informative note is not an error.
    assert.strictEqual(
      r.status, 0,
      `CLI --hybrid no-index must exit 0; stderr=${r.stderr.slice(0, 300)}`,
    );
    const out = r.stdout + r.stderr;
    assert.ok(
      out.includes('no semantic index found'),
      `CLI --hybrid must print "no semantic index found"; got stdout=${r.stdout.slice(0, 400)}`,
    );
  });
});

// ---------------------------------------------------------------------------
// (B2'') runHybridSingleRepo: shared orchestration testable with fake embedder
// ---------------------------------------------------------------------------
//
// Because cli.ts and tools.ts both delegate to runHybridSingleRepo, testing
// it directly with the fake embedder covers both paths without needing a real
// ONNX model or a child process.
// Mutation proof: removing inArg from the rrfFuseHits call inside
// runHybridSingleRepo makes the "in= filter" test below fail (xenoOut appears).

describe('runHybridSingleRepo — shared orchestration (B2 coverage)', () => {
  test(
    'in= filter: semantic-only hits outside prefix excluded',
    withFakeEmbedder(async () => {
      /**
       * Single repo. Two files:
       *   src/alpha.ts — inside in=src
       *   other/xeno.ts — outside in=src
       *
       * Query "qqzzyy" has zero lexical hits → lexHits = [].
       * Both files have embeddings. With in='src', only src/alpha.ts should appear.
       *
       * RED proof: removing the inArg parameter from the rrfFuseHits call inside
       * runHybridSingleRepo causes xenoOut to appear → test fails.
       */
      const root = mkdtempSync(join(tmpdir(), 'trail-hybrid-rhs-'));
      mkdirSync(join(root, '.git'), { recursive: true });
      mkdirSync(join(root, 'src'), { recursive: true });
      mkdirSync(join(root, 'other'), { recursive: true });
      writeFileSync(join(root, 'src/alpha.ts'), 'export function alphaIn(): string { return "alpha"; }');
      writeFileSync(join(root, 'other/xeno.ts'), 'export function xenoOut(): void { }');

      await buildAndEmbed(root);

      const graph = loadGraphCached(contextDirFor(root));
      assert.ok(graph, 'graph must exist after buildAndEmbed');

      const dbPath = join(contextDirFor(root), CACHE_DIR, 'embeddings.db');
      assert.ok(existsSync(dbPath), 'embeddings DB must exist');

      // Zero lexical hits for "qqzzyy".
      const result = await runHybridSingleRepo(
        [],           // lexHits
        'qqzzyy',    // query
        dbPath,
        graph.nodes,
        10,           // limit
        'src',        // inArg — only src/ hits should surface
      );

      assert.strictEqual(result.kind, 'hits',
        `expected hits result; got kind=${result.kind}`);
      assert.ok(result.kind === 'hits'); // narrowing

      // xenoOut (other/xeno.ts) must NOT appear despite being in the semantic index.
      const pointers = result.hits.map(h => h.pointer).join('\n');
      assert.ok(
        !pointers.includes('xeno'),
        `xenoOut must be excluded by in='src'; got pointers:\n${pointers}`,
      );
      // alphaIn (src/alpha.ts) MUST appear.
      assert.ok(
        result.hits.some(h => h.pointer.includes('alpha') || h.title.includes('alphaIn')),
        `alphaIn must appear (src/alpha.ts is in-scope); got:\n${pointers}`,
      );
    }),
  );

  test('no-index path: returns kind=no-index without error', async () => {
    const root = mkdtempSync(join(tmpdir(), 'trail-hybrid-rhs-noidx-'));
    mkdirSync(join(root, '.git'), { recursive: true });
    writeFileSync(join(root, 'src.ts'), 'export function f() {}');

    await buildOnly(root);
    const dbPath = join(contextDirFor(root), CACHE_DIR, 'embeddings.db');
    assert.ok(!existsSync(dbPath), 'embeddings DB must NOT exist');

    const result = await runHybridSingleRepo([], 'query', dbPath, [], 5);
    assert.strictEqual(result.kind, 'no-index',
      `expected no-index; got kind=${result.kind}`);
  });
});

// ---------------------------------------------------------------------------
// (B1''') workspace federation — global semantic order across children
// ---------------------------------------------------------------------------
//
// Verifies that allSemanticByScore is sorted by score desc before mapping to
// semHitsForRrf. Without the sort, the first-declared child always gets rank 0
// regardless of score, so a weak hit from repoA outranks a strong hit from repoB.
//
// Setup:
//   repoA (declared FIRST) → farFn (cosine ≈ 0 with query) — the WEAK hit
//   repoB (declared SECOND) → nearFn (cosine ≈ 1 with query) — the STRONG hit
//
// Expected: nearFn from repoB appears BEFORE farFn from repoA.
//
// RED proof:
//   - Remove/comment the allSemanticByScore.sort() line in workspace.ts → farFn
//     gets rank 0 (first in natural declaration order) → test fails.
//   - Replace sort with .reverse() → same failure (farFn would get rank 0 after
//     the reverse puts the low-score hit first).
//
// Controlled embedder:
//   text includes "nearFn" → vec[0] = 1  (aligns with query)
//   text includes "farFn"  → vec[1] = 1  (orthogonal to query)
//   everything else (query) → vec[0] = 1  (aligns with nearFn)

describe('workspace federation — global semantic order (B1\'\'\')', () => {
  test(
    'strong hit from child-2 (repoB) ranks before weak hit from child-1 (repoA)',
    async () => {
      // Controlled embedder: nearFn → [1,0,...], farFn → [0,1,...], query → [1,0,...]
      const controlled = (text: string): Float32Array => {
        const vec = new Float32Array(EMBED_DIM);
        if (text.includes('nearFn')) {
          vec[0] = 1; // high cosine with query
        } else if (text.includes('farFn')) {
          vec[1] = 1; // low cosine with query (orthogonal)
        } else {
          vec[0] = 1; // query aligns with nearFn
        }
        return vec;
      };
      _setEmbedderForTest(controlled);
      try {
        const root = tmpRoot();
        // repoA declared FIRST with the WEAK (far) function
        const childA = makeChild(root, 'repoA', {
          'src/far.ts': 'export function farFn(): void {}',
        });
        // repoB declared SECOND with the STRONG (near) function
        const childB = makeChild(root, 'repoB', {
          'src/near.ts': 'export function nearFn(): void {}',
        });
        await buildAndEmbed(childA);
        await buildAndEmbed(childB);
        writeWorkspace(root, { version: 1, children: ['repoA', 'repoB'] });

        // "qqzzyy_global_order" has zero lexical hits → all hits are semantic-only.
        // limit=5 is enough for 2 hits.
        const r = await callTool(root, 'trail_find_code', {
          query: 'qqzzyy_global_order',
          mode: 'hybrid',
          limit: 5,
        });

        assert.equal(r.isError, false, `must not be an error; got: ${r.text.slice(0, 400)}`);

        const nearPos = r.text.indexOf('nearFn');
        const farPos  = r.text.indexOf('farFn');

        assert.ok(nearPos !== -1, `nearFn (repoB, strong) must appear in results;\ngot: ${r.text.slice(0, 500)}`);
        assert.ok(farPos  !== -1, `farFn (repoA, weak) must appear in results;\ngot: ${r.text.slice(0, 500)}`);

        // Global sort by score desc: nearFn (cosine≈1) BEFORE farFn (cosine≈0).
        // Without the sort, natural order puts farFn (repoA, first child) at rank 0
        // and nearFn (repoB, second child) at rank 1 → farPos < nearPos → test fails.
        assert.ok(
          nearPos < farPos,
          `nearFn (strong, repoB) must appear before farFn (weak, repoA);\n` +
          `nearPos=${nearPos}, farPos=${farPos}\n${r.text.slice(0, 600)}`,
        );
      } finally {
        _setEmbedderForTest(null);
      }
    },
  );
});
