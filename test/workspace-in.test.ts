/**
 * Tests for uniform `in=` parameter across the four workspace tools and the CLI.
 * Covers resolveWorkspaceIn (pure), callTool federation, trail grep --in, stdio
 * set_scope + trace_calls, and uniform descriptions.
 *
 * Run with:
 *   GRAFT_NO_TRAIL_SWITCH=1 node --import tsx --test test/workspace-in.test.ts
 */

// Disable auto-refresh: graph building is managed manually.
process.env.GRAFT_NO_REFRESH = '1';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { buildGraph } from '../src/graph/build.js';
import {
  splitWorkspace,
  resolveWorkspaceIn,
} from '../src/graph/workspace.js';
import { contextDirFor, CACHE_DIR } from '../src/context/node-file.js';
import { loadGraphCached } from '../src/graph/load.js';
import {
  embedNodes,
  _setEmbedderForTest,
  EMBED_DIM,
} from '../src/ask/semantic.js';
import { callTool, TOOLS } from '../src/mcp/tools.js';

// ── Fake embedder ─────────────────────────────────────────────────────────────
function fakeEmbed(text: string): Float32Array {
  const hash = createHash('sha256').update(text).digest();
  const vec = new Float32Array(EMBED_DIM);
  for (let i = 0; i < EMBED_DIM; i++) {
    vec[i] = ((hash[i % 32]! ^ (hash[(i + 1) % 32]! << 4)) / 255) * 2 - 1;
  }
  return vec;
}

// ── File contents ─────────────────────────────────────────────────────────────
const SHARED_FN_X = 'export function sharedFn() { return xOnly(); }\nfunction xOnly() { return 1; }\n';
const LIB_FN      = 'export function libFn() { return 3; }\nexport function sharedFn() { return "fromLib"; }\n';
const SHARED_FN_Y = 'export function sharedFn() { return yOnly(); }\nfunction yOnly() { return 1; }\n';
const SHARED_FN_B = 'export function sharedFn() { return 4; }\n';

// ── Fixture helpers ───────────────────────────────────────────────────────────
function makeChildDir(
  parent: string,
  name: string,
  files: Record<string, string>,
): void {
  const dir = join(parent, name);
  mkdirSync(join(dir, '.git'), { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    const p = join(dir, file);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, content);
  }
}

function tmpWs(): string {
  return mkdtempSync(join(tmpdir(), 'ws-in-'));
}

// ── Shared fixture: a/x (src/x.ts, lib/l.ts), a/y (src/y.ts), b (src/b.ts) ──
let ROOT: string;

before(async () => {
  ROOT = tmpWs();
  makeChildDir(ROOT, 'a/x', { 'src/x.ts': SHARED_FN_X, 'lib/l.ts': LIB_FN });
  makeChildDir(ROOT, 'a/y', { 'src/y.ts': SHARED_FN_Y });
  makeChildDir(ROOT, 'b',   { 'src/b.ts': SHARED_FN_B });

  // Build graphs
  await splitWorkspace(ROOT, undefined, async (childDir) => {
    await buildGraph(childDir);
  });

  // Build embeddings for each child with fake embedder
  _setEmbedderForTest(fakeEmbed);
  for (const child of ['a/x', 'a/y', 'b']) {
    const childDir = join(ROOT, child);
    const ctx = contextDirFor(childDir);
    const graph = loadGraphCached(ctx);
    if (!graph) throw new Error(`no graph for ${child}`);
    const nodes = graph.nodes.filter((n) => n.kind !== 'file');
    const dbPath = join(ctx, CACHE_DIR, 'embeddings.db');
    await embedNodes(nodes, dbPath);
  }
  _setEmbedderForTest(null);
});

after(() => {
  if (ROOT) rmSync(ROOT, { recursive: true, force: true });
});

// ── 1.2 resolveWorkspaceIn — pura (no lee disco) ─────────────────────────────

const CHILDREN = ['a/x', 'a/y', 'b'] as const;
const COMPUESTO = ['default-core/frontend', 'default-core/backend'] as const;

