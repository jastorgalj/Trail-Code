/**
 * Tests for federated semantic search in workspace mode.
 * Covers federateSemantic (src/graph/workspace.ts) and callWorkspaceTool
 * (src/mcp/tools.ts case graft_search_semantic + descriptions).
 *
 * Pattern: node:test + node:assert/strict + tmpdir workspaces,
 * fake embedder via _setEmbedderForTest (same as test/semantic-search.test.ts).
 *
 * Run with:
 *   GRAFT_NO_TRAIL_SWITCH=1 node --import tsx --test test/workspace-semantic.test.ts
 */

// Disable auto-refresh: we manage graph building manually in each test.
process.env.GRAFT_NO_REFRESH = '1';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { buildGraph } from '../src/graph/build.js';
import { writeWorkspace } from '../src/graph/workspace.js';
import { contextDirFor, CACHE_DIR } from '../src/context/node-file.js';
import { loadGraphCached } from '../src/graph/load.js';
import {
  embedNodes,
  _setEmbedderForTest,
  EMBED_DIM,
} from '../src/ask/semantic.js';
import { callTool, TOOLS } from '../src/mcp/tools.js';
import { mcpInstructions } from '../src/mcp/instructions.js';
import type { NodeV1 } from '../src/graph/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Deterministic fake embedder — same as test/semantic-search.test.ts.
 * Different texts always produce different vectors; the exact query text
 * for a node is [id, signature].join(' '), which makes similarity == 1.0
 * when searched with the same text.
 */
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

/**
 * Returns the exact text that embedNodes uses for a node — matches itself
 * perfectly (cosine similarity == 1.0 when queried with this string).
 */
function nodeQueryText(
  node: Pick<NodeV1, 'id' | 'signature'> & { body_text?: string | null },
): string {
  return [node.id, node.signature ?? '', node.body_text ?? '']
    .filter(Boolean)
    .join(' ');
}

/**
 * Create a child directory with .git/ and optional .trail/learnings/ and
 * source files. Returns the absolute path of the child.
 */
function makeChildDir(
  parent: string,
  name: string,
  files: Record<string, string>,
  { isTrail = false }: { isTrail?: boolean } = {},
): string {
  const dir = join(parent, name);
  mkdirSync(join(dir, '.git'), { recursive: true });
  if (isTrail) mkdirSync(join(dir, '.trail', 'learnings'), { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    const p = join(dir, file);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, content);
  }
  return dir;
}

/**
 * Build graph + embeddings DB for a child.
 * Returns the exact query text that finds the first non-file node.
 */
async function buildAndEmbed(childDir: string): Promise<string> {
  await buildGraph(childDir);
  const ctx = contextDirFor(childDir);
  const graph = loadGraphCached(ctx);
  if (!graph) throw new Error(`no graph after buildGraph in ${childDir}`);
  const nodes = graph.nodes.filter(n => n.kind !== 'file');
  if (nodes.length === 0) throw new Error(`no non-file nodes in ${childDir}`);
  const dbPath = join(ctx, CACHE_DIR, 'embeddings.db');
  await embedNodes(nodes, dbPath);
  return nodeQueryText(nodes[0]!);
}

/** Build graph only (no embeddings DB). */
async function buildOnly(childDir: string): Promise<void> {
  await buildGraph(childDir);
}

/** Create a fresh temporary workspace parent directory. */
function tmpWs(): string {
  return mkdtempSync(join(tmpdir(), 'ws-sem-'));
}

/**
 * rmSync wrapper that swallows EPERM on Windows — better-sqlite3 may hold a
 * file handle briefly after a failed open, preventing immediate deletion.
 */
