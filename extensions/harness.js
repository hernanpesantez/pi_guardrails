import { randomUUID } from 'node:crypto';
import { loadProject, describe, describeDetailed, projectCounts, evaluate, runCommand } from '../src/engine.js';
import { manage, applyProposal, validateProposal } from '../src/manage.js';
import { describeGitHooks, gitHookStatus } from '../src/git.js';

const reply = text => ({ content: [{ type: 'text', text }], details: {} });
export default function harness(pi) {
  const registered = new Set();
  const configuredToolStates = new Map();
  let activeRoot;
  let pendingSelfAdd;
  let proposalRegistered = false;
  const proposalTool = 'pi_harness_policy_propose';
  const setToolActive = (name, shouldBeActive) => {
    const active = new Set(pi.getActiveTools());
    if (shouldBeActive) active.add(name); else active.delete(name);
    pi.setActiveTools([...active]);
  };
  const syncConfiguredTools = project => {
    const configured = new Map((project?.config.tools ?? []).map(tool => [`harness_${tool.id}`, tool.enabled !== false]));
    const transitions = [];
    for (const name of registered) {
      const next = configured.get(name) === true;
      if (configuredToolStates.get(name) !== next) transitions.push([name, next]);
      configuredToolStates.set(name, next);
    }
    if (!transitions.length) return;
    const active = new Set(pi.getActiveTools());
    for (const [name, next] of transitions) if (next) active.add(name); else active.delete(name);
    pi.setActiveTools([...active]);
  };
  const statusText = project => {
    if (!project) return undefined;
    const counts = projectCounts(project);
    return `harness: ${counts.rules.active}/${counts.rules.total} rules · ${counts.enforcements.active}/${counts.enforcements.total} guards · ${counts.tools.active}/${counts.tools.total} tools`;
  };
  async function refresh(ctx) {
    const project = await loadProject(ctx.cwd);
    activeRoot = project?.root;
    for (const tool of project?.config.tools ?? []) {
      const name = `harness_${tool.id}`;
      if (registered.has(name) || tool.enabled === false) continue;
      if (pi.getAllTools().some(t => t.name === name)) throw new Error(`Tool name collision: ${name}`);
      pi.registerTool({
        name, label: name, description: tool.description,
        parameters: { type: 'object', properties: { payload: { type: 'object', additionalProperties: true, description: 'JSON payload passed to the configured program' } }, required: ['payload'], additionalProperties: false },
        async execute(_id, { payload }, signal, _onUpdate, context) {
          try {
            const current = await loadProject(context.cwd);
            const definition = current?.config.tools.find(t => t.id === tool.id && t.enabled !== false);
            if (!definition) throw new Error('Tool removed or disabled in current project');
            const output = await runCommand(definition.command, { cwd: current.root, input: { version: 1, payload, projectRoot: current.root }, signal, timeoutMs: definition.timeoutMs });
            return reply(output || 'Completed.');
          } catch (error) { return { ...reply(error.message), isError: true }; }
        },
      });
      registered.add(name);
      configuredToolStates.set(name, true);
    }
    syncConfiguredTools(project);
    ctx.ui.setStatus('harness', statusText(project));
    return project;
  }
  const proposalReply = (text, isError = false) => ({ ...reply(text), ...(isError ? { isError: true } : {}) });
  const ensureProposalTool = () => {
    if (proposalRegistered) { setToolActive(proposalTool, true); return; }
    if (pi.getAllTools().some(tool => tool.name === proposalTool)) throw new Error(`Tool name collision: ${proposalTool}`);
    pi.registerTool({
      name: proposalTool,
      label: 'Harness Policy Proposal',
      description: 'Submit an atomic harness policy proposal after the user invokes /harness self-add. The user must confirm it in Pi before it is applied.',
      parameters: {
        type: 'object',
        properties: {
          requestId: { type: 'string', description: 'Request ID supplied by /harness self-add' },
          proposal: {
            type: 'object',
            description: 'Config entries to add atomically',
            properties: {
              rules: { type: 'array', items: { type: 'object', additionalProperties: true } },
              enforcements: { type: 'array', items: { type: 'object', additionalProperties: true } },
              tools: { type: 'array', items: { type: 'object', additionalProperties: true } },
            },
            required: ['rules', 'enforcements', 'tools'],
            additionalProperties: false,
          },
        },
        required: ['requestId', 'proposal'],
        additionalProperties: false,
      },
      async execute(_id, { requestId, proposal }, _signal, _onUpdate, context) {
        try {
          if (!pendingSelfAdd || requestId !== pendingSelfAdd.id) throw new Error('No matching /harness self-add request is pending.');
          const project = await loadProject(context.cwd);
          if (!project || project.root !== pendingSelfAdd.root) throw new Error('The active harness project changed. Start self-add again.');
          if (!context.hasUI) throw new Error('Self-add requires an interactive Pi confirmation.');
          await validateProposal(context.cwd, proposal);
          const executable = proposal.enforcements.some(item => item.check.kind === 'command') || proposal.tools.length > 0;
          const preview = [
            `Request: ${pendingSelfAdd.request}`,
            executable ? 'Warning: this proposal adds trusted executable commands.' : 'This proposal adds declarative policy only.',
            '', JSON.stringify(proposal, null, 2),
          ].join('\n');
          const confirmed = await context.ui.confirm('Apply harness policy?', preview);
          if (!confirmed) {
            pendingSelfAdd = undefined; setToolActive(proposalTool, false);
            return proposalReply('Policy proposal cancelled by the user.');
          }
          await applyProposal(context.cwd, proposal);
          pi.appendEntry('harness:policy-change', {
            timestamp: new Date().toISOString(),
            rules: proposal.rules.map(item => item.id),
            enforcements: proposal.enforcements.map(item => item.id),
            tools: proposal.tools.map(item => item.id),
          });
          pendingSelfAdd = undefined; setToolActive(proposalTool, false);
          const updated = await refresh(context);
          return proposalReply(`Policy applied.\n\n${describeDetailed(updated)}`);
        } catch (error) {
          return proposalReply(`Policy was not applied: ${error.message}`, true);
        }
      },
    });
    proposalRegistered = true;
    setToolActive(proposalTool, true);
  };
  async function dashboard(ctx) {
    if (!ctx.hasUI) return describeDetailed(await loadProject(ctx.cwd));
    while (true) {
      const project = await loadProject(ctx.cwd);
      if (!project) return describeDetailed(project);
      const counts = projectCounts(project);
      const activeRules = new Set(project.config.rules.filter(rule => rule.enabled !== false).map(rule => rule.id));
      const githubChecks = project.config.enforcements.filter(item => item.enabled !== false && activeRules.has(item.rule) && item.tools.some(tool => tool.startsWith('github:')));
      const hooks = await gitHookStatus(ctx.cwd);
      const hookState = hooks.installed ? 'installed' : hooks.configuredPath || hooks.legacyHooks.length ? 'conflict' : hooks.repository ? 'not installed' : 'unavailable';
      const top = [
        `Overview`,
        `Rules · ${counts.rules.active}/${counts.rules.total} active`,
        `Enforcements · ${counts.enforcements.active}/${counts.enforcements.total} active`,
        `Tools · ${counts.tools.active}/${counts.tools.total} active`,
        `GitHub checks · ${githubChecks.length} configured`,
        `Git hooks · ${hookState}`,
        'Close',
      ];
      const choice = await ctx.ui.select(`Harness control center\n${project.file}`, top);
      if (!choice || choice === 'Close') return describeDetailed(project);
      if (choice === 'Overview') {
        await ctx.ui.select(`${describeDetailed(project)}\n\n${describeGitHooks(hooks)}`, ['Back']);
        continue;
      }
      if (choice.startsWith('GitHub checks')) {
        const lines = githubChecks.length
          ? githubChecks.map(item => `${item.id}: ${item.action} on ${item.tools.join(', ')}`)
          : ['No active GitHub event enforcements.', 'Add an enforcement for an exact github:* event, then run the reusable action as a required check.'];
        await ctx.ui.select(`GitHub policy\n${lines.join('\n')}`, ['Back']);
        continue;
      }
      if (choice.startsWith('Git hooks')) {
        const actions = hooks.installed ? ['Uninstall hooks', 'Back']
          : hooks.repository && !hooks.configuredPath && !hooks.legacyHooks.length ? ['Install hooks', 'Back'] : ['Back'];
        const selected = await ctx.ui.select(describeGitHooks(hooks), actions);
        if (!selected || selected === 'Back') continue;
        const operation = selected.startsWith('Install') ? 'install' : 'uninstall';
        const ok = await ctx.ui.confirm(`${operation === 'install' ? 'Install' : 'Uninstall'} Git hooks?`, operation === 'install'
          ? 'Configure this repository to run harness pre-commit and pre-push policy events.'
          : 'Remove this repository’s harness core.hooksPath setting.');
        if (!ok) continue;
        ctx.ui.notify(await manage(ctx.cwd, `git ${operation}`), 'info');
        continue;
      }
      const kind = choice.startsWith('Rules') ? 'rule' : choice.startsWith('Enforcements') ? 'enforcement' : 'tool';
      const collection = { rule: 'rules', enforcement: 'enforcements', tool: 'tools' }[kind];
      const items = project.config[collection];
      if (!items.length) { ctx.ui.notify(`No ${collection} configured.`, 'info'); continue; }
      const labels = new Map(items.map(item => {
        const display = kind === 'tool' ? `harness_${item.id}` : `${kind} ${item.id}`;
        return [`${item.enabled === false ? 'Enable' : 'Disable'} ${display}`, item];
      }));
      const selected = await ctx.ui.select(`Toggle ${collection}`, [...labels.keys(), 'Back']);
      if (!selected || selected === 'Back') continue;
      const item = labels.get(selected);
      const operation = item.enabled === false ? 'enable' : 'disable';
      const ok = await ctx.ui.confirm(`${operation === 'enable' ? 'Enable' : 'Disable'} ${kind}?`, `${item.id}\n\n${item.description ?? `Rule: ${item.rule} · ${item.action} · ${item.tools.join(', ')}`}`);
      if (!ok) continue;
      await manage(ctx.cwd, `${operation} ${kind} ${item.id}`);
      await refresh(ctx);
      ctx.ui.notify(`${item.id} ${operation}d`, 'info');
    }
  }
  pi.on('session_start', async (_event, ctx) => {
    try { await refresh(ctx); }
    catch (e) { ctx.ui.setStatus('harness', 'harness: CONFIG ERROR'); ctx.ui.notify(e.message, 'error'); }
  });
  pi.on('before_agent_start', async (event, ctx) => {
    let context;
    try { context = describe(await loadProject(ctx.cwd)); }
    catch (e) { context = `Harness configuration error: ${e.message}. Tool calls are blocked until repaired.`; }
    return { systemPrompt: `${event.systemPrompt}\n\nProject harness rules (advisory rules are instructions, not executable protection):\n${context}` };
  });
  pi.on('tool_call', async (event, ctx) => {
    try {
      const project = await loadProject(ctx.cwd);
      if (!project) {
        if (activeRoot) return { block: true, reason: 'Harness configuration disappeared. Restore it or explicitly /harness reload.' };
        return;
      }
      const verdict = await evaluate(project, { toolName: event.toolName, input: event.input, cwd: ctx.cwd });
      for (const result of verdict.results) {
        // Do not store tool arguments, command output, or potentially sensitive checker reasons.
        pi.appendEntry('harness:decision', { timestamp: new Date().toISOString(), rule: result.rule, enforcement: result.enforcement, action: result.action, status: result.status, tool: event.toolName });
        if (result.action === 'warn' && result.status !== 'pass') ctx.ui.notify(`${result.rule}: ${result.reason}`, 'warning');
      }
      if (verdict.blocked) return { block: true, reason: verdict.results.filter(r => r.action === 'block' && r.status !== 'pass').map(r => `${r.rule}: ${r.reason}`).join('\n') };
    } catch (e) { return { block: true, reason: `Harness configuration error: ${e.message}. Repair config using the CLI or editor.` }; }
  });
  pi.registerCommand('harness', {
    description: 'Open the harness control center or manage policy. /harness help',
    handler: async (args, ctx) => {
      try {
        const text = args.trim();
        if (!text || text === 'dashboard') {
          const output = await dashboard(ctx);
          await refresh(ctx);
          pi.sendMessage({ customType: 'harness', content: output, display: true }, { triggerTurn: false });
          return;
        }
        if (text === 'self-add cancel') {
          pendingSelfAdd = undefined; setToolActive(proposalTool, false);
          ctx.ui.notify('Harness self-add request cancelled.', 'info');
          return;
        }
        if (text === 'self-add') throw new Error('Usage: /harness self-add <plain-language policy request>');
        if (text.startsWith('self-add ')) {
          const request = text.slice('self-add '.length).trim();
          if (!request) throw new Error('Usage: /harness self-add <plain-language policy request>');
          const project = await loadProject(ctx.cwd);
          if (!project) throw new Error('Run /harness init first');
          pendingSelfAdd = { id: randomUUID(), request, root: project.root };
          ensureProposalTool();
          pi.sendUserMessage([
            'Harness self-add request:', request, '',
            `Request ID: ${pendingSelfAdd.id}`,
            'Inspect the current .harness/config.json and translate this request into additive rules, enforcements, and tools.',
            'Native Git policies use tool names git:pre-commit and git:pre-push. The git-push checker can protect destination branches, deny deletion, and require matching local/remote branch names.',
            'Use existing built-in checks when possible. Do not edit project files during self-add. Command checkers and tools may reference only programs that already exist; if new executable code is required, explain that it needs a separate implementation change.',
            'GitHub policies use exact github:* event names and run through the reusable GitHub Action; they become remote enforcement only when that workflow is required by branch protection.',
            `Do not edit .harness/config.json directly. Call ${proposalTool} with the request ID and complete rules, enforcements, and tools arrays. The exact proposal requires user confirmation in Pi before it is applied.`,
          ].join('\n'), { deliverAs: 'steer' });
          ctx.ui.notify('Self-add request sent to the agent; waiting for a policy proposal.', 'info');
          return;
        }
        const output = await manage(ctx.cwd, text);
        await refresh(ctx);
        pi.sendMessage({ customType: 'harness', content: output, display: true }, { triggerTurn: false });
      } catch (e) { ctx.ui.notify(e.message, 'error'); }
    },
  });
}
