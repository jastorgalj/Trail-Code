# Tasks

## 1. Pruebas primero (rojas sobre la base)

- [x] 1.1 Crear `test/tool-output-no-instructions.test.ts` con dos fixtures: (a) repo único con
      `src/big.ts` de más de 40 000 caracteres que define `needleFn` y `src/use.ts` que lo llama,
      construido con `execFileSync(process.execPath, ['--import','tsx','src/cli.ts','build',d])` como en
      `test/mcp-tools.test.ts`; (b) workspace `repoA` (con `alphaHandler` y relleno > 40 000 caracteres),
      `repoB`, `repoC`, construido con `splitWorkspace` + `buildGraph` y con el grafo de `repoC` borrado,
      como en `test/workspace.test.ts` («one unbuilt child is surfaced»). Cada fixture se borra al final.
- [x] 1.2 En ese archivo, los escenarios de `specs/salida-tools/spec.md` sobre `callTool`
      (`../src/mcp/tools.js`): frases prohibidas en las 6 tools del repo único; nota de cobertura con y sin
      resultados en `trail_find_code`, `trail_find_all` y `trail_trace_calls`; `trail_repo_map` y
      `trail_check_freshness` con nota. Cada aserción de ausencia va acompañada de una de presencia
      (`tokens saved ≈` en el repo único; `repoA/` en el workspace) para que una salida vacía no pase en vacío.
- [x] 1.3 En el mismo archivo, los escenarios de `savingsLine`/`sumSavingsFooters`
      (`../src/context/savings.js`): miles con coma, sin línea cuando no hay ahorro, con y sin tarifa
      (`setInputRate(3)` / `setInputRate(null)`; restaurar `null` al final) y de `formatSessionStats`
      (`../src/claude/session-metrics.js`, con `{ id: 'abc', graftReads: 8, sourceReads: 2,
      savedTokens: 12345 }` la salida contiene `~12,345`). Para que la prueba sea roja sobre la base también
      en una máquina `en-US`, forzar el locale por defecto dentro del test: reemplazar
      `Number.prototype.toLocaleString` por una versión que, sin argumento de locale, delegue en
      `"es-CL"`, y restaurar el original al final (`after`). Verificar que fallan sobre la base con
      `node --import tsx --test test/tool-output-no-instructions.test.ts` y anotar cuáles.

## 2. Línea de ahorro como dato

- [x] 2.1 `src/context/savings.ts`: eliminar `savingsTurnNudge` y su uso en `savingsLine`; formatear
      `delta`, `pack` y `base` con `toLocaleString("en-US")`; añadir el valor en dólares a la línea solo si
      `inputRateUsdPerMtok` no es `null` (`worth ≈ ${formatDollars(usd)} at this session's input rate`).
      Corregir los comentarios que citan el nudge (`:11-12`, `:81-91`, `:133-135`).
- [x] 2.2 `src/ask/ask.ts`: quitar `savingsTurnNudge` del import (`:20`) y de `askSavingsLine` (`:1587`);
      mismo `en-US` y mismo fragmento de dólares (reutilizar un helper exportado de `savings.ts`, no
      duplicar el texto). No tocar `escalationNudge` (`:1563-1571`).
- [x] 2.3 `src/mcp/tools.ts:272-274`: actualizar el comentario «can put a dollar figure in the nudge».

- [x] 2.4 `src/claude/session-metrics.ts:205`: `saved.toLocaleString()` → `saved.toLocaleString("en-US")`.
      No tocar nada más de `formatSessionStats` (la línea 210 no usa locale). Confirmar que los 3 tests de
      `test/session-metrics.test.ts` que hoy fallan (`formatSessionStats renders the mix…`,
      `…prices the saving…`, `…omits the dollar line…`) pasan, sin editar ese archivo de test.

## 3. Nota de cobertura solo sin resultados

- [x] 3.1 `src/graph/workspace.ts`: en `federateAsk` (los dos puntos donde se añade `note`, hoy `:596` y
      `:643`) añadirla solo cuando `hits.length === 0`; en `federateCallers` (`:774-780`) añadirla solo en la
      rama `found: false`. `federateGrep` (`:689`), `federateMap` (`:710`) y `federateCheck` (`:739`) no cambian.
- [x] 3.2 `src/mcp/tools.ts` (`callWorkspaceTool`, case `graft_find_all`, `:221-226`) y
      `src/graph/workspace-cli.ts:136-146`: usar `coverage` solo cuando `result.totalHits === 0`.

## 4. Registro

- [x] 4.1 NO editar `CHANGELOG.md` (en este repo se escribe solo en el commit de release, ver `git log -- CHANGELOG.md`;
      los PR hermanos #12 y #19 tampoco lo tocan). En su lugar, deja en `metadata.pr_notes` del handoff el texto para la
      descripción del PR: los tres cambios de salida (sin orden al modelo, miles con coma en líneas de ahorro y `trail stats`,
      nota de cobertura solo sin resultados) y la nota de despliegue: trail corre como UN servidor MCP compartido por PC
      (mcp-proxy :3104) y hay que reiniciarlo tras reinstalar para que todos los agentes vean el contrato nuevo.

## 5. Gates (último grupo)

- [x] 5.1 `npx tsc -p tsconfig.json --noEmit` sin errores.
- [x] 5.2 Suite completa: `npm test` no termina en esta máquina (cuelgue preexistente de
      `test/trail-name.test.ts`), así que correr cada archivo con `node --import tsx --test <archivo>` y
      comparar con `.fabrica/baseline-fallas.txt`: ninguna falla nueva, y las 3 de `session-metrics` ya no
      aparecen.
- [x] 5.3 `openspec validate quitar-instruccion-salida-tools --strict` sin errores ni warnings.
