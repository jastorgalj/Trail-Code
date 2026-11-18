# Proposal

## Why

Cada respuesta de las tools de consulta de trail (`trail_find_code`, `trail_trace_calls`,
`trail_find_all`) abre con una línea de ahorro que termina en una orden al modelo: «At the end of your
reply, tell the user the total trail tokens saved this turn — sum each such line…»
(`src/context/savings.ts:92-108`, concatenada en `savingsLine` `:115-128` y en `askSavingsLine`
`src/ask/ask.ts:1577-1589`). Es una instrucción incrustada en el resultado de una tool: el mismo patrón
de un prompt-injection, y ruido en cualquier agente que no sea el que carga la skill. Además, en un
workspace con un repo hijo sin grafo, cada llamada federada repite la nota
«N of M workspace repos have graphs; run trail build to cover X» (`coverageNote`,
`src/graph/workspace.ts:241-245`), aunque el agente no puede ni debe construir ese repo.

Origen: issue jastorgalj/Trail-Code#17.

## What Changes

- La línea de ahorro pasa a ser solo un dato: se elimina `savingsTurnNudge` y su texto. La línea sigue
  empezando con `[trail] tokens saved ≈ N (P%)` y sigue siendo sumable por `sumSavingsFooters`.
- El número de la línea usa separador de miles `,` sin depender del locale del sistema (hoy en `es-CL`
  imprime `999.750` y `sumSavingsFooters` lo lee como `999`). Lo mismo en el resumen de sesión
  `formatSessionStats` (`src/claude/session-metrics.ts:205`), que hoy imprime `~12.345` y deja en rojo 3
  tests de `test/session-metrics.test.ts`.
- Si hay tarifa de entrada medida, el valor en dólares viaja en la propia línea de datos (hoy solo viajaba
  dentro de la frase eliminada).
- `coverageNote` deja de añadirse a los resultados de `trail_find_code`, `trail_find_all` y
  `trail_trace_calls` cuando hay resultados; se conserva cuando no hay ninguno, y siempre en
  `trail_repo_map` y `trail_check_freshness`. Aplica igual al CLI, que comparte los formateadores.
- Nueva capability `salida-tools` con la regla «la salida de una tool informa, no ordena» y un test que la
  verifica sobre la salida real de las tools.
- Despliegue: trail corre como UN solo servidor MCP por equipo, compartido por todos los agentes; el cambio
  de contrato llega a todos a la vez cuando se reinstala y reinicia ese servidor (ver design, «Despliegue»).

## Capabilities

### New Capabilities

- `salida-tools`: contenido permitido en la salida de texto de las tools de consulta (frases prohibidas,
  forma de la línea de ahorro, cuándo aparece la nota de cobertura).

### Modified Capabilities

(ninguna: `superficie-git` lista qué tools existen, no su contenido)

## Fuera de alcance

- `escalationNudge` de `src/ask/ask.ts:1563-1571` («don't re-ask with new wording; switch tool…»): es una
  pista de qué tool usar, no una orden sobre qué decirle al usuario. Se deja y queda anotado para un issue
  aparte (decisión P4 de la propuesta).
- La sección «Report what graft saved, every turn» de la skill que escribe `trail init`
  (`src/claude/skill-template.ts:260-276`): la skill la instala el usuario a propósito; no es salida de tool.
- El cableado `setInputRate` (`src/mcp/tools.ts:277`, `src/cli.ts:145`): se conserva, sigue siendo lo que
  alimenta los dólares de la línea de datos.
- `excludeFromDiscovery` (`src/graph/workspace.ts:68`, `:804-815`): ya existe y saca un repo de `children`
  al reconstruir el workspace; no requiere código.
- Publicar en npm: manual del usuario.
- Issues hermanos #12, #16, #19.
