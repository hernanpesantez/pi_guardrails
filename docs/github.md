# GitHub enforcement

`action.yml` is a composite GitHub Action that evaluates a configured harness
event in the consumer repository. It exits nonzero when any matching blocking
enforcement fails or returns unknown. The action selects Node.js 22.19 before
running the dependency-free policy engine.

## Consumer workflow

After a stable release exists, add a workflow like this to the repository that
owns `.harness/config.json`:

```yaml
name: Harness policy
on:
  pull_request:
jobs:
  policy:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4
      - uses: OWNER/PI-HARNESS-REPOSITORY@REVIEWED_TAG
        with:
          event: github:pull-request
          input: '{}'
```

Replace the placeholder with the reviewed repository and immutable tag. Configure
the resulting job as a required status check in GitHub branch protection. Merely
committing the workflow does not prevent an administrator from changing or
bypassing repository policy. Protect `.harness/`, its checker scripts, and the
workflow itself with CODEOWNERS or an equivalent owner-review rule; otherwise a
pull request can weaken the policy it is being evaluated against.

## Event input

For `github:*` events, the action supplies:

```json
{
  "repository": "owner/repository",
  "ref": "refs/pull/123/merge",
  "sha": "...",
  "baseRef": "main",
  "headRef": "feature/example",
  "actor": "octocat",
  "githubEventName": "pull_request"
}
```

The optional action `input` must be a JSON object. Its fields are added to this
object and may intentionally override defaults. Bind enforcements to an exact
event name such as `github:pull-request`; custom command checkers receive the
event through the standard JSON protocol.

The same entry point can be exercised locally:

```bash
pi-harness-enforce github:pull-request '{"baseRef":"main"}'
```

Warnings print diagnostics but exit zero. Blocking failures, invalid config,
invalid input, missing config, checker errors, and an event with no enabled
matching enforcement exit nonzero. This prevents a misspelled event from
producing an empty green check. The action does not call GitHub APIs, inspect
branch-protection settings, install webhooks, or request credentials.
