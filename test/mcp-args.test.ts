/**
 * Tests for MCP argument validation (mcp-validar-argumentos change).
 * Covers every scenario of spec mcp-argumentos/spec.md.
 *
 * Run with:
 *   GRAFT_NO_TRAIL_SWITCH=1 node --import tsx --test test/mcp-args.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { TOOLS, callTool } from '../src/mcp/tools.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function builtRepo(): string {
  const d = mkdtempSync(join(tmpdir(), 'mcp-args-built-'));
  mkdirSync(join(d, 'src'), { recursive: true });
  writeFileSync(
    join(d, 'src', 'math.ts'),
    'export function add(a: number, b: number): number {\n  return a + b;\n}\nexport function sub(a: number, b: number): number {\n  return add(a, -b);\n}\n',
  );
  execFileSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'build', d], { stdio: 'pipe' });
  return d;
}

/** Stdio helper — copied from test/mcp-server.test.ts */
async function rpc(messages: object[], dir: string, expected: number): Promise<any[]> {
  const home = mkdtempSync(join(tmpdir(), 'mcp-args-home-'));
  const { TRAIL_HOME: _t, GRAFT_HOME: _g, ...env } = process.env;
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'mcp', dir], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...env, HOME: home },
  });
  const responses: any[] = [];
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
    await new Promise((r) => setTimeout(r, 50));
  child.kill();
  await once(child, 'exit').catch(() => {});
  return responses;
}

// ── Scenario helpers ─────────────────────────────────────────────────────────

/** Required args per tool, correctly typed, for the TOOLS recorrido tests. */
const REQUIRED_VALID: Record<string, Record<string, unknown>> = {
  trail_set_scope:      { path: '/some/path' },
  trail_find_code:      { query: 'x' },
  trail_file_api:       { file: 'x' },
  trail_check_freshness: {},
  trail_build:          {},
  trail_trace_calls:    { symbol: 'x' },
  trail_find_all:       { pattern: 'x' },
  trail_repo_map:       {},
  trail_search_semantic: { query: 'x' },
};

// ── Requirement: Rechazo de argumentos desconocidos ──────────────────────────

test('Scenario: find_all con un parámetro desconocido no hace búsqueda', async () => {
  const d = builtRepo();
  const r = await callTool(d, 'trail_find_all', { pattern: 'add', paths: 'a' });
  assert.equal(r.isError, true);
  assert.match(r.text, /unknown argument "paths" \(did you mean "in"\?\) for trail_find_all/);
  assert.match(r.text, /expected one of: pattern, in, limit, ignore_case, fixed/);
  // No search results
  assert.doesNotMatch(r.text, /hits in/);
});

test('Scenario: varias claves desconocidas', async () => {
  const bare = mkdtempSync(join(tmpdir(), 'mcp-args-bare-'));
  const r = await callTool(bare, 'trail_check_freshness', { foo: 1, bar: 2 } as any);
  assert.equal(r.isError, true);
  assert.match(r.text, /^unknown arguments "foo", "bar" for trail_check_freshness/);
  assert.match(r.text, /expected no arguments$/);
});

test('Scenario: claves de Object.prototype se rechazan como desconocidas', async () => {
  const bare = mkdtempSync(join(tmpdir(), 'mcp-args-proto-'));
  // constructor, toString, __proto__ son propiedades de Object.prototype;
  // deben rechazarse como claves desconocidas (guard Object.hasOwn).
  const r1 = await callTool(bare, 'trail_find_all', { pattern: 'x', constructor: 1 } as any);
  assert.equal(r1.isError, true);
  assert.match(r1.text, /unknown argument .constructor. for trail_find_all/);
  assert.doesNotMatch(r1.text, /native code/);

  const r2 = await callTool(bare, 'trail_find_all', { pattern: 'x', toString: 1 } as any);
  assert.equal(r2.isError, true);
  assert.match(r2.text, /unknown argument .toString. for trail_find_all/);

  // __proto__ via JSON.parse (evita mutar el prototipo del literal)
  const args3 = JSON.parse('{"pattern":"x","__proto__":1}') as any;
  const r3 = await callTool(bare, 'trail_find_all', args3);
  assert.equal(r3.isError, true);
  assert.match(r3.text, /unknown argument .__proto__. for trail_find_all/);
});

// ── Requirement: Argumentos requeridos ausentes ──────────────────────────────

