# Configuration and extension protocols

The nearest `.harness/config.json` in the current directory or its ancestors is used. Configurations do not merge. Run `init` at the intended project root; nested projects inherit the nearest existing configuration unless you explicitly create their own. No Git repository is required except for Git checks.

```json
{
  "version": 1,
  "rules": [{"id":"branch-policy","description":"Edit on a feature branch."}],
  "enforcements": [{
    "id":"feature-branch",
    "rule":"branch-policy",
    "tools":["write","edit"],
    "action":"block",
    "check":{"kind":"git-branch","options":{"protected":["main","master"]}}
  }],
  "tools": []
}
```

All three arrays are required. Unknown fields and unsupported versions fail validation. IDs use lowercase letters, numbers, hyphens, and underscores, start with a letter, and are unique within their collection. `enabled` is optional and defaults to true. An enforcement referencing a missing rule is invalid.

## Rules

Fields: `id`, `description`, optional `enabled`. Descriptions enter the agent's system context each turn. They are trusted project instructions. A rule without enabled enforcement is advisory.

## Enforcements

Fields: `id`, `rule`, `tools`, `action`, `check`, optional `enabled`.

`tools` is a nonempty list of exact Pi tool names, or `*` to match every agent tool call. No other glob syntax is supported. Actions are `warn` or `block`. All matching checks run sequentially; a failure in any blocking check blocks the call. Disabled rules disable all their checks.

Built-in check kinds:

| Kind | Configuration | Meaning |
| --- | --- | --- |
| `deny` | No options | Always fails when selected |
| `git-branch` | `options.protected`: nonempty branch-name array | Fails on protected branches; unknown Git state returns unknown |
| `command` | `command`: argv array; optional `timeoutMs` | Executes a checker program |

`git-branch` resolves the target path for built-in `write` and `edit`. For all other tools it checks the session cwd's Git branch. It does not parse a shell command, a `git -C` argument, or custom tool payloads. Bind it only where that scope is appropriate.

A command checker runs from the configuration's project root with this stdin:

```json
{
  "version": 1,
  "projectRoot": "/work/project",
  "event": {
    "toolName": "harness_example",
    "cwd": "/work/project/subdir",
    "input": {"payload":{"ticket":"TASK-42"}}
  }
}
```

It must exit 0 and write exactly one object with `status` (`pass`, `fail`, or `unknown`) and a nonempty `reason`. Unexpected fields are rejected. Log diagnostics to stderr, not stdout. Checkers must be read-only and idempotent; even `/harness check` executes them. The harness cannot prove a custom checker is side-effect-free.

## Project tools

Fields: `id`, `description`, `command` (argv array), optional `timeoutMs`, optional `enabled`. Exposed to Pi as `harness_<id>`.

The Pi parameter schema is `{payload: object}`. stdin is:

```json
{"version":1,"projectRoot":"/work/project","payload":{"ticket":"TASK-42"}}
```

stdout becomes the tool's text result. A nonzero exit, spawn error, timeout, or output overflow produces an error tool result. stderr is drained and discarded. All programs inherit the Pi process environment and permissions. Never use a program's stdout for secrets.

Both program types default to 10 seconds, configurable from 1 to 300000 milliseconds. stdout is limited to 64 KiB. Commands use `spawn` with `shell: false`; executable lookup follows PATH, and relative script arguments resolve from the project root. The user can explicitly configure a shell program, but then assumes its interpretation and risk. Cancellation is supported for project tools. Pi's pre-tool hook does not supply a cancellation signal, so checker timeouts bound that work.

## Storage and edits

Commit `.harness/config.json` and project scripts with the repository. CLI mutations use an exclusion lock and atomic rename. Concurrent harness mutations fail with a lock error rather than overwrite each other. After a crashed CLI, inspect and remove a stale `config.json.lock` manually. External editors must not write concurrently with CLI mutations.

Audit entries use Pi's `appendEntry` with type `harness:decision`. They record timestamp, rule/enforcement IDs, action, result status, and tool name. They exclude arguments, checker reasons, and outputs. These session entries are diagnostic records, not tamper-proof evidence or task memory.
