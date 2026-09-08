# Sharing and releases

This checkout is a complete Pi package. Publishing is a separate owner action.

## Git distribution

1. Create a public repository under the intended owner, and push a reviewed commit.
2. Confirm the MIT license and attribution are correct for your contributors.
3. Run the tests and packing checks; tag the reviewed release, for example `v0.1.0`.
4. Users can install the actual repository with:

```bash
pi install -l git:github.com/OWNER/REPOSITORY@v0.1.0
```

`OWNER/REPOSITORY` is a placeholder, not an existing release.

## npm distribution

1. Choose and verify an available package name or owned npm scope; update `package.json`.
2. Add the actual repository, bugs, homepage, and author metadata once ownership is known.
3. Update `CHANGELOG.md` and version.
4. Run `npm test`, `npm run check`, and `npm pack --dry-run`.
5. Test the packed contents in a disposable Pi project.
6. Publish with your account using `npm publish --access public`.

Users then install `pi install -l npm:YOUR_PACKAGE@0.1.0`. Do not advertise the provisional name as published. The `pi-package` keyword and `pi.extensions` manifest enable Pi discovery. Source JavaScript is shipped directly, so consumers do not need build dependencies.

CI runs the Node test suite and package checks on Linux. Windows and macOS behavior is not yet release-qualified.
