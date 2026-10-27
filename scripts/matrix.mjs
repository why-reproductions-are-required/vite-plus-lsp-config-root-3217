import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { baseline, mode, assertInstalledState } from './installed-state.mjs';

const base = fileURLToPath(new URL('../', import.meta.url));
assertInstalledState();
const normalize = value => value.replaceAll('\\', '/');
const methods = ['current', 'inline', 'api', 'oxlint'];
const results = [];
let mismatches = 0;
console.log('method     fixture  cwd      actual   expected');
for (const method of methods) {
  for (const fixture of ['plain', 'custom']) {
    for (const cwd of ['project', 'other']) {
      const child = spawnSync(process.execPath, [path.join(base, 'scripts/resolve.mjs'), method, fixture, cwd, ...(baseline ? ['--baseline'] : [])], {
        cwd: base, encoding: 'utf8', timeout: 30_000,
      });
      let result;
      try { result = JSON.parse(child.stdout.trim().split('\n').at(-1)); } catch {}
      const expectedOk = method === 'api' || (!baseline && method === 'oxlint')
        || (method === 'inline' ? fixture === 'plain' : cwd === 'project');
      const errorText = result?.error ?? result?.raw?.Failures?.map(failure => failure.error).join('\n') ?? '';
      const expectedErrorDirectory = path.join(base, 'fixtures', method === 'inline' ? fixture : 'other', 'src');
      const normalizedError = errorText.replaceAll('\\', '/');
      // With a user-relative root, TanStack reports the relative app/src path.
      const expectedPath = method !== 'inline' && fixture === 'custom'
        ? 'app/src' : expectedErrorDirectory.replaceAll('\\', '/');
      const matched = result?.ok === expectedOk
        && child.status === (expectedOk ? 0 : 1)
        && (method !== 'api' || normalize(result?.root ?? '') === normalize(path.join(base, 'fixtures', fixture, fixture === 'custom' ? 'app' : '')))
        && (expectedOk || (normalizedError.includes('Could not resolve entry for router entry: router in ')
          && normalizedError.includes(expectedPath)));
      if (!matched) mismatches++;
      console.log(`${method.padEnd(10)} ${fixture.padEnd(8)} ${cwd.padEnd(8)} ${(result?.ok === true ? 'OK' : result?.ok === false ? 'FAIL' : 'ERROR').padEnd(8)} ${expectedOk ? 'OK' : 'FAIL'}${matched ? '' : '  MISMATCH'}`);
      results.push({ method, fixture, cwd, expectedOk, matched, status: child.status,
        result, stdout: child.stdout, stderr: child.stderr, error: child.error?.message });
    }
  }
}
mkdirSync(path.join(base, 'results', mode), { recursive: true });
writeFileSync(path.join(base, 'results', mode, 'matrix.json'), JSON.stringify(results, null, 2) + '\n');
console.log(mismatches ? `Unexpected outcomes: ${mismatches}. See results/${mode}/matrix.json.`
  : `All ${results.length} ${mode} cases matched. Raw resolveConfig controls still reproduce the bug. See results/${mode}/matrix.json.`);
process.exitCode = mismatches ? 1 : 0;
