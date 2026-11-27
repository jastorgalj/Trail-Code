# alcance-in-workspace Specification

## Purpose
Define cómo `trail_find_code`, `trail_trace_calls`, `trail_find_all`, `trail_search_semantic` y sus equivalentes
de CLI interpretan el parámetro `in` cuando el servidor o el CLI están enraizados en un workspace (carpeta con
varios repos hijos): una sola regla de resolución, el mismo error cuando no coincide y el mismo efecto en las
cuatro tools.

## Requirements

### Requirement: Normalización de in

El sistema SHALL normalizar `in` con `normalizePathPrefix` (`src/util/paths.ts:66`) antes de resolverlo:
`\` pasa a `/`, sin `./` inicial ni `/` final; vacío = ausente (todos los hijos). Un valor **absoluto**
SHALL convertirse a relativo a la raíz del workspace en `workspaceGraphsForIn` (donde hay `root`); si es
la raíz equivale a ausente, y si está fuera se pasa sin cambio y falla downstream.

#### Scenario: separadores y barra final

GIVEN un workspace con los hijos `a/x`, `a/y` y `b`
WHEN se resuelve `in` con `a\x\src`, `./a/x/src` y `a/x/src/`
THEN las tres resoluciones son idénticas a la de `a/x/src`

#### Scenario: in vacío es ausente

GIVEN el mismo workspace
WHEN se resuelve `in` con `/` y con `./`
THEN el resultado es igual al de no pasar `in`: los tres hijos y ningún sub-prefijo

#### Scenario: in absoluta dentro del workspace

GIVEN un workspace con root `/home/user/ws` y los hijos `a/x` y `b`
WHEN se llama una tool con `in: "/home/user/ws/a/x"` (ruta absoluta POSIX) o con `in: "C:/ws/a/x"` (Windows)
THEN la respuesta es `isError: false` e idéntica a la de `in: "a/x"` (relativa)

### Requirement: in dentro o igual a un hijo

El sistema SHALL resolver un `in` que es igual a un hijo, o que empieza con `<hijo>/`, a ese único hijo (el de
path más largo si varios coinciden), con el resto como sub-prefijo relativo al hijo (`undefined` cuando `in`
es el hijo mismo). La coincidencia SHALL ser por segmento de path y no por prefijo de texto.

#### Scenario: in con sub-prefijo

GIVEN un workspace con los hijos `a/x`, `a/y` y `b`
WHEN se resuelve `in` con `a/x/src`
THEN el resultado es un único destino: hijo `a/x`, sub-prefijo `src`

#### Scenario: in igual al hijo

GIVEN el mismo workspace
WHEN se resuelve `in` con `a/x`
THEN el resultado es un único destino: hijo `a/x`, sin sub-prefijo

#### Scenario: hijo compuesto gana al grupo

GIVEN un workspace con los hijos `default-core/frontend` y `default-core/backend`
WHEN se resuelve `in` con `default-core/frontend/src`
THEN el resultado es un único destino: hijo `default-core/frontend`, sub-prefijo `src`

### Requirement: in igual a un grupo de hijos

El sistema SHALL resolver un `in` que no es ni está dentro de ningún hijo, pero es ancestro de uno o más hijos
(algún hijo empieza con `<in>/`), a todos esos hijos, sin sub-prefijo. Razón: `trail_set_scope` sobre la
carpeta de un grupo inyecta ese grupo como `in`, y la documentación usa `in="default-core"`
(`README.md:507`).

#### Scenario: in igual a un grupo

GIVEN un workspace con los hijos `a/x`, `a/y` y `b`
WHEN se resuelve `in` con `a`
THEN los destinos son `a/x` y `a/y`, ambos sin sub-prefijo, y `b` no aparece

### Requirement: in sin coincidencia

El sistema SHALL rechazar un `in` sin coincidencia con `no workspace repo matching "<in>" — did you mean:
"<s1>", "<s2>", "<s3>"?`, con hasta 3 repos más cercanos por distancia de Levenshtein O(n·m) (ascendente;
empate alfabético). Las cuatro tools SHALL responder `isError: true` con ese mismo texto.

#### Scenario: in que no es hijo ni grupo

GIVEN un workspace con los hijos `a/x`, `a/y` y `b`, y `GRAFT_NO_REFRESH=1` en el entorno del test (sin nota
de refresco antepuesta)
WHEN se llama cada una de las cuatro tools con `in: "nope"`
THEN cada respuesta es `isError: true` y su texto es exactamente
`no workspace repo matching "nope" — did you mean: "a/x", "a/y", "b"?`

#### Scenario: coincidencia por segmento y no por texto

GIVEN el mismo workspace
WHEN se resuelve `in` con `a/xx` y con `a/x_`
THEN las dos resoluciones son el error `no workspace repo matching`, con la sugerencia `"a/x"` (distancia 1),
porque ningún hijo es igual a ellos ni empieza con ellos más `/`, ni son sufijo de ningún hijo

### Requirement: Sufijo único de un hijo

El sistema SHALL resolver un `in` que, sin coincidir con otra regla, es **sufijo de path** de exactamente
un hijo → ese hijo, con el resto de `in` como sub-prefijo relativo. Si es sufijo de dos o más hijos,
SHALL responder `"<in>" matches multiple repos: "<c1>", "<c2>" — be more specific`.
Razón: el agente suele escribir `backend` en vez de `default-core/backend`.

#### Scenario: sufijo único → inferir hijo

GIVEN un workspace con los hijos `default-core/backend` y `default-core/frontend`
WHEN se resuelve `in` con `backend` o con `backend/services/auth`
THEN el resultado es `{ ok: true, targets: [{ child: "default-core/backend", childIn: "services/auth" }] }`
(o `childIn: undefined` para el caso de solo `backend`)

#### Scenario: sufijo ambiguo → error con candidatos

GIVEN un workspace con los hijos `default-core/backend` e `infra-local/backend`
WHEN se resuelve `in` con `backend`
THEN el resultado es `isError: true` con texto que contiene `matches multiple repos`

### Requirement: Validar in antes de refrescar el grafo

El sistema SHALL validar `in` con `resolveWorkspaceIn` en `callTool` ANTES de `ensureFreshChildren`. Si
`in` no coincide, SHALL retornar `isError: true` sin refrescar ningún grafo; si coincide, SHALL refrescar
solo los hijos afectados. Razón: un typo en `in` no debe costar 4–17 s de refresh.

#### Scenario: in inválido → no hay refresh

GIVEN un workspace con los hijos `a/x`, `a/y` y `b` con grafos construidos
WHEN se llama `trail_find_code` con `in: "typo_repo"` (que no coincide con ningún hijo ni sufijo)
THEN la respuesta es `isError: true` con el texto de validación (sin nota de refresco),
y `ensureFreshChildren` no fue invocado (verificable con spy/mock en tests de integración)

#### Scenario: in válido → solo hijos afectados se refrescan

GIVEN el mismo workspace
WHEN se llama `trail_find_code` con `in: "a/x"` (un único hijo)
THEN `ensureFreshChildren` se invoca con `children: ["a/x"]` y no con `["a/x", "a/y", "b"]`

### Requirement: Las cuatro tools resuelven in por el mismo resolvedor

`federateAsk`, `federateCallers`, `federateGrep` y `federateSemantic` (`src/graph/workspace.ts`) SHALL
obtener los hijos en alcance y el sub-prefijo de cada uno únicamente de `resolveWorkspaceIn` (a través de
`scopeWorkspaceGraphs`), y SHALL NOT contener lógica propia que compare `in` con los paths de los hijos.
Razón: las tres copias de la regla son la causa de que el mismo `in` funcione en una tool y falle en otra.

#### Scenario: el mismo in da los mismos resultados en las cuatro tools

GIVEN un workspace con los hijos `a/x` (archivos `src/x.ts` con `sharedFn` y `lib/l.ts`), `a/y`
(`src/y.ts` con `sharedFn`) y `b` (`src/b.ts` con `sharedFn`), construido y con `embeddings.db` en cada hijo
WHEN se llama `trail_find_code`, `trail_trace_calls`, `trail_find_all` y `trail_search_semantic` sobre
`sharedFn` con `in: "a/x/src"`
THEN ninguna responde `isError: true`, ningún texto contiene `nothing indexed`, y todo path de resultado
empieza con `a/x/src/` (o `[a/x/]src/` en la semántica)

#### Scenario: no quedan copias de la regla

GIVEN el código de `src/graph/workspace.ts` tras el cambio
WHEN se busca `allChildren` e `inTrimmed`
THEN ninguna coincidencia cae dentro de `federateAsk`, `federateCallers`, `federateGrep` ni
`federateSemantic`

### Requirement: trace_calls pasa al hijo el sub-prefijo relativo al hijo

`federateCallers` SHALL llamar a `resolveSymbol` de cada hijo con el sub-prefijo relativo a ese hijo
(`src`) y nunca con el `in` completo (`a/x/src`). Razón: el grafo de un hijo indexa paths relativos al
hijo, y `assertPrefixIndexed` (`src/graph/scopes.ts:320`) lanza con un prefijo que no existe en él.

#### Scenario: trace_calls con in dentro de un hijo

GIVEN el workspace del escenario «el mismo in da los mismos resultados en las cuatro tools»
WHEN se llama `trail_trace_calls` con `symbol: "sharedFn"` e `in: "a/x/src"`
THEN la respuesta es `isError: false`, contiene el bloque `## a/x/` y no contiene `## a/y/` ni `## b/`

