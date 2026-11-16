## Purpose

Comportamiento de `trail_search_semantic` cuando el servidor MCP está enraizado en un workspace (carpeta
con varios repos hijos): de dónde lee el índice semántico de cada hijo, cómo `in` acota la búsqueda, qué
dice la tool cuando falta o falla un índice, y cómo las descripciones de las tools distinguen la búsqueda
léxica (`trail_find_code`) de la semántica.

## ADDED Requirements

### Requirement: Ubicación del índice semántico de cada hijo

La búsqueda semántica sobre un workspace SHALL leer el índice de cada hijo en
`embeddingsDbPath(contextDirFor(<raíz>/<hijo>))`, el mismo lugar donde `trail build` y el refresco por
drift lo escriben. La ruta SHALL NOT quedar fija en `graft/.cache/embeddings.db`. Razón: los repos
inicializados con trail guardan su mapa en `.trail/cache/`, y una ruta fija a `graft/` no los encuentra.

#### Scenario: Hijo con layout .trail/cache

GIVEN un workspace con los hijos `repoA` y `repoB`, ambos con `.trail/learnings/` y con su
`embeddings.db` en `.trail/cache/.cache/`, y ningún `graft/`
WHEN se llama `trail_search_semantic` con `query` sobre un símbolo de `repoA`
THEN la respuesta tiene `isError: false` y contiene un hit cuya ruta empieza con `[repoA/]`

#### Scenario: Hijo con layout graft heredado

GIVEN un workspace con el hijo `repoA` sin `.trail/` y con su `embeddings.db` en `graft/.cache/`
WHEN se llama `trail_search_semantic` con `query` sobre un símbolo de `repoA`
THEN la respuesta contiene un hit cuya ruta empieza con `[repoA/]`

#### Scenario: El formato de cada hit no cambia

GIVEN un workspace con un hijo indexado
WHEN se llama `trail_search_semantic` y hay un hit
THEN cada hit se imprime como `N. [<hijo>/]<ruta> · <símbolo>  (score: <número>)` seguido de una línea
con el snippet, y los hits van separados por una línea en blanco

### Requirement: El parámetro in selecciona hijos

`trail_search_semantic` SHALL tratar `in` (sin `/` finales) como prefijo por segmento de path: busca solo en
los hijos cuyo path es igual a `in` o empieza con `in/` (un hijo o un grupo). Razón: la documentación
usa `in="default-core"` para un grupo (`README.md:507`).

#### Scenario: in igual a un hijo

GIVEN un workspace con `repoA` y `repoB` indexados
WHEN se llama `trail_search_semantic` con `in: "repoB"`
THEN ningún hit de la respuesta empieza con `[repoA/]`

#### Scenario: in igual a un grupo de hijos

GIVEN un workspace con los hijos `grp/one`, `grp/two` y `other`, los tres indexados
WHEN se llama `trail_search_semantic` con `in: "grp"`
THEN los hits provienen solo de `[grp/one/]` y `[grp/two/]`

### Requirement: El parámetro in admite un subpath dentro de un hijo

Si ningún hijo cumple la regla de prefijo y `in` empieza con `<hijo>/`, `trail_search_semantic` SHALL buscar
solo en ese hijo (el de path más largo) y devolver solo los hits cuya `file_path` es igual al resto o
empieza con `<resto>/`. Razón: `trail_set_scope` inyecta `in` automáticamente (`src/mcp/server.ts:128-133`)
y puede apuntar dentro de un hijo.

#### Scenario: in con subpath dentro de un hijo

GIVEN `repoA` con archivos `src/a.ts` y `lib/l.ts` y `repoB` con `src/b.ts`, los tres indexados
WHEN se llama `trail_search_semantic` con `in: "repoA/src"`
THEN todo hit empieza con `[repoA/]src/`

#### Scenario: in con subpath sin hits

GIVEN el workspace del escenario anterior
WHEN se llama `trail_search_semantic` con `in: "repoA/nada"`
THEN la respuesta es `isError: false` y contiene `no semantic matches found across workspace children`

### Requirement: Un in sin coincidencia es un error

Cuando `in` no iguala ni es ancestro de ningún hijo (por segmento), `trail_search_semantic` SHALL responder
`isError: true` con `no workspace repos match "in=<in>" — available: <hasta 5 hijos separados por coma>`.
La coincidencia SHALL ser por segmento de path y no por prefijo de texto.

#### Scenario: in que no nombra ningún hijo

GIVEN un workspace con `repoA` y `repoB`
WHEN se llama `trail_search_semantic` con `in: "nosuch"`
THEN la respuesta es `isError: true` y contiene `no workspace repos match "in=nosuch"`