test('Scenario: falta el argumento requerido sin claves desconocidas', async () => {
  const bare = mkdtempSync(join(tmpdir(), 'mcp-args-bare-'));
  const r = await callTool(bare, 'trail_trace_calls', {});
  assert.equal(r.isError, true);
  assert.equal(
    r.text,
    'missing required argument "symbol" for trail_trace_calls; expected one of: symbol, direction, depth, in',
  );
});

test('Scenario: string vacío cuenta como presente — el validador no rechaza', async () => {
  const d = builtRepo();
  const r = await callTool(d, 'trail_find_all', { pattern: '' });
  assert.equal(r.isError, true);
  // Handler guard fires, not the validator
  assert.match(r.text, /trail_find_all requires a non-empty "pattern"/);
  assert.doesNotMatch(r.text, /missing required argument/);
});

// ── Requirement: Cláusulas del mensaje de validación ────────────────────────

test('Scenario: solo falta un requerido', async () => {
  const bare = mkdtempSync(join(tmpdir(), 'mcp-args-bare-'));
  const r = await callTool(bare, 'trail_find_code', {});
  assert.equal(r.isError, true);
  assert.equal(
    r.text,
    'missing required argument "query" for trail_find_code; expected one of: query, limit, full, in',
  );
});

test('Scenario: desconocido, faltante y valor inválido juntos', async () => {
  const bare = mkdtempSync(join(tmpdir(), 'mcp-args-bare-'));
  const r = await callTool(bare, 'trail_find_code', { pattern: 'x', limit: '3' } as any);
  assert.equal(r.isError, true);
  assert.equal(
    r.text,
    'unknown argument "pattern" (did you mean "query"?) for trail_find_code; missing required argument "query"; invalid argument "limit": expected number, got string; expected one of: query, limit, full, in',
  );
});

// ── Requirement: Posición del nombre de la tool en el mensaje ────────────────

test('Scenario: la tool aparece una sola vez', async () => {
  const bare = mkdtempSync(join(tmpdir(), 'mcp-args-bare-'));
  const r = await callTool(bare, 'trail_find_all', {
    pattern: 'x',
    fixed: 'a',
    ignore_case: 'b',
  } as any);
  assert.equal(r.isError, true);
  const occurrences = (r.text.match(/for trail_find_all/g) ?? []).length;
  assert.equal(occurrences, 1, `"for trail_find_all" should appear exactly once, got: ${r.text}`);
});

// ── Requirement: Cláusula expected y nombre anunciado ───────────────────────

test('Scenario: find_all con query en vez de pattern', async () => {
  const bare = mkdtempSync(join(tmpdir(), 'mcp-args-bare-'));
  const r = await callTool(bare, 'trail_find_all', { query: 'x' });
  assert.equal(r.isError, true);
  assert.equal(
    r.text,
    'unknown argument "query" (did you mean "pattern"?) for trail_find_all; missing required argument "pattern"; expected one of: pattern, in, limit, ignore_case, fixed',
  );
});

// ── Requirement: Pista del nombre correcto ───────────────────────────────────

test('Scenario: la pista va tras cada clave desconocida', async () => {
  const bare = mkdtempSync(join(tmpdir(), 'mcp-args-bare-'));
  const r = await callTool(bare, 'trail_find_all', {
    pattern: 'x',
    ignoreCase: true,
    paths: 's',
  } as any);
  assert.equal(r.isError, true);
  assert.match(
    r.text,
    /^unknown arguments "ignoreCase" \(did you mean "ignore_case"\?\), "paths" \(did you mean "in"\?\) for trail_find_all;/,
  );
});

test('Scenario: sin candidata no hay pista', async () => {
  const bare = mkdtempSync(join(tmpdir(), 'mcp-args-bare-'));
  const r = await callTool(bare, 'trail_find_all', { pattern: 'x', zzz: 1 } as any);
  assert.equal(r.isError, true);
  assert.match(r.text, /^unknown argument "zzz" for trail_find_all;/);
});

test('Scenario: la candidata ya viene en la llamada', async () => {
  const bare = mkdtempSync(join(tmpdir(), 'mcp-args-bare-'));
  const r = await callTool(bare, 'trail_find_code', { query: 'x', pattern: 'y' } as any);
  assert.equal(r.isError, true);
  assert.match(r.text, /^unknown argument "pattern" for trail_find_code;/);
  // No hint since query is already present
  assert.doesNotMatch(r.text, /did you mean/);
});

