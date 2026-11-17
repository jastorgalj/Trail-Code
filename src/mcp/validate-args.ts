/**
 * Pure argument validator for MCP tools.
 * No imports from ./tools.ts (would create a circular dependency).
 * No module-level state (safe under a shared server process, design D8).
 */

/** Levenshtein distance (iterative, O(m*n) space). */
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (__, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[_-]/g, '');
}

/**
 * Hint table: for each tool, maps an unknown key name to the likely intended
 * property name. The spec lists exactly these pairs; no others.
 */
const ARG_HINTS: Record<string, Record<string, string>> = {
  trail_find_all: { query: 'pattern', regex: 'pattern', path: 'in', paths: 'in' },
  trail_find_code: { pattern: 'query', path: 'in', paths: 'in' },
  trail_search_semantic: { pattern: 'query', path: 'in', paths: 'in' },
  trail_trace_calls: { name: 'symbol', query: 'symbol', path: 'in', paths: 'in' },
  trail_file_api: { path: 'file', paths: 'file' },
  trail_set_scope: { paths: 'path' },
};

/**
 * Synonym map: a key not listed in the schema that is nonetheless accepted.
 * The key is treated as equivalent to the target for required-presence and type
 * checking, but it is NOT renamed in the args object (handlers read both).
 */
const ARG_SYNONYMS: Record<string, Record<string, string>> = {
  trail_trace_calls: { file: 'symbol' },
};

/**
 * Find the best hint for an unknown key, following rules 1-3 from the spec.
 * Does not propose a property that is already in the call (argKeys).
 */
function findHint(
  unknownKey: string,
  propNames: string[],
  toolHints: Record<string, string>,
  argKeys: Set<string>,
): string | null {
  const normKey = normalize(unknownKey);
  // Rule 1: normalized exact match
  for (const prop of propNames) {
    if (normalize(prop) === normKey && !argKeys.has(prop)) return prop;
  }
  // Rule 2: both normalized lengths >= 4, Levenshtein distance <= 2
  if (normKey.length >= 4) {
    for (const prop of propNames) {
      const normProp = normalize(prop);
      if (normProp.length >= 4 && levenshtein(normKey, normProp) <= 2 && !argKeys.has(prop)) {
        return prop;
      }
    }
  }
  // Rule 3: static hint table
  const hint = Object.hasOwn(toolHints, unknownKey) ? toolHints[unknownKey] : undefined;
  if (hint !== undefined && !argKeys.has(hint)) return hint;
  return null;
}

/**
 * Special value rule for `depth` in trail_trace_calls.
 * Returns an error message string when the value is invalid, or null when OK.
 * The schema does not declare type for depth (it accepts number or "all"),
 * so this rule lives here as a declared exception (design D1).
 */
function checkDepthRule(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return null;
  if (value === 'all' || value === 'full') return null;
  const display =
    typeof value === 'string'
      ? `"${String(value).slice(0, 40)}"`
      : typeof value;
  return `expected number or "all", got ${display}`;
}

/**
 * Validate `args` against the tool definition `def`.
 *
 * Returns `{ok: true, args}` when all checks pass, or `{ok: false, text}`
 * when any check fails. The function is pure: no side effects, no state.
 *
 * Checks performed (in this order, all in one pass):
 *   (a) unknown keys — not in properties and not a declared synonym
 *   (b) missing required keys
 *   (c) wrong-type values (string/number/boolean/enum), in properties order
 *
 * Message format: clauses joined with "; ". The first clause carries " for <tool>".
 * A "expected one of: ..." tail is appended when there are (a) or (b) clauses.
 */
