/**
 * CLI guard: `trail <cmd> <root>` where `<root>` is a file or a nonexistent path.
 *
 * Before this fix every command treated a file or a missing path as a valid repo
 * root, logged `ENOTDIR` noise, and exited 0 (or created the missing directory).
 * Now every command exits 1 with a one-line message on stderr and no side effects.
 *
 * Tests are ordered to match the 14-command list in the card:
 *   ask, map, callers, grep, blast, skeleton, stats, status, viz, build,
 *   build --check, mcp, init --dry-run --yes --no-global, uninstall.
 * Plus: raíz-inexistente (a path that doesn't exist), --dir side-effect,
 * and a rootProblem unit test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { execFileSync } from "node:child_process";
import { rootProblem } from "../src/graph/root.js";
import { tmpRepo, chmodDenialUnavailable } from "./helpers.js";

// ─── helpers ────────────────────────────────────────────────────────────────

/**
 * Creates a fresh tmp dir with one file inside it; returns the absolute path
 * of that file (the "root-is-a-file" fixture).
 */
function fileRoot(tag: string): string {
  const d = tmpRepo(`rnd-${tag}`);
  const f = join(d, "not-a-dir.ts");
  writeFileSync(f, "export const x = 1;\n");
  return realpathSync.native(f);
}

/** Runs the CLI and returns {stdout, stderr, status}. */
function runCli(args: string[], extraEnv?: NodeJS.ProcessEnv): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GRAFT_NO_TRAIL_SWITCH: "1", ...extraEnv },
    });
    return { stdout, stderr: "", status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", status: e.status ?? 1 };
  }
}

/**
 * Returns a RegExp matching the exact `✗ root is not a directory: <absPath>`
 * line in stderr, handling Windows backslash escaping.
 */
function notDirRe(absPath: string): RegExp {
  return new RegExp("✗ root is not a directory: " + absPath.replace(/\\/g, "\\\\"), "m");
}

function doesNotExistRe(absPath: string): RegExp {
  return new RegExp("✗ root does not exist: " + absPath.replace(/\\/g, "\\\\"), "m");
}

/** Core contract for the "root is a file" case. */
function assertNotDir(r: { stdout: string; stderr: string; status: number }, absFile: string): void {
  assert.equal(r.status, 1, "exit code must be 1");
  assert.strictEqual(r.stdout, "", "stdout must be empty");
  assert.match(r.stderr, notDirRe(absFile), "stderr must contain the ✗ not-a-directory message");
  assert.doesNotMatch(r.stderr, /graph refresh skipped/, "stderr must not contain 'graph refresh skipped'");
  assert.doesNotMatch(r.stderr, /ENOTDIR/, "stderr must not contain raw ENOTDIR");
}

/** Core contract for the "root does not exist" case. */
function assertDoesNotExist(r: { stdout: string; stderr: string; status: number }, absPath: string): void {
  assert.equal(r.status, 1, "exit code must be 1");
  assert.strictEqual(r.stdout, "", "stdout must be empty");
  assert.match(r.stderr, doesNotExistRe(resolvePath(absPath)), "stderr must contain the ✗ does-not-exist message");
}

// ─── 14 commands (one test each) ───────────────────────────────────────────

test("ask: raíz-archivo → ✗ root is not a directory, exit 1, stdout vacío", () => {
  const f = fileRoot("ask");
  assertNotDir(runCli(["ask", "x", f]), f);
});

test("map: raíz-archivo → ✗ root is not a directory, exit 1, stdout vacío", () => {
  const f = fileRoot("map");
  assertNotDir(runCli(["map", f]), f);
});

test("callers: raíz-archivo → ✗ root is not a directory, exit 1, stdout vacío", () => {
  const f = fileRoot("callers");
  assertNotDir(runCli(["callers", "foo", f]), f);
});

test("grep: raíz-archivo → ✗ root is not a directory, exit 1, stdout vacío", () => {
  const f = fileRoot("grep");
  assertNotDir(runCli(["grep", "foo", f]), f);
});