// ── Requirement: Búsqueda de la candidata ────────────────────────────────────

test('Scenario: pistas por regla (1), (2) y (3)', async () => {
  const bare = mkdtempSync(join(tmpdir(), 'mcp-args-bare-'));
  const r1 = await callTool(bare, 'trail_find_all', { pattern: 'x', ignoreCase: true } as any);
  assert.match(r1.text, /"ignoreCase" \(did you mean "ignore_case"\?\)/);

  const r2 = await callTool(bare, 'trail_find_code', { query: 'x', limite: 3 } as any);
  assert.match(r2.text, /"limite" \(did you mean "limit"\?\)/);

  const r3 = await callTool(bare, 'trail_find_all', { pattern: 'x', paths: 'src' } as any);
  assert.match(r3.text, /"paths" \(did you mean "in"\?\)/);
});

// ── Requirement: Tabla de pistas de las tools de búsqueda ────────────────────

test('Scenario: search_semantic con pattern', async () => {
  const bare = mkdtempSync(join(tmpdir(), 'mcp-args-bare-'));
  const r = await callTool(bare, 'trail_search_semantic', { pattern: 'x' } as any);
  assert.equal(r.isError, true);
  assert.equal(
    r.text,
    'unknown argument "pattern" (did you mean "query"?) for trail_search_semantic; missing required argument "query"; expected one of: query, limit, in',
  );
});

// ── Requirement: Tabla de pistas de las demás tools ──────────────────────────

test('Scenario: una clave de la tabla no se acepta (trail_file_api con path)', async () => {
  const d = builtRepo();
  const r = await callTool(d, 'trail_file_api', { path: 'src/math.ts' } as any);
  assert.equal(r.isError, true);
  assert.match(r.text, /did you mean "file"\?/);
  // No signatures returned
  assert.doesNotMatch(r.text, /function add/);
});

// ── Requirement: Tipo de los valores ─────────────────────────────────────────

test('Scenario: limit como string se rechaza', async () => {
  const d = builtRepo();
  const r = await callTool(d, 'trail_find_code', { query: 'add', limit: '3' } as any);
  assert.equal(r.isError, true);
  assert.equal(r.text, 'invalid argument "limit" for trail_find_code: expected number, got string');
  assert.doesNotMatch(r.text, /src\/math\.ts/);
});

test('Scenario: query numérica se rechaza', async () => {
  const d = builtRepo();
  const r = await callTool(d, 'trail_find_code', { query: 123 } as any);
  assert.equal(r.isError, true);
  assert.equal(r.text, 'invalid argument "query" for trail_find_code: expected string, got number');
});

test('Scenario: booleano como string se rechaza', async () => {
  const d = builtRepo();
  const r = await callTool(d, 'trail_find_all', { pattern: 'add', fixed: 'true' } as any);
  assert.equal(r.isError, true);
  assert.equal(r.text, 'invalid argument "fixed" for trail_find_all: expected boolean, got string');
});

test('Scenario: varios valores inválidos en orden del schema', async () => {
  const bare = mkdtempSync(join(tmpdir(), 'mcp-args-bare-'));
  const r = await callTool(bare, 'trail_find_all', {
    pattern: 'x',
    fixed: 'a',
    ignore_case: 'b',
  } as any);
  assert.equal(r.isError, true);
  assert.equal(
    r.text,
    'invalid argument "ignore_case" for trail_find_all: expected boolean, got string; invalid argument "fixed": expected boolean, got string',
  );
});

test('Scenario: null cuenta como ausente y el rango no se valida', async () => {
  const d = builtRepo();
  const r1 = await callTool(d, 'trail_find_code', { query: 'add', limit: null } as any);
  assert.doesNotMatch(r1.text, /invalid argument/);
  const r2 = await callTool(d, 'trail_find_code', { query: 'add', limit: 0 });
  assert.doesNotMatch(r2.text, /invalid argument/);
});

test('Scenario: valores bien tipados siguen funcionando', async () => {
  const d = builtRepo();
  const r1 = await callTool(d, 'trail_find_all', {
    pattern: 'add',
    fixed: true,
    ignore_case: false,
  });
  assert.equal(r1.isError, false);
  assert.match(r1.text, /add/);
  const r2 = await callTool(d, 'trail_find_code', { query: 'add', limit: 3 });
  assert.equal(r2.isError, false);
  assert.match(r2.text, /add/);
});

