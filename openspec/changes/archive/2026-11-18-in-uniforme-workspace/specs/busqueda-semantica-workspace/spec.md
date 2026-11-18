## REMOVED Requirements

### Requirement: El parámetro in selecciona hijos

**Reason**: La regla de selección de hijos por `in` ya no es exclusiva de `trail_search_semantic`: la comparten
`trail_find_code`, `trail_trace_calls`, `trail_find_all` y `trail_search_semantic` y se enuncia una sola vez
en `alcance-in-workspace` (requirements «in dentro o igual a un hijo» e «in igual a un grupo de hijos»).
Mantener una segunda copia en esta capability reproduce el problema que este change corrige.

**Migration**: Los escenarios «in igual a un hijo» e «in igual a un grupo de hijos» siguen valiendo para la
semántica, ahora cubiertos por `alcance-in-workspace` (escenarios «in igual al hijo» e «in igual a un
grupo»). Sus tests en `test/workspace-semantic.test.ts` no cambian.

### Requirement: El parámetro in admite un subpath dentro de un hijo

**Reason**: Pasa a `alcance-in-workspace` («in dentro o igual a un hijo») y se extiende a las cuatro tools.
Además cambia un comportamiento: un sub-prefijo que no existe en el hijo deja de responder
`no semantic matches found` y pasa a ser el error `nothing indexed under "<in>/"` (requirement «Un
sub-prefijo inexistente es un error»), para que un typo no se lea como «no hay resultados».

**Migration**: El escenario «in con subpath dentro de un hijo» sigue valiendo y lo cubre el escenario «el
mismo in da los mismos resultados en las cuatro tools». El escenario «in con subpath sin hits» (que usaba
`repoA/nada`, un sub-prefijo inexistente) queda reemplazado por «sub-prefijo mal escrito»; el test
correspondiente de `test/workspace-semantic.test.ts` se reescribe para esperar `isError: true`.

### Requirement: Un in sin coincidencia es un error

**Reason**: El texto del error era distinto en `trail_find_code` (`no workspace repo matching "<in>" — repos:
<todos>`) y en `trail_search_semantic` (`no workspace repos match "in=<in>" — available: <hasta 5>`), y
`trail_trace_calls` y `trail_find_all` no tenían ninguno. Pasa a `alcance-in-workspace` («in sin
coincidencia») con un solo texto.

**Migration**: Los escenarios «in que no nombra ningún hijo» y «in coincide por segmento y no por prefijo de
texto» siguen valiendo con el texto nuevo `no workspace repo matching "<in>" — repos: <todos>`. Los dos
`assert` de `test/workspace-semantic.test.ts` que buscan `no workspace repos match "in=nosuch"` y
`"in=repo"` se actualizan a ese texto.
