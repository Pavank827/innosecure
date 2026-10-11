/**
 * INNOSECURE - Innovation Lab RFID Entry & Exit Monitoring System
 * Google Apps Script Backend API
 * 
 * This script acts as the cloud API between ESP32 and Google Sheets
 */

// ==================== CONFIGURATION ====================
const SPREADSHEET_ID = '1EHQTxaJVCN-GivxZHYT8PT3Uekr-GH039y5aQ8yIQZ8';
const SHEET_USERS = 'Users';
const SHEET_ACCESS_LOG = 'Access_Log';  
const SHEET_CURRENT_STATUS = 'Current_status';
const SHEET_ADMIN_ACCOUNTS = 'Admin_Accounts';
const SHEET_REGISTRATION_REQUEST = 'Registration_Request';

// Canonical header rows. Current_status is the 6-column layout:
// A RFID_UID, B NAME, C USER_ID, D ENTRY_TIME, E EXIT_TIME, F CURRENT_STATUS
// -> CURRENT_STATUS is column F (index 5).
const HEADER_ACCESS_LOG =
  ['TIMESTAMP', 'DATE', 'TIME', 'RFID_UID', 'NAME', 'USER_ID', 'ACTION', 'STATUS'];
const HEADER_CURRENT_STATUS =
  ['RFID_UID', 'NAME', 'USER_ID', 'ENTRY_TIME', 'EXIT_TIME', 'CURRENT_STATUS'];

// A WAITING RFID registration request stays valid slightly longer than the
// frontend's 60s poll window so a card tapped at the last second still lands.
// After this age the request is marked EXPIRED (also cleans up abandoned rows).
const RFID_REQUEST_TTL_MS = 65000;

// Request IDs are REQ_<epoch_ms>; derive creation time without parsing dates.
function parseRFIDRequestIdMs(requestId) {
  var match = /^REQ_(\d+)$/.exec(String(requestId || ''));
  return match ? Number(match[1]) : 0;
}

// rowIndex is the 0-based data-loop index (row number = rowIndex + 1).
// handle is only needed when the batch write has to fall back.
function expireRFIDRow(sheetName, rowIndex, handle) {
  writeCells(sheetName, rowIndex + 1, [
    { col: 2, value: 'EXPIRED' },
    { col: 5, value: formatISTDateTime() }
  ], handle);
}

// ==================== MAIN ENTRY POINT ====================
// Set as the very first statement of doPost/doGet so createResponse() can
// report how much of the ESP32's round trip was spent executing Apps Script.
// The ESP32 logs [HTTP] ... server_ms=... next to its own hop timings, which
// is what pins down whether remaining latency is GAS execution or network.
var _requestStartMs = 0;

// Per-step breakdown of server_ms for the two hot-path actions. Filled by
// markTiming() inside the handler and returned as timings_ms, so the ESP32 log
// can tell a slow spreadsheet open apart from a slow append apart from a slow
// scan. Null for actions that never call markTiming().
var _timingsMs = null;

function markTiming(key, sinceMs) {
  if (!_timingsMs) _timingsMs = {};
  _timingsMs[key] = Date.now() - sinceMs;
}

function doPost(e) {
  _requestStartMs = Date.now();
  _timingsMs = null;
  try {
    const data = JSON.parse(e.postData.contents);
    const action = data.action;
    const payload = data.data || {};

    // Mutating/admin actions require a signed session token once at least one
    // admin account exists (see PROTECTED_ACTIONS).
    if (PROTECTED_ACTIONS.indexOf(action) !== -1) {
      const authError = requireAuth(payload, action);
      if (authError) return authError;
    }

    switch (action) {
      case 'login':
        return handleLogin(payload);
      case 'create_admin_account':
        return handleCreateAdminAccount(payload);
      case 'validate_rfid':
        return handleValidateRFID(payload);
      case 'log_event':
        return handleLogEvent(payload);
      case 'register_user':
        return handleRegisterUser(payload);
      case 'check_rfid':
        return handleCheckRFID(payload);
      case 'register_rfid_scan':
        return handleRegisterRFIDScan(payload);
      case 'get_dashboard_data':
        return handleGetDashboardData(payload);
      case 'get_users':
        return handleGetUsers(payload);
      case 'get_current_inside':
        return handleGetCurrentInside(payload);
      case 'get_history':
        return handleGetHistory(payload);
      case 'get_reports':
        return handleGetReports(payload);
      case 'update_user':
        return handleUpdateUser(payload);
      case 'delete_user':
        return handleDeleteUser(payload);
      case 'delete_history_record':
        return handleDeleteHistoryRecord(payload);
      case 'enter_registration_mode':
        return handleEnterRegistrationMode(payload);
      case 'start_rfid_registration':
        return handleStartRFIDRegistration(payload);
      case 'get_rfid_registration_status':
        return handleGetRFIDRegistrationStatus(payload);
      case 'get_pending_rfid_registration':
        return handleGetPendingRFIDRegistration(payload);
      case 'rfid_registration_result':
        return handleRFIDRegistrationResult(payload);
      case 'export_excel':
        return handleExportExcel(payload);
      default:
        return createResponse(false, 'Unknown action: ' + action);
    }
  } catch (error) {
    return createResponse(false, 'Error: ' + error.message);
  }
}

function doGet(e) {
  _requestStartMs = Date.now();
  _timingsMs = null;
  try {
    const action = e.parameter.action;
    
    switch (action) {
      case 'get_dashboard_data':
        return handleGetDashboardData({});
      case 'get_users':
        return handleGetUsers({});
      case 'get_current_inside':
        return handleGetCurrentInside({});
      case 'get_history':
             return handleGetHistory(e.parameter);
      case 'get_reports':
        return handleGetReports(e.parameter);
      case 'get_rfid_registration_status':
        return handleGetRFIDRegistrationStatus(e.parameter);
      case 'get_pending_rfid_registration':
        return handleGetPendingRFIDRegistration({});
      case 'health':
        return createResponse(true, 'System operational');
      default:
        return createResponse(false, 'Unknown action');
    }
  } catch (error) {
    return createResponse(false, 'Error: ' + error.message);
  }  
}

// ==================== HELPER FUNCTIONS ====================
// openById() is a remote call (~100-400 ms). One web-app execution may touch
// several sheets (validate_rfid: Users + Current_status, log_event:
// Access_Log + Current_status), so the handle is memoized for the lifetime of
// this execution only (Apps Script globals do not persist between requests).
var _sheetCache = {};
function getSpreadsheet() {
  // Web-app requests (website/ESP32) may run without an "active" spreadsheet,
  // so open the configured one directly by ID.
  if (!_sheetCache.ss) {
    _sheetCache.ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  }
  return _sheetCache.ss;
}

function getSheet(name) {
  return getSpreadsheet().getSheetByName(name);
}

// Returns the sheet, creating it with the given header row when it is
// missing. A deleted/renamed Access_Log or Current_status tab must not make
// log_event / validate_rfid throw (the ESP32 would then queue the event
// forever instead of logging it).
function ensureSheet(name, headers) {
  var sheet = getSheet(name);
  if (!sheet) {
    sheet = getSpreadsheet().insertSheet(name);
    sheet.appendRow(headers);
  }
  return sheet;
}

// ==================== FAST BATCH READS (1 round trip) ====================
// Apps Script has no batched getValues(): every sheet read is its own remote
// call (~0.3-0.7 s each). batchReadRanges() buys ALL of a handler's ranges
// with ONE values:batchGet over UrlFetchApp and returns a name -> rows map
// shaped exactly like getDataRange().getValues() (rectangular rows, empty
// cells as '').
//
// It returns null whenever the fast path is unavailable - restricted
// UrlFetchApp, missing OAuth scope, a missing sheet, or any API error - and
// every caller then runs the ORIGINAL per-sheet code unchanged. Values are
// fetched with UNFORMATTED_VALUE, so date/time cells arrive as Sheets serial
// numbers instead of Date objects; the four cell helpers below accept both.
var _batch = null;

function batchReadRanges(specs) {
  try {
    if (typeof UrlFetchApp === 'undefined' || typeof ScriptApp === 'undefined' ||
        typeof ScriptApp.getOAuthToken !== 'function') {
      return null;
    }
    var url = 'https://sheets.googleapis.com/v4/spreadsheets/' + SPREADSHEET_ID +
      '/values:batchGet?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE';
    for (var i = 0; i < specs.length; i++) {
      url += '&ranges=' + encodeURIComponent(specs[i].range);
    }
    var response = UrlFetchApp.fetch(url, { method: 'get', muteHttpExceptions: true });
    if (response.getResponseCode() !== 200) return null;
    var json = JSON.parse(response.getContentText());
    var valueRanges = json.valueRanges || [];
    if (valueRanges.length !== specs.length) return null;
    var out = {};
    for (var j = 0; j < specs.length; j++) {
      out[specs[j].name] = normalizeSheetValues(valueRanges[j] && valueRanges[j].values);
    }
    return out;
  } catch (error) {
    return null;
  }
}

