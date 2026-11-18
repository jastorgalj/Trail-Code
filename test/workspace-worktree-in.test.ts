/**
 * Consultar un worktree enlazado DESDE un servidor rooted en el workspace.
 *
 * Un worktree (`<repo>/.worktrees/<rama>`, `.git` es archivo) no es un hijo del
 * workspace: comparte repo con su checkout principal y contarlo como repo lo
 * indexaría dos veces. El efecto secundario era que `in=` sobre un worktree no
 * matcheaba ningún hijo — la consulta respondía "no workspace repo" justo en las
 * tareas donde trail más aporta (revisar un diff, blast radius de una rama).
 *
 * El test usa `git init` / `git worktree add` reales: la detección depende del
 * layout en disco de git y un fixture a mano no lo falsificaría.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildGraph } from "../src/graph/build.js";
import { ensureFreshGraph } from "../src/graph/refresh.js";
import {
  federateAsk,
  federateCallers,
  federateGrep,
  splitWorkspace,
  workspaceGraphsForIn,
} from "../src/graph/workspace.js";
import { callTool } from "../src/mcp/tools.js";
import { tmpRepo } from "./helpers.js";

const MAIN = [
  "export function mainHandler() { return helper(); }",
  "function helper() { return 1; }",
  "",
].join("\n");

/** El símbolo que EXISTE SOLO en la rama del worktree. */
const BRANCH_ONLY = [
  "export function branchOnlyWidget() { return branchOnlyHelper(); }",
  "function branchOnlyHelper() { return 42; }",
  "",
].join("\n");

/** Aísla el test de la config git del desarrollador (mismo criterio que graph-seed). */
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "trail test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "trail test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    },
  });
}

/** Un repo commitado con un archivo en `src/` y su caché git-ignorada. */
function gitChild(parent: string, name: string, file: string, body: string): string {
  const dir = join(parent, name);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", file), body);
  writeFileSync(join(dir, ".gitignore"), "graft/\n.worktrees/\n");
  git(dir, "init", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "init");
  return dir;
}

/** Workspace de dos hijos construido, + un worktree vivo de `repoA` con un símbolo
 * que solo existe en su rama. */
async function workspaceWithWorktree(): Promise<{
  parent: string;
  worktree: string;
  clean: () => void;
}> {
  const parent = tmpRepo("ws-wt");
  gitChild(parent, "repoA", "main.ts", MAIN);
  gitChild(parent, "repoB", "other.ts", "export function otherHandler() { return 0; }\n");
  await splitWorkspace(parent, undefined, async (childDir) => {
    await buildGraph(childDir);
  });

  const repoA = join(parent, "repoA");
  const worktree = join(repoA, ".worktrees", "feature-x");
  git(repoA, "worktree", "add", "-b", "feature-x", worktree, "HEAD");
  writeFileSync(join(worktree, "src", "branch.ts"), BRANCH_ONLY);

  // El gate de la query (MCP y CLI) es quien siembra y refresca el worktree.
  await ensureFreshGraph(worktree);
  return { parent, worktree, clean: () => rmSync(parent, { recursive: true, force: true }) };
}

test("resolveWorktreeIn: reconoce el worktree del hijo, relativo o absoluto", async () => {
  const { parent, worktree, clean } = await workspaceWithWorktree();
  try {
    const rel = workspaceGraphsForIn(parent, undefined, "repoA/.worktrees/feature-x/src");
    assert.ok(rel.graphs.loaded.some((l) => l.child === "repoA/.worktrees/feature-x"));
    assert.equal(rel.in, "repoA/.worktrees/feature-x/src");

    const abs = workspaceGraphsForIn(parent, undefined, join(worktree, "src"));
    assert.ok(abs.graphs.loaded.some((l) => l.child === "repoA/.worktrees/feature-x"));
    assert.equal(abs.in, "repoA/.worktrees/feature-x/src", "absoluto → sub-prefijo relativo");

    // Un `in` normal (un hijo) no se toca.
    const plain = workspaceGraphsForIn(parent, undefined, "repoA/src");
    assert.equal(plain.in, "repoA/src");
    assert.equal(plain.graphs.loaded.length, 2, "sin worktree extra");
  } finally {
    clean();
  }
});

test("in=<hijo>/.worktrees/<rama>: el símbolo de la rama solo aparece por ese in", async () => {
  const { parent, clean } = await workspaceWithWorktree();
  try {
    const all = federateGrep(parent, undefined, "branchOnlyHelper", {});
    assert.equal(all.result.totalHits, 0, "la rama no es visible sin acotar al worktree");

    const scoped = federateGrep(parent, undefined, "branchOnlyHelper", {
      in: "repoA/.worktrees/feature-x",
    });
    assert.ok(scoped.result.totalHits > 0, "el worktree sí responde");
    for (const g of scoped.result.groups) {
      assert.ok(
        g.path.startsWith("repoA/.worktrees/feature-x/"),
        `el path abre el archivo correcto: ${g.path}`,
      );
    }

    // `trace_calls` sobre el worktree: el símbolo que solo existe ahí resuelve.
    const callers = federateCallers(parent, undefined, "branchOnlyWidget", {
      in: "repoA/.worktrees/feature-x/src",
    });
    assert.equal(callers.found, true, callers.text);
    assert.match(callers.text, /## repoA\/\.worktrees\/feature-x\//);

    // Y un sub-prefijo equivocado sigue fallando fuerte, no en silencio.
    assert.throws(
      () => federateGrep(parent, undefined, "branchOnlyHelper", {
        in: "repoA/.worktrees/feature-x/nope",
      }),
      /nothing indexed under/,
    );
  } finally {
    clean();
  }
});

test("in= sobre el worktree: ask acota y el servidor MCP siembra el grafo", async () => {
  const { parent, clean } = await workspaceWithWorktree();
  try {
    const ask = federateAsk(parent, undefined, "branchOnlyWidget helper", {
      limit: 8,
      in: "repoA/.worktrees/feature-x",
    });
    assert.ok(ask.hits.length > 0, "ask responde desde el worktree");
    for (const h of ask.hits) {
      assert.ok(
        h.scope?.startsWith("repoA/.worktrees/feature-x"),
        `scope con el path del worktree: ${h.scope}`,
      );
    }

    // El camino MCP real: `callTool` refresca (siembra si hace falta) antes de leer.
    const r = await callTool(parent, "trail_find_all", {
      pattern: "branchOnlyWidget",
      in: "repoA/.worktrees/feature-x/src",
    });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /repoA\/\.worktrees\/feature-x\/src\/branch\.ts/);
  } finally {
    clean();
  }
});
