# Repository guidance

- Read `PRODUCT.md` for product intent and `DESIGN.md` for interface direction
  before changing user-facing flows.

- Keep mdbase collection semantics in `mdbase-rs`; do not duplicate them here.
- During v0.3 development, the Rust workspace intentionally uses `../mdbase-rs`
  as a path dependency.
- Treat the local connector as the final authorization boundary. Every remote
  filesystem operation must be checked against its locally cached exact grant.
- Never send local collection paths to the control plane or persist record
  payloads there.
- Keep Rust and TypeScript protocol changes versioned and compatible.
- Run `cargo fmt --all`, `cargo test --workspace`, `pnpm typecheck`, `pnpm test`,
  and `pnpm e2e` before handing off changes that affect the request path.
- `MDBASE_CONNECT_DEV_AUTH=1` is for local development only.
