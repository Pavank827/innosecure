// Performance profiler for the InnoSecure website.
//
//   node tests/perf/profile.mjs --label baseline
//   node tests/perf/profile.mjs --label after --out tests/perf/after.json
//
// Runs a fixed, deterministic scenario against the real website code with a
// mocked backend (fixed latencies) and network throttling, then reports:
//   1. initial page load   6. device-status loading
//   2. dashboard load      7. API request counts
//   3. page switching      8. JavaScript execution time
//   4. users page          9. largest files / transfer size
//   5. history page       10. outage behaviour
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { launchChrome, Cdp, startStaticServer, evaluate, waitFor, sleep, WEBSITE_DIR } from '../harness/lib.mjs';
import { createMockBackend, fetchGoogleFonts } from '../harness/mock.mjs';

const args = process.argv.slice(2);
const label = argValue('--label') || 'run';
const outPath = argValue('--out') || path.join(path.dirname(fileURLToPath(import.meta.url)), `${label}.json`);
const siteDir = argValue('--dir');
const offlineBackend = args.includes('--outage');

function argValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}

// Fixed simulated latencies (identical for every run).
const THROTTLE = { latency: 15, downloadThroughput: 1_250_000, uploadThroughput: 500_000, offline: false };

async function metric(cdp) {
  const res = await cdp.send('Performance.getMetrics');
  const map = Object.fromEntries(res.metrics.map(m => [m.name, m.value]));
  // ScriptDuration is frozen in current Chrome builds; TaskDuration counts all
  // main-thread work (script + style + layout) and is the reliable signal.
  return { scriptDuration: map.ScriptDuration || 0, taskDuration: map.TaskDuration || 0, heap: map.JSHeapUsedSize || 0 };
}

// Waits until the backend has been quiet for `quietMs` so one scenario's
// requests never leak into the next scenario's count.
async function settle(mock, quietMs = 800, maxMs = 12000) {
  const start = Date.now();
  let count = mock.state.requests.length;
  let lastChange = Date.now();
  while (Date.now() - start < maxMs) {
    await sleep(150);
    const n = mock.state.requests.length;
    if (n !== count) { count = n; lastChange = Date.now(); }
    else if (Date.now() - lastChange >= quietMs) return;
  }
}

async function assetSizes(dir = WEBSITE_DIR) {
  const files = ['index.html', 'app.js', 'styles.css', '404.html'];
  const out = {};
  for (const f of files) {
    try {
      const buf = await readFile(path.join(dir, f));
      // Git stores LF blobs, and GitHub Pages serves those, so line endings
      // are normalised before measuring (a CRLF working copy would inflate
      // raw size without changing what the browser downloads).
      const lf = Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
      out[f] = { bytes: lf.length, gzip: zlib.gzipSync(lf).length };
    } catch { /* optional */ }
  }
  return out;
}

