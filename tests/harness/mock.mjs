// Deterministic mock backend for profiling + E2E runs.
//
// Intercepts requests at the Chrome DevTools "Fetch" layer so the real
// website code runs unmodified against stable, repeatable responses:
//   - script.google.com / script.googleusercontent.com  -> Apps Script mock
//   - makerspace-rfid-edge-api.workers.dev              -> Cloudflare Worker mock
//   - fonts.googleapis.com / fonts.gstatic.com          -> cached real font CSS/woff2
//   - everything else                                   -> served normally
//
// Latencies are fixed constants so before/after runs are comparable.

const DEFAULT_LATENCY = {
  gasGet: 900,
  gasPost: 900,
  edge: 250,
  fontCss: 180,
  fontFile: 250
};

export function istNow(offsetMs = 0) {
  return istFromMs(Date.now() + offsetMs);
}

function istFromMs(ms) {
  const d = new Date(ms);
  const ist = new Date(d.getTime() + (330 + d.getTimezoneOffset()) * 60000);
  const p = n => String(n).padStart(2, '0');
  return `${ist.getFullYear()}-${p(ist.getMonth() + 1)}-${p(ist.getDate())} ${p(ist.getHours())}:${p(ist.getMinutes())}:${p(ist.getSeconds())}`;
}