#### Scenario: trace_calls con in igual a un grupo

GIVEN el mismo workspace
WHEN se llama `trail_trace_calls` con `symbol: "sharedFn"` e `in: "a"`
THEN la respuesta es `isError: false` y contiene los bloques `## a/x/` y `## a/y/` y no contiene `## b/`

#### Scenario: símbolo ausente cuenta solo los hijos en alcance

GIVEN el mismo workspace
WHEN se llama `trail_trace_calls` con `symbol: "noExiste"` e `in: "a/x/src"`
THEN la respuesta es `isError: true` y su texto empieza con
`no symbol "noExiste" in any of the 1 workspace repo(s)`

### Requirement: find_all aplica in en un workspace

`trail_find_all` y `trail grep` en un workspace SHALL aceptar `in` y buscar solo en los hijos en alcance,
con el sub-prefijo relativo al hijo; los archivos de los demás hijos SHALL NOT leerse. Razón: sin esto el
parámetro se ignora, la respuesta mezcla repos ajenos y puede pesar más de 100 KB.

#### Scenario: find_all acotado a un sub-prefijo

GIVEN el workspace del escenario «el mismo in da los mismos resultados en las cuatro tools», donde `a/x` tiene 2 archivos indexados
(`src/x.ts`, `lib/l.ts`), `a/y` tiene 1 y `b` tiene 1
WHEN se llama `trail_find_all` con `pattern: "sharedFn"` e `in: "a/x/src"`
THEN el texto contiene `searched 1 indexed files` y todo path de hit empieza con `a/x/src/`

