// Golden equivalence test: the ORIGINAL Code.gs (frozen baseline) and the
// optimized Code.gs must return identical responses and leave identical
// spreadsheet state for every action, in every degradation mode:
//   old            - baseline code, SpreadsheetApp only
//   new+fast       - optimized code, working UrlFetchApp (batch read/write)
//   new+nofetch    - optimized code, UrlFetchApp missing entirely
//   new+failall    - optimized code, every REST call fails
//   new+slowappend - optimized code, REST appends fail but batch reads work
// Date cells are seeded BOTH as Date-producing serial cells and as plain
// text, which is exactly the transformation the optimization introduces
// (legacy getValues -> Date, fast batchGet -> Sheets serial number).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  makeClock, makeFakeDateClass, createBackend, runScript,
  stable, show, FROZEN_NOW_MS, serial, timeSerial
} from './gas-shim.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const OLD_CODE = fs.readFileSync(path.join(here, 'perf', 'backend-baseline', 'Code.gs.before'), 'utf8');
const NEW_CODE = fs.readFileSync(path.join(here, '..', 'google_apps_script', 'Code.gs'), 'utf8');

const HEADER_USERS = ['RFID_UID', 'NAME', 'USER_ID', 'DEPARTMENT', 'USER_TYPE', 'STATUS', 'REGISTRATION_DATE'];
const HEADER_LOG = ['TIMESTAMP', 'DATE', 'TIME', 'RFID_UID', 'NAME', 'USER_ID', 'ACTION', 'STATUS'];
const HEADER_STATUS = ['RFID_UID', 'NAME', 'USER_ID', 'ENTRY_TIME', 'EXIT_TIME', 'CURRENT_STATUS'];
const HEADER_ADMIN = ['FULL_NAME', 'USERNAME', 'PASSWORD_HASH', 'CREATED_AT'];
const HEADER_REG = ['REQUEST_ID', 'STATUS', 'RFID_UID', 'CREATED_AT', 'UPDATED_AT'];

const NOW = FROZEN_NOW_MS;

function baseSeed() {
  return {
    sheets: {
      Users: {
        rows: [
          HEADER_USERS,
          ['B3A35956', 'Asha Priya', 'CS2104', 'CSE', 'Student', 'Active', { d: serial(2026, 10, 8, 2, 38, 47) }],
          ['FD73F705', 'Rahul Menon', 'EE1402', 'ECE', 'Student', 'Active', { d: serial(2026, 9, 30, 15, 5, 11) }],
          ['12345678', 'Text Date', 'MT0101', 'MECH', 'Staff', 'Inactive', 'not-a-date'],
          ['', 'No Card', 'XX01', 'CIVIL', 'Student', 'Active', { d: serial(2026, 10, 1, 0, 0, 0) }]
        ]
      },
      Access_Log: {
        rows: [
          HEADER_LOG,
          [{ d: serial(2026, 10, 7, 21, 32, 39) }, { d: serial(2026, 10, 7) }, { d: timeSerial(21, 32, 39) },
            'B3A35956', 'Asha Priya', 'CS2104', 'ENTRY', 'INSIDE'],
          [{ d: serial(2026, 10, 8, 9, 0, 0) }, { d: serial(2026, 10, 8) }, { d: timeSerial(9, 0, 0) },
            'FD73F705', 'Rahul Menon', 'EE1402', 'EXIT', 'OUTSIDE'],
          ['', '', '', '', '', '', '', '', '', 'STRAY_JUNK'],
          ['2026-10-08 10:15:00', '2026-10-08', '10:15:00',
            'B3A35956', 'Asha Priya', 'CS2104', 'ENTRY', 'INSIDE'],
          [{ d: serial(2026, 10, 6, 8, 45, 0) }, { d: serial(2026, 10, 6) }, { d: timeSerial(8, 45, 0) },
            '12345678', 'Text Date', 'MT0101', 'ENTRY', 'INSIDE']
        ]
      },
      Current_status: {
        rows: [
          HEADER_STATUS,
          ['B3A35956', 'Asha Priya', 'CS2104', { d: timeSerial(9, 15, 0) }, '', 'INSIDE'],
          ['FD73F705', 'Rahul Menon', 'EE1402', { d: timeSerial(8, 0, 0) }, { d: timeSerial(9, 0, 0) }, 'OUTSIDE'],
          ['12345678', 'Text Date', 'MT0101', '08:30:00', '', 'INSIDE'],
          ['99999999', 'Ghost User', 'GG01', '', '', 'INSIDE'],
          ['55555555', 'Old Row', 'OO01', { d: timeSerial(10, 0, 0) }, 'INSIDE', '']
        ]
      },
      Admin_Accounts: {
        rows: [
          HEADER_ADMIN,
          ['Test Admin', 'admin', 's2_bootstrap', { d: serial(2026, 9, 1, 12, 0, 0) }]
        ]
      },
      Registration_Request: {
        rows: [
          HEADER_REG,
          ['REQ_' + (NOW - 10000), 'WAITING', '', { d: serial(2026, 10, 8, 10, 29, 50) }, { d: serial(2026, 10, 8, 10, 29, 50) }],
          ['REQ_' + (NOW - 30000), 'DETECTED', 'AABBCCDD', { d: serial(2026, 10, 8, 10, 29, 30) }, { d: serial(2026, 10, 8, 10, 29, 30) }],
          ['REQ_' + (NOW - 120000), 'WAITING', '', { d: serial(2026, 10, 8, 10, 28, 0) }, { d: serial(2026, 10, 8, 10, 28, 0) }],
          ['REQ_' + (NOW - 90000), 'EXPIRED', '', { d: serial(2026, 10, 8, 10, 28, 30) }, { d: serial(2026, 10, 8, 10, 28, 30) }]
        ]
      }
    }
  };
}

