# Design

## Contexto

Los agentes llaman a las tools MCP de trail con nombres de argumento de otros servidores. Hoy:

- `callTool` (`src/mcp/tools.ts`, desde la línea 264) no valida: cada handler lee solo los argumentos que
  conoce (`String(args.query ?? '')`, `typeof args.limit === 'number' ? args.limit : 5`, ...) e ignora el
  resto; un valor de tipo equivocado cae al default sin avisar (reproducido: `limit: "3"`, `query: 123`,
  `direction: "up"`, `depth: "3"`, `fixed: "true"`, todos con `isError: false`).
- Ningún `inputSchema` (`tools.ts:47-166`) declara `additionalProperties`.
- `trail_set_scope` se atiende en `src/mcp/server.ts:98-108` antes de `callTool` y lee solo `args['path']`.
- `injectClientScope` (`server.ts:128-134`) agrega `in` a **todas** las llamadas cuando hay scope fijado,
  incluidas las tools que no declaran `in`.

Despliegue: trail corre como UN solo servidor MCP por PC (mcp-proxy `:3104`, `trail mcp <carpeta raíz>`),
compartido por todos los perfiles de Hermes (dato del usuario, no verificado por mí contra el proxy). Un
cambio de contrato llega a todos los agentes a la vez al reinstalar.

## Decisiones

### D1. Un solo validador puro, alimentado por el schema

`src/mcp/validate-args.ts` (archivo nuevo, sin importar `tools.ts`: `tools.ts` lo importa y un import
inverso sería circular). Firma: `validateToolArgs(def: ToolDef, args: unknown): { ok: true; args:
Record<string, unknown> } | { ok: false; text: string }`. Es una función pura: sin estado, sin E/S, así
que no agrega estado por proceso y es segura bajo un servidor compartido. Lee `properties`, `required`,
`type` y `enum` de `def.inputSchema` (hoy tipado `object`: cast local). Excepciones declaradas en el
propio archivo: `ARG_SYNONYMS = { trail_trace_calls: { file: 'symbol' } }`, `ARG_HINTS` (tabla del spec)
y `VALUE_RULES = { trail_trace_calls: { depth: número finito | 'all' | 'full' } }` (ver D7). Por qué sin
listas por tool: #18 (agrega `limit` a `find_all`) y futuras propiedades solo editan el schema.

### D2. Dónde se llama

- `callTool`: primer paso del `try`, justo después de `canonicalToolName` y de resolver la definición
  (`findTool`, nueva función exportada: `TOOLS.find(t => canonicalToolName(t.name) === name)`). Sin
  definición: `unknown tool "<pedido>"; available: ...`. Va antes de `readWorkspace`/`ensureFresh*` para
  que un rechazo no cueste un refresh.
- `server.ts`, rama de `trail_set_scope`: la misma función antes de leer `path`.
- Se descarta validar en `server.ts` para todas las tools: los tests y otros llamadores usan `callTool`
  directo y quedarían sin la regla.

### D3. Error como resultado, no como error JSON-RPC (P5=1)

