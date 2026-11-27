/**
 * Edit-distance utilities — no external dependencies.
 */

/**
 * Levenshtein edit distance between two strings (classical O(n·m) two-row DP,
 * exact). Lower is more similar; 0 means identical.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const sub = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + sub);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j]!;
  }
  return prev[b.length]!;
}

/**
 * Returns up to `n` items from `pool` nearest to `query` by Levenshtein
 * distance, sorted ascending by distance then alphabetically for ties.
 */
export function topSuggestions(query: string, pool: readonly string[], n = 3): string[] {
  return [...pool]
    .map((s) => ({ s, d: levenshtein(query, s) }))
    .sort((a, b) => a.d - b.d || a.s.localeCompare(b.s))
    .slice(0, n)
    .map(({ s }) => s);
}