// Both code bases hash with the same seeded secret, so one bootstrap call
// gives the password hash shared by every variant.
function bootstrapHash() {
  const clock = makeClock();
  const FakeDate = makeFakeDateClass(clock);
  const backend = createBackend({ state: { sheets: {} }, FakeDate });
  const sandbox = runScript(OLD_CODE, 'bootstrap.js', {
    SpreadsheetApp: backend.SpreadsheetApp,
    PropertiesService: backend.PropertiesService,
    Utilities: backend.Utilities,
    console: backend.console
  }, FakeDate);
  return sandbox.hashPassword('secret123');
}
const ADMIN_HASH = bootstrapHash();

function withAdminHash(seed) {
  seed.sheets.Admin_Accounts.rows[1][2] = ADMIN_HASH;
  return seed;
}

function seedMissing(sheetName) {
  return () => {
    const s = baseSeed();
    delete s.sheets[sheetName];
    return s;
  };
}

function seedWithoutUserRows() {
  return () => {
    const s = baseSeed();
    s.sheets.Users.rows = [HEADER_USERS];
    return s;
  };
}

function execute(code, variant, scenario) {
  const clock = makeClock();
  const FakeDate = makeFakeDateClass(clock);
  const state = withAdminHash(scenario.seed ? scenario.seed() : baseSeed());
  const backend = createBackend({ state, FakeDate, fail: new Set(variant.fail || []) });
  const globals = {
    SpreadsheetApp: backend.SpreadsheetApp,
    PropertiesService: backend.PropertiesService,
    Utilities: backend.Utilities,
    ContentService: backend.ContentService,
    ScriptApp: backend.ScriptApp,
    console: backend.console
  };
  if (!variant.absent) globals.UrlFetchApp = backend.UrlFetchApp;

  const sandbox = runScript(code, variant.name, globals, FakeDate);
  const data = JSON.parse(JSON.stringify(scenario.data || {}));
  if (scenario.prepare) scenario.prepare(sandbox, data);

  let out;
  if (scenario.method === 'doGet') {
    out = sandbox.doGet({ parameter: Object.assign({}, data, { action: scenario.action }) });
  } else {
    out = sandbox.doPost({ postData: { contents: JSON.stringify({ action: scenario.action, data }) } });
  }
  return {
    response: JSON.parse(out.getContent()),
    state,
    calls: backend.calls
  };
}

