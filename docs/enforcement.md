# What enforcement covers

The harness evaluates agent tool calls delivered through Pi's `tool_call` extension event. It can prevent that particular call by returning `{block: true, reason}`. When its native Git hooks are installed, the same engine also evaluates `git:pre-commit` and `git:pre-push` events. Neither path can undo an action after execution.

## Covered

- Built-in and extension tools that Pi dispatches through that event.
- Current configuration, loaded before each call.
- All matching enabled enforcements, including wildcard selection.
- Checker exceptions, invalid output, and unavailable Git state as `unknown`; blocking checks fail closed.
- Invalid configuration blocks tool calls even if only advisory rules were intended.
- A config removed after successful session activation blocks subsequent calls until restored or explicitly accepted with `/harness reload`.
- Removed or disabled project tools cannot continue executing through a cached registration.
- Installed native hooks can block commits by current Git state and pushes by Git's resolved ref updates.

## Not covered

- User shell escapes, external terminals, programs outside Pi, or extension code that directly runs processes.
- Descendant operations inside a permitted shell/custom tool. A permitted tool can change branches, write files, or execute Git after its check passes.
- Arbitrary shell parsing, command aliases, credentials, filesystem isolation, or network restrictions.
- Git operations when native hooks are not installed, hooks are bypassed with `--no-verify`, or hooks are replaced outside the harness.
- GitHub branch protection, required checks, or other server-side rules.
- Tampering with the extension or configuration by a user/agent with filesystem access.
- Races between checking state and performing an action. The Git check does not lock a worktree.
- Semantic proof that tests are sufficient, a deployment is healthy, or a prose rule has been followed.

The `git-branch` write/edit example remains a Pi tool guard. Commit interception
starts only after `/harness git install` and an enforcement selects
`git:pre-commit`. To disallow shell access, bind a `deny` check to `bash`; then
add narrow structured tools as needed. Other extensions can still expose
powerful tools, so review their scope too. Use OS isolation and server-side
authorization when you need a security boundary.

The shipped composite GitHub Action can turn configured `github:*` events into a
workflow status. Remote protection exists only after that workflow is enabled
and required through repository branch protection; the harness does not inspect
or configure those GitHub settings itself.

Custom checker/tool programs are trusted executable code. Review definitions and scripts before adding them. Programs inherit the environment, so they may have access to credentials even though the harness never deliberately logs environment variables. On POSIX, timeout/cancellation kills the program's process group; descendants that detach can escape it. On Windows, only the direct child is killed. This is resource control, not sandboxing.

A failed blocking checker requires no interactive approval; it returns the reason to the agent. Fix the problem or explicitly change the project policy. Rule management is exposed as a user slash command and CLI, not an agent policy-editing tool, but an agent with shell/write access can still edit files.
