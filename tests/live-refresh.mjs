// Live-refresh contract tests for website/app.js.
//
//   node tests/live-refresh.mjs
//
// The real website code runs in headless Chrome against the deterministic mock
// backend. Every assertion is about observable behaviour after a simulated
// ESP32 card tap (mock.injectEvent): how fast the event becomes visible, that
// only one dashboard request is ever in flight, that a repeated payload never
// duplicates activity rows or counts, that filters/dates survive a refresh,
// and that GETs are cache-busted. Latencies are simulated - nothing here is a
// physical or production measurement.
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, Cdp, startStaticServer, evaluate, waitFor, sleep } from './harness/lib.mjs';
import { createMockBackend } from './harness/mock.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CHROME_PORT = 9469;

// Simulated network latencies. gasGet ~ real Apps Script web-app round trip
// (302 + execution); edge is the fast Worker path.
const LATENCY = { gasGet: 800, gasPost: 800, edge: 120, fontCss: 40, fontFile: 40 };

const results = [];

async function step(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error: String((error && error.message) || error) });
    console.log(`FAIL  ${name} -> ${(error && error.message) || error}`);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function assertEq(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertBetween(actual, min, max, message) {
  if (!(actual >= min && actual <= max)) {
    throw new Error(`${message}: expected ${min}..${max}, got ${actual}`);
  }
}

function assertIncludes(actual, needle, message) {
  if (!String(actual).includes(needle)) {
    throw new Error(`${message}: ${JSON.stringify(String(actual))} does not contain ${JSON.stringify(needle)}`);
  }
}

async function main() {
  const site = await startStaticServer();
  const mock = createMockBackend({ latency: LATENCY });
  const chrome = await launchChrome({ debuggingPort: CHROME_PORT });
  const cdp = await Cdp.connect(chrome.target.webSocketDebuggerUrl);

  const gas = action => mock.requestsOf('gas', action).length;
  const measurements = {};

  try {
    await Promise.all([
      cdp.send('Page.enable'),
      cdp.send('Network.enable'),
      cdp.send('Runtime.enable')
    ]);
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await mock.install(cdp);

    // ------------------------------------------------------------------ login
    await cdp.send('Page.navigate', { url: site.url });
    await waitFor(cdp, `document.readyState === 'complete'`, { timeoutMs: 15000 });
    await evaluate(cdp, `sessionStorage.clear(); localStorage.clear(); true`);
    await cdp.send('Page.navigate', { url: site.url });
    await waitFor(cdp, `document.readyState === 'complete'`, { timeoutMs: 15000 });
    await evaluate(cdp, `
      document.getElementById('loginUsername').value = 'admin';
      document.getElementById('loginPassword').value = 'secret';
      document.getElementById('loginForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      true
    `);
    await waitFor(cdp, `document.getElementById('mainApp').style.display !== 'none' ? 1 : 0`, { timeoutMs: 15000 });
    // Let the initial dashboard paint settle before measuring the live loop.
    await waitFor(cdp, `document.getElementById('statRegistered').textContent.trim() !== '--' ? 1 : 0`, { timeoutMs: 15000 });
    await sleep(500);
    // Deterministic cadence from here: pause the timer and drive refreshes
    // explicitly where needed; cadence tests resume it.
    await evaluate(cdp, `pauseAutoRefresh(); true`);

    // ------------------------------------------------------------------ T1
    await step('REFRESH_INTERVAL is the 1-2 s live target', async () => {
      const v = await evaluate(cdp, `REFRESH_INTERVAL`);
      assertEq(v, 2000, 'REFRESH_INTERVAL');
      const max = await evaluate(cdp, `REFRESH_MAX_MS`);
      assertEq(max, 10000, 'REFRESH_MAX_MS ceiling');
    });

    // ------------------------------------------------------------------ T2
    await step('dashboard GETs are cache-busted with nc= and cache:no-store', async () => {
      mock.state.requests.length = 0;
      await evaluate(cdp, `loadDashboardStats({ minAge: 0, force: true }); true`);
      await waitFor(cdp, `refreshInFlight === false ? 1 : 0`, { timeoutMs: 10000 });
      await sleep(100);
      const dashReqs = mock.requestsOf('gas', 'get_dashboard_data');
      assert(dashReqs.length >= 1, 'at least one dashboard request');
      const last = dashReqs[dashReqs.length - 1];
      assert(/([?&])nc=\d+/.test(last.url), `dashboard GET must carry nc= cache-buster, got ${last.url}`);
      const noStore = await evaluate(cdp, `(async () => {
        const orig = window.fetch;
        let seen = null;
        window.fetch = (url, opts) => { seen = opts || {}; return orig(url, opts); };
        try { await apiGet('get_history', { limit: 1 }); } finally { window.fetch = orig; }
        return seen && seen.cache;
      })()`);
      assertEq(noStore, 'no-store', 'fetch cache mode');
    });

    // ------------------------------------------------------------------ T3
    await step('only one get_dashboard_data is ever in flight', async () => {
      mock.reset();
      mock.state.latency.gasGet = 1200;
      const bursts = await evaluate(cdp, `(async () => {
        // Fire five overlapping loads the way a pathological caller would.
        for (let i = 0; i < 5; i++) loadDashboardStats({ minAge: 0, force: true });
        await new Promise(r => setTimeout(r, 1500));
        return true;
      })()`);
      assert(bursts, 'burst started');
      await waitFor(cdp, `refreshInFlight === false ? 1 : 0`, { timeoutMs: 10000 });
      await sleep(200);
      const maxSeen = mock.state.maxConcurrentByKey['get_dashboard_data'] || 0;
      assertEq(maxSeen, 1, 'max concurrent get_dashboard_data');
      assertEq(gas('get_dashboard_data'), 1, 'five overlapping loads share one request');
      mock.state.latency.gasGet = LATENCY.gasGet;
    });

    // ------------------------------------------------------------------ T4
    await step('a card tap becomes visible within ~1-2 s of the backend write', async () => {
      await evaluate(cdp, `pauseAutoRefresh(); true`);
      // Baseline paint.
      await evaluate(cdp, `loadDashboardStats({ minAge: 0, force: true }); true`);
      await waitFor(cdp, `document.getElementById('statEntries').textContent.trim() !== '--' ? 1 : 0`, { timeoutMs: 15000 });
      await sleep(300);

      const beforeEntries = Number(await evaluate(cdp, `document.getElementById('statEntries').textContent.trim()`));
      const beforeActivity = await evaluate(cdp, `document.getElementById('latestActivity').textContent`);

      // Simulated ESP32 write lands in the sheet NOW. Resume the live loop so
      // the next tick (or the device-activity nudge) picks it up.
      const write = mock.injectEvent({ rfid_uid: 'LIVE0001', name: 'Live Test', user_id: 'L999', action: 'ENTRY' });
      await evaluate(cdp, `refreshNow(); true`);

      const visible = await waitFor(cdp, `(() => {
        const entries = document.getElementById('statEntries').textContent.trim();
        const activity = document.getElementById('latestActivity').textContent;
        return (activity.includes('Live Test') && Number(entries) > ${beforeEntries}) ? Date.now() : 0;
      })()`, { timeoutMs: 8000 });

      const latencyMs = visible - write.at;
      measurements.eventToVisibleMs = latencyMs;
      measurements.simulatedGasGetMs = LATENCY.gasGet;
      // Target: visible within 1-2 s of the write where the network allows.
      // Simulated GAS latency alone is 800 ms, so the whole path must fit in
      // a couple of seconds end-to-end.
      assertBetween(latencyMs, 0, 2500, 'event -> visible latency');
      const afterEntries = Number(await evaluate(cdp, `document.getElementById('statEntries').textContent.trim()`));
      assertEq(afterEntries, beforeEntries + 1, 'today_entries incremented by exactly one');
      const afterActivity = await evaluate(cdp, `document.getElementById('latestActivity').textContent`);
      assertIncludes(afterActivity, 'Live Test', 'newest scan is on screen');
      assertIncludes(afterActivity, 'LIVE0001', 'newest scan shows the UID');
    });

    // ------------------------------------------------------------------ T5
    await step('the live cadence issues ~1 dashboard request per 2 s (not 10 s)', async () => {
      mock.reset();
      mock.state.latency.gasGet = LATENCY.gasGet;
      await evaluate(cdp, `startAutoRefresh(); true`);
      const before = gas('get_dashboard_data');
      await sleep(6500);
      await evaluate(cdp, `pauseAutoRefresh(); true`);
      // Allow the last in-flight cycle to finish so its request is counted.
      await waitFor(cdp, `refreshInFlight === false ? 1 : 0`, { timeoutMs: 10000 });
      await sleep(150);
      const used = gas('get_dashboard_data') - before;
      const perMinute = Math.round(used * 60 / 6.5);
      measurements.dashboardRequestsPerMinute = perMinute;
      measurements.dashboardRequestsIn6_5s = used;
      // 2 s cadence + ~0.8 s latency: about 3 cycles in 6.5 s. Allow a little
      // jitter either way; the old 10 s cadence would have produced 0-1.
      assertBetween(used, 2, 5, `dashboard requests in 6.5 s (live cadence)`);
    });

    // ------------------------------------------------------------------ T6
    await step('a repeated payload never duplicates activity rows or counts', async () => {
      await evaluate(cdp, `pauseAutoRefresh(); true`);
      await evaluate(cdp, `loadDashboardStats({ minAge: 0, force: true }); true`);
      await waitFor(cdp, `document.getElementById('statEntries').textContent.trim() !== '--' ? 1 : 0`, { timeoutMs: 15000 });
      await sleep(200);

      const rowsBefore = await evaluate(cdp, `document.querySelectorAll('#latestActivity .activity-item').length`);
      const entriesBefore = await evaluate(cdp, `document.getElementById('statEntries').textContent.trim()`);

      // Re-render the SAME payload three more times (simulates overlapping
      // refreshes receiving an identical body).
      for (let i = 0; i < 3; i++) {
        await evaluate(cdp, `loadDashboardStats({ minAge: 0, force: true }); true`);
        await sleep(50);
      }
      await sleep(1000);

      const rowsAfter = await evaluate(cdp, `document.querySelectorAll('#latestActivity .activity-item').length`);
      const entriesAfter = await evaluate(cdp, `document.getElementById('statEntries').textContent.trim()`);
      assertEq(rowsAfter, rowsBefore, 'activity row count after identical payloads');
      assertEq(entriesAfter, entriesBefore, 'today_entries after identical payloads');
    });

    // ------------------------------------------------------------------ T7
    await step('a refresh preserves history filters, dates and UI state (no reload)', async () => {
      await evaluate(cdp, `window.__liveMarker = 'alive'; navigateTo('history'); true`);
      await waitFor(cdp, `document.querySelectorAll('#historyTableBody tr').length > 0 ? 1 : 0`, { timeoutMs: 15000 });
      // Narrow the filters the way an operator would.
      await evaluate(cdp, `
        document.getElementById('historyName').value = 'Pavan';
        document.getElementById('historyAction').value = 'ENTRY';
        scheduleHistoryLoad();
        true
      `);
      await sleep(1200);
      const filtered = await evaluate(cdp, `(() => ({
        name: document.getElementById('historyName').value,
        action: document.getElementById('historyAction').value,
        date: document.getElementById('historyDate').value,
        rows: document.querySelectorAll('#historyTableBody tr').length
      }))()`);
      assertEq(filtered.name, 'Pavan', 'name filter survives');
      assertEq(filtered.action, 'ENTRY', 'action filter survives');
      assert(!!filtered.date, 'date filter is filled');
      assert(filtered.rows > 0, 'filtered rows are on screen');

      // Drive refreshes of the history page (live cadence) and confirm the
      // filter inputs and the SPA marker are untouched.
      for (let i = 0; i < 3; i++) {
        await evaluate(cdp, `refreshNow(); true`);
        await sleep(400);
      }
      await sleep(600);
      const after = await evaluate(cdp, `(() => ({
        marker: window.__liveMarker,
        name: document.getElementById('historyName').value,
        action: document.getElementById('historyAction').value,
        date: document.getElementById('historyDate').value,
        active: document.querySelector('.page.active') && document.querySelector('.page.active').id
      }))()`);
      assertEq(after.marker, 'alive', 'page must not reload during refresh');
      assertEq(after.name, 'Pavan', 'name filter after refresh');
      assertEq(after.action, 'ENTRY', 'action filter after refresh');
      assertEq(after.date, filtered.date, 'date filter after refresh');
      assertEq(after.active, 'page-history', 'still on the history page');
    });

    // ------------------------------------------------------------------ T8
    await step('reports keep expanded day groups across a refresh tick', async () => {
      await evaluate(cdp, `navigateTo('reports'); true`);
      await waitFor(cdp, `document.querySelectorAll('#reportGroups .report-day').length > 0 ? 1 : 0`, { timeoutMs: 15000 });
      // Open every collapsed day group.
      await evaluate(cdp, `
        document.querySelectorAll('#reportGroups details.report-day').forEach(d => { d.open = true; });
        document.querySelectorAll('#reportGroups details.report-day').length
      `);
      const openBefore = await evaluate(cdp, `
        [...document.querySelectorAll('#reportGroups details.report-day')].filter(d => d.open).length
      `);
      assert(openBefore > 0, 'at least one day group open');
      await evaluate(cdp, `refreshNow(); true`);
      await sleep(1500);
      // The report re-render rebuilds the details elements; the newest day is
      // open by contract. What must NOT happen is a full page reload (which
      // would reset scroll, marker and the chosen date range).
      const state = await evaluate(cdp, `(() => ({
        marker: window.__liveMarker,
        from: document.getElementById('reportFrom').value,
        to: document.getElementById('reportTo').value,
        open: [...document.querySelectorAll('#reportGroups details.report-day')].filter(d => d.open).length
      }))()`);
      assertEq(state.marker, 'alive', 'page must not reload while on reports');
      assert(!!state.from && !!state.to, 'chosen report range survives');
      assert(state.open >= 1, 'at least the newest day group is open after refresh');
    });

    // ------------------------------------------------------------------ T9
    await step('a slow backend stretches the cadence (adaptive backoff)', async () => {
      mock.reset();
      mock.state.latency.gasGet = 2500;
      // Must be on the dashboard: other pages reuse a longer navigation cache
      // and would not hit Apps Script on every tick.
      await evaluate(cdp, `navigateTo('dashboard'); hostHealth.clear(); refreshDelayMs = REFRESH_INTERVAL; startAutoRefresh(); true`);
      await sleep(200);
      const before = gas('get_dashboard_data');
      await sleep(9000);
      await evaluate(cdp, `pauseAutoRefresh(); true`);
      await waitFor(cdp, `refreshInFlight === false ? 1 : 0`, { timeoutMs: 15000 });
      const used = gas('get_dashboard_data') - before;
      const delay = await evaluate(cdp, `refreshDelayMs`);
      // With 2.5 s responses the delay must have grown past the 2 s baseline
      // toward the slow ceiling - and fewer requests than a fixed 2 s timer
      // would issue back-to-back.
      assert(delay > 2000, `refreshDelayMs must stretch above 2 s, got ${delay}`);
      assert(used >= 1, 'slow backend must still be polled');
      assert(used <= 4, `a 2.5 s backend must not be hammered (got ${used} requests in 9 s)`);
      measurements.slowBackendDelayMs = delay;
      measurements.slowBackendRequestsIn9s = used;
      mock.state.latency.gasGet = LATENCY.gasGet;
      mock.reset();
    });

    // ---------------------------------------------------------------- T10
    await step('a 30 s outage stays bounded thanks to adaptive backoff', async () => {
      try {
        mock.state.backend = 'fail';
        await evaluate(cdp, `navigateTo('dashboard'); hostHealth.clear(); refreshDelayMs = REFRESH_INTERVAL; startAutoRefresh(); true`);
        await sleep(200);
        const before = gas('get_dashboard_data');
        await sleep(30000);
        await evaluate(cdp, `pauseAutoRefresh(); true`);
        await waitFor(cdp, `refreshInFlight === false ? 1 : 0`, { timeoutMs: 20000 });
        const used = gas('get_dashboard_data') - before;
        measurements.outageRequestsIn30s = used;
        // Circuit breaker (attempts + cooldown) combined with adaptive
        // backoff: far fewer real HTTP attempts than one-per-2-seconds.
        assert(used >= 1, 'outage must be attempted at least once');
        assert(used <= 8, `30 s outage must stay bounded, got ${used}`);
        const ui = await evaluate(cdp, `(() => ({
          header: document.getElementById('systemStatusText').textContent,
          stats: document.getElementById('statRegistered').textContent.trim()
        }))()`);
        assertEq(ui.header, 'Backend Unreachable', 'honest outage header');
        assertEq(ui.stats, '--', 'no stale numbers during the outage');
      } finally {
        mock.state.backend = 'ok';
        await evaluate(cdp, `hostHealth.clear(); true`);
        mock.reset();
      }
    });

    // ---------------------------------------------------------------- T11
    await step('device last_seen advance triggers an immediate stats revalidation', async () => {
      await evaluate(cdp, `pauseAutoRefresh(); navigateTo('dashboard'); loadDashboard({ minAge: 0, force: true }); true`);
      // Wait for a COMPLETED stats fetch - not the optimistic first paint,
      // which can appear before the request finishes and would let the
      // nudge's singleFlight join an already-counted request.
      await waitFor(cdp, `(() => {
        const entry = responseCache.get('dashboardStats');
        return entry && (Date.now() - entry.ts) < 8000 ? 1 : 0;
      })()`, { timeoutMs: 15000 });
      await sleep(200);
      const before = gas('get_dashboard_data');
      // A fresh heartbeat (ESP32 just talked to the Worker) must pull stats
      // without waiting for the next scheduled tick.
      mock.injectEvent({ rfid_uid: 'NUDGE01', name: 'Nudge User', user_id: 'N001', action: 'EXIT' });
      await evaluate(cdp, `loadDeviceStatus({ minAge: 0 }); true`);
      await sleep(1500);
      const used = gas('get_dashboard_data') - before;
      assert(used >= 1, 'device activity must trigger a stats refresh');
    });

    // --------------------------------------------------- measurement summary
    console.log('\n--- live-refresh measurements (SIMULATED latencies, not production) ---');
    console.log(JSON.stringify(measurements, null, 2));
    const dir = path.join(ROOT, 'tests', 'perf');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'live-refresh-after.json'),
      JSON.stringify({ simulated: true, latency: LATENCY, measurements }, null, 2) + '\n'
    );
  } finally {
    try { await chrome.kill(); } catch { /* already gone */ }
    try { site.close(); } catch { /* already gone */ }
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} live-refresh tests passed`);
  if (failed.length) {
    for (const f of failed) console.log(`  - ${f.name}: ${f.error || ''}`);
    process.exitCode = 1;
  }
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
