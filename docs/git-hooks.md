# Native Git hooks

The optional Git adapter applies the same project rules outside Pi when Git runs
`pre-commit` or `pre-push`. It is a local workflow guard, not remote protection.

## Install and inspect

From Pi, open `/harness` and select **Git hooks**, or run:

```text
/harness git status
/harness git install
/harness git uninstall
```

The standalone CLI accepts the same commands. Installation points the
repository-local `core.hooksPath` at the package's `hooks/` directory. The
installer refuses to overwrite another configured hook path or existing
`.git/hooks/pre-commit` and `.git/hooks/pre-push` files. Uninstall only removes a
path owned by the current package location.

Because `core.hooksPath` is stored in common Git configuration, linked worktrees
use the same hooks. Every worktree still discovers its nearest
`.harness/config.json` independently from its working directory.

## Events

`git:pre-commit` input contains:

```json
{"stagedFiles":["src/example.js"]}
```

`git:pre-push` input contains the remote name and every resolved update:

```json
{
  "remoteName": "origin",
  "updates": [{
    "localRef": "refs/heads/feature",
    "localSha": "...",
    "remoteRef": "refs/heads/feature",
    "remoteSha": "..."
  }]
}
```

Git's remote-location argument is deliberately omitted because an HTTPS remote
may contain embedded credentials.

Command checkers receive this under the normal `event.input` envelope. Built-in
`git-branch` is appropriate for `git:pre-commit`. Built-in `git-push` supports:

- `protected`: exact remote branch names that cannot be updated.
- `denyDeletes`: reject zero-SHA deletion updates.
- `sameBranch`: require local and remote branch names to match.

All matching checks run. Blocking failures and unknown results exit the hook
with status 1. Warnings print to stderr and allow Git to continue. A missing or
invalid project config fails closed because an installed hook without readable
policy cannot establish what is allowed.

## Limits

Users and programs can bypass local hooks with `--no-verify`, change Git config,
edit the working-tree policy before a hook reads it, or invoke lower-level
transport operations. Package moves can invalidate an
absolute hook path until it is reinstalled. Native hooks do not create GitHub
required checks. Protect remote branches with GitHub branch protection and a
required workflow in addition to this local adapter.
