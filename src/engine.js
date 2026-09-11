import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { spawn } from 'node:child_process';

export const emptyConfig = () => ({ version: 1, rules: [], enforcements: [], tools: [] });
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonempty = v => typeof v === 'string' && v.trim().length > 0;
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const keys = (v, allowed, label) => {
  assert(object(v), `${label} must be an object`);
  for (const k of Object.keys(v)) assert(allowed.includes(k), `${label}: unknown field ${k}`);
};
const id = /^[a-z][a-z0-9_-]*$/;
const strings = v => Array.isArray(v) && v.every(nonempty);
function command(c, label) {
  assert(strings(c) && c.length > 0, `${label}.command must be a nonempty argv array`);
}
function timeout(v, label) {
  assert(v === undefined || Number.isInteger(v) && v >= 1 && v <= 300000, `${label}.timeoutMs must be 1..300000`);
}
export function validateConfig(config) {
  keys(config, ['version', 'rules', 'enforcements', 'tools'], 'config');
  assert(config.version === 1, 'Unsupported config version (expected 1)');
  for (const collection of ['rules', 'enforcements', 'tools']) {
    assert(Array.isArray(config[collection]), `${collection} must be an array`);
    const seen = new Set();
    for (const item of config[collection]) {
      assert(object(item) && typeof item.id === 'string' && id.test(item.id), `${collection}: invalid id`);
      assert(!seen.has(item.id), `${collection}: duplicate id ${item.id}`);
      seen.add(item.id);
      assert(item.enabled === undefined || typeof item.enabled === 'boolean', `${item.id}: enabled must be boolean`);
    }
  }
  for (const r of config.rules) {
    keys(r, ['id', 'description', 'enabled'], `rule ${r.id}`);
    assert(nonempty(r.description), `${r.id}: description required`);
  }
  for (const e of config.enforcements) {
    keys(e, ['id', 'rule', 'tools', 'action', 'check', 'enabled'], `enforcement ${e.id}`);
    assert(config.rules.some(r => r.id === e.rule), `${e.id}: unknown rule ${e.rule}`);
    assert(strings(e.tools) && e.tools.length > 0, `${e.id}: tools must be a nonempty list of exact names or *`);
    assert(['warn', 'block'].includes(e.action), `${e.id}: action must be warn or block`);
    keys(e.check, ['kind', 'options', 'command', 'timeoutMs'], `${e.id}.check`);
    const c = e.check;
    assert(['deny', 'git-branch', 'git-push', 'command'].includes(c.kind), `${e.id}: unknown checker ${c.kind}`);
    if (c.kind === 'command') {
      assert(c.options === undefined, `${e.id}: command checker does not accept options`);
      command(c.command, e.id); timeout(c.timeoutMs, e.id);
    } else {
      assert(c.command === undefined && c.timeoutMs === undefined, `${e.id}: command fields require command checker`);
      if (c.kind === 'deny') keys(c.options ?? {}, [], e.id);
      if (c.kind === 'git-branch') {
        keys(c.options, ['protected'], `${e.id}.options`);
        assert(strings(c.options.protected) && c.options.protected.length > 0, `${e.id}: protected branches required`);
      }
      if (c.kind === 'git-push') {
        keys(c.options, ['protected', 'denyDeletes', 'sameBranch'], `${e.id}.options`);
        assert(c.options.protected === undefined || strings(c.options.protected), `${e.id}: protected must be a list of branch names`);
        assert(c.options.denyDeletes === undefined || typeof c.options.denyDeletes === 'boolean', `${e.id}: denyDeletes must be boolean`);
        assert(c.options.sameBranch === undefined || typeof c.options.sameBranch === 'boolean', `${e.id}: sameBranch must be boolean`);
        assert((c.options.protected?.length ?? 0) > 0 || c.options.denyDeletes === true || c.options.sameBranch === true, `${e.id}: git-push requires protected branches, denyDeletes, or sameBranch`);
      }
    }
  }
  for (const t of config.tools) {
    keys(t, ['id', 'description', 'command', 'timeoutMs', 'enabled'], `tool ${t.id}`);
    assert(nonempty(t.description), `${t.id}: description required`);
    command(t.command, t.id); timeout(t.timeoutMs, t.id);
  }
  return config;
}

