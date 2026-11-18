# Design

## Contexto

Cuatro funciones federadas resuelven `in` con tres reglas distintas (verificado sobre `ae72591`):

| Función | `in` hoy |
|---|---|
| `federateAsk` (`src/graph/workspace.ts:337-350`) | hijo más largo que es prefijo de `in`; pasa el resto al hijo; un `in` sin hijo lanza `no workspace repo matching`; un grupo (`in="a"`) lanza |
| `federateCallers` (`:746-781`) | pasa `in` completo a `resolveSymbol` de cada hijo → `assertPrefixIndexed` lanza (`src/graph/scopes.ts:320-325`) |
| `federateGrep` (`:650-690`) | no recibe `in` |
| `federateSemantic` (`:835-875`) | grupo de hijos, o hijo + sub-prefijo, o `isError`; filtra por `file_path` después de buscar |

Despliegue: trail corre como UN servidor MCP por PC, compartido por todos los agentes y sin estado por
proceso. El cambio de contrato llega a todos a la vez cuando se reinstala y reinicia ese servidor.

## Decisiones

**D1 — Dos funciones, una pura y una que toca grafos (`src/graph/workspace.ts`).**

```ts
export interface WorkspaceInTarget { child: string; childIn?: string }
export type WorkspaceInResolution =
  | { ok: true; narrowed: boolean; targets: WorkspaceInTarget[] }
  | { ok: false; message: string };
export function resolveWorkspaceIn(children: readonly string[], inArg: string | undefined): WorkspaceInResolution;

export interface ScopedChild { child: string; graph: GraphV1; childIn?: string }
export type ScopedWorkspace =
  | { ok: true; narrowed: boolean; children: ScopedChild[]; missing: string[] }
  | { ok: false; message: string };
export function scopeWorkspaceGraphs(wg: WorkspaceGraphs, inArg: string | undefined): ScopedWorkspace;
```

`resolveWorkspaceIn` es pura (recibe solo los nombres de hijo, sin leer disco) para que el issue #15 pueda
llamarla en `callTool` antes del refresco de grafos (`src/mcp/tools.ts:311`) sin cargar nada.
`scopeWorkspaceGraphs` la aplica a `WorkspaceGraphs`: `children` son los destinos con grafo, `missing` los
destinos sin grafo (se informan, no se descartan), y verifica que el sub-prefijo exista en el grafo del hijo.
`narrowed` es `true` solo si `in` normalizado no es vacío.

**D2 — Orden de reglas: hijo/dentro de hijo antes que grupo.** `discoverWorkspaceChildren`
(`src/graph/scopes.ts`) devuelve repos git de primer nivel o uno más profundo dentro de carpetas que no son
git, así que un hijo no contiene a otro y las dos reglas nunca compiten en un workspace real. Se fija el orden
(hijo primero) solo para que el comportamiento sea determinista si un `workspace.json` editado a mano lista
`a` y `a/x`. La semántica hoy evalúa el grupo primero (`:852-856`); cambia solo en ese caso patológico.

**D3 — El grupo de hijos vale en las cuatro tools** (decisión P1 de la propuesta). `federateSemantic` ya lo
acepta (`:852-856`, spec `busqueda-semantica-workspace`, `README.md:507`); si el resolvedor común lo rechazara,
el cambio regresaría la semántica. Además `trail_set_scope` sobre la carpeta de un grupo inyecta ese grupo
como `in` y hoy rompe `trail_find_code`. Reproducido: con hijos `a/x` y `a/y`, `trail_find_code` con
`in: "a"` responde `no workspace repo matching "a"`.

**D4 — Un solo texto de error** (decisión P2). `no workspace repo matching "<in>" — repos: <todos>`: el de
`federateAsk`, porque lista todos los repos (la semántica listaba 5). Cada función lo entrega a su manera,
sin cambiar su tipo de retorno: `federateAsk` y `federateGrep` lanzan `Error(message)` (`callTool` lo
convierte en `isError: true`, `src/mcp/tools.ts:318-320`); `federateCallers` devuelve
`{ text: message, found: false }`; `federateSemantic` devuelve `{ text: message, isError: true }`.

