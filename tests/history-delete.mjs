// Security + correctness test for the delete_history_record action. The
// frozen Code.gs.before baseline has no such action, so gas-equivalence
// cannot cover it: this suite runs the CURRENT google_apps_script/Code.gs
// through the Apps Script shim and asserts:
//   - the action is authenticated (PROTECTED_ACTIONS) and doPost-only
//   - a successful delete removes exactly ONE Access_Log row and never
//     touches Users / Current_status / Registration_Request / Admin_Accounts
//   - a stale or mismatched record deletes nothing
//   - duplicate identical rows are deleted one at a time (newest first); the
//     content-match identity limitation is documented in the GAS README

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  makeClock, makeFakeDateClass, createBackend, runScript,
  deepCloneState, show, serial, timeSerial
} from './gas-shim.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CODE = fs.readFileSync(path.join(here, '..', 'google_apps_script', 'Code.gs'), 'utf8');

const HEADER_USERS = ['RFID_UID', 'NAME', 'USER_ID', 'DEPARTMENT', 'USER_TYPE', 'STATUS', 'REGISTRATION_DATE'];
const HEADER_LOG = ['TIMESTAMP', 'DATE', 'TIME', 'RFID_UID', 'NAME', 'USER_ID', 'ACTION', 'STATUS'];
const HEADER_STATUS = ['RFID_UID', 'NAME', 'USER_ID', 'ENTRY_TIME', 'EXIT_TIME', 'CURRENT_STATUS'];
const HEADER_ADMIN = ['FULL_NAME', 'USERNAME', 'PASSWORD_HASH', 'CREATED_AT'];
const HEADER_REG = ['REQUEST_ID', 'STATUS', 'RFID_UID', 'CREATED_AT', 'UPDATED_AT'];

const ASHA_ENTRY = [
  { d: serial(2026, 10, 7, 21, 32, 39) }, { d: serial(2026, 10, 7) }, { d: timeSerial(21, 32, 39) },
  'B3A35956', 'Asha Priya', 'CS2104', 'ENTRY', 'INSIDE'
];
const RAHUL_EXIT = [
  { d: serial(2026, 10, 8, 9, 0, 0) }, { d: serial(2026, 10, 8) }, { d: timeSerial(9, 0, 0) },
  'FD73F705', 'Rahul Menon', 'EE1402', 'EXIT', 'OUTSIDE'
];
const JUNK_ROW = ['', '', '', '', '', '', '', '', '', 'STRAY_JUNK'];
const TEXT_ASHA_ENTRY = ['2026-10-08 10:15:00', '2026-10-08', '10:15:00',
  'B3A35956', 'Asha Priya', 'CS2104', 'ENTRY', 'INSIDE'];

const cloneRows = rows => JSON.parse(JSON.stringify(rows));

function baseSeed(extraLogRows = []) {
  return {
    sheets: {
      Users: {
        rows: [
          HEADER_USERS,
          ['B3A35956', 'Asha Priya', 'CS2104', 'CSE', 'Student', 'Active', { d: serial(2026, 10, 8, 2, 38, 47) }],
          ['FD73F705', 'Rahul Menon', 'EE1402', 'ECE', 'Student', 'Active', { d: serial(2026, 9, 30, 15, 5, 11) }]
        ]
      },
      Access_Log: {
        rows: [
          HEADER_LOG,
          ...cloneRows([ASHA_ENTRY, RAHUL_EXIT, JUNK_ROW, TEXT_ASHA_ENTRY, ...extraLogRows])
        ]
      },
      Current_status: {
        rows: [
          HEADER_STATUS,
          ['B3A35956', 'Asha Priya', 'CS2104', { d: timeSerial(9, 15, 0) }, '', 'INSIDE'],
          ['FD73F705', 'Rahul Menon', 'EE1402', { d: timeSerial(8, 0, 0) }, { d: timeSerial(9, 0, 0) }, 'OUTSIDE']
        ]
      },
      Admin_Accounts: {
        rows: [
          HEADER_ADMIN,
          ['Test Admin', 'admin', 'bootstrap', { d: serial(2026, 9, 1, 12, 0, 0) }]
        ]
      },
      Registration_Request: {
        rows: [
          HEADER_REG,
          ['REQ_1', 'WAITING', '', { d: serial(2026, 10, 8, 10, 29, 50) }, { d: serial(2026, 10, 8, 10, 29, 50) }]
        ]
      }
    }
  };
}

