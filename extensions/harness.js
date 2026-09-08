import { loadProject, describe, evaluate, runCommand } from '../src/engine.js';
import { manage } from '../src/manage.js';

const reply = text => ({ content: [{ type: 'text', text }], details: {} });
export default function harness(pi) {
  const registered = new Set();
  let activeRoot;
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
    }
    ctx.ui.setStatus('harness', project ? `harness: ${project.config.rules.filter(r => r.enabled !== false).length} rules` : undefined);
    return project;
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
    description: 'Manage project rules, enforcement, and tools. /harness help',
    handler: async (args, ctx) => {
      try {
        const output = await manage(ctx.cwd, args);
        await refresh(ctx);
        pi.sendMessage({ customType: 'harness', content: output, display: true }, { triggerTurn: false });
      } catch (e) { ctx.ui.notify(e.message, 'error'); }
    },
  });
}
