/**
 * Unit tests for `resolveScope` (src/mcp/scope.ts).
 *
 * All filesystem dependencies are injected so every branch runs on any OS
 * without real paths.
 *
 * Run with:
 *   GRAFT_NO_TRAIL_SWITCH=1 node --import tsx --test test/scope.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveScope } from '../src/mcp/scope.js';

// A no-op isDir that always says "yes it's a directory"
const IS_DIR_YES = (): boolean => true;
// A no-op isDir that always says "not a directory / doesn't exist"
const IS_DIR_NO  = (): boolean => false;

// ── Success cases ─────────────────────────────────────────────────────────────

test('scope.ts: sub-ruta retorna in con pass in: "<rel>"', () => {
  const r = resolveScope('/w', '/w/src', { isDir: IS_DIR_YES });
  assert.equal(r.ok, true);
  assert.match(r.text, /pass in: "src"/);
  assert.match(r.text, /this server keeps no per-session scope/);
});

test('scope.ts: raíz del workspace retorna scope: whole workspace', () => {
  const r = resolveScope('/w', '/w', { isDir: IS_DIR_YES });
  assert.equal(r.ok, true);
  assert.match(r.text, /scope: whole workspace/);
  assert.match(r.text, /omit "in"/);
});

test('scope.ts: raíz con barra final retorna scope: whole workspace', () => {
  const r = resolveScope('/w', '/w/', { isDir: IS_DIR_YES });
  assert.equal(r.ok, true);
  assert.match(r.text, /scope: whole workspace/);
});

test('scope.ts: string vacío retorna scope: whole workspace', () => {
  const r = resolveScope('/w', '', { isDir: IS_DIR_YES });
  assert.equal(r.ok, true);
  assert.match(r.text, /scope: whole workspace/);
});

test('scope.ts: rel preserva mayúsculas del llamador', () => {
  const r = resolveScope('/w', '/w/MyModule', { isDir: IS_DIR_YES });
  assert.equal(r.ok, true);
  assert.match(r.text, /pass in: "MyModule"/);
});

// ── Error: fuera de la raíz ───────────────────────────────────────────────────

test('scope.ts: path fuera de la raíz retorna isError con texto de no scope resolved', () => {
  const r = resolveScope('/w', '/otro/repo', { isDir: IS_DIR_YES });
  assert.equal(r.ok, false);
  assert.match(r.text, /is not under the server workspace/);
  assert.match(r.text, /no scope resolved/);
});

// ── Error (a): segmento ".." ──────────────────────────────────────────────────

test('scope.ts: path con segmento ".." es rechazado (regla a)', () => {
  const r = resolveScope('/w', '/w/foo/../bar', { isDir: IS_DIR_YES });
  assert.equal(r.ok, false);
  assert.match(r.text, /contains ".." segments/);
});

test('scope.ts: ".." al inicio del relativo es rechazado', () => {
  const r = resolveScope('/w', '/w/../w/src', { isDir: IS_DIR_YES });
  // /w/../w/src starts with /w/ so rule 3 passes; rule 4 catches ".."
  assert.equal(r.ok, false);
  assert.match(r.text, /contains ".." segments/);
});

test('scope.ts: "..a" y "a.." no son segmentos ".."', () => {
  const r1 = resolveScope('/w', '/w/..a/src', { isDir: IS_DIR_YES });
  assert.equal(r1.ok, true);
  const r2 = resolveScope('/w', '/w/a../src', { isDir: IS_DIR_YES });
  assert.equal(r2.ok, true);
});

// ── Error (b): ruta inexistente / Error (c): existe pero no es directorio ─────

test('scope.ts: ruta inexistente es rechazada (regla b) — isDir inyectado devuelve false', () => {
  const r = resolveScope('/w', '/w/no-existe', { isDir: IS_DIR_NO });
  assert.equal(r.ok, false);
  assert.match(r.text, /is not an existing directory/);
});

test('scope.ts: ruta que es archivo es rechazada (regla c) — isDir inyectado devuelve false', () => {
  const r = resolveScope('/w', '/w/file.ts', { isDir: IS_DIR_NO });
  assert.equal(r.ok, false);
  assert.match(r.text, /is not an existing directory/);
});

// ── Error/OK (d): comparación de mayúsculas en Windows ───────────────────────

test('scope.ts: c:/ vs C:/ es aceptado cuando caseInsensitive=true (regla d)', () => {
  const r = resolveScope('C:/workspace', 'c:/workspace/src', {
    caseInsensitive: true,
    isDir: IS_DIR_YES,
  });
  assert.equal(r.ok, true);
  assert.match(r.text, /pass in: "src"/);
});

test('scope.ts: c:/ vs C:/ es rechazado cuando caseInsensitive=false', () => {
  const r = resolveScope('C:/workspace', 'c:/workspace/src', {
    caseInsensitive: false,
    isDir: IS_DIR_YES,
  });
  assert.equal(r.ok, false);
  assert.match(r.text, /is not under the server workspace/);
});

test('scope.ts: mismas mayúsculas en raíz siempre funciona (caseInsensitive=false)', () => {
  const r = resolveScope('C:/workspace', 'C:/workspace/src', {
    caseInsensitive: false,
    isDir: IS_DIR_YES,
  });
  assert.equal(r.ok, true);
  assert.match(r.text, /pass in: "src"/);
});

test('scope.ts: carpeta con distinta mayúscula en subpath es aceptada (solo la raíz compara CI)', () => {
  // caseInsensitive only applies to the root prefix check; rel is kept as-is
  const r = resolveScope('C:/workspace', 'c:/workspace/SRC', {
    caseInsensitive: true,
    isDir: IS_DIR_YES,
  });
  assert.equal(r.ok, true);
  // rel is taken from the original path, not lowercased
  assert.match(r.text, /pass in: "SRC"/);
});

// ── Backslash normalization ───────────────────────────────────────────────────

test('scope.ts: serverRoot con backslashes se normaliza', () => {
  const r = resolveScope('C:\\workspace', 'C:\\workspace\\src', {
    caseInsensitive: false,
    isDir: IS_DIR_YES,
  });
  assert.equal(r.ok, true);
  assert.match(r.text, /pass in: "src"/);
});

// ── Cadenas obsoletas ausentes ────────────────────────────────────────────────

test('scope.ts: los textos de respuesta no contienen cadenas obsoletas de sesión', () => {
  const sub = resolveScope('/w', '/w/src', { isDir: IS_DIR_YES });
  const root = resolveScope('/w', '/w', { isDir: IS_DIR_YES });
  for (const r of [sub, root]) {
    assert.doesNotMatch(r.text, /in this session/);
    assert.doesNotMatch(r.text, /subsequent/);
    assert.doesNotMatch(r.text, /automatically narrow/);
    assert.doesNotMatch(r.text, /set the session scope once/);
    assert.doesNotMatch(r.text, /Fijar scope de sesi/);
    assert.doesNotMatch(r.text, /Pin every later query/);
    assert.doesNotMatch(r.text, /Pin later queries/);
    assert.doesNotMatch(r.text, /scope unchanged/);
  }
});
