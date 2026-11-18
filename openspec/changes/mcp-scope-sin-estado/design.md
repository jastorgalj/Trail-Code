# Design

## D1 — Por qué se elimina el estado y no se aísla por sesión

El aislamiento por sesión exige una identidad de cliente en el transporte. En stdio hay un único flujo
JSON-RPC, así que «una sesión» coincide con «un proceso» — y ahí el estado no molesta. El caso roto es el
proxy stateless: varios clientes multiplexados sobre un proceso, y el issue ya verificó que el `roots` del
`initialize` no llega al proceso (`src/mcp/server.ts:64-67`). Sin identidad no hay `Map<session, scope>` que
valga: cualquier estado guardado es, por definición, de todos. Se elige la opción «a» del issue (eliminar
el estado) porque es la única que arregla el bug sin depender del transporte; la opción «b» (HTTP con
`Mcp-Session-Id`) queda para #10.

## D2 — Qué devuelve `set_scope`

`resolveScope(serverRoot, path)` normaliza separadores y barras finales y devuelve:

- path bajo la raíz → `scope: <rel> — pass in: "<rel>" on each call you want narrowed to it (...)`.
- path igual a la raíz (o vacío) → `scope: whole workspace — omit "in" on every call (...)`, `isError: false`.
- path fuera de la raíz → `path "<p>" is not under the server workspace "<srv>" — no scope resolved`,
  `isError: true`.

El texto repite la regla («this server keeps no per-session scope, so the value must travel in each call»)
en las dos respuestas exitosas: es la única superficie que ve el agente en cada llamada, así que la
descripción de la tool y la respuesta tienen que decir lo mismo (criterio de aceptación del issue).

## D3 — Nada se inyecta

Se elimina `injectClientScope` y su llamada: `callTool` recibe el objeto `arguments` sin tocar. También se
elimina la captura de `roots` en `initialize`, que era el otro camino por el que un cliente fijaba el scope
de todos. Consecuencia directa: ninguna tool «hereda» alcance, y el test de #20 (dos clientes concurrentes)
pasa por construcción — no hay dónde compartir nada.

## D4 — Compatibilidad

Es un cambio de comportamiento deliberado: quien llamaba `set_scope` una vez y consultaba sin `in` ahora
consulta el workspace completo. No se rompe ninguna llamada (los esquemas no cambian: `path` sigue siendo
string requerido) y la respuesta de la tool entrega el valor exacto a repetir. Las plantillas de skill
instaladas por `trail init` se regeneran en la próxima corrida, ya con el texto nuevo.
