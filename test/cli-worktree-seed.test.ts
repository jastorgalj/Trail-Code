/**
 * CLI query commands (ask, grep, map) auto-seed a linked worktree.
 *
 * Without the fix: `queryRoot` → `nearestGraftRoot` walks UP from a nested
 * worktree (e.g. `main/.worktrees/feature`) and finds the main checkout's graph.
 * All queries answer from the main checkout, not the worktree.
 *
 * With the fix: `queryRoot` calls `seedGraph(cwd)` first. The worktree gets its
 * own graph. `nearestGraftRoot` stops at the worktree (level 0), and queries
 * answer from the worktree's code.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildGraph } from "../src/graph/build.js";
import { wiringPath } from "../src/graph/write.js";
import { tmpRepo } from "./helpers.js";

const CLI_ABS = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");
// tsx must be resolved from the trail repo's node_modules, not from the target git repo.
// On Windows, --import requires a file:// URL, not a native path.
const TSX_URL = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "tsx", "dist", "esm", "index.mjs"),
).href;

const MATH = "export function add(a: number, b: number): number {\n  return a + b;\n}\n";
const MUL  = "export function mul(a: number, b: number): number {\n  return a * b;\n}\n";

const GIT_ENV = {
  GIT_CONFIG_GLOBAL:  "/dev/null",
  GIT_CONFIG_SYSTEM:  "/dev/null",
  GIT_AUTHOR_NAME:    "trail test",
  GIT_AUTHOR_EMAIL:   "test@example.invalid",
  GIT_COMMITTER_NAME: "trail test",
  GIT_COMMITTER_EMAIL:"test@example.invalid",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...GIT_ENV },
  });
}

/** Run the trail CLI from an arbitrary cwd (which is the git repo, NOT the trail source). */
function runCliFrom(
  cwd: string,
  args: string[],
): { stdout: string; stderr: string; status: number } {
  const res = spawnSync(
    process.execPath,
    ["--import", TSX_URL, CLI_ABS, ...args],
    {
      cwd,
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, GRAFT_NO_TRAIL_SWITCH: "1" },
    },
  );
  return {
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    status: res.status ?? 1,
  };
}

const outOf = (d: string): string => join(d, "graft");

/** A committed git repo with one source file and graft/ gitignored. */
function gitRepo(): string {
  const d = tmpRepo("cliwt-repo");
  git(d, "init", "-b", "main");
  mkdirSync(join(d, "src"), { recursive: true });
  writeFileSync(join(d, "src", "math.ts"), MATH);
  writeFileSync(join(d, ".gitignore"), "graft/\n");
  git(d, "add", "-A");
  git(d, "commit", "-m", "init");
  return d;
}

test("ask/grep/map from a nested worktree auto-seed and answer from the worktree's code", async () => {
  // --- Setup ----------------------------------------------------------------
  const main = gitRepo();
  await buildGraph(main);

  // Put the worktree INSIDE the main checkout (like `.claude/worktrees/<name>`
  // or Hermes `.worktrees/<id>`). This is the shape that triggers the bug:
  // nearestGraftRoot walks up from wt → main and finds the main's graph.
  const wtDir = join(main, ".worktrees", "feature");
  mkdirSync(join(main, ".worktrees"), { recursive: true });
  git(main, "worktree", "add", "--detach", wtDir, "HEAD");

  // The worktree has an extra function not present in the main checkout.
  writeFileSync(join(wtDir, "src", "math.ts"), `${MATH}${MUL}`);

  // No graph in the worktree yet.
  assert.equal(
    existsSync(wiringPath(outOf(wtDir))),
    false,
    "pre: worktree must have no graph (git-ignored, not checked out)",
  );

  // --- grep -----------------------------------------------------------------
  // RED (pre-fix): nearestGraftRoot finds the main's graph → `grep mul` on main
  // has no matches → stdout is empty / stderr says "answering from <main>".
  //
  // GREEN (post-fix): seedGraph(wt) runs first → wt gets its own graph →
  // nearestGraftRoot stops at wt → refreshBefore patches the diff → `mul` is indexed.
  const grep = runCliFrom(wtDir, ["grep", "mul", "--no-refresh"]);

  // The fix must seed the graph before grep reads it.  After seeding,
  // refreshBefore → ensureFreshGraph runs the incremental patch (mul is new).
  // So --no-refresh is off for the first run, and we re-query after the graph exists.
  const grepFresh = runCliFrom(wtDir, ["grep", "mul"]);
  assert.equal(grepFresh.status, 0, `grep should succeed:\n${grepFresh.stderr}`);
  assert.match(grepFresh.stdout, /mul/, "grep should find the worktree-only 'mul' function");

  // Key invariant: the CLI must NOT say "answering from <main>" — that is the bug.
  assert.doesNotMatch(
    grepFresh.stderr,
    /answering from/,
    `grep must NOT answer from the main checkout:\n${grepFresh.stderr}`,
  );

  // The worktree must have been seeded with its own graph.
  assert.equal(
    existsSync(wiringPath(outOf(wtDir))),
    true,
    "worktree must have its own graph after the first CLI query",
  );

  // --- ask ------------------------------------------------------------------
  const ask = runCliFrom(wtDir, ["ask", "multiply two numbers"]);
  assert.equal(ask.status, 0, `ask should succeed:\n${ask.stderr}`);
  assert.match(ask.stdout, /mul/, "ask should surface the worktree-only 'mul' function");
  assert.doesNotMatch(
    ask.stderr,
    /answering from/,
    `ask must NOT answer from the main checkout:\n${ask.stderr}`,
  );

  // --- map ------------------------------------------------------------------
  const map = runCliFrom(wtDir, ["map"]);
  assert.equal(map.status, 0, `map should succeed:\n${map.stderr}`);
  assert.match(map.stdout, /src/, "map should output the worktree's directory structure");
  assert.doesNotMatch(
    map.stderr,
    /answering from/,
    `map must NOT answer from the main checkout:\n${map.stderr}`,
  );

  // --- Cleanup --------------------------------------------------------------
  git(main, "worktree", "remove", "--force", wtDir);
  rmSync(main, { recursive: true, force: true });
});

