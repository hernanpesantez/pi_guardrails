import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand } from '../src/engine.js';
import { manage } from '../src/manage.js';
import { gitHookStatus, installGitHooks, uninstallGitHooks, evaluateGitHook } from '../src/git.js';

async function repository(t) {
  const root = await mkdtemp(join(tmpdir(), 'pi-harness-git-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await runCommand(['git', 'init', '-b', 'main'], { cwd: root });
  await manage(root, 'init');
  return root;
}

test('native hook install is visible, shared through core.hooksPath, and safely removable', async t => {
  const root = await repository(t);
  const installed = await installGitHooks(root);
  assert.equal(installed.installed, true);
  assert.equal((await gitHookStatus(root)).installed, true);
  assert.match(await manage(root, 'git status'), /installed/);
  const removed = await uninstallGitHooks(root);
  assert.equal(removed.installed, false);
  assert.equal((await gitHookStatus(root)).configuredPath, null);
});

test('native hook install refuses to replace another hook setup', async t => {
  const root = await repository(t);
  await runCommand(['git', 'config', '--local', 'core.hooksPath', '/tmp/another-hook-system'], { cwd: root });
  await assert.rejects(installGitHooks(root), /Existing core\.hooksPath/);

  await runCommand(['git', 'config', '--local', '--unset', 'core.hooksPath'], { cwd: root });
  const common = (await runCommand(['git', 'rev-parse', '--git-common-dir'], { cwd: root })).trim();
  await mkdir(join(root, common, 'hooks'), { recursive: true });
  await writeFile(join(root, common, 'hooks', 'pre-commit'), '#!/bin/sh\nexit 0\n');
  await assert.rejects(installGitHooks(root), /Existing pre-commit/);
});

test('git-push checker blocks protected destinations, deletes, and mismatched branch pushes', async t => {
  const root = await repository(t);
  const config = {
    version: 1,
    rules: [{ id: 'push-policy', description: 'Protect remote branches.' }],
    enforcements: [{
      id: 'push-guard', rule: 'push-policy', tools: ['git:pre-push'], action: 'block',
      check: { kind: 'git-push', options: { protected: ['main'], denyDeletes: true, sameBranch: true } },
    }],
    tools: [],
  };
  await writeFile(join(root, '.harness/config.json'), JSON.stringify(config));
  const sha = '1'.repeat(40); const old = '2'.repeat(40); const zero = '0'.repeat(40);
  const update = (localRef, localSha, remoteRef) => `${localRef} ${localSha} ${remoteRef} ${old}\n`;
  assert.equal((await evaluateGitHook(root, 'pre-push', [], update('refs/heads/feature', sha, 'refs/heads/main'))).blocked, true);
  assert.equal((await evaluateGitHook(root, 'pre-push', [], update('(delete)', zero, 'refs/heads/feature'))).blocked, true);
  assert.equal((await evaluateGitHook(root, 'pre-push', [], update('refs/heads/feature', sha, 'refs/heads/other'))).blocked, true);
  assert.equal((await evaluateGitHook(root, 'pre-push', [], update('refs/heads/feature', sha, 'refs/heads/feature'))).blocked, false);
});

test('pre-push checker input never receives the possibly credential-bearing remote location', async t => {
  const root = await repository(t);
  const checker = "let s='';for await(const c of process.stdin)s+=c;const x=JSON.parse(s);const safe=!Object.hasOwn(x.event.input,'remoteLocation');console.log(JSON.stringify({status:safe?'pass':'fail',reason:safe?'safe':'leaked'}))";
  const config = {
    version: 1,
    rules: [{ id: 'privacy', description: 'Do not forward remote credentials.' }],
    enforcements: [{
      id: 'privacy-guard', rule: 'privacy', tools: ['git:pre-push'], action: 'block',
      check: { kind: 'command', command: [process.execPath, '-e', checker] },
    }],
    tools: [],
  };
  await writeFile(join(root, '.harness/config.json'), JSON.stringify(config));
  assert.equal((await evaluateGitHook(root, 'pre-push', ['origin', 'https://credential@example.test/repo'], '')).blocked, false);
});

test('pre-commit hook uses the normal git-branch checker', async t => {
  const root = await repository(t);
  const config = {
    version: 1,
    rules: [{ id: 'branch-policy', description: 'Do not commit on main.' }],
    enforcements: [{
      id: 'commit-guard', rule: 'branch-policy', tools: ['git:pre-commit'], action: 'block',
      check: { kind: 'git-branch', options: { protected: ['main'] } },
    }],
    tools: [],
  };
  await writeFile(join(root, '.harness/config.json'), JSON.stringify(config));
  assert.equal((await evaluateGitHook(root, 'pre-commit', [], '')).blocked, true);
  await runCommand(['git', 'switch', '-c', 'feature'], { cwd: root });
  assert.equal((await evaluateGitHook(root, 'pre-commit', [], '')).blocked, false);
});

test('installed hooks block real commits and protected push refspecs', async t => {
  const root = await repository(t);
  const remote = await mkdtemp(join(tmpdir(), 'pi-harness-remote-'));
  t.after(() => rm(remote, { recursive: true, force: true }));
  await runCommand(['git', 'init', '--bare', remote], { cwd: root });
  await runCommand(['git', 'remote', 'add', 'origin', remote], { cwd: root });
  await runCommand(['git', 'config', 'user.name', 'Harness Test'], { cwd: root });
  await runCommand(['git', 'config', 'user.email', 'harness@example.test'], { cwd: root });
  const config = {
    version: 1,
    rules: [
      { id: 'commit-policy', description: 'Do not commit on main.' },
      { id: 'push-policy', description: 'Do not push main.' },
    ],
    enforcements: [
      { id: 'commit-guard', rule: 'commit-policy', tools: ['git:pre-commit'], action: 'block', check: { kind: 'git-branch', options: { protected: ['main'] } } },
      { id: 'push-guard', rule: 'push-policy', tools: ['git:pre-push'], action: 'block', check: { kind: 'git-push', options: { protected: ['main'] } } },
    ],
    tools: [],
  };
  await writeFile(join(root, '.harness/config.json'), JSON.stringify(config));
  await installGitHooks(root);
  await writeFile(join(root, 'example.txt'), 'content\n');
  await runCommand(['git', 'add', 'example.txt'], { cwd: root });
  await assert.rejects(runCommand(['git', 'commit', '-m', 'blocked'], { cwd: root }));
  await runCommand(['git', 'switch', '-c', 'feature'], { cwd: root });
  await runCommand(['git', 'commit', '-m', 'allowed'], { cwd: root });
  await runCommand(['git', 'push', '-u', 'origin', 'feature'], { cwd: root });
  await assert.rejects(runCommand(['git', 'push', 'origin', 'feature:main'], { cwd: root }));
});
