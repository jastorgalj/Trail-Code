# Proposal

## Why

Los agentes alternan entre servidores MCP con convenciones distintas y se equivocan de nombre o de tipo
de argumento. Hoy el servidor de trail lo esconde: `trail_find_all` con `query` responde
`graft_find_all requires a pattern` (nombre viejo, sin decir qué se recibió); con `paths` extra busca
sin filtrar; `limit: "3"` o `query: 123` se aceptan y caen al default o se convierten en texto;
`trail_set_scope` y `trail_build` ni siquiera se despachan (`unknown tool: graft_set_scope` /
`graft_build`). Issue jastorgalj/Trail-Code#16.

## What Changes

- Validar los argumentos de cada llamada contra el `inputSchema` anunciado: clave desconocida, requerido
  ausente o valor de tipo/enum equivocado → `isError` con mensaje que nombra lo esperado y, si hay
  candidato, `(did you mean "pattern"?)`. Sin alias: lo desconocido se rechaza. Sin coerción: `"3"` no
  es un número.
- `additionalProperties: false` en los nueve schemas.
- Validación como primer paso de `callTool` y del manejo de `trail_set_scope` en `server.ts`.
- `injectClientScope` deja de inyectar `in` en tools que no lo declaran.
- Arreglar el despacho de `trail_set_scope` (`server.ts:98`) y `trail_build` (`tools.ts:329`).
- Mensajes `graft_* requires ...` → nombre anunciado `trail_*`; descripciones sin rutas de un workspace
  concreto; la descripción de `trail_set_scope` avisa que el scope es compartido por todos los clientes
  del servidor.

## Capabilities

### New Capabilities

- `mcp-argumentos`: contrato de validación de argumentos de las tools MCP.

### Modified Capabilities

Ninguna (no existe spec previo de las tools MCP).

## Impact

- Código: `src/mcp/validate-args.ts` (nuevo), `src/mcp/tools.ts`, `src/mcp/server.ts`.
- Pruebas: `test/mcp-args.test.ts` (nuevo), `test/mcp-tools.test.ts` (2 aserciones de mensaje).
- Contrato: llamadas que antes «funcionaban» con argumentos de más o de tipo equivocado ahora fallan.
  Trail corre como un solo servidor compartido por todos los agentes: el cambio llega a todos a la vez
  al reinstalar (nota de despliegue en `design.md`). La descripción del PR lo registra (el `CHANGELOG.md` se escribe en el commit de release).
- Publicar en npm y reinstalar el servicio quedan fuera de alcance.

## Fuera de alcance

- Rangos de valores (`limit: 0`/negativo).
- `in`/`depth` ignorados en modo workspace por `find_all` y `trace_calls` (#14/#18/#15).
- Scope global por proceso (#20): este change hace alcanzable su escritura pero no agrega estado.
- Mensajes `graft` fuera de `src/mcp/tools.ts`.