test("ask/grep/map from a SUBDIRECTORY of a nested worktree auto-seed and answer from the worktree's code", async () => {
  // --- Setup ----------------------------------------------------------------
  const main = gitRepo();
  await buildGraph(main);

  const wtDir = join(main, ".worktrees", "feature-sub");
  mkdirSync(join(main, ".worktrees"), { recursive: true });
  git(main, "worktree", "add", "--detach", wtDir, "HEAD");

  // The worktree has an extra function not present in the main checkout.
  writeFileSync(join(wtDir, "src", "math.ts"), `${MATH}${MUL}`);

  // No graph in the worktree yet.
  assert.equal(
    existsSync(wiringPath(outOf(wtDir))),
    false,
    "pre: worktree must have no graph (git-ignored, not checked out)",
  );

  // Run from the src/ subdirectory of the worktree, not from the root.
  const subDir = join(wtDir, "src");

  // --- grep from subdirectory -----------------------------------------------
  // RED (pre-fix): seedGraph(cwd) with cwd=<worktree>/src → mainWorktreeRoot
  // reads <worktree>/src/.git which doesn't exist → returns null → no seed →
  // nearestGraftRoot climbs to main checkout → 0 hits / "answering from <main>".
  //
  // GREEN (post-fix): nearestLinkedWorktreeRoot(cwd) walks up → finds <worktree> →
  // seedGraph(<worktree>) succeeds → graph seeded → grep finds 'mul'.
  //
  // Note: when cwd = src/, nearestGraftRoot walks up 1 level to <worktree> and
  // legitimately prints "no code map here: answering from <worktree>/graft".
  // That is correct behavior (cwd is a subdir of the worktree). The key invariant
  // is that the answer comes from the worktree's graph, NOT from the main checkout.
  const grepSub = runCliFrom(subDir, ["grep", "mul"]);
  assert.equal(grepSub.status, 0, `grep from subdirectory should succeed:\n${grepSub.stderr}`);
  assert.match(grepSub.stdout, /mul/, "grep from subdirectory should find the worktree-only 'mul' function");
  // Must NOT report "answering from <main checkout>" — that is the bug.
  // May report "answering from <worktree>/graft" (legitimate: walked up from src/).
  assert.doesNotMatch(
    grepSub.stderr,
    new RegExp(outOf(main).replace(/\\/g, "\\\\").replace(/\./g, "\\.")),
    `grep from subdirectory must NOT answer from the main checkout:\n${grepSub.stderr}`,
  );

  // --- ask from subdirectory ------------------------------------------------
  const askSub = runCliFrom(subDir, ["ask", "multiply two numbers"]);
  assert.equal(askSub.status, 0, `ask from subdirectory should succeed:\n${askSub.stderr}`);
  assert.match(askSub.stdout, /mul/, "ask from subdirectory should surface the worktree-only 'mul' function");
  assert.doesNotMatch(
    askSub.stderr,
    new RegExp(outOf(main).replace(/\\/g, "\\\\").replace(/\./g, "\\.")),
    `ask from subdirectory must NOT answer from the main checkout:\n${askSub.stderr}`,
  );

  // --- map from subdirectory ------------------------------------------------
  const mapSub = runCliFrom(subDir, ["map"]);
  assert.equal(mapSub.status, 0, `map from subdirectory should succeed:\n${mapSub.stderr}`);
  assert.doesNotMatch(
    mapSub.stderr,
    new RegExp(outOf(main).replace(/\\/g, "\\\\").replace(/\./g, "\\.")),
    `map from subdirectory must NOT answer from the main checkout:\n${mapSub.stderr}`,
  );

  // --- Cleanup --------------------------------------------------------------
  git(main, "worktree", "remove", "--force", wtDir);
  rmSync(main, { recursive: true, force: true });
});
