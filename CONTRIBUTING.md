# Contributing

Use Node.js >=22.19. The core has no runtime dependencies or build step.

1. Create a feature branch in your own checkout.
2. Run `npm test` and `npm run check`.
3. Load the package into a disposable project with `pi install -l /absolute/path/to/checkout`.
4. Exercise `/harness init`, rule/enforcement/tool additions, and a blocked tool call.
5. Run `npm pack --dry-run` and inspect the file list.

Keep the core independent of Pi. Add adapters in `extensions/`. Prefer the existing command protocol for third-party checkers; adding a built-in checker requires validation, documented scope, and tests for unknown/error outcomes. Never claim a tool-call filter is a security sandbox.

Changes to configuration or program protocols must preserve version 1 compatibility or introduce an explicitly supported new version. Tests should cover behavior and failure modes, including renamed/disabled tools and config errors.

Documentation must distinguish implemented features from future ideas. Proposed directions include native custom tool schemas, shareable policy presets, and optional Git/server adapters. No release promises are implied.

## Pi integration smoke test

The default test suite skips the optional Pi integration test. To run it against an installed Pi package directory:

```bash
PI_HARNESS_PI_DIR=/absolute/path/to/node_modules/@earendil-works/pi-coding-agent npm test
```

This uses Pi's real extension loader and tool argument validator, with a minimal host runtime and no model calls. It checks dynamic tool registration and a blocking hook. It does not exercise a full interactive model session. The installed Pi directory must include its dependencies. The smoke test uses internal module paths and may need adaptation when upgrading Pi.
