# mcp-argumentos Specification

## Purpose
Contrato de argumentos de las tools MCP de trail: el servidor valida nombres y valores de cada llamada
contra el `inputSchema` que anuncia, rechaza lo desconocido o mal tipado con un mensaje que nombra lo
esperado, y nunca ejecuta una consulta con filtros que el agente cree haber puesto y el servidor ignoró.

## Requirements

### Requirement: Rechazo de argumentos desconocidos

El sistema SHALL rechazar toda llamada a una tool MCP cuyo objeto `arguments` contenga una clave que
no figure en `properties` del `inputSchema` de esa tool, devolviendo `isError: true` y sin ejecutar
la consulta.

#### Scenario: find_all con un parámetro desconocido no hace búsqueda

GIVEN un repo con grafo construido que contiene la función `add`
WHEN se llama `trail_find_all` con `{ "pattern": "add", "paths": "a" }`
THEN la respuesta tiene `isError: true`, el texto contiene `unknown argument "paths" (did you mean "in"?) for trail_find_all`
y `expected one of: pattern, in, limit, ignore_case, fixed`, y no contiene ningún resultado de búsqueda

#### Scenario: varias claves desconocidas

GIVEN cualquier repo
WHEN se llama `trail_check_freshness` con `{ "foo": 1, "bar": 2 }`
THEN el texto empieza con `unknown arguments "foo", "bar" for trail_check_freshness` y termina en
`expected no arguments`

### Requirement: Argumentos requeridos ausentes

El sistema SHALL rechazar toda llamada a la que le falte una propiedad listada en `required` del
`inputSchema`, con `isError: true`. Una propiedad cuenta como presente cuando la clave existe y su
valor no es `undefined` ni `null`; un string vacío cuenta como presente.

#### Scenario: falta el argumento requerido sin claves desconocidas

GIVEN un repo con grafo construido
WHEN se llama `trail_trace_calls` con `{}`
THEN el texto es exactamente `missing required argument "symbol" for trail_trace_calls; expected one
of: symbol, direction, depth, in` con `isError: true`

#### Scenario: string vacío cuenta como presente

GIVEN un repo con grafo construido
WHEN se llama `trail_find_all` con `{ "pattern": "" }`
THEN el validador no rechaza la llamada; el guard del handler responde `trail_find_all requires a
non-empty "pattern"` con `isError: true`

### Requirement: Cláusulas del mensaje de validación

El texto de un rechazo SHALL unir con `; `, en este orden, las cláusulas que apliquen: (a) si hay
claves desconocidas, `unknown argument "<clave>"` (varias: `unknown arguments "<c1>", "<c2>"`);
(b) si faltan requeridas, `missing required argument "<n>"` (varias: `missing required arguments
"<n1>", "<n2>"`); (c) una cláusula por valor inválido, en el orden de `properties` del schema.

#### Scenario: solo falta un requerido

GIVEN cualquier repo
WHEN se llama `trail_find_code` con `{}`
THEN el texto es exactamente `missing required argument "query" for trail_find_code; expected one of:
query, limit, full, in` con `isError: true`

#### Scenario: desconocido, faltante y valor inválido juntos

GIVEN cualquier repo
WHEN se llama `trail_find_code` con `{ "pattern": "x", "limit": "3" }`
THEN el texto es exactamente `unknown argument "pattern" (did you mean "query"?) for trail_find_code;
missing required argument "query"; invalid argument "limit": expected number, got string; expected one
of: query, limit, full, in`

### Requirement: Posición del nombre de la tool en el mensaje

La primera cláusula del texto de un rechazo, sea (a), (b) o (c), SHALL llevar ` for <tool>` justo
después de su lista de argumentos y de las pistas (en (c), antes de los dos puntos); las demás
cláusulas no lo llevan.

#### Scenario: la tool aparece una sola vez

GIVEN cualquier repo
WHEN se llama `trail_find_all` con `{ "pattern": "x", "fixed": "a", "ignore_case": "b" }`
THEN el texto contiene `for trail_find_all` exactamente una vez

