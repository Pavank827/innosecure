// Static checks for the InnoSecure website (no browser required).
//
//   node tests/static-checks.mjs
//
// Guards the things a runtime test cannot see: syntax, HTML/JS wiring,
// secrets in shipped code, HTTPS-only references, and the behavioural
// constants that must not drift (10 s refresh, 400 ms filter debounce).
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.join(ROOT, 'website');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ` -> ${detail}`}`);
}

function walk(dir) {
  return readdirSync(dir).flatMap(name => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const files = walk(SITE);
const appJs = readFileSync(path.join(SITE, 'app.js'), 'utf8');
const indexHtml = readFileSync(path.join(SITE, 'index.html'), 'utf8');
const stylesCss = readFileSync(path.join(SITE, 'styles.css'), 'utf8');

// ------------------------------------------------- 1. syntax
check('app.js parses as a classic script', (() => {
  try { new vm.Script(appJs, { filename: 'app.js' }); return true; }
  catch (error) { return error.message; }
})());

for (const file of [
  ...files.filter(f => f.endsWith('.mjs')),
  ...readdirSync(path.join(ROOT, 'tests')).filter(f => f.endsWith('.mjs')).map(f => path.join(ROOT, 'tests', f)),
  ...readdirSync(path.join(ROOT, 'tests', 'harness')).filter(f => f.endsWith('.mjs')).map(f => path.join(ROOT, 'tests', 'harness', f)),
  ...readdirSync(path.join(ROOT, 'tests', 'perf')).filter(f => f.endsWith('.mjs')).map(f => path.join(ROOT, 'tests', 'perf', f))
]) {
  const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  check(`parses: ${path.relative(ROOT, file)}`, res.status === 0, res.stderr.trim());
}

// ------------------------------------------------- 2. inline handler wiring
const handlerRe = /\son(?:click|change|input|submit|keyup|keydown|load)\s*=\s*"([^"]*)"/g;
const missingHandlers = [];
let match;
while ((match = handlerRe.exec(indexHtml))) {
  const calls = [...match[1].matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)].map(m => m[1]);
  for (const fn of calls) {
    if (['event', 'true', 'false'].includes(fn)) continue;
    if (!new RegExp(`function\\s+${fn}\\s*\\(`).test(appJs)) missingHandlers.push(fn);
  }
}
check('every inline HTML handler exists in app.js',
  missingHandlers.length === 0, `missing: ${[...new Set(missingHandlers)].join(', ')}`);

// --------------------------------------------- 3. element ids referenced by JS
const idRefs = new Set();
for (const re of [/getElementById\(\s*'([^'$]+)'\s*\)/g, /\$\(\s*'([^'$]+)'\s*\)/g]) {
  let m;
  while ((m = re.exec(appJs))) idRefs.add(m[1]);
}
const htmlIds = new Set([...indexHtml.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));
const missingIds = [...idRefs].filter(id => !htmlIds.has(id));
check('every element id referenced from app.js exists in index.html',
  missingIds.length === 0, `missing: ${missingIds.join(', ')}`);

// ------------------------------------------------------- 4. no secrets shipped
const secretPatterns = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
  [/\bAIza[0-9A-Za-z_-]{30,}\b/, 'Google API key'],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/, 'secret key'],
  [/\bBearer\s+[A-Za-z0-9._-]{20,}\b/, 'bearer token'],
  [/['"][A-Za-z0-9+/]{40,}={0,2}['"]\s*(;|\n|$)/, 'long base64 blob']
];
const secrets = [];
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  for (const [re, label] of secretPatterns) {
    if (re.test(text)) secrets.push(`${path.basename(file)}: ${label}`);
  }
}
check('no secrets in shipped website files', secrets.length === 0, secrets.join('; '));
check('no .env / key files in website/',
  !files.some(f => /(^|[\\/])(\.env|.*\.pem|.*\.key)$/i.test(f)));

// ----------------------------------------------- 5. HTTPS-only, no blocking CSS
const insecure = [];
for (const file of files) {
  if (!/\.(html|js|css)$/.test(file)) continue;
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/http:\/\/[^\s"')]+/g)) {
    if (!m[0].includes('www.w3.org')) insecure.push(`${path.basename(file)}: ${m[0]}`);
  }
}
check('no insecure http:// references', insecure.length === 0, insecure.join('; '));

check('Google Fonts CSS is not render-blocking',
  !/<link href="https:\/\/fonts\.googleapis\.com[^>]*rel="stylesheet"/.test(indexHtml) &&
  /rel="preload" as="style"/.test(indexHtml));

const remoteStyles = [...indexHtml.matchAll(/<link[^>]*rel="stylesheet"[^>]*https?:\/\/[^>]*>/g)]
  .map(m => m[0])
  .filter(tag => !tag.includes('styles.css'));
check('remote stylesheet links exist only in the <noscript> fallback',
  remoteStyles.length === 1 && indexHtml.includes(`<noscript>${remoteStyles[0]}</noscript>`),
  remoteStyles.join('; '));

check('app.js is loaded with defer', /<script src="app\.js" defer><\/script>/.test(indexHtml));

// -------------------------------------------------- 6. behavioural constants
check('refresh interval is still 10 s', /const REFRESH_INTERVAL = 10000;/.test(appJs));
check('filter debounce is still 400 ms', /const FILTER_DEBOUNCE_MS = 400;/.test(appJs));
check('auth token stays in sessionStorage (not localStorage)',
  /sessionStorage\.setItem\('authToken'/.test(appJs) &&
  !/localStorage\.setItem\('authToken'/.test(appJs));
check('auto refresh is skipped while the tab is hidden', /if \(document\.hidden\) return;/.test(appJs));
check('overlapping refreshes are refused', /if \(refreshInFlight\) return;/.test(appJs));

// ------------------------------------------------------------- 7. dead code
const dead = ['saveAdminAccounts', 'escapeAttrJs'].filter(fn => appJs.includes(fn));
check('no known dead functions left behind', dead.length === 0, dead.join(', '));

// ----------------------------------------------------------- 8. CSS sanity
const open = (stylesCss.match(/\{/g) || []).length;
const close = (stylesCss.match(/\}/g) || []).length;
check('styles.css braces are balanced', open === close, `${open} vs ${close}`);
check('loading placeholders have a reduced-motion fallback',
  /prefers-reduced-motion: reduce/.test(stylesCss));

// -------------------------------------------------------------- 9. summary
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} static checks passed`);
if (failed.length) {
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail || ''}`);
  process.exitCode = 1;
}
if (!existsSync(path.join(SITE, '404.html'))) {
  console.log('note: website/404.html missing');
}