function normalizeSheetValues(values) {
  if (!values || !values.length) return [];
  var width = 0;
  for (var i = 0; i < values.length; i++) {
    if (values[i] && values[i].length > width) width = values[i].length;
  }
  var rows = [];
  for (var r = 0; r < values.length; r++) {
    var src = values[r] || [];
    var row = [];
    for (var c = 0; c < width; c++) {
      row.push(src[c] === null || src[c] === undefined ? '' : src[c]);
    }
    rows.push(row);
  }
  return rows;
}

// Call once at the top of a handler with every range it will read.
// Returns true when the fast path answered.
function prefetchSheets(specs) {
  _batch = batchReadRanges(specs);
  return _batch !== null;
}

function hasPrefetched(name) {
  return _batch !== null && Object.prototype.hasOwnProperty.call(_batch, name);
}

// Sheet -> rows, served from the prefetch when possible, otherwise through
// the original getSheet()/ensureSheet() + getDataRange() code (including its
// exact behaviour when the sheet handle is null).
function readData(name, headers) {
  if (hasPrefetched(name)) {
    return _batch[name];
  }
  var sheet = headers ? ensureSheet(name, headers) : getSheet(name);
  return sheet.getDataRange().getValues();
}

function readDataOrNull(name, headers) {
  if (hasPrefetched(name)) {
    return _batch[name];
  }
  var sheet = headers ? ensureSheet(name, headers) : getSheet(name);
  if (!sheet) return null;
  return sheet.getDataRange().getValues();
}

// ==================== FAST WRITES ====================
// One values:batchUpdate (or values:append) round trip for several cells /
// a row, instead of one remote call per setValue(). Both return false on any
// problem so the caller repeats the original per-cell code.
function restBatchWrite(data) {
  try {
    if (typeof UrlFetchApp === 'undefined' || typeof ScriptApp === 'undefined' ||
        typeof ScriptApp.getOAuthToken !== 'function' || !data.length) {
      return false;
    }
    var response = UrlFetchApp.fetch(
      'https://sheets.googleapis.com/v4/spreadsheets/' + SPREADSHEET_ID + '/values:batchUpdate',
      {
        method: 'post',
        contentType: 'application/json',
        headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
        payload: JSON.stringify({ valueInputOption: 'USER_ENTERED', data: data }),
        muteHttpExceptions: true
      }
    );
    return response.getResponseCode() === 200;
  } catch (error) {
    return false;
  }
}

function restAppend(range, rows) {
  try {
    if (typeof UrlFetchApp === 'undefined' || typeof ScriptApp === 'undefined' ||
        typeof ScriptApp.getOAuthToken !== 'function') {
      return false;
    }
    var response = UrlFetchApp.fetch(
      'https://sheets.googleapis.com/v4/spreadsheets/' + SPREADSHEET_ID +
        '/values/' + encodeURIComponent(range) + ':append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS',
      {
        method: 'post',
        contentType: 'application/json',
        headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
        payload: JSON.stringify({ majorDimension: 'ROWS', values: rows }),
        muteHttpExceptions: true
      }
    );
    if (response.getResponseCode() !== 200) return false;
    try {
      JSON.parse(response.getContentText());
      return true;
    } catch (parseError) {
      return false;
    }
  } catch (error) {
    return false;
  }
}

// Apply every listed cell change in ONE values:batchUpdate round trip; if
// that fails, apply them one by one through the original getRange() code
// (clear:true cells keep using clearContent() there). `handle` is only used
// on that fallback, so the fast path never opens the file - and when the slow
// path already has a handle open, the original per-cell code runs directly.
function writeCells(sheetName, rowIndex, writes, handle) {
  if (!writes.length) return;
  if (handle) {
    for (var h = 0; h < writes.length; h++) {
      if (writes[h].clear) {
        handle.getRange(rowIndex, writes[h].col).clearContent();
      } else {
        handle.getRange(rowIndex, writes[h].col).setValue(writes[h].value);
      }
    }
    return;
  }
  var payload = [];
  for (var i = 0; i < writes.length; i++) {
    payload.push({
      range: sheetName + '!' + String.fromCharCode(64 + writes[i].col) + rowIndex,
      values: [[writes[i].clear ? '' : writes[i].value]]
    });
  }
  if (restBatchWrite(payload)) return;
  var target = getSheet(sheetName);
  for (var k = 0; k < writes.length; k++) {
    if (writes[k].clear) {
      target.getRange(rowIndex, writes[k].col).clearContent();
    } else {
      target.getRange(rowIndex, writes[k].col).setValue(writes[k].value);
    }
  }
}

// One append round trip without opening the file; when the slow path already
// has `handle`, the original appendRow() runs directly. `headers` (optional)
// recreates a sheet that vanished between the read and the append, exactly
// like the original ensureSheet() calls did.
function appendRowTo(range, sheetName, row, handle, headers) {
  if (handle) {
    handle.appendRow(row);
    return;
  }
  if (!restAppend(range, [row])) {
    (headers ? ensureSheet(sheetName, headers) : getSheet(sheetName)).appendRow(row);
  }
}

function createResponse(success, message, data) {
  const response = {
    success: success,
    message: message || '',
    timestamp: new Date().toISOString(),
    // Server-side execution time of this request. For POST actions this is the
    // Apps Script work behind hop 1 (validate_rfid sheet reads, log_event
    // writes); the 302/echo hop serves cached output and does not re-run code.
    server_ms: _requestStartMs ? (Date.now() - _requestStartMs) : -1
  };
  // Omitted entirely when the handler recorded no steps, so actions that are
  // not instrumented keep the exact payload they had before.
  if (_timingsMs) {
    response.timings_ms = _timingsMs;
  }
  if (data) {
    response.data = data;
  }
  return ContentService.createTextOutput(JSON.stringify(response))
    .setMimeType(ContentService.MimeType.JSON);
}

// ==================== TIME HELPERS (IST, timezone independent) ====================
// The ESP32 applies the +05:30 offset itself, so timestamps arriving from the
// firmware are already IST wall-clock strings. All helpers below therefore
// read IST fields through getUTC*() on a shifted instant: the result is
// correct no matter what timezone the Apps Script project is set to (the
// previous getFullYear()/getHours() version double-shifted when the project
// timezone was already Asia/Kolkata, which silently moved "today" in every
// dashboard/report query).
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const IST_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

function pad2(n) {
  return String(n).padStart(2, '0');
}

// A Date whose UTC fields equal IST wall-clock time. Always read it with
// getUTCFullYear()/getUTCHours()/...
function getISTTimestamp(date) {
  var base = date ? date.getTime() : Date.now();
  return new Date(base + IST_OFFSET_MS);
}

function formatISTDate(date) {
  var d = getISTTimestamp(date);
  return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
}

function formatISTTime(date) {
  var d = getISTTimestamp(date);
  return pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ':' + pad2(d.getUTCSeconds());
}

function formatISTDateTime(date) {
  return formatISTDate(date) + ' ' + formatISTTime(date);
}

// Sheets serial numbers: what values:batchGet returns with UNFORMATTED_VALUE
// (dates = days since 1899-12-30, times = a fraction of a day). Converted
// back through the UTC fields of the wall-clock instant, so the output is the
// same IST wall clock the Date branches above produce, with no timezone
// dependency at all. Only plausible serial ranges are treated as numbers -
// any other plain number still falls through to the string path below, which
// is exactly what getValues() + String() did before.
const SHEET_SERIAL_DAY_ZERO = 25569;  // days between 1899-12-30 and 1970-01-01

function isSheetSerial(value) {
  return typeof value === 'number' && isFinite(value) &&
    ((value >= 0 && value < 1) || (value >= 20000 && value <= 80000));
}

function sheetSerialDate(serial) {
  return new Date(Math.round((serial - SHEET_SERIAL_DAY_ZERO) * 86400000));
}

// Seconds since midnight for a time-of-day cell. Sheets may hand back either
// a plain string ("14:30:05", which is what the ESP32 path writes), a Date
// (if the cell auto-converted to a time value) or, on the fast batch path, a
// day fraction; all are accepted so a TypeError can never bubble up into
// doPost().
function secondsOfDayFromCell(value) {
  if (isSheetSerial(value)) {
    var sd = sheetSerialDate(value);
    return sd.getUTCHours() * 3600 + sd.getUTCMinutes() * 60 + sd.getUTCSeconds();
  }
  if (value instanceof Date) {
    return value.getHours() * 3600 + value.getMinutes() * 60 + value.getSeconds();
  }
  var m = /^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/.exec(String(value || '').trim());
  if (!m) return -1;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] || 0);
}

// Seconds since midnight on the IST clock (timezone independent).
function istSecondsOfDay(date) {
  var d = getISTTimestamp(date);
  return d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds();
}