function buildDataset() {
  const names = [
    ['Pavan Kumar', 'A866051240', 'CSE', 'Student', 'A37B9122'],
    ['Rahul Sharma', 'A866051241', 'ECE', 'Student', 'B48C0233'],
    ['Priya Patel', 'A866051242', 'CSE', 'Student', 'C59D1344'],
    ['Amit Singh', 'A866051243', 'MECH', 'Staff', 'D60E2455'],
    ['Sneha Reddy', 'A866051244', 'CSE', 'Student', 'E71F3566'],
    ['Vikram Iyer', 'A866051245', 'EEE', 'Teacher', 'F82G4677'],
    ['Neha Gupta', 'A866051246', 'CIVIL', 'Student', 'G93H5788'],
    ['Arjun Nair', 'A866051247', 'CSE', 'Student', 'H04I6899'],
    ['Kavya Rao', 'A866051248', 'ECE', 'Student', 'I15J7900'],
    ['Rohan Das', 'A866051249', 'MECH', 'Student', 'J26K8011'],
    ['Meera Joshi', 'A866051250', 'CSE', 'Teacher', 'K37L9122'],
    ['Suresh Babu', 'A866051251', 'EEE', 'Staff', 'L48M0233']
  ];

  const users = names.map(([name, user_id, department, user_type, rfid_uid], i) => ({
    rfid_uid,
    name,
    user_id,
    department,
    user_type,
    status: i === 11 ? 'Inactive' : 'Active',
    registration_date: '2026-09-01',
    current_status: i < 5 ? 'INSIDE' : 'OUTSIDE'
  }));

  const inside = users.filter(u => u.current_status === 'INSIDE').map((u, i) => ({
    name: u.name,
    user_id: u.user_id,
    department: u.department,
    entry_time: `0${9 + i}:1${i}:00`,
    duration: `${1 + i}h ${5 + i * 7}m`,
    rfid_uid: u.rfid_uid
  }));

  // 10 days of history in append order (oldest row first, exactly like the
  // Access_Log sheet). get_history serves the newest rows first, which is how
  // the Apps Script backend answers (it walks the sheet backwards).
  const HISTORY_DAYS = 10;
  const history = [];
  for (let day = HISTORY_DAYS - 1; day >= 0; day--) {
    const date = new Date(Date.now() - day * 86400000);
    const p = n => String(n).padStart(2, '0');
    const key = `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
    for (let r = 0; r < 6; r++) {
      const u = users[(day * 6 + r) % users.length];
      const action = r % 3 === 2 ? 'EXIT' : 'ENTRY';
      history.push({
        date: key,
        time: `${p(8 + r)}:${p((r * 13) % 60)}:00`,
        name: u.name,
        user_id: u.user_id,
        rfid_uid: u.rfid_uid,
        action,
        status: 'ALLOWED',
        timestamp: `${key} ${p(8 + r)}:${p((r * 13) % 60)}:00`
      });
    }
  }

  return { users, inside, history };
}

// Local calendar day, same shape the backend returns in record.date.
function localDateKey(offsetMs = 0) {
  const date = new Date(Date.now() + offsetMs);
  const p = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

function envelope(success, message, data) {
  return { success, message: message || '', timestamp: new Date().toISOString(), data: data || {} };
}

export function createMockBackend(options = {}) {
  const dataset = buildDataset();
  const state = {
    latency: { ...DEFAULT_LATENCY, ...(options.latency || {}) },
    backend: options.backend || 'ok',     // 'ok' | 'fail' (Apps Script down)
    edgeMode: options.edgeMode || 'ok',   // 'ok' | 'fail'
    deviceState: options.deviceState || 'ONLINE',
    // Absolute last_seen timestamp (ms). Stable between polls - the real
    // Worker only advances it when the ESP32 actually talks to the edge - so
    // the website's activity nudge is not falsely retriggered by every reply.
    deviceLastSeenMs: Date.now() - 12000,
    dashboardLegacy: false,               // drop recent_scans/total_visits (old backend)
    deleteFail: false,                    // delete_history_record always refuses
    requests: [],                          // every intercepted request
    maxConcurrentByKey: {},                // worst observed overlap per action
    counters: {},
    failCount: 0,
    registered: dataset.users.slice(),    // mutable copy (registration tests)
    // Events injected by live-refresh tests (simulated ESP32 card taps that
    // landed in Access_Log). Counters on get_dashboard_data include them.
    injected: [],
    insideDelta: 0
  };

  const inFlightByKey = new Map();

  function record(kind, key, method, url) {
    const entry = { t: Date.now(), kind, key, method, url };
    state.requests.push(entry);
    state.counters[key] = (state.counters[key] || 0) + 1;
    const n = (inFlightByKey.get(key) || 0) + 1;
    inFlightByKey.set(key, n);
    state.maxConcurrentByKey[key] = Math.max(state.maxConcurrentByKey[key] || 0, n);
    return () => {
      const cur = (inFlightByKey.get(key) || 1) - 1;
      if (cur <= 0) inFlightByKey.delete(key);
      else inFlightByKey.set(key, cur);
    };
  }

  function actionFromUrl(url, method, postData) {
    const u = new URL(url);
    if (method === 'POST' && postData) {
      try {
        const body = JSON.parse(postData);
        return { action: body.action, data: body.data || {}, query: {} };
      } catch { return { action: '', data: {}, query: {} }; }
    }
    return { action: u.searchParams.get('action') || '', data: {}, query: Object.fromEntries(u.searchParams) };
  }

  function gasResponse(action, params) {
    switch (action) {
      case 'login':
        if (params.password === 'wrong') return envelope(false, 'Invalid username or password');
        return envelope(true, 'Login successful', { token: 'mock-session-token', username: params.username, role: 'admin' });
      case 'get_dashboard_data': {
        // Same shape the Apps Script backend answers with: five most recent
        // scans, and the distinct cards that entered today (the Reports
        // total_visits scoped to a single day). Counters include events
        // injected by tests via injectEvent(), so a live-refresh assertion
        // can see the numbers move exactly like production.
        const today = localDateKey();
        const newestFirst = [...dataset.history]
          .sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
        const injectedToday = state.injected.filter(e => e.date === today);
        const payload = {
          registered_users: state.registered.length,
          currently_inside: dataset.inside.length + state.insideDelta,
          today_entries: 58 + injectedToday.filter(e => e.action === 'ENTRY').length,
          today_exits: 41 + injectedToday.filter(e => e.action === 'EXIT').length,
          latest_scan: {
            timestamp: istNow(-120000),
            name: dataset.users[0].name,
            rfid_uid: dataset.users[0].rfid_uid,
            action: 'ENTRY',
            status: 'ALLOWED'
          },
          last_sync: istNow(-5000),
          system_status: { esp32: 'ONLINE', rfid: 'READY', internet: 'CONNECTED', google_sheets: 'SYNCED' }
        };
        if (!state.dashboardLegacy) {
          payload.recent_scans = newestFirst
            .filter(r => r.action === 'ENTRY' || r.action === 'EXIT')
            .slice(0, 5);
          payload.total_visits = new Set(dataset.history
            .filter(r => r.date === today && r.action === 'ENTRY')
            .map(r => r.rfid_uid)).size;
        }
        return envelope(true, 'Dashboard data retrieved', payload);
      }
      case 'get_users':
        return envelope(true, 'Users retrieved', { users: state.registered });
      case 'get_current_inside':
        return envelope(true, 'Inside retrieved', { count: dataset.inside.length, users: dataset.inside });
      case 'get_history': {
        const date = String(params.filter_date || params.filterDate || '').substring(0, 10);
        const name = String(params.filter_name || '').toLowerCase();
        const rfid = String(params.filter_rfid || '').toLowerCase();
        const actionFilter = String(params.filter_action || '').toUpperCase();
        const limit = Number(params.limit) > 0 ? Math.min(Number(params.limit), 1000) : 100;
        const matched = dataset.history.filter(row =>
          (!date || row.date === date) &&
          (!name || row.name.toLowerCase().includes(name)) &&
          (!rfid || row.rfid_uid.toLowerCase().includes(rfid)) &&
          (!actionFilter || row.action === actionFilter)
        );
        // Newest first, at most `limit` rows: the Apps Script backend walks
        // the sheet backwards and stops once the limit is reached.
        const rows = matched.slice(Math.max(0, matched.length - limit)).reverse();
        return envelope(true, 'History retrieved', { history: rows });
      }
      case 'get_reports': {
        const from = String(params.from_date || '');
        const to = String(params.to_date || '');
        const rows = dataset.history
          .filter(r => (!from || r.date >= from) && (!to || r.date <= to))
          .map((r, i) => ({ sno: i + 1, department: 'CSE', user_type: 'Student', ...r }));
        return envelope(true, 'Report generated', {
          from_date: from,
          to_date: to,
          total_entries: rows.filter(r => r.action === 'ENTRY').length,
          total_exits: rows.filter(r => r.action === 'EXIT').length,
          // Same definition as the real backend: distinct (card, day) pairs.
          total_visits: new Set(rows
            .filter(r => r.action === 'ENTRY')
            .map(r => `${r.rfid_uid}_${r.date}`)).size,
          currently_inside: dataset.inside.length,
          data: rows
        });
      }
      case 'register_user': {
        if (state.registered.some(u => u.rfid_uid === params.rfid_uid)) {
          return envelope(false, 'RFID card already registered');
        }
        state.registered.push({
          rfid_uid: params.rfid_uid,
          name: params.name,
          user_id: params.user_id,
          department: params.department,
          user_type: params.user_type,
          status: 'Active',
          registration_date: '2026-10-08',
          current_status: 'OUTSIDE'
        });
        return envelope(true, 'User registered', { rfid_uid: params.rfid_uid, name: params.name });
      }
      case 'update_user':
        return envelope(true, 'User updated');
      case 'delete_history_record': {
        // Mirrors PROTECTED_ACTIONS on the real backend: no session token,
        // no deletion.
        if (!params.auth_token) {
          return envelope(false, 'Authentication required for delete_history_record');
        }
        if (state.deleteFail) {
          return envelope(false, 'Sheet write rejected by the backend');
        }
        const key = r => [r.timestamp, r.date, r.time, r.rfid_uid, r.name,
          r.user_id, r.action, r.status].join('|');
        const wanted = key({
          timestamp: String(params.timestamp || ''), date: String(params.date || ''),
          time: String(params.time || ''), rfid_uid: String(params.rfid_uid || ''),
          name: String(params.name || ''), user_id: String(params.user_id || ''),
          action: String(params.action || ''), status: String(params.status || '')
        });
        const idx = dataset.history.findIndex(r => key(r) === wanted);
        if (idx === -1) return envelope(false, 'History record not found (it may have changed)');
        dataset.history.splice(idx, 1);
        return envelope(true, 'History record deleted');
      }
      case 'start_rfid_registration':
        return envelope(true, 'Scan started', { request_id: 'req-1', status: 'WAITING' });
      case 'get_rfid_registration_status':
        return envelope(true, 'Polled', { status: 'IDLE', rfid_uid: '' });
      case 'export_excel':
        return envelope(true, 'Export ready', { data: dataset.history.slice(0, 20).map((r, i) => ({ sno: i + 1, ...r })) });
      default:
        return envelope(true, '', {});
    }
  }

  function edgeResponse() {
    if (state.deviceState === 'NEVER_SEEN') {
      return { success: true, data: { state: 'NEVER_SEEN', last_seen: '', last_seen_ist: '' } };
    }
    const seen = new Date(state.deviceLastSeenMs);
    return {
      success: true,
      data: {
        state: state.deviceState,
        last_seen: seen.toISOString(),
        last_seen_ist: istFromMs(state.deviceLastSeenMs)
      }
    };
  }

  async function install(cdp, { fontCss, fontFiles } = {}) {
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });

    // The real endpoints are cross-origin, so they all send ACAO: * — without
    // it Chrome would surface a CORS error instead of the HTTP status.
    const cors = [{ name: 'Access-Control-Allow-Origin', value: '*' }];
    const noStore = { name: 'Cache-Control', value: 'no-store' };

    cdp.on('Fetch.requestPaused', async ev => {
      const { requestId, request } = ev;
      const url = request.url;
      const done = [];
      let handled = false;
      if (process.env.MOCK_DEBUG && (ev.responseStatusCode || ev.redirectResponse)) {
        console.log('[mock] paused-with-response', request.method, url.slice(0, 90),
          'status=', ev.responseStatusCode, 'redirect=', !!ev.redirectResponse);
      }
      try {
        if (url.includes('script.google.com') || url.includes('script.googleusercontent.com')) {
          handled = true;
          const { action, data, query } = actionFromUrl(url, request.method, request.postData);
          done.push(record('gas', action || '(none)', request.method, url));
          const latency = request.method === 'POST' ? state.latency.gasPost : state.latency.gasGet;
          await sleep(latency);
          if (state.backend === 'fail') {
            state.failCount++;
            await cdp.send('Fetch.fulfillRequest', {
              requestId,
              responseCode: 500,
              responseHeaders: [{ name: 'Content-Type', value: 'text/plain' }, ...cors, noStore],
              body: base64('Internal Server Error')
            });
          } else {
            const payload = gasResponse(action, { ...query, ...data });
            await cdp.send('Fetch.fulfillRequest', {
              requestId,
              responseCode: 200,
              responseHeaders: [{ name: 'Content-Type', value: 'application/json; charset=utf-8' }, ...cors, noStore],
              body: base64(JSON.stringify(payload))
            });
          }
          return;
        }

        if (url.includes('workers.dev')) {
          handled = true;
          done.push(record('edge', 'device_status', request.method, url));
          await sleep(state.latency.edge);
          if (state.edgeMode === 'fail') {
            await cdp.send('Fetch.fulfillRequest', {
              requestId,
              responseCode: 503,
              responseHeaders: [{ name: 'Content-Type', value: 'text/plain' }, ...cors, noStore],
              body: base64('unavailable')
            });
          } else {
            await cdp.send('Fetch.fulfillRequest', {
              requestId,
              responseCode: 200,
              responseHeaders: [{ name: 'Content-Type', value: 'application/json; charset=utf-8' }, ...cors, noStore],
              body: base64(JSON.stringify(edgeResponse()))
            });
          }
          return;
        }

        if (url.includes('fonts.googleapis.com')) {
          handled = true;
          done.push(record('font', 'font-css', request.method, url));
          await sleep(state.latency.fontCss);
          await cdp.send('Fetch.fulfillRequest', {
            requestId,
            responseCode: 200,
            responseHeaders: [{ name: 'Content-Type', value: 'text/css; charset=utf-8' }, noStore],
            body: base64(fontCss || '/* fonts unavailable */')
          });
          return;
        }

        if (url.includes('fonts.gstatic.com')) {
          handled = true;
          const name = decodeURIComponent(url.split('/').pop().split('?')[0]);
          // Keyed by file so four different woff2 files are not mistaken for
          // four overlapping requests of the same resource.
          done.push(record('font', `font-file:${name}`, request.method, url));
          const bytes = fontFiles?.get(name);
          await sleep(state.latency.fontFile);
          await cdp.send('Fetch.fulfillRequest', {
            requestId,
            responseCode: bytes ? 200 : 404,
            responseHeaders: [
              { name: 'Content-Type', value: 'font/woff2' },
              { name: 'Access-Control-Allow-Origin', value: '*' },
              noStore
            ],
            body: bytes ? base64(bytes) : base64('')
          });
          return;
        }

        // Local site assets and anything else: let Chrome fetch normally.
        done.push(record('other', classifyOther(url), request.method, url));
        await cdp.send('Fetch.continueRequest', { requestId });
      } catch (err) {
        if (process.env.MOCK_DEBUG) console.log('[mock] handler error:', err.message, url.slice(0, 90));
        // Never fall through to the real internet for a mocked host.
        try {
          if (handled) await cdp.send('Fetch.failRequest', { requestId, errorReason: 'Failed' });
          else await cdp.send('Fetch.continueRequest', { requestId });
        } catch { /* already settled */ }
      } finally {
        for (const fn of done) fn();
      }
    });
  }

  return {
    state,
    install,
    reset() {
      state.requests.length = 0;
      state.counters = {};
      state.maxConcurrentByKey = {};
      state.failCount = 0;
      state.dashboardLegacy = false;
      state.deleteFail = false;
      state.injected.length = 0;
      state.insideDelta = 0;
    },
    // Simulates an ESP32 entry/exit landing in Access_Log + Current_status.
    // The next get_dashboard_data reflects it (recent scan, counters) and the
    // Worker last_seen advances, exactly like a real card tap through the
    // edge API. Returns the write instant so a test can measure
    // event-recorded -> visible-on-screen latency honestly.
    injectEvent({
      rfid_uid = 'A37B9122',
      name = 'Pavan Kumar',
      user_id = 'A866051240',
      action = 'ENTRY'
    } = {}) {
      const at = Date.now();
      const ts = istFromMs(at);
      const [date, time] = ts.split(' ');
      const row = { timestamp: ts, date, time, rfid_uid, name, user_id, action, status: 'ALLOWED' };
      dataset.history.push(row);
      state.injected.push(row);
      if (action === 'ENTRY') state.insideDelta += 1;
      if (action === 'EXIT') state.insideDelta = Math.max(0, state.insideDelta - 1);
      state.deviceLastSeenMs = at;
      return { at, row };
    },
    requestsOf(kind, key) {
      return state.requests.filter(r => (!kind || r.kind === kind) && (!key || r.key === key));
    },
    counts() {
      const out = {};
      for (const r of state.requests) out[`${r.kind}:${r.key}`] = (out[`${r.kind}:${r.key}`] || 0) + 1;
      return out;
    }
  };
}

function classifyOther(url) {
  if (url.includes('/styles.css')) return 'styles.css';
  if (url.includes('/app.js')) return 'app.js';
  if (url.endsWith('/') || url.includes('index.html')) return 'index.html';
  return 'other-asset';
}

function base64(str) {
  return Buffer.from(str, 'utf8').toString('base64');
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Downloads the real Google Fonts CSS + woff2 files once so font behaviour in
// the profile matches production without depending on live network timing.
export async function fetchGoogleFonts() {
  const cssUrl = 'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap';
  try {
    const res = await fetch(cssUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' }
    });
    if (!res.ok) return { fontCss: '', fontFiles: new Map() };
    let css = await res.text();
    const urls = [...new Set([...css.matchAll(/https:\/\/fonts\.gstatic\.com\/[^)]+/g)].map(m => m[0]))];
    const fontFiles = new Map();
    await Promise.all(urls.map(async u => {
      try {
        const r = await fetch(u);
        if (!r.ok) return;
        const buf = Buffer.from(await r.arrayBuffer());
        const name = decodeURIComponent(u.split('/').pop().split('?')[0]);
        fontFiles.set(name, buf);
        css = css.split(u).join(`https://fonts.gstatic.com/__local__/${name}`);
      } catch { /* font is optional */ }
    }));
    return { fontCss: css, fontFiles };
  } catch {
    return { fontCss: '', fontFiles: new Map() };
  }
}
