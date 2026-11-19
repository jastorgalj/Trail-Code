# Tasks

Gates: `npx tsc -p tsconfig.json --noEmit` y por archivo `GRAFT_NO_TRAIL_SWITCH=1 node --import tsx --test <archivo>`.

## 1. Implementación

- [x] 1.1 Crear `src/mcp/scope.ts` con `resolveScope` puro (inyectable `isDir` y `caseInsensitive`).
- [x] 1.2 Actualizar `src/mcp/server.ts` para importar de `scope.ts` y eliminar la función inline.

## 2. Tests

- [x] 2.1 `test/scope.test.ts` (nuevo): 17 tests unitarios cubriendo todas las reglas (a–d).
- [x] 2.2 `test/mcp-args.test.ts`: añadir 1 test stdio al final — `set_scope` con ruta inexistente → `isError`.
- [x] 2.3 `test/mcp-args.test.ts`: añadir 1 test stdio al final — `set_scope` con archivo real → `isError 'is not an existing directory'` (cubre isDir por defecto sin inyección).
- [x] 2.4 `test/workspace-in.test.ts`: borrar SOLO el test `set_scope dentro de un hijo y trace_calls sin in` y su helper `rpcIn` (rojo en main desde PR #30).

## 3. Verificación

- [x] 3.1 `npx tsc -p tsconfig.json --noEmit` exit 0.
- [x] 3.2 `scope.test.ts` 17/17; `mcp-args.test.ts` 47/47.
- [x] 3.3 Sabotajes a–d verificados: cada regla produce exactamente el rojo esperado.
- [x] 3.4 `openspec validate set-scope-validar-ruta --strict` limpio.
