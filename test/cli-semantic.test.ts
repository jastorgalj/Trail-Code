/**
 * `trail ask --semantic` at the process boundary — the three states the old
 * code could not tell apart, plus the `--in` it never applied in a workspace.
 *
 * Before this fix the CLI had its own copy of the federated search: an empty
 * `catch { /* DB not ready *\/ }` turned an unreadable index into "no matches",
 * a child without `embeddings.db` was skipped in silence, and `--in` was
 * ignored — so `--in repoB` answered from every repo. Each test below pins one
 * of those states; none of them needs the embedding model, because every one
 * fails (or is diagnosed) before the query is embedded.
 *
 * Run with:
 *   node --import tsx --test test/cli-semantic.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeWorkspace } from "../src/graph/workspace.js";
import { contextDirFor, CACHE_DIR } from "../src/context/node-file.js";
import { tmpRepo, runCli } from "./helpers.js";

// The graph is irrelevant here: every case is decided before or during the
// index lookup, and a refresh would need a provider for nothing.
process.env.GRAFT_NO_REFRESH = "1";

/** Parent dir with two git children and a `workspace.json` listing both. */
function workspace(): string {
  const root = tmpRepo("cli-sem");
  for (const child of ["repoA", "repoB"]) mkdirSync(join(root, child, ".git"), { recursive: true });
  writeWorkspace(root, { version: 1, children: ["repoA", "repoB"] });
  return root;
}

/** Put bytes where a child's vector index belongs — readable path, unreadable DB. */
function corruptIndex(repoDir: string): string {
  const db = join(contextDirFor(repoDir), CACHE_DIR, "embeddings.db");
  mkdirSync(dirname(db), { recursive: true });
  writeFileSync(db, "this is not a sqlite database at all\n");
  return db;
}

test("workspace with no index at all: says 0 of N and exits 1", () => {
  const root = workspace();
  const r = runCli(["ask", "anything", root, "--semantic", "--no-refresh"]);

  assert.equal(r.status, 1, r.describe());
  assert.equal(r.stdout, "", "a diagnosis is not a hit list");
  assert.match(
    r.stderr,
    /0 of 2 workspace repos have a semantic index; run trail build to cover repoA, repoB/,
    r.describe(),
  );
});

test("--in naming nothing is reported, not searched across every repo", () => {
  const root = workspace();
  corruptIndex(join(root, "repoA"));
  const r = runCli(["ask", "anything", root, "--semantic", "--in", "nope", "--no-refresh"]);

  assert.equal(r.status, 1, r.describe());
  assert.match(r.stderr, /no workspace repos match "in=nope"/, r.describe());
  // repoA's index is broken too, but it was never in scope: no search happened.
  assert.doesNotMatch(r.stderr, /semantic search failed in repoA/, r.describe());
});

test("an unreadable child index is reported on stderr, not swallowed", () => {
  const root = workspace();
  corruptIndex(join(root, "repoA"));
  const r = runCli(["ask", "anything", root, "--semantic", "--no-refresh"]);

  assert.equal(r.status, 1, r.describe());
  assert.match(r.stderr, /semantic search failed in repoA: /, r.describe());
  // The pre-fix behaviour: a broken DB read as an empty result set.
  assert.doesNotMatch(r.stderr, /no semantic matches found/, r.describe());
  assert.match(
    r.stderr,
    /1 of 2 workspace repos have a semantic index; run trail build to cover repoB/,
    r.describe(),
  );
});

test("single repo without an index says so — distinct from 'no matches'", () => {
  const repo = tmpRepo("cli-sem-single");
  mkdirSync(join(repo, ".git"));
  const r = runCli(["ask", "anything", repo, "--semantic", "--no-refresh"]);

  assert.equal(r.status, 1, r.describe());
  assert.match(r.stderr, /no semantic index for /, r.describe());
  assert.doesNotMatch(r.stderr, /no semantic matches found/, r.describe());
});

test("single repo with an unreadable index reports the failure", () => {
  const repo = tmpRepo("cli-sem-corrupt");
  mkdirSync(join(repo, ".git"));
  corruptIndex(repo);
  const r = runCli(["ask", "anything", repo, "--semantic", "--no-refresh"]);

  assert.equal(r.status, 1, r.describe());
  assert.match(r.stderr, /semantic search failed: .*file is not a database/, r.describe());
  assert.doesNotMatch(r.stderr, /no semantic matches found/, r.describe());
});