test('resolveWorkspaceIn: a\\x\\src normaliza igual que a/x/src', () => {
  const r1 = resolveWorkspaceIn(CHILDREN, 'a\\x\\src');
  const r2 = resolveWorkspaceIn(CHILDREN, 'a/x/src');
  assert.deepStrictEqual(r1, r2);
});

test('resolveWorkspaceIn: ./a/x/src normaliza igual que a/x/src', () => {
  const r1 = resolveWorkspaceIn(CHILDREN, './a/x/src');
  const r2 = resolveWorkspaceIn(CHILDREN, 'a/x/src');
  assert.deepStrictEqual(r1, r2);
});

test('resolveWorkspaceIn: a/x/src/ normaliza igual que a/x/src', () => {
  const r1 = resolveWorkspaceIn(CHILDREN, 'a/x/src/');
  const r2 = resolveWorkspaceIn(CHILDREN, 'a/x/src');
  assert.deepStrictEqual(r1, r2);
});

test('resolveWorkspaceIn: / es ausente — todos los hijos sin sub-prefijo', () => {
  const r = resolveWorkspaceIn(CHILDREN, '/');
  assert.strictEqual(r.ok, true);
  if (!r.ok) return;
  assert.strictEqual(r.narrowed, false);
  assert.deepStrictEqual(r.targets.map((t) => t.child).sort(), ['a/x', 'a/y', 'b']);
  assert.ok(r.targets.every((t) => t.childIn === undefined));
});

test('resolveWorkspaceIn: ./ es ausente — todos los hijos sin sub-prefijo', () => {
  const r = resolveWorkspaceIn(CHILDREN, './');
  assert.strictEqual(r.ok, true);
  if (!r.ok) return;
  assert.strictEqual(r.narrowed, false);
  assert.deepStrictEqual(r.targets.map((t) => t.child).sort(), ['a/x', 'a/y', 'b']);
  assert.ok(r.targets.every((t) => t.childIn === undefined));
});

test('resolveWorkspaceIn: a/xx no coincide (segmento)', () => {
  const r = resolveWorkspaceIn(CHILDREN, 'a/xx');
  assert.strictEqual(r.ok, false);
  if (r.ok) return;
  assert.match(r.message, /no workspace repo matching "a\/xx"/);
  assert.match(r.message, /repos:/);
});

test('resolveWorkspaceIn: a/x_ no coincide (segmento)', () => {
  const r = resolveWorkspaceIn(CHILDREN, 'a/x_');
  assert.strictEqual(r.ok, false);
  if (r.ok) return;
  assert.match(r.message, /no workspace repo matching "a\/x_"/);
});

test('resolveWorkspaceIn: x no coincide', () => {
  const r = resolveWorkspaceIn(CHILDREN, 'x');
  assert.strictEqual(r.ok, false);
  if (r.ok) return;
  assert.match(r.message, /no workspace repo matching "x"/);
});

test('resolveWorkspaceIn: a/x/src → hijo a/x con sub-prefijo src', () => {
  const r = resolveWorkspaceIn(CHILDREN, 'a/x/src');
  assert.strictEqual(r.ok, true);
  if (!r.ok) return;
  assert.strictEqual(r.narrowed, true);
  assert.deepStrictEqual(r.targets, [{ child: 'a/x', childIn: 'src' }]);
});

test('resolveWorkspaceIn: a/x → hijo a/x sin sub-prefijo', () => {
  const r = resolveWorkspaceIn(CHILDREN, 'a/x');
  assert.strictEqual(r.ok, true);
  if (!r.ok) return;
  assert.strictEqual(r.narrowed, true);
  assert.deepStrictEqual(r.targets, [{ child: 'a/x', childIn: undefined }]);
});

test('resolveWorkspaceIn: a → grupo a/x y a/y sin sub-prefijo', () => {
  const r = resolveWorkspaceIn(CHILDREN, 'a');
  assert.strictEqual(r.ok, true);
  if (!r.ok) return;
  assert.strictEqual(r.narrowed, true);
  assert.deepStrictEqual(r.targets.map((t) => t.child).sort(), ['a/x', 'a/y']);
  assert.ok(r.targets.every((t) => t.childIn === undefined));
});

