# Vite+ LSP config root reproduction

Reproduces [voidzero-dev/vite-plus#3217](https://github.com/voidzero-dev/vite-plus/issues/3217).

Oxlint and Oxfmt in Vite+ mode load the correct `vite.config.ts`, but plugin entry resolution can use the server's working directory. With multiple workspace folders, TanStack Start then searches for `router.tsx` in the wrong project.

This repository includes a config-resolution matrix, actual Oxlint/Oxfmt LSP sessions, and a separate check of Vite+'s CLI config helper. The fixtures test config loading; they are not complete web applications.

## Quick start

Use Node.js 24 or newer. The original reproduction was verified with Node.js `24.22.1` on macOS arm64; `.node-version` records that version.

```sh
git clone https://github.com/why-reproductions-are-required/vite-plus-lsp-config-root-3217.git
cd vite-plus-lsp-config-root-3217
npm ci
npm run verify:deps
npm run repro
npm run repro:lsp
```

No global Vite+ installation or running editor is required. The scripts use the Node executable that runs them.

Run every check, including the CLI helper comparison:

```sh
npm test
```

**A successful reproduction exits with code 0.** Rows marked `FAIL` in the matrix are expected failures in the affected implementation. An unexpected result, timeout, or startup error makes the check exit with code 1. Full results are written to the ignored `results/` directory.

## Pinned dependencies

The repository pins Vite+ `1.4.0`, the npm `latest` release checked on October 27, 2026, and its matching tool versions. The original Vite+ `1.3.0` reproduction remains available at [commit `70ef7fa`](https://github.com/why-reproductions-are-required/vite-plus-lsp-config-root-3217/tree/70ef7fa32b42afee6af90d4a695235e63c613b84).

Retested after `npm ci` with Node.js `24.22.1` on macOS arm64: dependency verification confirmed one shared Vite+ core instance, and all 16 matrix cases, the CLI helper comparison, and all four LSP cases matched the expected outcomes below. The wrong-root config error still occurs with Vite+ `1.4.0`.

| Package | Version |
| --- | --- |
| `vite-plus` | `1.4.0` |
| `vite` | `npm:@voidzero-dev/vite-plus-core@1.4.0` (bundled Vite `8.3.5`) |
| `oxlint` | `1.89.0` |
| `oxfmt` | `0.74.0` |
| `@tanstack/react-start` | `1.169.4` |

The lockfile also pins transitive dependencies, including `@tanstack/start-plugin-core@1.171.55`, as required by this React Start release. Use `npm ci` to keep these versions.

### Shared Vite instance

Following the [Vite+ manual installation guide](https://viteplus.dev/guide/local-cli#manual-installation), the direct `vite` dependency and the root override both use `npm:@voidzero-dev/vite-plus-core@1.4.0`. The matching specifications also avoid npm's `EOVERRIDE` error. The Vitest override matches Vite+'s bundled version:

```json
{
  "dependencies": {
    "vite": "npm:@voidzero-dev/vite-plus-core@1.4.0",
    "vite-plus": "1.4.0"
  },
  "overrides": {
    "vite": "npm:@voidzero-dev/vite-plus-core@1.4.0",
    "vitest": "5.0.5"
  }
}
```

Vite+, TanStack Start, Vitest, and other Vite consumers must resolve the same core package; there must be no standalone Vite installation. `npm run verify:deps` checks the lockfile, installed package identities, dependency resolution from the fixtures and Vite consumers, and the runtime identity of `resolveConfig` exported by `vite` and `vite-plus`. It also runs first in `npm test`. Results are saved in `results/dependencies.json`.

## Fixtures

```text
fixtures/
  other/                     # First workspace folder; empty lint/fmt config
  plain/
    vite.config.ts           # TanStack Start, no root, no lint/fmt fields
    src/router.tsx
    src/routes/__root.tsx
  custom/
    vite.config.ts           # TanStack Start with root: "app"
    app/src/router.tsx
    app/src/routes/__root.tsx
```

The fixtures share the repository's installed dependencies. `plain` denotes the default-root config without `lint` or `fmt` fields. Its `vite` declaration also uses the Vite+ core alias. This setup verifies the root-resolution bug with a correctly unified Vite+ toolchain.

## Config-resolution matrix

```sh
npm run repro
```

Each case runs in a separate Node process. `project` means the target config's directory; `other` means the sibling workspace folder.

| Loading method | No root, cwd=project | No root, cwd=other | root="app", cwd=project | root="app", cwd=other |
| --- | --- | --- | --- | --- |
| Current `resolveConfig({ configFile }, "build")` | OK | FAIL | OK | FAIL |
| Add inline `root: configDir` | OK | OK | FAIL | FAIL |
| Load user config, resolve its root from configDir | OK | OK | OK | OK |
| Actual Oxlint config loader | OK | FAIL | OK | FAIL |

The current loader searches in `other/src` instead of `plain/src`. The inline-root experiment fixes that case but overrides the custom config's `root: "app"`, so it searches in `custom/src` instead of `custom/app/src`.

To see the original error directly:

```sh
node scripts/resolve.mjs current plain other
```

This individual command intentionally exits with code 1 and prints an error containing:

```text
Could not resolve entry for router entry: router in .../fixtures/other/src
```

Its successful control is:

```sh
node scripts/resolve.mjs current plain project
```

Results: `results/matrix.json`.

## Actual LSP sessions

```sh
npm run repro:lsp
```

This starts the installed Oxlint and Oxfmt servers with `--lsp` in Vite+ mode, sends JSON-RPC initialization and document messages, and shuts them down afterward. The workspace folder list stays `[other, plain]`; only the server process's working directory changes.

| Server | cwd=plain | cwd=other |
| --- | --- | --- |
| Oxlint LSP | Config loads | Config error referring to `other/src` |
| Oxfmt LSP | Config loads | Config error referring to `other/src` |

Temporary fixture copies isolate the sessions from any ancestor `vite.config.ts`. The script cleans them up after each session. Full protocol messages are saved in `results/lsp-*.json`; the summary is in `results/lsp-summary.json`.

The servers remain alive and shut down normally. The minimal failing fixture can still receive default lint diagnostics and formatting edits. This reproduces **config loading failure**, not a guaranteed loss of all linting or formatting.

The script explicitly selects Vite+ mode. It does not test the VS Code extension's binary-selection logic. `repro.code-workspace` contains the same two folders for optional manual inspection with the Oxc extension; that GUI path was not used for the automated verification.

## CLI helper comparison

```sh
npm run repro:cli
```

This invokes the private `resolveViteConfig()` helper from the pinned `vite-plus@1.4.0` bundle. With the process already in the target project, the plain config succeeds but `root: "app"` fails. The helper passes an inline `root: cwd`, which overrides the user's root.

Results: `results/cli-helper.json`. The bundle filename is specific to the pinned release.

## Scope of the proposed root calculation

The `preserve` experiment calculates:

```js
path.resolve(path.dirname(configFile), loaded.config.root ?? '')
```

It confirms the root-resolution direction discussed in the issue. It is not a production patch: loading the config first and then using `configFile: false` changes other semantics, including `inlineConfig`, SSR detection, and metadata visible to `configResolved` hooks. Plugins can still execute side effects during config loading unless they are wrapped with `lazyPlugins`.

## Related discussion

- [Original issue #3217](https://github.com/voidzero-dev/vite-plus/issues/3217)
- [Root handling and proposed shared API](https://github.com/voidzero-dev/vite-plus/issues/3217#issuecomment-6431179065)
- [Oxc extension multi-root binary selection #145](https://github.com/oxc-project/oxc-vscode/issues/145)
- [Multi-root Vite+ integration #418](https://github.com/oxc-project/oxc-vscode/issues/418)
