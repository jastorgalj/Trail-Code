# Tasks

Gates del repo (CONTRIBUTING.md): `npx tsc -p tsconfig.json --noEmit` y `npm run test`.
Comando de pruebas por archivo: `GRAFT_NO_TRAIL_SWITCH=1 node --import tsx --test test/mcp-args.test.ts`.

Rama: `fix/issue-20-scope-stateless`, desde `origin/main` `eb2b832`. Los números de línea de la propuesta son
orientativos: busca por texto (`clientRoot`, `injectClientScope`, `roots`).

## 1. Servidor sin estado

- [x] 1.1 Borrar `let clientRoot` y el bloque de `roots` en `initialize` de `src/mcp/server.ts`; quitar el
      import de `node:url` si queda sin uso.
- [x] 1.2 Reemplazar `injectClientScope` por `resolveScope(serverRoot, path)` según `design.md` D2, y llamar
      `callTool(root, name, args, dirOverride)` sin inyectar nada.
- [x] 1.3 Reemplazar el handler de `trail_set_scope` por: validar argumentos (sin tocar estado) → responder
      el texto de `resolveScope`.

## 2. Textos

- [x] 2.1 `src/mcp/tools.ts`: descripción de `trail_set_scope` (resuelve `in`, no guarda scope) y de su
      `path` (subtree; la raíz = workspace completo).
- [x] 2.2 `src/mcp/instructions.ts`, `src/claude/skill-template.ts`, `src/claude/hermes-skill-template.ts`
      y la tabla del `README.md`: dejar de prometer «scope de sesión».
      Ojo: dentro de las plantillas el backtick va escapado (`\``), también en el texto nuevo.

## 3. Pruebas

- [x] 3.1 `test/mcp-args.test.ts`: `set_scope` válido responde `pass in: "src"`; raíz responde
      `scope: whole workspace`; path fuera de la raíz sigue siendo `isError: true`.
- [x] 3.2 Escenario nuevo: `set_scope` a `src` y después `trail_find_all` de un literal que vive en `lib/`
      devuelve el hit — ninguna tool hereda el scope.
- [x] 3.3 Ajustar los escenarios que asumían inyección (descripción, «no deja rastro», etc.).

## 4. Gates

- [x] 4.1 `npx tsc -p tsconfig.json --noEmit`.
- [x] 4.2 `GRAFT_NO_TRAIL_SWITCH=1 node --import tsx --test test/mcp-args.test.ts` (46/46).
- [x] 4.3 `npm run test` (suite completa; ver resultado en el PR).