// ==================== SHEET CELL NORMALISATION ====================
// Sheets silently converts "2026-10-01 09:05:07" and "09:05:07" into Date
// objects. JSON.stringify() then emits them as a UTC ISO string (the dashboard
// used to show 18:30 for a 00:00 IST event), and a Date never equals a
// "YYYY-MM-DD" filter string, which zeroed today's entry/exit counters and
// made every date-range filter return nothing. Everything read from a cell
// goes through these three helpers.

// 'YYYY-MM-DD' for a date cell, whatever Sheets hands back.
function dateKeyFromCell(value) {
  if (isSheetSerial(value)) {
    var sd = sheetSerialDate(value);
    return sd.getUTCFullYear() + '-' + pad2(sd.getUTCMonth() + 1) + '-' + pad2(sd.getUTCDate());
  }
  if (value instanceof Date) {
    // A date-only cell arrives as local midnight; read its local fields so a
    // script timezone far from IST cannot shift the day.
    if (value.getHours() === 0 && value.getMinutes() === 0 && value.getSeconds() === 0) {
      return value.getFullYear() + '-' + pad2(value.getMonth() + 1) + '-' + pad2(value.getDate());
    }
    return formatISTDate(value);
  }
  var s = String(value || '').trim();
  var m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return m ? m[1] : s;  // no date inside -> pass the raw text through unchanged
}

// 'HH:MM:SS' for a time-of-day or date-time cell.
function timeTextFromCell(value) {
  if (isSheetSerial(value)) {
    var sd = sheetSerialDate(value);
    return pad2(sd.getUTCHours()) + ':' + pad2(sd.getUTCMinutes()) + ':' + pad2(sd.getUTCSeconds());
  }
  if (value instanceof Date) {
    // Sheets time-only cells are dated 1899-12-30: their local fields ARE the
    // wall-clock time and must not be shifted to IST.
    if (value.getFullYear() < 1901) {
      return pad2(value.getHours()) + ':' + pad2(value.getMinutes()) + ':' + pad2(value.getSeconds());
    }
    return formatISTTime(value);
  }
  var m = /^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/.exec(String(value || '').trim());
  if (m) return pad2(Number(m[1])) + ':' + pad2(Number(m[2])) + ':' + pad2(Number(m[3] || 0));
  return '';
}

// 'YYYY-MM-DD HH:MM:SS' in IST for a timestamp cell.
function dateTimeTextFromCell(value) {
  if (isSheetSerial(value)) {
    var sd = sheetSerialDate(value);
    return sd.getUTCFullYear() + '-' + pad2(sd.getUTCMonth() + 1) + '-' + pad2(sd.getUTCDate()) +
      ' ' + pad2(sd.getUTCHours()) + ':' + pad2(sd.getUTCMinutes()) + ':' + pad2(sd.getUTCSeconds());
  }
  if (value instanceof Date) return formatISTDateTime(value);
  var s = String(value || '').trim();
  if (s === '') return '';
  if (IST_TIMESTAMP_RE.test(s)) return s;
  var d = new Date(s);  // leftover ISO strings from rows written by older code
  if (!isNaN(d.getTime())) return formatISTDateTime(d);
  return s;
}

// ==================== PASSWORD HASHING & SESSION TOKENS ====================
// The original hash was a 32-bit JavaScript string hash: two different
// passwords almost always collided and the value could be inverted trivially.
// Passwords are now salted SHA-256, keyed with a per-script secret kept in
// Script Properties (never in the sheet or the repository).

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;  // 12 hours

function getAuthSecret() {
  var props = PropertiesService.getScriptProperties();
  var secret = props.getProperty('AUTH_SECRET');
  if (!secret) {
    secret = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
    props.setProperty('AUTH_SECRET', secret);
  }
  return secret;
}

function sha256Hex(text) {
  var bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(text),
    Utilities.Charset.UTF_8
  );
  var hex = '';
  for (var i = 0; i < bytes.length; i++) {
    var b = (bytes[i] + 256) % 256;
    hex += (b < 16 ? '0' : '') + b.toString(16);
  }
  return hex;
}

// New format: s2_<hex>. Legacy rows keep the old h_<base36> value.
function hashPassword(password) {
  return 's2_' + sha256Hex(getAuthSecret() + '|' + String(password));
}

function legacyHashPassword(password) {
  var hash = 0;
  var str = String(password);
  for (var i = 0; i < str.length; i++) {
    var char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return 'h_' + Math.abs(hash).toString(36);
}

function verifyPassword(password, storedHash) {
  if (!storedHash) return false;
  var stored = String(storedHash);
  if (stored.indexOf('h_') === 0) {
    return stored === legacyHashPassword(password);  // legacy row
  }
  return stored === hashPassword(password);
}

// Session token: t1_<expiry_ms>_<signature>_<username>
// Signature = SHA-256(secret|expiry|username). Unsigned "auth_<Date.now>"
// tokens proved nothing and were valid forever.
function signToken(username, ttlMs) {
  var exp = Date.now() + (ttlMs || TOKEN_TTL_MS);
  var sig = sha256Hex(getAuthSecret() + '|' + exp + '|' + username).substring(0, 32);
  return 't1_' + exp + '_' + sig + '_' + username;
}

function verifyToken(token) {
  if (!token) return null;
  var m = /^t1_(\d+)_([0-9a-f]{8,64})_(.+)$/.exec(String(token));
  if (!m) return null;

  var exp = Number(m[1]);
  var sig = m[2];
  var username = m[3];

  if (!exp || Date.now() > exp) return null;

  var expected = sha256Hex(getAuthSecret() + '|' + exp + '|' + username).substring(0, 32);
  if (expected !== sig) return null;

  return username;
}

function hasAdminAccounts() {
  var sheet = getSheet(SHEET_ADMIN_ACCOUNTS);
  if (!sheet) return false;
  return sheet.getLastRow() > 1;  // header + at least one account
}

// Actions that mutate data (or expose exports) need a valid session token
// once admin accounts exist. While the sheet is still empty the API stays
// open, otherwise the very first account could never be created.
const PROTECTED_ACTIONS = [
  'create_admin_account',
  'update_user',
  'delete_user',
  'delete_history_record',
  'export_excel'
];

function requireAuth(payload, action) {
  if (!hasAdminAccounts()) return null;
  if (verifyToken(payload && payload.auth_token)) return null;
  return createResponse(false, 'Authentication required for ' + action);
}

// ==================== ADMIN ACCOUNT MANAGEMENT ====================
function handleCreateAdminAccount(payload) {
  var fast = prefetchSheets([
    { name: SHEET_ADMIN_ACCOUNTS, range: SHEET_ADMIN_ACCOUNTS + '!A1:D' }
  ]);
  var sheet = null;
  var data;
  if (fast) {
    data = _batch[SHEET_ADMIN_ACCOUNTS];
  } else {
    sheet = getSheet(SHEET_ADMIN_ACCOUNTS);
    data = sheet.getDataRange().getValues();
  }

  var username = String(payload.username || '').trim();
  var password = String(payload.password || '');
  var fullName = String(payload.fullName || '').trim();

  if (!username || !password) {
    return createResponse(false, 'Username and password are required');
  }

  if (username.length > 64 || password.length < 4 || password.length > 128) {
    return createResponse(false, 'Username must be <= 64 chars and password 4-128 chars');
  }

  if (fullName.length > 128) {
    fullName = fullName.substring(0, 128);
  }

  for (var i = 1; i < data.length; i++) {
    if (data[i][1] && String(data[i][1]).toLowerCase() === username.toLowerCase()) {
      return createResponse(false, 'Username already exists');
    }
  }

  var timestamp = formatISTDateTime();

  appendRowTo(SHEET_ADMIN_ACCOUNTS + '!A:D', SHEET_ADMIN_ACCOUNTS,
    [fullName, username, hashPassword(password), timestamp], sheet);

  return createResponse(true, 'Admin account created successfully', {
    username: username
  });
}

function handleLogin(payload) {
  var username = String(payload.username || '').trim();
  var password = String(payload.password || '');

  if (!username || !password) {
    return createResponse(false, 'Username and password are required');
  }

  if (username.length > 64 || password.length > 128) {
    return createResponse(false, 'Invalid username or password');
  }

  var fast = prefetchSheets([
    { name: SHEET_ADMIN_ACCOUNTS, range: SHEET_ADMIN_ACCOUNTS + '!A1:D' }
  ]);
  var sheet = null;
  var data;
  if (fast) {
    data = _batch[SHEET_ADMIN_ACCOUNTS];
  } else {
    sheet = getSheet(SHEET_ADMIN_ACCOUNTS);
    data = sheet.getDataRange().getValues();
  }

  for (var i = 1; i < data.length; i++) {
    if (!data[i][1] || String(data[i][1]).toLowerCase() !== username.toLowerCase()) {
      continue;
    }

    if (!verifyPassword(password, data[i][2])) {
      return createResponse(false, 'Invalid username or password');
    }

    // Transparently upgrade a legacy weak hash to the salted SHA-256 format
    // the first time that password is used.
    var stored = String(data[i][2] || '');
    if (stored.indexOf('s2_') !== 0) {
      writeCells(SHEET_ADMIN_ACCOUNTS, i + 1, [
        { col: 3, value: hashPassword(password) }
      ], sheet);
    }

    return createResponse(true, 'Login successful', {
      token: signToken(String(data[i][1])),
      username: data[i][1],
      fullName: data[i][0],
      role: 'admin'
    });
  }

  return createResponse(false, 'Invalid username or password');
}

// ==================== RFID VALIDATION ====================
// READ-ONLY by design: this call sits on the critical path of every tap, so it
// must not write. The old version did ensureSheet(Current_status) + appendRow
// when a registered user had no status row yet - that is a second openById()
// plus a Sheets write (~0.5-1.5 s) on the hot path. updateCurrentStatus() (run
// by the following log_event) creates that row anyway, and a missing row reads
// as OUTSIDE, which is the correct default before any ENTRY is logged.
function handleValidateRFID(payload) {
  var stepStart = Date.now();
  prefetchSheets([
    { name: SHEET_USERS, range: SHEET_USERS + '!A1:G' },
    { name: SHEET_CURRENT_STATUS, range: SHEET_CURRENT_STATUS + '!A1:F' }
  ]);
  var batchMs = Date.now() - stepStart;
  var afterPrefetch = Date.now();

  var data;
  if (hasPrefetched(SHEET_USERS)) {
    data = _batch[SHEET_USERS];
    markTiming('open_ms', Date.now());  // fast path never opened the file
    markTiming('users_read_ms', Date.now() - batchMs);
  } else {
    var sheet = getSpreadsheet().getSheetByName(SHEET_USERS);
    markTiming('open_ms', afterPrefetch);
    if (!sheet) {
      return createResponse(false, 'Users sheet is missing');
    }
    var readStart = Date.now();
    data = sheet.getDataRange().getValues();
    markTiming('users_read_ms', readStart);
  }
  var rfidUID = String(payload.rfid_uid || '').trim();

  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() !== rfidUID) continue;

    // Current_status: A..F, so CURRENT_STATUS is column F = index 5.
    var currentStatus = 'OUTSIDE';
    var statusData = null;
    if (hasPrefetched(SHEET_CURRENT_STATUS)) {
      statusData = _batch[SHEET_CURRENT_STATUS];
      markTiming('status_read_ms', Date.now() - batchMs);
    } else {
      var statusSheet = getSpreadsheet().getSheetByName(SHEET_CURRENT_STATUS);
      if (statusSheet) {
        var statusStart = Date.now();
        statusData = statusSheet.getDataRange().getValues();
        markTiming('status_read_ms', statusStart);
      }
    }
    if (statusData) {
      for (var j = 1; j < statusData.length; j++) {
        if (String(statusData[j][0]).trim() === rfidUID) {
          // Column F only - never column E (that is EXIT_TIME now).
          var stored = String(statusData[j][5] || '').trim().toUpperCase();
          if (stored === 'INSIDE' || stored === 'OUTSIDE') {
            currentStatus = stored;
          }
          // Empty/unreadable column F => safely OUTSIDE (default above).
          break;
        }
      }
    }

    return createResponse(true, 'User found', {
      registered: true,
      name: data[i][1],
      user_id: data[i][2],
      department: data[i][3],
      user_type: data[i][4],
      status: data[i][5],
      current_status: currentStatus
    });
  }

  return createResponse(true, 'User not found', { registered: false });
}

