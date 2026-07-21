# Beta release checklist

MDBASE Connect desktop bundles contain the Electron controller and the matching
Rust connector agent. A release is one tested unit; mixing controller and agent
versions is unsupported.

## Local package verification

From the repository root:

```bash
pnpm install --frozen-lockfile
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
pnpm typecheck
pnpm test
pnpm e2e
pnpm e2e:sync
pnpm e2e:oracle
pnpm --filter @mdbase/connect-desktop package
```

The package command compiles a release agent, creates the platform Electron
bundle, and verifies that `app.asar` and the agent executable are both present.
Run the packaged application once with a fresh user-data directory and complete
pairing, collection registration, encrypted TaskNotes authorization, one write,
pause/resume, and revocation.

## Signing and publication

Public artifacts must be signed with the platform owner's credentials:

- macOS: Developer ID signing and Apple notarization;
- Windows: Authenticode signing for the application and installer;
- Linux: repository/package signatures for the chosen distribution channel.

Unsigned local packages are test artifacts. Do not present them as public beta
downloads. Release automation should receive signing material from the CI
secret store, never repository files or developer environment files.

Before publishing a version, record the exact `mdbase-rs` revision, run the
local and oracle end-to-end suites, retain checksums for every artifact, verify
upgrade and clean-install paths, and publish the supported protocol and schema
versions. Automatic updates should be enabled only after signed rollback and
staged-rollout behavior has been exercised against a private channel.