// ── Requirement: Valores enumerados ──────────────────────────────────────────

test('Scenario: direction inválida', async () => {
  const d = builtRepo();
  const r = await callTool(d, 'trail_trace_calls', { symbol: 'add', direction: 'up' } as any);
  assert.equal(r.isError, true);
  assert.equal(
    r.text,
    'invalid argument "direction" for trail_trace_calls: expected "in" or "out", got "up"',
  );
});

// ── Requirement: Valor de depth ───────────────────────────────────────────────

test('Scenario: depth como string numérico se rechaza', async () => {
  const d = builtRepo();
  const r = await callTool(d, 'trail_trace_calls', { symbol: 'add', depth: '3' } as any);
  assert.equal(r.isError, true);
  assert.equal(
    r.text,
    'invalid argument "depth" for trail_trace_calls: expected number or "all", got "3"',
  );
});

test('Scenario: depth number, all y full pasan', async () => {
  const d = builtRepo();
  const r1 = await callTool(d, 'trail_trace_calls', { symbol: 'add', depth: 2 });
  assert.doesNotMatch(r1.text, /invalid argument/);
  const r2 = await callTool(d, 'trail_trace_calls', { symbol: 'add', depth: 'all' } as any);
  assert.doesNotMatch(r2.text, /invalid argument/);
  const r3 = await callTool(d, 'trail_trace_calls', { symbol: 'add', depth: 'full' } as any);
  assert.doesNotMatch(r3.text, /invalid argument/);
});

// ── Requirement: Argumentos que no son un objeto ─────────────────────────────

test('Scenario: arguments es un array — callTool directo', async () => {
  const bare = mkdtempSync(join(tmpdir(), 'mcp-args-bare-'));
  const r = await callTool(bare, 'trail_find_all', ['add'] as any);
  assert.equal(r.isError, true);
  assert.equal(r.text, 'arguments for trail_find_all must be an object');
});

// ── Requirement: Validación antes de cualquier trabajo ───────────────────────

test('Scenario: la validación no toca disco — dir sin grafo retorna error de validación', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-args-nodisk-'));
  const r = await callTool(dir, 'trail_find_all', { query: 'x' });
  assert.equal(r.isError, true);
  assert.match(r.text, /unknown argument "query"/);
  // A "no graph" message would indicate validation didn't fire first
  assert.doesNotMatch(r.text, /graft build/);
  // Directory should not have been modified (no graft/ subdir created)
  assert.equal(existsSync(join(dir, 'graft')), false);
});

test('Scenario: nombre antiguo se valida contra el schema actual', async () => {
  const bare = mkdtempSync(join(tmpdir(), 'mcp-args-bare-'));
  const r = await callTool(bare, 'graft_grep', { query: 'x' });
  assert.equal(r.isError, true);
  assert.match(r.text, /for trail_find_all/);
});

// ── Requirement: Tool inexistente ─────────────────────────────────────────────

test('Scenario: tool inexistente', async () => {
  const bare = mkdtempSync(join(tmpdir(), 'mcp-args-bare-'));
  const r = await callTool(bare, 'trail_nope', {});
  assert.equal(r.isError, true);
  assert.match(r.text, /^unknown tool "trail_nope"; available: trail_set_scope, trail_find_code,/);
});

// ── Requirement: Sinónimo file de trace_calls ────────────────────────────────

test('Scenario: trace_calls con file — sinónimo no anunciado no se rechaza', async () => {
  const d = builtRepo();
  const r = await callTool(d, 'trail_trace_calls', { file: 'src/math.ts', depth: 2 } as any);
  assert.equal(r.isError, false);
  assert.match(r.text, /src\/math\.ts/);
});

// ── Requirement: Schemas con additionalProperties false ──────────────────────

test('Scenario: todos los schemas lo declaran', () => {
  for (const t of TOOLS) {
    const schema = t.inputSchema as { additionalProperties?: unknown };
    assert.equal(
      schema.additionalProperties,
      false,
      `${t.name}: inputSchema.additionalProperties should be false`,
    );
  }
});

// ── Requirement: El validador deriva todo del schema ─────────────────────────