### Requirement: Cláusula expected y nombre anunciado

El texto de un rechazo que contenga la cláusula (a) o la (b) SHALL terminar con `expected one of:
<propiedades del schema separadas por ", " en su orden>`, o con `expected no arguments` si el schema no
tiene propiedades. Un rechazo que contenga solo cláusulas (c) no lleva esa cláusula final. `<tool>`
SHALL ser el nombre anunciado en `tools/list` (`trail_*`), nunca `graft_*`.

#### Scenario: find_all con query en vez de pattern

GIVEN cualquier repo
WHEN se llama `trail_find_all` con `{ "query": "x" }`
THEN el texto es exactamente `unknown argument "query" (did you mean "pattern"?) for trail_find_all;
missing required argument "pattern"; expected one of: pattern, in, limit, ignore_case, fixed` con
`isError: true`

#### Scenario: set_scope con paths en vez de path

GIVEN un servidor MCP arrancado sobre un directorio
WHEN se llama `trail_set_scope` con `{ "paths": "C:/x/y" }`
THEN el texto es exactamente `unknown argument "paths" (did you mean "path"?) for trail_set_scope;
missing required argument "path"; expected one of: path` con `isError: true`, y el scope de la
sesión no cambia

### Requirement: Pista del nombre correcto

Tras cada clave desconocida el sistema SHALL añadir ` (did you mean "<propiedad>"?)` cuando encuentre
una candidata, y nada cuando no la encuentre. Una propiedad que ya viene en la llamada SHALL NOT
proponerse como candidata.

#### Scenario: la pista va tras cada clave desconocida

GIVEN cualquier repo
WHEN se llama `trail_find_all` con `{ "pattern": "x", "ignoreCase": true, "paths": "s" }`
THEN el texto empieza con `unknown arguments "ignoreCase" (did you mean "ignore_case"?), "paths" (did
you mean "in"?) for trail_find_all;`

#### Scenario: sin candidata no hay pista

GIVEN cualquier repo
WHEN se llama `trail_find_all` con `{ "pattern": "x", "zzz": 1 }`
THEN el texto empieza con `unknown argument "zzz" for trail_find_all;` (sin paréntesis tras la clave)

#### Scenario: la candidata ya viene en la llamada

GIVEN cualquier repo
WHEN se llama `trail_find_code` con `{ "query": "x", "pattern": "y" }`
THEN el texto empieza con `unknown argument "pattern" for trail_find_code;` (sin pista, porque `query`
ya está presente)

### Requirement: Búsqueda de la candidata

La candidata SHALL buscarse recorriendo las propiedades del schema en su orden: (1) la primera cuyo
nombre normalizado (minúsculas, sin `_` ni `-`) sea igual al de la clave; (2) la primera cuyo nombre y
el de la clave normalizados midan ambos al menos 4 caracteres y estén a distancia de Levenshtein
menor o igual a 2; (3) la propiedad que indique la tabla de pistas para esa tool y esa clave.

#### Scenario: pistas por regla (1), (2) y (3)

GIVEN cualquier repo
WHEN se llama `trail_find_all` con `{ "pattern": "x", "ignoreCase": true }`
AND `trail_find_code` con `{ "query": "x", "limite": 3 }`
AND `trail_find_all` con `{ "pattern": "x", "paths": "src" }`
THEN los textos contienen respectivamente `"ignoreCase" (did you mean "ignore_case"?)`,
`"limite" (did you mean "limit"?)` y `"paths" (did you mean "in"?)`

### Requirement: Tabla de pistas de las tools de búsqueda

La tabla de pistas SHALL contener para `trail_find_all` las parejas `query→pattern`, `regex→pattern`,
`path→in`, `paths→in`; y para `trail_find_code` y `trail_search_semantic` las parejas `pattern→query`,
`path→in`, `paths→in`. Las claves de la tabla siguen siendo desconocidas: la pista no las acepta como
alias.

#### Scenario: search_semantic con pattern

