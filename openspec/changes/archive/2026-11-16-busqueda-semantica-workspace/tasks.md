# Tasks

Reglas para quien ejecuta: trabajar en el worktree `.worktrees/issue-19` (rama `fix/19-semantica-workspace-cache`);
no commitear ni pushear (lo hace el closer); no tocar `src/graph/workspace.ts:241-245` (`coverageNote`),
`src/cli.ts`, ni `~/.hermes`/`workspace.json` del servidor compartido. Las pruebas usan un workspace
temporal bajo `os.tmpdir()`, nunca `C:/Users/jastorga/Desarrollo`.

## 1. federateSemantic (`src/graph/workspace.ts`)

- [x] 1.1 Reescribir `federateSemantic` (hoy `workspace.ts:826-875`): candidatos = `loaded.map(l => l.child)` ∪
      `missing` de `loadWorkspaceGraphs`, ordenados; ruta del índice =
      `embeddingsDbPath(contextDirFor(join(root, child)))` (import de `./build-run.js`; si el import crea un
      ciclo que rompe `npm test`, usar `join(contextDirFor(...), CACHE_DIR, 'embeddings.db')` con `CACHE_DIR`
      de `../context/node-file.js`). Prohibido dejar el literal `'graft', '.cache'` en la función: es la causa
      del bug (los repos en trail no tienen `graft/`).
- [x] 1.2 Aplicar `in` según los requirements «El parámetro in selecciona hijos», «El parámetro in admite un
      subpath dentro de un hijo» y «Un in sin coincidencia es un error»
      (hijos bajo el prefijo; si ninguno, hijo ancestro + subpath con filtro por segmento sobre `file_path`;
      si nada, `isError: true` con `no workspace repos match "in=<in>" — available: <5 hijos>`). Firma nueva:
      agregar `inScope?: string` como último parámetro (no reordenar los existentes).
- [x] 1.3 Por hijo: si no existe el `embeddings.db` → cuenta como «sin índice» y NO se llama a
      `searchSemantic`; si existe, llamar `searchSemantic(query, db, k)` con `k = limit * 10` si hay subpath y
      `limit * 2` si no; si lanza, registrar `semantic search failed in <hijo>: <primera línea del mensaje>`
      (prohibido el `catch` vacío: ocultaba `Embeddings DB not found`).
- [x] 1.4 Armar la respuesta según los requirements «Sin índice en ningún hijo es un error accionable»,
      «Cobertura parcial se informa» y «Un índice que falla se informa con su hijo»: texto de hits idéntico
      al actual (`N. [<hijo>/]<ruta> · <símbolo>  (score: <score>)` +
      línea de snippet, separados por línea en blanco; la ruta sigue prefijada `[<hijo>/]`), luego una línea
      en blanco y las líneas de cobertura/fallo; `isError` = ningún hijo completó su búsqueda. El comando se
      escribe literal `trail build` (como `src/cli.ts:818`), NO con `cmd("graft build")`: sin la variable de
      marca, `cmd()` devuelve `graft build` (`src/brand.ts:15-16,74-75`) y los textos exactos de los
      escenarios no se cumplirían en pruebas.
      Verificar: `node --import tsx` con el repro (ver propuesta §3) devuelve el hit de `repoA`.

## 2. Tools MCP (`src/mcp/tools.ts`)

