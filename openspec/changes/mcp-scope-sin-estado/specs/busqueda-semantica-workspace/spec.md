## MODIFIED Requirements

### Requirement: El parámetro in admite un subpath dentro de un hijo

Si ningún hijo cumple la regla de prefijo y `in` empieza con `<hijo>/`, `trail_search_semantic` SHALL buscar
solo en ese hijo (el de path más largo) y devolver solo los hits cuya `file_path` es igual al resto o
empieza con `<resto>/`. Razón: `trail_set_scope` devuelve un `in` que puede apuntar dentro de un hijo y el
agente lo repite en cada consulta (la tool ya no inyecta nada, ver capability `mcp-scope`).

#### Scenario: in con subpath dentro de un hijo

GIVEN `repoA` con archivos `src/a.ts` y `lib/l.ts` y `repoB` con `src/b.ts`, los tres indexados
WHEN se llama `trail_search_semantic` con `in: "repoA/src"`
THEN todo hit empieza con `[repoA/]src/`

#### Scenario: in con subpath sin hits

GIVEN el workspace del escenario anterior
WHEN se llama `trail_search_semantic` con `in: "repoA/nada"`
THEN la respuesta es `isError: false` y contiene `no semantic matches found across workspace children`