function safeRmSync(p: string): void {
  try {
    rmSync(p, { recursive: true, force: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EPERM') throw e;
  }
}

// ---------------------------------------------------------------------------
// Scenario: Hijo con layout .trail/cache
// (This is the RED→GREEN test: must FAIL before implementing federateSemantic fix.)
// ---------------------------------------------------------------------------
test(
  'Hijo con layout .trail/cache',
  withFakeEmbedder(async () => {
    const parent = tmpWs();
    try {
      // Both children use trail layout: .trail/learnings/ present →
      // contextDirFor returns .trail/cache (not graft/).
      makeChildDir(
        parent,
        'repoA',
        { 'src/a.ts': 'export function alphaHandler() { return 1; }\n' },
        { isTrail: true },
      );
      makeChildDir(
        parent,
        'repoB',
        { 'b.ts': 'export function betaHandler() { return 2; }\n' },
        { isTrail: true },
      );
      const queryA = await buildAndEmbed(join(parent, 'repoA'));
      await buildAndEmbed(join(parent, 'repoB'));
      writeWorkspace(parent, { version: 1, children: ['repoA', 'repoB'] });

      const r = await callTool(parent, 'trail_search_semantic', {
        query: queryA,
      });
      assert.equal(
        r.isError,
        false,
        `expected isError:false but got: ${r.text}`,
      );
      assert.ok(
        r.text.includes('[repoA/]'),
        `expected hit starting with [repoA/] but got: ${r.text}`,
      );
    } finally {
      safeRmSync(parent);
    }
  }),
);

// ---------------------------------------------------------------------------
// Scenario: Hijo con layout graft heredado
// ---------------------------------------------------------------------------
test(
  'Hijo con layout graft heredado',
  withFakeEmbedder(async () => {
    const parent = tmpWs();
    try {
      // No .trail/learnings/ → contextDirFor returns graft/
      makeChildDir(parent, 'repoA', {
        'a.ts': 'export function alphaHandler() { return 1; }\n',
      });
      makeChildDir(parent, 'repoB', {
        'b.ts': 'export function betaHandler() { return 2; }\n',
      });
      const queryA = await buildAndEmbed(join(parent, 'repoA'));
      await buildAndEmbed(join(parent, 'repoB'));
      writeWorkspace(parent, { version: 1, children: ['repoA', 'repoB'] });

      const r = await callTool(parent, 'trail_search_semantic', {
        query: queryA,
      });
      assert.equal(r.isError, false, `expected isError:false: ${r.text}`);
      assert.ok(
        r.text.includes('[repoA/]'),
        `expected [repoA/] in: ${r.text}`,
      );
    } finally {
      safeRmSync(parent);
    }
  }),
);

// ---------------------------------------------------------------------------
// Scenario: El formato de cada hit no cambia
// ---------------------------------------------------------------------------
test(
  'El formato de cada hit no cambia',
  withFakeEmbedder(async () => {
    const parent = tmpWs();
    try {
      makeChildDir(
        parent,
        'repoA',
        { 'a.ts': 'export function alphaHandler() { return 1; }\n' },
        { isTrail: true },
      );
      const queryA = await buildAndEmbed(join(parent, 'repoA'));
      writeWorkspace(parent, { version: 1, children: ['repoA'] });

      const r = await callTool(parent, 'trail_search_semantic', {
        query: queryA,
      });
      assert.equal(r.isError, false);
      // Format: N. [<child>/]<path> · <symbol>  (score: <number>)
      assert.match(
        r.text,
        /^1\. \[repoA\/\].+ · .+  \(score: [\d.]+\)/m,
        `hit format mismatch: ${r.text}`,
      );
      // Snippet line follows (may be empty string but the newline is present)
      assert.ok(r.text.includes('\n   '), `expected snippet line: ${r.text}`);
    } finally {
      safeRmSync(parent);
    }
  }),
);

// ---------------------------------------------------------------------------
// Scenario: in igual a un hijo
// ---------------------------------------------------------------------------
test(
  'in igual a un hijo',
  withFakeEmbedder(async () => {
    const parent = tmpWs();
    try {
      makeChildDir(parent, 'repoA', {
        'a.ts': 'export function alphaHandler() { return 1; }\n',
      });
      makeChildDir(parent, 'repoB', {
        'b.ts': 'export function betaHandler() { return 2; }\n',
      });
      const queryA = await buildAndEmbed(join(parent, 'repoA'));
      await buildAndEmbed(join(parent, 'repoB'));
      writeWorkspace(parent, { version: 1, children: ['repoA', 'repoB'] });

      // Query for repoA's node but scope to repoB — repoA must not appear.
      const r = await callTool(parent, 'trail_search_semantic', {
        query: queryA,
        in: 'repoB',
      });
      assert.ok(
        !r.text.includes('[repoA/]'),
        `expected no repoA hits with in:repoB but got: ${r.text}`,
      );
    } finally {
      safeRmSync(parent);
    }
  }),
);

// ---------------------------------------------------------------------------
// Scenario: in igual a un grupo de hijos
// ---------------------------------------------------------------------------
test(
  'in igual a un grupo de hijos',
  withFakeEmbedder(async () => {
    const parent = tmpWs();
    try {
      // Three children: grp/one, grp/two, other
      makeChildDir(parent, 'grp/one', {
        'a.ts': 'export function grpOneHandler() { return 1; }\n',
      });
      makeChildDir(parent, 'grp/two', {
        'a.ts': 'export function grpTwoHandler() { return 2; }\n',
      });
      makeChildDir(parent, 'other', {
        'a.ts': 'export function otherHandler() { return 3; }\n',
      });
      const queryOne = await buildAndEmbed(join(parent, 'grp', 'one'));
      await buildAndEmbed(join(parent, 'grp', 'two'));
      await buildAndEmbed(join(parent, 'other'));
      writeWorkspace(parent, {
        version: 1,
        children: ['grp/one', 'grp/two', 'other'],
      });

      // Query for grp/one's node with in:'grp' → only grp/* children.
      const r = await callTool(parent, 'trail_search_semantic', {
        query: queryOne,
        in: 'grp',
      });
      assert.ok(
        !r.text.includes('[other/]'),
        `expected no other/ hits with in:grp but got: ${r.text}`,
      );
      // grp/one or grp/two hits should appear (or at least no other/ hit)
    } finally {
      safeRmSync(parent);
    }
  }),
);

// ---------------------------------------------------------------------------
// Scenario: in con subpath dentro de un hijo
// ---------------------------------------------------------------------------
test(
  'in con subpath dentro de un hijo',
  withFakeEmbedder(async () => {
    const parent = tmpWs();
    try {
      // repoA has src/a.ts, lib/l.ts, and srcx/x.ts; repoB has src/b.ts.
      // srcx/ is intentionally a neighbour of src/ to verify that the
      // subpath filter uses startsWith(subpath + '/'), not startsWith(subpath).
      makeChildDir(
        parent,
        'repoA',
        {
          'src/a.ts': 'export function alphaHandler() { return 1; }\n',
          'lib/l.ts': 'export function libHelper() { return 0; }\n',
          'srcx/x.ts': 'export function xHandler() { return 99; }\n',
        },
        { isTrail: true },
      );
      makeChildDir(
        parent,
        'repoB',
        { 'src/b.ts': 'export function betaHandler() { return 2; }\n' },
        { isTrail: true },
      );
      const queryA = await buildAndEmbed(join(parent, 'repoA'));
      await buildAndEmbed(join(parent, 'repoB'));
      writeWorkspace(parent, { version: 1, children: ['repoA', 'repoB'] });

      // in:'repoA/src' → only repoA, only file_path.startsWith('src/')
      const r = await callTool(parent, 'trail_search_semantic', {
        query: queryA,
        in: 'repoA/src',
      });
      // All hits must be [repoA/]src/...
      const hitLines = r.text
        .split('\n')
        .filter(l => /^\d+\./.test(l));
      for (const line of hitLines) {
        assert.ok(
          line.includes('[repoA/]src/'),
          `hit should be [repoA/]src/... but got: ${line}`,
        );
      }
      // srcx/ must be excluded: startsWith('src/') must NOT match 'srcx/...'
      assert.ok(
        !hitLines.some(l => l.includes('[repoA/]srcx/')),
        `srcx/ should be excluded by in:'repoA/src' filter but got: ${hitLines.join(', ')}`,
      );
    } finally {
      safeRmSync(parent);
    }
  }),
);

// ---------------------------------------------------------------------------
// Scenario: in con subpath sin hits
// ---------------------------------------------------------------------------
test(
  'in con subpath sin hits',
  withFakeEmbedder(async () => {
    const parent = tmpWs();
    try {
      makeChildDir(
        parent,
        'repoA',
        { 'src/a.ts': 'export function alphaHandler() { return 1; }\n' },
        { isTrail: true },
      );
      makeChildDir(
        parent,
        'repoB',
        { 'src/b.ts': 'export function betaHandler() { return 2; }\n' },
        { isTrail: true },
      );
      const queryA = await buildAndEmbed(join(parent, 'repoA'));
      await buildAndEmbed(join(parent, 'repoB'));
      writeWorkspace(parent, { version: 1, children: ['repoA', 'repoB'] });

      // in:'repoA/nada' → subpath 'nada', no file has path under 'nada/'
      const r = await callTool(parent, 'trail_search_semantic', {
        query: queryA,
        in: 'repoA/nada',
      });
      assert.equal(r.isError, false, `expected isError:false: ${r.text}`);
      assert.ok(
        r.text.includes('no semantic matches found across workspace children'),
        `expected no-match text but got: ${r.text}`,
      );
    } finally {
      safeRmSync(parent);
    }
  }),
);

// ---------------------------------------------------------------------------
// Scenario: in que no nombra ningún hijo
// ---------------------------------------------------------------------------
test(
  'in que no nombra ningún hijo',
  withFakeEmbedder(async () => {
    const parent = tmpWs();
    try {
      makeChildDir(parent, 'repoA', {
        'a.ts': 'export function alphaHandler() { return 1; }\n',
      });
      makeChildDir(parent, 'repoB', {
        'b.ts': 'export function betaHandler() { return 2; }\n',
      });
      await buildOnly(join(parent, 'repoA'));
      await buildOnly(join(parent, 'repoB'));
      writeWorkspace(parent, { version: 1, children: ['repoA', 'repoB'] });

      const r = await callTool(parent, 'trail_search_semantic', {
        query: 'anything',
        in: 'nosuch',
      });
      assert.equal(r.isError, true, `expected isError:true: ${r.text}`);
      assert.ok(
        r.text.includes('no workspace repos match "in=nosuch"'),
        `expected match error but got: ${r.text}`,
      );
    } finally {
      safeRmSync(parent);
    }
  }),
);

// ---------------------------------------------------------------------------
// Scenario: in coincide por segmento y no por prefijo de texto
// ---------------------------------------------------------------------------
test(
  'in coincide por segmento y no por prefijo de texto',
  withFakeEmbedder(async () => {
    const parent = tmpWs();
    try {
      makeChildDir(parent, 'repoA', {
        'a.ts': 'export function alphaHandler() { return 1; }\n',
      });
      await buildOnly(join(parent, 'repoA'));
      writeWorkspace(parent, { version: 1, children: ['repoA'] });

      // 'repo' is a text prefix of 'repoA' but not a segment match
      const r = await callTool(parent, 'trail_search_semantic', {
        query: 'anything',
        in: 'repo',
      });
      assert.equal(r.isError, true, `expected isError:true: ${r.text}`);
      assert.ok(
        r.text.includes('no workspace repos match "in=repo"'),
        `expected match error but got: ${r.text}`,
      );
    } finally {
      safeRmSync(parent);
    }
  }),
);

// ---------------------------------------------------------------------------
// Scenario: Workspace sin ningún índice
// ---------------------------------------------------------------------------
test(
  'Workspace sin ningún índice',
  withFakeEmbedder(async () => {
    const parent = tmpWs();
    try {
      // Build graphs but create NO embeddings DBs.
      makeChildDir(parent, 'repoA', {
        'a.ts': 'export function alphaHandler() { return 1; }\n',
      });
      makeChildDir(parent, 'repoB', {
        'b.ts': 'export function betaHandler() { return 2; }\n',
      });
      await buildOnly(join(parent, 'repoA'));
      await buildOnly(join(parent, 'repoB'));
      writeWorkspace(parent, { version: 1, children: ['repoA', 'repoB'] });

      const r = await callTool(parent, 'trail_search_semantic', {
        query: 'anything',
      });
      assert.equal(r.isError, true, `expected isError:true: ${r.text}`);
      assert.equal(
        r.text,
        '0 of 2 workspace repos have a semantic index; run trail build to cover repoA, repoB',
        `exact text mismatch: ${r.text}`,
      );
    } finally {
      safeRmSync(parent);
    }
  }),
);

// ---------------------------------------------------------------------------
// Scenario: in acota el conteo
// ---------------------------------------------------------------------------
test(
  'in acota el conteo',
  withFakeEmbedder(async () => {
    const parent = tmpWs();
    try {
      makeChildDir(parent, 'repoA', {
        'a.ts': 'export function alphaHandler() { return 1; }\n',
      });
      makeChildDir(parent, 'repoB', {
        'b.ts': 'export function betaHandler() { return 2; }\n',
      });
      await buildOnly(join(parent, 'repoA'));
      await buildOnly(join(parent, 'repoB'));
      writeWorkspace(parent, { version: 1, children: ['repoA', 'repoB'] });

      // in:'repoA' → only repoA in scope, no index → 0 of 1
      const r = await callTool(parent, 'trail_search_semantic', {
        query: 'anything',
        in: 'repoA',
      });
      assert.equal(r.isError, true, `expected isError:true: ${r.text}`);
      assert.ok(
        r.text.includes(
          '0 of 1 workspace repos have a semantic index; run trail build to cover repoA',
        ),
        `expected 0-of-1 coverage note but got: ${r.text}`,
      );
    } finally {
      safeRmSync(parent);
    }
  }),
);

// ---------------------------------------------------------------------------
// Scenario: Un hijo sin índice
// ---------------------------------------------------------------------------
test(
  'Un hijo sin índice',
  withFakeEmbedder(async () => {
    const parent = tmpWs();
    try {
      makeChildDir(parent, 'repoA', {
        'a.ts': 'export function alphaHandler() { return 1; }\n',
      });
      makeChildDir(parent, 'repoB', {
        'b.ts': 'export function betaHandler() { return 2; }\n',
      });
      // Embed only repoA
      const queryA = await buildAndEmbed(join(parent, 'repoA'));
      await buildOnly(join(parent, 'repoB'));
      writeWorkspace(parent, { version: 1, children: ['repoA', 'repoB'] });

      const r = await callTool(parent, 'trail_search_semantic', {
        query: queryA,
      });
      assert.equal(r.isError, false, `expected isError:false: ${r.text}`);
      assert.ok(
        r.text.includes('[repoA/]'),
        `expected repoA hit but got: ${r.text}`,
      );
      assert.ok(
        r.text.includes(
          '1 of 2 workspace repos have a semantic index; run trail build to cover repoB',
        ),
        `expected coverage note but got: ${r.text}`,
      );
    } finally {
      safeRmSync(parent);
    }
  }),
);

// ---------------------------------------------------------------------------
// Scenario: Un índice ilegible se informa
// ---------------------------------------------------------------------------
test(
  'Un índice ilegible se informa',
  withFakeEmbedder(async () => {
    const parent = tmpWs();
    try {
      makeChildDir(parent, 'repoA', {
        'a.ts': 'export function alphaHandler() { return 1; }\n',
      });
      makeChildDir(parent, 'repoB', {
        'b.ts': 'export function betaHandler() { return 2; }\n',
      });
      // Embed repoA; write plain-text "DB" for repoB
      const queryA = await buildAndEmbed(join(parent, 'repoA'));
      await buildOnly(join(parent, 'repoB'));
      const ctxB = contextDirFor(join(parent, 'repoB'));
      const corruptDb = join(ctxB, CACHE_DIR, 'embeddings.db');
      mkdirSync(join(ctxB, CACHE_DIR), { recursive: true });
      writeFileSync(corruptDb, 'this is not a sqlite database\n');
      writeWorkspace(parent, { version: 1, children: ['repoA', 'repoB'] });

      const r = await callTool(parent, 'trail_search_semantic', {
        query: queryA,
      });
      assert.equal(r.isError, false, `expected isError:false: ${r.text}`);
      assert.ok(
        r.text.includes('[repoA/]'),
        `expected repoA hit but got: ${r.text}`,
      );
      assert.ok(
        r.text.includes('semantic search failed in repoB:'),
        `expected failure line but got: ${r.text}`,
      );
    } finally {
      safeRmSync(parent);
    }
  }),
);

// ---------------------------------------------------------------------------
// Scenario: Todos los índices fallan
// ---------------------------------------------------------------------------
test(
  'Todos los índices fallan',
  withFakeEmbedder(async () => {
    const parent = tmpWs();
    try {
      makeChildDir(parent, 'repoA', {
        'a.ts': 'export function alphaHandler() { return 1; }\n',
      });
      await buildOnly(join(parent, 'repoA'));
      // Write a corrupt DB for repoA
      const ctxA = contextDirFor(join(parent, 'repoA'));
      const corruptDb = join(ctxA, CACHE_DIR, 'embeddings.db');
      mkdirSync(join(ctxA, CACHE_DIR), { recursive: true });
      writeFileSync(corruptDb, 'this is not a sqlite database\n');
      writeWorkspace(parent, { version: 1, children: ['repoA'] });

      const r = await callTool(parent, 'trail_search_semantic', {
        query: 'anything',
      });
      assert.equal(r.isError, true, `expected isError:true: ${r.text}`);
      assert.ok(
        r.text.includes('semantic search failed in repoA:'),
        `expected failure line but got: ${r.text}`,
      );
    } finally {
      safeRmSync(parent);
    }
  }),
);

// ---------------------------------------------------------------------------
// Scenario: Descripción de trail_find_code
// ---------------------------------------------------------------------------
test('Descripción de trail_find_code', () => {
  const tool = TOOLS.find(t => t.name === 'trail_find_code');
  assert.ok(tool, 'trail_find_code not found in TOOLS');
  const desc = tool!.description;
  assert.ok(desc.includes('lexical'), `description missing 'lexical': ${desc}`);
  assert.ok(
    desc.includes('structural'),
    `description missing 'structural': ${desc}`,
  );
  assert.ok(
    desc.includes('embeddings'),
    `description missing 'embeddings': ${desc}`,
  );
  assert.ok(
    desc.includes('trail_search_semantic'),
    `description missing 'trail_search_semantic': ${desc}`,
  );
});

// ---------------------------------------------------------------------------
// Scenario: Instrucciones MCP
// ---------------------------------------------------------------------------
test('Instrucciones MCP', () => {
  const instr = mcpInstructions();
  const findCodeLine = instr
    .split('\n')
    .find(l => l.trim().startsWith('- graft_find_code'));
  const semanticLine = instr
    .split('\n')
    .find(l => l.trim().startsWith('- graft_search_semantic'));

  assert.ok(findCodeLine, 'no graft_find_code line in mcpInstructions');
  assert.ok(semanticLine, 'no graft_search_semantic line in mcpInstructions');

  assert.ok(
    findCodeLine!.includes('lexical'),
    `find_code line missing 'lexical': ${findCodeLine}`,
  );
  assert.ok(
    findCodeLine!.includes('no embeddings'),
    `find_code line missing 'no embeddings': ${findCodeLine}`,
  );
  assert.ok(
    semanticLine!.includes('embeddings'),
    `search_semantic line missing 'embeddings': ${semanticLine}`,
  );
});
