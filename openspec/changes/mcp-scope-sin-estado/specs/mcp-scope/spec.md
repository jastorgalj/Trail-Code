## Purpose

Contrato de `trail_set_scope`: la tool resuelve un path a un valor `in` y lo devuelve; el servidor no guarda
alcance, ninguna tool lo hereda y dos clientes del mismo proceso nunca se pisan.

## ADDED Requirements

### Requirement: `trail_set_scope` no guarda estado

`trail_set_scope` SHALL NOT almacenar el scope en el proceso, en el módulo ni en el transporte. SHALL
resolver `path` contra la raíz del servidor y responder el valor `in` que el agente debe pasar en cada
llamada que quiera acotar. Las barras finales y los separadores `\` se normalizan a `/`.

#### Scenario: subpath bajo la raíz

GIVEN un servidor MCP arrancado sobre `/w` y un directorio `/w/src` existente
WHEN se llama `trail_set_scope` con `{ "path": "/w/src" }`
THEN la respuesta es `isError: false` y su texto contiene `pass in: "src"` y
`this server keeps no per-session scope`

#### Scenario: la raíz del workspace limpia el alcance

GIVEN un servidor MCP arrancado sobre `/w`
WHEN se llama `trail_set_scope` con `{ "path": "/w/" }`
THEN la respuesta es `isError: false` y su texto contiene `scope: whole workspace` y `omit "in"`, que es la
forma documentada de volver a consultar todo el workspace

#### Scenario: path fuera del workspace

GIVEN un servidor MCP arrancado sobre `/w`
WHEN se llama `trail_set_scope` con `{ "path": "/otro/repo" }`
THEN la respuesta es `isError: true` y su texto es `path "/otro/repo" is not under the server workspace "/w" —
no scope resolved`

### Requirement: Ninguna tool hereda el scope

El servidor SHALL NOT inyectar `in` en los argumentos de ninguna tool, ni derivar un scope del `roots` del
`initialize`. Los argumentos llegan a `callTool` tal como los envió el cliente.

#### Scenario: consulta posterior a set_scope no se acota

GIVEN un repo con `src/a.ts` (función `alpha`) y `lib/b.ts` (función `beta`), con grafo construido
WHEN se llama `trail_set_scope` con `{ "path": "<repo>/src" }` y después `trail_find_all` con
`{ "pattern": "beta" }` en la misma conexión
THEN la respuesta de `trail_find_all` contiene el hit `lib/b.ts` — no se aplicó ningún `in`

#### Scenario: dos clientes sobre el mismo servidor

GIVEN un proceso `trail mcp <workspace>` detrás de un proxy stateless, con dos agentes A y B
WHEN A llama `trail_set_scope` y B llama `trail_find_code` sin `in`
THEN el resultado de B es el del workspace completo, no el subtree que eligió A — el estado no existe

### Requirement: La descripción coincide con el comportamiento

La descripción anunciada de `trail_set_scope` SHALL decir que el servidor no guarda scope de sesión y que
el valor devuelto debe pasarse en cada llamada. SHALL NOT prometer que las consultas posteriores se acotan
solas.

#### Scenario: la descripción no promete estado

GIVEN el arreglo `TOOLS` del servidor
WHEN se lee la descripción de `trail_set_scope`
THEN contiene `keeps no session scope` y no contiene `subsequent trail queries in this session`
