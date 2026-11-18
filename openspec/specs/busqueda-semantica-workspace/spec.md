# busqueda-semantica-workspace Specification

## Purpose
Comportamiento de `trail_search_semantic` cuando el servidor MCP está enraizado en un workspace (carpeta
con varios repos hijos): de dónde lee el índice semántico de cada hijo, cómo `in` acota la búsqueda, qué
dice la tool cuando falta o falla un índice, y cómo las descripciones de las tools distinguen la búsqueda
léxica (`trail_find_code`) de la semántica.

## Requirements

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

### Requirement: La CLI comparte la federación semántica del MCP

`trail ask --semantic` en un workspace SHALL producir los mismos hits, el mismo filtro por `--in` y los mismos diagnósticos de cobertura que la tool `trail_search_semantic`, porque ambos consumen una sola implementación federada. Los hits SHALL ir a stdout; la cobertura y los fallos por hijo, a stderr.

#### Scenario: Hits a stdout, cobertura y fallos a stderr

GIVEN un workspace con `repoA` indexado y `repoB` sin índice semántico
WHEN se ejecuta `trail ask "<query>" --semantic` y hay hits en `repoA`
THEN los hits de `repoA` van a stdout y la línea de cobertura (`1 of 2 workspace repos have a semantic index`) va a stderr

### Requirement: La CLI distingue «sin índice» de «sin coincidencias»

Cuando ningún hijo en alcance tiene `embeddings.db`, `trail ask --semantic` SHALL responder `<k> of <N> workspace repos have a semantic index; run trail build to cover <hijos>` y SHALL NOT responder «no semantic matches». En un repo único sin índice SHALL decirlo con su propia ruta. El código de salida SHALL ser distinto de cero en ambos casos.

#### Scenario: Workspace sin ningún índice

GIVEN un workspace cuyos hijos no tienen índice semántico
WHEN se ejecuta `trail ask "<query>" --semantic`
THEN stderr contiene `0 of 2 workspace repos have a semantic index`
AND el proceso termina con código distinto de cero

#### Scenario: Repo único sin índice

GIVEN un repo indexado pero sin índice semántico
WHEN se ejecuta `trail ask "<query>" --semantic` sobre él
THEN stderr dice que ese repo no tiene índice semántico
AND SHALL NOT decir «no semantic matches found»

### Requirement: Un índice ilegible no se traga en la CLI

Si la búsqueda semántica falla en un hijo, `trail ask --semantic` SHALL reportar `semantic search failed in <hijo>: <primera línea del mensaje>` en stderr y SHALL NOT responder «no semantic matches». Con un índice ilegible en un repo único SHALL reportar `semantic search failed: <mensaje>`. El código de salida SHALL ser distinto de cero cuando no se obtuvo ningún hit.

#### Scenario: Índice ilegible en un hijo del workspace

GIVEN un workspace con un `embeddings.db` ilegible en `repoA` y sin índice en `repoB`
WHEN se ejecuta `trail ask "<query>" --semantic`
THEN stderr contiene `semantic search failed in repoA:`
AND stderr informa la cobertura parcial
AND el proceso termina con código distinto de cero

#### Scenario: Índice ilegible en un repo único

GIVEN un repo cuyo `embeddings.db` no es una base SQLite válida
WHEN se ejecuta `trail ask "<query>" --semantic` sobre él
THEN stderr contiene `semantic search failed:` con el mensaje original
AND el proceso termina con código distinto de cero
