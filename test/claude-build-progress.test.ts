/**
 * `trail init` builds a repo's map by spawning `trail build` and reading the
 * child's output: its progress becomes init's spinner count. That only works if
 * the parent can parse the line the child draws — including the thousands
 * separators a big repo gets.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseProgress } from "../src/claude/build-progress.js";

test("parseProgress reads the plain form", () => {
  assert.deepEqual(parseProgress("\x1b[2Kparsing 12/40 files · 1s · src/a.ts"), { index: 12, total: 40 });
});

test("parseProgress reads counts with thousands separators", () => {
  assert.deepEqual(parseProgress("parsing 1,204/1,942 files · 75s · src/b.ts"), { index: 1204, total: 1942 });
});

test("parseProgress takes the last line in a chunk", () => {
  const chunk = "parsing 1/9 filesparsing 2/9 filesparsing 3/9 files";
  assert.deepEqual(parseProgress(chunk), { index: 3, total: 9 });
});

test("parseProgress is null when the chunk says nothing about progress", () => {
  assert.equal(parseProgress("✓ wiring: 10 nodes, 5 edges"), null);
});