test('resolveWorkspaceIn: hijos compuestos — default-core/frontend/src → hijo compuesto gana al grupo', () => {
  const r = resolveWorkspaceIn(COMPUESTO, 'default-core/frontend/src');
  assert.strictEqual(r.ok, true);
  if (!r.ok) return;
  assert.strictEqual(r.narrowed, true);
  assert.deepStrictEqual(r.targets, [{ child: 'default-core/frontend', childIn: 'src' }]);
});

// ── 1.3 Per-tool con callTool ─────────────────────────────────────────────────

// --- in sin coincidencia → mismo texto de error en las cuatro tools ---
const NO_MATCH_MSG = /no workspace repo matching "nope" — repos: a\/x, a\/y, b/;

test('find_code: in nope → isError con mensaje uniforme', async () => {
  const r = await callTool(ROOT, 'trail_find_code', { query: 'sharedFn', in: 'nope' });
  assert.strictEqual(r.isError, true, `expected isError:true, got: ${r.text}`);
  assert.match(r.text, NO_MATCH_MSG);
});

test('trace_calls: in nope → isError con mensaje uniforme', async () => {
  const r = await callTool(ROOT, 'trail_trace_calls', { symbol: 'sharedFn', in: 'nope' });
  assert.strictEqual(r.isError, true, `expected isError:true, got: ${r.text}`);
  assert.match(r.text, NO_MATCH_MSG);
});

test('find_all: in nope → isError con mensaje uniforme', async () => {
  const r = await callTool(ROOT, 'trail_find_all', { pattern: 'sharedFn', in: 'nope' });
  assert.strictEqual(r.isError, true, `expected isError:true, got: ${r.text}`);
  assert.match(r.text, NO_MATCH_MSG);
});

test('search_semantic: in nope → isError con mensaje uniforme', async () => {
  const r = await callTool(ROOT, 'trail_search_semantic', { query: 'sharedFn', in: 'nope' });
  assert.strictEqual(r.isError, true, `expected isError:true, got: ${r.text}`);
  assert.match(r.text, NO_MATCH_MSG);
});

// --- in con sub-prefijo existente: las cuatro no dan isError ---
test('find_code: in a/x/src → paths en src/, no en lib/', async () => {
  const r = await callTool(ROOT, 'trail_find_code', { query: 'sharedFn', in: 'a/x/src' });
  assert.strictEqual(r.isError, false, `expected isError:false, got: ${r.text}`);
  assert.doesNotMatch(r.text, /nothing indexed/);
  // debe haber un hit en src/x.ts (match lexical exacto)
  assert.match(r.text, /src\/x\.ts/);
  // señuelo: lib/l.ts también tiene sharedFn; su aparición delataría sabotaje (f)
  assert.doesNotMatch(r.text, /lib\/l\.ts/);
  assert.doesNotMatch(r.text, /src\/y\.ts/);
  assert.doesNotMatch(r.text, /src\/b\.ts/);
});

