import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { manage } from '../src/manage.js';

const piDir = process.env.PI_HARNESS_PI_DIR;
test('real Pi loader registers commands/tools and accepts the tool JSON schema', { skip: !piDir }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-harness-pi-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await manage(root, 'init');
  await writeFile(join(root, '.harness/config.json'), JSON.stringify({ version: 1,
    rules: [{ id: 'no-read', description: 'Do not read files' }],
    enforcements: [{ id: 'guard', rule: 'no-read', tools: ['read'], action: 'block', check: { kind: 'deny' } }],
    tools: [{ id: 'echo', description: 'Echo payload', command: [process.execPath, '-e', 'process.stdin.pipe(process.stdout)'] }],
  }));
  const { loadExtensions } = await import(pathToFileURL(resolve(piDir, 'dist/core/extensions/loader.js')));
  const { validateToolArguments } = await import(pathToFileURL(resolve(piDir, 'node_modules/@earendil-works/pi-ai/dist/utils/validation.js')));
  const loaded = await loadExtensions([resolve('extensions/harness.js')], root);
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  const ext = loaded.extensions[0];
  assert.ok(ext.commands.has('harness'));
  loaded.runtime.getAllTools = () => [...ext.tools.values()].map(t => t.definition);
  loaded.runtime.appendEntry = () => {};
  const errors = [];
  const ctx = { cwd: root, ui: { setStatus() {}, notify(message, level) { if (level === 'error') errors.push(message); } } };
  for (const handler of ext.handlers.get('session_start')) await handler({ type: 'session_start' }, ctx);
  assert.deepEqual(errors, []);
  const tool = ext.tools.get('harness_echo').definition;
  const valid = { payload: { hello: 'world' } };
  assert.deepEqual(validateToolArguments(tool, { name: tool.name, arguments: valid }), valid);
  assert.throws(() => validateToolArguments(tool, { name: tool.name, arguments: {} }));
  for (const handler of ext.handlers.get('tool_call')) {
    assert.equal((await handler({ type: 'tool_call', toolName: 'read', input: { path: 'file' } }, ctx)).block, true);
  }
  const output = await tool.execute('id', valid, undefined, undefined, ctx);
  assert.equal(JSON.parse(output.content[0].text).payload.hello, 'world');
});