export function validateToolArgs(
  def: { name: string; inputSchema: object },
  args: unknown,
): { ok: true; args: Record<string, unknown> } | { ok: false; text: string } {
  const name = def.name; // announced trail_* name

  // null/undefined is treated as an empty object (absent arguments)
  if (args === null || args === undefined) {
    args = {};
  }

  // args must be a plain object (not array, string, number, boolean)
  if (typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, text: `arguments for ${name} must be an object` };
  }

  const argsObj = args as Record<string, unknown>;
  const schema = def.inputSchema as {
    properties?: Record<string, { type?: string; enum?: string[] }>;
    required?: string[];
  };

  const properties = schema.properties ?? {};
  const required = schema.required ?? [];
  const propNames = Object.keys(properties);
  const synonyms = ARG_SYNONYMS[name] ?? {};
  const toolHints = ARG_HINTS[name] ?? {};

  // Keys present in the call (all keys of argsObj, regardless of value)
  const argKeys = new Set<string>(Object.keys(argsObj));

  // Keys with a non-null/undefined value — used for required-check
  const presentKeys = new Set<string>(
    [...argKeys].filter((k) => argsObj[k] !== null && argsObj[k] !== undefined),
  );
  // Synonyms satisfy their target's required entry
  for (const [syn, target] of Object.entries(synonyms)) {
    if (presentKeys.has(syn)) presentKeys.add(target);
  }

  // === (a) Unknown keys ===
  const unknownKeys: string[] = [];
  for (const key of argKeys) {
    if (Object.hasOwn(properties, key)) continue;
    if (Object.hasOwn(synonyms, key)) continue;
    unknownKeys.push(key);
  }

  // === (b) Missing required ===
  const missingRequired: string[] = [];
  for (const req of required) {
    if (!presentKeys.has(req)) missingRequired.push(req);
  }

  // === (c) Type errors (in schema properties order) ===
  const typeErrors: { key: string; msg: string }[] = [];

  for (const propName of propNames) {
    const val = argsObj[propName];
    if (val === null || val === undefined) continue; // absent → skip type check

    // Special rule for depth (trail_trace_calls only)
    if (name === 'trail_trace_calls' && propName === 'depth') {
      const msg = checkDepthRule(val);
      if (msg !== null) typeErrors.push({ key: propName, msg });
      continue;
    }

    const propSchema = properties[propName];
    const propType = propSchema?.type;
    const propEnum = propSchema?.enum;

    if (propEnum) {
      // Enum validation (only string enums today; e.g. direction: "in"|"out")
      if (typeof val === 'string') {
        const display = val.length > 40 ? val.slice(0, 40) : val;
        if (!propEnum.includes(val)) {
          typeErrors.push({
            key: propName,
            msg: `expected ${propEnum.map((v) => `"${v}"`).join(' or ')}, got "${display}"`,
          });
        }
      } else {
        typeErrors.push({
          key: propName,
          msg: `expected ${propEnum.map((v) => `"${v}"`).join(' or ')}, got ${typeof val}`,
        });
      }
      continue;
    }

    if (!propType) continue; // no declared type (e.g. depth schema has no type)

    if (propType === 'string' && typeof val !== 'string') {
      typeErrors.push({ key: propName, msg: `expected string, got ${typeof val}` });
    } else if (propType === 'number' && (typeof val !== 'number' || !Number.isFinite(val as number))) {
      typeErrors.push({ key: propName, msg: `expected number, got ${typeof val}` });
    } else if (propType === 'boolean' && typeof val !== 'boolean') {
      typeErrors.push({ key: propName, msg: `expected boolean, got ${typeof val}` });
    }
  }

  // Also validate synonym values using the target property's type
  for (const [syn, target] of Object.entries(synonyms)) {
    const val = argsObj[syn];
    if (val === null || val === undefined) continue;
    const propSchema = properties[target];
    if (!propSchema?.type) continue;
    if (propSchema.type === 'string' && typeof val !== 'string') {
      typeErrors.push({ key: syn, msg: `expected string, got ${typeof val}` });
    } else if (propSchema.type === 'number' && (typeof val !== 'number' || !Number.isFinite(val as number))) {
      typeErrors.push({ key: syn, msg: `expected number, got ${typeof val}` });
    } else if (propSchema.type === 'boolean' && typeof val !== 'boolean') {
      typeErrors.push({ key: syn, msg: `expected boolean, got ${typeof val}` });
    }
  }

  // === All checks passed ===
  if (unknownKeys.length === 0 && missingRequired.length === 0 && typeErrors.length === 0) {
    return { ok: true, args: argsObj };
  }

  // === Build rejection message ===
  const clauses: string[] = [];
  let isFirst = true;

  // (a) Unknown keys — may carry hint per key
  if (unknownKeys.length > 0) {
    const prefix = unknownKeys.length === 1 ? 'unknown argument' : 'unknown arguments';
    const keyParts = unknownKeys.map((k) => {
      const hint = findHint(k, propNames, toolHints, argKeys);
      return hint ? `"${k}" (did you mean "${hint}"?)` : `"${k}"`;
    });
    const clause = `${prefix} ${keyParts.join(', ')}`;
    clauses.push(isFirst ? `${clause} for ${name}` : clause);
    isFirst = false;
  }

  // (b) Missing required
  if (missingRequired.length > 0) {
    const prefix =
      missingRequired.length === 1 ? 'missing required argument' : 'missing required arguments';
    const clause = `${prefix} ${missingRequired.map((k) => `"${k}"`).join(', ')}`;
    clauses.push(isFirst ? `${clause} for ${name}` : clause);
    isFirst = false;
  }

  // (c) Type / value errors (in schema properties order)
  for (const { key, msg } of typeErrors) {
    const clause = `invalid argument "${key}"`;
    clauses.push(isFirst ? `${clause} for ${name}: ${msg}` : `${clause}: ${msg}`);
    isFirst = false;
  }

  // Tail: "expected one of: ..." only when there are (a) or (b) clauses
  if (unknownKeys.length > 0 || missingRequired.length > 0) {
    if (propNames.length > 0) {
      clauses.push(`expected one of: ${propNames.join(', ')}`);
    } else {
      clauses.push('expected no arguments');
    }
  }

  return { ok: false, text: clauses.join('; ') };
}
