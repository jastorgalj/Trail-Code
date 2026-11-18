/**
 * Shared "tokens saved" estimate for every retrieval-style graft command.
 *
 * The model is always the same: baseline (what you'd have read otherwise, in
 * full) − this output (what graft handed you). The baseline is measured from
 * the `chars` the build stored on each file node, so it costs nothing and is
 * honest about the alternative — opening the files whole. When no file in the
 * baseline has a known size (a pre-`chars` graph), the estimate is omitted
 * rather than faked.
 *
 * `graft ask` keeps its own footer (it carries an escalation nudge); everything
 * else — skeleton, grep, callers, map — routes through {@link savingsFor} +
 * {@link withSavings} here.
 */
import type { GraphV1 } from '../graph/types.js';
import { formatDollars } from './price.js';
import { brand, tag } from "../brand.js";

export interface Savings {
  /** How many source files the baseline covers. */
  files: number;
  /** Total chars of those files — the "read them whole" cost. */
  baselineChars: number;
}

/** Rough tokens for a byte length (≈ 4 chars/token; good enough for an estimate). */
export function toTokens(chars: number): number {
  return Math.round(chars / 4);
}

/** path → char size, from the file nodes the build sized. Skips nodes with no
 * `chars` (pre-upgrade graphs), so an old index just yields a smaller baseline
 * rather than a wrong one. */
function fileSizes(graph: GraphV1): Map<string, number> {
  const m = new Map<string, number>();
  for (const n of graph.nodes)
    if (n.kind === 'file' && typeof n.chars === 'number') m.set(n.path, n.chars);
  return m;
}

/** Baseline = whole size of the distinct `paths`, summed from file-node sizes.
 * Returns undefined when not a single path has a known size — the caller then
 * omits the estimate instead of claiming a bogus one. */
export function savingsFor(graph: GraphV1, paths: Iterable<string>): Savings | undefined {
  const sizes = fileSizes(graph);
  let baselineChars = 0;
  let files = 0;
  for (const p of new Set(paths)) {
    const c = sizes.get(p);
    if (c === undefined) continue;
    baselineChars += c;
    files++;
  }
  return files > 0 ? { files, baselineChars } : undefined;
}

/**
 * The blended input rate this session is paying, in $/Mtok, or null when nobody
 * has measured one.
 *
 * Process-level because it is a process-level fact: one CLI invocation answers
 * one query for one session, and the alternative — threading a rate through
 * `withSavings` and all seven of its callers — would put a billing parameter in
 * the signature of every retrieval formatter for no gain. Set by the CLI's
 * `noteQuery` and by the MCP dispatch, both of which already resolve the repo
 * root; unset everywhere else, which is why every consumer treats null as
 * "report tokens only" rather than as zero.
 */
let inputRateUsdPerMtok: number | null = null;

/** Tell this module what an input token costs here. Null clears it, and so does
 * anything that isn't a positive finite number — a NaN from a zero-denominator
 * rate must render as "no dollars known", never as `$NaN` in the agent's face. */
export function setInputRate(usdPerMtok: number | null): void {
  inputRateUsdPerMtok =
    typeof usdPerMtok === 'number' && Number.isFinite(usdPerMtok) && usdPerMtok > 0
      ? usdPerMtok
      : null;
}

/** Returns the dollar-value suffix for a savings line
 * (` worth ≈ $X.XX at this session's input rate`), or `""` when no rate is
 * known or the saving is zero. Used by both {@link savingsLine} and `ask.ts`'s
 * `askSavingsLine` so the two lines share identical phrasing. */
export function savingsDollarSuffix(savedTokens: number): string {
  if (inputRateUsdPerMtok === null || savedTokens <= 0) return '';
  const usd = (savedTokens * inputRateUsdPerMtok) / 1_000_000;
  return ` worth ≈ ${formatDollars(usd)} at this session's input rate`;
}

/** The one-line savings estimate for a command's text output, so the agent gets
 * the number for free — no extra tool call. `body` is the exact rendered output
 * the agent reads (the pack). Returns "" when there's nothing honest to claim:
 * no baseline, or the output isn't actually smaller than reading the files
 * (tiny files, where the pointers cost more than the source).
 *
 * Uses `"en-US"` explicitly so the comma separator is stable regardless of the
 * system locale — `sumSavingsFooters` relies on `[\d,]+` to parse the number
 * back, and a locale-dependent dot separator would silently truncate it. */
export function savingsLine(body: string, saved: Savings | undefined): string {
  if (!saved || saved.baselineChars <= 0) return '';
  const pack = toTokens(body.length);
  const base = toTokens(saved.baselineChars);
  if (base <= pack) return '';
  const delta = base - pack;
  const pct = Math.round((delta / base) * 100);
  return (
    `${tag()} tokens saved ≈ ${delta.toLocaleString('en-US')} (${pct}%) — this output ≈ ` +
    `${pack.toLocaleString('en-US')} tok vs reading the ${saved.files} file(s) it covers whole ≈ ` +
    `${base.toLocaleString('en-US')} tok (estimate).` +
    savingsDollarSuffix(delta)
  );
}

/**
 * Sum every `[graft] tokens saved ≈ N` footer in a blob of text — the reader
 * half of {@link savingsLine}, kept next to the writer so the two never drift.
 * A single blob can carry several (an agent that made two graft calls in one
 * turn).
 */
export function sumSavingsFooters(text: string): number {
  let total = 0;
  // The code a query saved reading, and the digging a reused learning saved.
  for (const m of text.matchAll(/\[(?:graft|trail)\] (?:tokens|learnings) saved ≈ ([\d,]+)/g)) {
    total += Number(m[1].replace(/,/g, '')) || 0;
  }
  return total;
}

/** Render `body` with the savings line on TOP.
 *
 * Deliberately a header, not a footer: agents routinely pipe graft through
 * `head -N` (and hosts truncate long tool output from the end), which silently
 * ate the number and, with it, the PostToolUse accumulator that feeds the
 * statusline's `~N tok saved`. Every clipper keeps the head, so the number
 * survives. Emitted once — a second copy at the bottom would be double-counted
 * by that accumulator's `matchAll`. */
export function withSavings(body: string, saved: Savings | undefined): string {
  const line = savingsLine(body, saved);
  return line ? `${line}\n\n${body}` : body;
}
