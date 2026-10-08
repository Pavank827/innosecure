// Shared harness: local static server + headless Chrome + raw CDP client.
// No third-party dependencies (Node 22 ships a global WebSocket).
import http from 'node:http';
import zlib from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const WEBSITE_DIR = path.join(ROOT, 'website');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

// Serves website/ the way GitHub Pages would (gzip for text, no cache headers
// that would hide work from a cold-cache measurement).
export function startStaticServer(dir = WEBSITE_DIR) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      let rel = decodeURIComponent(url.pathname);
      if (rel === '/') rel = '/index.html';
      const file = path.normalize(path.join(dir, rel));
      if (!file.startsWith(path.normalize(dir))) {
        res.writeHead(403).end('forbidden');
        return;
      }
      let data = await readFile(file);
      const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
      const headers = { 'Content-Type': type, 'Cache-Control': 'no-store' };
      if (/\bgzip\b/.test(String(req.headers['accept-encoding'] || '')) &&
          /^(text\/|application\/(json|javascript))/.test(type)) {
        data = zlib.gzipSync(data);
        headers['Content-Encoding'] = 'gzip';
      }
      headers['Content-Length'] = data.length;
      res.writeHead(200, headers);
      res.end(data);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    }
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, port, url: `http://127.0.0.1:${port}/`, close: () => new Promise(r => server.close(r)) });
    });
  });
}

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0];
}

async function waitForJson(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) { lastErr = e; }
    await new Promise(r => setTimeout(r, 150));
  }
  throw lastErr || new Error('timeout waiting for ' + url);
}

export async function launchChrome({ debuggingPort = 9333 } = {}) {
  const exe = findChrome();
  const profile = mkdtempSync(path.join(os.tmpdir(), 'chrome-perf-'));
  const args = [
    '--headless=new',
    `--remote-debugging-port=${debuggingPort}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    '--disable-background-networking',
    '--disable-component-update',
    '--no-pings',
    '--window-size=1366,900',
    'about:blank'
  ];
  const child = spawn(exe, args, { stdio: 'ignore', windowsHide: true });
  const version = await waitForJson(`http://127.0.0.1:${debuggingPort}/json/version`);
  const target = await (await fetch(
    `http://127.0.0.1:${debuggingPort}/json/new?${encodeURIComponent('about:blank')}`,
    { method: 'PUT' }
  )).json();
  return {
    version,
    target,
    kill() {
      try { child.kill(); } catch { /* already gone */ }
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      }
    }
  };
}

export class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
  }

  static async connect(wsUrl) {
    const cdp = new Cdp(wsUrl);
    cdp.ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      cdp.ws.addEventListener('open', resolve, { once: true });
      cdp.ws.addEventListener('error', reject, { once: true });
    });
    cdp.ws.addEventListener('message', ev => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch { return; }
      if (msg.id !== undefined) {
        const entry = cdp.pending.get(msg.id);
        if (!entry) return;
        cdp.pending.delete(msg.id);
        if (msg.error) entry.reject(new Error(`${entry.method}: ${msg.error.message}`));
        else entry.resolve(msg.result);
        return;
      }
      const list = cdp.listeners.get(msg.method);
      if (list) for (const cb of list) { try { cb(msg.params); } catch { /* listener bug */ } }
    });
    return cdp;
  }

  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error('cdp closed'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, cb) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(cb);
  }

  once(method, cb) {
    const wrapper = params => {
      const list = this.listeners.get(method) || [];
      const i = list.indexOf(wrapper);
      if (i >= 0) list.splice(i, 1);
      cb(params);
    };
    this.on(method, wrapper);
  }

  close() {
    this.closed = true;
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

// Evaluate an expression in the page and return its value by reference.
export async function evaluate(cdp, expression, { awaitPromise = true } = {}) {
  const res = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
    allowUnsafeEvalBlockedByCSP: false
  });
  if (res.exceptionDetails) {
    const detail = res.exceptionDetails.exception?.description || res.exceptionDetails.text;
    throw new Error('page exception: ' + detail);
  }
  return res.result?.value;
}

// Polls a page expression until it returns a truthy value; returns the value.
export async function waitFor(cdp, expression, { timeoutMs = 20000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await evaluate(cdp, expression);
      if (last) return last;
    } catch {
      // Navigating page: context not ready yet, keep polling.
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out: ${expression.slice(0, 160)} (last=${JSON.stringify(last)})`);
}

export function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
