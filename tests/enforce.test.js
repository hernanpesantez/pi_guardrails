import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const entry = resolve('bin/pi-harness-enforce.js');
async function project(t, action) {
  const root = await mkdtemp(join(tmpdir(), 'pi-harness-enforce-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.harness'));
  await writeFile(join(root, '.harness/config.json'), JSON.stringify({
    version: 1,
    rules: [{ id: 'remote-policy', description: 'Remote policy.' }],
    enforcements: [{ id: 'remote-guard', rule: 'remote-policy', tools: ['github:pull-request'], action, check: { kind: 'deny' } }],
    tools: [],
  }));
  return root;
}

test('standalone enforcement exits nonzero for a blocked GitHub event', async t => {
  const root = await project(t, 'block');
  const result = spawnSync(process.execPath, [entry, 'github:pull-request', '{"baseRef":"main"}'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /remote-policy/);
});

test('standalone enforcement reports warnings without failing the check', async t => {
  const root = await project(t, 'warn');
  const result = spawnSync(process.execPath, [entry, 'github:pull-request', '{}'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stderr, /Harness warn/);
});

test('standalone enforcement fails closed when no policy matches the event', async t => {
  const root = await project(t, 'block');
  const result = spawnSync(process.execPath, [entry, 'github:push', '{}'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No enabled enforcement matched github:push/);
});
