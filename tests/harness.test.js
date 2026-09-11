import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyConfig, validateConfig, loadProject, evaluate, runCommand, describeDetailed } from '../src/engine.js';
import { manage, applyProposal } from '../src/manage.js';
import extension from '../extensions/harness.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pi-harness-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await manage(root, 'init');
  return root;
}
async function save(root, config) { await writeFile(join(root, '.harness/config.json'), JSON.stringify(config)); }
function policy(check = { kind: 'deny' }, action = 'block', tools = ['write']) {
  return { version: 1, rules: [{ id: 'policy', description: 'Test policy' }], enforcements: [{ id: 'guard', rule: 'policy', tools, action, check }], tools: [] };
}
const event = root => ({ toolName: 'write', input: { path: 'file.txt' }, cwd: root });

test('init is non-destructive; nearest ancestor discovered from nested directories', async t => {
  const root = await fixture(t);
  await mkdir(join(root, 'a/b'), { recursive: true });
  assert.equal((await loadProject(join(root, 'a/b'))).root, root);
  await save(root, policy());
  await manage(root, 'init');
  assert.equal((await loadProject(root)).config.rules.length, 1);
  await manage(join(root, 'a/b'), 'init --local');
  assert.equal((await loadProject(join(root, 'a/b'))).root, join(root, 'a/b'));
});
test('strict configuration rejects typos, dangling references, duplicate ids and invalid commands', () => {
  for (const mutate of [
    c => { c.versoin = 1; }, c => { c.rules.push(c.rules[0]); },
    c => { c.enforcements[0].rule = 'missing'; }, c => { c.enforcements[0].action = 'allow'; },
    c => { c.enforcements[0].check = { kind: 'command', command: 'echo yes' }; },
    c => { c.enforcements[0].check = { kind: 'command', command: ['node'], timeoutMs: 0 }; },
  ]) { const c = policy(); mutate(c); assert.throws(() => validateConfig(c)); }
});
test('rule management adds, toggles, and rejects duplicates without corrupting config', async t => {
  const root = await fixture(t);
  await manage(root, 'rule add tests Run tests before completion.');
  assert.match(await manage(root, 'status'), /advisory/);
  await assert.rejects(manage(root, 'rule add tests Duplicate'));
  await manage(root, 'disable rule tests');
  assert.match(await manage(root, 'doctor'), /disabled/);
  await manage(root, 'enable rule tests');
  const file = join(root, 'guard.json');
  await writeFile(file, JSON.stringify({ id: 'guard', rule: 'tests', tools: ['bash'], action: 'block', check: { kind: 'deny' } }));
  await manage(root, `enforcement add ${file}`);
  assert.match(await manage(root, 'check bash {}'), /"blocked": true/);
});
test('policy proposals are validated and applied atomically', async t => {
  const root = await fixture(t);
  await applyProposal(root, {
    rules: [{ id: 'branch-policy', description: 'Use a feature branch.' }],
    enforcements: [{
      id: 'branch-guard', rule: 'branch-policy', tools: ['write', 'edit'], action: 'block',
      check: { kind: 'git-branch', options: { protected: ['main'] } },
    }],
    tools: [],
  });
  const before = await readFile(join(root, '.harness/config.json'), 'utf8');
  assert.match(describeDetailed(await loadProject(root)), /Rules 1\/1 active/);
  assert.match(describeDetailed(await loadProject(root)), /branch-guard \[block · git-branch · write, edit\]/);
  await assert.rejects(applyProposal(root, {
    rules: [{ id: 'branch-policy', description: 'Duplicate.' }], enforcements: [], tools: [],
  }), /duplicate id branch-policy/);
  assert.equal(await readFile(join(root, '.harness/config.json'), 'utf8'), before);
});
test('detailed status reports enforcement as inactive when its parent rule is disabled', async t => {
  const root = await fixture(t);
  const config = policy(); config.rules[0].enabled = false;
  await save(root, config);
  const status = describeDetailed(await loadProject(root));
  assert.match(status, /Enforcements 0\/1 active/);
  assert.match(status, /○ guard .*rule disabled/);
});
test('blocking, warning, tool selection, disabled enforcement and advisory behavior', async () => {
  const project = { root: '/tmp', config: policy() };
  assert.equal((await evaluate(project, event('/tmp'))).blocked, true);
  assert.equal((await evaluate(project, { ...event('/tmp'), toolName: 'read' })).blocked, false);
  project.config.enforcements[0].action = 'warn';
  assert.equal((await evaluate(project, event('/tmp'))).results[0].status, 'fail');
  assert.equal((await evaluate(project, event('/tmp'))).blocked, false);
  project.config.enforcements[0].enabled = false;
  assert.deepEqual((await evaluate(project, event('/tmp'))).results, []);
  project.config.enforcements[0].enabled = true;
  project.config.rules[0].enabled = false;
  assert.deepEqual((await evaluate(project, event('/tmp'))).results, []);
});
test('custom command protocol passes structured input without shell evaluation', async t => {
  const root = await fixture(t);
  const code = `let s='';for await(const c of process.stdin)s+=c;const x=JSON.parse(s);console.log(JSON.stringify({status:x.event.input.path==='$(touch nope)'?'pass':'fail',reason:'checked'}))`;
  const project = { root, config: policy({ kind: 'command', command: [process.execPath, '-e', code] }) };
  assert.equal((await evaluate(project, { ...event(root), input: { path: '$(touch nope)' } })).results[0].status, 'pass');
  await assert.rejects(readFile(join(root, 'nope')));
});
test('checker failures, invalid results, timeout and oversized output fail closed', async t => {
  const root = await fixture(t);
  for (const code of ["process.exit(2)", "console.log('not json')", "console.log('{}')", "setInterval(()=>{},1000)", "console.log('x'.repeat(70000))"]) {
    const p = { root, config: policy({ kind: 'command', command: [process.execPath, '-e', code], timeoutMs: 150 }) };
    const result = await evaluate(p, event(root));
    assert.equal(result.blocked, true); assert.equal(result.results[0].status, 'unknown');
  }
  await assert.rejects(runCommand(['definitely-not-a-real-executable'], { cwd: root }));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runCommand([process.execPath], { cwd: root, signal: controller.signal }), /aborted/);
});
test('git check follows target repository and symlinks; detached/non-git state is unknown', async t => {
  const root = await fixture(t);
  const git = args => runCommand(['git', ...args], { cwd: root });
  await git(['init', '-b', 'main']);
  const p = { root, config: policy({ kind: 'git-branch', options: { protected: ['main'] } }) };
  assert.equal((await evaluate(p, event(root))).blocked, true);
  await git(['checkout', '-b', 'feature']);
  assert.equal((await evaluate(p, event(root))).blocked, false);
  const other = await fixture(t);
  await runCommand(['git', 'init', '-b', 'main'], { cwd: other });
  await symlink(other, join(root, 'linked'));
  assert.equal((await evaluate(p, { ...event(root), input: { path: 'linked/new.txt' } })).blocked, true);
  const nonGit = await fixture(t);
  assert.equal((await evaluate(p, event(nonGit))).results[0].status, 'unknown');
  await git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'test']);
  await git(['checkout', '--detach']);
  assert.equal((await evaluate(p, event(root))).results[0].status, 'unknown');
});
function fakePi() {
  const events = {}, tools = new Map(), commands = {}, entries = [], messages = [];
  let activeTools = new Set(['read', 'write', 'edit', 'bash']);
  return { events, tools, commands, entries, messages,
    on: (name, cb) => { events[name] = cb; }, registerTool: tool => { tools.set(tool.name, tool); activeTools.add(tool.name); },
    registerCommand: (name, value) => { commands[name] = value; }, getAllTools: () => [...tools.values()],
    getActiveTools: () => [...activeTools], setActiveTools: names => { activeTools = new Set(names); },
    appendEntry: (...args) => entries.push(args), sendMessage: message => messages.push(message),
    sendUserMessage: message => messages.push({ user: message }),
  };
}
function context(root, ui = {}) {
  return {
    cwd: root, mode: 'tui', hasUI: true,
    ui: { setStatus() {}, notify() {}, select: async () => undefined, confirm: async () => true, ...ui },
  };
}
test('Pi adapter blocks mutations, injects rules, audits without arguments, fails closed on broken/deleted config', async t => {
  const root = await fixture(t); await save(root, policy());
  const pi = fakePi(); extension(pi); const ctx = context(root);
  await pi.events.session_start({}, ctx);
  assert.match((await pi.events.before_agent_start({ systemPrompt: 'base' }, ctx)).systemPrompt, /Test policy/);
  assert.equal((await pi.events.tool_call({ toolName: 'write', input: { path: 'private-value' } }, ctx)).block, true);
  assert.doesNotMatch(JSON.stringify(pi.entries), /private-value/);
  await writeFile(join(root, '.harness/config.json'), '{broken');
  assert.equal((await pi.events.tool_call({ toolName: 'read', input: {} }, ctx)).block, true);
  await rm(join(root, '.harness/config.json'));
  assert.equal((await pi.events.tool_call({ toolName: 'read', input: {} }, ctx)).block, true);
});
test('Pi command adds executable tools dynamically; disabled and removed tools cannot execute', async t => {
  const root = await fixture(t); const pi = fakePi(); extension(pi); const ctx = context(root);
  await pi.events.session_start({}, ctx);
  const definition = { id: 'echo', description: 'Echo structured input', command: [process.execPath, '-e', 'process.stdin.pipe(process.stdout)'] };
  await writeFile(join(root, 'tool.json'), JSON.stringify(definition));
  await pi.commands.harness.handler('tool add tool.json', ctx);
  const tool = pi.tools.get('harness_echo'); assert.ok(tool);
  const response = await tool.execute('id', { payload: { hello: 'world' } }, undefined, undefined, ctx);
  assert.equal(JSON.parse(response.content[0].text).payload.hello, 'world');
  await manage(root, 'disable tool echo');
  assert.equal((await tool.execute('id', { payload: {} }, undefined, undefined, ctx)).isError, true);
});
test('Pi dashboard toggles configured entries and disabled tools leave the active tool set', async t => {
  const root = await fixture(t);
  await save(root, {
    version: 1,
    rules: [{ id: 'policy', description: 'Test policy' }],
    enforcements: [{ id: 'guard', rule: 'policy', tools: ['write'], action: 'block', check: { kind: 'deny' } }],
    tools: [{ id: 'echo', description: 'Echo', command: [process.execPath, '-e', 'process.stdin.pipe(process.stdout)'] }],
  });
  const choices = ['Tools · 1/1 active', 'Disable harness_echo', 'Close'];
  const pi = fakePi(); extension(pi);
  const ctx = context(root, { select: async () => choices.shift() });
  await pi.events.session_start({}, ctx);
  assert.ok(pi.getActiveTools().includes('harness_echo'));
  await pi.commands.harness.handler('', ctx);
  assert.equal((await loadProject(root)).config.tools[0].enabled, false);
  assert.ok(!pi.getActiveTools().includes('harness_echo'));
});
test('self-add asks the agent for a proposal and applies it only after TUI confirmation', async t => {
  const root = await fixture(t);
  const pi = fakePi(); extension(pi); const ctx = context(root);
  await pi.events.session_start({}, ctx);
  await pi.commands.harness.handler('self-add Block writes on main', ctx);
  const request = pi.messages.find(message => message.user)?.user;
  assert.match(request, /Block writes on main/);
  assert.match(request, /harness_policy_propose/);
  assert.ok(pi.getActiveTools().includes('pi_harness_policy_propose'));
  const requestId = /Request ID: ([a-f0-9-]+)/.exec(request)[1];
  const result = await pi.tools.get('pi_harness_policy_propose').execute('id', {
    requestId,
    proposal: {
      rules: [{ id: 'main-writes', description: 'Do not write on main.' }],
      enforcements: [{
        id: 'main-write-guard', rule: 'main-writes', tools: ['write', 'edit'], action: 'block',
        check: { kind: 'git-branch', options: { protected: ['main'] } },
      }],
      tools: [],
    },
  }, undefined, undefined, ctx);
  assert.equal(result.isError, undefined);
  assert.equal((await loadProject(root)).config.rules[0].id, 'main-writes');
  assert.ok(!pi.getActiveTools().includes('pi_harness_policy_propose'));
  assert.equal(pi.entries.at(-1)[0], 'harness:policy-change');
});
test('self-add rejects an invalid merged proposal before asking for confirmation', async t => {
  const root = await fixture(t); let confirmations = 0;
  await manage(root, 'rule add existing Existing rule.');
  const before = await readFile(join(root, '.harness/config.json'), 'utf8');
  const pi = fakePi(); extension(pi);
  const ctx = context(root, { confirm: async () => { confirmations += 1; return true; } });
  await pi.events.session_start({}, ctx);
  await pi.commands.harness.handler('self-add Add another rule', ctx);
  const request = pi.messages.find(message => message.user).user;
  const requestId = /Request ID: ([a-f0-9-]+)/.exec(request)[1];
  const result = await pi.tools.get('pi_harness_policy_propose').execute('id', {
    requestId,
    proposal: { rules: [{ id: 'existing', description: 'Duplicate.' }], enforcements: [], tools: [] },
  }, undefined, undefined, ctx);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /duplicate id existing/);
  assert.equal(confirmations, 0);
  assert.equal(await readFile(join(root, '.harness/config.json'), 'utf8'), before);
});
