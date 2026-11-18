/**
 * The build's progress line has to be a *report*, not a log: hundreds of files
 * must not become hundreds of lines, and a non-TTY (CI, `> build.log`) must get
 * nothing at all.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { startProgressLine } from "../src/util/progress-line.js";

/** A stand-in for a WriteStream that records what was drawn. */
function fakeStream(opts: { isTTY?: boolean; columns?: number } = {}) {
  const chunks: string[] = [];
  const stream = {
    isTTY: opts.isTTY ?? true,
    columns: opts.columns ?? 100,
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
  };
  return { stream: stream as unknown as NodeJS.WriteStream, chunks };
}

/** A clock that advances a fixed step per call, so elapsed time is deterministic. */
function ticker(stepMs: number, start = 0) {
  let t = start;
  return () => {
    const v = t;
    t += stepMs;
    return v;
  };
}

test("not a TTY: nothing is ever written", () => {
  const { stream, chunks } = fakeStream({ isTTY: false });
  const line = startProgressLine({ stream, now: ticker(10) });
  assert.equal(line.active, false);
  for (let i = 0; i < 50; i++) line.update("parsing", i, 50, `src/f${i}.ts`);
  line.stop();
  assert.deepEqual(chunks, [], "a piped or redirected build stays a clean log");
});

test("hundreds of files draw a bounded number of frames, not one per file", () => {
  const { stream, chunks } = fakeStream();
  // 10ms per update, 120ms throttle: at most ~1 draw per 12 updates.
  const line = startProgressLine({ stream, now: ticker(10) });
  for (let i = 0; i < 800; i++) line.update("parsing", i, 800, `src/file-${i}.ts`);
  line.stop();
  assert.ok(chunks.length < 80, `expected a handful of frames, got ${chunks.length}`);
  assert.ok(chunks.length > 1, "but the line does redraw as work moves");
});

test("the final item of a phase always draws, so the total is never stale", () => {
  const { stream, chunks } = fakeStream();
  const line = startProgressLine({ stream, now: ticker(1) });
  line.update("parsing", 0, 4, "a.ts");
  // Same instant-ish: every one of these is inside the throttle window except the
  // last, which is the point.
  line.update("parsing", 1, 4, "b.ts");
  line.update("parsing", 3, 4, "d.ts");
  line.stop();
  const draws = chunks.filter((c) => c.includes("parsing"));
  assert.ok(draws.some((c) => c.includes("4/4 files")), "the last draw reports the full count");
});

test("the line carries the label, both counts, elapsed seconds and the path", () => {
  const { stream, chunks } = fakeStream();
  // Created at t=0, drawn at t=12s: `Math.round(12000/1000)` = 12s.
  let calls = 0;
  const line = startProgressLine({ stream, now: () => (calls++ === 0 ? 0 : 12_000) });
  line.update("parsing", 411, 1204, "src/graph/extract.ts");
  line.stop();
  const draw = chunks.find((c) => c.includes("parsing")) ?? "";
  assert.match(draw, /parsing 412\/1,204 files/);
  assert.match(draw, / · 12s · src\/graph\/extract\.ts$/);
});

test("stop erases the line, and a stopped line ignores further updates", () => {
  const { stream, chunks } = fakeStream();
  const line = startProgressLine({ stream, now: ticker(1000) });
  line.update("parsing", 0, 10, "a.ts");
  const drawn = chunks.length;
  line.stop();
  line.stop(); // idempotent
  line.update("parsing", 5, 10, "b.ts");
  assert.equal(chunks.length, drawn + 1, "one clear, nothing after it");
  assert.match(chunks[chunks.length - 1] ?? "", /^\r\x1b\[2K$/);
});

test("GRAFT_PROGRESS=1 keeps the line coming through a pipe, for a parent that reads it", () => {
  const { stream, chunks } = fakeStream({ isTTY: false });
  const before = process.env.GRAFT_PROGRESS;
  process.env.GRAFT_PROGRESS = "1";
  try {
    const line = startProgressLine({ stream, now: ticker(1000) });
    assert.equal(line.active, true);
    line.update("parsing", 1, 4, "a.ts");
    assert.ok(chunks.some((c) => c.includes("2/4 files")));
  } finally {
    if (before === undefined) delete process.env.GRAFT_PROGRESS;
    else process.env.GRAFT_PROGRESS = before;
  }
});

test("a long path is cut to the terminal width instead of wrapping", () => {
  const { stream, chunks } = fakeStream({ columns: 40 });
  // 1s elapsed, and the throttle never applies to the final item.
  const line = startProgressLine({ stream, now: () => 1_000 });
  line.update("parsing", 99, 100, `src/${"deep/".repeat(20)}file.ts`);
  line.stop();
  const draw = chunks.find((c) => c.includes("parsing")) ?? "";
  // Strip the \r\x1b[2K prefix before measuring.
  assert.ok(draw.replace(/^\r\x1b\[2K/, "").length <= 39, `wrapped: ${draw.length}`);
});