function bootstrapHash() {
  const clock = makeClock();
  const FakeDate = makeFakeDateClass(clock);
  const backend = createBackend({ state: { sheets: {} }, FakeDate });
  const sandbox = runScript(CODE, 'bootstrap.js', {
    SpreadsheetApp: backend.SpreadsheetApp,
    PropertiesService: backend.PropertiesService,
    Utilities: backend.Utilities,
    console: backend.console
  }, FakeDate);
  return sandbox.hashPassword('secret123');
}
const ADMIN_HASH = bootstrapHash();

// Fresh sandbox per test: one Code.gs execution lifetime.
function makeSandbox({ seed, absent = false } = {}) {
  const clock = makeClock();
  const FakeDate = makeFakeDateClass(clock);
  const state = seed ? seed() : baseSeed();
  state.sheets.Admin_Accounts.rows[1][2] = ADMIN_HASH;
  const backend = createBackend({ state, FakeDate });
  const globals = {
    SpreadsheetApp: backend.SpreadsheetApp,
    PropertiesService: backend.PropertiesService,
    Utilities: backend.Utilities,
    ContentService: backend.ContentService,
    ScriptApp: backend.ScriptApp,
    console: backend.console
  };
  if (!absent) globals.UrlFetchApp = backend.UrlFetchApp;
  const sandbox = runScript(CODE, 'history-delete.js', globals, FakeDate);
  return { sandbox, state, calls: backend.calls };
}

function post(sandbox, action, data) {
  const out = sandbox.doPost({ postData: { contents: JSON.stringify({ action, data }) } });
  return JSON.parse(out.getContent());
}

function del(sandbox, payload, { auth = true } = {}) {
  const data = JSON.parse(JSON.stringify(payload));
  if (auth) data.auth_token = sandbox.signToken('admin');
  return post(sandbox, 'delete_history_record', data);
}

// The client echoes exactly what get_history rendered; tests do the same so
// no timestamp-text format is guessed here.
function renderedRecord(sandbox, match) {
  const response = post(sandbox, 'get_history', { limit: 1000 });
  if (!response.success) throw new Error('seed get_history failed: ' + response.message);
  const record = response.data.history.find(r => Object.keys(match).every(k => r[k] === match[k]));
  if (!record) throw new Error('seed record not found: ' + JSON.stringify(match));
  return record;
}

let passed = 0;
let failed = 0;

function check(name, cond, msg, detail) {
  if (cond) {
    passed++;
    console.log('PASS  ' + name);
    return true;
  }
  failed++;
  console.log('FAIL  ' + name + ' -> ' + msg);
  if (detail) console.log(detail);
  return false;
}

const UNTOUCHED = ['Users', 'Current_status', 'Registration_Request', 'Admin_Accounts'];
const logRows = state => state.sheets.Access_Log.rows;

// 1. Authenticated deletion is refused without a session token.
{
  const { sandbox, state, calls } = makeSandbox();
  const before = deepCloneState(state);
  const record = renderedRecord(sandbox, { rfid_uid: 'FD73F705', action: 'EXIT' });
  const response = del(sandbox, record, { auth: false });
  check('delete without token is rejected',
    response.success === false && /Authentication required/.test(response.message),
    'expected auth failure, got ' + show(response));
  check('rejected delete leaves Access_Log unchanged',
    show(logRows(state)) === show(before.sheets.Access_Log.rows),
    'rows changed', 'before: ' + show(before.sheets.Access_Log.rows) + '\nafter: ' + show(logRows(state)));
  check('rejected delete performs no sheet writes',
    calls.deleteRow === 0 && calls.appendRow === 0 && calls.restAppend === 0,
    'deleteRow=' + calls.deleteRow + ' appendRow=' + calls.appendRow + ' restAppend=' + calls.restAppend);
}

// 2. Authenticated deletion removes exactly one row and touches nothing else.
{
  const { sandbox, state, calls } = makeSandbox();
  const before = deepCloneState(state);
  const record = renderedRecord(sandbox, { rfid_uid: 'FD73F705', action: 'EXIT' });
  const response = del(sandbox, record);
  check('authenticated delete succeeds',
    response.success === true, 'got ' + show(response));
  const after = logRows(state);
  check('exactly one Access_Log row was removed',
    after.length === before.sheets.Access_Log.rows.length - 1,
    'rows ' + before.sheets.Access_Log.rows.length + ' -> ' + after.length);
  check('the intended row is the one that is gone',
    !after.some(r => String(r[3]) === 'FD73F705' && String(r[6]) === 'EXIT') &&
    after.some(r => String(r[3]) === 'B3A35956') &&
    after.some(r => r[9] === 'STRAY_JUNK'),
    'remaining rows: ' + show(after));
  check('Users / Current_status / Registration_Request / Admin_Accounts untouched',
    UNTOUCHED.every(name => show(state.sheets[name].rows) === show(before.sheets[name].rows)),
    'another sheet changed');
  check('delete row used the fast batchGet path',
    calls.batchGet >= 1 && calls.deleteRow === 1,
    'batchGet=' + calls.batchGet + ' deleteRow=' + calls.deleteRow);
}