test('trace_calls: in a/x/src → no isError, solo bloque a/x/', async () => {
  const r = await callTool(ROOT, 'trail_trace_calls', { symbol: 'sharedFn', in: 'a/x/src' });
  assert.strictEqual(r.isError, false, `expected isError:false, got: ${r.text}`);
  assert.match(r.text, /## a\/x\//);
  assert.doesNotMatch(r.text, /## a\/y\//);
  assert.doesNotMatch(r.text, /## b\//);
});

test('find_all: in a/x/src → searched 1 indexed files', async () => {
  const r = await callTool(ROOT, 'trail_find_all', { pattern: 'sharedFn', in: 'a/x/src' });
  assert.strictEqual(r.isError, false, `expected isError:false, got: ${r.text}`);
  assert.match(r.text, /searched 1 indexed files?/);
});

test('find_all: in a → searched 3 indexed files', async () => {
  const r = await callTool(ROOT, 'trail_find_all', { pattern: 'sharedFn', in: 'a' });
  assert.strictEqual(r.isError, false, `expected isError:false, got: ${r.text}`);
  assert.match(r.text, /searched 3 indexed files?/);
  assert.doesNotMatch(r.text, /^b\//m);
});

test('find_all: sub-prefijo existente sin resultados → isError:false', async () => {
  const r = await callTool(ROOT, 'trail_find_all', { pattern: 'zzzNoExiste', in: 'a/x/src' });
  assert.strictEqual(r.isError, false, `expected isError:false, got: ${r.text}`);
});

test('search_semantic: in a/x/src → paths en src/, no en lib/', async () => {
  _setEmbedderForTest(fakeEmbed);
  try {
    const r = await callTool(ROOT, 'trail_search_semantic', { query: 'sharedFn', in: 'a/x/src' });
    assert.strictEqual(r.isError, false, `expected isError:false, got: ${r.text}`);
    assert.doesNotMatch(r.text, /nothing indexed/);
    // debe haber hits en src/x.ts
    assert.match(r.text, /src\/x\.ts/);
    // señuelo: lib/l.ts también tiene sharedFn; su aparición delataría sabotaje (g)
    assert.doesNotMatch(r.text, /lib\/l\.ts/);
    assert.doesNotMatch(r.text, /src\/y\.ts/);
    assert.doesNotMatch(r.text, /src\/b\.ts/);
  } finally {
    _setEmbedderForTest(null);
  }
});

// --- trace_calls con in = grupo ---
test('trace_calls: in a → bloques a/x/ y a/y/, sin b/', async () => {
  const r = await callTool(ROOT, 'trail_trace_calls', { symbol: 'sharedFn', in: 'a' });
  assert.strictEqual(r.isError, false, `expected isError:false, got: ${r.text}`);
  assert.match(r.text, /## a\/x\//);
  assert.match(r.text, /## a\/y\//);
  assert.doesNotMatch(r.text, /## b\//);
});

test('find_code: in a → grupo, hits a/x/ y a/y/, sin b/', async () => {
  const r = await callTool(ROOT, 'trail_find_code', { query: 'sharedFn', in: 'a' });
  assert.strictEqual(r.isError, false, `expected isError:false, got: ${r.text}`);
  assert.match(r.text, /a\/x\//);
  assert.match(r.text, /a\/y\//);
  assert.doesNotMatch(r.text, /^b\//m);
});

// --- símbolo ausente cuenta solo los hijos en alcance ---
test('trace_calls: símbolo ausente con in a/x/src cuenta 1 repo', async () => {
  const r = await callTool(ROOT, 'trail_trace_calls', { symbol: 'noExiste', in: 'a/x/src' });
  assert.strictEqual(r.isError, true, `expected isError:true, got: ${r.text}`);
  assert.match(r.text, /no symbol "noExiste" in any of the 1 workspace repo\(s\)/);
});

// --- sub-prefijo mal escrito → isError en las cuatro tools ---
const NOTHING_INDEXED = /nothing indexed under "a\/x\/nada\/"/;

test('find_code: sub-prefijo a/x/nada → isError', async () => {
  const r = await callTool(ROOT, 'trail_find_code', { query: 'sharedFn', in: 'a/x/nada' });
  assert.strictEqual(r.isError, true, `expected isError:true, got: ${r.text}`);
  assert.match(r.text, NOTHING_INDEXED);
});

test('trace_calls: sub-prefijo a/x/nada → isError', async () => {
  const r = await callTool(ROOT, 'trail_trace_calls', { symbol: 'sharedFn', in: 'a/x/nada' });
  assert.strictEqual(r.isError, true, `expected isError:true, got: ${r.text}`);
  assert.match(r.text, NOTHING_INDEXED);
});

test('find_all: sub-prefijo a/x/nada → isError', async () => {
  const r = await callTool(ROOT, 'trail_find_all', { pattern: 'sharedFn', in: 'a/x/nada' });
  assert.strictEqual(r.isError, true, `expected isError:true, got: ${r.text}`);
  assert.match(r.text, NOTHING_INDEXED);
});

test('search_semantic: sub-prefijo a/x/nada → isError', async () => {
  const r = await callTool(ROOT, 'trail_search_semantic', { query: 'sharedFn', in: 'a/x/nada' });
  assert.strictEqual(r.isError, true, `expected isError:true, got: ${r.text}`);
  assert.match(r.text, NOTHING_INDEXED);
});

// ── 1.4 CLI grep ──────────────────────────────────────────────────────────────
test('trail grep --in a/x/src acota al sub-prefijo', () => {
  const out = execFileSync(
    process.execPath,
    ['--import', 'tsx', 'src/cli.ts', 'grep', 'sharedFn', ROOT, '--in', 'a/x/src'],
    { env: { ...process.env, GRAFT_NO_REFRESH: '1' }, encoding: 'utf8' },
  );
  assert.match(out, /a\/x\/src\/x\.ts/);
  assert.doesNotMatch(out, /a\/y\//);
  assert.doesNotMatch(out, /^b\//m);
});

// ── 1.5 stdio: set_scope dentro de un hijo y trace_calls sin in ──────────────
// (test aislado — no comparte helpers con otros tests; #20 puede borrarlo o reescribirlo)
async function rpcIn(messages: object[], dir: string, expected: number): Promise<unknown[]> {
  const home = mkdtempSync(join(tmpdir(), 'mcp-in-home-'));
  const { TRAIL_HOME: _t, GRAFT_HOME: _g, ...env } = process.env;
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'mcp', dir], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...env, HOME: home, GRAFT_NO_REFRESH: '1' },
  });
  const responses: unknown[] = [];
  let buf = '';
  child.stdout.on('data', (d: Buffer) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) responses.push(JSON.parse(line));
    }
  });
  for (const m of messages) child.stdin.write(`${JSON.stringify(m)}\n`);
  const deadline = Date.now() + 15000;
  while (responses.length < expected && Date.now() < deadline)
    await new Promise<void>((r) => setTimeout(r, 50));
  child.kill();
  await once(child, 'exit').catch(() => {});
  rmSync(home, { recursive: true, force: true });
  return responses;
}

test('set_scope dentro de un hijo y trace_calls sin in', async () => {
  // path normalizado a forward-slash para el protocolo MCP
  const scopePath = join(ROOT, 'a', 'x', 'src').replaceAll('\\', '/');
  const responses = await rpcIn([
    {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
    },
    {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'trail_set_scope', arguments: { path: scopePath } },
    },
    {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'trail_trace_calls', arguments: { symbol: 'sharedFn' } },
    },
  ], ROOT, 3);

  const traceResp = (responses as Array<{ id?: number; result?: { content?: Array<{ text?: string }> } }>)
    .find((r) => r.id === 3);
  assert.ok(traceResp, 'no response for id=3');
  const content = traceResp?.result?.content?.[0]?.text ?? '';
  assert.match(content, /## a\/x\//);
  assert.doesNotMatch(content, /## a\/y\//);
});

// ── 1.6 Descripciones iguales y contienen 'workspace' ────────────────────────
test('las cuatro propiedades in tienen la misma descripción y contienen workspace', () => {
  const toolNames = ['trail_find_code', 'trail_trace_calls', 'trail_find_all', 'trail_search_semantic'];
  const descs = toolNames.map((name) => {
    const tool = TOOLS.find((t) => t.name === name);
    assert.ok(tool, `tool ${name} not found in TOOLS`);
    const schema = (tool!.inputSchema as Record<string, unknown>);
    const props = (schema.properties as Record<string, { description?: string }>);
    const desc = props?.in?.description;
    assert.ok(desc, `${name}.inputSchema.properties.in.description is missing`);
    return desc!;
  });
  const first = descs[0]!;
  for (const d of descs) {
    assert.strictEqual(d, first, `descriptions differ:\n  ${first}\n  vs\n  ${d}`);
  }
  assert.match(first, /workspace/);
});