- [x] 2.1 En `callWorkspaceTool`, `case 'graft_search_semantic'` (`tools.ts:236-241`): leer
      `args.in` (string no vacío) y pasarlo a `federateSemantic`; no agregar validación de `limit` ni de otros
      argumentos (es del issue #16).
- [x] 2.2 Borrar de `callSingleTool` la rama workspace inalcanzable (`tools.ts:405-438`, desde el comentario
      `// Workspace: federate semantic search…` hasta el `}` que cierra `if (ws && ws.children.length > 0)`)
      y la constante `inPrefix` (`tools.ts:402`), que queda sin uso. Dejar intacta la ruta «Single repo».
      Verificar: `grep -n "childDb" src/mcp/tools.ts` no devuelve nada y `npx tsc -p tsconfig.json --noEmit`
      sale 0 (sin imports sin usar si el proyecto los rechaza).
- [x] 2.3 Reescribir la `description` de `trail_find_code` (`tools.ts:61-63`): conservar la primera frase y
      agregar que la búsqueda es `lexical` y `structural` (sin `embeddings`), que `(lexical)` en la
      respuesta es lo normal, y que para buscar por significado se use `trail_search_semantic`. Debe
      contener literalmente `lexical`, `structural`, `embeddings` y `trail_search_semantic`.
- [x] 2.4 Ajustar la `description` de `trail_search_semantic` (`tools.ts:154-155`): agregar que en un
      workspace busca en el índice de cada repo hijo y que `trail_build` lo crea. Conservar «Best for specs
      and docs (.md); for code symbols use trail_find_code instead».

## 3. Instrucciones y documentación

- [x] 3.1 `src/mcp/instructions.ts:52-62` (líneas `graft_find_code` y `graft_search_semantic` de la lista):
      la de `find_code` pasa a `where/how is X; ranked hits (lexical + structural, no embeddings)`; la de
      `search_semantic` a `natural-language search over the embeddings index (docs/specs)`. No agregar
      líneas nuevas ni cambiar `TOOL_ORDER`.
- [x] 3.2 `README.md`: en la tabla de tools MCP (`README.md:277-278`) la fila de `trail_find_code` aclara
      «lexical + structural, no embeddings» y la de `trail_search_semantic` «en un workspace busca en el
      índice de cada repo»; en `## Semantic search` (`README.md:504`) agregar una frase: «`trail_find_code`
      and `trail ask` never use embeddings; the header `(lexical)` is expected». No tocar `CHANGELOG.md`.

## 4. Pruebas (`test/workspace-semantic.test.ts`, archivo nuevo)

- [x] 4.1 Crear el archivo con un helper que arme el workspace temporal (hijos con `.git/`, y
      `.trail/learnings/` cuando el hijo es «de trail»), construya cada grafo con `buildGraph`, escriba
      `workspace.json` con `splitWorkspace` (patrón de `test/workspace.test.ts:25-45`) y cree el índice con
      `embedNodes(nodos no-file, embeddingsDbPath(contextDirFor(hijo)))` bajo `_setEmbedderForTest` con el
      embedder falso de `test/semantic-search.test.ts:44-52`, restaurándolo con `null` en `finally`. Cada
      prueba llama `callTool(raíz, 'trail_search_semantic', args)` y limpia su carpeta temporal.
- [x] 4.2 Una prueba por escenario del spec `busqueda-semantica-workspace`, con el nombre del escenario:
      «Hijo con layout .trail/cache», «Hijo con layout graft heredado», «El formato de cada hit no cambia»,
      los seis de `in` (igual a un hijo, igual a un grupo con hijos `grp/one`, `grp/two`, `other`, con
      subpath `repoA/src`, subpath sin hits `repoA/nada`, `nosuch`, `repo` por segmento), «Workspace sin
      ningún índice» (texto exacto `0 of 2 workspace repos have a semantic index; run trail build to cover repoA, repoB`),
      «in acota el conteo», «Un hijo sin índice», «Un índice ilegible se informa» (escribir texto plano en el
      `embeddings.db` de `repoB`), «Todos los índices fallan», y las de descripción/instrucciones
      («Descripción de trail_find_code» con `TOOLS`, «Instrucciones MCP» con `mcpInstructions()`).
      Verificar: `node --import tsx --test test/workspace-semantic.test.ts` con `GRAFT_NO_TRAIL_SWITCH=1`
      exportado: todas en verde. Antes de implementar 1.x, la prueba «Hijo con layout .trail/cache» DEBE
      fallar con `no semantic matches found across workspace children` (confirma que cubre el bug).

## 5. Compuertas completas (último grupo)

- [x] 5.1 `npx tsc -p tsconfig.json --noEmit` → exit 0.
- [x] 5.2 Correr por separado, con `GRAFT_NO_TRAIL_SWITCH=1`, `node --import tsx --test` sobre
      `test/workspace-semantic.test.ts` (todas verdes), `test/semantic-search.test.ts` (4/4),
      `test/workspace.test.ts` y `test/mcp-tools.test.ts`: estas dos deben fallar SOLO las pruebas de la
      baseline (`workspace.json lists both children…`, `readWorkspace: rejects foreign/invalid json…`,
      `federated ask: --in <child> narrows…`, `TOOLS lists the six tools with schemas`,
      `TOOLS advertises exactly the six new names…`). `npm test` completo no termina en esta máquina
      (baseline en `.fabrica/propuesta.md`); no se usa como compuerta ni se «arregla» aquí.
- [x] 5.3 `openspec validate busqueda-semantica-workspace --strict` → sin errores ni warnings.
