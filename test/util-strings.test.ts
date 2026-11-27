/**
 * Unit tests for src/util/strings.ts (levenshtein + topSuggestions).
 *
 * Run with:
 *   node --import tsx --test test/util-strings.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { levenshtein, topSuggestions } from '../src/util/strings.js';

// ── levenshtein ───────────────────────────────────────────────────────────────

test('levenshtein: idéntico → 0', () => {
  assert.strictEqual(levenshtein('abc', 'abc'), 0);
  assert.strictEqual(levenshtein('', ''), 0);
});

test('levenshtein: cadena vacía → longitud de la otra', () => {
  assert.strictEqual(levenshtein('', 'abc'), 3);
  assert.strictEqual(levenshtein('abc', ''), 3);
});

test('levenshtein: una inserción/eliminación → 1', () => {
  assert.strictEqual(levenshtein('abc', 'abcd'), 1);  // insert d
  assert.strictEqual(levenshtein('abcd', 'abc'), 1);  // delete d
});

test('levenshtein: una sustitución → 1 (no 0)', () => {
  // Con sub=0 en la DP esta asignación retornaría 0, no 1.
  assert.strictEqual(levenshtein('abc', 'axc'), 1);  // b → x
  assert.strictEqual(levenshtein('x', 'y'), 1);      // 1 sub
});

// ── topSuggestions ────────────────────────────────────────────────────────────

test('topSuggestions: ranking por distancia no por alfabético; exactamente n; tie-break alfa', () => {
  // Pool de 6 hijos. Distancias reales desde 'core/backen' (len=11):
  //   core/backend  = 1   (inserción 'd')
  //   aa/backend    = 5
  //   zz/backend    = 5   (misma d que aa/backend; tie-break alfa: aa < zz)
  //   core/frontend = 6
  //   aaaa          = 10
  //   bbbb          = 10
  //
  // Orden alfabético (que contradice distancia):
  //   aa/backend < aaaa < bbbb < core/backend < core/frontend < zz/backend
  // Top-3 real: ['core/backend', 'aa/backend', 'zz/backend']
  //
  // Mutaciones que detecta:
  //   • sin .slice(0,3) → devuelve 6, length !== 3
  //   • sort DESC → 'aaaa','bbbb' primeros, result[0] !== 'core/backend'
  //   • sub=0 en DP → distancias cambian a |len(a)-len(b)|; aa/backend(d=1) supera
  //     a core/backend(d=1 también, len=12 vs 11) pero alfa aa < core → 'aa/backend'
  //     queda primero y el deepStrictEqual falla.
  // Pool con zz/backend ANTES de aa/backend: sin localeCompare el sort estable
  // los dejaría en ese orden (zz < aa no existe), rompiendo el assert.deepStrictEqual.
  const pool = ['zz/backend', 'core/frontend', 'bbbb', 'core/backend', 'aaaa', 'aa/backend'];
  const result = topSuggestions('core/backen', pool, 3);

  // Exactamente 3 (no 4+): prueba que .slice(0, n) opera
  assert.strictEqual(
    result.length,
    3,
    `se esperan 3 sugerencias, se obtuvieron ${result.length}: [${result.join(', ')}]`,
  );

  // Orden exacto: core/backend primero por distancia (d=1), no alfa (aa/backend iría antes).
  // aa/backend y zz/backend empatan a d=5; alfa→ aa/backend < zz/backend.
  assert.deepStrictEqual(
    result,
    ['core/backend', 'aa/backend', 'zz/backend'],
    `ranking incorrecto: [${result.join(', ')}]`,
  );

  // aaaa/bbbb fuera aunque son los primeros alfa: prueba distancia > alfa
  assert.ok(!result.includes('aaaa'), 'aaaa no debe aparecer (d=10 > top-3)');
  assert.ok(!result.includes('bbbb'), 'bbbb no debe aparecer (d=10 > top-3)');
});