// Nearest ancestor configuration wins, including from nested project directories.
export async function findProject(cwd) {
  let dir = resolve(cwd);
  while (true) {
    const file = resolve(dir, '.harness/config.json');
    try { await stat(file); return { root: dir, file }; }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
export async function loadProject(cwd) {
  const project = await findProject(cwd);
  return project ? { ...project, config: validateConfig(JSON.parse(await readFile(project.file, 'utf8'))) } : null;
}

// No shell interpolation. stdin carries structured data; stdout is bounded.
export function runCommand(argv, { cwd, input, timeoutMs = 10000, signal } = {}) {
  return new Promise((resolveResult, reject) => {
    if (signal?.aborted) return reject(new Error('Command aborted'));
    const child = spawn(argv[0], argv.slice(1), { cwd, stdio: ['pipe', 'pipe', 'pipe'], shell: false, detached: process.platform !== 'win32' });
    let stdout = '', bytes = 0, failure;
    const stop = message => {
      failure ??= new Error(message);
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch (e) { if (e.code !== 'ESRCH') child.kill('SIGKILL'); }
    };
    const timer = setTimeout(() => stop('Command timed out'), timeoutMs);
    const abort = () => stop('Command aborted');
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', data => {
      bytes += data.length;
      if (bytes > 65536) stop('Command output exceeded 64 KiB');
      else stdout += data.toString();
    });
    // Drain stderr, but never persist it or include it in model-visible errors.
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.on('error', error => { failure = new Error(`Command could not start: ${error.code ?? 'unknown error'}`); });
    child.on('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`Command exited with code ${code}`));
      else resolveResult(stdout);
    });
    child.stdin.end(input === undefined ? '' : JSON.stringify(input));
  });
}
export async function check(checker, event, project, signal) {
  try {
    if (checker.kind === 'deny') return { status: 'fail', reason: 'Tool is prohibited by this rule' };
    if (checker.kind === 'git-branch') {
      // Inspect the target file's repository for edit/write; use cwd for other tools.
      let cwd = event.cwd;
      if (['write', 'edit'].includes(event.toolName)) {
        assert(nonempty(event.input?.path), 'Missing target path');
        let target = resolve(cwd, event.input.path);
        while (true) {
          try { target = await realpath(target); break; }
          catch (e) {
            if (e.code !== 'ENOENT') throw e;
            const parent = dirname(target);
            if (parent === target) throw e;
            target = parent;
          }
        }
        cwd = (await stat(target)).isDirectory() ? target : dirname(target);
      }
      const branch = (await runCommand(['git', 'symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd, signal })).trim();
      assert(branch.length > 0, 'Cannot determine branch');
      return checker.options.protected.includes(branch)
        ? { status: 'fail', reason: `Protected branch: ${branch}` }
        : { status: 'pass', reason: `Feature branch: ${branch}` };
    }
    if (checker.kind === 'git-push') {
      assert(event.toolName === 'git:pre-push', 'git-push checker requires git:pre-push');
      assert(Array.isArray(event.input?.updates), 'Missing pre-push updates');
      const zero = sha => typeof sha === 'string' && /^0{40}(?:0{24})?$/.test(sha);
      for (const update of event.input.updates) {
        assert(object(update), 'Invalid pre-push update');
        for (const field of ['localRef', 'localSha', 'remoteRef', 'remoteSha']) assert(nonempty(update[field]), `Missing pre-push ${field}`);
        const branchName = update.remoteRef.startsWith('refs/heads/') ? update.remoteRef.slice(11) : null;
        if (branchName && (checker.options.protected ?? []).includes(branchName)) return { status: 'fail', reason: `Protected push destination: ${branchName}` };
        if (zero(update.localSha)) {
          if (checker.options.denyDeletes) return { status: 'fail', reason: `Branch deletion is prohibited: ${branchName ?? update.remoteRef}` };
          continue;
        }
        if (checker.options.sameBranch && branchName) {
          const localName = update.localRef.startsWith('refs/heads/') ? update.localRef.slice(11) : null;
          if (!localName || localName !== branchName) return { status: 'fail', reason: `Push branch names must match: ${update.localRef} → ${update.remoteRef}` };
        }
      }
      return { status: 'pass', reason: `${event.input.updates.length} push update(s) allowed` };
    }
    const result = JSON.parse(await runCommand(checker.command, {
      cwd: project.root, input: { version: 1, event, projectRoot: project.root }, timeoutMs: checker.timeoutMs, signal,
    }));
    keys(result, ['status', 'reason'], 'checker result');
    assert(['pass', 'fail', 'unknown'].includes(result.status) && nonempty(result.reason), 'Invalid checker result');
    return result;
  } catch (error) {
    return { status: 'unknown', reason: error.message };
  }
}
export async function evaluate(project, event, signal) {
  const results = [];
  for (const enforcement of project.config.enforcements) {
    const rule = project.config.rules.find(r => r.id === enforcement.rule);
    if (rule.enabled === false || enforcement.enabled === false) continue;
    if (!enforcement.tools.includes('*') && !enforcement.tools.includes(event.toolName)) continue;
    const result = await check(enforcement.check, event, project, signal);
    results.push({ enforcement: enforcement.id, rule: rule.id, action: enforcement.action, ...result });
  }
  return { blocked: results.some(r => r.action === 'block' && r.status !== 'pass'), results };
}
const enabled = item => Boolean(item) && item.enabled !== false;
export function projectCounts(project) {
  const count = items => ({ active: items.filter(enabled).length, total: items.length });
  const enabledRules = new Set((project?.config.rules ?? []).filter(enabled).map(rule => rule.id));
  const enforcements = project?.config.enforcements ?? [];
  return {
    rules: count(project?.config.rules ?? []),
    enforcements: { active: enforcements.filter(item => enabled(item) && enabledRules.has(item.rule)).length, total: enforcements.length },
    tools: count(project?.config.tools ?? []),
  };
}
export function describe(project) {
  if (!project) return 'Harness: no project configuration. Run /harness init.';
  const { config } = project;
  const lines = [`Harness: ${project.file}`];
  for (const rule of config.rules) {
    const links = config.enforcements.filter(e => e.rule === rule.id && e.enabled !== false);
    const mode = rule.enabled === false ? 'disabled' : links.length ? links.map(e => `${e.action} on ${e.tools.join(',')}`).join('; ') : 'advisory';
    lines.push(`${rule.id} [${mode}]: ${rule.description}`);
  }
  for (const tool of config.tools) lines.push(`tool harness_${tool.id}: ${tool.enabled === false ? 'disabled' : tool.description}`);
  return lines.join('\n');
}
export function describeDetailed(project) {
  if (!project) return 'Harness: no project configuration. Run /harness init.';
  const counts = projectCounts(project);
  const lines = [
    `Harness: ${project.file}`,
    `Rules ${counts.rules.active}/${counts.rules.total} active · Enforcements ${counts.enforcements.active}/${counts.enforcements.total} active · Tools ${counts.tools.active}/${counts.tools.total} active`,
    '',
    'Rules',
  ];
  if (!project.config.rules.length) lines.push('  (none)');
  for (const rule of project.config.rules) {
    lines.push(`  ${enabled(rule) ? '●' : '○'} ${rule.id}: ${rule.description}`);
  }
  lines.push('', 'Enforcements');
  if (!project.config.enforcements.length) lines.push('  (none)');
  for (const enforcement of project.config.enforcements) {
    const ruleEnabled = enabled(project.config.rules.find(rule => rule.id === enforcement.rule));
    const effective = enabled(enforcement) && ruleEnabled;
    const note = !ruleEnabled ? ' · rule disabled' : '';
    lines.push(`  ${effective ? '●' : '○'} ${enforcement.id} [${enforcement.action} · ${enforcement.check.kind} · ${enforcement.tools.join(', ')}${note}] → ${enforcement.rule}`);
  }
  lines.push('', 'Tools');
  if (!project.config.tools.length) lines.push('  (none)');
  for (const tool of project.config.tools) {
    lines.push(`  ${enabled(tool) ? '●' : '○'} harness_${tool.id}: ${tool.description}`);
  }
  return lines.join('\n');
}
