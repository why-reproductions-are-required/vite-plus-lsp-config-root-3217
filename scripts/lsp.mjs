import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vitePlusPackage from 'vite-plus/package.json' with { type: 'json' };

const root = fileURLToPath(new URL('../', import.meta.url));
const resultsDir = path.join(root, 'results');
const timeoutMs = 20_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const normalize = (value) => value.replaceAll('\\', '/');
mkdirSync(resultsDir, { recursive: true });

async function run(tool, cwdName) {
  // Keep ancestor Vite configs from affecting automatic config discovery.
  const sandbox = mkdtempSync(path.join(os.tmpdir(), 'vite-plus-3217-'));
  const events = [];
  let child;
  let closed;
  let processError;
  let stderr = '';
  let serverInfo;
  let formattingResult;
  let error;
  let initialized = false;
  let shutdown = false;
  const pending = new Map();

  try {
    cpSync(path.join(root, 'fixtures'), path.join(sandbox, 'fixtures'), { recursive: true });
    symlinkSync(path.join(root, 'node_modules'), path.join(sandbox, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir');
    const project = path.join(sandbox, 'fixtures', 'plain');
    const other = path.join(sandbox, 'fixtures', 'other');
    const cwd = cwdName === 'project' ? project : other;
    const folders = [
      { uri: pathToFileURL(other).href, name: 'other' },
      { uri: pathToFileURL(project).href, name: 'plain' },
    ];
    const file = path.join(project, 'src', 'example.ts');
    const fileUri = pathToFileURL(file).href;
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
      uri: fileUri, languageId: 'typescript', version: 1, text: readFileSync(file, 'utf8'),
    } } });

    if (cwdName === 'other') {
      await waitFor(() => configErrors(events).some(isWrongRootError), 'the wrong-root config error');
    } else if (tool === 'oxlint') {
      await waitFor(() => events.some(({ direction, message }) => direction === 'receive'
        && message.method === 'textDocument/publishDiagnostics'
        && message.params.uri === fileUri && message.params.diagnostics.length > 0), 'lint diagnostics');
    } else {
      // Oxfmt has no notification for successful configuration initialization.
      await waitFor(() => events.some(({ direction, message }) => direction === 'receive'
        && message.method === 'workspace/configuration'), 'workspace configuration');
      await sleep(4500);
    }
    if (tool === 'oxfmt') {
      formattingResult = await request('textDocument/formatting', {
        textDocument: { uri: fileUri }, options: { tabSize: 2, insertSpaces: true },
      });
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
  const expectedBehavior = cwdName === 'project' ? failures.length === 0 : failures.some(isWrongRootError);
  const passed = !error && initialized && shutdown && closed?.code === 0 && expectedBehavior;
  const record = { tool, cwd: cwdName, passed, initialized, shutdown, serverInfo,
    exit: closed, error, stderr, configErrors: failures, formattingResult, events };
  writeFileSync(path.join(resultsDir, `lsp-${tool}-${cwdName}.json`), `${JSON.stringify(record, null, 2)}\n`);
  return { tool, cwd: cwdName, passed, config: failures.some(isWrongRootError) ? 'failed (wrong root)' : failures.length ? 'failed' : 'loaded',
    exit: closed?.code ?? closed?.signal ?? 'not closed', error: error?.split('\n')[0] };
}

function configErrors(events) {
  return events.filter(({ direction, message }) => direction === 'receive'
    && ['window/showMessage', 'window/logMessage'].includes(message.method)
    && /Failed to load (config|configuration)/i.test(message.params.message))
    .map(({ message }) => message.params.message);
}

function isWrongRootError(message) {
  const text = normalize(message);
  return text.includes('Could not resolve entry for router entry: router in ')
    && text.includes('/fixtures/other/src');
}

const summary = [];
for (const tool of ['oxlint', 'oxfmt']) {
  for (const cwd of ['project', 'other']) summary.push(await run(tool, cwd));
}
writeFileSync(path.join(resultsDir, 'lsp-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.table(summary, ['tool', 'cwd', 'passed', 'config', 'exit']);
if (summary.every(({ passed }) => passed)) {
  console.log('Reproduced: both LSP servers load the same config with the wrong root when cwd=other.');
  console.log('The servers stay alive; default diagnostics or formatting may still work.');
  console.log('Full protocol logs: results/lsp-*.json');
} else {
  console.error('Unexpected result. Inspect results/lsp-*.json for details.');
  process.exitCode = 1;
}
