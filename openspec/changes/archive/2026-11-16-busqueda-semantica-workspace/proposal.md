# Proposal

## Why

Issue #19. En un servidor `trail mcp` con raíz en un workspace (varios repos hijos), la tool
`trail_search_semantic` responde `no semantic matches found across workspace children` aunque los
embeddings existan. Reproducido en un workspace temporal de 2 repos con layout `.trail/cache`:

- `trail build` y el refresco por drift escriben el índice en `<hijo>/.trail/cache/.cache/embeddings.db`
  (`embeddingsDbPath(contextDirFor(hijo))`, `src/graph/build-run.ts:49`, `src/graph/refresh.ts:168`).
- `federateSemantic` lo busca en `<hijo>/graft/.cache/embeddings.db` (ruta fija,
  `src/graph/workspace.ts:846`), no lo encuentra, y el `catch` vacío (`workspace.ts:859-861`) oculta el
  error `Embeddings DB not found`.
- `in` se descarta: `callWorkspaceTool` no se lo pasa a `federateSemantic` (`src/mcp/tools.ts:236-241`).
- La rama que sí resolvía bien el hijo y el `in` (`src/mcp/tools.ts:405-438`) es inalcanzable: `callTool`
  responde antes con `callWorkspaceTool` (`tools.ts:285`).

Además, `trail_find_code` responde siempre `(lexical)` y los agentes concluyen que la semántica está
apagada. Es por diseño (`AskResult.mode` solo admite `structural | lexical | empty`,
`src/ask/ask.ts:102`), pero la descripción de la tool y las instrucciones MCP no lo dicen.

## What Changes

- `federateSemantic` ubica el índice de cada hijo con `embeddingsDbPath(contextDirFor(<raíz>/<hijo>))`:
  el mismo resolvedor que usan build, refresh y el resto de las tools de workspace. Los repos que aún
  están en `graft/` siguen funcionando porque `contextDirFor` ya devuelve `graft/` para ellos.
- `in` acota la búsqueda semántica del workspace: a un hijo, a un grupo de hijos por prefijo (uso
  documentado `in="default-core"`) o a un subpath dentro de un hijo (el que inyecta `trail_set_scope`).
- Se dejan de tragar los errores: si ningún hijo tiene índice, la tool lo dice y nombra el comando; si
  solo algunos lo tienen, la respuesta nombra los que faltan; si un índice falla, nombra el hijo y la causa.
- Se elimina la rama workspace inalcanzable de `callSingleTool` (`tools.ts:405-438`): queda un solo camino.
- La descripción de `trail_find_code`, las instrucciones MCP y el README declaran que `trail_find_code` es
  léxico + estructural (sin embeddings) y que la semántica vive en `trail_search_semantic`.

## Out of Scope

- Modo híbrido (RRF léxico + semántico) en `trail_find_code` detrás de un flag: es una feature nueva, no el
  arreglo del bug.
- `trail ask --semantic` en CLI (`src/cli.ts:793-826`): ya resuelve bien la ruta; no se toca para no chocar
  con otros cambios en `cli.ts`.
- Umbral de score (`> 0.05` en CLI y single-repo, ninguno en workspace): no cambia.
- Publicar en npm y reiniciar el servidor compartido `trail mcp` (mcp-proxy :3104): manual del usuario.
- Reescribir las plantillas de skill (`src/claude/skill-template.ts:70-83`,
  `src/claude/hermes-skill-template.ts:58-74`): ya dicen que `trail_find_code` es léxico.

## Impact

- Código: `src/graph/workspace.ts`, `src/mcp/tools.ts`, `src/mcp/instructions.ts`, `README.md`.
- Pruebas: `test/workspace-semantic.test.ts` (nuevo).
- Contrato MCP: nombres y parámetros de las tools no cambian; el formato de cada hit
  (`N. [hijo/]ruta · símbolo  (score: X)`) tampoco. Cambian: textos de descripción y los mensajes de
  respuesta cuando no hay índice (compatible con `superficie-git`, requirement «Las nueve tools MCP
  conservan nombre y contrato»).