GIVEN cualquier repo
WHEN se llama `trail_search_semantic` con `{ "pattern": "x" }`
THEN el texto es exactamente `unknown argument "pattern" (did you mean "query"?) for
trail_search_semantic; missing required argument "query"; expected one of: query, limit, in` con
`isError: true`

### Requirement: Tabla de pistas de las demás tools

La tabla de pistas SHALL contener para `trail_trace_calls` las parejas `name→symbol`, `query→symbol`,
`path→in`, `paths→in`; para `trail_file_api`, `path→file` y `paths→file`; y para `trail_set_scope`,
`paths→path`. La tabla no contiene ninguna otra pareja.

#### Scenario: una clave de la tabla no se acepta

GIVEN un repo con grafo construido
WHEN se llama `trail_file_api` con `{ "path": "src/math.ts" }`
THEN la respuesta es `isError: true` con `did you mean "file"?` y no devuelve las firmas del archivo

### Requirement: Tipo de los valores

El sistema SHALL rechazar, con `isError: true` y sin ejecutar la consulta, todo argumento presente
cuyo valor no coincida con el `type` que declara su propiedad en el schema: `string` exige un string,
`number` un número finito, `boolean` un booleano. No hay coerción: `"3"` no cuenta como número ni
`"true"` como booleano. Un valor `null` cuenta como ausente (no se valida). El sistema no valida
rangos: `limit: 0`, negativos o decimales pasan este requirement.

#### Scenario: limit como string se rechaza

GIVEN un repo con grafo construido
WHEN se llama `trail_find_code` con `{ "query": "add", "limit": "3" }`
THEN el texto es exactamente `invalid argument "limit" for trail_find_code: expected number, got
string` con `isError: true`, y no contiene resultados de búsqueda

#### Scenario: query numérica se rechaza

GIVEN un repo con grafo construido
WHEN se llama `trail_find_code` con `{ "query": 123 }`
THEN el texto es exactamente `invalid argument "query" for trail_find_code: expected string, got
number` (no `missing required argument`, porque la clave está presente)

#### Scenario: booleano como string se rechaza

GIVEN un repo con grafo construido
WHEN se llama `trail_find_all` con `{ "pattern": "add", "fixed": "true" }`
THEN el texto es exactamente `invalid argument "fixed" for trail_find_all: expected boolean, got
string` con `isError: true`

#### Scenario: varios valores inválidos en orden del schema

GIVEN cualquier repo
WHEN se llama `trail_find_all` con `{ "pattern": "x", "fixed": "a", "ignore_case": "b" }`
THEN el texto es exactamente `invalid argument "ignore_case" for trail_find_all: expected boolean, got
string; invalid argument "fixed": expected boolean, got string`

#### Scenario: null cuenta como ausente y el rango no se valida

GIVEN un repo con grafo construido
WHEN se llama `trail_find_code` con `{ "query": "add", "limit": null }`
AND `trail_find_code` con `{ "query": "add", "limit": 0 }`
THEN ninguna de las dos respuestas contiene `invalid argument`

#### Scenario: valores bien tipados siguen funcionando

GIVEN un repo con grafo construido que contiene la función `add`
WHEN se llama `trail_find_all` con `{ "pattern": "add", "fixed": true, "ignore_case": false }`
AND `trail_find_code` con `{ "query": "add", "limit": 3 }`
THEN ambas responden `isError: false` con resultados de búsqueda

### Requirement: Valores enumerados

El sistema SHALL rechazar un valor presente que no figure en el `enum` de su propiedad (hoy solo
`direction` de `trail_trace_calls`, con `in` y `out`). La cláusula usa los valores del `enum` entre
comillas dobles unidos con ` or `. Si el valor es un string, `got` lo muestra entre comillas dobles y
cortado a 40 caracteres; si no lo es, `got` es el tipo.

#### Scenario: direction inválida

GIVEN un repo con grafo construido
WHEN se llama `trail_trace_calls` con `{ "symbol": "add", "direction": "up" }`
THEN el texto es exactamente `invalid argument "direction" for trail_trace_calls: expected "in" or
"out", got "up"` con `isError: true`

### Requirement: Valor de depth