test('Scenario: toda clave desconocida se rechaza en toda tool — recorrido zzz_desconocida', async () => {
  const bare = mkdtempSync(join(tmpdir(), 'mcp-args-zzz-'));
  for (const t of TOOLS) {
    const args = { ...REQUIRED_VALID[t.name], zzz_desconocida: 1 } as any;
    const r = await callTool(bare, t.name, args);
    assert.equal(r.isError, true, `${t.name}: should be isError for zzz_desconocida`);
    assert.match(
      r.text,
      new RegExp(`unknown argument "zzz_desconocida" for ${t.name}`),
      `${t.name}: message should name zzz_desconocida`,
    );
  }
});

test('Scenario: todo valor mal tipado se rechaza en toda tool — recorrido 19 props', async () => {
  const bare = mkdtempSync(join(tmpdir(), 'mcp-args-typed-'));

  /** [toolName, propName, wrongValue] — 19 entries, depth excluded */
  const cases: [string, string, unknown][] = [
    // trail_set_scope
    ['trail_set_scope',      'path',        5],
    // trail_find_code
    ['trail_find_code',      'query',       5],
    ['trail_find_code',      'limit',       'x'],
    ['trail_find_code',      'full',        'x'],
    ['trail_find_code',      'in',          5],
    // trail_file_api
    ['trail_file_api',       'file',        5],
    // trail_build
    ['trail_build',          'include_md',  'yes'],
    ['trail_build',          'semantic',    'yes'],
    // trail_trace_calls (depth excluded, direction via wrong-type number)
    ['trail_trace_calls',    'symbol',      5],
    ['trail_trace_calls',    'direction',   5],
    ['trail_trace_calls',    'in',          5],
    // trail_find_all
    ['trail_find_all',       'pattern',     5],
    ['trail_find_all',       'in',          5],
    ['trail_find_all',       'ignore_case', 'x'],
    ['trail_find_all',       'fixed',       'x'],
    // trail_repo_map
    ['trail_repo_map',       'max_dirs',    'x'],
    // trail_search_semantic
    ['trail_search_semantic', 'query',      5],
    ['trail_search_semantic', 'limit',      'x'],
    ['trail_search_semantic', 'in',         5],
  ];
  assert.equal(cases.length, 19, 'must have exactly 19 cases');

  for (const [toolName, prop, wrongVal] of cases) {
    const req = REQUIRED_VALID[toolName] ?? {};
    const args = { ...req, [prop]: wrongVal } as any;
    const r = await callTool(bare, toolName, args);
    assert.equal(r.isError, true, `${toolName}.${prop}: should be isError`);
    assert.match(
      r.text,
      new RegExp(`invalid argument "${prop}"`),
      `${toolName}.${prop}: message should contain invalid argument`,
    );
    assert.match(
      r.text,
      /, got /,
      `${toolName}.${prop}: message should contain ", got "`,
    );
  }
});

// ── Requirement: Descripciones genéricas ─────────────────────────────────────

test('Scenario: descripciones sin rutas de un workspace concreto', () => {
  for (const t of TOOLS) {
    const schema = t.inputSchema as {
      properties?: Record<string, { description?: string }>;
    };
    const descSources = [
      t.description,
      ...Object.values(schema.properties ?? {}).map((p) => p.description ?? ''),
    ];
    for (const desc of descSources) {
      assert.doesNotMatch(desc, /default-core/, `${t.name}: description should not contain "default-core"`);
      assert.doesNotMatch(desc, /Desarrollo/, `${t.name}: description should not contain "Desarrollo"`);
      assert.doesNotMatch(desc, /C:\/Users/, `${t.name}: description should not contain "C:/Users"`);
      assert.doesNotMatch(desc, /graft_/, `${t.name}: description should not contain "graft_"`);
    }
  }
});

test('Scenario: la descripción de trail_set_scope no promete estado de sesión', () => {
  const def = TOOLS.find((t) => t.name === 'trail_set_scope');
  assert.ok(def, 'trail_set_scope should be in TOOLS');
  assert.match(def!.description, /keeps no session scope/);
  assert.doesNotMatch(def!.description, /subsequent trail queries in this session/);
});

// ── Requirement: callTool no atiende set_scope ───────────────────────────────

test('Scenario: callTool con set_scope válido retorna handled-by-server', async () => {
  const bare = mkdtempSync(join(tmpdir(), 'mcp-args-bare-'));
  const r = await callTool(bare, 'trail_set_scope', { path: 'x' });
  assert.equal(r.isError, true);
  assert.equal(r.text, 'trail_set_scope is handled by the MCP server, not by callTool');
});