// ==================== LOG EVENT ====================
function handleLogEvent(payload) {
  if (!payload || !payload.rfid_uid) {
    return createResponse(false, 'rfid_uid is required');
  }

  // The firmware sends "" while its clock is not NTP-synced yet (and older
  // firmware sent the literal "TIME_UNAVAILABLE"). A malformed value would be
  // written into TIMESTAMP/DATE/TIME and break every "today" filter, so any
  // non-conforming timestamp is replaced with the server's IST clock.
  var timestamp = String(payload.timestamp || '').trim();
  if (!IST_TIMESTAMP_RE.test(timestamp)) {
    timestamp = formatISTDateTime();
  }

  var parts = timestamp.split(' ');
  var date = parts[0];
  var time = parts[1];

  var rfidUID = String(payload.rfid_uid).substring(0, 32);
  var name = String(payload.name || 'Unknown').substring(0, 128);
  var userId = String(payload.user_id || 'N/A').substring(0, 64);
  var action = String(payload.action || 'UNKNOWN').toUpperCase().substring(0, 32);
  var status = String(payload.status || 'UNKNOWN').toUpperCase().substring(0, 64);

  // Always a NEW row - never overwrites earlier Access_Log records.
  var row = [
    timestamp,
    date,
    time,
    rfidUID,
    name,
    userId,
    action,
    status
  ];

  var stepStart = Date.now();
  if (restAppend(SHEET_ACCESS_LOG + '!A:H', [row])) {
    markTiming('sheet_ms', Date.now());  // fast path never opened the file
    markTiming('append_ms', stepStart);
  } else {
    // Missing sheet must not throw: create it with the canonical header so the
    // event is still appended instead of the ESP32 being handed an error.
    var sheet = ensureSheet(SHEET_ACCESS_LOG, HEADER_ACCESS_LOG);
    markTiming('sheet_ms', stepStart);
    var appendStart = Date.now();
    sheet.appendRow(row);
    markTiming('append_ms', appendStart);
  }

  if (action === 'ENTRY' || action === 'EXIT') {
    // Pass the exact time written above so Current_status ENTRY_TIME /
    // EXIT_TIME always matches the Access_Log row for the same event.
    var statusStart = Date.now();
    updateCurrentStatus(rfidUID, action, name, userId, time);
    markTiming('status_ms', statusStart);
  }

  return createResponse(true, 'Event logged successfully');
}

// Current_status layout (6 columns):
// A RFID_UID | B NAME | C USER_ID | D ENTRY_TIME | E EXIT_TIME | F CURRENT_STATUS
//
// ENTRY: D = now, F = INSIDE,  E preserved.
// EXIT : E = now, F = OUTSIDE, D preserved.
function updateCurrentStatus(rfidUID, action, name, userId, timeText) {
  if (!rfidUID) return;

  // Same clock second as the Access_Log row; server IST clock as fallback.
  var time = /^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(String(timeText || '').trim())
    ? String(timeText).trim()
    : formatISTTime();

  var fast = prefetchSheets([
    { name: SHEET_CURRENT_STATUS, range: SHEET_CURRENT_STATUS + '!A1:F' }
  ]);
  var sheet = null;
  var data;
  if (fast) {
    data = _batch[SHEET_CURRENT_STATUS];
  } else {
    sheet = ensureSheet(SHEET_CURRENT_STATUS, HEADER_CURRENT_STATUS);
    data = sheet.getDataRange().getValues();
  }

  var rowIndex = -1;
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === rfidUID) {
      rowIndex = i + 1;
      break;
    }
  }

  if (rowIndex < 0) {
    var newRow = null;
    if (action === 'ENTRY') {
      newRow = [rfidUID, name || 'Unknown', userId || 'N/A', time, '', 'INSIDE'];
    } else if (action === 'EXIT') {
      newRow = [rfidUID, name || 'Unknown', userId || 'N/A', '', time, 'OUTSIDE'];
    }
    if (!newRow) return;
    if (fast) {
      if (restAppend(SHEET_CURRENT_STATUS + '!A:F', [newRow])) return;
      ensureSheet(SHEET_CURRENT_STATUS, HEADER_CURRENT_STATUS).appendRow(newRow);
      return;
    }
    sheet.appendRow(newRow);
    return;
  }

  // Repair rows written by the old 5-column code, where the status text
  // landed in column E - which is EXIT_TIME now and must hold a time only.
  var exitCell = String(data[rowIndex - 1][4] || '').trim();
  if (/^(INSIDE|OUTSIDE)$/i.test(exitCell)) {
    sheet = sheet || ensureSheet(SHEET_CURRENT_STATUS, HEADER_CURRENT_STATUS);
    sheet.getRange(rowIndex, 5).clearContent();
  }

  // One write spec per changed cell, in the original order; both paths apply
  // exactly these so the end state can never differ between them.
  var writes = [];
  if (!String(data[rowIndex - 1][1] || '').trim() && name) {
    writes.push({ col: 2, value: name });
  }
  if (!String(data[rowIndex - 1][2] || '').trim() && userId) {
    writes.push({ col: 3, value: userId });
  }
  if (action === 'ENTRY') {
    writes.push({ col: 4, value: time });       // D ENTRY_TIME
    writes.push({ col: 6, value: 'INSIDE' });   // F CURRENT_STATUS
  } else if (action === 'EXIT') {
    writes.push({ col: 5, value: time });       // E EXIT_TIME
    writes.push({ col: 6, value: 'OUTSIDE' });  // F CURRENT_STATUS
  }

  writeCells(SHEET_CURRENT_STATUS, rowIndex, writes, sheet);
}