const VARIANTS = [
  { name: 'old', kind: 'old' },
  { name: 'new+fast', fail: [] },
  { name: 'new+nofetch', absent: true },
  { name: 'new+failall', fail: ['batchGet', 'append', 'batchUpdate'] },
  { name: 'new+slowappend', fail: ['append'] }
];

const withAuth = (sandbox, data) => { data.auth_token = sandbox.signToken('admin'); };

const SCENARIOS = [
  // ---- reads (website + ESP32) ----
  { name: 'doGet health', method: 'doGet', action: 'health', data: {} },
  { name: 'doGet dashboard', method: 'doGet', action: 'get_dashboard_data', data: {}, expectBatchGet: true },
  { name: 'dashboard data', action: 'get_dashboard_data', data: {}, expectBatchGet: true },
  { name: 'dashboard when Current_status missing', seed: seedMissing('Current_status'), action: 'get_dashboard_data', data: {} },
  { name: 'dashboard when Users missing throws identically', seed: seedMissing('Users'), action: 'get_dashboard_data', data: {} },
  { name: 'users list', action: 'get_users', data: {}, expectBatchGet: true },
  { name: 'users when Current_status missing', seed: seedMissing('Current_status'), action: 'get_users', data: {} },
  { name: 'current inside', action: 'get_current_inside', data: {}, expectBatchGet: true },
  { name: 'history no filters', action: 'get_history', data: {}, expectBatchGet: true },
  { name: 'history filtered', action: 'get_history', data: { filter_date: '2026-10-08', filter_action: 'ENTRY', filter_name: 'Asha', limit: '2' }, expectBatchGet: true },
  { name: 'history rfid filter misses', action: 'get_history', data: { filter_rfid: 'ZZZZ' }, expectBatchGet: true },
  { name: 'doGet history filtered', method: 'doGet', action: 'get_history', data: { filter_date: '2026-10-07' }, expectBatchGet: true },
  { name: 'reports explicit range', action: 'get_reports', data: { from_date: '2026-10-06', to_date: '2026-10-08' }, expectBatchGet: true },
  { name: 'reports default range', action: 'get_reports', data: {}, expectBatchGet: true },
  { name: 'doGet reports', method: 'doGet', action: 'get_reports', data: { from_date: '2026-10-07', to_date: '2026-10-08' }, expectBatchGet: true },

  // ---- RFID validation (ESP32 hot path) ----
  { name: 'validate registered INSIDE user', action: 'validate_rfid', data: { rfid_uid: 'B3A35956' }, expectBatchGet: true },
  { name: 'validate registered OUTSIDE user', action: 'validate_rfid', data: { rfid_uid: 'FD73F705' }, expectBatchGet: true },
  { name: 'validate inactive user', action: 'validate_rfid', data: { rfid_uid: '12345678' }, expectBatchGet: true },
  { name: 'validate ghost status row user', action: 'validate_rfid', data: { rfid_uid: '99999999' }, expectBatchGet: true },
  { name: 'validate unknown card', action: 'validate_rfid', data: { rfid_uid: 'FFFFFFFF' }, expectBatchGet: true },
  { name: 'validate blank uid matches blank row', action: 'validate_rfid', data: { rfid_uid: '' }, expectBatchGet: true },
  { name: 'validate with Users sheet missing', seed: seedMissing('Users'), action: 'validate_rfid', data: { rfid_uid: 'B3A35956' } },

  // ---- auth ----
  { name: 'login ok', action: 'login', data: { username: 'admin', password: 'secret123' }, expectBatchGet: true },
  { name: 'login wrong password', action: 'login', data: { username: 'admin', password: 'wrong' }, expectBatchGet: true },
  { name: 'login unknown user', action: 'login', data: { username: 'nobody', password: 'secret123' }, expectBatchGet: true },
  { name: 'login missing password', action: 'login', data: { username: 'admin' } },
  { name: 'create_admin duplicate username', action: 'create_admin_account', data: { username: 'admin', password: 'newpass123', fullName: 'Other' }, prepare: withAuth, expectBatchGet: true },
  { name: 'create_admin new account', action: 'create_admin_account', data: { username: 'operator', password: 'newpass123', fullName: 'Ops User' }, prepare: withAuth, expectBatchGet: true },
  { name: 'update_user rejected without token', action: 'update_user', data: { rfid_uid: 'B3A35956', name: 'Nope' } },
  { name: 'export_excel rejected without token', action: 'export_excel', data: {} },

  // ---- user management ----
  { name: 'update_user non-contiguous fields', action: 'update_user', data: { rfid_uid: 'B3A35956', name: 'Asha P', department: 'CSE Labs' }, prepare: withAuth, expectBatchGet: true },
  { name: 'update_user partial write on invalid field', action: 'update_user', data: { rfid_uid: 'B3A35956', name: 'Accepted Name', user_id: 'X'.repeat(65) }, prepare: withAuth, expectBatchGet: true },
  { name: 'update_user status invalid', action: 'update_user', data: { rfid_uid: 'B3A35956', status: 'Paused' }, prepare: withAuth },
  { name: 'update_user Inactive resets status row', action: 'update_user', data: { rfid_uid: 'B3A35956', status: 'Inactive' }, prepare: withAuth, expectBatchGet: true },
  { name: 'update_user not found', action: 'update_user', data: { rfid_uid: 'FFFFFFFF', name: 'Ghost' }, prepare: withAuth, expectBatchGet: true },
  { name: 'delete_user removes both rows', action: 'delete_user', data: { rfid_uid: 'FD73F705' }, prepare: withAuth, expectBatchGet: true },
  { name: 'delete_user not found', action: 'delete_user', data: { rfid_uid: 'FFFFFFFF' }, prepare: withAuth, expectBatchGet: true },
  { name: 'check_rfid exists', action: 'check_rfid', data: { rfid_uid: 'B3A35956' }, expectBatchGet: true },
  { name: 'check_rfid missing', action: 'check_rfid', data: { rfid_uid: 'FFFFFFFF' }, expectBatchGet: true },
  { name: 'export_excel range', action: 'export_excel', data: { from_date: '2026-10-06', to_date: '2026-10-08' }, prepare: withAuth, expectBatchGet: true },

  // ---- registration of a user ----
  { name: 'register_user success', action: 'register_user', data: { rfid_uid: 'AABBCCDD', name: 'New Kid', user_id: 'CS9999', department: 'CSE', user_type: 'Student' }, expectBatchGet: true },
  { name: 'register_user duplicate', action: 'register_user', data: { rfid_uid: 'B3A35956', name: 'Dup', user_id: 'CS0001' }, expectBatchGet: true },
  { name: 'register_user missing name', action: 'register_user', data: { rfid_uid: 'AABBCCDD' } },
  { name: 'register_user over-long name', action: 'register_user', data: { rfid_uid: 'AABBCCDD', name: 'N'.repeat(129), user_id: 'CS1' } },
  { name: 'register_user resets stale status row', action: 'register_user', data: { rfid_uid: '55555555', name: 'Old Row', user_id: 'OO01' }, expectBatchGet: true },
  { name: 'register_user with Users sheet missing', seed: seedMissing('Users'), action: 'register_user', data: { rfid_uid: 'AABBCCDD', name: 'New Kid', user_id: 'CS9999' } },

  // ---- event logging (ESP32) ----
  { name: 'log_event ENTRY updates existing status', action: 'log_event', data: { rfid_uid: 'FD73F705', name: 'Rahul Menon', user_id: 'EE1402', action: 'ENTRY', status: 'INSIDE', timestamp: '2026-10-08 10:30:00' }, expectBatchGet: true },
  { name: 'log_event invalid timestamp replaced by server clock', action: 'log_event', data: { rfid_uid: 'B3A35956', name: 'Asha Priya', user_id: 'CS2104', action: 'EXIT', status: 'OUTSIDE', timestamp: '' }, expectBatchGet: true },
  { name: 'log_event EXIT for ghost status row', action: 'log_event', data: { rfid_uid: '99999999', name: 'Ghost User', user_id: 'GG01', action: 'EXIT', status: 'OUTSIDE', timestamp: '2026-10-08 10:30:00' }, expectBatchGet: true },
  { name: 'log_event repairs legacy status-in-E row', action: 'log_event', data: { rfid_uid: '55555555', name: 'Old Row', user_id: 'OO01', action: 'ENTRY', status: 'INSIDE', timestamp: '2026-10-08 10:30:00' }, expectBatchGet: true },
  { name: 'log_event brand-new user appends status row', action: 'log_event', data: { rfid_uid: 'CAFEBABE', name: 'Walk In', user_id: 'WW11', action: 'ENTRY', status: 'INSIDE', timestamp: '2026-10-08 10:30:00' }, expectBatchGet: true },
  { name: 'log_event non ENTRY/EXIT skips status', action: 'log_event', data: { rfid_uid: 'B3A35956', name: 'Asha Priya', user_id: 'CS2104', action: 'TEST', status: 'OK', timestamp: '2026-10-08 10:30:00' } },
  { name: 'log_event missing rfid', action: 'log_event', data: { action: 'ENTRY' } },
  { name: 'log_event with Access_Log sheet missing', seed: seedMissing('Access_Log'), action: 'log_event', data: { rfid_uid: 'B3A35956', name: 'Asha Priya', user_id: 'CS2104', action: 'ENTRY', status: 'INSIDE', timestamp: '2026-10-08 10:30:00' } },

  // ---- RFID registration workflow ----
  { name: 'start_rfid_registration expires stale rows', action: 'start_rfid_registration', data: {}, expectBatchGet: true },
  { name: 'get_pending serves live request and expires stale', action: 'get_pending_rfid_registration', data: {}, expectBatchGet: true },
  { name: 'status DETECTED consumed exactly once', action: 'get_rfid_registration_status', data: { request_id: 'REQ_' + (NOW - 30000) }, expectBatchGet: true },
  { name: 'status WAITING for fresh request', action: 'get_rfid_registration_status', data: { request_id: 'REQ_' + (NOW - 10000) }, expectBatchGet: true },
  { name: 'status legacy newest live row', action: 'get_rfid_registration_status', data: {}, expectBatchGet: true },
  { name: 'status unknown request', action: 'get_rfid_registration_status', data: { request_id: 'REQ_1' }, expectBatchGet: true },
  { name: 'doGet status DETECTED consumed', method: 'doGet', action: 'get_rfid_registration_status', data: { request_id: 'REQ_' + (NOW - 30000) }, expectBatchGet: true },
  { name: 'rfid_registration_result stores DETECTED', action: 'rfid_registration_result', data: { request_id: 'REQ_' + (NOW - 10000), rfid_uid: 'DEADBEEF' }, expectBatchGet: true },
  { name: 'rfid_registration_result rejected', action: 'rfid_registration_result', data: { request_id: 'REQ_1', rfid_uid: 'DEADBEEF' }, expectBatchGet: true },
  { name: 'rfid_registration_result missing uid', action: 'rfid_registration_result', data: { request_id: 'REQ_' + (NOW - 10000) } },

  // ---- misc ----
  { name: 'register_rfid_scan passthrough', action: 'register_rfid_scan', data: { rfid_uid: 'B3A35956' } },
  { name: 'enter_registration_mode', action: 'enter_registration_mode', data: {} },
  { name: 'unknown action', action: 'definitely_not_an_action', data: {} }
];

