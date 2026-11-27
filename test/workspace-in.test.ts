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
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { buildGraph } from '../src/graph/build.js';
import {
  splitWorkspace,
  resolveWorkspaceIn,
  absoluteToWorkspaceRelative,
} from '../src/graph/workspace.js';
import { contextDirFor, CACHE_DIR } from '../src/context/node-file.js';
import { readFingerprint } from '../src/graph/fingerprint.js';
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

// Solo Windows: ahí el shell produce `\` y el resolver tiene que aceptarlo. En
// posix un `\` es un carácter legal dentro de un nombre de archivo, y por eso
// `toPosixPath` es deliberadamente la identidad (src/util/paths.ts:20-31).
test('resolveWorkspaceIn: a\\x\\src normaliza igual que a/x/src', { skip: process.platform !== 'win32' }, () => {
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

test('resolveWorkspaceIn: a/xx no coincide (segmento) — sugiere a/x', () => {
  const r = resolveWorkspaceIn(CHILDREN, 'a/xx');
  assert.strictEqual(r.ok, false);
  if (r.ok) return;
  assert.match(r.message, /no workspace repo matching "a\/xx"/);
  assert.match(r.message, /did you mean:/);
  assert.match(r.message, /"a\/x"/);
});

test('resolveWorkspaceIn: a/x_ no coincide (segmento)', () => {
  const r = resolveWorkspaceIn(CHILDREN, 'a/x_');
  assert.strictEqual(r.ok, false);
  if (r.ok) return;
  assert.match(r.message, /no workspace repo matching "a\/x_"/);
});

test('resolveWorkspaceIn: x infiere a/x por sufijo único (R3)', () => {
  const r = resolveWorkspaceIn(CHILDREN, 'x');
  assert.strictEqual(r.ok, true);
  if (!r.ok) return;
  assert.strictEqual(r.narrowed, true);
  assert.deepStrictEqual(r.targets, [{ child: 'a/x', childIn: undefined }]);
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

// --- in sin coincidencia → mismo texto de error con sugerencias en las cuatro tools ---
const NO_MATCH_MSG = /no workspace repo matching "nope" — did you mean: "a\/x", "a\/y", "b"\?/;

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

test('find_all: in a + limit:2 → solo hits bajo a/, ≤2 y truncado con el total correcto', async () => {
  // Fixture: a/x has 2 hits (src/x.ts + lib/l.ts), a/y has 1 hit (src/y.ts) = 3 total in group a.
  // limit:2 caps the global answer to 2; the remaining 1 must land in truncated.hits.
  const r = await callTool(ROOT, 'trail_find_all', { pattern: 'sharedFn', in: 'a', limit: 2 });
  assert.strictEqual(r.isError, false, `expected isError:false, got: ${r.text}`);
  // Only paths under a/ — b/ must be absent even without limit
  assert.doesNotMatch(r.text, /^b\//m, 'in=a must exclude b/ regardless of limit');
  // The global cap kept 2 hits, truncation note must name the 1 beyond the cap
  assert.match(r.text, /1 more hit beyond the cap/, 'truncation note must report exactly 1 omitted hit');
  // Header reflects the capped count (2), not the total before the cap
  assert.match(r.text, /"sharedFn" — 2 hits/, 'header hit count must be the kept count after cap');
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

// ── R1: in absoluta → relativa al workspace ──────────────────────────────────

test('absoluteToWorkspaceRelative: relativa se normaliza (sin ./ ni barra final)', () => {
  assert.strictEqual(absoluteToWorkspaceRelative(ROOT, './a/x/src/'), 'a/x/src');
});

test('absoluteToWorkspaceRelative: absoluta bajo root → porción relativa', () => {
  const abs = resolve(ROOT, 'a', 'x', 'src');
  assert.strictEqual(absoluteToWorkspaceRelative(ROOT, abs), 'a/x/src');
});

test('absoluteToWorkspaceRelative: absoluta === root → cadenas vacía (todos los hijos)', () => {
  assert.strictEqual(absoluteToWorkspaceRelative(ROOT, resolve(ROOT)), '');
});

test('absoluteToWorkspaceRelative: absoluta fuera de root → sin cambio (fallará downstream)', () => {
  const outside = resolve(ROOT, '..', '..', 'definitely-outside-root');
  assert.strictEqual(absoluteToWorkspaceRelative(ROOT, outside), outside.replace(/\\/g, '/'));
});

test('find_code: in absoluta nativa → misma respuesta que la relativa (R1)', async () => {
  const abs = resolve(ROOT, 'a', 'x', 'src');
  const rAbs = await callTool(ROOT, 'trail_find_code', { query: 'sharedFn', in: abs });
  const rRel = await callTool(ROOT, 'trail_find_code', { query: 'sharedFn', in: 'a/x/src' });
  assert.strictEqual(rAbs.isError, false, `expected isError:false, got: ${rAbs.text}`);
  assert.strictEqual(rAbs.text, rRel.text, 'absoluta y relativa deben dar la misma respuesta');
  assert.match(rAbs.text, /src\/x\.ts/);
  assert.doesNotMatch(rAbs.text, /src\/y\.ts/);
  assert.doesNotMatch(rAbs.text, /src\/b\.ts/);
});

test('find_code: in absoluta fuera del root → error, no crash (R1)', async () => {
  const outside = resolve(ROOT, '..', '..', 'outside-abs-node');
  const r = await callTool(ROOT, 'trail_find_code', { query: 'sharedFn', in: outside });
  assert.strictEqual(r.isError, true, `expected isError:true, got: ${r.text}`);
  assert.match(r.text, /no workspace repo matching/);
});

// ── R2: regresión — carpeta contenedora (grupo) en las cuatro tools ──────────
// (find_code / find_all / trace_calls ya tienen su caso de grupo arriba; acá se
// cubre el que faltaba: search_semantic sobre un grupo debe federar sobre los
// dos hijos y excluir b.)

test('search_semantic: in a → grupo, hits en a/ y excluye b/ (R2 regresión)', async () => {
  _setEmbedderForTest(fakeEmbed);
  try {
    const r = await callTool(ROOT, 'trail_search_semantic', { query: 'sharedFn', in: 'a' });
    assert.strictEqual(r.isError, false, `expected isError:false, got: ${r.text}`);
    assert.doesNotMatch(r.text, /nothing indexed/);
    assert.match(r.text, /src\/x\.ts/, 'el grupo a debe incluir a/x');
    assert.doesNotMatch(r.text, /src\/b\.ts/, 'el grupo a debe excluir b');
  } finally {
    _setEmbedderForTest(null);
  }
});

// ── R3: sufijo único de un hijo ──────────────────────────────────────────────

test('resolveWorkspaceIn: backend → default-core/backend (sufijo único de 1 segmento)', () => {
  const r = resolveWorkspaceIn(COMPUESTO, 'backend');
  assert.strictEqual(r.ok, true);
  if (!r.ok) return;
  assert.strictEqual(r.narrowed, true);
  assert.deepStrictEqual(r.targets, [{ child: 'default-core/backend', childIn: undefined }]);
});

test('resolveWorkspaceIn: backend/services/auth → default-core/backend + childIn services/auth', () => {
  const r = resolveWorkspaceIn(COMPUESTO, 'backend/services/auth');
  assert.strictEqual(r.ok, true);
  if (!r.ok) return;
  assert.strictEqual(r.narrowed, true);
  assert.deepStrictEqual(r.targets, [{ child: 'default-core/backend', childIn: 'services/auth' }]);
});

test('resolveWorkspaceIn: backend ambiguo entre dos hijos → error matches multiple repos', () => {
  const AMBIGUO = ['default-core/backend', 'infra-local/backend'] as const;
  const r = resolveWorkspaceIn(AMBIGUO, 'backend');
  assert.strictEqual(r.ok, false);
  if (r.ok) return;
  assert.match(r.message, /matches multiple repos/);
  assert.match(r.message, /"default-core\/backend"/);
  assert.match(r.message, /"infra-local\/backend"/);
});

// ── R4: sugerencias con edit distance ────────────────────────────────────────

test('resolveWorkspaceIn: nope → did you mean con los tres hijos por distancia', () => {
  const r = resolveWorkspaceIn(CHILDREN, 'nope');
  assert.strictEqual(r.ok, false);
  if (r.ok) return;
  assert.strictEqual(
    r.message,
    'no workspace repo matching "nope" — did you mean: "a/x", "a/y", "b"?',
  );
});

test('resolveWorkspaceIn: workspace vacío → error sin sección de sugerencias', () => {
  const r = resolveWorkspaceIn([], 'nope');
  assert.strictEqual(r.ok, false);
  if (r.ok) return;
  assert.strictEqual(r.message, 'no workspace repo matching "nope"');
  assert.doesNotMatch(r.message, /did you mean/);
});

test('resolveWorkspaceIn: core/backen con 6 hijos → exactamente 3 sugerencias, orden distancia (no alfa), tie-break alfa (R4 ranking)', () => {
  // Pool de 6 hijos. Distancias reales desde 'core/backen' (len=11):
  //   core/backend=1, aa/backend=5, zz/backend=5, core/frontend=6, aaaa=10, bbbb=10
  //
  // Orden alfabético (que contradice distancia — alfa top-3: aa/backend, aaaa, bbbb):
  //   aa/backend < aaaa < bbbb < core/backend < core/frontend < zz/backend
  //
  // Top-3 por distancia + tie alfa: core/backend(1), aa/backend(5), zz/backend(5)
  //
  // Mutaciones que detecta:
  //   • sin .slice(0,3) → mensaje lista 6, no 3 (mensaje no coincide)
  //   • sort DESC → 'aaaa','bbbb' primeros en el mensaje (mensaje no coincide)
  //   • sub=0 en DP → aa/backend sube a d=1 (mismo len diff que core/backend)
  //     y alfa aa < core, así que 'aa/backend' va primero → mensaje no coincide
  // Pool con zz/backend ANTES de aa/backend: sin localeCompare el sort estable
  // los dejaría en ese orden (zz primero), rompiendo el assert del mensaje.
  const CHILDREN_6 = ['zz/backend', 'core/frontend', 'bbbb', 'core/backend', 'aaaa', 'aa/backend'] as const;
  const r = resolveWorkspaceIn(CHILDREN_6, 'core/backen');
  assert.strictEqual(r.ok, false);
  if (r.ok) return;
  assert.strictEqual(
    r.message,
    'no workspace repo matching "core/backen" — did you mean: "core/backend", "aa/backend", "zz/backend"?',
    'se esperan exactamente 3 sugerencias, en orden de distancia, tie-break alfa',
  );
});

// ── R5: validar in antes del refresh + refrescar solo hijos afectados ─────────
// Estos tests habilitan el refresh (borran GRAFT_NO_REFRESH) sobre un workspace
// AISLADO y ensucian un hijo para que un refresh sea observable. Se observa el
// FINGERPRINT del hijo (que sólo cambia si se reconstruye) además de la nota de
// respuesta: con la pre-validación el refresh no corre (in inválido) o corre sólo
// sobre el hijo afectado; sin ella, el hijo ensuciado se reconstruye y el
// fingerprint cambia (y en el caso válido aparece "refreshed" en el texto).

async function buildIsolated(children: Record<string, Record<string, string>>): Promise<string> {
  const root = tmpWs();
  for (const [name, files] of Object.entries(children)) makeChildDir(root, name, files);
  await splitWorkspace(root, undefined, async (childDir) => {
    await buildGraph(childDir);
  });
  return root;
}

/** Print `[size, mtimeMs, hash]` del archivo `relSuffix` en el fingerprint del hijo. */
function fpEntry(root: string, child: string, relSuffix: string): string | null {
  const fp = readFingerprint(contextDirFor(join(root, child)));
  if (!fp) return null;
  const key = Object.keys(fp.files).find((k) => k.replace(/\\/g, '/').endsWith(relSuffix));
  return key ? JSON.stringify(fp.files[key]) : null;
}

test('R5: in inválido no refresca ningún grafo (fingerprint de b intacto)', async () => {
  const root = await buildIsolated({
    'a/x': { 'src/x.ts': SHARED_FN_X },
    b: { 'src/b.ts': SHARED_FN_B },
  });
  try {
    // Ensucia b: si el refresh corriera, reconstruiría b y su fingerprint cambiaría.
    writeFileSync(join(root, 'b', 'src', 'b.ts'), SHARED_FN_B + '// changed\n');
    const before = fpEntry(root, 'b', 'src/b.ts');
    assert.ok(before, 'b debe tener fingerprint tras el build');
    const prev = process.env.GRAFT_NO_REFRESH;
    delete process.env.GRAFT_NO_REFRESH;
    try {
      const r = await callTool(root, 'trail_find_code', { query: 'sharedFn', in: 'typo_repo' });
      assert.strictEqual(r.isError, true, `expected isError:true, got: ${r.text}`);
      assert.match(r.text, /no workspace repo matching "typo_repo"/);
    } finally {
      if (prev === undefined) delete process.env.GRAFT_NO_REFRESH;
      else process.env.GRAFT_NO_REFRESH = prev;
    }
    const after = fpEntry(root, 'b', 'src/b.ts');
    assert.strictEqual(after, before, 'in inválido no debe reconstruir b (el refresh no corre)');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('R5: in válido refresca solo el hijo afectado, no los demás', async () => {
  const root = await buildIsolated({
    'a/x': { 'src/x.ts': SHARED_FN_X },
    'a/y': { 'src/y.ts': SHARED_FN_Y },
  });
  try {
    // Ensucia a/y (NO el hijo afectado a/x): sin el filtro de hijos, el refresh
    // recorrería todos los hijos, reconstruiría a/y y dejaría nota "refreshed".
    writeFileSync(join(root, 'a', 'y', 'src', 'y.ts'), SHARED_FN_Y + '// changed\n');
    const beforeY = fpEntry(root, 'a/y', 'src/y.ts');
    assert.ok(beforeY, 'a/y debe tener fingerprint tras el build');
    const prev = process.env.GRAFT_NO_REFRESH;
    delete process.env.GRAFT_NO_REFRESH;
    try {
      const r = await callTool(root, 'trail_find_code', { query: 'sharedFn', in: 'a/x' });
      assert.strictEqual(r.isError, false, `expected isError:false, got: ${r.text}`);
      assert.doesNotMatch(r.text, /refreshed/, 'in=a/x no debe refrescar a/y');
    } finally {
      if (prev === undefined) delete process.env.GRAFT_NO_REFRESH;
      else process.env.GRAFT_NO_REFRESH = prev;
    }
    const afterY = fpEntry(root, 'a/y', 'src/y.ts');
    assert.strictEqual(afterY, beforeY, 'a/y (no afectado) no debe reconstruirse');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
