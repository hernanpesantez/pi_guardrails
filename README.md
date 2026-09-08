# Pi Agent Harness

Project rules, executable enforcement, and custom tools for [Pi](https://github.com/earendil-works/pi). Bring the same engine to any repository and keep each project's policy in version control.

**Version 0.1 is an early implementation.** It enforces policy at Pi's agent `tool_call` boundary. It is not an operating-system sandbox, a Git server policy, or a guarantee that an agent follows every instruction.

- **Rules** describe requirements and are included in the agent's context each turn.
- **Enforcements** attach executable checks to tool names, with `warn` or `block` actions.
- **Tools** run configured programs with structured JSON input, without shell interpolation.

No runtime npm dependencies. Node.js >=22.19 and Pi with dynamic `registerTool` support are required. Developed against Pi 0.85.1 (`@earendil-works/pi-coding-agent`); older Pi versions are not yet supported.

## Install locally

From any project, using your absolute checkout path:

```bash
pi install -l /absolute/path/to/pi-agent-harness
```

Then start Pi (or `/reload` in an existing session):

```text
/harness init
/harness rule add branch-policy Edit code on a feature branch.
/harness enforcement add /absolute/path/to/pi-agent-harness/examples/protected-branch.json
/harness status
```

The example blocks Pi `write` and `edit` calls targeting repositories on `main` or `master`. It checks the target's repository, including symlink targets and newly created paths. A detached HEAD or unknown repository blocks too. It **does not inspect shell commands or prevent a shell from writing or committing**. Add a `deny` enforcement for `bash` if your workflow uses only structured tools, or complement it with external controls.

Nothing is installed into your other projects automatically. `-l` writes Pi's project settings. Omit `-l` for a user installation; the extension then looks for project configuration wherever Pi runs.

## Commands

| Command | Purpose |
| --- | --- |
| `/harness init` | Create `.harness/config.json` without overwriting existing policy |
| `/harness rule add <id> <description>` | Add an advisory rule |
| `/harness enforcement add <file.json>` | Validate and attach a checker definition |
| `/harness tool add <file.json>` | Register a project tool |
| `/harness enable rule\|enforcement\|tool <id>` | Enable an entry |
| `/harness disable rule\|enforcement\|tool <id>` | Disable an entry |
| `/harness status` | Show advisory rules, enforcement scope, and tools |
| `/harness doctor` | Validate configuration and show status; does not execute programs |
| `/harness check <tool-name> <JSON-input>` | Evaluate policy without executing the target tool |
| `/harness reload` | Discover tools after external edits and accept the current project root |
| `/harness help` | Show command help |

Paths after `add` may contain spaces; pass the path without literal quote characters in Pi. The standalone CLI uses normal shell quoting:

```bash
node /absolute/path/to/pi-agent-harness/bin/pi-harness.js init
node /absolute/path/to/pi-agent-harness/bin/pi-harness.js rule add tests "Run project tests before completion."
node /absolute/path/to/pi-agent-harness/bin/pi-harness.js check write '{"path":"src/example.js"}'
```

`pi-harness` is also available when installed through npm's CLI mechanisms. Pi package installation alone does not promise a globally accessible CLI binary.

## Add custom enforcement and a tool

Copy `examples/checker.mjs` and `examples/echo.mjs` into your project's `.harness/` directory. Then:

```text
/harness rule add ticket-required Include a ticket when using the echo tool.
/harness enforcement add /absolute/path/to/pi-agent-harness/examples/ticket-enforcement.json
/harness tool add /absolute/path/to/pi-agent-harness/examples/echo-tool.json
/harness check harness_echo {"payload":{}}
/harness check harness_echo {"payload":{"ticket":"TASK-42"}}
```

The agent can call `harness_echo` with `{"payload":{"ticket":"TASK-42","message":"hello"}}`. Each project tool currently takes a free-form JSON `payload` object; its program validates domain-specific fields. Native per-tool input schemas are a future extension.

Programs can be written in any language. Checkers receive JSON on stdin and return one JSON result on stdout:

```json
{"status":"fail","reason":"Provide payload.ticket"}
```

Supported results are `pass`, `fail`, and `unknown`. A blocking enforcement blocks both `fail` and `unknown`, including timeouts, missing executables, invalid output, and nonzero exit codes. A warning records the result and displays a UI notification without blocking. In headless workflows, inspect session audit entries for warnings.

See [configuration and protocols](docs/configuration.md) and [enforcement coverage](docs/enforcement.md).

## Architecture

```text
Pi tool_call -> load + validate nearest project config
             -> select enabled rules/enforcements by tool name
             -> built-in checker or external checker program
             -> pass / warn / block + session audit entry

Pi custom tool -> reload current definition -> execute program via argv + JSON stdin
```

The engine in `src/engine.js` has no Pi dependency. The adapter in `extensions/harness.js` connects it to Pi. The CLI and `/harness` share the management implementation. This is a Pi package, not a Codex plugin.

Rules without enforcement remain visibly advisory. Changing a rule's prose does not generate a checker. Configuration is re-read before each tool call, and disabled or removed custom tools refuse execution immediately. Adding tools externally requires `/harness reload`; changing a registered tool's description requires Pi `/reload` to refresh its model-facing metadata.

## Development and sharing

```bash
npm test
npm run check
npm pack --dry-run
```

Tests use Node's built-in runner and temporary Git repositories. No model or API key is required. See [CONTRIBUTING.md](CONTRIBUTING.md) for development and [release instructions](docs/releasing.md) for publishing through Git or npm. The package name is provisional; npm availability has not been claimed or verified.

MIT licensed. No hosted service, telemetry, or automatic external requests.

## Pi documentation used

- [Extensions: lifecycle events, custom tools, commands, session entries](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- [Packages: manifest, local/Git/npm installation, distribution](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)
