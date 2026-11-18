## 1. Código

- [x] 1.1 `federateSemantic` devuelve además `answer`, `notes`, `errors` y `found`, sin cambiar `text` ni `isError` (el MCP sigue recibiendo un único texto).
- [x] 1.2 `runWorkspaceSemantic` en `src/graph/workspace-cli.ts`: hits a stdout, cobertura y fallos a stderr, exit 1 cuando no hay hit o hay diagnóstico.
- [x] 1.3 La rama `--semantic` de `src/cli.ts` usa `federateSemantic` en workspace y ya no duplica la búsqueda por hijo.
- [x] 1.4 Repo único: sin índice → mensaje propio; índice ilegible → `semantic search failed: <mensaje>`; ambos con exit 1. Sin `catch` vacío.

## 2. Tests

- [x] 2.1 `test/cli-semantic.test.ts` con los cinco estados (sin índice en workspace, `--in` inexistente, índice ilegible en un hijo, repo único sin índice, repo único con índice ilegible). Verificado rojo contra `main` (5/5 fallan) y verde con el fix (5/5 pasan).
- [x] 2.2 `test/workspace-semantic.test.ts` y `test/semantic-search.test.ts` siguen verdes (20 + 5 casos), así que el MCP no cambió de contrato.

## 3. Gates

- [x] 3.1 `npx tsc -p tsconfig.json --noEmit` → sin errores.
- [x] 3.2 `npm run test` → 32 fallos, todos reproducidos por nombre en un checkout limpio de `main` (layout `.trail` vs `.graft`, expectativas de marca/help atadas a la máquina); ninguno en los archivos tocados.