let passed = 0;
let failed = 0;

function fail(name, msg, detail) {
  failed++;
  console.log('FAIL  ' + name + ' -> ' + msg);
  if (detail) console.log(detail);
}

function check(name, cond, msg, detail) {
  if (cond) {
    passed++;
    console.log('PASS  ' + name);
    return true;
  }
  fail(name, msg, detail);
  return false;
}

let batchGetSeen = 0;

// handleGetDashboardData now ALSO answers with recent_scans and total_visits.
// They are additive, so they are removed before the baseline comparison: the
// legacy contract must not drift, and the two new fields get their own
// assertions (below) instead.
const DASHBOARD_EXTRAS = ['recent_scans', 'total_visits'];

function withoutDashboardExtras(response, action) {
  if (action !== 'get_dashboard_data') return response;
  const clone = JSON.parse(JSON.stringify(response));
  if (clone && clone.data) DASHBOARD_EXTRAS.forEach(key => { delete clone.data[key]; });
  return clone;
}

for (const scenario of SCENARIOS) {
  const reference = execute(OLD_CODE, VARIANTS[0], scenario);
  for (const variant of VARIANTS.slice(1)) {
    let run;
    try {
      run = execute(NEW_CODE, variant, scenario);
    } catch (error) {
      fail(scenario.name + ' [' + variant.name + ']', 'threw: ' + error.stack);
      continue;
    }
    const ok =
      show(withoutDashboardExtras(run.response, scenario.action)) ===
        show(withoutDashboardExtras(reference.response, scenario.action)) &&
      show(run.state) === show(reference.state);
    if (!ok) {
      fail(scenario.name + ' [' + variant.name + ']', 'response/state diverged from baseline',
        '--- response old ---\n' + show(reference.response) +
        '\n--- response ' + variant.name + ' ---\n' + show(run.response) +
        '\n--- state diff ---\n' + diffState(reference.state, run.state));
      continue;
    }
    if (variant.name === 'new+fast') {
      if (scenario.expectBatchGet && run.calls.batchGet < 1) {
        fail(scenario.name, 'fast path was expected to run at least one values:batchGet');
        continue;
      }
      if (scenario.expectBatchGet) {
        batchGetSeen++;
        const oldReads = reference.calls.getValues;
        const newReads = run.calls.getValues;
        if (!(newReads < oldReads)) {
          fail(scenario.name, 'fast path did not reduce getDataRange().getValues() calls (' + oldReads + ' -> ' + newReads + ')');
          continue;
        }
      }
    }
    passed++;
    console.log('PASS  ' + scenario.name + ' [' + variant.name + ']');
  }
}