`isError: true` con texto, igual que el resto de errores blandos de `callTool` ("`callTool` never throws —
hosts get soft errors as isError content", `tools.ts:3`) y como pide el issue. Un `-32602` queda
descartado: el agente recibiría un error de protocolo en vez de un texto que puede corregir (sospecha, no
verificada contra cada cliente MCP).

### D4. injectClientScope solo donde hay `in`

Con la validación en `callTool`, el `in` inyectado en `trail_file_api`, `trail_check_freshness`,
`trail_build` y `trail_repo_map` sería rechazado como desconocido (el agente no lo envió). La función
recibe la definición de la tool y no inyecta si el schema no declara `in`. Tampoco inyecta cuando
`arguments` no es un objeto.

### D5. Código muerto que el validador deja al descubierto (P4=1)

`canonicalToolName` devuelve `graft_*` (`tool-names.ts:50-53`), pero `server.ts:98` compara con
`'trail_set_scope'` y `tools.ts:329` tiene `case 'trail_build'`. Reproducido contra `dist/` del worktree
(rebasado sobre `dee8a0d`): `trail_set_scope` y `trail_build` responden `unknown tool: graft_set_scope` /
`graft_build`. Se corrigen aquí (dos literales) por la decisión P4=1 del usuario.

**Consecuencia que el spec cubre y la propuesta declara:** hoy nadie puede fijar el scope por MCP porque
la rama es inalcanzable; al arreglarla, `clientRoot` (una variable por proceso) pasa a escribirse con
`trail_set_scope`, y bajo el servidor compartido la última llamada de cualquier cliente gana para todos.
No se agrega estado nuevo (requirement «Validación de trail_set_scope en el servidor»); la descripción de
la tool pasa a decirlo (requirement «Descripción de set_scope declara que el scope es compartido»). La
solución real es #20. Hechos verificados: las skills de Hermes ya prohíben `trail_set_scope`
(`skills/devops/detacoop-leyes/SKILL.md:110`, `skills/devops/trail-code/SKILL.md:43`), pero el propio
servidor lo recomienda a cualquier cliente en sus instrucciones (`src/mcp/instructions.ts:54`:
«set the session scope once») y `clientRoot` ya se escribe hoy desde `roots` en `initialize`
(`server.ts:64-66`).

### D6. No se aplica inBrand al texto de salida

`inBrand` reescribe la palabra `graft` en cualquier texto; aplicado a la respuesta completa tocaría
código del usuario en resultados de `find_all`/`find_code`. Los mensajes propios se construyen con el
nombre anunciado (`def.name`, siempre `trail_*`).

### D7. Validar tipos de valores: rechazar, no coercionar (P3=2)

El usuario pidió validar el tipo de los valores; la política para un número enviado como string queda
decidida aquí con su porqué:

| Opción | Efecto | Veredicto |
|---|---|---|
| **Rechazar** `limit: "3"` con `invalid argument "limit" for trail_find_code: expected number, got string` | Un reintento del agente | **Elegida** |
| Coercionar `"3"` → `3` | Sin reintento, pero hay que decidir `"3.5"`, `"1e3"`, `" 3"`, `""`, `"true"`, y el validador tendría que devolver `arguments` reescritos que los handlers lean en lugar del original | Descartada |

Por qué rechazar: (1) hoy `limit: "3"` ya se ignora y cae al default 5 (reproducido), así que rechazarlo
no rompe ninguna llamada que funcione: solo hace visible un fallo que existe; (2) coerción obliga a una
tabla de formatos aceptables y a que lo que ve el handler difiera de lo que mandó el agente, justo el
tipo de silencio que el issue quiere eliminar; (3) el mensaje nombra el tipo esperado y el recibido, y
con un solo servidor compartido el costo es un reintento por cliente, una vez. Mi afirmación previa de
«hay clientes que mandan números como string» **no está verificada**; si existieran, verían el error y
corregirían.

Reglas (todas derivadas del schema salvo `depth`):

- `type: 'string'` → `typeof === 'string'` (el vacío pasa; lo rechaza el guard del handler);
  `'number'` → `typeof === 'number'` y `Number.isFinite`; `'boolean'` → `typeof === 'boolean'`.
- `null`/`undefined` = ausente (coherente con «requerido ausente»).
- `enum` (hoy solo `direction`): el valor debe estar en la lista; `got` muestra el string entre comillas
  (máx. 40 caracteres) para que se vea el error; para no-strings, el tipo.
- `depth`: el schema no declara `type` (acepta número o `"all"`; el handler acepta además `"full"`,
  `tools.ts:366`). Cambiar el schema a `oneOf` alteraría lo que `tools/list` anuncia a todos los hosts a
  la vez y algunos convertidores de schema no soportan `oneOf`; en su lugar, una regla declarada en el
  validador (excepción documentada en D1) y el schema anunciado no cambia.
- No se validan rangos (`limit: 0`, negativos, decimales): un tema por PR y el comportamiento actual de
  esos valores no está especificado; queda fuera de alcance.
- El orden de las cláusulas de valor sigue el de `properties` del schema (determinista).
- Formato: `invalid argument "<n>" for <tool>: expected <E>, got <G>`; si ya hay una cláusula previa, sin
  `for <tool>`. La cláusula final `expected one of: ...` solo acompaña a rechazos con cláusulas (a)/(b).

### D8. Tampoco se agrega estado al servidor compartido

Ni el validador ni `findTool` guardan nada entre llamadas; `injectClientScope` sigue siendo función pura
de sus parámetros. Lo único mutable sigue siendo `clientRoot`, que este change no toca salvo para hacer
alcanzable su escritura (D5).

## Riesgos

| Riesgo | Mitigación |
|---|---|
| Un cliente que hoy manda argumentos de más o de tipo equivocado pasa a recibir error, y a TODOS los agentes a la vez al reinstalar | Es el objetivo del issue; el mensaje nombra lo esperado. Verificado: las skills `detacoop-*` del perfil default usan `trail_find_code {query, in}`, `trail_find_all {pattern, in}`, `trail_trace_calls {symbol, in}`, que cumplen el contrato nuevo (otros perfiles y repos: no revisados). Único argumento extra usado por el propio código: `file` en `trace_calls` (sinónimo conservado) e `in` inyectado (D4) |
| `trail_set_scope` pasa a funcionar y su estado es global al servidor compartido | D5: sin estado nuevo, descripción veraz, nota de despliegue; las skills de Hermes ya lo prohíben. Remedio real: #20 antes o junto con la reinstalación |
| Hosts que validan con `additionalProperties:false` y envían `in` automático | El servidor ya no lo inyecta donde no existe (D4) |
| Solape con #18 y #20 en `tools.ts` y `server.ts` | Ver `propuesta.md` §7 |
| Rojos preexistentes de la suite (`mcp-tools`, `mcp-server`, `trail-name`) | No se tocan (CONTRIBUTING.md:81); se compara contra la baseline |

## Nota de despliegue

Un solo servidor por PC: reinstalar el paquete y reiniciar el servicio cambia el contrato para todos los
agentes a la vez. Orden recomendado: (1) fusionar este PR, (2) fusionar #20 (o decidir conscientemente
dejar `set_scope` expuesto), (3) reinstalar y reiniciar mcp-proxy, (4) humo: `trail_find_all` con
`pattern` responde y con `query` devuelve `did you mean "pattern"?`. Publicar en npm y reinstalar quedan
fuera de este change.

## Fuera de alcance

- Rangos de valores (`limit: 0`/negativo).
- `in` ignorado en modo workspace por `find_all` (`tools.ts:221-224`, `federateGrep` no lo recibe) y
  `depth`/`in` de `trace_calls` en modo workspace (`callWorkspaceTool` solo lee `depth` numérico,
  `tools.ts:213`): #14/#18/#15. (`search_semantic` ya honra `in` tras #19.)
- Estado de scope global por proceso (#20).
- Mensajes `graft` fuera de `src/mcp/tools.ts` (p. ej. `graft check: NO GRAPH` en `check_freshness`,
  `src/mcp/instructions.ts` bajo la marca `graft`).
