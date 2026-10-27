import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const base = fileURLToPath(new URL('../', import.meta.url));
const baseline = process.argv.includes('--baseline');
const mode = baseline ? 'baseline' : 'patched';
const normalize = value => value?.replaceAll('\\', '/') ?? null;
const records = [];

for (const caseName of ['observe', 'requires-config-file', 'lazy-plugins']) {
  // Each config must load in a fresh process with no inherited NODE_ENV state.
  const child = spawnSync(process.execPath, [
    path.join(base, 'scripts/compatibility-case.mjs'),
    caseName,
    ...(baseline ? ['--baseline'] : []),
  ], { cwd: base, encoding: 'utf8', timeout: 30_000 });

  let record;
  try {
    assert.equal(child.status, 0, child.error?.message ?? child.stderr);
    const line = child.stdout.trim().split('\n').at(-1);
    const result = JSON.parse(line);
    record = { caseName, passed: false, result };
    const { state } = result;
    const expectedFailure = !baseline && caseName === 'requires-config-file';

    assert.equal(result.ok, !expectedFailure, result.error);
    assert.equal(state.moduleLoads, 1, 'Config module must evaluate once');
    assert.equal(state.factoryCalls, 1, 'Async config factory must evaluate once');
    assert.equal(state.dependencyMarker, 'compatibility-probe');
    assert.equal(state.moduleNodeEnv, baseline ? 'development' : null);
    assert.equal(state.factoryNodeEnv, baseline ? 'development' : null);
    assert.equal(state.factoryEnv.isSsrBuild, false);
    assert.equal(state.applyEnv.isSsrBuild, !baseline);
    assert.equal(state.configEnv.isSsrBuild, !baseline);
    assert.equal(state.ssrApply, !baseline);
    assert.equal(state.ssrHookCalls, baseline ? 0 : 1);
    assert.equal(state.lazyFactoryCalls, 0, 'Metadata resolution must skip lazy plugin factories');
    assert.equal(result.metadataMarkerAfter, null, 'Metadata guard must restore the environment');

    const hook = state.resolvedHook;
    assert.equal(normalize(hook.root), normalize(result.expectedRoot), 'The relative user root must be retained');
    assert.equal(normalize(hook.configFile), baseline ? normalize(result.configFile) : null);
    assert.equal(baseline ? normalize(hook.inlineConfigFile) : hook.inlineConfigFile,
      baseline ? normalize(result.configFile) : false);
    assert.equal(hook.inlineHasUserMarker, !baseline);
    if (baseline) {
      assertDependencies(hook.dependencies, result.configFile);
      assert.equal(hook.inlineKeys.includes('root'), false);
      assert.equal(hook.inlineKeys.includes('plugins'), false);
    } else {
      assert.deepEqual(hook.dependencies, []);
      assert.equal(hook.inlineKeys.includes('root'), true);
      assert.equal(hook.inlineKeys.includes('plugins'), true);
    }

    if (expectedFailure) {
      assert.equal(result.error, 'The plugin requires config.configFile during configResolved');
      record.knownIncompatibility = 'A plugin that requires configFile in configResolved fails before the helper can restore it.';
    } else {
      assert.equal(normalize(result.returned.root), normalize(result.expectedRoot));
      assert.equal(normalize(result.returned.configFile), normalize(result.configFile));
      assertDependencies(result.returned.dependencies, result.configFile);
      assert.equal(baseline ? normalize(result.returned.inlineConfigFile) : result.returned.inlineConfigFile,
        baseline ? normalize(result.configFile) : false);
      assert.equal(result.returned.inlineHasUserMarker, !baseline);
    }
    record.passed = true;
  } catch (error) {
    record ??= { caseName, passed: false, stdout: child.stdout, stderr: child.stderr };
    record.failure = error.message;
  }
  records.push(record);
  console.log(`${record.passed ? 'PASS' : 'FAIL'} ${mode}: ${caseName}${record.knownIncompatibility ? ' (known incompatibility confirmed)' : ''}`);
  if (record.failure) console.error(record.failure);
}

function assertDependencies(dependencies, configFile) {
  const normalized = dependencies.map(file => file.replaceAll('\\', '/'));
  assert.ok(normalized.includes(configFile.replaceAll('\\', '/')), 'Config dependency must be retained');
  assert.ok(normalized.some(file => file.endsWith('/probes/dependency.mjs')), 'Imported dependency must be retained');
}

const passed = records.every(record => record.passed);
const directory = path.join(base, 'results', mode);
await mkdir(directory, { recursive: true });
await writeFile(path.join(directory, 'compatibility.json'), `${JSON.stringify({
  mode,
  passed,
  purpose: 'Check the exact proposal, including expected compatibility differences. A passing suite does not imply production readiness.',
  records,
}, null, 2)}\n`);
process.exitCode = passed ? 0 : 1;
