// Prints a before/after comparison of two profile runs.
//
//   node tests/perf/compare.mjs [baseline.json] [after.json]
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const a = JSON.parse(readFileSync(path.join(dir, args[0] || 'baseline.json'), 'utf8'));
const b = JSON.parse(readFileSync(path.join(dir, args[1] || 'after.json'), 'utf8'));

function ms(v) { return v === null || v === undefined ? 'n/a' : `${Math.round(v)} ms`; }
function pct(before, after) {
  if (before === null || after === null || before === undefined || after === undefined || !before) return '';
  const d = ((after - before) / before) * 100;
  return ` (${d > 0 ? '+' : ''}${d.toFixed(0)}%)`;
}
function row(label, before, after, fmt = v => String(v)) {
  console.log(`  ${label.padEnd(34)} ${fmt(before).padStart(9)}  ->  ${fmt(after).padStart(9)}${typeof before === 'number' && typeof after === 'number' ? pct(before, after) : ''}`);
}

const sa = a.scenario, sb = b.scenario;
console.log(`\n== ${a.label}  vs  ${b.label} ==\n`);

console.log('A. cold load (login screen)');
row('TTFB', sa.initialLoad.ttfb, sb.initialLoad.ttfb, ms);
row('first contentful paint', sa.initialLoad.fcp, sb.initialLoad.fcp, ms);
row('DOM content loaded', sa.initialLoad.dcl, sb.initialLoad.dcl, ms);
row('load event', sa.initialLoad.load, sb.initialLoad.load, ms);
row('API requests', sa.initialLoad.requests.length, sb.initialLoad.requests.length);

console.log('\nB. authenticated dashboard');
row('app shell visible', sa.dashboard.shellAt, sb.dashboard.shellAt, ms);
row('statistics filled in', sa.dashboard.statsAt, sb.dashboard.statsAt, ms);
row('device status filled in', sa.dashboard.deviceStatusAt, sb.dashboard.deviceStatusAt, ms);
row('header status settled', sa.dashboard.headerAt, sb.dashboard.headerAt, ms);

console.log('\nC. page switching (sync / data)');
for (const key of Object.keys(sa.pageSwitch)) {
  const x = sa.pageSwitch[key], y = sb.pageSwitch[key];
  if (!y) continue;
  row(`${key} sync`, x.syncMs, y.syncMs, ms);
  row(`${key} data`, x.dataMs, y.dataMs, ms);
  console.log(`  ${''.padEnd(34)} ${String(x.requests.join(',') || '0').padStart(9)}  ->  ${String(y.requests.join(',') || '0').padStart(9)}`);
}

console.log('\nD. users');
row('rows', sa.users.rows, sb.users.rows);
row('re-toggle API requests', sa.users.retoggleRequests, sb.users.retoggleRequests);

console.log('\nE. history (4 keystrokes)');
row('UI update', sa.history.uiUpdateMs, sb.history.uiUpdateMs, ms);
console.log(`  ${''.padEnd(34)} ${sa.history.requests.join(',') || '0'}  ->  ${sb.history.requests.join(',') || '0'}`);

console.log('\nF. idle 31 s on the dashboard');
row('refresh ticks counted', sa.idle30sOnDashboard.ticks, sb.idle30sOnDashboard.ticks);
row('total requests', sa.idle30sOnDashboard.total, sb.idle30sOnDashboard.total);
console.log(`  ${''.padEnd(34)} ${sa.idle30sOnDashboard.requests.join(', ')}`);
console.log(`  ${''.padEnd(34)} ${sb.idle30sOnDashboard.requests.join(', ')}`);

console.log('\nG. Google outage (30 s window)');
row('error shown after', sa.outage.errorShownAfterMs, sb.outage.errorShownAfterMs, ms);
row('Apps Script requests', sa.outage.gasRequests, sb.outage.gasRequests);
for (const key of Object.keys(sa.outage.ui)) {
  const before = sa.outage.ui[key], after = sb.outage.ui[key];
  console.log(`  ${key.padEnd(34)} ${String(before).padStart(9)}  ->  ${String(after).padStart(9)}${before === after ? '' : '   <-- changed'}`);
}

console.log('\nH. JavaScript');
row('main thread: page switches', sa.javascript.mainThreadPageSwitchMs, sb.javascript.mainThreadPageSwitchMs, ms);
row('main thread: whole session', sa.javascript.mainThreadSessionMs, sb.javascript.mainThreadSessionMs, ms);
row('render 100 history rows', sa.javascript.render100RowsMs, sb.javascript.render100RowsMs, ms);
row('escapeHtml x5000', sa.javascript.escapeHtml5kMs, sb.javascript.escapeHtml5kMs, ms);
row('JS heap used', sa.javascript.heapUsedBytes, sb.javascript.heapUsedBytes, v => `${Math.round(v / 1024)} KB`);

console.log('\nI. files (raw / gzip)');
for (const file of Object.keys(a.assets)) {
  const x = a.assets[file], y = b.assets[file];
  if (!y) continue;
  console.log(`  ${file.padEnd(14)} ${String(x.bytes).padStart(7)} / ${String(x.gzip).padStart(6)}  ->  ${String(y.bytes).padStart(7)} / ${String(y.gzip).padStart(6)} bytes`);
}

console.log('\nJ. overlapping identical in-flight requests (whole session)');
const API_ACTIONS = new Set([
  'get_dashboard_data', 'device_status', 'get_users', 'get_current_inside',
  'get_history', 'get_reports', 'register_user', 'login'
]);
function overlaps(r, apiOnly) {
  return Object.entries(r.maxConcurrent || {})
    .filter(([k, v]) => v > 1 && (!apiOnly || API_ACTIONS.has(k)))
    .map(([k, v]) => `${k} x${v}`);
}
for (const [name, run] of [[a.label, a], [b.label, b]]) {
  console.log(`  ${name} API:  ${overlaps(run, true).join(', ') || 'none'}`);
  console.log(`  ${name} static: ${overlaps(run, false).filter(x => !API_ACTIONS.has(x.split(' x')[0])).join(', ') || 'none'}`);
}
