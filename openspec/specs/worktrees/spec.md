# worktrees Specification

## Purpose
Soporte de primera clase para git worktrees: el índice de cada path consultado describe el
working tree de ese path, se siembra desde el checkout principal y se refresca solo, sin
`trail build` manual y sin exigir que el checkout principal permanezca en una rama concreta.

Origen: el seed desde el checkout principal y el lock de concurrencia son de upstream (PR
#704, ya presentes en la base v0.28.0). El delta de este fork es que `embeddings.db` viaja
en el seed, que un worktree enlazado no cuenta como child del workspace, y que el refresco
inline está acotado y no carga el modelo ONNX.

## Requirements

### Requirement: Seed del índice al consultar desde un worktree

Cuando una consulta llega a un worktree enlazado (`.git` es archivo, no directorio) sin índice
propio, el sistema SHALL copiar desde el checkout principal el grafo léxico, los archivos de
cache sembrables y `embeddings.db`, y a continuación parchear los archivos que difieren entre
la rama del principal y la rama del worktree. La consulta SHALL responder sobre el working
tree del worktree, no sobre la rama del principal.

#### Scenario: Primera consulta en un worktree recién creado

GIVEN un repositorio indexado y un worktree nuevo creado con `git worktree add` sobre otra rama
WHEN se ejecuta la primera consulta (`trail ask` o tool MCP) desde el worktree
THEN el worktree queda con índice propio sembrado y parcheado, y la respuesta refleja el
código de la rama del worktree

#### Scenario: Búsqueda semántica disponible desde el primer uso en el worktree

GIVEN un checkout principal con `embeddings.db` construido
WHEN se consulta `trail_search_semantic` desde un worktree recién sembrado
THEN la búsqueda responde con resultados, sin error `Embeddings DB not found`

### Requirement: Refresco automático del índice al detectar drift

Toda consulta (tools MCP y comandos CLI de búsqueda) SHALL detectar el drift entre el índice y
el working tree del path consultado: hasta 50 archivos se re-extraen inline antes de responder;
más de 50 disparan rebuild en background con la advertencia
`[stale: N files changed, rebuilding in background]` antepuesta al resultado. Razón: el
`trail build` manual post-merge era el paso más olvidado del flujo.

#### Scenario: Drift acotado se parchea inline

GIVEN un repositorio indexado donde se modificó 1 archivo después del último build
WHEN se ejecuta una consulta léxica
THEN la respuesta refleja el contenido actual del archivo modificado y no incluye advertencia
de stale

#### Scenario: Drift grande responde con advertencia y repara en background

GIVEN un repositorio indexado donde difieren 51 o más archivos respecto del índice
WHEN se ejecuta una consulta léxica
THEN la respuesta llega sin bloquear por el rebuild completo, incluye la advertencia
`[stale: ...]`, y una consulta posterior al término del rebuild responde fresca sin advertencia

### Requirement: El refresco inline no carga el modelo de embeddings

El parche inline por drift SHALL actualizar solo el grafo léxico. La actualización del índice
semántico SHALL ejecutarse en background. Razón: cargar el modelo ONNX cuesta segundos y
bloquearía consultas léxicas que no lo necesitan.

#### Scenario: Consulta léxica con drift no paga el costo del modelo

GIVEN un repositorio con drift de 1 archivo
WHEN se ejecuta `trail_find_code`
THEN la consulta no inicializa el pipeline de embeddings en el proceso que responde

### Requirement: Un worktree enlazado no es un repositorio del workspace

El descubrimiento de children de un workspace SHALL excluir los directorios cuyo `.git` es un
archivo (worktree enlazado). El conteo de repos de `trail status` y la federación de búsquedas
SHALL contar cada repositorio una sola vez aunque tenga worktrees vivos.

#### Scenario: Workspace con un worktree activo

GIVEN un workspace con el repo `backend` y un worktree `backend/.worktrees/tarea-x`
WHEN se reconstruye el workspace y se consulta `trail status`
THEN `backend` aparece una vez y el worktree no aparece como repo independiente

### Requirement: Consultar un worktree enlazado desde el workspace padre

Con el servidor MCP o el CLI enraizados en un workspace, `in` SHALL aceptar la ruta de un worktree
enlazado de un hijo conocido — `<hijo>/.worktrees/<rama>`, relativa al workspace o absoluta, y
cualquier path debajo de ella — y resolverla a ese worktree con el resto como sub-prefijo. La
consulta SHALL responder sobre el árbol del worktree y cada path de resultado SHALL quedar prefijado
`<hijo>/.worktrees/<rama>/`, para que el `file:line` abra el archivo correcto desde el padre. El
worktree SHALL seguir sin contar como repo del workspace (requisito anterior): el hijo y su worktree
nunca se consultan como dos repos a la vez.

La primera consulta sobre un worktree SHALL sembrarlo desde el checkout principal y parchear la
diferencia entre las ramas, igual que una consulta ejecutada dentro del worktree — nunca un rebuild
en frío. Un `in` que no es un worktree enlazado SHALL conservar la resolución normal del workspace, y
un sub-prefijo que no existe en el grafo del worktree SHALL seguir fallando con
`nothing indexed under`.

#### Scenario: Un símbolo que solo existe en la rama del worktree

GIVEN un workspace con el hijo `backend` construido y un worktree `backend/.worktrees/feature-x` que
introduce `branchOnlyHelper`
WHEN se consulta `trail_find_all` con `in: "backend/.worktrees/feature-x"`
THEN el símbolo aparece con paths `backend/.worktrees/feature-x/src/…`, y sin `in` no aparece

#### Scenario: Ruta absoluta al worktree

GIVEN el mismo workspace y el path absoluto de `backend/.worktrees/feature-x/src`
WHEN se consulta `trail_find_code`, `trail_trace_calls` o `trail_find_all` con ese `in`
THEN la resolución es idéntica a la del path relativo al workspace
