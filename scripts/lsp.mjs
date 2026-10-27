import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vitePlusPackage from 'vite-plus/package.json' with { type: 'json' };

const root = fileURLToPath(new URL('../', import.meta.url));
const baseline = process.argv.includes('--baseline');
const mode = baseline ? 'baseline' : 'patched';
const vitePlus = await import('vite-plus');
assert.equal(typeof vitePlus.resolveConfigFile === 'function', !baseline,
  `The installed vite-plus package does not match ${mode} mode. Apply or reverse the patch first.`);
const resultsDir = path.join(root, 'results', mode);
const timeoutMs = 20_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const normalize = (value) => value.replaceAll('\\', '/');
mkdirSync(resultsDir, { recursive: true });

async function run(tool, fixture, cwdName) {
  // Keep ancestor Vite configs from affecting automatic config discovery.
  // Use the same long Windows paths as Vite and the servers when creating URIs.
  const sandbox = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'vite-plus-3217-')));
  const events = [];
  let child;
  let closed;
  let processError;
  let stderr = '';
  let serverInfo;
  let formattingResult;
  let formattedText;
  let diagnostics;
  let error;
  let initialized = false;
  let shutdown = false;
  const pending = new Map();

  try {
    cpSync(path.join(root, 'fixtures'), path.join(sandbox, 'fixtures'), { recursive: true });
    symlinkSync(path.join(root, 'node_modules'), path.join(sandbox, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir');
    const project = path.join(sandbox, 'fixtures', fixture);
    const other = path.join(sandbox, 'fixtures', 'other');
    const cwd = cwdName === 'project' ? project : other;
    const folders = [
      { uri: pathToFileURL(other).href, name: 'other' },
      { uri: pathToFileURL(project).href, name: fixture },
    ];
    const file = path.join(project, fixture === 'custom' ? 'app/src' : 'src', 'example.ts');
    const fileUri = pathToFileURL(file).href;
    const source = readFileSync(file, 'utf8');
    const expectConfigError = baseline && cwdName === 'other';
    const args = [path.join(root, 'node_modules', tool, 'bin', tool), '--lsp'];
    events.push({ direction: 'launch', executable: process.execPath, args, cwd });
    child = spawn(process.execPath, args, {
      cwd,
      env: {
        ...process.env,
        VP_VERSION: vitePlusPackage.version,
        VP_COMMAND: tool === 'oxlint' ? 'lint' : 'fmt',
        VP_RESOLVING_CONFIG_METADATA: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const fail = (failure) => {
      processError ??= failure;
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(failure);
      }
      pending.clear();
    };
    child.on('error', fail);
    child.stdin.on('error', fail);
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('close', (code, signal) => {
      closed = { code, signal };
      if (pending.size) fail(new Error(`Server closed with pending requests (${code ?? signal}).`));
    });

    let nextId = 0;
    const send = (message) => {
      if (processError) throw processError;
      events.push({ direction: 'send', message });
      const body = JSON.stringify({ jsonrpc: '2.0', ...message });
      child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    };
    const request = (method, params) => new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}.`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try {
        send({ id, method, params });
      } catch (failure) {
        clearTimeout(timer);
        pending.delete(id);
        reject(failure);
      }
    });
    const receive = (message) => {
      events.push({ direction: 'receive', message });
      if (message.method && message.id !== undefined) {
        let result = null;
        if (message.method === 'workspace/configuration') {
          result = message.params.items.map(() => ({ run: 'onType' }));
        } else if (message.method === 'workspace/workspaceFolders') {
          result = folders;
        }
        send({ id: message.id, result });
      } else if (pending.has(message.id)) {
        const item = pending.get(message.id);
        pending.delete(message.id);
        clearTimeout(item.timer);
        if (message.error) item.reject(new Error(`${message.error.code}: ${message.error.message}`));
        else item.resolve(message.result);
      }
    };

    let buffer = Buffer.alloc(0);
    child.stdout.on('data', (chunk) => {
      try {
        buffer = Buffer.concat([buffer, chunk]);
        for (;;) {
          const split = buffer.indexOf('\r\n\r\n');
          if (split < 0) break;
          const header = buffer.subarray(0, split).toString();
          const length = Number(/Content-Length:\s*(\d+)/i.exec(header)?.[1]);
          if (!Number.isFinite(length)) throw new Error(`Invalid LSP header: ${header}`);
          if (buffer.length < split + 4 + length) break;
          const message = JSON.parse(buffer.subarray(split + 4, split + 4 + length).toString());
          buffer = buffer.subarray(split + 4 + length);
          receive(message);
        }
      } catch (failure) {
        fail(failure);
      }
    });
    const waitFor = async (predicate, description) => {
      const deadline = Date.now() + timeoutMs;
      while (!predicate()) {
        if (processError) throw processError;
        if (closed) throw new Error(`Server closed before ${description}.`);
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}.`);
        await sleep(25);
      }
    };

    const result = await request('initialize', {
      processId: process.pid,
      clientInfo: { name: 'vite-plus-3217-reproduction', version: '1' },
      rootUri: folders[0].uri,
      workspaceFolders: folders,
      capabilities: {
        workspace: { configuration: true, workspaceFolders: true },
        textDocument: { publishDiagnostics: { relatedInformation: true } },
      },
    });
    if (!result?.capabilities || !result.serverInfo?.version?.includes(`VP: ${vitePlusPackage.version}`)) {
      throw new Error(`Unexpected initialization response: ${JSON.stringify(result)}`);
    }
    initialized = true;
    serverInfo = result.serverInfo;
    send({ method: 'initialized', params: {} });
    send({ method: 'textDocument/didOpen', params: { textDocument: {
      uri: fileUri, languageId: 'typescript', version: 1, text: source,
    } } });

    if (expectConfigError) {
      await waitFor(() => configErrors(events).some((message) => isWrongRootError(message, fixture)),
        'the wrong-root config error');
    }
    if (tool === 'oxlint') {
      const expectedRule = fixture === 'custom' && !expectConfigError ? 'no-console' : 'no-unused-vars';
      await waitFor(() => {
        diagnostics = events.filter(({ direction, message }) => direction === 'receive'
          && message.method === 'textDocument/publishDiagnostics' && message.params.uri === fileUri)
          .at(-1)?.message.params.diagnostics;
        return diagnostics?.some((diagnostic) => String(diagnostic.code).includes(expectedRule));
      }, `${expectedRule} lint diagnostics`);
    } else {
      await waitFor(() => events.some(({ direction, message }) => direction === 'receive'
        && message.method === 'workspace/configuration'), 'workspace configuration');
      // Initialization is asynchronous. Wait for a completed formatting operation,
      // including the custom setting, instead of treating an absent error as success.
      const expectedText = fixture === 'custom' && !expectConfigError
        ? 'const unused = 1\nconsole.log("test")\n'
        : 'const unused = 1;\nconsole.log("test");\n';
      const deadline = Date.now() + timeoutMs;
      do {
        formattingResult = await request('textDocument/formatting', {
          textDocument: { uri: fileUri }, options: { tabSize: 2, insertSpaces: true },
        });
        formattedText = Array.isArray(formattingResult) ? applyTextEdits(source, formattingResult) : undefined;
        if (formattedText === expectedText) break;
        if (Date.now() > deadline) {
          throw new Error(`Formatting did not use the expected settings. Result: ${JSON.stringify(formattedText)}`);
        }
        await sleep(100);
      } while (true);
    }
    await request('shutdown', null);
    shutdown = true;
    send({ method: 'exit' });
    await waitFor(() => closed, 'server shutdown');
  } catch (failure) {
    error = failure.stack ?? failure.message;
  } finally {
    for (const item of pending.values()) clearTimeout(item.timer);
    pending.clear();
    if (child && !closed) {
      child.kill('SIGTERM');
      for (let attempt = 0; attempt < 40 && !closed; attempt++) await sleep(25);
      if (!closed) {
        child.kill('SIGKILL');
        for (let attempt = 0; attempt < 40 && !closed; attempt++) await sleep(25);
      }
    }
    rmSync(sandbox, { recursive: true, force: true });
  }

  const failures = configErrors(events);
  const wrongRoot = failures.some((message) => isWrongRootError(message, fixture));
  const expectedBehavior = baseline && cwdName === 'other' ? wrongRoot : failures.length === 0;
  const passed = !error && initialized && shutdown && closed?.code === 0 && expectedBehavior;
  const record = { mode, tool, fixture, cwd: cwdName, passed, initialized, shutdown, serverInfo,
    exit: closed, error, stderr, configErrors: failures, diagnostics, formattingResult, formattedText, events };
  writeFileSync(path.join(resultsDir, `lsp-${tool}-${fixture}-${cwdName}.json`), `${JSON.stringify(record, null, 2)}\n`);
  return { tool, fixture, cwd: cwdName, passed, config: wrongRoot ? 'failed (wrong root)' : failures.length ? 'failed' : 'loaded',
    exit: closed?.code ?? closed?.signal ?? 'not closed', error: error?.split('\n')[0] };
}

