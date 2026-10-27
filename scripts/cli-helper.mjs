import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// Private bundle entry from the exact pinned vite-plus@1.4.0 release.
import { a as resolveViteConfig } from '../node_modules/vite-plus/dist/resolve-vite-config-Dn5896A4.js';

const base = fileURLToPath(new URL('../', import.meta.url));
const results = [];
for (const fixture of ['plain', 'custom']) {
  const project = path.join(base, 'fixtures', fixture);
  process.chdir(project);
  try {
    const config = await resolveViteConfig(project);
    results.push({ fixture, ok: true, root: config.root });
  } catch (error) {
    results.push({ fixture, ok: false, error: error.message, stack: error.stack });
  }
}
mkdirSync(path.join(base, 'results'), { recursive: true });
writeFileSync(path.join(base, 'results/cli-helper.json'), JSON.stringify(results, null, 2) + '\n');
const customError = results[1].error?.replaceAll('\\', '/') ?? '';
const reproduced = results[0].ok && !results[1].ok
  && customError.includes('Could not resolve entry for router entry: router in ')
  && customError.includes(path.join(base, 'fixtures/custom/src').replaceAll('\\', '/'));
for (const result of results) console.log(`${result.fixture}: ${result.ok ? 'OK' : `FAIL: ${result.error}`}`);
console.log(reproduced ? 'Reproduced: the CLI helper overrides root: "app". See results/cli-helper.json.'
  : 'Unexpected outcome. See results/cli-helper.json.');
process.exitCode = reproduced ? 0 : 1;
