# Delta: superficie-git

## ADDED Requirements

### Requirement: init reporta cada skill con su path y estado, y resume la corrida

`trail init` SHALL informar cada skill instalada con la misma forma que el resto de los archivos que escribe
(`✓ <agente>: <path> (created|updated|unchanged)`), de modo que una corrida sin cambios diga `unchanged`
en vez de aparentar una reescritura. Al final SHALL imprimir una sola línea de resumen con los agentes
cuyas skills se instalaron y cuántas se escribieron, y bajo `--no-global` SHALL decir explícitamente que
las skills se omitieron.

#### Scenario: Corrida con --all-agents sobre un HOME limpio

GIVEN un HOME limpio
WHEN se ejecuta `trail init --no-build --all-agents`
THEN la salida trae `✓ claude: ~/.claude/skills/trail/SKILL.md (created)`, `✓ hermes: ~/.hermes/skills/trail/SKILL.md (created)` y la línea `· skills: claude, hermes (2 written)`

#### Scenario: Segunda corrida idempotente

GIVEN el mismo repo y HOME después de una corrida con `--all-agents`
WHEN se ejecuta de nuevo `trail init --no-build --all-agents`
THEN las dos líneas de skill dicen `(unchanged)` y el resumen dice `· skills: claude, hermes (0 written, 2 unchanged)`

#### Scenario: init solo anuncia las skills de los agentes elegidos

GIVEN un HOME limpio
WHEN se ejecuta `trail init --no-build --agents hermes`
THEN la salida no menciona `~/.claude/skills` y el resumen nombra solo `hermes`

#### Scenario: init con --no-global dice que omitió las skills

GIVEN un HOME limpio
WHEN se ejecuta `trail init --no-build --agents claude --no-global`
THEN la salida no menciona ningún path de skill y trae `· skills: skipped (--no-global)`