// ---- the two new dashboard fields, checked against the existing readers ----
// recent_scans must be exactly what get_history returns for the newest scans
// (it shares handleGetHistory's field construction), and total_visits must be
// exactly the Reports calculation scoped to a single day: distinct cards with
// an ENTRY on that day.
const TODAY = '2026-10-08'; // FROZEN_NOW_MS = 2026-10-08 10:30:00 IST

for (const variant of VARIANTS.slice(1)) {
  const dash = execute(NEW_CODE, variant,
    { name: 'dashboard extras', action: 'get_dashboard_data', data: {} }).response.data;
  const hist = execute(NEW_CODE, variant,
    { name: 'history for scans', action: 'get_history', data: { limit: '1000' } }).response.data.history;
  const rep = execute(NEW_CODE, variant,
    { name: 'reports for today', action: 'get_reports', data: { from_date: TODAY, to_date: TODAY } }).response.data;

  const expectedScans = hist
    .filter(row => row.action === 'ENTRY' || row.action === 'EXIT')
    .slice(0, 5);

  check(`recent_scans is the newest ENTRY/EXIT rows, at most five [${variant.name}]`,
    Array.isArray(dash.recent_scans) &&
      dash.recent_scans.length <= 5 &&
      show(dash.recent_scans) === show(expectedScans),
    `expected ${show(expectedScans)}, got ${show(dash.recent_scans)}`);

  check(`total_visits equals get_reports for today [${variant.name}]`,
    dash.total_visits === rep.total_visits,
    `dashboard said ${dash.total_visits}, reports said ${rep.total_visits}`);

  check(`total_visits counts the distinct cards that entered today [${variant.name}]`,
    dash.total_visits === 1 && dash.total_visits > 0,
    `got ${dash.total_visits}, expected 1 (B3A35956 only)`);
}

function diffState(a, b) {
  const lines = [];
  const names = new Set([...Object.keys(a.sheets), ...Object.keys(b.sheets)]);
  for (const name of names) {
    const ra = a.sheets[name] ? a.sheets[name].rows : undefined;
    const rb = b.sheets[name] ? b.sheets[name].rows : undefined;
    if (show(ra) !== show(rb)) {
      lines.push('sheet ' + name + ':');
      lines.push('  old: ' + show(ra));
      lines.push('  new: ' + show(rb));
    }
  }
  return lines.join('\n') || '(state objects differ outside sheet rows)';
}

console.log('');
console.log(passed + '/' + (passed + failed) + ' equivalence checks passed' +
  (batchGetSeen ? ' (' + batchGetSeen + ' fast-path batchGet confirmations)' : ''));
if (failed > 0) process.exit(1);
