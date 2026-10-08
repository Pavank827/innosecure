// Mock-backed end-to-end tests for the InnoSecure website.
//
//   node tests/e2e.mjs
//
// The real website code runs in headless Chrome against a deterministic mock
// backend (Apps Script + Cloudflare Worker + fonts), so every assertion is
// about observable behaviour: request counts, honest status text, cache
// reuse, optimistic updates and error states. No live network is used.
import { launchChrome, Cdp, startStaticServer, evaluate, waitFor, sleep } from './harness/lib.mjs';
import { createMockBackend } from './harness/mock.mjs';

const CHROME_PORT = 9466;

// Fixed latencies: fast enough for a short suite, slow enough that a
// debounced request (400 ms) and a response are clearly separated.
const LATENCY = { gasGet: 400, gasPost: 400, edge: 150, fontCss: 60, fontFile: 80 };

const results = [];
let current = null;

async function step(name, fn) {
  current = name;
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error: String(error && error.message || error) });
    console.log(`FAIL  ${name} -> ${error && error.message || error}`);
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

function assertIncludes(actual, needle, message) {
  if (!String(actual).includes(needle)) {
    throw new Error(`${message}: ${JSON.stringify(String(actual))} does not contain ${JSON.stringify(needle)}`);
  }
}

function localIso(date) {
  const p = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

async function main() {
  const site = await startStaticServer();
  const mock = createMockBackend({ latency: LATENCY });
  const chrome = await launchChrome({ debuggingPort: CHROME_PORT });
  const cdp = await Cdp.connect(chrome.target.webSocketDebuggerUrl);

  // Request bookkeeping (totals are always taken as deltas around a step).
  const total = () => mock.state.requests.length;
  const gas = action => mock.requestsOf('gas', action).length;
  const edge = () => mock.requestsOf('edge').length;

  const pauseRefresh = () => evaluate(cdp, 'clearInterval(refreshTimer); refreshTimer = null; true');
  const resumeRefresh = () => evaluate(cdp, 'startAutoRefresh(); true');

  try {
    await Promise.all([
      cdp.send('Page.enable'),
      cdp.send('Network.enable'),
      cdp.send('Runtime.enable')
    ]);
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await mock.install(cdp);

    // ---------------------------------------------------------------- T1
    await step('cold load shows the login screen and issues no API request', async () => {
      await cdp.send('Page.navigate', { url: site.url });
      await waitFor(cdp, `document.readyState === 'complete'`, { timeoutMs: 15000 });
      await evaluate(cdp, `sessionStorage.clear(); localStorage.clear(); true`);
      await cdp.send('Page.navigate', { url: site.url });
      await waitFor(cdp, `document.readyState === 'complete'`, { timeoutMs: 15000 });
      await sleep(600);

      const view = await evaluate(cdp, `(() => ({
        login: getComputedStyle(document.getElementById('loginScreen')).display !== 'none',
        app: getComputedStyle(document.getElementById('mainApp')).display !== 'none'
      }))()`);
      assert(view.login, 'login screen is not visible');
      assert(!view.app, 'main app must stay hidden before login');
      assertEq(mock.requestsOf('gas').length, 0, 'no Apps Script request before login');
      assertEq(edge(), 0, 'no edge request before login');
      mock.state.requests.length = 0;
    });

    // ---------------------------------------------------------------- T2
    await step('wrong password keeps the user on the login screen with an error', async () => {
      await evaluate(cdp, `
        document.getElementById('loginUsername').value = 'admin';
        document.getElementById('loginPassword').value = 'wrong';
        document.getElementById('loginForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
        true
      `);
      const message = await waitFor(cdp, `(() => {
        const el = document.getElementById('loginError');
        return el && el.style.display === 'block' && el.textContent ? el.textContent : 0;
      })()`, { timeoutMs: 10000 });
      assertIncludes(message, 'Invalid username or password', 'login error message');
      assertEq(gas('login'), 1, 'exactly one login attempt');
      assert(await evaluate(cdp, `getComputedStyle(document.getElementById('mainApp')).display === 'none'`),
        'app must not open after a failed login');
    });

    // ---------------------------------------------------------------- T3
    await step('login opens an honest dashboard (Checking... first, then live values)', async () => {
      const before = { gas: total() };
      await evaluate(cdp, `
        document.getElementById('loginPassword').value = 'secret';
        document.getElementById('loginForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
        true
      `);
      await waitFor(cdp, `document.getElementById('mainApp').style.display === 'flex' ? 1 : 0`, { timeoutMs: 15000 });

      // Shell is up but the backend has not answered yet: never claim ONLINE.
      const early = await evaluate(cdp, `(() => ({
        header: document.getElementById('systemStatusText').textContent,
        sheetsLoading: document.getElementById('statusSheets').classList.contains('loading'),
        statsLoading: document.getElementById('statRegistered').classList.contains('loading')
      }))()`);
      assertIncludes(early.header, 'Checking', `header before the first reply was "${early.header}"`);
      assert(!/System Online/i.test(early.header), 'must not claim System Online before the backend answers');
      assert(early.sheetsLoading && early.statsLoading, 'placeholders must show the loading state');

      await waitFor(cdp, `document.getElementById('statRegistered').textContent.trim() !== '--' ? 1 : 0`, { timeoutMs: 20000 });
      await waitFor(cdp, `document.getElementById('systemStatusText').textContent.indexOf('Checking') === -1 ? 1 : 0`, { timeoutMs: 20000 });
      await sleep(400);

      const ui = await evaluate(cdp, `(() => ({
        header: document.getElementById('systemStatusText').textContent,
        esp32: document.getElementById('statusESP32').textContent.trim(),
        rfid: document.getElementById('statusRFID').textContent.trim(),
        internet: document.getElementById('statusInternet').textContent.trim(),
        sheets: document.getElementById('statusSheets').textContent.trim(),
        lastSeen: document.getElementById('deviceLastSeen').textContent.trim(),
        registered: document.getElementById('statRegistered').textContent.trim(),
        inside: document.getElementById('statInside').textContent.trim(),
        statLoading: document.getElementById('statRegistered').classList.contains('loading'),
        sheetsLoading: document.getElementById('statusSheets').classList.contains('loading'),
        page: document.querySelector('.page.active') && document.querySelector('.page.active').id
      }))()`);
      assertEq(ui.header, 'System Online', 'header status');
      assertEq(ui.esp32, 'ONLINE', 'ESP32 status');
      assertEq(ui.rfid, 'READY', 'RFID status');
      assertEq(ui.internet, 'CONNECTED', 'internet status');
      assertEq(ui.sheets, 'SYNCED', 'Google Sheets status');
      assert(ui.lastSeen !== '--', 'device last seen must be filled from the heartbeat');
      assert(/^\d+$/.test(ui.registered), `registered users must be a number, got "${ui.registered}"`);
      assert(/^\d+$/.test(ui.inside), `currently inside must be a number, got "${ui.inside}"`);
      assert(!ui.statLoading && !ui.sheetsLoading, 'loading state must be cleared once data arrives');
      assertEq(ui.page, 'page-dashboard', 'dashboard is the active page');
      assertEq(gas('get_dashboard_data'), 1, 'one dashboard statistics request');
      assertEq(edge(), 1, 'one device status request');
      assert(await evaluate(cdp, `window.__e2eMarker = 'alive'; window.__e2eMarker`), 'marker setup');
    });

    // ---------------------------------------------------------------- T4
    await step('device status text follows the real heartbeat state', async () => {
      await pauseRefresh();
      // Between sub-steps the breaker cooldown is treated as elapsed (time
      // passing); otherwise a failed probe would block the next one for 15 s.
      const settle = async () => {
        mock.state.edgeMode = 'ok';
        await evaluate(cdp, `hostHealth.clear(); true`);
      };
      try {
        mock.state.edgeMode = 'fail';
        await evaluate(cdp, `loadDeviceStatus({ minAge: 0 })`);
        await waitFor(cdp, `document.getElementById('statusESP32').textContent.indexOf('UNKNOWN') !== -1 ? 1 : 0`, { timeoutMs: 10000 });
        let ui = await evaluate(cdp, `(() => ({
          esp32: document.getElementById('statusESP32').textContent.trim(),
          rfid: document.getElementById('statusRFID').textContent.trim(),
          header: document.getElementById('systemStatusText').textContent
        }))()`);
        assertEq(ui.esp32, 'UNKNOWN', 'edge failure must show UNKNOWN, not ONLINE');
        assertEq(ui.rfid, 'UNKNOWN', 'RFID status on edge failure');
        assertIncludes(ui.header, 'Device Unknown', 'header on edge failure');
        await settle();

        mock.state.deviceState = 'NEVER_SEEN';
        await evaluate(cdp, `loadDeviceStatus({ minAge: 0 })`);
        await waitFor(cdp, `document.getElementById('statusESP32').textContent.indexOf('NEVER SEEN') !== -1 ? 1 : 0`, { timeoutMs: 10000 });
        ui = await evaluate(cdp, `(() => ({
          esp32: document.getElementById('statusESP32').textContent.trim(),
          rfid: document.getElementById('statusRFID').textContent.trim(),
          header: document.getElementById('systemStatusText').textContent
        }))()`);
        assertEq(ui.esp32, 'NEVER SEEN', 'never-seen device');
        assertEq(ui.rfid, 'UNKNOWN', 'RFID status for a device that never reported');
        assertIncludes(ui.header, 'Device Never Seen', 'header for a device that never reported');

        mock.state.deviceState = 'OFFLINE';
        await evaluate(cdp, `loadDeviceStatus({ minAge: 0 })`);
        await waitFor(cdp, `document.getElementById('statusESP32').textContent.indexOf('OFFLINE') !== -1 ? 1 : 0`, { timeoutMs: 10000 });
        ui = await evaluate(cdp, `(() => ({
          esp32: document.getElementById('statusESP32').textContent.trim(),
          rfid: document.getElementById('statusRFID').textContent.trim(),
          header: document.getElementById('systemStatusText').textContent
        }))()`);
        assertEq(ui.esp32, 'OFFLINE', 'offline device');
        assertEq(ui.rfid, 'NOT READY', 'RFID status while the device is offline');
        assertIncludes(ui.header, 'Device Offline', 'header while the device is offline');
      } finally {
        // Always leave a healthy, online device behind for the later steps.
        mock.state.deviceState = 'ONLINE';
        mock.state.edgeMode = 'ok';
        await evaluate(cdp, `hostHealth.clear(); loadDeviceStatus({ minAge: 0 })`);
      }
    });

    // ---------------------------------------------------------------- T5
    await step('browser offline state is reported as No Internet', async () => {
      await cdp.send('Network.emulateNetworkConditions', {
        offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1
      });
      await evaluate(cdp, `window.dispatchEvent(new Event('offline')); true`);
      const ui = await evaluate(cdp, `(() => ({
        internet: document.getElementById('statusInternet').textContent.trim(),
        header: document.getElementById('systemStatusText').textContent
      }))()`);
      assertEq(ui.internet, 'DISCONNECTED', 'internet status while the browser is offline');
      assertEq(ui.header, 'No Internet', 'header while the browser is offline');

      await cdp.send('Network.emulateNetworkConditions', {
        offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1
      });
      await evaluate(cdp, `window.dispatchEvent(new Event('online')); true`);
      const back = await evaluate(cdp, `document.getElementById('statusInternet').textContent.trim()`);
      assertEq(back, 'CONNECTED', 'internet status after reconnecting');
    });

    // ---------------------------------------------------------------- T6
    await step('Apps Script outage shows an error state and fails fast (bounded retries)', async () => {
      try {
        mock.state.backend = 'fail';
        const before = gas('get_dashboard_data');
        await evaluate(cdp, `loadDashboard({ minAge: 0 })`);

        const message = await waitFor(cdp, `(() => {
          const txt = document.getElementById('latestActivity').textContent;
          return /Could not reach the backend|Backend returned an error/.test(txt) ? txt.trim() : 0;
        })()`, { timeoutMs: 20000 });
        assertIncludes(message, 'backend', 'dashboard error message');

        const ui = await evaluate(cdp, `(() => ({
          header: document.getElementById('systemStatusText').textContent,
          sheets: document.getElementById('statusSheets').textContent.trim(),
          stats: document.getElementById('statRegistered').textContent.trim(),
          interactive: typeof navigateTo === 'function'
        }))()`);
        assertEq(ui.header, 'Backend Unreachable', 'header during the outage');
        assertEq(ui.sheets, 'ERROR', 'sheets status during the outage');
        assertEq(ui.stats, '--', 'statistics must not show stale numbers during an outage');
        assert(ui.interactive, 'page must stay interactive during the outage');

        const used = gas('get_dashboard_data') - before;
        assert(used <= 5, `one outage chain must stay bounded, used ${used} requests`);
        assert(used >= 1, 'the outage must produce at least one attempt');
      } finally {
        mock.state.backend = 'ok';
        await evaluate(cdp, `hostHealth.clear(); true`);
      }

      // Recovery: the breaker opens after repeated failures, so simulate the
      // cooldown having elapsed (time passing) and bring the backend back.
      await evaluate(cdp, `loadDashboard({ minAge: 0 })`);
      await waitFor(cdp, `document.getElementById('systemStatusText').textContent === 'System Online' ? 1 : 0`, { timeoutMs: 15000 });
      const after = await evaluate(cdp, `(() => ({
        sheets: document.getElementById('statusSheets').textContent.trim(),
        stats: document.getElementById('statRegistered').textContent.trim()
      }))()`);
      assertEq(after.sheets, 'SYNCED', 'sheets status after recovery');
      assert(/^\d+$/.test(after.stats), 'statistics must come back after recovery');
    });

    // ---------------------------------------------------------------- T7
    await step('10-second auto refresh still runs while the tab is visible', async () => {
      await resumeRefresh();
      const before = { dash: gas('get_dashboard_data'), edge: edge() };
      await sleep(11000);
      assert(gas('get_dashboard_data') - before.dash >= 1, 'dashboard statistics must refresh within 11 s');
      assert(edge() - before.edge >= 1, 'device status must refresh within 11 s');
    });

    // ---------------------------------------------------------------- T8
    await step('a 30 s Google outage costs far fewer requests than before and stays usable', async () => {
      try {
        mock.state.backend = 'fail';
        const before = gas('get_dashboard_data');
        await sleep(30000);
        const used = gas('get_dashboard_data') - before;
        const ui = await evaluate(cdp, `(() => ({
          header: document.getElementById('systemStatusText').textContent,
          sheets: document.getElementById('statusSheets').textContent.trim(),
          stats: document.getElementById('statRegistered').textContent.trim()
        }))()`);
        assertEq(ui.header, 'Backend Unreachable', 'header after 30 s of outage');
        assertEq(ui.sheets, 'ERROR', 'sheets status after 30 s of outage');
        assertEq(ui.stats, '--', 'statistics during the outage');
        assert(used <= 6, `30 s outage must stay bounded (baseline was 9), got ${used}`);
        assert(used >= 1, 'the outage must be attempted at least once');

        // Recovery must happen on its own once the backend answers again.
        // Let any in-flight failing refresh finish first, then simulate the
        // breaker cooldown having elapsed (time passing).
        mock.state.backend = 'ok';
        await waitFor(cdp, `refreshInFlight === false ? 1 : 0`, { timeoutMs: 20000 });
        await evaluate(cdp, `hostHealth.clear(); true`);
        await waitFor(cdp, `document.getElementById('systemStatusText').textContent === 'System Online' ? 1 : 0`, { timeoutMs: 20000 });
      } finally {
        // Whatever happened above, later steps need a healthy backend and a
        // paused refresh timer so their request counts stay deterministic.
        mock.state.backend = 'ok';
        await evaluate(cdp, `hostHealth.clear(); true`);
        await pauseRefresh();
      }
    });

    // ---------------------------------------------------------------- T9
    await step('page switching is synchronous and never reloads the page', async () => {
      await evaluate(cdp, `window.__e2eMarker = 'alive'; true`);
      for (const page of ['users', 'inside', 'history', 'reports', 'dashboard']) {
        const ms = await evaluate(cdp, `(() => { const t = performance.now(); navigateTo('${page}'); return performance.now() - t; })()`);
        assert(ms < 100, `navigateTo('${page}') took ${ms.toFixed(1)} ms (must be synchronous)`);
        const state = await evaluate(cdp, `(() => ({
          marker: window.__e2eMarker,
          active: document.querySelector('.page.active').id
        }))()`);
        assertEq(state.marker, 'alive', 'page must not reload during navigation');
        assertEq(state.active, `page-${page}`, `active page after navigating to ${page}`);
      }
    });

    // ---------------------------------------------------------------- T10
    await step('returning to the dashboard reuses fresh data (no new request)', async () => {
      await evaluate(cdp, `navigateTo('inside'); true`);
      await waitFor(cdp, `document.getElementById('insideCount').textContent.trim() !== '--' ? 1 : 0`, { timeoutMs: 15000 });
      // Let the dashboard fetch started by the previous step finish first so
      // the measurement below starts from a settled state.
      await sleep(800);
      const before = total();

      const painted = await evaluate(cdp, `(() => {
        document.getElementById('statRegistered').textContent = '--';
        navigateTo('dashboard');
        return document.getElementById('statRegistered').textContent.trim();
      })()`);
      assert(/^\d+$/.test(painted), `dashboard must repaint instantly from cache, got "${painted}"`);
      await sleep(700);
      assertEq(total() - before, 0, 'no request when the dashboard data is still fresh');
      const value = await evaluate(cdp, `document.getElementById('statRegistered').textContent.trim()`);
      assert(/^\d+$/.test(value), 'dashboard keeps showing real numbers after the cached paint');
    });

    // ---------------------------------------------------------------- T11
    await step('users tab loads once and reuses the list on re-toggle', async () => {
      await evaluate(cdp, `navigateTo('users'); true`);
      await waitFor(cdp, `getComputedStyle(document.getElementById('usersPanelRegister')).display !== 'none' ? 1 : 0`, { timeoutMs: 10000 });

      await evaluate(cdp, `switchUsersTab('registered'); true`);
      await waitFor(cdp, `(() => {
        const body = document.getElementById('usersTableBody');
        return body && !/Loading users/.test(body.textContent) && body.querySelectorAll('tr').length > 0 ? 1 : 0;
      })()`, { timeoutMs: 15000 });
      const rows = await evaluate(cdp, `document.querySelectorAll('#usersTableBody tr').length`);
      assertEq(rows, 12, 'registered users row count');
      assertEq(gas('get_users'), 1, 'the users list is fetched once');

      const before = gas('get_users');
      await evaluate(cdp, `switchUsersTab('register'); switchUsersTab('registered'); true`);
      await sleep(1000);
      assertEq(gas('get_users') - before, 0, 're-entering the tab must reuse the cached list');
      const again = await evaluate(cdp, `document.querySelectorAll('#usersTableBody tr').length`);
      assertEq(again, 12, 'rows are still rendered after the re-toggle');
    });

    // ---------------------------------------------------------------- T12
    await step('a duplicate User ID is blocked locally without a register request', async () => {
      const before = gas('register_user');
      await evaluate(cdp, `(() => {
        document.getElementById('regUserName').value = 'Duplicate Person';
        document.getElementById('regUserUserId').value = 'A866051240';
        document.getElementById('regUserDept').value = 'CSE';
        document.getElementById('regUserType').value = 'Student';
        handleRFIDDetected('EE77AA99');
        document.getElementById('registerUserForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
        return true;
      })()`);

      const toast = await waitFor(cdp, `(() => {
        const el = document.getElementById('toast');
        return el && el.style.display === 'block' ? document.getElementById('toastMessage').textContent : 0;
      })()`, { timeoutMs: 10000 });
      assertIncludes(toast, 'already registered', 'duplicate User ID must be reported');
      assertIncludes(toast, 'Pavan Kumar', 'the error must name the existing owner');
      assertEq(gas('register_user') - before, 0, 'duplicate registration must not reach the backend');
      const rows = await evaluate(cdp, `document.querySelectorAll('#usersTableBody tr').length`);
      assertEq(rows, 12, 'the users table must not gain a row');
      await waitFor(cdp, `document.getElementById('toast').style.display === 'none' ? 1 : 0`, { timeoutMs: 8000 });
    });

    // ---------------------------------------------------------------- T13
    await step('a new registration appears immediately and is confirmed once', async () => {
      const before = { register: gas('register_user'), users: gas('get_users') };
      await evaluate(cdp, `(() => {
        document.getElementById('regUserName').value = 'E2E Test User';
        document.getElementById('regUserUserId').value = 'A999999999';
        document.getElementById('regUserDept').value = 'ECE';
        document.getElementById('regUserType').value = 'Student';
        handleRFIDDetected('FF00EE11');
        document.getElementById('registerUserForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
        return true;
      })()`);

      const toast = await waitFor(cdp, `(() => {
        const el = document.getElementById('toast');
        return el && el.style.display === 'block' ? document.getElementById('toastMessage').textContent : 0;
      })()`, { timeoutMs: 10000 });
      assertIncludes(toast, 'registered successfully', 'registration success toast');

      const optimistic = await evaluate(cdp, `document.getElementById('usersTableBody').textContent`);
      assertIncludes(optimistic, 'E2E Test User', 'the new user must be visible without waiting for a refetch');

      await waitFor(cdp, `document.querySelectorAll('#usersTableBody tr').length === 13 ? 1 : 0`, { timeoutMs: 15000 });
      assertEq(gas('register_user') - before.register, 1, 'exactly one register request');
      assert(gas('get_users') - before.users <= 1, 'the confirmation refetch must be a single request');
      await waitFor(cdp, `document.getElementById('toast').style.display === 'none' ? 1 : 0`, { timeoutMs: 8000 });
    });

    // ---------------------------------------------------------------- T14
    await step('history filtering previews instantly and sends exactly one request', async () => {
      await evaluate(cdp, `navigateTo('history'); true`);
      await waitFor(cdp, `document.querySelectorAll('#historyTableBody tr').length > 0 &&
        !/Loading history/.test(document.getElementById('historyTableBody').textContent) ? 1 : 0`, { timeoutMs: 15000 });
      // The table above may already show cached rows while the initial request
      // is still in flight; let it land so the typing below cannot race it
      // (two different history queries at once is what the overlap check looks for).
      await sleep(900);
      const before = gas('get_history');

      const typed = await evaluate(cdp, `(() => {
        const table = document.getElementById('historyTableBody');
        window.__histBefore = table.textContent;
        const input = document.getElementById('historyName');
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        for (const ch of 'Neha') {
          input.value += ch;
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
        return { changed: table.textContent !== window.__histBefore, text: table.textContent };
      })()`);
      assert(typed.changed, 'the filtered rows must update before the debounced request answers');
      assertIncludes(typed.text, 'Neha Gupta', 'the preview must show matching rows');

      await sleep(1300);
      assertEq(gas('get_history') - before, 1, '4 keystrokes must cost exactly one request');
      const final = await evaluate(cdp, `document.getElementById('historyTableBody').textContent`);
      assertIncludes(final, 'Neha Gupta', 'the authoritative response is rendered too');
      assert(!final.includes('Rahul Sharma'), 'the filtered table must not contain non-matching rows');

      // Clear the filter again so later steps start from a known state.
      const clearBefore = gas('get_history');
      await evaluate(cdp, `(() => {
        const input = document.getElementById('historyName');
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
      await sleep(1300);
      assert(gas('get_history') - clearBefore <= 1, 'clearing the filter costs at most one request');
    });

    // ---------------------------------------------------------------- T15
    await step('reports default to the last 7 days and honour the cache window', async () => {
      // The page was first opened during the navigation step above; that load
      // plus every revisit inside the 25 s window must stay at one request.
      const before = gas('get_reports');
      await evaluate(cdp, `navigateTo('reports'); true`);
      // Give the (async) request time to be issued and answered before the
      // count is checked: the table text from the previous visit is still on
      // screen, so "table has rows" alone is not a completion signal.
      await sleep(1200);

      const today = new Date();
      const expectedFrom = localIso(new Date(today.getTime() - 6 * 86400000));
      const expectedTo = localIso(today);
      const ui = await evaluate(cdp, `(() => ({
        from: document.getElementById('reportFrom').value,
        to: document.getElementById('reportTo').value,
        entries: document.getElementById('reportEntries').textContent.trim(),
        rows: document.querySelectorAll('#reportTableBody tr').length
      }))()`);
      assertEq(ui.from, expectedFrom, 'default report start date (7 days incl. today)');
      assertEq(ui.to, expectedTo, 'default report end date (today)');
      assertEq(before, 1, 'the first visit to the reports page must issue exactly one request');
      assertEq(gas('get_reports') - before, 0, 're-entering must reuse the cached report');
      assert(/^\d+$/.test(ui.entries), 'report totals must be filled in');
      assert(ui.rows > 0, 'report table must contain rows');
      // Precondition for the revisit below: the entry must still be inside the
      // cache window, otherwise the "no refetch" claim would be a timing guess.
      assert(await evaluate(cdp, `cacheIsFresh(\`report|\${document.getElementById('reportFrom').value}|\${document.getElementById('reportTo').value}\`, REPORT_CACHE_TTL_MS)`),
        'the report cache must still be fresh');

      const revisitBefore = gas('get_reports');
      const painted = await evaluate(cdp, `(() => {
        navigateTo('dashboard');
        navigateTo('reports');
        return document.querySelectorAll('#reportTableBody tr').length;
      })()`);
      assert(painted > 0, 'revisiting reports must repaint instantly from cache');
      await sleep(700);
      assertEq(gas('get_reports') - revisitBefore, 0, 'no report request while the cache is fresh');
    });

    // ---------------------------------------------------------------- T16
    await step('two simultaneous dashboard loads share one request (single flight)', async () => {
      const beforeGas = gas('get_dashboard_data');
      const beforeEdge = edge();
      await evaluate(cdp, `Promise.all([loadDashboard({ minAge: 0 }), loadDashboard({ minAge: 0 })]).then(() => true)`);
      await sleep(400);
      assertEq(gas('get_dashboard_data') - beforeGas, 1, 'concurrent dashboard loads must issue one statistics request');
      assertEq(edge() - beforeEdge, 1, 'concurrent dashboard loads must issue one heartbeat request');
    });

    // ---------------------------------------------------------------- T17
    await step('no identical requests ever overlap across the whole session', async () => {
      const overlapping = Object.entries(mock.state.maxConcurrentByKey).filter(([, v]) => v > 1);
      assertEq(overlapping.length, 0, `overlapping identical requests: ${JSON.stringify(Object.fromEntries(overlapping))}`);
    });

    // ---------------------------------------------------------------- T18
    await step('session survives a reload with cached dashboard paint (no fake status)', async () => {
      await cdp.send('Page.navigate', { url: site.url });
      await waitFor(cdp, `document.readyState === 'complete'`, { timeoutMs: 15000 });
      await waitFor(cdp, `document.getElementById('mainApp').style.display === 'flex' ? 1 : 0`, { timeoutMs: 15000 });

      // Cached numbers may paint instantly; the status header may not claim
      // ONLINE until the live sources answer.
      const early = await evaluate(cdp, `(() => ({
        header: document.getElementById('systemStatusText').textContent,
        stat: document.getElementById('statRegistered').textContent.trim()
      }))()`);
      assert(!/System Online/i.test(early.header), `header must not claim ONLINE immediately, got "${early.header}"`);
      assertIncludes(early.header, 'Checking', `header must start in Checking state, got "${early.header}"`);

      await waitFor(cdp, `document.getElementById('systemStatusText').textContent === 'System Online' ? 1 : 0`, { timeoutMs: 20000 });
      await waitFor(cdp, `document.getElementById('statusESP32').textContent.indexOf('ONLINE') !== -1 ? 1 : 0`, { timeoutMs: 20000 });
      const ui = await evaluate(cdp, `(() => ({
        stat: document.getElementById('statRegistered').textContent.trim(),
        esp32: document.getElementById('statusESP32').textContent.trim()
      }))()`);
      assert(/^\d+$/.test(ui.stat), 'cached statistics are shown after the reload');
      assertEq(ui.esp32, 'ONLINE', 'live device status after the reload');
      assert(await evaluate(cdp, `window.__e2eMarker === undefined || window.__e2eMarker !== 'alive'`),
        'a reload must reset page state (marker cleared)');
    });

    // ---------------------------------------------------------------- summary
    const passed = results.filter(r => r.ok).length;
    const failed = results.length - passed;
    console.log(`\n${passed}/${results.length} checks passed`);
    if (failed) {
      console.log('Failures:');
      for (const r of results.filter(r => !r.ok)) console.log(`  - ${r.name}: ${r.error}`);
    }
    console.log(`requests by action: ${JSON.stringify(mock.counts())}`);
    console.log(`max concurrent per action: ${JSON.stringify(mock.state.maxConcurrentByKey)}`);
    process.exitCode = failed ? 1 : 0;
  } finally {
    cdp.close();
    chrome.kill();
    await site.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