El schema de `depth` en `trail_trace_calls` no declara `type`, así que el validador SHALL tener una
regla declarada en `src/mcp/validate-args.ts` que acepte un número finito o el string `"all"` (también
`"full"`, que los handlers aceptan sin anunciarlo). Cualquier otro valor se rechaza con `expected
number or "all"`. El schema anunciado en `tools/list` SHALL quedar sin cambios.

#### Scenario: depth como string numérico se rechaza

GIVEN un repo con grafo construido
WHEN se llama `trail_trace_calls` con `{ "symbol": "add", "depth": "3" }`
THEN el texto es exactamente `invalid argument "depth" for trail_trace_calls: expected number or
"all", got "3"` con `isError: true`

#### Scenario: depth number, all y full pasan

GIVEN un repo con grafo construido
WHEN se llama `trail_trace_calls` con `depth` igual a `2`, `"all"` y `"full"`
THEN ninguna respuesta contiene `invalid argument`

### Requirement: Argumentos que no son un objeto

El sistema SHALL responder `isError: true` con el texto `arguments for <tool> must be an object` cuando
`arguments` sea un array, un string, un número o un booleano, sin evaluar claves. Un `arguments`
ausente o `null` SHALL tratarse como `{}`.

#### Scenario: arguments es un array

GIVEN cualquier repo
WHEN se llama `trail_find_all` con `arguments` igual a `["add"]`
THEN el texto es `arguments for trail_find_all must be an object` con `isError: true`

### Requirement: Validación antes de cualquier trabajo

La validación SHALL ser el primer paso de `callTool`: después de resolver el nombre con
`canonicalToolName` y antes de leer el workspace, refrescar el grafo o cargarlo. Así `graft_find_all`
y los alias antiguos (`graft_ask`, `graft_grep`, ...) se validan contra el schema de su tool actual,
y un rechazo no cuesta un refresh.

#### Scenario: la validación no toca disco

GIVEN un directorio sin grafo ni repositorio
WHEN se llama `callTool` con `trail_find_all` y `{ "query": "x" }`
THEN responde el error de validación y no crea ni modifica archivos en el directorio

#### Scenario: nombre antiguo se valida contra el schema actual

GIVEN cualquier repo
WHEN se llama `graft_grep` con `{ "query": "x" }`
THEN el texto contiene `for trail_find_all` (nombre anunciado, no `graft_grep`)

### Requirement: Validación de trail_set_scope en el servidor

`trail_set_scope` se atiende en `src/mcp/server.ts` sin pasar por `callTool`; ese manejo SHALL llamar
a la misma función de validación que `callTool` antes de leer `path`, y responder el rechazo con
`isError: true` sin modificar el scope de la sesión. El servidor SHALL NOT guardar ningún estado nuevo
por proceso: el único estado de scope es el `clientRoot` que ya existe.

#### Scenario: set_scope rechazado no cambia el scope

GIVEN un servidor MCP sobre `<repo>` con scope fijado a `<repo>/src`
WHEN se llama `trail_set_scope` con `{ "paths": "<repo>/other" }` y luego `trail_find_code` con
`{ "query": "add" }`
THEN la segunda llamada sigue recibiendo `in: "src"` inyectado

#### Scenario: set_scope con path de tipo inválido

GIVEN un servidor MCP arrancado sobre un directorio
WHEN se llama `trail_set_scope` con `{ "path": 5 }`
THEN el texto es exactamente `invalid argument "path" for trail_set_scope: expected string, got
number` con `isError: true`

### Requirement: Tool inexistente

Un nombre que, tras `canonicalToolName`, no corresponda a ninguna tool de `TOOLS` SHALL responder
`isError: true` con `unknown tool "<nombre pedido, tal cual>"; available: <nombres de TOOLS
separados por ", ">`.

#### Scenario: tool inexistente

GIVEN cualquier repo
WHEN se llama `trail_nope` con `{}`
THEN el texto empieza con `unknown tool "trail_nope"; available: trail_set_scope, trail_find_code,`
y `isError` es `true`

