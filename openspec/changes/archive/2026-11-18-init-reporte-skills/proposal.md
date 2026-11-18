# Proposal

## Why

`trail init` sí escribe las skills de agente, pero no las reporta como reporta todo lo demás. En `0.29.0`
la skill de Claude Code sale como un `✓ wrote <path>` pelado: sin `(created|updated|unchanged)`, así que
una segunda corrida idempotente parece haber reescrito el archivo (`src/cli.ts:1531`). La de Hermes, en
cambio, solo aparece dentro del bloque del host `hermes` y con otra forma, de modo que quien mira la salida
no puede confirmar por script si una skill quedó instalada, si cambió o si se omitió.

Además no hay una línea final que resuma las skills de la corrida: en un `init` de workspace son cuarenta
líneas de wiring y hay que leerlas todas. Y bajo `--no-global` las skills desaparecen de la salida sin decir
nada (`src/claude/init.ts:184-194`, `src/hosts/init.ts:104-110`), aunque el flag sea justamente el que las
omite.

Origen: issue jastorgalj/Trail-Code#9.

## What Changes

- `runInit` devuelve `skillAction` (`created` / `updated` / `unchanged`, vacío si no escribió skill) y usa
  un `writeSkill` idempotente que compara el contenido antes de reescribir (`src/claude/init.ts`). El path
  legacy de `graft` gana el mismo reporte sin cambiar nada más de su salida.
- La línea de la skill de Claude Code pasa a `✓ claude: <path> (<estado>)`, igual que las demás.
- Las entradas de skill de `runHostsInit` se marcan con `kind: 'skill'`, para distinguirlas del
  `AGENTS.md` del mismo host (`src/hosts/init.ts`).
- `wireTarget` acumula las skills en su `WireReport` y `runInitCommand` imprime una sola línea al final:
  `· skills: claude, hermes (2 written)`, o `(0 written, 2 unchanged)` si no hubo nada que escribir, o
  `· skills: skipped (--no-global)` cuando el flag las omitió.
- Tests: `test/init-skill-report.test.ts` cubre el contrato por CLI (primera corrida, corrida idempotente,
  selección parcial y `--no-global`); `test/claude-init.test.ts` cubre `skillAction`.

## Capabilities

### New Capabilities

(ninguna)

### Modified Capabilities

- `superficie-git`: el requerimiento nuevo «init reporta cada skill con su path y estado, y resume la
  corrida» fija la forma de esas líneas.

## Fuera de alcance

- La forma del resto de las líneas de `init` (`✓ mcp …`, `- removed …`): no cambia.
- El path legacy de `graft` mantiene su texto salvo el estado de la skill.
- `antigravity` sigue fuera de la superficie de `init` (`SUPPORTED_AGENTS`), así que su skill no entra en el
  resumen.