test("blast: raíz-archivo → ✗ root is not a directory, exit 1, stdout vacío", () => {
  const f = fileRoot("blast");
  assertNotDir(runCli(["blast", f]), f);
});

test("skeleton: raíz-archivo → ✗ root is not a directory, exit 1, stdout vacío", () => {
  const f = fileRoot("skeleton");
  assertNotDir(runCli(["skeleton", "a.ts", f]), f);
});

test("stats: raíz-archivo → ✗ root is not a directory, exit 1, stdout vacío", () => {
  const f = fileRoot("stats");
  assertNotDir(runCli(["stats", f]), f);
});

test("status: raíz-archivo → ✗ root is not a directory, exit 1, stdout vacío", () => {
  const f = fileRoot("status");
  // `status` is only registered under the trail brand (TRAIL_INVOKED_AS=trail);
  // under graft it's named `stats`. Pass the brand env so the command exists.
  assertNotDir(runCli(["status", f], { TRAIL_INVOKED_AS: "trail" }), f);
});

test("viz --export: raíz-archivo → ✗ root is not a directory, exit 1, stdout vacío", () => {
  const f = fileRoot("viz");
  // The export dir is never created because the guard fires before viz runs.
  const exportDir = join(tmpdir(), `trail-viz-out-${Date.now()}`);
  assertNotDir(runCli(["viz", f, "--export", exportDir, "--no-open"]), f);
  assert.ok(!existsSync(exportDir), "--export dir must not have been created");
});

test("build: raíz-archivo → ✗ root is not a directory, exit 1, stdout vacío", () => {
  const f = fileRoot("build");
  assertNotDir(runCli(["build", f]), f);
});

test("build --check: raíz-archivo → ✗ root is not a directory, exit 1, stdout vacío", () => {
  const f = fileRoot("buildcheck");
  assertNotDir(runCli(["build", f, "--check"]), f);
});

test("mcp: raíz-archivo → ✗ root is not a directory, exit 1, stdout vacío", () => {
  const f = fileRoot("mcp");
  assertNotDir(runCli(["mcp", f]), f);
});

test("init --dry-run: raíz-archivo → ✗ root is not a directory, exit 1, stdout vacío", () => {
  const f = fileRoot("init");
  assertNotDir(runCli(["init", f, "--dry-run", "--yes", "--no-global"]), f);
});

test("uninstall: raíz-archivo → ✗ root is not a directory, exit 1, stdout vacío", () => {
  const f = fileRoot("uninstall");
  assertNotDir(runCli(["uninstall", f]), f);
});

// ─── raíz inexistente ──────────────────────────────────────────────────────

test("ask: raíz-inexistente → ✗ root does not exist, exit 1, no crea el directorio", () => {
  const base = tmpRepo("ne-ask");
  // Do NOT call realpathSync.native on a nonexistent path — it throws ENOENT.
  // Build the nonexistent sibling from the already-canonical base.
  const nonexistent = base + "-nonexistent-" + Date.now();
  assert.ok(!existsSync(nonexistent), "pre: path must not exist");

  const r = runCli(["ask", "x", nonexistent]);
  assert.equal(r.status, 1);
  assert.strictEqual(r.stdout, "");
  assert.match(r.stderr, doesNotExistRe(resolvePath(nonexistent)));
  assert.ok(!existsSync(nonexistent), "post: nonexistent root must NOT have been created");
});

test("build: raíz-inexistente → ✗ root does not exist, exit 1, no crea el directorio", () => {
  const base = tmpRepo("ne-build");
  const ne = base + "-nonexistent-" + Date.now();
  assert.ok(!existsSync(ne), "pre: path must not exist");

  assertDoesNotExist(runCli(["build", ne]), ne);
  assert.ok(!existsSync(ne), "post: nonexistent root must NOT have been created");
});

test("init --dry-run: raíz-inexistente → ✗ root does not exist, exit 1, no crea el directorio", () => {
  const base = tmpRepo("ne-init");
  const ne = base + "-nonexistent-" + Date.now();
  assert.ok(!existsSync(ne), "pre: path must not exist");

  assertDoesNotExist(runCli(["init", ne, "--dry-run", "--yes", "--no-global"]), ne);
  assert.ok(!existsSync(ne), "post: nonexistent root must NOT have been created");
});