### Requirement: Sinónimo file de trace_calls

El sistema SHALL seguir aceptando `file` como sinónimo no anunciado de `symbol` en `trail_trace_calls`
(los handlers leen `args.symbol ?? args.file`): la clave `file` no se rechaza como desconocida, satisface
el requerido `symbol` y se valida con el tipo de `symbol` (string). El schema anunciado SHALL seguir sin
listar `file`.

#### Scenario: trace_calls con file

GIVEN un repo con grafo construido que contiene `src/math.ts`
WHEN se llama `trail_trace_calls` con `{ "file": "src/math.ts", "depth": 2 }`
THEN la llamada no se rechaza por validación y responde igual que con `{ "symbol": "src/math.ts",
"depth": 2 }`

### Requirement: Schemas con additionalProperties false

Cada `inputSchema` de `TOOLS` SHALL declarar `additionalProperties: false`, para que los hosts que
validan del lado del cliente rechacen lo desconocido antes de enviarlo.

#### Scenario: todos los schemas lo declaran

GIVEN el arreglo `TOOLS`
WHEN se recorre cada entrada
THEN cada `inputSchema.additionalProperties` es `false`

### Requirement: El validador deriva todo del schema

El validador SHALL obtener las propiedades permitidas, las requeridas, los tipos y los `enum` únicamente
de `properties`, `required`, `type` y `enum` del `inputSchema` de cada tool, sin listas paralelas por
tool. Las únicas excepciones declaradas son la tabla de pistas, el sinónimo `file` y la regla de `depth`.
Añadir una propiedad tipada al schema la hace válida y validada sin otro cambio.

#### Scenario: toda clave desconocida se rechaza en toda tool

GIVEN el arreglo `TOOLS`
WHEN, para cada tool, se llama `callTool` con las propiedades requeridas en un valor válido de su tipo
más la clave `zzz_desconocida`
THEN las nueve respuestas tienen `isError: true` y su texto contiene `unknown argument
"zzz_desconocida" for <nombre de esa tool>`

#### Scenario: todo valor mal tipado se rechaza en toda tool

GIVEN el arreglo `TOOLS`
WHEN, para cada propiedad de cada tool que declara `type` (`string`, `number` o `boolean`), se llama
`callTool` con las requeridas en un valor válido y esa propiedad en un valor de otro tipo (`5` si
espera `string`; `"x"` si espera `number` o `boolean`)
THEN cada respuesta tiene `isError: true` y su texto contiene `invalid argument "<propiedad>"` y `, got `
(ocho tools con propiedades tipadas; 19 propiedades en total, `depth` excluida porque su schema no declara `type`)

### Requirement: Scope de sesión solo donde la tool declara in

`injectClientScope` (`src/mcp/server.ts`) SHALL inyectar `in` únicamente cuando el schema de la tool
llamada declara la propiedad `in`. Con la validación activa, inyectarlo en una tool que no lo declara
(`trail_file_api`, `trail_check_freshness`, `trail_build`, `trail_repo_map`) la haría rechazarse a sí
misma como argumento desconocido.

#### Scenario: tras fijar scope, una tool sin in sigue funcionando

GIVEN un servidor MCP sobre `<repo>` y `trail_set_scope` con `{ "path": "<repo>/src" }` ya aceptado
WHEN se llama `trail_check_freshness` con `{}`
THEN la respuesta no contiene `unknown argument`

### Requirement: Scope de sesión no toca arguments que no es objeto

`injectClientScope` SHALL NOT inyectar nada cuando `arguments` no es un objeto: la copia con spread
convertiría un array en un objeto con claves `0`, `1`, ... y ocultaría el error `must be an object`.

#### Scenario: array con scope fijado

GIVEN un servidor MCP con scope fijado a `<repo>/src`
WHEN se llama `trail_find_all` con `arguments` igual a `["add"]`
THEN el texto es `arguments for trail_find_all must be an object` con `isError: true`

### Requirement: trail_set_scope alcanzable

