# Contributing to Zusk

Thanks for your interest in Zusk! Bug reports, ideas and pull requests are all welcome.

## Before you start

- **Found a bug?** [Open an issue](https://github.com/shubhranka/zusk/issues/new/choose) with the steps to reproduce it, your OS and your PostgreSQL version.
- **Have an idea?** Open a feature request first, so we can agree on the approach before you spend time on code.
- **Found a security problem?** Please don't open a public issue. See [SECURITY.md](SECURITY.md).

## Set up

You'll need [Node.js](https://nodejs.org) 22 or newer, a [Rust toolchain](https://rustup.rs), the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS, and Docker.

```sh
npm install
npm run db:up          # Postgres 16 with seed data on localhost:54329
npm run tauri dev      # the desktop app, with hot reload for the UI
```

To work on the UI in a normal browser, run `npm run dev:bridge` and `npm run dev`, then open http://localhost:1420. The [README](README.md#working-on-the-ui-in-a-browser) explains how the bridge works.

## Run the checks

CI runs all of these on every pull request:

```sh
npm test                                                              # UI logic (Vitest)
npm run build                                                         # type-check and build the UI
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml                       # Rust unit tests
cargo test --manifest-path src-tauri/Cargo.toml --test db -- --include-ignored
#   ^ integration tests, against the Docker database
```

## Guidelines

- **The webview never talks to Postgres.** All database work belongs in the Rust core (`src-tauri/src`), exposed to the UI as a command in `commands.rs`.
- **Read-only mode is a promise.** Changes to `db/query.rs` or `db/splitter.rs` must keep read-only sessions unable to write. Add a test when you touch them.
- **Match the code around you.** Follow its naming, comment style and structure. Keep comments for the *why*.
- **Keep pull requests focused.** One change per PR is easier to review. Include screenshots for UI changes.
- **Add tests** for new behaviour: Vitest for UI logic in `src/lib`, Rust unit tests next to the code, and integration tests in `src-tauri/tests/db.rs` for anything that talks to Postgres.

## Project layout

See [Project layout](README.md#how-it-works) in the README for a map of the code.

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
