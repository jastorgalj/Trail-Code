## Purpose

Define qué puede contener la salida de texto que el CLI y el servidor MCP de trail devuelven por sus
tools de consulta: solo información (hits, líneas de ahorro, notas de estado), nunca instrucciones
dirigidas al modelo sobre qué decirle al usuario.

## ADDED Requirements

### Requirement: La salida de las tools no da órdenes al modelo

La salida de texto de `trail_find_code`, `trail_find_all`, `trail_trace_calls`, `trail_file_api`,
`trail_repo_map`, `trail_check_freshness` y `trail_search_semantic`, y la de sus equivalentes de CLI,
SHALL NOT contener ninguna de estas frases, sin distinguir mayúsculas: `tell the user`,
`At the end of your reply`, `sum each such line`. Razón: una orden dentro del resultado de una tool es el
patrón de un prompt-injection y enseña al agente a obedecer texto que no viene de su usuario.

#### Scenario: find_code con ahorro no trae la orden

GIVEN un repo construido cuyo archivo `big.ts` pesa más de 40 000 caracteres y define `needleFn`
WHEN se llama `trail_find_code` con `query: "needleFn"`
THEN la salida contiene una línea que empieza con `[graft] tokens saved ≈` o `[trail] tokens saved ≈`
AND la salida no contiene `tell the user`, `At the end of your reply` ni `sum each such line`

#### Scenario: las demás tools de consulta tampoco

GIVEN el mismo repo construido
WHEN se llama `trail_find_all` con `pattern: "needleFn"`, `trail_trace_calls` con `symbol: "needleFn"`,
`trail_file_api` con `file: "big.ts"`, `trail_repo_map` y `trail_check_freshness`
THEN ninguna salida contiene las tres frases prohibidas

### Requirement: La línea de ahorro es un dato sumable

Cuando una consulta ahorra tokens, la línea de ahorro SHALL empezar con `[trail] tokens saved ≈ <N>
(<P>%)` (con `[graft]` en lugar de `[trail]` bajo el nombre graft) y SHALL terminar con el texto
informativo del estimado, sin ninguna orden. `<N>` SHALL escribirse con dígitos y `,` como separador de
miles, sea cual sea el locale del sistema, y `sumSavingsFooters` aplicada a la línea SHALL devolver
exactamente `<N>`.

#### Scenario: miles con coma aunque el locale sea es-CL

GIVEN un sistema con locale `es-CL`, un cuerpo de 1 000 caracteres y un baseline de 4 000 000
caracteres (ahorro de 999 750 tokens)
WHEN se genera la línea de ahorro con `savingsLine`
THEN la línea empieza con `[graft] tokens saved ≈ 999,750 (` o `[trail] tokens saved ≈ 999,750 (`
AND `sumSavingsFooters(línea)` devuelve `999750`

#### Scenario: la línea no se emite cuando no hay ahorro

GIVEN una salida cuyo tamaño estimado es mayor o igual al de leer los archivos completos
WHEN se genera la línea de ahorro
THEN la salida no contiene la cadena `tokens saved`

### Requirement: El resumen de sesión usa el mismo separador

La línea `tokens saved:` de `formatSessionStats` SHALL escribir la cifra con `,` como separador de miles,
sea cual sea el locale del sistema, para que el resumen de `trail stats` sea comparable con la línea de
ahorro de cada consulta.

#### Scenario: el resumen de sesión usa la coma

GIVEN un sistema con locale `es-CL` y una sesión con `savedTokens: 12345`
WHEN se genera el texto con `formatSessionStats`
THEN la línea `tokens saved:` contiene `~12,345` y no contiene `12.345`

### Requirement: El valor en dólares viaja en la línea de datos

Cuando el proceso conoce la tarifa de entrada medida de la sesión, la línea de ahorro SHALL incluir el
valor del ahorro en dólares como dato, con el formato de `formatDollars` (`$1.23`, o `<$0.01`), y SHALL NOT
formularlo como pedido. Sin tarifa conocida, la línea SHALL NOT contener `$`.

#### Scenario: con tarifa conocida

GIVEN `setInputRate(3)`, un cuerpo vacío y un baseline de 4 000 000 caracteres (ahorro de 1 000 000
tokens)
WHEN se genera la línea de ahorro con `savingsLine`
THEN la línea contiene `$3.00`
AND `sumSavingsFooters(línea)` devuelve `1000000`

#### Scenario: sin tarifa

GIVEN `setInputRate(null)`, un cuerpo vacío y un baseline de 4 000 000 caracteres
WHEN se genera la línea de ahorro con `savingsLine`
THEN la línea no contiene `$`

### Requirement: La nota de cobertura del workspace no acompaña a resultados

En un workspace con algún repo hijo sin grafo, `trail_find_code`, `trail_find_all` y `trail_trace_calls`
SHALL NOT incluir la nota `workspace repos have graphs` cuando devuelven al menos un resultado, y SHALL
incluirla cuando no devuelven ninguno (porque el repo sin grafo podría tener la respuesta).
`trail_repo_map` y `trail_check_freshness` SHALL incluirla siempre que falte algún grafo.

#### Scenario: con resultados, sin nota

GIVEN un workspace con `repoA` y `repoB` construidos y `repoC` sin grafo, y `repoA` define `alphaHandler`
WHEN se llama `trail_find_code` con `query: "alphaHandler"`
THEN la salida contiene `repoA/`
AND la salida no contiene `workspace repos have graphs`

#### Scenario: sin resultados, con nota

GIVEN el mismo workspace
WHEN se llama `trail_find_all` con `pattern: "zzzNoExisteZzz"`
THEN la salida contiene `2 of 3 workspace repos have graphs`

#### Scenario: map y freshness siempre la llevan

GIVEN el mismo workspace
WHEN se llama `trail_repo_map` y `trail_check_freshness`
THEN ambas salidas contienen `2 of 3 workspace repos have graphs`