// ── Requirement: Guards con el nombre anunciado ───────────────────────────────

test('Scenario: ningún mensaje de tools.ts nombra graft_', async () => {
  // The guards in callWorkspaceTool and callSingleTool (requires a non-empty)
  // must use trail_* names. We trigger them by passing empty strings.
  const bare = mkdtempSync(join(tmpdir(), 'mcp-args-bare-'));
  // trace_calls workspace guard (this won't reach workspace mode on a bare dir,
  // but callWorkspaceTool is only reached when readWorkspace returns non-null;
  // for single-graph path, the guard fires in callSingleTool).
  const d = builtRepo();

  const guards: [string, Record<string, unknown>][] = [
    ['trail_find_code',      { query: '' }],
    ['trail_trace_calls',    { symbol: '' }],
    ['trail_find_all',       { pattern: '' }],
    ['trail_search_semantic', { query: '' }],
    ['trail_file_api',       { file: '' }],
  ];
  for (const [toolName, args] of guards) {
    const r = await callTool(d, toolName, args);
    assert.equal(r.isError, true, `${toolName}: should be isError for empty arg`);
    assert.doesNotMatch(
      r.text,
      /graft_/,
      `${toolName}: guard message must not contain "graft_"`,
    );
  }
});

// ── stdio: set_scope, build, scope injection ─────────────────────────────────

test('Scenario: set_scope con paths en vez de path — stdio', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-args-srv-'));
  const rs = await rpc(
    [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'trail_set_scope', arguments: { paths: 'C:/x/y' } } },
    ],
    dir,
    2,
  );
  const call = rs.find((r: any) => r.id === 2);
  assert.equal(call.result.isError, true);
  assert.equal(
    call.result.content[0].text,
    'unknown argument "paths" (did you mean "path"?) for trail_set_scope; missing required argument "path"; expected one of: path',
  );
});

test('Scenario: set_scope válido devuelve el in a pasar — stdio', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-args-srv2-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  const rs = await rpc(
    [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'trail_set_scope', arguments: { path: join(dir, 'src').replace(/\\/g, '/') } } },
    ],
    dir,
    2,
  );
  const call = rs.find((r: any) => r.id === 2);
  assert.equal(call.result.isError, false);
  assert.match(call.result.content[0].text, /pass in: "src"/);
});

test('Scenario: set_scope con la raíz del workspace devuelve el workspace completo — stdio', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-args-srv-root-'));
  const rs = await rpc(
    [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'trail_set_scope', arguments: { path: dir.replace(/\\/g, '/') + '/' } } },
    ],
    dir,
    2,
  );
  const call = rs.find((r: any) => r.id === 2);
  assert.equal(call.result.isError, false, 'the workspace root must be accepted, so a scope can be cleared');
  assert.match(call.result.content[0].text, /scope: whole workspace/);
});

test('Scenario: set_scope de un cliente no acota la consulta siguiente — stdio', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-args-nostat-scope-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'lib'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.ts'), 'export function alpha(): number {\n  return 1;\n}\n');
  writeFileSync(join(dir, 'lib', 'b.ts'), 'export function beta(): number {\n  return 2;\n}\n');
  execFileSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'build', dir], { stdio: 'pipe' });
  const rs = await rpc(
    [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      // Client A pins the scope to src/ ...
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'trail_set_scope', arguments: { path: join(dir, 'src').replace(/\\/g, '/') } } },
      // ... and a query from any client still sees the whole workspace.
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'trail_find_all', arguments: { pattern: 'beta' } } },
    ],
    dir,
    3,
  );
  const set = rs.find((r: any) => r.id === 2);
  const grep = rs.find((r: any) => r.id === 3);
  assert.equal(set.result.isError, false, 'set_scope should succeed');
  assert.match(grep.result.content[0].text, /lib\/b\.ts/,
    'a query must not inherit the scope set by another client');
});

test('Scenario: set_scope con path de tipo inválido — stdio', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-args-srv3-'));
  const rs = await rpc(
    [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'trail_set_scope', arguments: { path: 5 } } },
    ],
    dir,
    2,
  );
  const call = rs.find((r: any) => r.id === 2);
  assert.equal(call.result.isError, true);
  assert.equal(
    call.result.content[0].text,
    'invalid argument "path" for trail_set_scope: expected string, got number',
  );
});