async function main() {
  const results = { label, startedAt: new Date().toISOString(), scenario: {} };

  const site = await startStaticServer(siteDir || WEBSITE_DIR);
  const fonts = await fetchGoogleFonts();
  const mock = createMockBackend();
  const chrome = await launchChrome({ debuggingPort: 9433 });
  const cdp = await Cdp.connect(chrome.target.webSocketDebuggerUrl);

  try {
    await Promise.all([
      cdp.send('Page.enable'),
      cdp.send('Network.enable'),
      cdp.send('Runtime.enable'),
      cdp.send('Performance.enable')
    ]);
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await cdp.send('Network.emulateNetworkConditions', THROTTLE);
    await mock.install(cdp, fonts);

    const apiCount = () => mock.requestsOf('gas').length + mock.requestsOf('edge').length;
    const snapshot = () => mock.state.requests.length;
    const since = n => mock.state.requests.slice(n);

    // ---------------------------------------------------------------- S1
    // Cold load with no session token: login screen only, zero API calls.
    await cdp.send('Page.navigate', { url: site.url });
    await waitFor(cdp, `document.readyState === 'complete'`, { timeoutMs: 15000 });
    await evaluate(cdp, `sessionStorage.clear()`);
    mock.reset();

    let t0 = Date.now();
    await cdp.send('Page.navigate', { url: site.url });
    await waitFor(cdp, `document.readyState === 'complete'`, { timeoutMs: 15000 });
    await sleep(400); // settle fonts/paints
    const s1 = await evaluate(cdp, `(() => {
      const nav = performance.getEntriesByType('navigation')[0];
      const paints = performance.getEntriesByType('paint');
      const fcp = paints.find(p => p.name === 'first-contentful-paint');
      const dclp = paints.find(p => p.name === 'domContentLoaded');
      return {
        ttfb: nav.responseStart,
        dcl: nav.domContentLoadedEventEnd,
        load: nav.loadEventEnd,
        fcp: fcp ? fcp.startTime : null,
        loginVisible: getComputedStyle(document.getElementById('loginScreen')).display !== 'none',
        appHidden: getComputedStyle(document.getElementById('mainApp')).display === 'none',
        wallMs: performance.now()
      };
    })()`);
    results.scenario.initialLoad = {
      ...s1,
      requests: since(snapshot()).map(r => `${r.kind}:${r.key}`),
      wallMs: Date.now() - t0
    };

    // ---------------------------------------------------------------- S2
    // Authenticated load: dashboard must paint immediately, then fill in.
    mock.reset();
    await evaluate(cdp, `sessionStorage.setItem('authToken', 'perf-token'); sessionStorage.setItem('adminUser','perf')`);
    const snap2 = snapshot();
    t0 = Date.now();
    await cdp.send('Page.navigate', { url: site.url });

    const appVisible = await waitFor(cdp, `(() => {
      const el = document.getElementById('mainApp');
      return el && el.style.display === 'flex' ? performance.now() : 0;
    })()`, { timeoutMs: 15000 }).catch(() => null);

    const firstShell = await waitFor(cdp, `(() => {
      const el = document.getElementById('mainApp');
      return el && el.style.display === 'flex' && document.querySelector('.page.active') ? performance.now() : 0;
    })()`, { timeoutMs: 15000 }).catch(() => null);

    const statsReady = await waitFor(cdp, `document.getElementById('statRegistered').textContent.trim() !== '--' ? performance.now() : 0`, { timeoutMs: 20000 }).catch(() => null);
    const statusReady = await waitFor(cdp, `(() => {
      const el = document.getElementById('statusESP32');
      return el && !/CHECKING/.test(el.textContent) ? performance.now() : 0;
    })()`, { timeoutMs: 20000 }).catch(() => null);
    const headerReady = await waitFor(cdp, `document.getElementById('systemStatusText').textContent.indexOf('Checking') === -1 ? performance.now() : 0`, { timeoutMs: 20000 }).catch(() => null);

    await sleep(300);
    results.scenario.dashboard = {
      appVisibleAt: appVisible,
      shellAt: firstShell,
      statsAt: statsReady,
      deviceStatusAt: statusReady,
      headerAt: headerReady,
      requests: since(snap2).map(r => `${r.kind}:${r.key}`),
      wallMs: Date.now() - t0
    };

    // ---------------------------------------------------------------- S3
    // Page switching. Sync part must be instant; data part is measured too.
    const mBefore = await metric(cdp);
    const pageSwitch = {};
    async function switchTo(name, setup, readyExpr) {
      const snap = snapshot();
      const sync = await evaluate(cdp, `(() => {
        window.__t_switch = performance.now(); ${setup}; return performance.now() - window.__t_switch;
      })()`);
      let dataMs = null;
      try {
        dataMs = await waitFor(cdp, `(${readyExpr}) ? (performance.now() - window.__t_switch) : 0`, { timeoutMs: 15000 });
      } catch { dataMs = null; }
      pageSwitch[name] = {
        syncMs: sync,
        dataMs: dataMs === null ? null : dataMs,
        requests: since(snap).filter(r => r.kind === 'gas' || r.kind === 'edge').map(r => `${r.kind}:${r.key}`)
      };
    }

    await switchTo('users', `navigateTo('users')`,
      `getComputedStyle(document.getElementById('usersPanelRegister')).display !== 'none'`);
    await switchTo('usersRegisteredTab', `switchUsersTab('registered')`,
      `!/Loading users/.test(document.getElementById('usersTableBody').textContent)`);
    const usersRows = await evaluate(cdp, `document.querySelectorAll('#usersTableBody tr').length`);
    // Second visit to the same tab must reuse already-loaded data.
    const snapUsers = snapshot();
    await evaluate(cdp, `switchUsersTab('register'); switchUsersTab('registered')`);
    await sleep(1200);
    const usersRetoggleRequests = since(snapUsers).filter(r => r.kind === 'gas').length;
    await switchTo('inside', `navigateTo('inside')`,
      `document.getElementById('insideCount').textContent.trim() !== '--'`);
    await switchTo('history', `navigateTo('history')`,
      `!/Loading history/.test(document.getElementById('historyTableBody').textContent)`);

    // History keystroke behaviour: 4 rapid keystrokes, one debounced request.
    const snapHist = snapshot();
    const histT0 = await evaluate(cdp, `(() => {
      window.__histBefore = document.getElementById('historyTableBody').textContent;
      const input = document.getElementById('historyName');
      input.value = '';
      input.dispatchEvent(new Event('input', {bubbles:true}));
      window.__histStart = performance.now();
      for (const ch of 'Neha') {
        input.value += ch;
        input.dispatchEvent(new Event('input', {bubbles:true}));
      }
      return window.__histStart;
    })()`);
    const histPaint = await waitFor(cdp, `document.getElementById('historyTableBody').textContent !== window.__histBefore ? performance.now() : 0`, { timeoutMs: 8000 }).catch(() => null);
    await sleep(1600);
    const histRequests = since(snapHist).filter(r => r.kind === 'gas');
    // Clear the filter again so the rest of the run is deterministic.
    await evaluate(cdp, `(() => {
      const input = document.getElementById('historyName');
      input.value = '';
      input.dispatchEvent(new Event('input', {bubbles:true}));
    })()`);
    await settle(mock);

    await switchTo('reports', `navigateTo('reports')`,
      `document.getElementById('reportTableBody').textContent.trim() !== 'Select date range to generate report'`);
    await switchTo('dashboard', `navigateTo('dashboard')`,
      `document.getElementById('statRegistered').textContent.trim() !== '--'`);

    await settle(mock);
    const mAfterSwitch = await metric(cdp);
    results.scenario.pageSwitch = pageSwitch;
    results.scenario.users = {
      rows: usersRows,
      retoggleRequests: usersRetoggleRequests
    };
    results.scenario.history = {
      keystrokes: 4,
      uiUpdateMs: histPaint === null ? null : Math.max(0, histPaint - histT0),
      requests: histRequests.map(r => `${r.kind}:${r.key}`)
    };

    // ---------------------------------------------------------------- S4
    // Idle on the dashboard: how many requests does the 10 s refresh cost?
    // The window is aligned to a refresh tick (gas + edge of that cycle
    // recorded, then measured) so every run counts the same number of ticks:
    // an unaligned 31 s window can contain 3 or 4 ticks purely by luck.
    const isDashTick = r => r.kind === 'gas' && r.key === 'get_dashboard_data';
    const ticksSeen = () => mock.state.requests.filter(isDashTick).length;
    const ticksBefore = ticksSeen();
    const alignDeadline = Date.now() + 15000;
    while (ticksSeen() === ticksBefore && Date.now() < alignDeadline) await sleep(50);
    const edgeBefore = mock.requestsOf('edge').length;
    const edgeDeadline = Date.now() + 800;
    while (mock.requestsOf('edge').length === edgeBefore && Date.now() < edgeDeadline) await sleep(30);
    const snapIdle = snapshot();
    const idleStart = Date.now();
    await sleep(31000);
    const idleReqs = since(snapIdle).filter(r => r.kind === 'gas' || r.kind === 'edge');
    results.scenario.idle30sOnDashboard = {
      durationMs: Date.now() - idleStart,
      ticks: idleReqs.filter(isDashTick).length,
      requests: idleReqs.map(r => `${r.kind}:${r.key}`),
      total: idleReqs.length
    };

    // ---------------------------------------------------------------- S5
    // Google outage: Apps Script answers 500. UI must stay usable and honest.
    // Snapshot the session-wide counters first: reset() below would otherwise
    // leave the final report describing only the outage window.
    await settle(mock);
    const sessionCounts = mock.counts();
    const sessionMax = { ...mock.state.maxConcurrentByKey };
    mock.reset();
    mock.state.backend = 'fail';
    const snapOutage = snapshot();
    const outageStart = Date.now();
    const errShownAt = await waitFor(cdp, `(() => {
      const el = document.getElementById('latestActivity');
      const txt = el ? el.textContent : '';
      return /Could not reach the backend|Backend returned an error/.test(txt) ? performance.now() : 0;
    })()`, { timeoutMs: 30000 }).catch(() => null);
    const errVisibleAt = errShownAt === null ? null : Date.now() - outageStart;
    await sleep(Math.max(0, 30000 - (Date.now() - outageStart)));
    const outageReqs = since(snapOutage).filter(r => r.kind === 'gas');
    const outageUi = await evaluate(cdp, `(() => ({
      header: document.getElementById('systemStatusText').textContent,
      sheets: document.getElementById('statusSheets').textContent.trim(),
      esp32: document.getElementById('statusESP32').textContent.trim(),
      stats: document.getElementById('statRegistered').textContent.trim(),
      interactive: typeof navigateTo === 'function'
    }))()`);
    mock.state.backend = 'ok';

    results.scenario.outage = {
      windowMs: Date.now() - outageStart,
      errorShownAfterMs: errVisibleAt,
      gasRequests: outageReqs.length,
      ui: outageUi
    };

    // ---------------------------------------------------------------- JS cost
    const mAfter = await metric(cdp);

    // Micro-benchmarks of the hot render paths (results are restored).
    const bench = await evaluate(cdp, `(() => {
      const rows = [];
      for (let i = 0; i < 100; i++) {
        rows.push({ date: '2026-10-08', time: '09:0' + (i % 10) + ':00', name: 'User ' + i,
          user_id: 'A8660512' + (10 + i), rfid_uid: 'RF' + i, action: i % 2 ? 'EXIT' : 'ENTRY', status: 'ALLOWED' });
      }
      const tbody = document.getElementById('historyTableBody');
      const saved = tbody.innerHTML;
      let render = Infinity;
      for (let run = 0; run < 5; run++) {
        const t0 = performance.now();
        renderHistoryTable(rows);
        render = Math.min(render, performance.now() - t0);
      }
      tbody.innerHTML = saved;
      const sample = '<b>Test & \\"quoted\\" \\'quoted\\' needle</b>';
      let escape = Infinity;
      for (let run = 0; run < 3; run++) {
        const t2 = performance.now();
        for (let i = 0; i < 5000; i++) escapeHtml(sample);
        escape = Math.min(escape, performance.now() - t2);
      }
      return { render100RowsMs: render, escapeHtml5kMs: escape };
    })()`);

    results.scenario.javascript = {
      mainThreadPageSwitchMs: Math.round((mAfterSwitch.taskDuration - mBefore.taskDuration) * 1000),
      mainThreadSessionMs: Math.round((mAfter.taskDuration - mBefore.taskDuration) * 1000),
      rawTaskBefore: mBefore.taskDuration,
      rawTaskAfterSwitch: mAfterSwitch.taskDuration,
      rawTaskEnd: mAfter.taskDuration,
      render100RowsMs: Math.round(bench.render100RowsMs * 100) / 100,
      escapeHtml5kMs: Math.round(bench.escapeHtml5kMs * 100) / 100,
      heapUsedBytes: Math.round(mAfter.heap)
    };

    const outageCounts = mock.counts();
    const outageMax = { ...mock.state.maxConcurrentByKey };
    results.requests = mergeAdd(sessionCounts, outageCounts);
    results.requestsOutage = outageCounts;
    results.maxConcurrent = mergeMax(sessionMax, outageMax);
    results.maxConcurrentOutage = outageMax;
    results.assets = await assetSizes(siteDir || WEBSITE_DIR);
    results.notes = {
      throttle: THROTTLE,
      latency: mock.state.latency,
      backend: 'mocked (deterministic), gzip static server, HTTP cache disabled'
    };
  } finally {
    cdp.close();
    chrome.kill();
    await site.close();
  }

  writeFileSync(outPath, JSON.stringify(results, null, 2));
  print(results);
  console.log(`\nWrote ${outPath}`);
}

