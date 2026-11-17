# Design

## Context

La línea de ahorro y la nota de cobertura son dos fuentes distintas de texto no pedido en la salida de las
tools. Verificado sobre `origin/main` (c17f23b) ejecutando las tools con `callTool` contra fixtures:

| Salida | Orden al modelo hoy | Nota de cobertura hoy |
|---|---|---|
| repo único: `find_code`, `find_all`, `trace_calls`, `file_api`, `repo_map` | sí (las 5) | no aplica |
| repo único: `check_freshness` | no | no aplica |
| workspace: `find_all`, `trace_calls`, `repo_map` | sí | sí |
| workspace: `find_code`, `check_freshness` | no (la ruta federada de ask no emite línea de ahorro) | sí |

El único consumidor del texto de la línea es `sumSavingsFooters` (`src/context/savings.ts:137-144`), que
solo lo lee `parseSavings` (`src/claude/session-metrics.ts:105-107`), y `parseSavings` no tiene llamador
fuera de tests: el hook `tool-savings` que lo invocaba se amputó con el fork (`superficie-git`: `trail init`
no escribe `settings.json` ni `.trail/hook.cjs`). La skill que `trail init` instala sigue pidiendo el
tally por su cuenta (`src/claude/skill-template.ts:260-276`), así que quitar la frase de la salida no deja a
Claude Code sin la instrucción: la conserva donde el usuario la instaló a propósito.

## Decisions

- **D1 (P1) La línea queda como dato; la orden se elimina, sin opt-in.** Un opt-in
  (`TRAIL_SAVINGS_NUDGE=1`) no tiene consumidor en el fork y mantendría vivo el patrón de inyección. Mover
  el dato a `_meta`/structured content cambia `src/mcp/server.ts` (zona del issue #16) y los hosts no
  garantizan mostrarlo.
- **D2 (P1) Los dólares pasan a la línea de datos.** La rama con tarifa de `savingsTurnNudge`
  (`savings.ts:101-107`) era el único lugar donde viajaba el valor en dólares. Se conserva como dato
  (`worth ≈ $X`) para que `setInputRate` (`tools.ts:277`, `cli.ts:145`) siga teniendo efecto. Nota: en el
  fork la tarifa hoy es siempre `null` (`inputCostMicros` se lee en `session-metrics.ts:183` pero ningún
  código de `src/` lo escribe), así que la rama está dormida; se conserva el dato, no se inventa un productor.
- **D3 (P5=2, decidido por el usuario) Separador de miles fijo `en-US` en las tres salidas numéricas.**
  `toLocaleString()` sin argumento depende del locale: en `es-CL` imprime `999.750` y el regex `[\d,]+` de
  `sumSavingsFooters` lee `999`. Se fija `"en-US"` en `savingsLine` (`savings.ts:123-125`), `askSavingsLine`
  (`ask.ts:1584-1586`) y `formatSessionStats` (`session-metrics.ts:205`, único `toLocaleString` de esa
  función; la línea 210 es `value saved` vía `formatDollars`, sin locale). No se toca el regex (los tests
  existentes ya usan comas). Con esto los 3 tests de `session-metrics` de la baseline pasan a verde (misma
  causa, verificado: el único aserto que falla es el número con `.`). Otros `toLocaleString()` sin locale
  que quedan fuera: `scripts/tally-audit.mjs` (script de desarrollo, no es salida de tool).
- **D4 (P2) La nota de cobertura solo acompaña a respuestas vacías.** Con resultados, la nota no cambia la
  decisión del agente; sin resultados sí: «no hay nada» puede ser falso si un repo no está indexado.
  `federateGrep` sigue devolviendo `coverage`; los llamadores (`tools.ts:226`, `workspace-cli.ts:142,146`)
  deciden. `federateMap` y `federateCheck` no cambian.
- **D5 (P3) CLI y MCP igual.** Comparten `federateAsk/Grep/Callers` y `formatAsk`; separarlos exigiría un
  flag en cada uno.
- **D6 (P4) `escalationNudge` queda.** Es una pista de qué tool usar, no una orden sobre qué decirle al
  usuario; el test prohíbe las tres frases del issue, no todo imperativo.

## Despliegue (servidor MCP compartido)

Dato del usuario (no verificado por mí): trail corre como un único servidor MCP por equipo (`mcp-proxy`
:3104, sin estado, `trail mcp C:/Users/jastorga/Desarrollo`), compartido por todos los perfiles/agentes.
Consecuencias para este cambio:

- El contrato de salida cambia para todos los agentes a la vez, cuando se reinstala el paquete y se
  reinicia ese servidor; hasta entonces todos ven el comportamiento viejo. No hay migración gradual por
  agente y ninguna decisión de este change la requiere.
- Evidencia de que el servidor vivo aún corre la versión vieja: una llamada real a `trail_find_all` desde
  el explorer devolvió la línea con la orden y `228.924` (locale `es-CL`), y la nota
  `29 of 30 workspace repos have graphs` junto a 100 resultados.
- Este change NO añade estado por proceso: la nota de cobertura depende solo del resultado de esa llamada
  (por eso se descartó «una vez por sesión», que en un servidor compartido mezclaría clientes) y el
  separador usa un locale fijo, no el del proceso.
- Estado por proceso que ya existe y no se toca: `inputRateUsdPerMtok` (`savings.ts:69-75`) es una variable
  de módulo que `callTool` reescribe en cada llamada (`tools.ts:277`). En un servidor compartido, dos
  llamadas concurrentes podrían pisarse, y la tarifa de `sessionInputRate(root)` sería la de la «última
  sesión» de cualquier agente. Hoy es inocuo: ningún código de `src/` escribe `inputCostMicros`, la tarifa
  es siempre `null` y la línea no lleva `$`. Si aparece un productor de la tarifa, debe viajar como
  parámetro, no como global (sospecha, no verificada con carga concurrente).
- Los tests nuevos prueban `callTool`/`savingsLine` en proceso; no prueban el servidor por HTTP.

## Risks / Trade-offs

- Quien hoy dependa de que la salida diga «tell the user…» deja de recibirla: solo Claude Code con la skill
  instalada sigue tallying; los demás hosts dejan de hacerlo (es lo que pide el issue).
- `src/graph/workspace.ts` y `src/mcp/tools.ts` los tocan también #16 y #19: conflicto de merge probable en
  `tools.ts` (bloque `graft_find_all` de `callWorkspaceTool`, que #16 también reescribe al validar args).