// ==================== USER REGISTRATION ====================
function handleRegisterUser(payload) {
  var fast = prefetchSheets([
    { name: SHEET_USERS, range: SHEET_USERS + '!A1:G' },
    { name: SHEET_CURRENT_STATUS, range: SHEET_CURRENT_STATUS + '!A1:F' }
  ]);
  var sheet = null;
  var data;
  if (fast) {
    data = _batch[SHEET_USERS];
  } else {
    sheet = getSheet(SHEET_USERS);
    data = sheet.getDataRange().getValues();
  }

  var rfidUID = String(payload.rfid_uid || '').trim();
  var name = String(payload.name || '').trim();
  var userId = String(payload.user_id || '').trim();
  var department = String(payload.department || '').trim();
  var userType = String(payload.user_type || 'Student').trim();

  if (!rfidUID) {
    return createResponse(false, 'rfid_uid is required');
  }
  if (!name || !userId) {
    return createResponse(false, 'name and user_id are required');
  }
  if (rfidUID.length > 32 || name.length > 128 || userId.length > 64 ||
      department.length > 64 || userType.length > 32) {
    return createResponse(false, 'One or more fields exceed the allowed length');
  }

  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === rfidUID) {
      return createResponse(false, 'RFID card already registered');
    }
  }

  var timestamp = formatISTDateTime();
  var userRow = [
    rfidUID,
    name,
    userId,
    department,
    userType || 'Student',
    'Active',
    timestamp
  ];
  appendRowTo(SHEET_USERS + '!A:G', SHEET_USERS, userRow, sheet);

  // Current_status row for the new user (6 columns):
  // [RFID_UID, NAME, USER_ID, "", "", "OUTSIDE"]
  var statusSheet = null;
  var statusData;
  if (fast) {
    statusData = _batch[SHEET_CURRENT_STATUS];
  } else {
    statusSheet = ensureSheet(SHEET_CURRENT_STATUS, HEADER_CURRENT_STATUS);
    statusData = statusSheet.getDataRange().getValues();
  }
  var existingRow = -1;

  for (var s = 1; s < statusData.length; s++) {
    if (String(statusData[s][0]).trim() === rfidUID) {
      existingRow = s + 1;
      break;
    }
  }

  if (existingRow > 0) {
    // Defensive: a leftover status row must be reset for the fresh user
    // instead of leaving a stale INSIDE/entry time behind.
    writeCells(SHEET_CURRENT_STATUS, existingRow, [
      { col: 2, value: name },
      { col: 3, value: userId },
      { col: 4, clear: true },
      { col: 5, clear: true },
      { col: 6, value: 'OUTSIDE' }
    ], statusSheet);
  } else {
    var statusRow = [rfidUID, name, userId, '', '', 'OUTSIDE'];
    appendRowTo(SHEET_CURRENT_STATUS + '!A:F', SHEET_CURRENT_STATUS, statusRow,
      statusSheet, HEADER_CURRENT_STATUS);
  }

  return createResponse(true, 'User registered successfully', {
    rfid_uid: rfidUID,
    name: name
  });
}

// ==================== CHECK RFID ====================
function handleCheckRFID(payload) {
  var fast = prefetchSheets([
    { name: SHEET_USERS, range: SHEET_USERS + '!A1:G' }
  ]);
  var data;
  if (fast) {
    data = _batch[SHEET_USERS];
  } else {
    data = getSheet(SHEET_USERS).getDataRange().getValues();
  }
  var rfidUID = payload.rfid_uid;

  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === rfidUID) {
      return createResponse(true, 'RFID exists', {
        exists: true,
        name: data[i][1]
      });
    }
  }
  
  return createResponse(true, 'RFID available', { exists: false });
}

function handleRegisterRFIDScan(payload) {
  return createResponse(true, 'RFID scan recorded', {
    rfid_uid: payload.rfid_uid,
    status: 'waiting_for_details'
  });
}

// ==================== DASHBOARD DATA ====================
function handleGetDashboardData(payload) {
  var fast = prefetchSheets([
    { name: SHEET_USERS, range: SHEET_USERS + '!A1:G' },
    { name: SHEET_CURRENT_STATUS, range: SHEET_CURRENT_STATUS + '!A1:F' },
    { name: SHEET_ACCESS_LOG, range: SHEET_ACCESS_LOG + '!A1:H' }
  ]);

  var usersData;
  var statusData;
  var logData;
  if (fast) {
    usersData = _batch[SHEET_USERS];
    statusData = _batch[SHEET_CURRENT_STATUS];
    logData = _batch[SHEET_ACCESS_LOG];
  } else {
    var usersSheet = getSheet(SHEET_USERS);
    usersData = usersSheet.getDataRange().getValues();
    var statusSheet = ensureSheet(SHEET_CURRENT_STATUS, HEADER_CURRENT_STATUS);
    statusData = statusSheet.getDataRange().getValues();
    var logSheet = ensureSheet(SHEET_ACCESS_LOG, HEADER_ACCESS_LOG);
    logData = logSheet.getDataRange().getValues();
  }
  var registeredUsers = Math.max(0, usersData.length - 1);
  var currentlyInside = 0;

  for (var i = 1; i < statusData.length; i++) {
    if (String(statusData[i][5] || '').toUpperCase() === 'INSIDE') {
      currentlyInside++;
    }
  }

  var today = formatISTDate();

  var todayEntries = 0;
  var todayExits = 0;
  var latestScan = null;

  for (var i = 1; i < logData.length; i++) {
    if (dateKeyFromCell(logData[i][1]) === today) {
      if (logData[i][6] === 'ENTRY') todayEntries++;
      if (logData[i][6] === 'EXIT') todayExits++;
    }
  }

  if (logData.length > 1) {
    var lastRow = logData[logData.length - 1];
    latestScan = {
      timestamp: dateTimeTextFromCell(lastRow[0]),
      name: lastRow[4],
      rfid_uid: lastRow[3],
      action: lastRow[6],
      status: lastRow[7]
    };
  }

  return createResponse(true, 'Dashboard data retrieved', {
    registered_users: registeredUsers,
    currently_inside: currentlyInside,
    today_entries: todayEntries,
    today_exits: todayExits,
    latest_scan: latestScan,
    last_sync: formatISTDateTime(),
    system_status: {
      esp32: 'ONLINE',
      rfid: 'READY',
      internet: 'CONNECTED',
      google_sheets: 'SYNCED'
    }
  });
}

// ==================== GET USERS ====================
function handleGetUsers(payload) {
  var fast = prefetchSheets([
    { name: SHEET_USERS, range: SHEET_USERS + '!A1:G' },
    { name: SHEET_CURRENT_STATUS, range: SHEET_CURRENT_STATUS + '!A1:F' }
  ]);

  var data;
  var statusData;
  if (fast) {
    data = _batch[SHEET_USERS];
    statusData = _batch[SHEET_CURRENT_STATUS];
  } else {
    var sheet = getSheet(SHEET_USERS);
    data = sheet.getDataRange().getValues();
    var statusSheet = ensureSheet(SHEET_CURRENT_STATUS, HEADER_CURRENT_STATUS);
    statusData = statusSheet.getDataRange().getValues();
  }
  var users = [];

  // One pass over Current_status instead of a nested scan per user; the first
  // row for an RFID_UID still wins, exactly like the inner loop's break.
  var statusByRfid = Object.create(null);
  for (var j = 1; j < statusData.length; j++) {
    var key = String(statusData[j][0]).trim();
    if (!Object.prototype.hasOwnProperty.call(statusByRfid, key)) {
      statusByRfid[key] = statusData[j][5];
    }
  }

  for (var i = 1; i < data.length; i++) {
    var currentStatus = 'OUTSIDE';
    var lookupKey = String(data[i][0]).trim();
    if (Object.prototype.hasOwnProperty.call(statusByRfid, lookupKey)) {
      var storedStatus = String(statusByRfid[lookupKey] || '').trim().toUpperCase();
      if (storedStatus === 'INSIDE' || storedStatus === 'OUTSIDE') {
        currentStatus = storedStatus;
      }
    }

    users.push({
      rfid_uid: data[i][0],
      name: data[i][1],
      user_id: data[i][2],
      department: data[i][3],
      user_type: data[i][4],
      status: data[i][5],
      registration_date: dateKeyFromCell(data[i][6]),
      current_status: currentStatus
    });
  }

  return createResponse(true, 'Users retrieved', { users: users });
}

