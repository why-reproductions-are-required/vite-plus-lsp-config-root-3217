# Vite+ LSP config root: local patch experiment

Reproduces [voidzero-dev/vite-plus#3217](https://github.com/voidzero-dev/vite-plus/issues/3217) and applies [leaysgur's proposed shared config API](https://github.com/voidzero-dev/vite-plus/issues/3217#issuecomment-6431179065) to installed packages.

Oxlint and Oxfmt in Vite+ mode load the correct `vite.config.ts`, but plugin entry resolution can use the server's working directory. In a workspace with multiple folders, TanStack Start then searches for `router.tsx` in the wrong project. The CLI config helper has a related problem: its inline `root` overrides the user's `root`.

This branch uses `patch-package` to add an experimental `resolveConfigFile()` API and connect the actual Oxlint, Oxfmt, and CLI config loaders to it. No upstream Vite+ build or release is required. The root cases pass with this patch, but the exact proposal still changes other config semantics. The compatibility probes make those differences visible.

## Quick start

Use Node.js 24 or newer. The experiment was verified with Node.js `24.22.1` on macOS arm64; `.node-version` records that version.

```sh
git clone --branch experiment/shared-config-api https://github.com/why-reproductions-are-required/vite-plus-lsp-config-root-3217.git
cd vite-plus-lsp-config-root-3217
npm ci
npm run compare
```

`npm ci` applies the three committed patches through `postinstall`. Keep development dependencies and install scripts enabled. If you deliberately install with `--ignore-scripts`, run `npm run patch:apply` afterward.

`npm run compare` verifies the shared Vite+ dependency, reverses the patches, runs the baseline, reapplies the patches, and runs the patched cases. It leaves the patches applied, including after a reported check failure. Do not run it concurrently with another command that uses this installation. If the process is forcibly terminated, run `npm ci` to restore a known state.

No global Vite+ installation or running editor is required. The scripts use the Node executable that runs them. The fixtures exercise config loading; they are not complete web applications.

**Exit code 0 means all outcomes matched their expectations.** Expected root failures remain visible in the baseline and control rows. A known compatibility failure is also expected in the patched probes. A passing suite does not mean that the proposal is production-ready.

## Local patches

| Patch | Change |
| --- | --- |
| [`vite-plus+1.4.0.patch`](patches/vite-plus+1.4.0.patch) | Export `resolveConfigFile()` and use it in the CLI config helper when a config file is found. |
| [`oxlint+1.89.0.patch`](patches/oxlint+1.89.0.patch) | Call the shared API when extracting the `lint` field. |
| [`oxfmt+0.74.0.patch`](patches/oxfmt+0.74.0.patch) | Call the shared API when extracting the `fmt` field. |

The API loads the user config once, resolves its `root` relative to the config directory, and passes that object to `resolveConfig()` with `configFile: false`. It restores `configFile` and `configFileDependencies` on the returned config. It also uses Vite+'s metadata-resolution guard to skip `lazyPlugins` factories.

```js
const loaded = await loadConfigFromFile(configEnv, configFile);
const root = path.resolve(path.dirname(configFile), loaded.config.root ?? '');
const config = await resolveConfig({ ...loaded.config, root, configFile: false }, 'build');
config.configFile = loaded.path;
config.configFileDependencies = loaded.dependencies;
```

The patch changes the pinned ESM bundles only. It does not add a CommonJS export or public TypeScript declarations. Bundle names and private helper imports are specific to these releases. This is an executable experiment, not a complete upstream API implementation.

## Commands and results

| Command | Purpose |
| --- | --- |
| `npm run compare` | Run the original and patched packages, then leave patches applied. |
| `npm test` | Run all checks against patched packages only. |
| `npm run verify:deps` | Verify every Vite consumer uses the same Vite+ core installation. |
| `npm run repro` | Run the config-resolution matrix and its controls. |
| `npm run repro:lsp` | Run actual Oxlint and Oxfmt LSP sessions. |
| `npm run repro:cli` | Call the CLI's config helper. |
| `npm run test:compat` | Check known API compatibility differences. |
| `npm run patch:revert` / `npm run patch:apply` | Manually switch installed dependency files. |

For a single baseline check, reverse the patches and pass `--baseline` to its script. Reapply them before running the default commands:

```sh
npm run patch:revert
node scripts/lsp.mjs --baseline
npm run patch:apply
```

Full results are saved under the ignored `results/` directory:

- `comparison.json`: command status, runtime, package versions, and final patch state.
- `dependencies.json`: shared Vite+ core verification.
- `baseline/` and `patched/`: `matrix.json`, `cli-helper.json`, `lsp-summary.json`, full `lsp-*.json` protocol logs, and `compatibility.json`.

## GitHub Actions

The [verification workflow](.github/workflows/verify.yml) runs on pull requests and pushes to `main`. It uses Linux, macOS, and Windows runners with the Node.js version from `.node-version`.

Each job runs `npm ci` and `npm run compare`. The comparison checks dependency overrides, config resolution, the CLI helper, real LSP sessions, and the known compatibility differences in both modes. Unexpected outcomes fail the job; expected failures remain part of the comparison.

The workflow uploads `results/` as a separate artifact for each platform, including when a check fails. Artifacts are retained for 14 days. If installation fails before results exist, inspect the job log.

## Root resolution results

Each mode covers two configs: `plain` has no explicit `root`, `lint`, or `fmt`; `custom` has `root: 'app'`, `lint.rules['no-console']: 'error'`, and `fmt.semi: false`. Each runs from both the config directory and the sibling `other` directory.

| Real consumer | Config / working directory | Original packages | Patched packages |
| --- | --- | --- | --- |
| Oxlint and Oxfmt LSP | Default root, cwd=project | Config loads | Config loads |
| Oxlint and Oxfmt LSP | Default root, cwd=other | Wrong-root config error | Config loads |
| Oxlint and Oxfmt LSP | `root: 'app'`, cwd=project | Config loads | Config loads |
| Oxlint and Oxfmt LSP | `root: 'app'`, cwd=other | Wrong-root config error | Config loads |
| CLI config helper | Default root, either cwd | Config loads | Config loads |
| CLI config helper | `root: 'app'`, either cwd | User root is overwritten; config fails | Config loads |
| CLI config helper | No config file | Root is the requested directory | Same root |
| CLI helper with `traverseUp: true` | Parent config has `root: 'app'` | Root is the child package directory | Root is the parent's `app` directory |

After a clean install, all 16 baseline matrix cases, 20 patched matrix cases, six CLI cases per mode, eight LSP cases per mode, and three compatibility probes per mode matched their expected outcomes.

The matrix retains two controls. Calling the original `resolveConfig({ configFile }, 'build')` still fails from the other directory because that API is unchanged. Adding inline `root: configDir` fixes the default-root case but overwrites `root: 'app'`. The new API and the patched Oxlint loader succeed in all four root/cwd combinations.

To see the raw API error directly while patches are applied:

```sh
node scripts/resolve.mjs current plain other
```

This command intentionally exits with code 1 and reports `Could not resolve entry for router entry: router in .../fixtures/other/src`.

### Actual LSP behavior

The runner starts the installed binaries with `--lsp` in Vite+ mode, sends JSON-RPC initialization and document messages, and shuts each server down. Workspace folders stay `[other, target]`; the server's working directory changes independently. Temporary fixture copies prevent ancestor configs from affecting discovery.

A successful custom case must produce the configured `no-console` diagnostic or formatting without semicolons. This confirms that the target config is used. Every session must also complete its operation and exit cleanly.

The unpatched servers can still return default lint diagnostics or formatting after a config error. The bug is a config-loading failure, not a guaranteed loss of all linting or formatting. The script does not test the VS Code extension's binary-selection logic. `repro.code-workspace` is available for optional manual inspection, but the automated run does not use an editor.

## Compatibility results

These probes use fresh processes and unset `NODE_ENV` before loading the config. Both modes use the metadata-resolution guard. Their working directory is the config directory, which separates API differences from the wrong-root problem.

| Observation | Original `resolveConfig()` | Proposed `resolveConfigFile()` |
| --- | --- | --- |
| Config module and async factory evaluation | Once each | Once each |
| Relative user root | Retained | Retained |
| `lazyPlugins` factory during metadata resolution | Skipped | Skipped |
| `NODE_ENV` during config module/factory evaluation, when initially unset | `development` | Unset |
| `isSsrBuild` in plugin `apply` and `config` for a user config with `build.ssr` | `false` | `true` |
| SSR-only probe plugin selected by `apply` | Skipped | Runs |
| `configFile` / `configFileDependencies` inside `configResolved` | Path / dependencies | `undefined` / empty array |
| Returned config metadata | Path / dependencies | Restored after hooks finish |
| `inlineConfig` | Caller-supplied config-file option | Loaded user config, absolute root, and `configFile: false` |
| Plugin that requires `configFile` in `configResolved` | Succeeds | Throws before metadata can be restored |

The final row is an intentional failing plugin. Its probe passes only if the incompatibility is observed. Restoring metadata after `resolveConfig()` does not restore what hooks saw while it ran.

The CLI's parent-config case is another behavior change. With `traverseUp: true`, the original helper keeps the child package directory as the root. The patched helper resolves the parent's declared root from the parent config directory. Existing monorepos that rely on the child directory need a compatibility decision.

These findings support the shared-API and config-relative-root approach, but the two-stage loading implementation needs more compatibility work before an upstream fix. It does not change `process.cwd()`, so a plugin that reads that value directly can still depend on the launch directory. Plugins can also execute side effects during config loading unless their work is deferred with `lazyPlugins`.

## Pinned dependencies and Vite override

| Package | Version |
| --- | --- |
| `vite-plus` | `1.4.0` |
| `vite` | `npm:@voidzero-dev/vite-plus-core@1.4.0` (bundled Vite `8.3.5`) |
| `oxlint` | `1.89.0` |
| `oxfmt` | `0.74.0` |
| `@tanstack/react-start` | `1.169.4` |
| `patch-package` | `8.0.1` |

Vite+ `1.4.0` was the npm `latest` release checked on October 27, 2026. The lockfile pins transitive dependencies, including `@tanstack/start-plugin-core@1.171.55`.

Following the [Vite+ manual installation guide](https://viteplus.dev/guide/local-cli#manual-installation), the direct `vite` dependency and root override use the same core alias. The Vitest override matches Vite+'s bundled version:

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

`verify:deps` checks the lockfile, installed package identities, physical paths, and the runtime identity of `resolveConfig` exported by `vite` and `vite-plus`. All 12 checked consumers resolve one core installation. There is no standalone Vite installation.

The unpatched reproduction with these overrides is preserved at [commit `09f4b84`](https://github.com/why-reproductions-are-required/vite-plus-lsp-config-root-3217/tree/09f4b845acafc707482a2105a09b584f41697bf9). The original Vite+ `1.3.0` version is at [commit `70ef7fa`](https://github.com/why-reproductions-are-required/vite-plus-lsp-config-root-3217/tree/70ef7fa32b42afee6af90d4a695235e63c613b84).

## Related discussion

- [Original issue #3217](https://github.com/voidzero-dev/vite-plus/issues/3217)
- [Root handling and proposed shared API](https://github.com/voidzero-dev/vite-plus/issues/3217#issuecomment-6431179065)
- [Oxc extension multi-root binary selection #145](https://github.com/oxc-project/oxc-vscode/issues/145)
- [Multi-root Vite+ integration #418](https://github.com/oxc-project/oxc-vscode/issues/418)
