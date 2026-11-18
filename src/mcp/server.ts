/**
 * Minimal MCP stdio server: newline-delimited JSON-RPC 2.0.
 * stdout carries protocol messages ONLY; diagnostics go to stderr.
 * Cloud/workspace connector removed (trail-solo-grafo change).
 */
import { createInterface } from 'node:readline';
import { TOOLS, callTool, findTool } from './tools.js';
import { mcpInstructions } from './instructions.js';
import { hasGraftIndex } from '../graph/root.js';
import { mainWorktreeRoot } from '../graph/seed.js';
import { runUpkeep } from '../upkeep-run.js';
import { runningVersion } from '../upkeep.js';
import { maybeFlushInBackground, track } from '../telemetry/index.js';
import { brand, inBrand } from '../brand.js';
import { canonicalToolName, GRAFT_MCP_TOOL_NAMES } from './tool-names.js';
import { validateToolArgs } from './validate-args.js';

const TOOL_COMMAND: Record<string, string> = {
  graft_find_code: 'ask',
  graft_find_all: 'grep',
  graft_trace_calls: 'callers',
  graft_file_api: 'skeleton',
  graft_repo_map: 'map',
  graft_check_freshness: 'check',
};

function isRepoTool(name: string): boolean {
  return GRAFT_MCP_TOOL_NAMES.has(name.toLowerCase()) || GRAFT_MCP_TOOL_NAMES.has(canonicalToolName(name).toLowerCase());
}

function send(msg: object): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}
function reply(id: unknown, result: object): void { send({ jsonrpc: '2.0', id, result }); }
function replyError(id: unknown, code: number, message: string): void { send({ jsonrpc: '2.0', id, error: { code, message } }); }

function advertised(root: string, dirOverride?: string): typeof TOOLS {
  if (dirOverride !== undefined) return TOOLS;
  if (hasGraftIndex(root)) return TOOLS;
  const main = mainWorktreeRoot(root);
  return main && hasGraftIndex(main) ? TOOLS : [];
}

export function startMcpServer(root: string, dirOverride?: string, version = '0', opts: { brainsOnly?: boolean } = {}): void {
  const brainsOnly = opts.brainsOnly === true;
  const upkeep = brainsOnly ? [] : runUpkeep(root, runningVersion()).lines;
  for (const line of upkeep) console.error(line);
  if (!brainsOnly) maybeFlushInBackground();

  const repoTools = () =>
    (brainsOnly ? [] : advertised(root, dirOverride)).map((t) => ({ name: inBrand(t.name), description: inBrand(t.description), inputSchema: t.inputSchema }));

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    let msg: { id?: unknown; method?: string; params?: Record<string, any> };
    try { msg = JSON.parse(text); } catch { replyError(null, -32700, 'parse error'); return; }
    const { id, method, params } = msg;
    const isNotification = id === undefined;
    switch (method) {
      case 'initialize': {
        // No per-session state: behind a stateless proxy every client's
        // `initialize` reaches the same process, which cannot tell them apart,
        // so a client's `roots` must not become another client's query scope (#20).
        const local = [upkeep.length ? upkeep.join('\n') : '', brainsOnly ? '' : mcpInstructions()];
        reply(id, { protocolVersion: params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: brand(), version }, instructions: local.filter(Boolean).join('\n\n') });
        return;
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return;
      case 'ping':
        if (!isNotification) reply(id, {});
        return;
      case 'tools/list':
        if (isNotification) return;
        reply(id, { tools: repoTools() });
        return;
      case 'prompts/list':
        if (isNotification) return;
        reply(id, { prompts: [] });
        return;
      case 'prompts/get':
        if (isNotification) return;
        replyError(id, -32601, 'no prompts available');
        return;
      case 'tools/call': {
        if (isNotification) return;
        const name = String(params?.name ?? '');
        const args = (params?.arguments ?? {}) as Record<string, unknown>;
        if (brainsOnly && !isRepoTool(name)) {
          reply(id, { content: [{ type: 'text', text: `this server answers local graph tools only; ${name} isn't one` }], isError: true });
          return;
        }
        if (canonicalToolName(name) === 'graft_set_scope') {
          const def = findTool(name);
          if (def) {
            const validation = validateToolArgs(def, args);
            if (!validation.ok) {
              reply(id, { content: [{ type: 'text', text: validation.text }], isError: true });
              return;
            }
          }
          const scope = resolveScope(root, args['path']);
          reply(id, { content: [{ type: 'text', text: scope.text }], isError: !scope.ok });
          return;
        }
        const def = findTool(name);
        callTool(root, name, args, dirOverride).then(
          (r) => {
            const canonical = canonicalToolName(name);
            const command = Object.hasOwn(TOOL_COMMAND, canonical) ? TOOL_COMMAND[canonical] : undefined;
            track('query', { command, surface: 'mcp' }, { repo: root, host: 'mcp' });
            reply(id, { content: [{ type: 'text', text: r.text }], isError: r.isError });
          },
          (err) => replyError(id, -32603, err instanceof Error ? err.message : String(err)),
        );
        return;
      }
      default:
        if (!isNotification) replyError(id, -32601, `method not found: ${method}`);
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

/**
 * Resolve `path` into the `in` value the caller must pass on each query.
 *
 * Deliberately stateless: the server may be one process behind a stateless
 * stdio→HTTP proxy shared by several agents, and nothing in the JSON-RPC stream
 * identifies the client. Any stored scope would leak across clients, so
 * `trail_set_scope` only computes the value and hands it back (#20).
 */
function resolveScope(serverRoot: string, pathArg: unknown): { text: string; ok: boolean } {
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const srv = norm(String(serverRoot));
  const p = norm(String(pathArg ?? ''));
  const suffix = 'this server keeps no per-session scope, so the value must travel in each call';
  if (p === srv || p === '') {
    return { ok: true, text: `scope: whole workspace — omit "in" on every call (${suffix})` };
  }
  if (!p.startsWith(srv + '/')) {
    return { ok: false, text: `path "${p}" is not under the server workspace "${srv}" — no scope resolved` };
  }
  const rel = p.slice(srv.length + 1);
  return { ok: true, text: `scope: ${rel} — pass in: "${rel}" on each call you want narrowed to it (${suffix})` };
}