// ==================== GET CURRENT INSIDE ====================
function handleGetCurrentInside(payload) {
  var fast = prefetchSheets([
    { name: SHEET_CURRENT_STATUS, range: SHEET_CURRENT_STATUS + '!A1:F' },
    { name: SHEET_USERS, range: SHEET_USERS + '!A1:G' }
  ]);

  var data;
  var usersData;
  if (fast) {
    data = _batch[SHEET_CURRENT_STATUS];
    usersData = _batch[SHEET_USERS];
  } else {
    var sheet = ensureSheet(SHEET_CURRENT_STATUS, HEADER_CURRENT_STATUS);
    data = sheet.getDataRange().getValues();
    var usersSheet = getSheet(SHEET_USERS);
    usersData = usersSheet.getDataRange().getValues();
  }
  var insideUsers = [];

  // First matching user row wins, exactly like the inner loop's break.
  var deptByRfid = new Map();
  for (var j = 1; j < usersData.length; j++) {
    if (!deptByRfid.has(usersData[j][0])) {
      deptByRfid.set(usersData[j][0], usersData[j][3]);
    }
  }

  for (var i = 1; i < data.length; i++) {
    if (String(data[i][5] || '').toUpperCase() === 'INSIDE') {
      var department = deptByRfid.has(data[i][0]) ? deptByRfid.get(data[i][0]) : '';
      var userId = data[i][2];

      var entryTime = data[i][3];
      // Duration must compare IST wall-clock time against IST wall-clock time.
      // The old code mixed a timezone-shifted Date with setHours(), which is
      // only correct when the script timezone happens to be UTC.
      var entrySec = secondsOfDayFromCell(entryTime);
      var diffSec = entrySec < 0 ? 0 : istSecondsOfDay() - entrySec;
      if (diffSec < 0) diffSec += 24 * 3600;  // entered before midnight
      if (diffSec > 7 * 24 * 3600) diffSec = 0;  // corrupt cell -> do not show weeks
      var diffMins = Math.floor(diffSec / 60);
      var hours = Math.floor(diffMins / 60);
      var mins = diffMins % 60;
      var duration = hours > 0 ? hours + 'h ' + mins + 'm' : mins + 'm';

      insideUsers.push({
        rfid_uid: data[i][0],
        name: data[i][1],
        user_id: userId,
        department: department,
        entry_time: timeTextFromCell(entryTime),
        duration: duration,
        status: 'INSIDE'
      });
    }
  }

  return createResponse(true, 'Current inside users retrieved', {
    count: insideUsers.length,
    users: insideUsers
  });
}

// ==================== GET HISTORY ====================
function handleGetHistory(params) {
  var fast = prefetchSheets([
    { name: SHEET_ACCESS_LOG, range: SHEET_ACCESS_LOG + '!A1:H' }
  ]);
  var data;
  if (fast) {
    data = _batch[SHEET_ACCESS_LOG];
  } else {
    var sheet = ensureSheet(SHEET_ACCESS_LOG, HEADER_ACCESS_LOG);
    data = sheet.getDataRange().getValues();
  }
  var history = [];
  
  var filterDate = String(params.filter_date || '').substring(0, 10);
  var filterName = String(params.filter_name || '').substring(0, 64);
  var filterRFID = String(params.filter_rfid || '').substring(0, 32);
  var filterAction = String(params.filter_action || '').substring(0, 32);
  var limit = parseInt(params.limit, 10);
  if (!isFinite(limit) || limit <= 0) limit = 100;
  limit = Math.min(limit, 1000);
  
  for (var i = data.length - 1; i >= 1 && history.length < limit; i--) {
    var match = true;
    var rowDate = dateKeyFromCell(data[i][1]);
    
    if (filterDate && rowDate !== filterDate) match = false;
    if (filterName && String(data[i][4]).toLowerCase().indexOf(filterName.toLowerCase()) === -1) match = false;
    if (filterRFID && String(data[i][3]).toLowerCase().indexOf(filterRFID.toLowerCase()) === -1) match = false;
    if (filterAction && data[i][6] !== filterAction) match = false;
    
    if (match) {
      history.push({
        timestamp: dateTimeTextFromCell(data[i][0]),
        date: rowDate,
        time: timeTextFromCell(data[i][2]),
        rfid_uid: data[i][3],
        name: data[i][4],
        user_id: data[i][5],
        action: data[i][6],
        status: data[i][7]
      });
    }
  }
  
  return createResponse(true, 'History retrieved', { history: history });
}

// ==================== GET REPORTS ====================
function handleGetReports(params) {
  var fast = prefetchSheets([
    { name: SHEET_ACCESS_LOG, range: SHEET_ACCESS_LOG + '!A1:H' },
    { name: SHEET_CURRENT_STATUS, range: SHEET_CURRENT_STATUS + '!A1:F' }
  ]);
  var data;
  var statusData;
  if (fast) {
    data = _batch[SHEET_ACCESS_LOG];
    statusData = _batch[SHEET_CURRENT_STATUS];
  } else {
    var sheet = ensureSheet(SHEET_ACCESS_LOG, HEADER_ACCESS_LOG);
    data = sheet.getDataRange().getValues();
    var statusSheet = ensureSheet(SHEET_CURRENT_STATUS, HEADER_CURRENT_STATUS);
    statusData = statusSheet.getDataRange().getValues();
  }

  var fromDate = String(params.from_date || formatISTDate(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)));
  var toDate = String(params.to_date || formatISTDate());

  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) {
    fromDate = formatISTDate(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000));
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(toDate)) {
    toDate = formatISTDate();
  }
  if (fromDate > toDate) {
    var swap = fromDate;
    fromDate = toDate;
    toDate = swap;
  }

  var totalEntries = 0;
  var totalExits = 0;
  var visits = {};
  var reportData = [];

  for (var i = 1; i < data.length; i++) {
    var rowDate = dateKeyFromCell(data[i][1]);
    if (rowDate >= fromDate && rowDate <= toDate) {
      if (data[i][6] === 'ENTRY') {
        totalEntries++;
        visits[data[i][3] + '_' + rowDate] = true;
      }
      if (data[i][6] === 'EXIT') totalExits++;
      reportData.push({
        sno: reportData.length + 1,
        date: rowDate,
        rfid_uid: data[i][3],
        name: data[i][4],
        user_id: data[i][5],
        action: data[i][6],
        status: data[i][7]
      });
    }
  }

  var currentlyInside = 0;
  for (var s = 1; s < statusData.length; s++) {
    if (String(statusData[s][5] || '').toUpperCase() === 'INSIDE') currentlyInside++;
  }

  return createResponse(true, 'Reports retrieved', {
    from_date: fromDate,
    to_date: toDate,
    total_entries: totalEntries,
    total_exits: totalExits,
    total_visits: Object.keys(visits).length,
    currently_inside: currentlyInside,
    data: reportData
  });
}

// ==================== UPDATE USER ====================
function handleUpdateUser(payload) {
  var fast = prefetchSheets([
    { name: SHEET_USERS, range: SHEET_USERS + '!A1:G' },
    { name: SHEET_CURRENT_STATUS, range: SHEET_CURRENT_STATUS + '!A1:F' }
  ]);
  var sheet = null;
  var data;
  if (fast) {
    data = _batch[SHEET_USERS];
  } else {
    sheet = getSheet(SHEET_USERS);
    data = sheet.getDataRange().getValues();
  }

  var rfidUID = String(payload.rfid_uid || '').trim();
  if (!rfidUID) {
    return createResponse(false, 'rfid_uid is required');
  }

  if (payload.status) {
    var wanted = String(payload.status);
    if (wanted !== 'Active' && wanted !== 'Inactive') {
      return createResponse(false, "status must be 'Active' or 'Inactive'");
    }
  }

  var fields = [
    ['name', 2, 128],
    ['user_id', 3, 64],
    ['department', 4, 64],
    ['user_type', 5, 32]
  ];

  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) !== rfidUID) continue;

    var writes = [];
    for (var f = 0; f < fields.length; f++) {
      var key = fields[f][0];
      if (payload[key]) {
        var value = String(payload[key]).trim();
        if (!value || value.length > fields[f][2]) {
          // Flush what was already accepted before returning the error, which
          // is what the original per-cell writes did.
          writeCells(SHEET_USERS, i + 1, writes, sheet);
          return createResponse(false, key + ' must be 1-' + fields[f][2] + ' chars');
        }
        writes.push({ col: fields[f][1], value: value });
      }
    }

    if (payload.status) {
      writes.push({ col: 6, value: String(payload.status) });
    }

    writeCells(SHEET_USERS, i + 1, writes, sheet);

    if (String(payload.status) === 'Inactive') {
      var statusSheet = null;
      var statusData;
      if (fast) {
        statusData = _batch[SHEET_CURRENT_STATUS];
      } else {
        statusSheet = ensureSheet(SHEET_CURRENT_STATUS, HEADER_CURRENT_STATUS);
        statusData = statusSheet.getDataRange().getValues();
      }
      for (var j = 1; j < statusData.length; j++) {
        if (String(statusData[j][0]) === rfidUID) {
          writeCells(SHEET_CURRENT_STATUS, j + 1, [
            { col: 6, value: 'OUTSIDE' }  // F CURRENT_STATUS
          ], statusSheet);
          break;
        }
      }
    }

    return createResponse(true, 'User updated successfully');
  }

  return createResponse(false, 'User not found');
}

