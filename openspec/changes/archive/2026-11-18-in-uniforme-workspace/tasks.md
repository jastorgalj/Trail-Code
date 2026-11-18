# Tasks

Gates del repo: `npx tsc -p tsconfig.json --noEmit` y las pruebas POR ARCHIVO con
`GRAFT_NO_TRAIL_SWITCH=1 node --import tsx --test <archivo>` (`npm test` completo se cuelga en esta máquina).
No editar `CHANGELOG.md`. No tocar `src/mcp/server.ts`.

## 1. Pruebas primero (rojas sobre la base)

- [x] 1.1 Crear `test/workspace-in.test.ts`. Primera línea de código: `process.env.GRAFT_NO_REFRESH = '1'`
      antes de los imports (igual que `test/workspace-semantic.test.ts:13`). Fixture en un tmpdir, hijos
      con `.git/` vacío: `a/x` con `src/x.ts` = `export function sharedFn() { return xOnly(); }\nfunction xOnly() { return 1; }\n`
      y `lib/l.ts` = `export function libFn() { return 3; }\n`; `a/y` con `src/y.ts` = el mismo texto con `yOnly`;
      `b` con `src/b.ts` = `export function sharedFn() { return 4; }\n`. Construir con `splitWorkspace` +
      `buildGraph` (como `workspaceFx`/`buildWorkspace` en `test/workspace.test.ts:25-47`) y generar
      `embeddings.db` por hijo con `embedNodes` + `_setEmbedderForTest` (como
      `test/workspace-semantic.test.ts:58-114`; restaurar `null` al final). Borrar el tmpdir al final.
- [x] 1.2 Pruebas puras de `resolveWorkspaceIn(['a/x','a/y','b'], in)` (importada de
      `../src/graph/workspace.js`): los escenarios de los requirements «Normalización de in», «in dentro o
      igual a un hijo», «in igual a un grupo de hijos» e «in sin coincidencia» de
      `specs/alcance-in-workspace/spec.md`, incluidos `a\x\src`, `./a/x/src`, `a/x/src/`, `/`, `./`, `a/xx`,
      `a/x_` y `x`; y el de hijos compuestos `['default-core/frontend','default-core/backend']`.
- [x] 1.3 Pruebas por tool con `callTool` (`../src/mcp/tools.js`) sobre el fixture: los escenarios de los
      requirements «Las cuatro tools resuelven in por el mismo resolvedor», «trace_calls pasa al hijo…»,
      «find_all aplica in…», «Un sub-prefijo inexistente es un error» e «in sin coincidencia». El de
      `find_all` afirma `searched 1 indexed files` (con `in: "a/x/src"`) y `searched 3 indexed files`
      (con `in: "a"`).
- [x] 1.4 Prueba de `trail grep` del CLI: `execFileSync(process.execPath, ['--import','tsx','src/cli.ts','grep',
      'sharedFn', <raíz>, '--in', 'a/x/src'], { env: { ...process.env, GRAFT_NO_REFRESH: '1' } })` y afirmar el
      escenario «trail grep del CLI en un workspace».
- [x] 1.5 Prueba stdio de `set_scope`: en el mismo archivo, un helper `rpc` propio (copiar el patrón de
      `test/mcp-args.test.ts:36-61`: `spawn(process.execPath, ['--import','tsx','src/cli.ts','mcp', dir])`,
      `HOME` temporal, sin `TRAIL_HOME`/`GRAFT_HOME`, `GRAFT_NO_REFRESH=1`) y el escenario «set_scope dentro de
      un hijo y trace_calls sin in». No añadir este test a `test/mcp-args.test.ts`.
- [x] 1.6 Prueba de descripciones: las cuatro `inputSchema.properties.in.description` de `TOOLS` son iguales y
      contienen `workspace`.
- [x] 1.7 Ejecutar `node --import tsx --test test/workspace-in.test.ts` sobre la base y anotar cuáles fallan.
      Esperado en rojo: `trace_calls` (todos los `in`), `find_all` (todos los `in`), `find_code` con `in: "a"`,
      sub-prefijo mal escrito en las cuatro, `in` sin coincidencia en `trace_calls`, `find_all` y semántica
      (texto), descripciones, `set_scope` + `trace_calls`, `trail grep --in`, y las pruebas de
      `resolveWorkspaceIn` (no existe).

## 2. Resolvedor

- [x] 2.1 `src/graph/workspace.ts`: añadir, justo después de `coverageNote` (`:241-245`), los tipos y las
      funciones `resolveWorkspaceIn` y `scopeWorkspaceGraphs` de `design.md` D1, con las reglas D2, D4 y D5.
      Importar `normalizePathPrefix` de `../util/paths.js` y `pathUnderPrefix` de `./scopes.js` (ya se importa
      `discoverWorkspaceChildren` de ahí, `:30`). `resolveWorkspaceIn` no lee disco. Mensaje de no coincidencia:
      `no workspace repo matching "<in normalizado>" — repos: <hijos ordenados separados por ", ">`.
      Mensaje de sub-prefijo: `nothing indexed under "<in normalizado>/" in workspace repo <hijo>`.

## 3. Las cuatro funciones usan el resolvedor

- [x] 3.1 `federateAsk` (`:320-`): reemplazar el bloque `:330-350` y `onlyChild` (`:335`, `:355`, `:403-414`)
      por `scopeWorkspaceGraphs(wg, opts.in)`; si `!ok`, `throw new Error(message)`. Iterar `scoped.children`
      y pasar `in: childIn`. Compuerta (design D6): `bypassGate = scoped.narrowed && scoped.children.length +
      scoped.missing.length === 1`. Conservar el `catch { continue }` de `:372-374` solo para un hijo corrupto.