test('Scenario: set_scope rechazado no deja rastro — stdio', async () => {
  const dir = builtRepo();
  const srcPath = join(dir, 'src').replace(/\\/g, '/');
  const rs = await rpc(
    [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      // 1. Set scope to src
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'trail_set_scope', arguments: { path: srcPath } } },
      // 2. Try invalid set_scope (wrong key) — must be rejected, scope unchanged
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'trail_set_scope', arguments: { paths: srcPath + '/other' } } },
      // 3. Query — scope should still be src (finds results, not "unknown argument")
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'trail_find_code', arguments: { query: 'add' } } },
    ],
    dir,
    4,
  );
  const setOk  = rs.find((r: any) => r.id === 2);
  const setErr = rs.find((r: any) => r.id === 3);
  const query  = rs.find((r: any) => r.id === 4);

  assert.equal(setOk.result.isError, false, 'first set_scope should succeed');
  assert.equal(setErr.result.isError, true,  'second set_scope (paths) should fail');
  assert.doesNotMatch(query.result.content[0].text, /unknown argument/,
    'query after rejected set_scope should not contain unknown argument error');
  assert.equal(query.result.isError, false, 'query should succeed with still-valid scope');
});

test('Scenario: build se despacha — stdio', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-args-build-'));
  const rs = await rpc(
    [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'trail_build', arguments: { semantic: false } } },
    ],
    dir,
    2,
  );
  const call = rs.find((r: any) => r.id === 2);
  assert.equal(call.result.isError, false);
  assert.match(call.result.content[0].text, /trail build started in background/);
});

test('Scenario: build con include_md como string se rechaza — stdio', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-args-build2-'));
  const rs = await rpc(
    [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'trail_build', arguments: { include_md: 'yes' } } },
    ],
    dir,
    2,
  );
  const call = rs.find((r: any) => r.id === 2);
  assert.equal(call.result.isError, true);
  assert.equal(
    call.result.content[0].text,
    'invalid argument "include_md" for trail_build: expected boolean, got string',
  );
});

test('Scenario: tras set_scope, una tool sin `in` sigue funcionando — stdio', async () => {
  const dir = builtRepo();
  const srcPath = join(dir, 'src').replace(/\\/g, '/');
  const rs = await rpc(
    [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'trail_set_scope', arguments: { path: srcPath } } },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'trail_check_freshness', arguments: {} } },
    ],
    dir,
    3,
  );
  const check = rs.find((r: any) => r.id === 3);
  assert.doesNotMatch(check.result.content[0].text, /unknown argument/);
  assert.equal(check.result.isError, false);
});

test('Scenario: array con scope fijado — stdio', async () => {
  const dir = builtRepo();
  const srcPath = join(dir, 'src').replace(/\\/g, '/');
  const rs = await rpc(
    [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'trail_set_scope', arguments: { path: srcPath } } },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'trail_find_all', arguments: ['add'] } },
    ],
    dir,
    3,
  );
  const call = rs.find((r: any) => r.id === 3);
  assert.equal(call.result.isError, true);
  assert.equal(call.result.content[0].text, 'arguments for trail_find_all must be an object');
});

// ── Requirement: Validación de ruta en set_scope ──────────────────────────────

test('Scenario: set_scope con ruta inexistente retorna isError — stdio', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-args-nonexist-'));
  const rs = await rpc(
    [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'trail_set_scope', arguments: { path: dir.replace(/\\/g, '/') + '/does-not-exist' } } },
    ],
    dir,
    2,
  );
  const call = rs.find((r: any) => r.id === 2);
  assert.equal(call.result.isError, true);
  assert.match(call.result.content[0].text, /is not an existing directory/);
});

test('Scenario: set_scope con un archivo retorna isError — stdio', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-args-file-'));
  const filePath = join(dir, 'file.ts');
  writeFileSync(filePath, 'export const x = 1;\n');
  const rs = await rpc(
    [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'trail_set_scope', arguments: { path: filePath.replace(/\\/g, '/') } } },
    ],
    dir,
    2,
  );
  const call = rs.find((r: any) => r.id === 2);
  assert.equal(call.result.isError, true);
  assert.match(call.result.content[0].text, /is not an existing directory/);
});
