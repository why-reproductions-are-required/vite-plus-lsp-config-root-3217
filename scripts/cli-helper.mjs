import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as vitePlusApi from 'vite-plus';
// Private bundle entry from the exact pinned vite-plus@1.4.0 release.
import { a as resolveViteConfig, n as findViteConfigUp } from '../node_modules/vite-plus/dist/resolve-vite-config-Dn5896A4.js';
import { findMonorepoRoot } from '../node_modules/vite-plus/binding/index.js';

const base = fileURLToPath(new URL('../', import.meta.url));
const baseline = process.argv.includes('--baseline');
const mode = baseline ? 'baseline' : 'patched';
const normalize = value => value?.replaceAll('\\', '/');
if ((typeof vitePlusApi.resolveConfigFile === 'function') === baseline) {
  throw new Error(`Expected ${mode} dependencies. Use npm run patch:${baseline ? 'revert' : 'apply'}.`);
}
const results = [];
for (const fixture of ['plain', 'custom']) {
  for (const cwd of ['project', 'other']) {
    const project = path.join(base, 'fixtures', fixture);
    process.chdir(cwd === 'project' ? project : path.join(base, 'fixtures/other'));
    try {
      const config = await resolveViteConfig(project);
      results.push({ fixture, cwd, ok: true, root: config.root });
    } catch (error) {
      results.push({ fixture, cwd, ok: false, error: error.message, stack: error.stack });
    }
  }
}
for (const result of results) {
  const error = result.error?.replaceAll('\\', '/') ?? '';
  result.matched = baseline && result.fixture === 'custom'
    ? !result.ok && error.includes('Could not resolve entry for router entry: router in ')
      && error.includes(path.join(base, 'fixtures/custom/src').replaceAll('\\', '/'))
    : result.ok && normalize(result.root) === normalize(path.join(base, 'fixtures', result.fixture, result.fixture === 'custom' ? 'app' : ''));
}

// Isolate fallback and parent-config discovery from repository and ancestor configs.
// Expand Windows short names so expected paths match Vite's native realpath.
const sandbox = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'vite-plus-3217-cli-')));
try {
  const noConfig = path.join(sandbox, 'no-config');
  mkdirSync(noConfig);
  process.chdir(noConfig);
  try {
    assert.equal(findViteConfigUp(noConfig, path.parse(noConfig).root), undefined,
      'The fallback fixture must have no ancestor Vite config');
    const config = await resolveViteConfig(noConfig);
    results.push({ fixture: 'no-config', cwd: 'project', ok: true, root: config.root,
      configFile: config.configFile ?? null, expectedRoot: noConfig,
      matched: normalize(config.root) === normalize(noConfig) && config.configFile === undefined });
  } catch (error) {
    results.push({ fixture: 'no-config', cwd: 'project', ok: false, matched: false,
      error: error.message, stack: error.stack });
  }

  const workspace = path.join(sandbox, 'workspace');
  const child = path.join(workspace, 'packages/child');
  const app = path.join(workspace, 'app');
  const configFile = path.join(workspace, 'vite.config.mjs');
  mkdirSync(child, { recursive: true });
  mkdirSync(app);
  // The pinned native helper recognizes package.json workspaces as a monorepo.
  writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({
    name: 'parent-config-workspace', private: true, workspaces: ['packages/*'],
  }));
  writeFileSync(path.join(child, 'package.json'), JSON.stringify({ name: 'child-project', private: true }));
  writeFileSync(configFile, "export default { root: 'app', lint: { rules: { 'no-console': 'error' } } };\n");
  process.chdir(child);
  try {
    const discoveredWorkspaceRoot = findMonorepoRoot(child);
    assert.equal(normalize(discoveredWorkspaceRoot), normalize(workspace),
      'The pinned helper must detect the temporary workspace');
    const config = await resolveViteConfig(child, { traverseUp: true });
    const expectedRoot = baseline ? child : app;
    results.push({ fixture: 'traverse-up', cwd: 'child', ok: true, root: config.root,
      configFile: config.configFile ?? null, expectedRoot, discoveredWorkspaceRoot,
      matched: normalize(config.root) === normalize(expectedRoot)
        && normalize(config.configFile) === normalize(configFile)
        && config.lint?.rules?.['no-console'] === 'error' });
  } catch (error) {
    results.push({ fixture: 'traverse-up', cwd: 'child', ok: false, matched: false,
      error: error.message, stack: error.stack });
  }
} finally {
  process.chdir(base);
  rmSync(sandbox, { recursive: true, force: true });
}

for (const result of results) {
  console.log(`${result.fixture}, cwd=${result.cwd}: ${result.ok ? 'OK' : 'FAIL'} (${result.matched ? 'expected' : 'unexpected'})`);
}
mkdirSync(path.join(base, 'results', mode), { recursive: true });
writeFileSync(path.join(base, 'results', mode, 'cli-helper.json'), JSON.stringify(results, null, 2) + '\n');
console.log(`CLI helper results: results/${mode}/cli-helper.json`);
process.exitCode = results.every(result => result.matched) ? 0 : 1;