function ms(v) {
  return v === null || v === undefined ? 'n/a' : `${Math.round(v)} ms`;
}

function mergeAdd(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = (out[k] || 0) + v;
  return out;
}

function mergeMax(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = Math.max(out[k] || 0, v);
  return out;
}

function print(r) {
  const s = r.scenario;
  console.log(`\n================ ${r.label} ================`);
  console.log('1. INITIAL LOAD (cold, no session)');
  console.log(`   TTFB ${ms(s.initialLoad.ttfb)} | FCP ${ms(s.initialLoad.fcp)} | DCL ${ms(s.initialLoad.dcl)} | load ${ms(s.initialLoad.load)}`);
  console.log(`   requests: ${s.initialLoad.requests.join(', ') || '(none)'}`);
  console.log('2. DASHBOARD (authenticated load)');
  console.log(`   shell ${ms(s.dashboard.shellAt)} | device status ${ms(s.dashboard.deviceStatusAt)} | header ${ms(s.dashboard.headerAt)} | stats ${ms(s.dashboard.statsAt)}`);
  console.log(`   requests: ${s.dashboard.requests.join(', ')}`);
  console.log('3. PAGE SWITCH (sync / data)');
  for (const [k, v] of Object.entries(s.pageSwitch)) {
    console.log(`   ${k.padEnd(20)} sync ${ms(v.syncMs).padStart(8)}  data ${ms(v.dataMs).padStart(8)}  api=${v.requests.length ? v.requests.join(',') : 0}`);
  }
  console.log('4. USERS');
  console.log(`   rows ${s.users.rows} | retoggle api requests ${s.users.retoggleRequests}`);
  console.log('5. HISTORY');
  console.log(`   4 keystrokes -> UI update ${ms(s.history.uiUpdateMs)}, requests: ${s.history.requests.join(', ') || '(none)'}`);
  console.log('6/7. IDLE 31 s ON DASHBOARD');
  const idle = s.idle30sOnDashboard;
  console.log(`   ${idle.total} requests over ${idle.ticks} refresh ticks: ${idle.requests.join(', ')}`);
  console.log('10. GOOGLE OUTAGE (30 s)');
  console.log(`   error shown after ${ms(s.outage.errorShownAfterMs)} | GAS requests ${s.outage.gasRequests}`);
  console.log(`   header="${s.outage.ui.header}" sheets="${s.outage.ui.sheets}" esp32="${s.outage.ui.esp32}" stats="${s.outage.ui.stats}"`);
  console.log('8. JAVASCRIPT');
  console.log(`   main thread: page switches ${ms(s.javascript.mainThreadPageSwitchMs)}, whole session ${ms(s.javascript.mainThreadSessionMs)}`);
  console.log(`   render 100 history rows ${s.javascript.render100RowsMs} ms | escapeHtml x5000 ${s.javascript.escapeHtml5kMs} ms | heap ${Math.round(s.javascript.heapUsedBytes / 1024)} KB`);
  console.log('9. FILES (raw / gzip, line endings normalised)');
  for (const [f, v] of Object.entries(r.assets)) console.log(`   ${f.padEnd(14)} ${String(v.bytes).padStart(7)} / ${String(v.gzip).padStart(6)} bytes`);
  const overlaps = Object.entries(r.maxConcurrent || {}).filter(([, v]) => v > 1);
  console.log(`   overlapping identical in-flight requests (whole session): ${overlaps.length ? JSON.stringify(Object.fromEntries(overlaps)) : 'none'}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