- [x] 3.2 `federateCallers` (`:746-`): iterar `scoped.children`, llamar
      `resolveSymbol(graph, symbol, childIn ? { in: childIn } : {})`; si `!ok`, devolver
      `{ text: message, found: false }`. El texto de símbolo ausente cuenta `scoped.children.length`.
- [x] 3.3 `federateGrep` (`:650-`): añadir `in?: string` a `opts`; iterar `scoped.children` y pasar
      `in: childIn` a `grepGraph`; si `!ok`, `throw new Error(message)`. `coverage` no cambia.
- [x] 3.4 `federateSemantic` (`:835-`): reemplazar `:843-874` por `scopeWorkspaceGraphs`; `selectedChildren` =
      hijos de `scoped.children` más `scoped.missing`, ordenados; `subpath` = `childIn` del único destino con
      sub-prefijo; si `!ok`, `{ text: message, isError: true }`. Mantener sin cambio la clasificación por
      `embeddings.db`, los mensajes de cobertura y el filtro por `file_path`.

## 4. Cableado

- [x] 4.1 `src/mcp/tools.ts` `callWorkspaceTool`, case `graft_find_all` (`:227-236`): pasar
      `in: typeof args.in === 'string' && args.in ? args.in : undefined` a `federateGrep`.
- [x] 4.2 `src/mcp/tools.ts`: constante `IN_DESCRIPTION` (texto de `design.md` D8) y usarla en las
      propiedades `in` de `trail_find_code` (`:74-77`), `trail_trace_calls` (`:127`), `trail_find_all`
      (`:141`) y `trail_search_semantic` (`:169`).
- [x] 4.3 `src/graph/workspace-cli.ts` `runWorkspaceGrep` (`:129-`): añadir `in?: string` a `opts` y pasarlo a
      `federateGrep`. `src/cli.ts:1233`: pasar `in: opts.in` a `runWorkspaceGrep`.

## 5. Pruebas existentes y documentación

- [x] 5.1 `test/workspace.test.ts:438`: la regex `/no workspace repo "nope".*repoA.*repoB/s` está en rojo sobre
      la base (el código dice `no workspace repo matching "nope"`); cambiarla a
      `/no workspace repo matching "nope".*repoA.*repoB/s`. No tocar los otros dos rojos de ese archivo
      (`workspace.json lists both children…`, `readWorkspace: rejects foreign/invalid json…`): son previos y
      ajenos (`knowledgeRepos: undefined` en el objeto leído).
- [x] 5.2 `test/workspace-semantic.test.ts`: en `:451` y `:481` esperar `no workspace repo matching "nosuch"` y
      `no workspace repo matching "repo"`; reescribir el test `in con subpath sin hits` (`:388-420`) para
      esperar `isError: true` y `nothing indexed under "repoA/nada/"`.
- [x] 5.3 `README.md` (zona de `trail_search_semantic`, `:504-507`): añadir un párrafo corto con la regla de
      `in` en un workspace (repo, grupo o ruta dentro de un repo; mismo error y mismo efecto en las cuatro
      tools). `src/claude/hermes-skill-template.ts:131-132`: reemplazar «`in="default-core"` no es un scope
      válido» por la regla (un grupo es un scope válido) y ejecutar
      `test/claude-skill-template.test.ts` y `test/upkeep.test.ts` para confirmar que ninguna fija ese texto.
- [x] 5.4 NO editar `CHANGELOG.md`. Dejar en `metadata.pr_notes` del handoff el texto para el PR: (a) `in`
      uniforme en las cuatro tools y el CLI, (b) `trail_find_all` en workspace ahora respeta `in`, (c) typo de
      sub-prefijo es error, (d) un grupo es `in` válido en todas, (e) despliegue: trail corre como UN
      servidor MCP compartido por PC (mcp-proxy :3104); reiniciarlo tras reinstalar para que todos los agentes
      vean el contrato nuevo.

## 6. Gates (último grupo)

- [x] 6.1 `npx tsc -p tsconfig.json --noEmit` sin errores (la base sale 0).
- [x] 6.2 Pruebas por archivo, cada una con `GRAFT_NO_TRAIL_SWITCH=1 node --import tsx --test <archivo>`:
      `test/workspace-in.test.ts` (todo verde), `test/workspace.test.ts`, `test/workspace-semantic.test.ts`,
      `test/mcp-args.test.ts`, `test/mcp-tools.test.ts`, `test/mcp-server.test.ts`,
      `test/tool-output-no-instructions.test.ts`, `test/graph-traverse.test.ts`,
      `test/graph-traverse-cli.test.ts`, `test/search-grep.test.ts`, `test/graph-scopes.test.ts`,
      `test/claude-skill-template.test.ts`, `test/upkeep.test.ts`. Rojos permitidos (previos en `ae72591`,
      sin editar): `test/workspace.test.ts` 2 (`workspace.json lists both children…`,
      `readWorkspace: rejects foreign/invalid json…`); `test/mcp-tools.test.ts` 2 (`TOOLS lists the six tools
      with schemas`, `TOOLS advertises exactly the six new names`); `test/mcp-server.test.ts` 3 (`a built repo
      advertises every tool`, `a fresh worktree advertises every tool…`, `initialize carries instructions…`).
      Cualquier otro rojo es propio.
- [x] 6.3 `openspec validate in-uniforme-workspace --strict` sin errores ni warnings.
