/**
 * Verifica que la salida de las tools de trail:
 *   1. No contiene frases imperativas dirigidas al modelo.
 *   2. La nota de cobertura del workspace solo aparece sin resultados.
 *   3. La línea de ahorro usa separador de miles con coma (en-US), sea cual sea el locale.
 *   4. formatSessionStats usa el mismo separador.
 *
 * Para que los escenarios de miles sean ROJOS sobre la base en cualquier máquina
 * (incluido en-US), el test reemplaza Number.prototype.toLocaleString para que,
 * sin argumento de locale, delegue en "es-CL". Tras el fix el código pasa el locale
 * explícito ("en-US") y no queda afectado por este override.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildGraph } from '../src/graph/build.js';
import { contextDirFor } from '../src/context/node-file.js';
import { splitWorkspace } from '../src/graph/workspace.js';
import { callTool } from '../src/mcp/tools.js';
import { savingsLine, sumSavingsFooters, setInputRate } from '../src/context/savings.js';
import { formatSessionStats } from '../src/claude/session-metrics.js';

// ── Locale override ───────────────────────────────────────────────────────────
// Reemplaza toLocaleString() sin args para delegar en "es-CL", de modo que las
// aserciones de formato de miles fallen sobre la base en cualquier host locale.
// Después del fix, el código pasa "en-US" explícito y no depende del override.
const _origToLocaleString = Number.prototype.toLocaleString;

// ── Fixtures ──────────────────────────────────────────────────────────────────
// Archivo grande: > 40 000 caracteres para que savingsLine produzca una línea
// (savings.ts:119: si base <= pack, devuelve "")
const BIG_COMMENT = `// ${"x".repeat(42000)}`;

let repoDir = ''; // fixture (a): repo único
let wsDir = '';   // fixture (b): workspace con repoC sin grafo

before(async () => {
  // Instalar override de locale
  Number.prototype.toLocaleString = function (
    locale?: string | string[],
    ...rest: Parameters<typeof _origToLocaleString>[1][]
  ) {
    return _origToLocaleString.call(this, locale ?? 'es-CL', ...rest);
  } as typeof Number.prototype.toLocaleString;

  // ── fixture (a): repo único ─────────────────────────────────────────────
  repoDir = mkdtempSync(join(tmpdir(), 'trail17-repo-'));
  mkdirSync(join(repoDir, 'src'), { recursive: true });
  // big.ts: > 40 000 chars y define needleFn
  writeFileSync(
    join(repoDir, 'src', 'big.ts'),
    `${BIG_COMMENT}\nexport function needleFn(): number { return 42; }\n`,
  );
  // use.ts: llama a needleFn (crea una arista en el grafo)
  writeFileSync(
    join(repoDir, 'src', 'use.ts'),
    `import { needleFn } from './big.js';\nexport function useFn(): number { return needleFn(); }\n`,
  );
  execFileSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'build', repoDir], {
    stdio: 'pipe',
  });

  // ── fixture (b): workspace repoA + repoB + repoC (sin grafo) ───────────
  wsDir = mkdtempSync(join(tmpdir(), 'trail17-ws-'));
  const wsRepos: Record<string, string> = {
    // repoA: > 40 000 chars + alphaHandler (para que find_code genere savings)
    repoA: `${BIG_COMMENT}\nexport function alphaHandler() { return 1; }\n`,
    repoB: 'export function betaFn() { return 2; }\n',
    repoC: 'export function gammaFn() { return 3; }\n',
  };
  for (const [name, content] of Object.entries(wsRepos)) {
    mkdirSync(join(wsDir, name, '.git'), { recursive: true });
    writeFileSync(join(wsDir, name, 'a.ts'), content);
  }
  await splitWorkspace(wsDir, undefined, async (childDir) => {
    await buildGraph(childDir);
  });
  // Simular que repoC nunca fue construido
  rmSync(contextDirFor(join(wsDir, 'repoC')), { recursive: true, force: true });
});

after(async () => {
  // Restaurar toLocaleString original
  Number.prototype.toLocaleString = _origToLocaleString;
  // Limpiar fixtures
  if (repoDir) rmSync(repoDir, { recursive: true, force: true });
  if (wsDir) rmSync(wsDir, { recursive: true, force: true });
  // Resetear inputRate
  setInputRate(null);
});

// ══════════════════════════════════════════════════════════════════════════════
// 1. Frases prohibidas — ninguna tool debe contenerlas (escenario spec §1)
// ══════════════════════════════════════════════════════════════════════════════

const FORBIDDEN = ['tell the user', 'at the end of your reply', 'sum each such line'];

function assertNoForbidden(text: string, toolName: string): void {
  for (const phrase of FORBIDDEN) {
    assert.ok(
      !text.toLowerCase().includes(phrase),
      `${toolName}: la salida NO debe contener "${phrase}"\n---\n${text.slice(0, 400)}\n---`,
    );
  }
}

test('find_code con ahorro no trae la orden al modelo', async () => {
  const r = await callTool(repoDir, 'graft_find_code', { query: 'needleFn' });
  assert.equal(r.isError, false);
  // Presencia: la línea de ahorro (garantiza que el fixture es suficientemente grande)
  assert.match(r.text, /tokens saved ≈/i, 'la salida debe contener la línea de ahorro (fixture > 40k)');
  assertNoForbidden(r.text, 'graft_find_code');
});

test('find_code en repo único: línea de ahorro usa coma como separador de miles (en-US)', async () => {
  // big.ts tiene ~42 000 chars → delta >1 000 tokens → el número lleva al menos una coma.
  // Con el override activo (es-CL), sin 'en-US' explícito se obtienen puntos → test rojo.
  // Sabotaje S8: quitar 'en-US' en askSavingsLine (ask.ts:1584-1586) → este test falla.
  const r = await callTool(repoDir, 'graft_find_code', { query: 'needleFn' });
  assert.equal(r.isError, false);
  // Presencia: línea de ahorro existe
  assert.match(r.text, /tokens saved ≈/i, 'la salida debe contener la línea de ahorro');
  // Miles con coma (en-US): el número tras «≈» contiene al menos una coma
  assert.match(
    r.text,
    /tokens saved ≈ \d{1,3}(,\d{3})+/,
    'askSavingsLine debe usar coma como separador de miles (en-US); sin en-US → es-CL forzado → puntos',
  );
  // sumSavingsFooters debe poder parsear el número de la salida
  const parsed = sumSavingsFooters(r.text);
  assert.ok(parsed > 1000, `sumSavingsFooters debe devolver >1000 (obtenido: ${parsed})`);
});

test('las demás tools de repo único tampoco traen la orden', async () => {
  // graft_find_all: presencia de needleFn en el resultado
  const findAll = await callTool(repoDir, 'graft_find_all', { pattern: 'needleFn' });
  assert.match(findAll.text, /needleFn/, 'graft_find_all debe mencionar needleFn (presencia)');
  assertNoForbidden(findAll.text, 'graft_find_all');

  // graft_trace_calls: needleFn tiene un caller (useFn en use.ts)
  const trace = await callTool(repoDir, 'graft_trace_calls', { symbol: 'needleFn' });
  assert.match(trace.text, /needleFn|useFn/, 'graft_trace_calls debe mencionar needleFn o su caller (presencia)');
  assertNoForbidden(trace.text, 'graft_trace_calls');

  // graft_file_api: src/big.ts contiene needleFn
  const fileApi = await callTool(repoDir, 'graft_file_api', { file: 'src/big.ts' });
  assert.match(fileApi.text, /needleFn|big\.ts/, 'graft_file_api debe mencionar needleFn o big.ts (presencia)');
  assertNoForbidden(fileApi.text, 'graft_file_api');

  // graft_repo_map: devuelve contenido propio (mapa del repo)
  const repoMap = await callTool(repoDir, 'graft_repo_map', {});
  assert.ok(repoMap.text.length > 0, 'graft_repo_map debe devolver contenido no vacío (presencia)');
  assertNoForbidden(repoMap.text, 'graft_repo_map');

  // graft_check_freshness: devuelve contenido propio
  const fresh = await callTool(repoDir, 'graft_check_freshness', {});
  assert.ok(fresh.text.length > 0, 'graft_check_freshness debe devolver contenido no vacío (presencia)');
  assertNoForbidden(fresh.text, 'graft_check_freshness');
});

test('tools de workspace tampoco traen la orden al modelo', async () => {
  // graft_find_code en workspace: alphaHandler existe en repoA
  const fc = await callTool(wsDir, 'graft_find_code', { query: 'alphaHandler' });
  assert.match(fc.text, /alphaHandler/, 'graft_find_code (ws) debe mencionar alphaHandler (presencia)');
  assertNoForbidden(fc.text, 'graft_find_code (workspace)');

  // graft_find_all en workspace
  const fa = await callTool(wsDir, 'graft_find_all', { pattern: 'alphaHandler' });
  assert.match(fa.text, /alphaHandler/, 'graft_find_all (ws) debe mencionar alphaHandler (presencia)');
  assertNoForbidden(fa.text, 'graft_find_all (workspace)');

  // graft_trace_calls en workspace: alphaHandler existe en repoA (found:true)
  const tc = await callTool(wsDir, 'graft_trace_calls', { symbol: 'alphaHandler' });
  assert.match(tc.text, /alphaHandler/, 'graft_trace_calls (ws) debe mencionar alphaHandler (presencia)');
  assertNoForbidden(tc.text, 'graft_trace_calls (workspace)');

  // graft_repo_map en workspace
  const rm = await callTool(wsDir, 'graft_repo_map', {});
  assert.ok(rm.text.length > 0, 'graft_repo_map (ws) debe devolver contenido no vacío (presencia)');
  assertNoForbidden(rm.text, 'graft_repo_map (workspace)');

  // graft_check_freshness en workspace
  const cf = await callTool(wsDir, 'graft_check_freshness', {});
  assert.ok(cf.text.length > 0, 'graft_check_freshness (ws) debe devolver contenido no vacío (presencia)');
  assertNoForbidden(cf.text, 'graft_check_freshness (workspace)');
});

// ══════════════════════════════════════════════════════════════════════════════
// 2. Nota de cobertura del workspace (escenario spec §4)
// ══════════════════════════════════════════════════════════════════════════════

test('find_code alphaHandler en workspace: contiene repoA/ y NO la nota de cobertura', async () => {
  const r = await callTool(wsDir, 'graft_find_code', { query: 'alphaHandler' });
  assert.equal(r.isError, false);
  // Presencia: resultado de repoA
  assert.match(r.text, /repoA\//, 'la salida debe contener repoA/ (hit encontrado)');
  // Ausencia: nota de cobertura
  assert.ok(
    !r.text.includes('workspace repos have graphs'),
    `find_code con resultados NO debe traer nota de cobertura\n---\n${r.text.slice(0, 400)}\n---`,
  );
});

test('find_all zzzNoExisteZzz en workspace: contiene nota "2 of 3 workspace repos have graphs"', async () => {
  const r = await callTool(wsDir, 'graft_find_all', { pattern: 'zzzNoExisteZzz' });
  assert.equal(r.isError, false);
  assert.match(r.text, /2 of 3 workspace repos have graphs/,
    'sin resultados, la nota de cobertura debe aparecer');
});

test('find_all alphaHandler en workspace: contiene hits y NO la nota de cobertura', async () => {
  const r = await callTool(wsDir, 'graft_find_all', { pattern: 'alphaHandler' });
  assert.equal(r.isError, false);
  // Presencia: hits de repoA
  assert.match(r.text, /repoA\//, 'la salida debe contener repoA/ (hit encontrado)');
  // Ausencia: nota de cobertura
  assert.ok(
    !r.text.includes('workspace repos have graphs'),
    `find_all con resultados NO debe traer nota de cobertura\n---\n${r.text.slice(0, 400)}\n---`,
  );
});

test('trace_calls alphaHandler en workspace con resultados: NO trae nota de cobertura', async () => {
  // alphaHandler existe en repoA → found:true → el texto NO incluye cov.
  // Sabotaje S5: añadir «text += cov» en federateCallers found:true (workspace.ts:779) → este test falla.
  const r = await callTool(wsDir, 'graft_trace_calls', { symbol: 'alphaHandler' });
  // Presencia: la salida menciona alphaHandler
  assert.match(r.text, /alphaHandler/, 'la salida debe mencionar alphaHandler (presencia)');
  // Ausencia: sin nota de cobertura en el camino found:true
  assert.ok(
    !r.text.includes('workspace repos have graphs'),
    `trace_calls con resultados NO debe traer nota de cobertura\n---\n${r.text.slice(0, 400)}\n---`,
  );
  assertNoForbidden(r.text, 'graft_trace_calls (workspace con resultados)');
});

test('trace_calls zzzNoExisteZzz en workspace sin resultados: trae nota de cobertura', async () => {
  // found:false → el texto incluye cov («2 of 3 workspace repos have graphs»)
  const r = await callTool(wsDir, 'graft_trace_calls', { symbol: 'zzzNoExisteZzz' });
  assert.match(
    r.text,
    /2 of 3 workspace repos have graphs/,
    'sin resultados, la nota de cobertura debe aparecer',
  );
});

test('repo_map y check_freshness del workspace siempre traen la nota de cobertura', async () => {
  const map = await callTool(wsDir, 'graft_repo_map', {});
  assert.match(map.text, /2 of 3 workspace repos have graphs/,
    'repo_map debe contener la nota de cobertura');

  const fresh = await callTool(wsDir, 'graft_check_freshness', {});
  assert.match(fresh.text, /2 of 3 workspace repos have graphs/,
    'check_freshness debe contener la nota de cobertura');
});

// ══════════════════════════════════════════════════════════════════════════════
// 3. Separador de miles en la línea de ahorro (escenario spec §2)
// ══════════════════════════════════════════════════════════════════════════════

// Cuerpo de 1 000 chars y baseline de 4 000 000 chars:
//   pack  = round(1000 / 4)        =   250 tokens
//   base  = round(4_000_000 / 4)   = 1_000_000 tokens
//   delta = 1_000_000 - 250        =   999_750 tokens
const BODY_1K = 'x'.repeat(1000);
const SAVINGS_4M = { files: 1, baselineChars: 4_000_000 };

test('savingsLine: miles con coma aunque el locale sea es-CL', () => {
  setInputRate(null); // sin tarifa
  const line = savingsLine(BODY_1K, SAVINGS_4M);
  // Presencia de la línea
  assert.match(line, /tokens saved ≈/i, 'debe haber una línea de ahorro');
  // Miles con coma (en-US)
  assert.match(line, /tokens saved ≈ 999,750 \(/,
    'el delta de 999 750 debe imprimirse con coma: 999,750');
  // sumSavingsFooters debe poder parsear el número
  assert.equal(sumSavingsFooters(line), 999_750,
    'sumSavingsFooters debe devolver 999750');
});

test('savingsLine: la línea no se emite cuando no hay ahorro', () => {
  // body mayor que el baseline → base <= pack → ""
  const bigBody = 'x'.repeat(4_000_001);
  const line = savingsLine(bigBody, SAVINGS_4M);
  assert.equal(line, '', 'sin ahorro la línea debe ser vacía');
  assert.ok(!line.includes('tokens saved'), 'sin ahorro no debe haber "tokens saved"');
});

test('savingsLine: con tarifa, incluye el valor en dólares', () => {
  setInputRate(3); // $3/Mtok
  // body vacío, baseline 4M → delta = 1_000_000 tokens → usd = 1_000_000 * 3 / 1_000_000 = $3.00
  const line = savingsLine('', SAVINGS_4M);
  assert.match(line, /\$3\.00/, 'con tarifa $3/Mtok y 1M tokens la línea debe contener $3.00');
  assert.equal(sumSavingsFooters(line), 1_000_000, 'sumSavingsFooters debe devolver 1000000');
  setInputRate(null); // restaurar
});

test('savingsLine: sin tarifa, no hay $', () => {
  setInputRate(null);
  const line = savingsLine('', SAVINGS_4M);
  assert.ok(!line.includes('$'), 'sin tarifa la línea no debe contener $');
});

// ══════════════════════════════════════════════════════════════════════════════
// 4. formatSessionStats usa el mismo separador de miles (escenario spec §3)
// ══════════════════════════════════════════════════════════════════════════════

test('formatSessionStats contiene ~12,345 con locale es-CL (P5=2)', () => {
  const out = formatSessionStats({ id: 'abc', graftReads: 8, sourceReads: 2, savedTokens: 12345 });
  assert.match(out, /~12,345/, 'tokens saved debe usar coma como separador de miles');
  assert.ok(!out.includes('12.345'), 'no debe usar punto como separador de miles');
});
