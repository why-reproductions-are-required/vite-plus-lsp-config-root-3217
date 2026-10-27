# Vite+ LSP config root: preview integration

Reproduces [voidzero-dev/vite-plus#3217](https://github.com/voidzero-dev/vite-plus/issues/3217) with the published [PR #3249 preview](https://github.com/voidzero-dev/vite-plus/pull/3249#issuecomment-6434827450), built from commit `ba6364a0574e955a2886e4d06fa02eea2b2c24fa`.

Oxlint and Oxfmt in Vite+ mode load the correct `vite.config.ts`, but their existing loader calls `resolveConfig({ configFile }, 'build')`. Plugin entry resolution can then use the server's working directory. In a workspace with multiple folders, TanStack Start searches for `router.tsx` in the wrong project.

The preview provides `resolveConfigFile()` and connects the CLI config helper to it. Its bundled Oxlint and Oxfmt releases still use the old API. This repository keeps two small patches that switch those consumers to the published API. **There is no local Vite+ implementation patch.**

## Quick start

Use Node.js 24 or newer. `.node-version` pins Node.js `24.22.1` for CI.

```sh
git clone --branch experiment/shared-config-api https://github.com/why-reproductions-are-required/vite-plus-lsp-config-root-3217.git
cd vite-plus-lsp-config-root-3217
npm ci
npm run compare
```

The repository's `.npmrc` uses `https://registry-bridge.viteplus.dev/`, which serves the preview and proxies other packages to npm. `npm ci` installs the pinned build and applies the two Oxc patches through `postinstall`. Keep development dependencies and install scripts enabled. If you install with `--ignore-scripts`, run `npm run patch:apply` afterward.

`npm run compare` checks the shared Vite+ dependency, reverses the Oxc patches, runs the unmodified-preview cases, reapplies the patches, and runs the adapted-consumer cases. It leaves the Oxc patches applied, including after a reported check failure. The Vite+ package stays unchanged throughout the comparison.

Do not run the comparison concurrently with another command that uses this installation. If the process is forcibly terminated, run `npm ci` to restore a known state. No global Vite+ installation or running editor is required. The fixtures exercise config loading; they are not complete web applications.

**Exit code 0 means all outcomes matched their expectations.** The unmodified preview must still reproduce the LSP root error. The compatibility probes also include an intentional plugin failure. A passing suite does not imply full API compatibility or production readiness.

## What the two patches change

| Patch | Change |
| --- | --- |
| [`oxlint+1.89.0.patch`](patches/oxlint+1.89.0.patch) | Call the preview's `resolveConfigFile(path)` when extracting the `lint` field. |
| [`oxfmt+0.74.0.patch`](patches/oxfmt+0.74.0.patch) | Call the preview's `resolveConfigFile(path)` when extracting the `fmt` field. |

Both patches change the config-loading call site. The root calculation, metadata guard, CLI integration, CommonJS export, and public TypeScript declarations come from the published preview.

The upstream API loads the user config once and resolves its `root` relative to the loaded config file's directory. It passes the loaded object to `resolveConfig()` with `configFile: false`, then restores `configFile` and `configFileDependencies` on the returned object. The metadata guard skips `lazyPlugins` factories.

## Comparison modes

| Mode | Vite+ implementation | Oxc config loaders | Results directory |
| --- | --- | --- | --- |
| `--baseline` | Published preview | Original `resolveConfig()` calls | `results/preview/` |
| Default | Same published preview | Two patches call `resolveConfigFile()` | `results/adapted/` |

The new API and the fixed CLI helper are present in both modes. Reversing the patches only restores the original Oxlint and Oxfmt call sites.

The compatibility suite compares APIs inside this same preview: `--baseline` uses `resolveConfig()` as the control, while the default uses `resolveConfigFile()`. It does not compare two Vite+ versions.

| Command | Purpose |
| --- | --- |
| `npm run compare` | Run both modes, then leave the Oxc patches applied. |
| `npm test` | Run all checks with the adapted Oxc consumers. |
| `npm run verify:deps` | Check that every Vite consumer uses the same preview core installation. |
| `npm run repro` | Run the config-resolution matrix and its controls. |
| `npm run repro:lsp` | Run actual Oxlint and Oxfmt LSP sessions. |
| `npm run repro:cli` | Call the preview's CLI config helper. |
| `npm run test:compat` | Check known differences between the config APIs. |
| `npm run patch:revert` / `npm run patch:apply` | Manually switch the Oxc call sites. |

For a single unmodified-preview check:

```sh
npm run patch:revert
node scripts/lsp.mjs --baseline
npm run patch:apply
```

Full results are saved under the ignored `results/` directory:

- `comparison.json`: command status, runtime, package versions, and final patch state.
- `dependencies.json`: shared preview core verification.
- `preview/` and `adapted/`: `matrix.json`, `cli-helper.json`, `lsp-summary.json`, full `lsp-*.json` protocol logs, and `compatibility.json`.

## Expected root behavior

Each mode covers two configs. `plain` has no explicit `root`, `lint`, or `fmt`. `custom` has `root: 'app'`, `lint.rules['no-console']: 'error'`, and `fmt.semi: false`. Each runs from both the config directory and the sibling `other` directory.

| Consumer | Config / working directory | Unmodified preview | Preview with Oxc patches |
| --- | --- | --- | --- |
| `resolveConfigFile()` | Default or custom root, either cwd | Correct root | Correct root |
| Oxlint and Oxfmt LSP | Default root, cwd=project | Config loads | Config loads |
| Oxlint and Oxfmt LSP | Default root, cwd=other | Wrong-root config error | Config loads |
| Oxlint and Oxfmt LSP | `root: 'app'`, cwd=project | Config loads | Config loads |
| Oxlint and Oxfmt LSP | `root: 'app'`, cwd=other | Wrong-root config error | Config loads |
| CLI config helper | Default or custom root, either cwd | Config loads | Config loads |
| CLI config helper | No config file | Root is the requested directory | Same root |
| CLI helper with `traverseUp: true` | Parent config has `root: 'app'` | Root is the parent's `app` directory | Same root |

Each mode includes 16 matrix cases, six CLI cases, eight LSP cases, and three compatibility probes. The matrix uses four methods: raw `resolveConfig()`, an inline-root control, the published `resolveConfigFile()`, and the actual Oxlint loader.

The raw API still fails from the other directory. Adding inline `root: configDir` fixes the default-root case but overwrites `root: 'app'`. The published API succeeds in all four root/cwd combinations. The Oxlint loader does so only after applying its call-site patch.

To see the raw API error directly while the Oxc patches are applied:

```sh
node scripts/resolve.mjs current plain other
```

This command intentionally exits with code 1 and reports `Could not resolve entry for router entry: router in .../fixtures/other/src`.

### Actual LSP behavior

The runner starts the installed binaries with `--lsp` in Vite+ mode, sends JSON-RPC initialization and document messages, and shuts each server down. Workspace folders stay `[other, target]`; the server's working directory changes independently. Temporary fixture copies prevent ancestor configs from affecting discovery.

A successful custom case must produce the configured `no-console` diagnostic or formatting without semicolons. Every session must complete its operation and exit cleanly.

The unmodified consumers can still return default lint diagnostics or formatting after a config error. The bug is a config-loading failure, not a guaranteed loss of all linting or formatting. The script does not test the VS Code extension's binary-selection logic. `repro.code-workspace` is available for optional manual inspection; the automated run does not use an editor.

## Compatibility differences

These probes use fresh processes and unset `NODE_ENV` before loading the config. Both APIs use the metadata-resolution guard. The working directory is the config directory, which separates API differences from the wrong-root problem.

| Observation | Raw `resolveConfig()` control | Published `resolveConfigFile()` |
| --- | --- | --- |
| Config module and async factory evaluation | Once each | Once each |
| Relative user root | Retained | Retained |
| `lazyPlugins` factory during metadata resolution | Skipped | Skipped |
| `NODE_ENV` during config evaluation, when initially unset | `development` | Unset |
| `isSsrBuild` in plugin `apply` and `config` for a user config with `build.ssr` | `false` | `true` |
| SSR-only probe plugin selected by `apply` | Skipped | Runs |
| `configFile` / `configFileDependencies` inside `configResolved` | Path / dependencies | `undefined` / empty array |
| Returned config metadata | Path / dependencies | Restored after hooks finish |
| `inlineConfig` | Caller-supplied config-file option | Loaded user config, absolute root, and `configFile: false` |
| Plugin that requires `configFile` in `configResolved` | Succeeds | Throws before metadata can be restored |

The final row is an intentional failing plugin. Its probe passes only if the incompatibility is observed. Restoring metadata after `resolveConfig()` does not restore what hooks saw while it ran.

The preview also changes CLI parent-config behavior relative to Vite+ `1.4.0`. With `traverseUp: true`, the older helper kept the child package directory as the root. The preview resolves the parent's declared root from the parent config directory. Both modes in this repository use that new behavior.

The API does not change `process.cwd()`, so plugins that read it directly can still depend on the launch directory. Plugins can also execute side effects during config loading unless their work is deferred with `lazyPlugins`. These limits remain relevant even when the root cases pass.

## Pinned dependencies and Vite override

The exact preview version is `0.0.0-commit.ba6364a0574e955a2886e4d06fa02eea2b2c24fa`. Both `vite-plus` and its core use that version. The lockfile pins the remaining dependencies.

| Package | Version |
| --- | --- |
| `vite-plus` | Exact preview above |
| `vite` | Alias to `@voidzero-dev/vite-plus-core` at the same preview version |
| `oxlint` | `1.89.0` |
| `oxfmt` | `0.74.0` |
| `@tanstack/react-start` | `1.169.4` |
| `patch-package` | `8.0.1` |

Following the [Vite+ manual installation guide](https://viteplus.dev/guide/local-cli#manual-installation), the direct `vite` dependency and root override use the same core alias. The Vitest override matches the bundled version:

```json
{
  "dependencies": {
    "vite": "npm:@voidzero-dev/vite-plus-core@0.0.0-commit.ba6364a0574e955a2886e4d06fa02eea2b2c24fa",
    "vite-plus": "0.0.0-commit.ba6364a0574e955a2886e4d06fa02eea2b2c24fa"
  },
  "overrides": {
    "vite": "npm:@voidzero-dev/vite-plus-core@0.0.0-commit.ba6364a0574e955a2886e4d06fa02eea2b2c24fa",
    "vitest": "5.0.5"
  }
}
```

`verify:deps` checks the lockfile, installed package identities, physical paths, and the runtime identity of `resolveConfig` exported by `vite` and `vite-plus`. All consumers must resolve one preview core installation, with no standalone Vite installation.

## GitHub Actions

The [verification workflow](.github/workflows/verify.yml) runs on pull requests and pushes to `main`. It uses Linux, macOS, and Windows runners with the Node.js version from `.node-version`.

Each job runs `npm ci` and `npm run compare`. Unexpected outcomes fail the job; expected failures remain part of the comparison. The workflow uploads `results/` as a separate artifact for each platform, including when a check fails. Artifacts are retained for 14 days. If installation fails before results exist, inspect the job log.

## Earlier reproductions

- [Vite+ `1.4.0` without local patches (`09f4b84`)](https://github.com/why-reproductions-are-required/vite-plus-lsp-config-root-3217/tree/09f4b845acafc707482a2105a09b584f41697bf9): original reproduction with the complete Vite+ core override.
- [Local implementation experiment (`85093c9`)](https://github.com/why-reproductions-are-required/vite-plus-lsp-config-root-3217/tree/85093c91638f81282f2f6420dfab3b93b4b5b652): earlier version that patched Vite+ itself. This branch now uses the published preview instead.

## Related discussion

- [Original issue #3217](https://github.com/voidzero-dev/vite-plus/issues/3217)
- [Shared API implementation in PR #3249](https://github.com/voidzero-dev/vite-plus/pull/3249)
- [Preview build and registry instructions](https://github.com/voidzero-dev/vite-plus/pull/3249#issuecomment-6434827450)
- [Oxc extension multi-root binary selection #145](https://github.com/oxc-project/oxc-vscode/issues/145)
- [Multi-root Vite+ integration #418](https://github.com/oxc-project/oxc-vscode/issues/418)
