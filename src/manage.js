import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { emptyConfig, findProject, loadProject, validateConfig, describe } from './engine.js';

export const help = `Harness commands:
  init
  status | doctor
  rule add <id> <description>
  enforcement add <path-to-definition.json>
  tool add <path-to-definition.json>
  enable|disable rule|enforcement|tool <id>
  check <tool-name> <JSON-input>

Checks are dry runs of enforcement; custom checker programs still execute.
Definitions are JSON. Changes take effect on the next tool call.
New tools register immediately via /harness; use /harness reload after external edits.`;
const collections = { rule: 'rules', enforcement: 'enforcements', tool: 'tools' };
async function update(file, transform) {
  // Exclusion lock prevents lost updates between harness commands. External editors
  // should not write concurrently. Never overwrite a config from a stale snapshot.
  const lock = `${file}.lock`;
  const handle = await import('node:fs/promises').then(fs => fs.open(lock, 'wx'));
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const config = validateConfig(JSON.parse(await readFile(file, 'utf8')));
    transform(config); validateConfig(config);
    await writeFile(temporary, JSON.stringify(config, null, 2) + '\n', { flag: 'wx' });
    await rename(temporary, file);
  } finally {
    await handle.close(); await unlink(lock);
    await unlink(temporary).catch(e => { if (e.code !== 'ENOENT') throw e; });
  }
}
export async function manage(cwd, args) {
  const text = args.trim();
  if (!text || text === 'help') return help;
  if (text === 'init') {
    const existing = await findProject(cwd);
    if (existing) return `Already initialized: ${existing.file}`;
    const file = resolve(cwd, '.harness/config.json');
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(emptyConfig(), null, 2) + '\n', { flag: 'wx' });
    return `Created ${file}. No rules enabled; add rules and attach enforcement.`;
  }
  const project = await loadProject(cwd);
  if (['status', 'doctor', 'reload'].includes(text)) return describe(project);
  if (!project) throw new Error('Run harness init first');
  const rule = /^rule add ([a-z][a-z0-9_-]*) (.+)$/s.exec(text);
  const add = /^(enforcement|tool) add (.+)$/s.exec(text);
  const toggle = /^(enable|disable) (rule|enforcement|tool) ([a-z][a-z0-9_-]*)$/.exec(text);
  if (rule) await update(project.file, c => c.rules.push({ id: rule[1], description: rule[2] }));
  else if (add) {
    const definition = JSON.parse(await readFile(resolve(cwd, add[2]), 'utf8'));
    await update(project.file, c => c[collections[add[1]]].push(definition));
  } else if (toggle) await update(project.file, c => {
    const item = c[collections[toggle[2]]].find(i => i.id === toggle[3]);
    if (!item) throw new Error(`Unknown ${toggle[2]}: ${toggle[3]}`);
    item.enabled = toggle[1] === 'enable';
  });
  else {
    const dry = /^check (\S+) (.+)$/s.exec(text);
    if (!dry) throw new Error(help);
    const { evaluate } = await import('./engine.js');
    const input = JSON.parse(dry[2]);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Tool input must be an object');
    return JSON.stringify(await evaluate(project, { toolName: dry[1], input, cwd }), null, 2);
  }
  return describe(await loadProject(cwd));
}
