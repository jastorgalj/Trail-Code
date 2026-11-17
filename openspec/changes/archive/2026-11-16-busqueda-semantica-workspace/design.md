# Design

## Context

Ruta de una llamada `trail_search_semantic` en un servidor enraizado en un workspace (verificado en
`origin/main` c17f23b):

1. `callTool` (`src/mcp/tools.ts:263-291`) lee `workspace.json`; si hay workspace llama
   `callWorkspaceTool` y solo cae a `callSingleTool` cuando este devuelve `null`.
2. `callWorkspaceTool` tiene un `case 'graft_search_semantic'` (`tools.ts:236-241`) que responde con
   `federateSemantic(root, dirOverride, query, limit)` y **no pasa `in`**.
3. `federateSemantic` (`src/graph/workspace.ts:826-875`) itera `wg.loaded` y abre
   `join(root, child, 'graft', '.cache', 'embeddings.db')` (`:846`); el `catch` vacío (`:859-861`) oculta
   el error y, sin hits, responde `no semantic matches found across workspace children`.
4. La rama workspace de `callSingleTool` (`tools.ts:405-438`, dentro del `case 'graft_search_semantic'` que
   empieza en `:397`) ya hace lo correcto (resuelve con
   `contextDirFor(childRoot)`, respeta `in`) pero nunca se ejecuta: el paso 1 siempre responde antes.

Dónde se escribe el índice: `embeddingsDbPath(outDir)` = `<outDir>/.cache/embeddings.db`
(`src/graph/build-run.ts:49`), con `outDir = contextDirFor(<repo>)` → `mapDirFor` → `.trail/cache` si el repo
está en trail, `graft` si no (`src/context/map-dir.ts:43-49`). `mapDirFor` además migra un `graft/` viejo a
`.trail/cache` cuando el repo pasa a trail (`map-dir.ts:61-77`), así que un repo viejo no necesita fallback
propio: `contextDirFor` ya devuelve el lugar correcto en ambos casos.

## Decisiones

| # | Decisión | Por qué | Alternativa descartada |
|---|---|---|---|
| D1 | Arreglar `federateSemantic` y borrar la rama muerta de `callSingleTool` | `federateSemantic` convive con `federateAsk/Callers/Grep/Map/Check` y se prueba sin pasar por MCP | Borrar `federateSemantic` y dejar viva la rama de `callSingleTool`: habría que mover el despacho y rompe la simetría de `callWorkspaceTool` |
| D2 | Ruta con `embeddingsDbPath(contextDirFor(join(root, child)))` | Una sola fuente de verdad para la ruta; sin fallback a `graft/` propio | Probar `.trail/cache` y luego `graft`: duplica lo que `mapDirFor` ya decide |
| D3 | `in` = unión de dos reglas (hijos bajo el prefijo, o hijo ancestro + subpath) | La doc usa `in="default-core"` (grupo, `README.md:507`); `trail_set_scope` inyecta `in` que puede caer dentro de un hijo (`server.ts:128-133`) | Copiar la regla de `federateAsk` (`workspace.ts:337-348`): solo acepta hijo-ancestro y rompería el grupo documentado. Copiar la de la rama muerta: rechazaría el subpath inyectado por el scope |
| D4 | Sin índice en ningún hijo → `isError: true` | La tool no pudo correr; con `false` el agente lo lee como «sin resultados». La CLI ya sale con código 1 en ese caso (`cli.ts:817-820`) | `isError: false` con mensaje claro (menos intrusivo, pero algunos hosts ocultan el texto cuando no es error) |
| D5 | Formato de la línea de cobertura espejo de `coverageNote` (`workspace.ts:241-245`) | El agente ya conoce `N of M workspace repos have graphs; run … to cover …` | Texto nuevo sin relación |
| D6 | No se toca `coverageNote` ni los footers de ahorro | Es terreno del issue #17 | — |

## Límites conocidos

- Con subpath en `in`, el filtro se aplica DESPUÉS de la búsqueda vectorial por hijo (no hay filtro por
  ruta dentro de sqlite-vec). Se pide `limit * 10` candidatos por hijo cuando hay subpath, `limit * 2`
  cuando no; hits fuera del subpath que queden dentro de esos candidatos se descartan, así que puede
  devolver menos de `limit` aunque existan más dentro del subpath.
- El score sigue sin umbral en workspace (single-repo y CLI filtran `> 0.05`): se deja como está para no
  cambiar el contrato más allá del bug.
- El servidor compartido ya levantado sigue con el código viejo hasta reiniciarlo tras instalar el build.