// ==================== DELETE USER ====================
function handleDeleteUser(payload) {
  var fast = prefetchSheets([
    { name: SHEET_USERS, range: SHEET_USERS + '!A1:G' },
    { name: SHEET_CURRENT_STATUS, range: SHEET_CURRENT_STATUS + '!A1:F' }
  ]);
  var sheet = null;
  var data;
  if (fast) {
    data = _batch[SHEET_USERS];
  } else {
    sheet = getSheet(SHEET_USERS);
    data = sheet.getDataRange().getValues();
  }

  var rfidUID = String(payload.rfid_uid || '').trim();
  if (!rfidUID) {
    return createResponse(false, 'rfid_uid is required');
  }

  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === rfidUID) {
      (sheet || getSheet(SHEET_USERS)).deleteRow(i + 1);

      var statusSheet = null;
      var statusData;
      if (fast) {
        statusData = _batch[SHEET_CURRENT_STATUS];
      } else {
        statusSheet = ensureSheet(SHEET_CURRENT_STATUS, HEADER_CURRENT_STATUS);
        statusData = statusSheet.getDataRange().getValues();
      }
      for (var j = 1; j < statusData.length; j++) {
        if (String(statusData[j][0]) === rfidUID) {
          (statusSheet || getSheet(SHEET_CURRENT_STATUS)).deleteRow(j + 1);
          break;
        }
      }

      return createResponse(true, 'User deleted successfully');
    }
  }

  return createResponse(false, 'User not found');
}

// ==================== DELETE HISTORY RECORD ====================
// Removes ONE Access_Log row. The client echoes the eight columns it
// rendered; a row is deleted only when every column matches, so a stale
// table can never remove a different record. Exactly one row is deleted
// (the newest match). Two rows with identical content are indistinguishable:
// the newest of the two is removed first. POST only, session token required.
function handleDeleteHistoryRecord(payload) {
  var timestamp = String(payload.timestamp || '').substring(0, 40);
  var date = String(payload.date || '').substring(0, 10);
  var time = String(payload.time || '').substring(0, 10);
  var rfidUID = String(payload.rfid_uid || '').substring(0, 32);
  var name = String(payload.name || '').substring(0, 128);
  var userId = String(payload.user_id || '').substring(0, 32);
  var actionValue = String(payload.action || '').substring(0, 32);
  var status = String(payload.status || '').substring(0, 32);

  // Timestamp + RFID + action identify the record; without them an empty
  // payload could match (and delete) rows of garbage.
  if (!timestamp || !rfidUID || !actionValue) {
    return createResponse(false, 'timestamp, rfid_uid and action are required');
  }

  var fast = prefetchSheets([
    { name: SHEET_ACCESS_LOG, range: SHEET_ACCESS_LOG + '!A1:H' }
  ]);
  var sheet = null;
  var data;
  if (fast) {
    data = _batch[SHEET_ACCESS_LOG];
  } else {
    sheet = ensureSheet(SHEET_ACCESS_LOG, HEADER_ACCESS_LOG);
    data = sheet.getDataRange().getValues();
  }

  // Scan bottom-up (newest first) and require an exact match on all eight
  // columns, using the same text normalisation as handleGetHistory so the
  // values round-trip unchanged from what the table displayed.
  var match = -1;
  for (var i = data.length - 1; i >= 1; i--) {
    if (dateTimeTextFromCell(data[i][0]) !== timestamp) continue;
    if (dateKeyFromCell(data[i][1]) !== date) continue;
    if (timeTextFromCell(data[i][2]) !== time) continue;
    if (String(data[i][3] || '') !== rfidUID) continue;
    if (String(data[i][4] || '') !== name) continue;
    if (String(data[i][5] || '') !== userId) continue;
    if (String(data[i][6] || '') !== actionValue) continue;
    if (String(data[i][7] || '') !== status) continue;
    match = i;
    break;
  }

  if (match < 0) {
    return createResponse(false, 'History record not found (it may have changed)');
  }

  (sheet || getSheet(SHEET_ACCESS_LOG)).deleteRow(match + 1);
  return createResponse(true, 'History record deleted');
}

// ==================== REGISTRATION MODE ====================
function handleEnterRegistrationMode(payload) {
  return createResponse(true, 'Registration mode activated', {
    mode: 'registration',
    instruction: 'Scan RFID card to register'
  });
}

// ==================== RFID REGISTRATION WORKFLOW ====================
function handleStartRFIDRegistration(payload) {
  var fast = prefetchSheets([
    { name: SHEET_REGISTRATION_REQUEST, range: SHEET_REGISTRATION_REQUEST + '!A1:E' }
  ]);
  var sheet = null;
  var data;
  if (fast) {
    data = _batch[SHEET_REGISTRATION_REQUEST];
  } else {
    sheet = getSheet(SHEET_REGISTRATION_REQUEST);
    data = sheet.getDataRange().getValues();
  }

  // Single active request: expire any previous WAITING/DETECTED rows so the
  // web and the ESP32 always agree on which request is live (concurrency).
  for (var i = 1; i < data.length; i++) {
    var oldStatus = String(data[i][1]);
    if (oldStatus === 'WAITING' || oldStatus === 'DETECTED') {
      expireRFIDRow(SHEET_REGISTRATION_REQUEST, i, sheet);
    }
  }

  var baseMs = Date.now();
  var seenIds = {};
  for (var k = 0; k < data.length; k++) {
    seenIds[String(data[k][0])] = true;
  }
  // Unique even if two starts land in the same millisecond.
  var requestId = 'REQ_' + baseMs;
  var bump = 0;
  while (seenIds[requestId]) {
    bump++;
    requestId = 'REQ_' + (baseMs + bump);
  }
  var timestamp = formatISTDateTime();

  appendRowTo(SHEET_REGISTRATION_REQUEST + '!A:E', SHEET_REGISTRATION_REQUEST,
    [requestId, 'WAITING', '', timestamp, timestamp], sheet);
  console.log('[REGISTRATION] request created: ' + requestId);

  return createResponse(true, 'RFID registration started', {
    status: 'WAITING',
    message: 'Waiting for RFID card...',
    request_id: requestId
  });
}

// ESP32 polls this (and the web can too) to discover the oldest live WAITING
// request. Stale rows (older than RFID_REQUEST_TTL_MS) are marked EXPIRED here.
function handleGetPendingRFIDRegistration(payload) {
  var fast = prefetchSheets([
    { name: SHEET_REGISTRATION_REQUEST, range: SHEET_REGISTRATION_REQUEST + '!A1:E' }
  ]);
  var sheet = null;
  var data;
  if (fast) {
    data = _batch[SHEET_REGISTRATION_REQUEST];
  } else {
    sheet = getSheet(SHEET_REGISTRATION_REQUEST);
    data = sheet.getDataRange().getValues();
  }
  var now = Date.now();

  var oldestIdx = -1;
  var oldestMs = 0;

  for (var i = 1; i < data.length; i++) {
    if (String(data[i][1]) !== 'WAITING') continue;

    var createdMs = parseRFIDRequestIdMs(data[i][0]);
    if (createdMs && now - createdMs > RFID_REQUEST_TTL_MS) {
      expireRFIDRow(SHEET_REGISTRATION_REQUEST, i, sheet);
      continue;
    }
    
    if (oldestIdx === -1 || createdMs < oldestMs) {
      oldestIdx = i;
      oldestMs = createdMs;
    }
  }
  
  if (oldestIdx === -1) {
    return createResponse(true, 'No pending registration request', {
      pending: false,
      request_id: ''
    });
  }
  
  console.log('[REGISTRATION] pending served: ' + data[oldestIdx][0]);
  return createResponse(true, 'Pending registration request', {
    pending: true,
    request_id: data[oldestIdx][0],
    status: 'WAITING'
  });
}

