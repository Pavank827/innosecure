// In-memory Apps Script + Sheets REST shim used by the golden equivalence
// test and the performance bench. It models the two value shapes the real
// backend sees:
//   - getDataRange().getValues()  -> rectangular rows, date/time cells as Date
//     objects (epoch = true IST instant, local fields = IST wall clock)
//   - values:batchGet UNFORMATTED -> rectangular rows, date/time cells as
//     Sheets serial numbers (days since 1899-12-30)
// Everything written goes through USER_ENTERED parsing (date/time-looking
// strings become serial cells), matching what the probe measured on the live
// spreadsheet.

import crypto from 'node:crypto';
import vm from 'node:vm';

const IST_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 86400000;
const EPOCH_1899 = Date.UTC(1899, 11, 30);

export const FROZEN_NOW_MS = Date.UTC(2026, 9, 8, 5, 0, 0);  // 2026-10-08 10:30:00 IST

export function makeClock(initialMs = FROZEN_NOW_MS) {
  return { now: initialMs };
}

// local getters answer with IST wall-clock fields (the script project's
// timezone), regardless of the machine timezone running the test.
export function makeFakeDateClass(clock) {
  class FakeDate extends Date {
    constructor(...args) {
      if (args.length === 0) super(clock.now);
      else if (args.length === 1) super(args[0]);
      else {
        const [y, mo = 0, d = 1, h = 0, mi = 0, s = 0, ms = 0] = args;
        super(Date.UTC(y, mo, d, h, mi, s, ms) - IST_MS);
      }
    }
    static now() { return clock.now; }
    _ist() { return new Date(this.getTime() + IST_MS); }
    getHours() { return this._ist().getUTCHours(); }
    getMinutes() { return this._ist().getUTCMinutes(); }
    getSeconds() { return this._ist().getUTCSeconds(); }
    getMilliseconds() { return this._ist().getUTCMilliseconds(); }
    getFullYear() { return this._ist().getUTCFullYear(); }
    getMonth() { return this._ist().getUTCMonth(); }
    getDate() { return this._ist().getUTCDate(); }
    getDay() { return this._ist().getUTCDay(); }
    getTimezoneOffset() { return -330; }
  }
  return FakeDate;
}

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2} \d{1,2}:\d{2}:\d{2}$/;
const TIME_ONLY_RE = /^\d{1,2}:\d{2}:\d{2}$/;

function wallSerial(str) {
  let m;
  if ((m = DATE_ONLY_RE.exec(str))) {
    return (Date.UTC(+str.slice(0, 4), +str.slice(5, 7) - 1, +str.slice(8, 10)) - EPOCH_1899) / DAY_MS;
  }
  if ((m = /^(\d{4})-(\d{2})-(\d{2}) \d{1,2}:\d{2}:\d{2}$/.exec(str))) {
    const [h, mi, s] = str.slice(11).split(':').map(Number);
    return (Date.UTC(+m[1], +m[2] - 1, +m[3], h, mi, s) - EPOCH_1899) / DAY_MS;
  }
  if ((m = TIME_ONLY_RE.exec(str))) {
    const [h, mi, s] = str.split(':').map(Number);
    return (h * 3600 + mi * 60 + s) / 86400;
  }
  return null;
}

// USER_ENTERED: date/time-looking text becomes a date cell, everything else
// (including numeric RFID text) stays as typed.
export function userEntered(v) {
  if (v === null || v === undefined) return '';
  if (typeof v !== 'string') return v;
  if (v === '') return '';
  if (DATE_ONLY_RE.test(v) || DATE_TIME_RE.test(v) || TIME_ONLY_RE.test(v)) {
    const ser = wallSerial(v);
    if (ser !== null) return { d: ser };
  }
  return v;
}

export function serial(y, m, d, h = 0, mi = 0, s = 0) {
  return (Date.UTC(y, m - 1, d, h, mi, s) - EPOCH_1899) / DAY_MS;
}

export function timeSerial(h, mi, s) {
  return (h * 3600 + mi * 60 + s) / 86400;
}

export function cellModel(v) {
  if (typeof v === 'string' && (DATE_ONLY_RE.test(v) || DATE_TIME_RE.test(v) || TIME_ONLY_RE.test(v))) {
    return { d: wallSerial(v) };
  }
  return v;
}

function hasContent(v) {
  return v !== undefined && v !== null && v !== '';
}

function normalizeCellForBatch(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'object' && typeof v.d === 'number') return v.d;
  return v;
}

function normalizeCellForValues(v, FakeDate) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'object' && typeof v.d === 'number') {
    return new FakeDate(Math.round(EPOCH_1899 + v.d * DAY_MS - IST_MS));
  }
  return v;
}

