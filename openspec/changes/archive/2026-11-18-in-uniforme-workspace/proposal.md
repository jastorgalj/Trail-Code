# Proposal

## Why

En un servidor rooted en un workspace (carpeta con varios repos hijos), el mismo `in=` se interpreta
distinto según la tool. Reproducido sobre `main` (`ae72591`) con un workspace de dos hijos `a/x` y `a/y`
que definen ambos `sharedFn` en `src/`:

| Tool | `in="a/x/src"` | Causa |
|---|---|---|
| `trail_find_code` | acota a `a/x/src` | `federateAsk` quita el prefijo del hijo (`src/graph/workspace.ts:337-350`) |
| `trail_trace_calls` | `nothing indexed under "a/x/src/"` | `federateCallers` pasa el `in` completo a cada hijo (`:760`) |
| `trail_find_all` | se ignora: busca en todos los hijos | `callWorkspaceTool` no lo pasa (`src/mcp/tools.ts:230-233`) y `federateGrep` no lo acepta (`:650-655`) |
| `trail_search_semantic` | acota | `federateSemantic` tiene su propia copia de la regla (`:849-874`) |

Son tres copias distintas de la regla. `trail_set_scope` inyecta su resultado como `in` en las tools que lo
declaran (`injectClientScope`, `src/mcp/server.ts:139-156`), así que tras fijar un scope dentro de un hijo
`trace_calls` falla siempre y `find_all` no se acota. Además `in` = grupo de hijos (`in="a"`) lo acepta
solo la semántica: `trail_find_code` responde `no workspace repo matching "a"`.

Origen: issue jastorgalj/Trail-Code#14.

## What Changes

- Un único resolvedor puro `resolveWorkspaceIn(children, in)` en `src/graph/workspace.ts` y un helper
  `scopeWorkspaceGraphs(wg, in)` que lo aplica a los grafos cargados. `federateAsk`, `federateCallers`,
  `federateGrep` y `federateSemantic` resuelven `in` solo por ahí; desaparecen las tres copias.
- Regla única: `in` vacío = todos los hijos; igual a un hijo o dentro de un hijo = ese hijo con el resto
  como sub-prefijo; igual a un grupo de hijos = esos hijos; cualquier otro valor = error que lista los repos.
- `trail_find_all` (MCP) y `trail grep` (CLI) en workspace pasan a aceptar y aplicar `in`; solo se leen los
  archivos de los hijos en alcance.
- `trail_trace_calls` deja de pasar el prefijo del hijo al propio hijo.
- Un sub-prefijo que no existe en el hijo es un error `nothing indexed under "<in>/"` en las cuatro tools
  (hoy `trace_calls` lo lanza, `find_code` lo traga como «no matching nodes» y `search_semantic` responde
  «no semantic matches»).
- Un `in` que no nombra ningún repo responde el mismo texto en las cuatro tools.
- La descripción de `in` es la misma en las cuatro tools y dice la regla del workspace.
- Capability nueva `alcance-in-workspace`; MODIFIED en `busqueda-semantica-workspace` (texto del error y
  subpath sin coincidencia).

## Capabilities

### New Capabilities

- `alcance-in-workspace`: cómo se interpreta `in` en un workspace, igual para `trail_find_code`,
  `trail_trace_calls`, `trail_find_all`, `trail_search_semantic` y sus equivalentes de CLI.

### Modified Capabilities

- `busqueda-semantica-workspace`: el texto del error de `in` sin coincidencia pasa a ser el común, y un
  subpath inexistente deja de ser «no semantic matches».

## Fuera de alcance

- Issue #15: `in` como ruta absoluta o sin el prefijo del grupo, y validar `in` antes del refresco de grafos
  (`ensureFreshChildren` en `src/mcp/tools.ts:311`). Este cambio deja el resolvedor listo para que #15
  lo extienda sin tocar a los cuatro llamadores.
- Issue #18: `limit` y tope global de `trail_find_all`.
- Issue #20: scope de `trail_set_scope` por sesión (`src/mcp/server.ts`).
- `trail_trace_calls` con `depth: "all"` en workspace: `callWorkspaceTool` solo lee `depth` numérico
  (`src/mcp/tools.ts:222`) y lo ignora en silencio. Defecto distinto; issue aparte.
- `trail callers --json` en workspace cae al camino de un solo repo (`src/cli.ts:1161`). Issue aparte.
- La nota de cobertura de `federateAsk` sigue contando todos los hijos aunque `in` acote a uno.
- `CHANGELOG.md` (se escribe solo en el commit de release) y publicar en npm.