El servidor SHALL despachar `trail_set_scope` a su handler bajo cualquier nombre aceptado (`trail_*`
y `graft_*`). Hoy la comparación es contra `'trail_set_scope'` (`src/mcp/server.ts:98`) pero
`canonicalToolName` devuelve `graft_set_scope` (`src/mcp/tool-names.ts:50-53`), así que la rama nunca
se alcanza y la respuesta es `unknown tool: graft_set_scope`.

#### Scenario: set_scope válido fija el scope

GIVEN un servidor MCP arrancado sobre `<repo>`
WHEN se llama `trail_set_scope` con `{ "path": "<repo>/src" }`
THEN la respuesta es `isError: false` con texto `scope set to: src — all queries will narrow to this
path automatically`

### Requirement: Descripción de set_scope declara que el scope es compartido

La descripción de `trail_set_scope` SHALL incluir la frase `The scope is held by the server process and
shared by every client connected to it; the last call wins.` Es la descripción veraz del estado que ya
existe (`clientRoot`); este requirement no cambia ese estado. Reemplazarlo por un estado por sesión es
trabajo del issue #20.

#### Scenario: la descripción avisa del alcance

GIVEN el arreglo `TOOLS`
WHEN se lee la descripción de `trail_set_scope`
THEN contiene `shared by every client connected to it`

### Requirement: trail_build alcanzable

`callTool` SHALL despachar `trail_build` a su implementación bajo cualquier nombre aceptado. Hoy el
`case 'trail_build'` (`src/mcp/tools.ts`, rama `callSingleTool`) nunca se alcanza porque
`canonicalToolName` devuelve `graft_build`, y la respuesta es `unknown tool: graft_build`.

#### Scenario: build se despacha

GIVEN un servidor MCP arrancado sobre un repo
WHEN se llama `trail_build` con `{ "semantic": false }`
THEN la respuesta empieza con `trail build started in background` y `isError` es `false`

#### Scenario: build con include_md como string se rechaza

GIVEN un servidor MCP arrancado sobre un repo
WHEN se llama `trail_build` con `{ "include_md": "yes" }`
THEN el texto es exactamente `invalid argument "include_md" for trail_build: expected boolean, got
string` y no se lanza ningún build

### Requirement: callTool no atiende set_scope

`callTool` invocado directamente con `trail_set_scope` y argumentos válidos SHALL responder
`isError: true` con `trail_set_scope is handled by the MCP server, not by callTool`, en lugar de
`unknown tool`.

#### Scenario: callTool con set_scope válido

GIVEN cualquier repo
WHEN se llama `callTool` con `trail_set_scope` y `{ "path": "x" }`
THEN el texto es `trail_set_scope is handled by the MCP server, not by callTool` con `isError: true`

### Requirement: Guards con el nombre anunciado

Los nueve literales `graft_<tool> requires a <arg>` de `src/mcp/tools.ts` (los encuentra
`grep -n "requires a" src/mcp/tools.ts`) SHALL pasar a `<tool anunciada> requires a non-empty
"<arg>"`, usando el nombre `trail_*`. Ningún texto de error de `src/mcp/tools.ts` SHALL contener
`graft_`. Aplicar `inBrand` al texto completo de las respuestas queda prohibido: reescribiría la
palabra `graft` dentro de código del usuario devuelto en resultados de búsqueda.

#### Scenario: ningún mensaje de tools.ts nombra graft_

GIVEN el código de `src/mcp/tools.ts`
WHEN se buscan los literales de texto que contienen `requires a`
THEN ninguno contiene `graft_`

### Requirement: Descripciones genéricas

Las descripciones de `TOOLS` (de cada tool y de cada propiedad de su schema) SHALL NOT contener las
cadenas `default-core`, `Desarrollo` ni `C:/Users`; los ejemplos usan rutas genéricas
(`/path/to/project`, `packages/api`).

#### Scenario: descripciones sin rutas de un workspace concreto

GIVEN el arreglo `TOOLS`
WHEN se recorren las descripciones de cada tool y de cada propiedad de su schema
THEN ninguna contiene `default-core`, `Desarrollo` ni `C:/Users`