function parseA1(range) {
  // 'Users!A1:G' | 'Users!A:H' | 'Users!B5'
  const bang = range.indexOf('!');
  if (bang < 0) return null;
  const sheetName = range.slice(0, bang);
  const body = range.slice(bang + 1);
  const parts = body.split(':');
  const start = /^([A-Z]+)(\d+)?$/.exec(parts[0]);
  if (!start) return null;
  const colLetter = start[1];
  const startCol = colLetter.split('').reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
  const startRow = start[2] ? Number(start[2]) : 1;
  let endCol = startCol;
  let endRow = startRow;
  if (parts.length === 2) {
    const end = /^([A-Z]+)(\d+)?$/.exec(parts[1]);
    if (!end) return null;
    const ec = end[1].split('').reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
    endCol = ec;
    endRow = end[2] ? Number(end[2]) : Infinity;
  }
  return { sheetName, startRow, startCol, endRow, endCol };
}

export function createBackend({ state, FakeDate, fail = new Set(), counters }) {
  const calls = counters || {
    openById: 0, getValues: 0, setValue: 0, clearContent: 0, appendRow: 0,
    deleteRow: 0, getLastRow: 0, insertSheet: 0,
    batchGet: 0, restAppend: 0, restBatchUpdate: 0
  };

  function sheetRows(name) {
    return Object.prototype.hasOwnProperty.call(state.sheets, name) ? state.sheets[name].rows : null;
  }

  function usedDims(rows) {
    let lastRow = 0;
    let lastCol = 0;
    for (let r = 0; r < rows.length; r++) {
      for (let c = 0; c < rows[r].length; c++) {
        if (hasContent(rows[r][c])) {
          if (r + 1 > lastRow) lastRow = r + 1;
          if (c + 1 > lastCol) lastCol = c + 1;
        }
      }
    }
    return { h: Math.max(lastRow, 1), w: Math.max(lastCol, 1) };
  }

  function makeRange(name, row, col, height, width) {
    return {
      getValues() {
        calls.getValues++;
        const rows = sheetRows(name);
        const dims = rows ? usedDims(rows) : { h: 1, w: 1 };
        const h = height || dims.h - (row - 1);
        const w = width || dims.w - (col - 1);
        const out = [];
        for (let r = 0; r < Math.max(h, 1); r++) {
          const line = [];
          for (let c = 0; c < Math.max(w, 1); c++) {
            const src = rows ? (rows[row - 1 + r] || [])[col - 1 + c] : undefined;
            line.push(normalizeCellForValues(src, FakeDate));
          }
          out.push(line);
        }
        return out;
      },
      setValue(v) {
        calls.setValue++;
        const rows = sheetRows(name);
        if (rows) {
          while (rows.length < row) rows.push([]);
          if (!rows[row - 1]) rows[row - 1] = [];
          rows[row - 1][col - 1] = userEntered(v);
        }
        return this;
      },
      clearContent() {
        calls.clearContent++;
        const rows = sheetRows(name);
        if (rows && rows[row - 1]) rows[row - 1][col - 1] = '';
        return this;
      }
    };
  }

  function makeSheet(name) {
    return {
      getName: () => name,
      getDataRange() {
        const rows = sheetRows(name);
        const dims = rows ? usedDims(rows) : { h: 1, w: 1 };
        return makeRange(name, 1, 1, dims.h, dims.w);
      },
      getRange(row, col, height, width) {
        return makeRange(name, row, col, height, width);
      },
      appendRow(values) {
        calls.appendRow++;
        const rows = sheetRows(name);
        if (rows) rows.push(values.map(userEntered));
        return this;
      },
      deleteRow(index) {
        calls.deleteRow++;
        const rows = sheetRows(name);
        if (rows) rows.splice(index - 1, 1);
        return this;
      },
      getLastRow() {
        calls.getLastRow++;
        const rows = sheetRows(name);
        if (!rows) return 0;
        return usedDims(rows).h;
      },
      insertRowsAfter() { return this; },
      clear() { return this; }
    };
  }

  const spreadsheet = {
    getSheetByName(name) {
      return sheetRows(name) ? makeSheet(name) : null;
    },
    insertSheet(name) {
      calls.insertSheet++;
      state.sheets[name] = { rows: [] };
      return makeSheet(name);
    },
    getName: () => 'SPREADSHEET'
  };

  const SpreadsheetApp = {
    openById(id) {
      calls.openById++;
      return spreadsheet;
    },
    getActiveSpreadsheet: () => spreadsheet
  };

  function jsonResponse(code, body) {
    return {
      getResponseCode: () => code,
      getContentText: () => body
    };
  }

  function batchGet(url) {
    calls.batchGet++;
    if (fail.has('batchGet')) return jsonResponse(500, JSON.stringify({ error: 'injected failure' }));
    const query = url.split('?')[1] || '';
    const ranges = query.split('&')
      .filter(p => p.startsWith('ranges='))
      .map(p => decodeURIComponent(p.slice('ranges='.length)));
    const valueRanges = [];
    for (const range of ranges) {
      const parsed = parseA1(range);
      const rows = parsed ? sheetRows(parsed.sheetName) : null;
      if (!parsed || !rows) {
        return jsonResponse(400, JSON.stringify({ error: { code: 400, message: 'Unable to parse range' } }));
      }
      const out = [];
      const maxRow = Math.min(rows.length, parsed.endRow === Infinity ? rows.length : parsed.endRow);
      for (let r = parsed.startRow - 1; r < maxRow; r++) {
        const line = [];
        for (let c = parsed.startCol; c <= parsed.endCol; c++) {
          line.push(normalizeCellForBatch((rows[r] || [])[c]));
        }
        while (line.length && line[line.length - 1] === null) line.pop();
        out.push(line);
      }
      while (out.length && out[out.length - 1].length === 0) out.pop();
      valueRanges.push({ range, values: out });
    }
    return jsonResponse(200, JSON.stringify({ valueRanges }));
  }

  function restAppend(url, params) {
    calls.restAppend++;
    if (fail.has('append')) return jsonResponse(500, JSON.stringify({ error: 'injected failure' }));
    const m = /\/values\/([^:]+):append\?/.exec(url);
    const parsed = m ? parseA1(decodeURIComponent(m[1])) : null;
    const rows = parsed ? sheetRows(parsed.sheetName) : null;
    if (!parsed || !rows) {
      return jsonResponse(400, JSON.stringify({ error: { code: 400, message: 'Unable to parse range' } }));
    }
    const body = JSON.parse(params.payload);
    for (const row of body.values || []) rows.push(row.map(userEntered));
    return jsonResponse(200, JSON.stringify({ updates: { updatedRows: (body.values || []).length } }));
  }

  function restBatchUpdate(url, params) {
    calls.restBatchUpdate++;
    if (fail.has('batchUpdate')) return jsonResponse(500, JSON.stringify({ error: 'injected failure' }));
    const body = JSON.parse(params.payload);
    const data = body.data || [];
    const staged = [];
    for (const item of data) {
      const parsed = parseA1(item.range);
      const rows = parsed ? sheetRows(parsed.sheetName) : null;
      if (!parsed || !rows || parsed.startRow < 1 || parsed.endRow !== parsed.startRow) {
        return jsonResponse(400, JSON.stringify({ error: { code: 400, message: 'Invalid range' } }));
      }
      staged.push({ rows, row: parsed.startRow - 1, col: parsed.startCol, values: (item.values || [])[0] || [] });
    }
    for (const s of staged) {
      while (s.rows.length <= s.row) s.rows.push([]);
      if (!s.rows[s.row]) s.rows[s.row] = [];
      for (let i = 0; i < s.values.length; i++) {
        s.rows[s.row][s.col + i] = userEntered(s.values[i]);
      }
    }
    return jsonResponse(200, JSON.stringify({ responses: data.map(() => ({})) }));
  }

  const UrlFetchApp = {
    fetch(url, params) {
      const u = String(url);
      if (u.includes('values:batchGet')) return batchGet(u);
      if (u.includes(':append')) return restAppend(u, params || {});
      if (u.endsWith('/values:batchUpdate')) return restBatchUpdate(u, params || {});
      return jsonResponse(404, JSON.stringify({ error: 'unknown endpoint' }));
    }
  };

  const propsStore = new Map([['AUTH_SECRET', 'equivalence-test-secret-0123456789']]);
  let uuidCounter = 0;
  const properties = {
    getProperty: k => (propsStore.has(k) ? propsStore.get(k) : null),
    setProperty: (k, v) => { propsStore.set(k, String(v)); return properties; }
  };

  const Utilities = {
    getUuid() {
      uuidCounter += 1;
      return '00000000-0000-4000-8000-' + String(uuidCounter).padStart(12, '0');
    },
    computeDigest(alg, text) {
      return Array.from(crypto.createHash('sha256').update(String(text), 'utf8').digest());
    },
    DigestAlgorithm: { SHA_256: 'SHA_256' },
    Charset: { UTF_8: 'UTF_8' },
    sleep: () => {}
  };

  const logs = [];

  return {
    calls,
    logs,
    SpreadsheetApp,
    UrlFetchApp,
    ScriptApp: { getOAuthToken: () => 'test-oauth-token' },
    PropertiesService: { getScriptProperties: () => properties },
    Utilities,
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput(text) {
        const out = {
          getContent: () => text,
          setMimeType: () => out
        };
        return out;
      }
    },
    console: {
      log: (...a) => logs.push(a.map(String).join(' ')),
      warn: (...a) => logs.push(a.map(String).join(' ')),
      error: (...a) => logs.push(a.map(String).join(' '))
    }
  };
}

export function runScript(code, filename, globals, FakeDate) {
  const sandbox = { ...globals, Date: FakeDate };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename });
  return sandbox;
}

export function deepCloneState(state) {
  return {
    sheets: Object.fromEntries(
      Object.entries(state.sheets).map(([name, sheet]) => [
        name,
        { rows: sheet.rows.map(row => row.map(cell => (cell && typeof cell === 'object' && typeof cell.d === 'number' ? { d: cell.d } : cell))) }
      ])
    )
  };
}

// Order-insensitive structural equality across vm boundaries.
export function stable(value) {
  if (value === undefined) return '__undefined__';
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(stable);
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = stable(value[key]);
  return out;
}

export function show(value) {
  return JSON.stringify(stable(value), null, 1);
}
