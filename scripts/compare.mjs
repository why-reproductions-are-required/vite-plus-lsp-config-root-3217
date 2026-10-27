import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const patchPackage = path.join(root, 'node_modules/patch-package/index.js');
const steps = [];
let passed = false;
let restored = false;

function run(label, script, args = [], timeout = 180_000) {
  console.log(`\n${label}`);
  const started = Date.now();
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    stdio: 'inherit',
    timeout,
  });
  steps.push({ label, status: result.status, signal: result.signal,
    elapsedMs: Date.now() - started, error: result.error?.message });
  if (result.error || result.status !== 0) {
    throw new Error(`${label} failed: ${result.error?.message ?? result.signal ?? result.status}`);
  }
}

function applyPatches() {
  run('Apply local dependency patches', patchPackage, ['--error-on-fail']);
  restored = true;
}

function runSuite(mode) {
  for (const script of ['matrix', 'cli-helper', 'lsp', 'compatibility']) {
    run(`${mode}: ${script}`, path.join(root, `scripts/${script}.mjs`),
      mode === 'baseline' ? ['--baseline'] : []);
  }
}

try {
  // Applying twice is safe and also supports starting from reversed patches.
  applyPatches();
  run('Verify the shared Vite+ core dependency', path.join(root, 'scripts/verify-deps.mjs'));
  restored = false;
  run('Restore original dependency files for the baseline', patchPackage, ['--reverse', '--error-on-fail']);
  runSuite('baseline');
  applyPatches();
  runSuite('patched');
  passed = true;
} catch (error) {
  console.error(error.message);
} finally {
  if (!restored) {
    try { applyPatches(); } catch (error) { console.error(error.message); }
  }
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  mkdirSync(path.join(root, 'results'), { recursive: true });
  writeFileSync(path.join(root, 'results/comparison.json'), `${JSON.stringify({
    passed,
    patchesApplied: restored,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    dependencies: manifest.dependencies,
    steps,
  }, null, 2)}\n`);
}

console.log(passed
  ? '\nBoth modes matched their expected outcomes, including known compatibility differences.'
  : '\nComparison failed. Inspect the output and results/comparison.json.');
console.log(restored ? 'Local patches are applied.' : 'Could not restore patches. Run npm ci before retrying.');
process.exitCode = passed && restored ? 0 : 1;