test("uninstall: raíz-inexistente → ✗ root does not exist, exit 1, no crea el directorio", () => {
  const base = tmpRepo("ne-uninstall");
  const ne = base + "-nonexistent-" + Date.now();
  assert.ok(!existsSync(ne), "pre: path must not exist");

  assertDoesNotExist(runCli(["uninstall", ne]), ne);
  assert.ok(!existsSync(ne), "post: nonexistent root must NOT have been created");
});

// ─── --dir side-effect ────────────────────────────────────────────────────

test("--dir + raíz-archivo: mismo error, el dir override no se crea", () => {
  const f = fileRoot("dir-override");
  const otherDir = join(tmpdir(), `trail-ctxout-${Date.now()}`);
  assert.ok(!existsSync(otherDir), "pre: override dir must not exist");

  const r = runCli(["--dir", otherDir, "ask", "x", f]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, notDirRe(f));
  assert.ok(!existsSync(otherDir), "post: --dir override must not have been created");
});

// ─── build patchBuildConfig guard ─────────────────────────────────────────

test("build --include-dir: raíz-archivo con flag que llama patchBuildConfig → no escribe nada en el directorio padre", () => {
  const f = fileRoot("build-patch");
  const parentDir = join(f, ".."); // the tmpRepo dir
  const beforeEntries = readdirSync(parentDir).sort();
  // patchBuildConfig would try <file>/graft/... which is ENOTDIR; the guard fires before it even tries.
  const r = runCli(["build", f, "--include-dir", "src"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, notDirRe(f));
  // Verify the parent dir's contents are unchanged (guard fired before patchBuildConfig wrote anything).
  assert.deepEqual(readdirSync(parentDir).sort(), beforeEntries, "parentDir entries must be unchanged");
});

test("build --include-dir: raíz-inexistente → guard antes de patchBuildConfig, no crea el directorio", () => {
  const base = tmpRepo("ne-build-inc");
  const ne = base + "-nonexistent-" + Date.now();
  assert.ok(!existsSync(ne), "pre: path must not exist");
  // patchBuildConfig (triggered by --include-dir) would create <ne>/graft/... if the guard didn't fire first.
  const r = runCli(["build", ne, "--include-dir", "src"]);
  assert.equal(r.status, 1);
  assert.strictEqual(r.stdout, "");
  assert.match(r.stderr, doesNotExistRe(resolvePath(ne)));
  assert.ok(!existsSync(ne), "post: raíz inexistente no debe haberse creado (guard fires before patchBuildConfig)");
});

// ─── rootProblem unit tests ───────────────────────────────────────────────

test("rootProblem: directorio existente → null", () => {
  const d = tmpRepo("rp-dir");
  assert.strictEqual(rootProblem(d), null);
});

test("rootProblem: archivo existente → not-dir", () => {
  const d = tmpRepo("rp-file");
  const f = join(d, "file.ts");
  writeFileSync(f, "");
  assert.strictEqual(rootProblem(f), "not-dir");
});

test("rootProblem: ruta inexistente → missing", () => {
  const d = tmpRepo("rp-missing");
  const gone = join(d, "does-not-exist-" + Date.now());
  assert.strictEqual(rootProblem(gone), "missing");
});

test(
  "rootProblem: error de stat distinto de ENOENT/ENOTDIR → null (EACCES, no portable en Windows — omitido en Windows)",
  { skip: chmodDenialUnavailable() ?? undefined },
  () => {
    const d = tmpRepo("rp-eacces");
    // Revoke all permissions so stat on a child path raises EACCES.
    chmodSync(d, 0o000);
    try {
      const result = rootProblem(join(d, "sub-" + Date.now()));
      assert.strictEqual(result, null, "unexpected stat errors must return null");
    } finally {
      chmodSync(d, 0o755);
    }
  },
);
