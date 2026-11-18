# Proposal: set_scope valida la ruta (trail#20, P2)

## Why

`trail_set_scope` en `origin/main` (PR #30) resuelve path → `in` y lo devuelve sin guardar estado, pero
no valida la ruta recibida: acepta segmentos `..`, rutas inexistentes, archivos y distingue mayúsculas de
unidad en Windows aunque el sistema de archivos no lo haga. Un path malformado llega al llamador como
un `in=` inútil o engañoso.

## What Changes

- Extraer `resolveScope` a `src/mcp/scope.ts` como función pura con `isDir` y `caseInsensitive`
  inyectables.
- Rechazar con `isError: true`:
  (a) paths con segmento `..` (tras normalizar `\`→`/`);
  (b) paths que no existen o no son directorio;
  (c) en Windows, comparar la raíz sin distinguir mayúsculas (`c:/…` vs `C:/…` aceptado).

## Capabilities

### Modified Capabilities

- `mcp-scope`: agregar los requisitos de validación de ruta (a–c) al contrato de `trail_set_scope`.
  La capability fue creada en el change `mcp-scope-sin-estado` (PR #30); aún no está en
  `openspec/specs/` (pendiente de archivar), por lo que este delta la trata como ADDED en una nueva
  spec de la misma capability.

## Impact

- Código: `src/mcp/scope.ts` (nuevo), `src/mcp/server.ts` (import).
- Pruebas: `test/scope.test.ts` (nuevo, 17 unitarios), `test/mcp-args.test.ts` (+2 stdio al final: inexistente + archivo real), `test/workspace-in.test.ts` (borrado test `set_scope dentro de un hijo` rojo en main).
- Contrato: `trail_set_scope` ahora rechaza rutas inválidas con `isError: true`; el comportamiento
  hacia rutas correctas no cambia.
- Spec: REMOVED requirement «El in inyectado por set_scope funciona en las cuatro tools» de `alcance-in-workspace` (ya no aplica tras PR #30 sin estado).
