## ADDED Requirements

### Requirement: La CLI comparte la federación semántica del MCP

`trail ask --semantic` en un workspace SHALL producir los mismos hits, el mismo filtro por `--in` y los mismos diagnósticos de cobertura que la tool `trail_search_semantic`, porque ambos consumen una sola implementación federada. Los hits SHALL ir a stdout; la cobertura y los fallos por hijo, a stderr.

#### Scenario: --in acota la búsqueda en la CLI

GIVEN un workspace con índice semántico en `repoA` y `repoB`
WHEN se ejecuta `trail ask "<query>" --semantic --in repoB`
THEN el resultado contiene sólo hits de `repoB`

#### Scenario: --in con subpath filtra por segmento

GIVEN un workspace con índice en `repoA`
WHEN se ejecuta `trail ask "<query>" --semantic --in repoA/src`
THEN sólo se devuelven hits cuyo `file_path` cae bajo `src/` del hijo

#### Scenario: Un --in que no nombra ningún hijo es un error

GIVEN un workspace con hijos `repoA` y `repoB`
WHEN se ejecuta `trail ask "<query>" --semantic --in nope`
THEN stderr dice que ningún repo del workspace coincide con `nope` y lista los disponibles
AND el proceso termina con código distinto de cero
AND no se busca en ningún hijo

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
