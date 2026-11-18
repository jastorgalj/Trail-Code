# Tasks

## 1. Pruebas primero

- [x] 1.1 `test/init-skill-report.test.ts`: CLI bajo brand `trail` con HOME de scratch; primera corrida con
      `--all-agents` (dos líneas `✓ <agente>: <path> (created)` + `· skills: claude, hermes (2 written)`),
      segunda corrida idempotente (`(unchanged)` y `(0 written, 2 unchanged)`), `--agents hermes`
      (no menciona `~/.claude/skills` y el resumen nombra solo `hermes`) y `--no-global`
      (`· skills: skipped (--no-global)`, sin paths de skill).
- [x] 1.2 `test/claude-init.test.ts`: `runInit` devuelve `skillAction` `created` → `unchanged` → `updated`
      (tras escribir basura en la skill) y `''` bajo `global: false`.

## 2. Implementación

- [x] 2.1 `src/claude/init.ts`: `InitResult.skillAction`, helper `writeSkill` idempotente usado por
      `runTrailInit` y por el path legacy de `graft`.
- [x] 2.2 `src/hosts/init.ts`: las entradas de skill llevan `kind: 'skill'`.
- [x] 2.3 `src/cli.ts`: línea `✓ claude: <path> (<estado>)`, `WireReport.skills`, y el resumen único de la
      corrida (incluido `skipped (--no-global)`, también en modo workspace quieto).

## 3. Verificación

- [x] 3.1 `npx tsc -p tsconfig.json --noEmit` sin errores.
- [x] 3.2 `node --import tsx --test test/init-skill-report.test.ts test/claude-init.test.ts` → 19/19.
- [x] 3.3 Suite completa: los fallos que quedan se reproducen igual sobre `origin/main` sin estos cambios
      (entorno sin binarios nativos por `npm ci --ignore-scripts`, y un test A5 dependiente del orden).

## 4. Documentación

- [x] 4.1 Delta de `superficie-git` con la forma de las líneas, archivado junto con el cambio.