function configErrors(events) {
  return events.filter(({ direction, message }) => direction === 'receive'
    && ['window/showMessage', 'window/logMessage'].includes(message.method)
    && /Failed to load (config|configuration)/i.test(message.params.message))
    .map(({ message }) => message.params.message);
}

function isWrongRootError(message, fixture) {
  const text = normalize(message);
  return text.includes('Could not resolve entry for router entry: router in ')
    && (fixture === 'custom' ? text.includes('router in app/src') : text.includes('/fixtures/other/src'));
}

function applyTextEdits(source, edits) {
  // LSP positions use UTF-16 code units, as do JavaScript string offsets.
  const lines = source.split('\n');
  const offset = ({ line, character }) => {
    assert.ok(Number.isInteger(line) && line >= 0 && line < lines.length, 'Invalid edit line.');
    assert.ok(Number.isInteger(character) && character >= 0 && character <= lines[line].length,
      'Invalid edit character.');
    return lines.slice(0, line).reduce((total, text) => total + text.length + 1, 0) + character;
  };
  const ranges = edits.map(({ range, newText }) => {
    const start = offset(range.start);
    const end = offset(range.end);
    assert.ok(start <= end && typeof newText === 'string', 'Invalid text edit.');
    return { start, end, newText };
  }).sort((a, b) => b.start - a.start || b.end - a.end);
  let previousStart = source.length;
  let text = source;
  for (const { start, end, newText } of ranges) {
    assert.ok(end <= previousStart, 'Overlapping text edits.');
    text = text.slice(0, start) + newText + text.slice(end);
    previousStart = start;
  }
  return text;
}

const summary = [];
for (const tool of ['oxlint', 'oxfmt']) {
  for (const fixture of ['plain', 'custom']) {
    for (const cwd of ['project', 'other']) summary.push(await run(tool, fixture, cwd));
  }
}
writeFileSync(path.join(resultsDir, 'lsp-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.table(summary, ['tool', 'fixture', 'cwd', 'passed', 'config', 'exit']);
if (summary.every(({ passed }) => passed)) {
  console.log(baseline
    ? 'Baseline confirmed: both LSP servers fail to load config when cwd=other.'
    : 'Patch confirmed: both LSP servers load default and custom roots from either cwd.');
  console.log('Successful custom cases apply no-console and semi:false from the Vite config.');
  console.log(`Full protocol logs: results/${mode}/lsp-*.json`);
} else {
  console.error(`Unexpected result. Inspect results/${mode}/lsp-*.json for details.`);
  process.exitCode = 1;
}