// 3. A stale record (same identity, changed content) deletes nothing.
{
  const { sandbox, state } = makeSandbox();
  const before = deepCloneState(state);
  const record = renderedRecord(sandbox, { rfid_uid: 'FD73F705', action: 'EXIT' });
  const response = del(sandbox, { ...record, timestamp: '2020-01-01 00:00:00' });
  check('mismatched timestamp is refused',
    response.success === false && /not found/.test(response.message),
    'got ' + show(response));
  check('mismatched delete leaves state unchanged',
    show(state.sheets) === show(before.sheets), 'state changed');
}

// 4. Missing identifiers (including the junk row) can never match a delete.
{
  const { sandbox, state } = makeSandbox();
  const before = deepCloneState(state);
  const record = renderedRecord(sandbox, { rfid_uid: 'FD73F705', action: 'EXIT' });
  const noRfid = del(sandbox, { ...record, rfid_uid: '' });
  const blank = del(sandbox, {});
  const junk = del(sandbox, {
    timestamp: '', date: '', time: '', rfid_uid: '', name: '', user_id: '', action: '', status: ''
  });
  check('missing rfid_uid is refused',
    noRfid.success === false && /required/.test(noRfid.message), 'got ' + show(noRfid));
  check('empty payload is refused',
    blank.success === false && /required/.test(blank.message), 'got ' + show(blank));
  check('the junk row cannot be targeted',
    junk.success === false, 'got ' + show(junk));
  check('refused deletes leave state unchanged',
    show(state.sheets) === show(before.sheets), 'state changed');
}

// 5. The action is not reachable through doGet.
{
  const { sandbox, state, calls } = makeSandbox();
  const before = deepCloneState(state);
  const record = renderedRecord(sandbox, { rfid_uid: 'FD73F705', action: 'EXIT' });
  const out = sandbox.doGet({ parameter: { ...record, action: 'delete_history_record' } });
  const response = JSON.parse(out.getContent());
  check('doGet refuses delete_history_record',
    response.success === false && /Unknown action/.test(response.message),
    'got ' + show(response));
  check('doGet delete attempt leaves state unchanged',
    show(state.sheets) === show(before.sheets) && calls.deleteRow === 0,
    'state changed or deleteRow ran');
}

// 6. Two identical rows: one delete removes exactly one of them (newest first).
//    Identity is the full content, so the twin is deleted on the next call.
{
  const twin = ['2026-10-07 12:00:00', '2026-10-07', '12:00:00',
    'DUPCARD01', 'Twin User', 'TP001', 'ENTRY', 'INSIDE'];
  const { sandbox, state } = makeSandbox({ seed: () => baseSeed([twin, twin]) });
  const beforeCount = logRows(state).length;
  const record = renderedRecord(sandbox, { rfid_uid: 'DUPCARD01' });
  const first = del(sandbox, record);
  const remaining = logRows(state).filter(r => String(r[3]) === 'DUPCARD01');
  check('duplicate row delete succeeds', first.success === true, 'got ' + show(first));
  check('exactly one duplicate remains after one delete',
    remaining.length === 1 && logRows(state).length === beforeCount - 1,
    'remaining twins: ' + remaining.length);
  const second = del(sandbox, record);
  const gone = logRows(state).filter(r => String(r[3]) === 'DUPCARD01');
  check('second delete removes the twin',
    second.success === true && gone.length === 0, 'remaining twins: ' + gone.length);
}

// 7. Degradation: when UrlFetchApp is missing the fallback path still deletes.
{
  const { sandbox, state, calls } = makeSandbox({ absent: true });
  const before = deepCloneState(state);
  const record = renderedRecord(sandbox, { rfid_uid: 'FD73F705', action: 'EXIT' });
  const response = del(sandbox, record);
  check('fallback (no UrlFetchApp) delete succeeds',
    response.success === true && calls.batchGet === 0 && calls.deleteRow === 1 &&
    logRows(state).length === before.sheets.Access_Log.rows.length - 1,
    'got ' + show(response) + ' batchGet=' + calls.batchGet + ' deleteRow=' + calls.deleteRow);
}

console.log('');
console.log(passed + '/' + (passed + failed) + ' history-delete checks passed');
if (failed > 0) process.exit(1);
