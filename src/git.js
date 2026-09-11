import { stat } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate, loadProject, runCommand } from './engine.js';

const hooksDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../hooks');
const exists = async file => { try { await stat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const git = (cwd, ...args) => runCommand(['git', ...args], { cwd });

export async function gitHookStatus(cwd) {
  try {
    const root = (await git(cwd, 'rev-parse', '--show-toplevel')).trim();
    const commonValue = (await git(cwd, 'rev-parse', '--git-common-dir')).trim();
    const commonDirectory = resolve(root, commonValue);
    const configuredValue = (await git(cwd, 'config', '--local', '--get', '--default', '', 'core.hooksPath')).trim();
    const configuredPath = configuredValue ? resolve(root, configuredValue) : null;
    const legacyHooks = [];
    if (!configuredPath) {
      for (const name of ['pre-commit', 'pre-push']) if (await exists(join(commonDirectory, 'hooks', name))) legacyHooks.push(name);
    }
    return {
      repository: true, root, commonDirectory, expectedPath: hooksDirectory,
      configuredPath, installed: configuredPath === hooksDirectory, legacyHooks,
    };
  } catch (error) {
    return { repository: false, installed: false, reason: error.message, expectedPath: hooksDirectory, configuredPath: null, legacyHooks: [] };
  }
}

export function describeGitHooks(status) {
  if (!status.repository) return `Git hooks: unavailable (${status.reason})`;
  if (status.installed) return `Git hooks: installed (${status.expectedPath})`;
  if (status.configuredPath) return `Git hooks: another core.hooksPath is configured (${status.configuredPath})`;
  if (status.legacyHooks.length) return `Git hooks: existing ${status.legacyHooks.join(', ')} must be integrated first`;
  return 'Git hooks: not installed';
}

export async function installGitHooks(cwd) {
  const status = await gitHookStatus(cwd);
  if (!status.repository) throw new Error(`Cannot install Git hooks: ${status.reason}`);
  if (status.installed) return status;
  if (status.configuredPath) throw new Error(`Existing core.hooksPath found: ${status.configuredPath}`);
  if (status.legacyHooks.length) throw new Error(`Existing ${status.legacyHooks.join(' and ')} found; integrate them before installing`);
  for (const name of ['pre-commit', 'pre-push']) if (!await exists(join(hooksDirectory, name))) throw new Error(`Harness hook is missing: ${name}`);
  await git(cwd, 'config', '--local', 'core.hooksPath', hooksDirectory);
  return gitHookStatus(cwd);
}

export async function uninstallGitHooks(cwd) {
  const status = await gitHookStatus(cwd);
  if (!status.repository) throw new Error(`Cannot uninstall Git hooks: ${status.reason}`);
  if (!status.configuredPath) return status;
  if (!status.installed) throw new Error(`Refusing to remove another core.hooksPath: ${status.configuredPath}`);
  await git(cwd, 'config', '--local', '--unset', 'core.hooksPath');
  return gitHookStatus(cwd);
}

function parsePushUpdates(input) {
  if (!input.trim()) return [];
  return input.trim().split('\n').map((line, index) => {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 4) throw new Error(`Malformed pre-push update on line ${index + 1}`);
    const [localRef, localSha, remoteRef, remoteSha] = fields;
    return { localRef, localSha, remoteRef, remoteSha };
  });
}

export async function evaluateGitHook(cwd, hook, args = [], stdin = '') {
  if (!['pre-commit', 'pre-push'].includes(hook)) throw new Error(`Unsupported Git hook: ${hook}`);
  const project = await loadProject(cwd);
  if (!project) throw new Error('Harness Git hooks require .harness/config.json');
  const input = hook === 'pre-push'
    // Git's second pre-push argument may contain embedded credentials. It is
    // deliberately not forwarded to policy checkers or diagnostics.
    ? { remoteName: args[0] ?? null, updates: parsePushUpdates(stdin) }
    : { stagedFiles: (await git(cwd, 'diff', '--cached', '--name-only', '--no-renames')).trim().split('\n').filter(Boolean) };
  return evaluate(project, { toolName: `git:${hook}`, input, cwd });
}