function handleGetRFIDRegistrationStatus(payload) {
  var fast = prefetchSheets([
    { name: SHEET_REGISTRATION_REQUEST, range: SHEET_REGISTRATION_REQUEST + '!A1:E' }
  ]);
  var sheet = null;
  var data;
  if (fast) {
    data = _batch[SHEET_REGISTRATION_REQUEST];
  } else {
    sheet = getSheet(SHEET_REGISTRATION_REQUEST);
    data = sheet.getDataRange().getValues();
  }
  var now = Date.now();

  var wantId = payload && payload.request_id ? String(payload.request_id) : '';
  var matchIdx = -1;

  if (wantId) {
    // Exact request only: never fall back to another row's status.
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][0]) === wantId) {
        matchIdx = i;
        break;
      }
    }
  } else {
    // No request_id supplied (legacy caller): newest live row.
    for (var j = data.length - 1; j >= 1; j--) {
      var legacyStatus = String(data[j][1]);
      if (legacyStatus !== 'WAITING' && legacyStatus !== 'DETECTED') continue;
      var legacyMs = parseRFIDRequestIdMs(data[j][0]);
      if (legacyMs && now - legacyMs > RFID_REQUEST_TTL_MS) {
        expireRFIDRow(SHEET_REGISTRATION_REQUEST, j, sheet);
        continue;
      }
      matchIdx = j;
      break;
    }
  }

  if (matchIdx === -1) {
    return createResponse(true, 'Status retrieved', {
      status: 'IDLE',
      request_id: wantId,
      rfid_uid: ''
    });
  }

  var rowStatus = String(data[matchIdx][1]);
  var rowId = String(data[matchIdx][0]);
  var createdMs = parseRFIDRequestIdMs(rowId);

  // Age out abandoned requests so nobody waits on a dead one.
  if ((rowStatus === 'WAITING' || rowStatus === 'DETECTED') &&
      createdMs && now - createdMs > RFID_REQUEST_TTL_MS) {
    expireRFIDRow(SHEET_REGISTRATION_REQUEST, matchIdx, sheet);
    return createResponse(true, 'Status retrieved', {
      status: 'EXPIRED',
      request_id: rowId,
      rfid_uid: ''
    });
  }

  if (rowStatus === 'WAITING') {
    return createResponse(true, 'Status retrieved', {
      status: 'WAITING',
      request_id: rowId,
      rfid_uid: ''
    });
  }

  if (rowStatus === 'DETECTED' && data[matchIdx][2]) {
    // Consume the result so it is reported exactly once.
    writeCells(SHEET_REGISTRATION_REQUEST, matchIdx + 1, [
      { col: 2, value: 'IDLE' }
    ], sheet);
    return createResponse(true, 'RFID detected', {
      status: 'DETECTED',
      request_id: rowId,
      rfid_uid: data[matchIdx][2]
    });
  }
  
  if (rowStatus === 'EXPIRED') {
    return createResponse(true, 'Status retrieved', {
      status: 'EXPIRED',
      request_id: rowId,
      rfid_uid: ''
    });
  }
  
  // IDLE (already consumed) or DETECTED without a UID: nothing left to wait for.
  return createResponse(true, 'Status retrieved', {
    status: rowStatus === 'DETECTED' ? 'EXPIRED' : 'IDLE',
    request_id: rowId,
    rfid_uid: ''
  });
}

function handleRFIDRegistrationResult(payload) {
  var fast = prefetchSheets([
    { name: SHEET_REGISTRATION_REQUEST, range: SHEET_REGISTRATION_REQUEST + '!A1:E' }
  ]);
  var sheet = null;
  var data;
  if (fast) {
    data = _batch[SHEET_REGISTRATION_REQUEST];
  } else {
    sheet = getSheet(SHEET_REGISTRATION_REQUEST);
    data = sheet.getDataRange().getValues();
  }

  var rfidUid = payload.rfid_uid;
  if (!rfidUid) {
    return createResponse(false, 'No RFID UID provided');
  }

  var requestId = payload.request_id ? String(payload.request_id) : '';
  if (!requestId) {
    return createResponse(false, 'request_id is required');
  }

  // Exact row only, and only while it is WAITING — never write to another row.
  var targetRow = -1;
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === requestId &&
        String(data[i][1]) === 'WAITING') {
      targetRow = i;
      break;
    }
  }

  if (targetRow === -1) {
    console.log('[REGISTRATION] result rejected: ' + requestId + ' uid=' + rfidUid);
    return createResponse(false, 'No WAITING registration request for request_id: ' + requestId);
  }

  writeCells(SHEET_REGISTRATION_REQUEST, targetRow + 1, [
    { col: 2, value: 'DETECTED' },
    { col: 3, value: rfidUid },
    { col: 5, value: formatISTDateTime() }
  ], sheet);

  console.log('[REGISTRATION] result stored: ' + requestId + ' uid=' + rfidUid);

  return createResponse(true, 'RFID registration result recorded', {
    status: 'DETECTED',
    request_id: requestId,
    rfid_uid: rfidUid
  });
}

// ==================== EXPORT EXCEL ====================
function handleExportExcel(payload) {
  var fast = prefetchSheets([
    { name: SHEET_ACCESS_LOG, range: SHEET_ACCESS_LOG + '!A1:H' },
    { name: SHEET_USERS, range: SHEET_USERS + '!A1:G' }
  ]);
  var data;
  var usersData;
  if (fast) {
    data = _batch[SHEET_ACCESS_LOG];
    usersData = _batch[SHEET_USERS];
  } else {
    var sheet = ensureSheet(SHEET_ACCESS_LOG, HEADER_ACCESS_LOG);
    data = sheet.getDataRange().getValues();
    var usersSheet = getSheet(SHEET_USERS);
    usersData = usersSheet.getDataRange().getValues();
  }

  var fromDate = String(payload.from_date || formatISTDate(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)));
  var toDate = String(payload.to_date || formatISTDate());

  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) {
    fromDate = formatISTDate(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(toDate)) {
    toDate = formatISTDate();
  }
  if (fromDate > toDate) {
    var swap = fromDate;
    fromDate = toDate;
    toDate = swap;
  }

  var exportData = [];
  var sno = 1;

  // First matching user row wins, exactly like the inner loop's break.
  var userByRfid = new Map();
  for (var j = 1; j < usersData.length; j++) {
    if (!userByRfid.has(usersData[j][0])) {
      userByRfid.set(usersData[j][0], [usersData[j][3], usersData[j][4]]);
    }
  }

  for (var i = 1; i < data.length; i++) {
    var rowDate = dateKeyFromCell(data[i][1]);
    if (rowDate >= fromDate && rowDate <= toDate) {
      var department = '';
      var userType = '';
      var userInfo = userByRfid.get(data[i][3]);
      if (userInfo) {
        department = userInfo[0];
        userType = userInfo[1];
      }

      exportData.push({
        sno: sno++,
        date: rowDate,
        rfid_uid: data[i][3],
        name: data[i][4],
        user_id: data[i][5],
        department: department,
        user_type: userType,
        action: data[i][6],
        status: data[i][7]
      });
    }
  }

  return createResponse(true, 'Export data ready', {
    from_date: fromDate,
    to_date: toDate,
    data: exportData
  });
}

// ==================== INITIALIZE SPREADSHEET ====================
function initializeSpreadsheet() {
  var ss = getSpreadsheet();
  
  var usersSheet = ss.getSheetByName(SHEET_USERS);
  if (!usersSheet) {
    usersSheet = ss.insertSheet(SHEET_USERS);
    usersSheet.appendRow(['RFID_UID', 'NAME', 'USER_ID', 'DEPARTMENT', 'USER_TYPE', 'STATUS', 'REGISTRATION_DATE']);
  }
  
  var logSheet = ss.getSheetByName(SHEET_ACCESS_LOG);
  if (!logSheet) {
    logSheet = ss.insertSheet(SHEET_ACCESS_LOG);
    logSheet.appendRow(HEADER_ACCESS_LOG);
  }
  
  var statusSheet = ss.getSheetByName(SHEET_CURRENT_STATUS);
  if (!statusSheet) {
    statusSheet = ss.insertSheet(SHEET_CURRENT_STATUS);
    statusSheet.appendRow(HEADER_CURRENT_STATUS);
  } else {
    upgradeCurrentStatusSheet(statusSheet);
  }
  
  var adminSheet = ss.getSheetByName(SHEET_ADMIN_ACCOUNTS);
  if (!adminSheet) {
    adminSheet = ss.insertSheet(SHEET_ADMIN_ACCOUNTS);
    adminSheet.appendRow(['FULL_NAME', 'USERNAME', 'PASSWORD_HASH', 'CREATED_AT']);
  }
  
  var regSheet = ss.getSheetByName(SHEET_REGISTRATION_REQUEST);
  if (!regSheet) {
    regSheet = ss.insertSheet(SHEET_REGISTRATION_REQUEST);
    regSheet.appendRow(['REQUEST_ID', 'STATUS', 'RFID_UID', 'CREATED_AT', 'UPDATED_AT']);
  }
  
  return 'Spreadsheet initialized successfully';
}

// Upgrades a legacy 5-column Current_status sheet (CURRENT_STATUS in column
// E) to the 6-column layout: E becomes EXIT_TIME and the stored status text
// moves to F. Safe to run repeatedly - a sheet that already has the
// 6-column header is left untouched. Called from initializeSpreadsheet().
function upgradeCurrentStatusSheet(statusSheet) {
  if (statusSheet.getLastRow() < 1) return;

  var header = statusSheet.getRange(1, 1, 1, 6).getValues()[0];
  if (String(header[4]).trim() !== 'CURRENT_STATUS' ||
      String(header[5]).trim() !== '') {
    return;  // already the 6-column layout
  }

  statusSheet.getRange(1, 5).setValue('EXIT_TIME');
  statusSheet.getRange(1, 6).setValue('CURRENT_STATUS');

  var lastRow = statusSheet.getLastRow();
  if (lastRow < 2) return;

  var legacy = statusSheet.getRange(2, 5, lastRow - 1, 1).getValues();
  var shifted = [];
  for (var r = 0; r < legacy.length; r++) {
    shifted.push([legacy[r][0]]);
  }
  statusSheet.getRange(2, 6, lastRow - 1, 1).setValues(shifted);
  statusSheet.getRange(2, 5, lastRow - 1, 1).clearContent();
}