#### Scenario: find_all acotado a un grupo

GIVEN el mismo workspace
WHEN se llama `trail_find_all` con `pattern: "sharedFn"` e `in: "a"`
THEN el texto contiene `searched 3 indexed files` y ningún path de hit empieza con `b/`

#### Scenario: trail grep del CLI en un workspace

GIVEN el mismo workspace construido en disco
WHEN se ejecuta `trail grep sharedFn <raíz> --in a/x/src`
THEN la salida contiene `a/x/src/x.ts` y ningún path de hit empieza con `a/y/` ni con `b/`

### Requirement: Un sub-prefijo inexistente es un error

Cuando `in` resuelve a un hijo con sub-prefijo y ese hijo tiene grafo pero ningún nodo indexado bajo el
sub-prefijo, `trail_find_code`, `trail_trace_calls`, `trail_find_all` y `trail_search_semantic` SHALL
responder `isError: true` con un texto que contiene `nothing indexed under "<in>/"`, donde `<in>` es el
valor normalizado completo. Razón: un sub-prefijo mal escrito no debe leerse como «no hay resultados».

#### Scenario: sub-prefijo mal escrito

GIVEN el workspace del escenario «el mismo in da los mismos resultados en las cuatro tools»
WHEN se llama cada una de las cuatro tools con `in: "a/x/nada"`
THEN cada respuesta es `isError: true` y su texto contiene `nothing indexed under "a/x/nada/"`

#### Scenario: sub-prefijo existente sin resultados

GIVEN el mismo workspace
WHEN se llama `trail_find_all` con `pattern: "zzzNoExiste"` e `in: "a/x/src"`
THEN la respuesta es `isError: false` (hay archivos bajo `a/x/src/`, solo que sin coincidencias)

### Requirement: Con in a un solo hijo no hay compuerta entre hijos

`federateAsk` SHALL saltar la compuerta de fuerza de coincidencia entre hijos (`STRONG_FLOOR`/`HIGH_FLOOR`)
solo cuando `in` no vacío resuelve a exactamente un hijo. Con `in` ausente, o con un grupo de dos o más
hijos, la compuerta SHALL aplicarse. Razón: con un solo hijo elegido no hay competencia entre repos, y la
pista `also matched: <hijo> — narrow with --in <hijo>` debe llevar a un resultado no vacío.

#### Scenario: in a un hijo débil conserva el comportamiento actual

GIVEN el workspace del test `federated ask: explicit --in <weak child> bypasses the cross-child gate`
(`test/workspace.test.ts`)
WHEN se llama `federateAsk` con `in: "repoJunk"`
THEN el resultado es el mismo que antes del cambio: el test cuyo título empieza con
`federated ask: explicit --in <weak child> bypasses the cross-child gate` sigue verde sin editarlo

### Requirement: La descripción de in es la misma en las cuatro tools

Las propiedades `in` de `trail_find_code`, `trail_trace_calls`, `trail_find_all` y `trail_search_semantic`
en `TOOLS` (`src/mcp/tools.ts`) SHALL tener exactamente la misma `description`, definida en una constante,
que SHALL decir que en un workspace `in` es relativo a la raíz del workspace. Razón: hoy las cuatro dicen
cosas distintas y el agente aprende una regla por tool.

#### Scenario: descripciones iguales

GIVEN la lista `TOOLS` exportada por `src/mcp/tools.ts`
WHEN se lee `inputSchema.properties.in.description` de las cuatro tools
THEN las cuatro cadenas son iguales y contienen `workspace`