#### Scenario: in coincide por segmento y no por prefijo de texto

GIVEN un workspace con el hijo `repoA`
WHEN se llama `trail_search_semantic` con `in: "repo"`
THEN la respuesta es `isError: true` y contiene `no workspace repos match "in=repo"`

### Requirement: Sin índice en ningún hijo es un error accionable

Cuando ningún hijo en alcance tiene `embeddings.db`, `trail_search_semantic` SHALL responder
`isError: true` con el texto
`0 of <N> workspace repos have a semantic index; run trail build to cover <hijos sin índice separados por coma>`,
donde `<N>` cuenta los hijos en alcance. SHALL NOT responder `no semantic matches found`. Razón: ese
mensaje hace creer al agente que la búsqueda corrió y no halló nada, cuando no pudo correr.

#### Scenario: Workspace sin ningún índice

GIVEN un workspace con `repoA` y `repoB` construidos (grafo) y sin ningún `embeddings.db`
WHEN se llama `trail_search_semantic` con cualquier `query`
THEN la respuesta es `isError: true` y contiene exactamente
`0 of 2 workspace repos have a semantic index; run trail build to cover repoA, repoB`

#### Scenario: in acota el conteo

GIVEN el workspace del escenario anterior
WHEN se llama `trail_search_semantic` con `in: "repoA"`
THEN el texto contiene `0 of 1 workspace repos have a semantic index; run trail build to cover repoA`

### Requirement: Cobertura parcial se informa

Cuando algunos hijos en alcance tienen `embeddings.db` y otros no, la respuesta SHALL incluir, tras los
hits (o tras `no semantic matches found across workspace children` si no hubo hits), una línea en blanco y
`<k> of <N> workspace repos have a semantic index; run trail build to cover <hijos sin índice>`.

#### Scenario: Un hijo sin índice

GIVEN un workspace con `repoA` indexado y `repoB` sin `embeddings.db`
WHEN se llama `trail_search_semantic` con un `query` que produce un hit en `repoA`
THEN la respuesta es `isError: false`, contiene el hit `[repoA/]` y termina con la línea
`1 of 2 workspace repos have a semantic index; run trail build to cover repoB`

### Requirement: Un índice que falla se informa con su hijo

Cuando la búsqueda en un hijo con `embeddings.db` lanza un error, la respuesta SHALL incluir una línea
`semantic search failed in <hijo>: <primera línea del mensaje>` por cada hijo fallido, y SHALL NOT omitirlo
en silencio. `isError` SHALL ser `true` solo si ningún hijo completó su búsqueda.

#### Scenario: Un índice ilegible se informa

GIVEN un workspace con `repoA` indexado y `repoB` con un `embeddings.db` que no es una base SQLite
válida (archivo de texto plano)
WHEN se llama `trail_search_semantic`
THEN la respuesta contiene los hits de `repoA`, es `isError: false` y contiene una línea que empieza con
`semantic search failed in repoB:`

#### Scenario: Todos los índices fallan

GIVEN un workspace cuyo único hijo `repoA` tiene un `embeddings.db` que no es una base SQLite válida
WHEN se llama `trail_search_semantic`
THEN la respuesta es `isError: true` y contiene una línea que empieza con
`semantic search failed in repoA:`

### Requirement: trail_find_code declara que no usa embeddings

La descripción de la tool `trail_find_code` en `TOOLS` (`src/mcp/tools.ts`) SHALL contener las palabras
`lexical`, `structural` y `embeddings`, y SHALL nombrar `trail_search_semantic` como la tool para búsqueda
por significado. La descripción de `trail_search_semantic` SHALL indicar que en un workspace busca en el
índice de cada repo hijo. Razón: `trail_find_code` responde siempre `(lexical)` y los agentes concluyen
que la semántica está desactivada.

#### Scenario: Descripción de trail_find_code

GIVEN la lista `TOOLS` exportada por `src/mcp/tools.ts`
WHEN se lee la `description` de `trail_find_code`
THEN contiene `lexical`, `structural`, `embeddings` y `trail_search_semantic`

### Requirement: Las instrucciones MCP distinguen léxico de semántico

El texto de `mcpInstructions()` (`src/mcp/instructions.ts`) SHALL describir `trail_find_code` como búsqueda
léxica y estructural sin embeddings, y `trail_search_semantic` como búsqueda por significado sobre el
índice de embeddings.

#### Scenario: Instrucciones MCP

GIVEN el texto devuelto por `mcpInstructions()`
WHEN se busca la línea de `trail_find_code` y la de `trail_search_semantic`
THEN la primera contiene `lexical` y `no embeddings`, y la segunda contiene `embeddings`
