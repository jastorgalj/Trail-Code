# Proposal

## Why

`trail_set_scope` guarda el scope en una variable del proceso (`src/mcp/server.ts:55`, `clientRoot`), pero
la tool promete alcance de sesión. Desplegado como servidor compartido —un único `trail mcp <workspace>`
detrás de un proxy stdio→HTTP en modo stateless, usado por varios perfiles de agentes— el `set_scope` de
un agente acota las consultas de todos los demás, que reciben resultados de otro repo o errores de `in`
sin haberlo pedido. Además el scope no se puede limpiar (pasar la raíz se rechaza) y el transporte no
ofrece ninguna señal para separar clientes: en stdio hay un solo flujo JSON-RPC y, con proxy delante, ni
siquiera llega el `roots` del `initialize` (`src/mcp/server.ts:64-67`). Issue jastorgalj/Trail-Code#20.

## What Changes

- **Eliminar el estado**: `trail_set_scope` deja de guardar nada. Resuelve `path` a un path relativo y
  responde el `in` exacto que el agente debe pasar en cada consulta que quiera acotar (opción «a» del
  issue). Sin estado no hay alcance cruzado entre clientes.
- **Ninguna tool hereda scope**: se borra `injectClientScope` y el uso de `roots` como scope; `callTool`
  recibe los argumentos tal como llegaron.
- **Limpiar el scope deja de ser un problema**: con la raíz del workspace `set_scope` responde «whole
  workspace — omit `in`», que es la forma documentada de volver a consultar todo.
- **Descripción y textos alineados**: descripción de la tool, instrucciones del servidor, plantillas de
  skill (Claude y Hermes) y README dejan de hablar de «scope de sesión» y dicen que el `in` viaja en cada
  llamada.

Fuera de alcance: transporte HTTP nativo con `Mcp-Session-Id` (opción «b» del issue, depende de #10) y
cualquier cambio en la resolución de `in=` dentro de workspace (#14/#15), que no se toca.

## Capabilities

### New Capabilities

- `mcp-scope`: contrato de `trail_set_scope` — resuelve un path a `in`, no guarda estado y ninguna tool
  hereda alcance.

### Modified Capabilities

- `busqueda-semantica-workspace`: la razón del requirement «El parámetro in admite un subpath dentro de un
  hijo» cita la inyección automática de `trail_set_scope`, que ya no existe (el requirement en sí no cambia).

## Impact

- Código: `src/mcp/server.ts` (`resolveScope` reemplaza `clientRoot` + `injectClientScope`),
  `src/mcp/tools.ts`, `src/mcp/instructions.ts`, `src/claude/skill-template.ts`,
  `src/claude/hermes-skill-template.ts`, `README.md`.
- Pruebas: `test/mcp-args.test.ts` (3 escenarios nuevos, 4 reescritos).
- Contrato: tras `set_scope`, las consultas ya **no** se acotan solas; el agente debe repetir el `in`. Es
  el precio de ser seguro en un servidor compartido y queda escrito en la respuesta de la tool.
