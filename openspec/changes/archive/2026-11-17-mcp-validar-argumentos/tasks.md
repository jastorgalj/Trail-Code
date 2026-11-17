# Tasks

Gates del repo (CONTRIBUTING.md): `npx tsc -p tsconfig.json --noEmit` y pruebas. No hay lint.
Comando de pruebas por archivo: `GRAFT_NO_TRAIL_SWITCH=1 node --import tsx --test test/<archivo>.test.ts`
(la suite completa tarda y en esta máquina una prueba de `trail-name.test.ts` se queda colgada: ver
baseline en la propuesta).

Rama: `fix/16-validar-args-mcp`, ya rebasada sobre `origin/main` `dee8a0d` (incluye #12 y #19). Antes de
empezar: `git fetch origin && git rev-list --left-right --count HEAD...origin/main`; si main avanzó,
rebasar y volver a leer `src/mcp/tools.ts` y `src/mcp/server.ts` (los números de línea de esta lista
son orientativos: busca por texto).

## 1. Validador

- [x] 1.1 Crear `src/mcp/validate-args.ts` con `validateToolArgs(def, args)` según `design.md` D1 y D7:
      objeto obligatorio; claves desconocidas; requeridos; sinónimo `file` de `trail_trace_calls`
      (válido para `symbol` y validado como string); pista (reglas 1-3 y tabla `ARG_HINTS` del spec);
      tipos `string|number|boolean` y `enum` derivados del schema, `null` = ausente, sin coerción;
      regla declarada de `depth` (número finito, `"all"` o `"full"`); formato exacto de las cláusulas
      (a), (b), (c), posición de ` for <tool>` solo en la primera y cláusula `expected one of:` solo si
      hay (a) o (b). Prohibido importar `./tools.js` desde este archivo (import circular). Prohibido
      guardar estado a nivel de módulo (servidor compartido: design D8).

## 2. tools.ts

- [x] 2.1 Agregar `additionalProperties: false` a los nueve `inputSchema` de `TOOLS`. Prohibido cambiar
      ningún otro campo de los schemas (en especial `depth`: el schema anunciado no cambia).
- [x] 2.2 Reemplazar los ejemplos de `tools.ts:54` y `:161` por rutas genéricas
      (`/path/to/project`, `packages/api`). Agregar a la descripción de `trail_set_scope` la frase literal
      del spec (`The scope is held by the server process and shared by every client connected to it; the
      last call wins.`) sin quitar el resto de la descripción.
- [x] 2.3 Exportar `findTool(requestedName)` (busca en `TOOLS` por `canonicalToolName`).
- [x] 2.4 En `callTool`: primer paso del `try`, tras `canonicalToolName`: sin definición →
      `unknown tool "<pedido>"; available: ...`; con definición → `validateToolArgs`; rechazo →
      `{ text, isError: true }` antes de `readWorkspace`.
- [x] 2.5 Los nueve guards `graft_<tool> requires a <arg>` (`grep -n "requires a" src/mcp/tools.ts`:
      `:202, :210, :220, :238, :304, :317, :357, :380, :401`) pasan a `<tool trail_*> requires a
      non-empty "<arg>"`.
- [x] 2.6 `case 'trail_build'` (`:329`) → `case 'graft_build'`. Rama por defecto: si el nombre es
      `graft_set_scope`, responder `trail_set_scope is handled by the MCP server, not by callTool`.

## 3. server.ts

- [x] 3.1 `server.ts:98`: comparar con `'graft_set_scope'`; antes de leer `path`, llamar a
      `validateToolArgs` con la definición de `trail_set_scope` (vía `findTool`); rechazo → `reply` con
      `isError: true` sin tocar `clientRoot`. Prohibido agregar variables de estado nuevas.
- [x] 3.2 `injectClientScope`: recibir la definición de la tool y no inyectar `in` si su schema no
      declara `in`, ni cuando `arguments` no es un objeto (array, string, número, booleano).

## 4. Pruebas

- [x] 4.1 Crear `test/mcp-args.test.ts` con un caso por scenario del spec
      `openspec/changes/mcp-validar-argumentos/specs/mcp-argumentos/spec.md` (los de `callTool` en
      proceso; los de `trail_set_scope`, scope inyectado y `trail_build` por stdio con
      `node --import tsx src/cli.ts mcp <dir>`, helper propio copiado de `test/mcp-server.test.ts`; bajo
      tsx el hijo de `trail_build` apunta a un `cli.js` inexistente y falla en silencio: la prueba solo
      afirma el texto de respuesta). Incluir los dos recorridos de `TOOLS`: clave `zzz_desconocida`
      rechazada en las nueve tools y valor mal tipado rechazado en cada propiedad tipada; schemas con
      `additionalProperties: false`; descripciones sin `default-core`/`Desarrollo`/`C:/Users`;
      descripción de `trail_set_scope` con `shared by every client connected to it`.
- [x] 4.2 `test/mcp-tools.test.ts:181` (`/requires a symbol/`) → `/missing required argument "symbol"/`
      y `:238` (`/requires a pattern/`) → `/missing required argument "pattern"/`. Mensaje cambiado a
      propósito (spec). Verificado: `:135-137` (`/unknown tool/i`) sigue pasando. No tocar las pruebas
      rojas de la baseline.
- [x] 4.3 Revisar que las pruebas vigentes que llaman `callTool`/tools por stdio siguen pasando con tipos
      estrictos (`test/workspace-semantic.test.ts`, `test/graph-*.test.ts`, `test/mcp-server.test.ts`,
      `test/trail-name.test.ts`): si alguna manda un valor mal tipado, se corrige la prueba (el
      contrato cambió a propósito) y se declara en el handoff.

## 5. Docs

- [x] 5.1 NO editar `CHANGELOG.md` (en este repo se escribe solo en el commit de release; #12, #17 y #19
      tampoco lo tocan). Deja en `metadata.pr_notes` el texto para la descripción del PR: las tools MCP rechazan
      argumentos desconocidos y valores de tipo equivocado (sin coerción), `trail_set_scope`/`trail_build` vuelven
      a despacharse, el scope de `trail_set_scope` es compartido por todos los clientes del servidor (ver #20), y
      la nota de despliegue: servidor MCP único por PC (mcp-proxy :3104) que hay que reiniciar tras reinstalar.

## 6. Verificación final

- [x] 6.1 `npx tsc -p tsconfig.json --noEmit` → 0 errores.
- [x] 6.2 `openspec validate mcp-validar-argumentos --strict` → válido.
- [x] 6.3 Pruebas por archivo: `test/mcp-args.test.ts`, `test/mcp-tools.test.ts`,
      `test/mcp-server.test.ts`, `test/trail-name.test.ts`, `test/claude-skill-template.test.ts`,
      `test/graph-load.test.ts`, `test/graph-refresh.test.ts`, `test/graph-seed.test.ts`,
      `test/graph-follow-submodules.test.ts`, `test/workspace-semantic.test.ts`. Comparar contra la
      baseline de la propuesta: los únicos rojos permitidos son los de la baseline; ninguno nuevo.
- [x] 6.4 Suite completa `npm test` OPCIONAL y con tope (p. ej. `timeout 1200 npm test`): en esta máquina se
      cuelga en `test/trail-name.test.ts` (preexistente). Si se cuelga, repórtalo con el archivo; la compuerta
      real es 6.3 contra la baseline.