**D5 — Sub-prefijo inexistente = error en las cuatro** (decisión P3). Con la regla D1 el sub-prefijo recae
siempre en un único hijo, así que «un hijo donde el sub-prefijo no existe se salte» (tercer punto del issue)
no ocurre por construcción: con grupo no hay sub-prefijo. Lo que sí ocurre es el typo: `scopeWorkspaceGraphs`
devuelve `nothing indexed under "<in>/" in workspace repo <hijo>`, igual que el camino de un solo repo
(`assertPrefixIndexed`, mensaje fijado por `test/ask.test.ts:960`, `test/mcp-tools.test.ts:112`). Hoy
`federateAsk` lo traga en `catch { continue }` (`:372-374`) y responde `no matching nodes`. El `catch` se
conserva solo para un hijo con grafo corrupto.

**D6 — Compuerta entre hijos.** `onlyChild` (`:335`, usado en `:355`, `:410`, `:414`) pasa a
`narrowed && children.length + missing.length === 1`. No basta con «`in` presente»: con un grupo de varios
hijos hay competencia entre repos y la compuerta debe aplicar.

**D7 — Nota de cobertura sin cambio.** `coverageNote(wg)` sigue contando todos los hijos sin grafo aunque
`in` acote. Cambiarlo es alcance de otro issue; queda anotado en el proposal.

**D8 — Descripción única de `in`.** Una constante `IN_DESCRIPTION` en `src/mcp/tools.ts` usada por las
cuatro tools (hoy: `:76`, `:127`, `:141`, `:169`, con tres redacciones). Texto: `narrow to a path prefix
(segment-aware). In a workspace the path is relative to the workspace root and may name a repo, a group of
repos or a path inside a repo (e.g. "packages", "packages/api", "packages/api/src"); in a single repo it is
relative to the repo root (e.g. "server/src").` Ninguna prueba actual fija esas descripciones
(verificado con `grep -n "narrow to nodes" test/`: sin resultados).

## Dónde engancharán #15 y #18

- **#15** (`in` absoluto, sin el prefijo del grupo, validación antes del refresco): extiende
  `resolveWorkspaceIn` (nuevas reglas antes del error) y la llama desde `callTool`, antes de
  `ensureFreshChildren`. Las cuatro funciones federadas no cambian.
- **#18** (`limit` y tope global de `trail_find_all`): añade `limit` a `federateGrep` y al schema de
  `trail_find_all`; consume `scoped.children` ya filtrado, por lo que el tope aplica solo a los hijos en
  alcance.

## Solape con #20

#20 toca `src/mcp/server.ts` (`clientRoot`, `injectClientScope`, `:55`, `:99-118`, `:139-156`) y la
descripción de `trail_set_scope` (`src/mcp/tools.ts:51`). Este cambio NO edita `server.ts`. En
`src/mcp/tools.ts` edita otras líneas (`in` de las cuatro tools, `callWorkspaceTool` case `graft_find_all`,
imports). El test stdio de `set_scope` va en un archivo nuevo, no en `test/mcp-args.test.ts`, para no chocar
con las pruebas de #20.

## Riesgos

- `src/graph/workspace.ts` (960 líneas) recibe cambios de #14, #15 y #18 en secuencia: mantener el resolvedor
  como bloque contiguo después de `coverageNote` (`:241-245`) para que #15 lo edite sin tocar otras zonas.
- `federateSemantic` hoy no exige grafo cargado; `scopeWorkspaceGraphs` sí lo usa para validar el
  sub-prefijo. Un hijo con `embeddings.db` pero sin grafo no se valida (se trata como `missing`).
- Cambio de contrato visible para el agente: un `in` con grupo ahora funciona en `find_code`; un typo de
  sub-prefijo ahora es error en vez de «sin resultados». Ambos son el comportamiento del camino de un solo repo.
