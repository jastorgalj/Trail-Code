import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { runCli, tmpRepo } from './helpers.js';

// Under trail, which is the name the skills are for: the graft path keeps its
// old output byte for byte.
process.env.TRAIL_INVOKED_AS = 'trail';

function fresh(): string { return tmpRepo('initskill'); }

/** Run `init` with a scratch home (never the runner's) and return its stderr. */
function init(repo: string, home: string, extra: string[] = []): string {
  const res = runCli(['init', repo, '--no-build', ...extra], { home });
  assert.equal(res.status, 0, res.describe());
  return res.stderr ?? '';
}

test('init reports every skill with its path and state, plus one summary line', () => {
  const home = fresh(); const repo = fresh();
  const claudeSkill = join(home, '.claude', 'skills', 'trail', 'SKILL.md');
  const hermesSkill = join(home, '.hermes', 'skills', 'trail', 'SKILL.md');

  const first = init(repo, home, ['--all-agents']);
  // The same shape as every other written file: agent, path, state. Claude's
  // used to be a bare "✓ wrote <path>", which read as a rewrite on every run.
  assert.ok(first.includes(`✓ claude: ${claudeSkill} (created)`), first);
  assert.ok(first.includes(`✓ hermes: ${hermesSkill} (created)`), first);
  // …and one line a script can grep for the whole run.
  assert.ok(first.includes('· skills: claude, hermes (2 written)'), first);

  // A re-run changes nothing, and says so instead of printing "wrote" again.
  const second = init(repo, home, ['--all-agents']);
  assert.ok(second.includes(`✓ claude: ${claudeSkill} (unchanged)`), second);
  assert.ok(second.includes(`✓ hermes: ${hermesSkill} (unchanged)`), second);
  assert.ok(second.includes('· skills: claude, hermes (0 written, 2 unchanged)'), second);
});

test('init names only the agents it was given, and no skill of the other', () => {
  const home = fresh(); const repo = fresh();
  const out = init(repo, home, ['--agents', 'hermes']);
  assert.ok(out.includes(join('.hermes', 'skills', 'trail', 'SKILL.md')), out);
  assert.ok(!out.includes(join('.claude', 'skills')), out);
  assert.ok(out.includes('· skills: hermes (1 written)'), out);
});

test('--no-global reports the skills as skipped instead of staying silent', () => {
  const home = fresh(); const repo = fresh();
  const out = init(repo, home, ['--all-agents', '--no-global']);
  assert.ok(out.includes('· skills: skipped (--no-global)'), out);
  assert.ok(!out.includes(join('.hermes', 'skills')), out);
  assert.ok(!out.includes(join('.claude', 'skills')), out);
});
