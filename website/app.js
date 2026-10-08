// ==================== CONFIGURATION ====================
const API_URL = 'https://script.google.com/macros/s/AKfycbxgofza5uMuvmm-nEFbi4EQWT_SGYDVLOLh8xbJ12C-bpvoW3JGI9it5WN9-RhKWTn6-g/exec';
// Cloudflare Worker: device liveness only (no API key required for action=device_status).
const EDGE_API_URL = 'https://makerspace-rfid-edge-api.makerspace-rfid-edge-api.workers.dev/';
const REFRESH_INTERVAL = 10000;
const FILTER_DEBOUNCE_MS = 400;
const DEMO_MODE = false;

// Cache policy (milliseconds). Only data that has not changed since the last
// fetch may be reused; the 10-second auto refresh still runs on its own timer.
const NAV_CACHE_TTL_MS = 8000;          // re-entering a page within 8 s reuses data
const USERS_REFRESH_TTL_MS = 10000;     // users list at most once per refresh tick
const REPORT_CACHE_TTL_MS = 25000;      // reports change slowly, cache a little longer
const USERS_DUPLICATE_TTL_MS = 30000;   // local duplicate-User-ID check window
const DASHBOARD_CACHE_TTL_MS = 300000;  // last-known stats for an instant first paint

// Circuit breaker for a failing host: after a failed attempt chain, further
// calls fail fast instead of hammering the endpoint (Google outage behaviour).
const API_MAX_ATTEMPTS = 3;
const API_RETRY_DELAY_MS = 600;
const HOST_COOLDOWN_MS = [15000, 30000, 45000, 60000];

// ==================== STATE ====================
let currentPage = 'dashboard';
let refreshTimer = null;
let refreshInFlight = false;
let isAuthenticated = false;
let authToken = null;
let registrationUID = '';
let activeUsersTab = 'register';
let usersData = [];
let currentInsideData = [];
let historyData = [];
let reportData = [];
let dashboardStatsSeq = 0;
let deviceSeq = 0;
let usersSeq = 0;
let insideSeq = 0;
let historySeq = 0;
let reportSeq = 0;
let historyDebounceTimer = null;
let reportRangeInitialised = false;

// Last known payloads. They are only used to paint immediately; every screen
// still revalidates with the backend and shows a real error state on failure.
let lastDashboardData = null;
let lastSyncValue = '';
let sheetsState = 'pending';   // 'pending' | 'ok' | 'error'
let edgeState = 'pending';     // 'pending' | 'ok' | 'error'
let edgeStatusValue = null;
let usersLoaded = false;
let usersLoadedAt = 0;

// ==================== MICRO-OPTIMISATIONS ====================
const domRefs = new Map();
const pageEls = new Map();
const navEls = new Map();
const inflightRequests = new Map();
const responseCache = new Map();
const hostHealth = new Map();

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Element lookup is one of the hottest paths (tables, status, refresh loop).
function $(id) {
  let el = domRefs.get(id);
  if (el === undefined) {
    el = document.getElementById(id);
    if (el) domRefs.set(id, el);
  }
  return el;
}

function setText(id, value) {
  const el = $(id);
  if (el && el.textContent !== value) el.textContent = value;
}

function setHTML(el, html) {
  if (el && el.__renderedHtml !== html) {
    el.__renderedHtml = html;
    el.innerHTML = html;
  }
}

function setLoading(id, loading) {
  const el = $(id);
  if (el) el.classList.toggle('loading', !!loading);
}

// Escapes without touching the DOM: the previous implementation created a
// <div> for every value, which dominated table render time.
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/[&<>"']/g, ch => HTML_ESCAPES[ch]);
}

// Safe CSS class fragment for a value that comes from the backend/sheet.
function slug(value) {
  if (value === null || value === undefined) return '';
  return String(value).toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
}

function formatTime(timestamp) {
  if (!timestamp) return '--';
  const parts = timestamp.split(' ');
  if (parts.length >= 2) {
    return parts[1];
  }
  return timestamp;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ==================== INITIALIZATION ====================
document.addEventListener('DOMContentLoaded', () => {
  checkAuth();
  setupEventListeners();
});

function checkAuth() {
  const token = sessionStorage.getItem('authToken');
  if (token) {
    isAuthenticated = true;
    authToken = token;
    showMainApp();
  }
}

function setupEventListeners() {
  $('loginForm').addEventListener('submit', handleLogin);
  $('createAccountForm').addEventListener('submit', handleCreateAccount);
  // One delegated listener instead of an inline handler per table row.
  $('usersTableBody').addEventListener('click', handleUsersTableClick);
  window.addEventListener('online', renderSystemStatus);
  window.addEventListener('offline', renderSystemStatus);
  document.addEventListener('visibilitychange', () => {
    // Refresh only while the tab is visible; refresh immediately on return.
    if (!document.hidden && isAuthenticated) refreshNow();
  });
}

function handleUsersTableClick(event) {
  const button = event.target.closest('[data-user-action]');
  if (!button || !$('usersTableBody').contains(button)) return;
  const rfidUid = button.getAttribute('data-rfid');
  if (button.getAttribute('data-user-action') === 'edit') {
    editUser(rfidUid);
  } else {
    toggleUserStatus(rfidUid, button.getAttribute('data-status'));
  }
}

// ==================== SCREEN NAVIGATION ====================
function showLogin() {
  $('loginScreen').style.display = 'flex';
  $('createAccountScreen').style.display = 'none';
  $('loginError').style.display = 'none';
  $('createAccountForm').reset();
  $('createAccountError').style.display = 'none';
  $('createAccountSuccess').style.display = 'none';
}

function showCreateAccount() {
  $('loginScreen').style.display = 'none';
  $('createAccountScreen').style.display = 'flex';
  $('loginError').style.display = 'none';
}

// Open the account form from inside the app (header "Add Admin" button).
// The session token is still in memory there, which the backend requires
// for create_admin_account once at least one account exists.
function showCreateAccountForSession() {
  $('mainApp').style.display = 'none';
  $('loginScreen').style.display = 'none';
  $('createAccountScreen').style.display = 'flex';
  $('createAccountError').style.display = 'none';
  $('createAccountSuccess').style.display = 'none';
  $('createAccountForm').reset();
}

// Leave the account form: back to the app when logged in, otherwise to login.
function closeCreateAccount() {
  $('createAccountScreen').style.display = 'none';
  if (isAuthenticated) {
    showMainApp();
  } else {
    showLogin();
  }
}

// ==================== ADMIN ACCOUNT MANAGEMENT ====================
function getAdminAccounts() {
  const accounts = localStorage.getItem('innosecure_admin_accounts');
  return accounts ? JSON.parse(accounts) : [];
}

function hashPassword(password) {
  let hash = 0;
  for (let i = 0; i < password.length; i++) {
    const char = password.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return 'h_' + Math.abs(hash).toString(36);
}

async function handleCreateAccount(e) {
  e.preventDefault();

  const fullName = $('createFullName').value.trim();
  const username = $('createUsername').value.trim();
  const password = $('createPassword').value;
  const confirmPassword = $('createConfirmPassword').value;

  const errorEl = $('createAccountError');
  const successEl = $('createAccountSuccess');

  errorEl.style.display = 'none';
  successEl.style.display = 'none';

  // Check required fields
  if (!fullName || !username || !password || !confirmPassword) {
    errorEl.textContent = 'Please fill in all fields';
    errorEl.style.display = 'block';
    return;
  }

  // Check password match
  if (password !== confirmPassword) {
    errorEl.textContent = 'Passwords do not match';
    errorEl.style.display = 'block';
    return;
  }

  // Check password length
  if (password.length < 4) {
    errorEl.textContent = 'Password must be at least 4 characters';
    errorEl.style.display = 'block';
    return;
  }

  try {
    const response = await apiCall('create_admin_account', {
      fullName: fullName,
      username: username,
      password: password
    });

    if (response.success) {
      successEl.textContent = 'Admin account created successfully.';
      successEl.style.display = 'block';

      $('createAccountForm').reset();

      setTimeout(() => {
        closeCreateAccount();
      }, 2000);

    } else {
      let message = response.message || 'Account creation failed.';
      if (message.indexOf('Authentication required') === 0) {
        // The backend closes self-signup as soon as one admin exists, so this
        // screen only works for the very first account.
        message = 'Admin account creation is locked now that an admin account exists. ' +
          'Sign in with an existing account and use "Add Admin" in the header instead.';
      }
      errorEl.textContent = message;
      errorEl.style.display = 'block';
    }

  } catch (error) {
    console.error('Create account error:', error);

    errorEl.textContent = 'Connection failed. Please try again.';
    errorEl.style.display = 'block';
  }
}
// ==================== AUTHENTICATION ====================
async function handleLogin(e) {
  e.preventDefault();
  const username = $('loginUsername').value;
  const password = $('loginPassword').value;
  const errorEl = $('loginError');

  errorEl.style.display = 'none';

  if (DEMO_MODE) {
    const accounts = getAdminAccounts();

    if (accounts.length === 0) {
      errorEl.textContent = 'No admin account found. Please create an admin account.';
      errorEl.style.display = 'block';
      return;
    }

    const account = accounts.find(
      a => a.username.toLowerCase() === username.toLowerCase() && a.passwordHash === hashPassword(password)
    );

    if (account) {
      isAuthenticated = true;
      authToken = 'demo_token';
      sessionStorage.setItem('authToken', authToken);
      sessionStorage.setItem('adminUser', account.username);
      showMainApp();
      return;
    }

    errorEl.textContent = 'Invalid username or password.';
    errorEl.style.display = 'block';
    return;
  }

  try {
    const response = await apiCall('login', { username, password });
    if (response.success) {
      isAuthenticated = true;
      authToken = response.data.token;
      sessionStorage.setItem('authToken', authToken);
      sessionStorage.setItem('adminUser', username);
      showMainApp();
    } else {
      errorEl.textContent = response.message || 'Invalid username or password.';
      errorEl.style.display = 'block';
    }
  } catch (error) {
    errorEl.textContent = 'Connection failed. Please try again.';
    errorEl.style.display = 'block';
  }
}

function logout() {
  isAuthenticated = false;
  authToken = null;
  sessionStorage.removeItem('authToken');
  sessionStorage.removeItem('adminUser');
  $('loginScreen').style.display = 'flex';
  $('createAccountScreen').style.display = 'none';
  $('mainApp').style.display = 'none';
  $('loginUsername').value = '';
  $('loginPassword').value = '';
  $('loginError').style.display = 'none';
  if (refreshTimer) clearInterval(refreshTimer);
}

function showMainApp() {
  $('loginScreen').style.display = 'none';
  $('mainApp').style.display = 'flex';
  if (!lastDashboardData) lastDashboardData = readDashboardCache();
  startAutoRefresh();
  loadDashboard();
}

// ==================== API CALLS ====================
// Google's redirect target (script.googleusercontent.com/macros/echo) intermittently
// answers 404/5xx. Without a retry a single blip surfaces as "Connection failed".

function hostOf(url) {
  try { return new URL(url).origin; } catch (error) { return url; }
}

function hostAllowsRequest(url) {
  const health = hostHealth.get(hostOf(url));
  return !health || Date.now() >= health.openUntil;
}

function hostRecordFailure(url) {
  const key = hostOf(url);
  const health = hostHealth.get(key) || { fails: 0, openUntil: 0 };
  health.fails += 1;
  const index = Math.min(health.fails - 1, HOST_COOLDOWN_MS.length - 1);
  health.openUntil = Date.now() + HOST_COOLDOWN_MS[index];
  hostHealth.set(key, health);
}

function hostRecordSuccess(url) {
  hostHealth.delete(hostOf(url));
}

function hostIsSick(url) {
  const health = hostHealth.get(hostOf(url));
  return !!health && health.fails > 0;
}

async function fetchJSON(url, options = {}, attemptsOverride) {
  // Circuit open: fail immediately instead of adding traffic to a dead host.
  if (!hostAllowsRequest(url)) {
    const cooldownError = new Error('Host is cooling down after repeated failures');
    cooldownError.cooldown = true;
    throw cooldownError;
  }

  // While the host is recovering, probe with a single request; healthy hosts
  // keep the full transient-blip retry chain.
  const attempts = attemptsOverride || (hostIsSick(url) ? 1 : API_MAX_ATTEMPTS);
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, options);
      if (!response.ok) throw new Error('HTTP error ' + response.status);

      const json = await response.json();
      hostRecordSuccess(url);
      return json;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await sleep(API_RETRY_DELAY_MS * attempt);
      }
    }
  }

  hostRecordFailure(url);
  console.error('API Error:', lastError);
  throw lastError;
}

// Same endpoint requested twice at the same time shares one request.
function singleFlight(key, task) {
  const existing = inflightRequests.get(key);
  if (existing) return existing;
  const promise = Promise.resolve()
    .then(task)
    .finally(() => {
      if (inflightRequests.get(key) === promise) inflightRequests.delete(key);
    });
  inflightRequests.set(key, promise);
  return promise;
}

function cacheRead(key) {
  const entry = responseCache.get(key);
  return entry || null;
}

function cacheWrite(key, value) {
  responseCache.set(key, { value: value, ts: Date.now() });
}

function cacheIsFresh(key, minAge) {
  const entry = cacheRead(key);
  return !!entry && (Date.now() - entry.ts) < minAge;
}

async function apiCall(action, data = {}) {
  if (DEMO_MODE) {
    return getDemoData(action, data);
  }

  // Session token is attached to every POST: the backend requires it for
  // mutating actions (update_user, delete_user, export_excel,
  // create_admin_account) as soon as an admin account exists.
  const payload = authToken ? { ...data, auth_token: authToken } : data;

  const json = await fetchJSON(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action, data: payload })
  });

  if (json && json.success === false &&
      typeof json.message === 'string' &&
      json.message.indexOf('Authentication required') === 0) {
    if (authToken) {
      // Token expired or was rejected: force a fresh login instead of letting
      // every subsequent action fail silently.
      logout();
      showToast('Session expired. Please log in again.', 'error');
      // Flag it so the caller does not overwrite the message above.
      return Object.assign({}, json, { session_expired: true });
    }
    // No session at all (e.g. the login-screen account form): let the caller
    // show the backend message instead of claiming a session expired.
    return json;
  }

  return json;
}

async function apiGet(action, params = {}) {
  if (DEMO_MODE) {
    return getDemoData(action, params);
  }

  const key = `GET ${action} ${JSON.stringify(params)}`;
  return singleFlight(key, () => {
    const queryString = new URLSearchParams({ action, ...params }).toString();
    return fetchJSON(`${API_URL}?${queryString}`);
  });
}

// ==================== NAVIGATION ====================
function allPageEls() {
  if (!pageEls.has('all')) pageEls.set('all', document.querySelectorAll('.page'));
  return pageEls.get('all');
}

function pageEl(page) {
  if (!pageEls.has(page)) pageEls.set(page, document.getElementById(`page-${page}`));
  return pageEls.get(page);
}

function navEl(page) {
  if (!navEls.has(page)) navEls.set(page, document.querySelector(`.nav-item[data-page="${page}"]`));
  return navEls.get(page);
}

function navigateTo(page) {
  currentPage = page;

  allPageEls().forEach(p => p.classList.remove('active'));
  const target = pageEl(page);
  if (target) target.classList.add('active');

  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const nav = navEl(page);
  if (nav) nav.classList.add('active');

  loadPageData(page, false);
}

function toggleSidebar() {
  $('sidebar').classList.toggle('open');
}

// Fetches only what the visible page needs. The periodic refresh passes
// isRefreshTick=true so live pages always ask for fresh data while static
// pages (reports, users) reuse a recent response.
function loadPageData(page, isRefreshTick) {
  let task;
  switch (page) {
    case 'dashboard': task = loadDashboard({ minAge: isRefreshTick ? 0 : NAV_CACHE_TTL_MS }); break;
    case 'users': task = refreshUsersTab(isRefreshTick); break;
    case 'inside': task = loadCurrentInside({ minAge: isRefreshTick ? 0 : NAV_CACHE_TTL_MS }); break;
    case 'history': task = loadHistory({ minAge: isRefreshTick ? 0 : NAV_CACHE_TTL_MS }); break;
    case 'reports':
      ensureReportDateRange();
      task = loadReport({ minAge: REPORT_CACHE_TTL_MS });
      break;
  }
  return Promise.resolve(task).catch(error => console.error('Page data load failed:', error));
}

// ==================== AUTO REFRESH ====================
function startAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(refreshNow, REFRESH_INTERVAL);
}

// One refresh at a time: Apps Script calls can take several seconds, and a
// 10 s timer would otherwise pile new requests on top of unfinished ones.
function refreshNow() {
  if (refreshInFlight) return;
  // Nothing to refresh while the tab is hidden; visibilitychange refreshes
  // immediately when the user comes back.
  if (document.hidden) return;
  refreshInFlight = true;
  loadPageData(currentPage, true).finally(() => {
    refreshInFlight = false;
  });
}

// ==================== DASHBOARD ====================
// Dashboard state comes from two independent sources:
//   - Apps Script (statistics, latest scan, last sync)
//   - Cloudflare Worker action=device_status (real ESP32 last-seen heartbeat)
// Apps Script returns a HARDCODED system_status, so it is never used here.
// They are fetched and rendered independently: a slow or failing Google never
// blocks the device card, and the page shell paints before either answers.
function loadDashboard(options = {}) {
  const minAge = options.minAge === undefined ? NAV_CACHE_TTL_MS : options.minAge;
  return Promise.allSettled([
    loadDashboardStats({ minAge }),
    loadDeviceStatus({ minAge })
  ]);
}

async function loadDashboardStats(options = {}) {
  const minAge = options.minAge === undefined ? NAV_CACHE_TTL_MS : options.minAge;
  const seq = ++dashboardStatsSeq;

  // Paint the last known numbers immediately, then replace with live data.
  const cached = cacheRead('dashboardStats');
  if (cached) {
    lastDashboardData = cached.value;
    lastSyncValue = lastDashboardData.last_sync || '';
  }
  if (lastDashboardData) renderDashboardStats(lastDashboardData);

  // Revalidated within 8 s of the previous success: no extra Apps Script call.
  if (!options.force && cached && (Date.now() - cached.ts) < minAge) {
    if (seq === dashboardStatsSeq) renderSystemStatus();
    return;
  }

  try {
    const response = await apiGet('get_dashboard_data');
    if (seq !== dashboardStatsSeq) return;

    if (response && response.success) {
      sheetsState = 'ok';
      lastDashboardData = response.data || {};
      lastSyncValue = lastDashboardData.last_sync || '';
      cacheWrite('dashboardStats', lastDashboardData);
      writeDashboardCache(lastDashboardData);
      renderDashboardStats(lastDashboardData);
    } else {
      sheetsState = 'error';
      responseCache.delete('dashboardStats');
      renderDashboardError('Backend returned an error: ' + ((response && response.message) || 'unknown'));
    }
  } catch (error) {
    if (seq !== dashboardStatsSeq) return;
    sheetsState = 'error';
    // A failed call invalidates the entry: a later navigation must not paint
    // numbers the backend has not confirmed since the failure.
    responseCache.delete('dashboardStats');
    renderDashboardError('Could not reach the backend (Google Apps Script). Retrying…');
  }

  if (seq === dashboardStatsSeq) renderSystemStatus();
}

// Device status is read-only and public on the Worker, so no API key is sent.
function fetchEdgeDeviceStatus(attempts) {
  // Same guarantee as apiGet: two overlapping loads share one heartbeat call.
  return singleFlight('GET device_status', async () => {
    const json = await fetchJSON(`${EDGE_API_URL}?action=device_status`, {
      headers: { 'Accept': 'application/json' }
    }, attempts);
    if (!json.success || !json.data) throw new Error(json.message || 'device_status failed');
    return json.data;
  });
}

async function loadDeviceStatus(options = {}) {
  const minAge = options.minAge === undefined ? NAV_CACHE_TTL_MS : options.minAge;
  const seq = ++deviceSeq;

  // The heartbeat payload carries its own last-seen timestamp, so reusing a
  // reply that is seconds old still shows an honest age.
  const cached = cacheRead('deviceStatus');
  if (cached && (Date.now() - cached.ts) < minAge) {
    edgeStatusValue = cached.value;
    edgeState = 'ok';
    if (seq === deviceSeq) renderSystemStatus();
    return;
  }

  try {
    // No retry chain here: the Worker answers in milliseconds and a failed
    // heartbeat should surface as UNKNOWN right away.
    edgeStatusValue = await fetchEdgeDeviceStatus(1);
    edgeState = 'ok';
    cacheWrite('deviceStatus', edgeStatusValue);
  } catch (error) {
    edgeStatusValue = null;
    edgeState = 'error';
    // Do not let an earlier success mask a failed heartbeat.
    responseCache.delete('deviceStatus');
  }
  if (seq !== deviceSeq) return;
  renderSystemStatus();
}

function buildSystemStatus() {
  let esp32 = 'UNKNOWN';
  let rfid = 'UNKNOWN';
  let lastSeen = null;

  if (edgeState === 'pending') {
    esp32 = 'CHECKING';
    rfid = 'CHECKING';
  } else if (edgeState === 'error') {
    esp32 = 'UNKNOWN';
    rfid = 'UNKNOWN';
  } else if (edgeStatusValue) {
    lastSeen = edgeStatusValue;
    if (edgeStatusValue.state === 'ONLINE') {
      esp32 = 'ONLINE';
      rfid = 'READY';
    } else if (edgeStatusValue.state === 'OFFLINE') {
      esp32 = 'OFFLINE';
      rfid = 'NOT READY';
    } else if (edgeStatusValue.state === 'NEVER_SEEN') {
      esp32 = 'NEVER SEEN';
      rfid = 'UNKNOWN';
    }
  }

  return {
    esp32: esp32,
    rfid: rfid,
    internet: navigator.onLine ? 'CONNECTED' : 'DISCONNECTED',
    google_sheets: sheetsState === 'ok' ? 'SYNCED' : sheetsState === 'error' ? 'ERROR' : 'CHECKING',
    last_seen: lastSeen
  };
}

function renderSystemStatus() {
  updateSystemStatus(buildSystemStatus(), lastSyncValue, lastSeenLabel(edgeStatusValue));
}

function lastSeenLabel(edgeStatus) {
  if (!edgeStatus || !edgeStatus.last_seen) return '--';
  const ageMs = Date.now() - Date.parse(edgeStatus.last_seen);
  const ageText = Number.isFinite(ageMs) && ageMs >= 0
    ? (ageMs < 60000 ? Math.round(ageMs / 1000) + 's ago' : Math.round(ageMs / 60000) + 'm ago')
    : '';
  return `${formatTime(edgeStatus.last_seen_ist)}${ageText ? ' (' + ageText + ')' : ''}`;
}

function renderDashboardStats(data) {
  setText('statRegistered', String(data.registered_users || 0));
  setText('statInside', String(data.currently_inside || 0));
  setText('statEntries', String(data.today_entries || 0));
  setText('statExits', String(data.today_exits || 0));
  ['statRegistered', 'statInside', 'statEntries', 'statExits'].forEach(setLoadingDone);

  const activityEl = $('latestActivity');
  if (data.latest_scan) {
    const scan = data.latest_scan;
    const scanAction = String(scan.action || '').toUpperCase();
    const activityHTML = `
      <div class="activity-item">
        <div class="activity-icon ${slug(scanAction)}">
          ${scanAction === 'ENTRY' ?
            '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"></polyline></svg>' :
            '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 18 13.5 8.5 8.5 13.5 1 6"></polyline></svg>'
          }
        </div>
        <div class="activity-info">
          <div class="activity-name">${escapeHtml(scan.name)}</div>
          <div class="activity-detail">${escapeHtml(scan.action)} &bull; ${escapeHtml(scan.rfid_uid)}</div>
        </div>
        <div class="activity-time">${escapeHtml(formatTime(scan.timestamp))}</div>
      </div>
    `;
    setHTML(activityEl, activityHTML);
  } else {
    setHTML(activityEl, `
      <div class="empty-state">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
          <circle cx="12" cy="12" r="10"></circle>
          <polyline points="12 6 12 12 16 14"></polyline>
        </svg>
        <p>No recent activity</p>
      </div>
    `);
  }
}

function setLoadingDone(id) {
  setLoading(id, false);
}

function renderDashboardError(message) {
  ['statRegistered', 'statInside', 'statEntries', 'statExits'].forEach(id => {
    setText(id, '--');
    setLoadingDone(id);
  });
  setHTML($('latestActivity'), `<div class="empty-state"><p>${escapeHtml(message)}</p></div>`);
}

const STATUS_ONLINE_VALUES = ['ONLINE', 'READY', 'CONNECTED', 'SYNCED'];
const STATUS_UNKNOWN_VALUES = ['UNKNOWN', 'CHECKING', 'NEVER SEEN', 'DEGRADED'];

function statusDotClass(value) {
  const v = String(value || '').toUpperCase();
  if (STATUS_ONLINE_VALUES.includes(v)) return 'online';
  if (STATUS_UNKNOWN_VALUES.includes(v)) return 'warning';
  return 'offline';
}

function headerStatusText(status) {
  if (status.internet === 'DISCONNECTED') return { text: 'No Internet', cls: 'offline' };
  if (status.google_sheets === 'ERROR') return { text: 'Backend Unreachable', cls: 'offline' };
  // The backend has not answered yet: never claim the system is online.
  if (status.google_sheets === 'CHECKING') return { text: 'Checking…', cls: 'warning' };
  if (status.esp32 === 'OFFLINE') return { text: 'Device Offline', cls: 'offline' };
  if (status.esp32 === 'NEVER SEEN') return { text: 'Device Never Seen', cls: 'warning' };
  if (status.esp32 === 'UNKNOWN') return { text: 'Device Unknown', cls: 'warning' };
  return { text: 'System Online', cls: 'online' };
}

function updateSystemStatus(status, lastSync, lastSeen) {
  const statusMap = {
    'statusESP32': status.esp32,
    'statusRFID': status.rfid,
    'statusInternet': status.internet,
    'statusSheets': status.google_sheets
  };

  for (const [id, value] of Object.entries(statusMap)) {
    const el = $(id);
    if (el) {
      setHTML(el, `<span class="status-dot ${statusDotClass(value)}"></span> ${escapeHtml(value)}`);
      setLoading(id, value === 'CHECKING');
    }
  }

  setText('deviceLastSeen', lastSeen || '--');

  if (lastSync) {
    setText('lastSyncTime', formatTime(lastSync));
  }

  const headerDot = $('systemStatusDot');
  const headerText = $('systemStatusText');
  if (headerDot && headerText) {
    const header = headerStatusText(status);
    if (headerDot.className !== 'status-dot ' + header.cls) headerDot.className = 'status-dot ' + header.cls;
    setText('systemStatusText', header.text);
  }
}

// ==================== TABLE MESSAGES ====================
function setTableMessage(tbodyId, message, colspan) {
  const tbody = $(tbodyId);
  if (!tbody) return;
  setHTML(tbody, `<tr><td colspan="${colspan}" class="empty-cell">${escapeHtml(message)}</td></tr>`);
}

// ==================== USERS ====================
async function loadUsers(options = {}) {
  const minAge = options.minAge === undefined ? NAV_CACHE_TTL_MS : options.minAge;
  const cached = cacheRead('users');

  // Show what we already have first so switching tabs feels instant.
  if (cached && (usersLoaded || Array.isArray(cached.value))) {
    usersData = cached.value;
    usersLoaded = true;
    usersLoadedAt = cached.ts;
    renderCurrentUsersView();
  }

  if (!options.force && cached && (Date.now() - cached.ts) < minAge) return;

  const seq = ++usersSeq;
  try {
    const response = await apiGet('get_users');
    if (seq !== usersSeq) return;

    if (!response.success) {
      setTableMessage('usersTableBody', 'Could not load users: ' + (response.message || 'unknown error'), 8);
      return;
    }

    usersData = response.data.users || [];
    usersLoaded = true;
    usersLoadedAt = Date.now();
    cacheWrite('users', usersData);
    renderCurrentUsersView();
  } catch (error) {
    if (seq !== usersSeq) return;
    console.error('Users load error:', error);
    setTableMessage('usersTableBody', 'Could not reach the backend to load users. Retrying…', 8);
  }
}

function renderCurrentUsersView() {
  const searchEl = $('userSearch');
  const query = searchEl ? searchEl.value.toLowerCase().trim() : '';
  if (!query) {
    renderUsersTable(usersData);
    return;
  }
  renderUsersTable(filterUserRows(usersData, query), 'No matching users');
}

function filterUserRows(users, query) {
  return users.filter(user =>
    user.name.toLowerCase().includes(query) ||
    user.user_id.toLowerCase().includes(query) ||
    user.rfid_uid.toLowerCase().includes(query) ||
    user.department.toLowerCase().includes(query)
  );
}

function renderUsersTable(users, emptyMessage) {
  const tbody = $('usersTableBody');

  if (users.length === 0) {
    setHTML(tbody, `<tr><td colspan="8" class="empty-cell">${escapeHtml(emptyMessage || 'No users registered')}</td></tr>`);
    return;
  }

  setHTML(tbody, users.map(user => `
    <tr>
      <td><strong>${escapeHtml(user.name)}</strong></td>
      <td>${escapeHtml(user.user_id)}</td>
      <td><code>${escapeHtml(user.rfid_uid)}</code></td>
      <td>${escapeHtml(user.department)}</td>
      <td>${escapeHtml(user.user_type)}</td>
      <td><span class="badge badge-${slug(user.status)}">${escapeHtml(user.status)}</span></td>
      <td><span class="badge badge-${slug(user.current_status)}">${escapeHtml(user.current_status)}</span></td>
      <td>
        <div style="display:flex;gap:4px;">
          <button type="button" class="btn-icon" data-user-action="edit" data-rfid="${escapeHtml(user.rfid_uid)}" title="Edit">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"></path>
              <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"></path>
            </svg>
          </button>
          <button type="button" class="btn-icon" data-user-action="toggle" data-rfid="${escapeHtml(user.rfid_uid)}" data-status="${escapeHtml(user.status)}" title="${user.status === 'Active' ? 'Deactivate' : 'Activate'}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              ${user.status === 'Active' ?
                '<path d="M18.36 6.64a9 9 0 11-12.73 0M12 2v10"></path>' :
                '<path d="M22 11.08V12a10 10 0 11-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline>'
              }
            </svg>
          </button>
        </div>
      </td>
    </tr>
  `).join(''));
}

function filterUsers() {
  renderCurrentUsersView();
}

// ==================== USERS TAB NAVIGATION ====================
function switchUsersTab(tab) {
  activeUsersTab = tab;
  const tabRegistered = $('tabRegisteredUsers');
  const tabRegister = $('tabRegisterUser');
  const panelRegistered = $('usersPanelRegistered');
  const panelRegister = $('usersPanelRegister');

  if (tab === 'registered') {
    tabRegistered.classList.add('active');
    tabRegister.classList.remove('active');
    panelRegistered.style.display = 'block';
    panelRegister.style.display = 'none';
    loadUsers();
  } else {
    tabRegistered.classList.remove('active');
    tabRegister.classList.add('active');
    panelRegistered.style.display = 'none';
    panelRegister.style.display = 'block';
  }
}

// Auto-refresh for the Users page: refresh ONLY the registered-users list.
// Never touches the registration form, so typed values and a scanned RFID UID survive.
function refreshUsersTab(isRefreshTick) {
  if (activeUsersTab === 'registered') {
    return loadUsers({ minAge: isRefreshTick ? USERS_REFRESH_TTL_MS : NAV_CACHE_TTL_MS });
  }
}

function resetRegisterForm() {
  $('registerUserForm').reset();
  $('regUserRFID').value = '';
  $('rfidScanStatus').style.display = 'none';
  $('btnReadRFID').disabled = false;
  $('btnRegisterUser').disabled = true;
  registrationUID = '';
}

// ==================== RFID SCAN WORKFLOW ====================
let rfidPollTimer = null;

async function startRFIDScan() {
  const btn = $('btnReadRFID');
  const statusEl = $('rfidScanStatus');
  const rfidField = $('regUserRFID');

  btn.disabled = true;
  btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0110 0v4"></path></svg> SCANNING...';

  statusEl.textContent = 'Waiting for RFID card... Place the RFID card near the reader.';
  statusEl.className = 'rfid-scan-status waiting';
  statusEl.style.display = 'block';

  rfidField.value = '';
  registrationUID = '';
  $('btnRegisterUser').disabled = true;

  try {
    // Apps Script occasionally answers HTTP 200 with success:false while it is
    // under load. Retry the start so one transient backend error does not
    // abort the scan; a persistent failure still shows the same message.
    let response = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      response = await apiCall('start_rfid_registration', {});
      if (response.success) break;
      if (attempt < 3) await sleep(1000 * attempt);
    }

    if (response.success) {
      const startRequestId = response.data && response.data.request_id
        ? response.data.request_id
        : '';
      console.log('[REGISTRATION] start:', startRequestId || '(no request_id)');
      pollRFIDResult(startRequestId);
    } else {
      showRFIDError('Failed to start RFID scan. Please try again.');
    }
  } catch (error) {
    showRFIDError('Connection error. Please try again.');
  }
}

function pollRFIDResult(requestId) {
  if (rfidPollTimer) clearTimeout(rfidPollTimer);

  let attempts = 0;
  const maxAttempts = 30;
  const deadline = Date.now() + 60000;
  let consecutiveErrors = 0;

  const poll = async () => {
    attempts++;

    if (attempts > maxAttempts || Date.now() >= deadline) {
      showRFIDError('RFID scan timed out. Please try again.');
      return;
    }

    try {
      const response = await apiGet(
        'get_rfid_registration_status',
        requestId ? { request_id: requestId } : {}
      );
      consecutiveErrors = 0;
      console.log('[REGISTRATION] poll:', JSON.stringify(response.data || response));

      if (response.success && response.data) {
        if (response.data.status === 'DETECTED' && response.data.rfid_uid) {
          handleRFIDDetected(response.data.rfid_uid);
          return;
        } else if (response.data.status === 'TIMEOUT' || response.data.status === 'EXPIRED') {
          showRFIDError('RFID scan timed out. Please try again.');
          return;
        }
      }
    } catch (error) {
      // One exhausted retry chain must not kill the scan; only stop after
      // several failures in a row, so a transient 404 keeps polling.
      consecutiveErrors++;
      if (consecutiveErrors >= 3) {
        showRFIDError('Connection error. Please try again.');
        return;
      }
    }

    rfidPollTimer = setTimeout(poll, 1000);
  };

  poll();
}

function handleRFIDDetected(uid) {
  const btn = $('btnReadRFID');
  const statusEl = $('rfidScanStatus');
  const rfidField = $('regUserRFID');

  uid = (uid || '').trim();
  if (!uid) return;

  registrationUID = uid;
  rfidField.value = uid;

  statusEl.textContent = 'RFID detected successfully';
  statusEl.className = 'rfid-scan-status success';

  btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg> RFID SCANNED';
  btn.disabled = false;

  $('btnRegisterUser').disabled = false;
}

function showRFIDError(message) {
  const btn = $('btnReadRFID');
  const statusEl = $('rfidScanStatus');

  statusEl.textContent = message;
  statusEl.className = 'rfid-scan-status error';

  btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0110 0v4"></path></svg> READ RFID';
  btn.disabled = false;
}

// ==================== REGISTER USER ====================
async function submitRegisterUser(e) {
  e.preventDefault();

  const name = $('regUserName').value.trim();
  const userId = $('regUserUserId').value.trim();
  const department = $('regUserDept').value.trim();
  const userType = $('regUserType').value;
  const rfidUid = registrationUID;

  if (!name) {
    showToast('Please enter a name', 'error');
    return;
  }

  if (!userId) {
    showToast('Please enter a User ID', 'error');
    return;
  }

  if (!rfidUid) {
    showToast('Please scan an RFID card first', 'error');
    return;
  }

  if (!department) {
    showToast('Please enter a department', 'error');
    return;
  }

  const userData = {
    rfid_uid: rfidUid,
    name: name,
    user_id: userId,
    department: department,
    user_type: userType
  };

  try {
    // The backend de-duplicates RFID cards only, so a duplicate User ID would
    // silently create a second account with the same identity. Check first:
    // a recently loaded full user list answers this without a network round
    // trip, otherwise the list is fetched as before.
    let existingUsers = null;
    const duplicateCacheFresh = usersLoaded && usersData.length > 0 &&
      (Date.now() - usersLoadedAt) < USERS_DUPLICATE_TTL_MS;

    if (duplicateCacheFresh) {
      existingUsers = usersData;
    } else {
      const usersResponse = await apiGet('get_users');
      if (usersResponse && usersResponse.success && Array.isArray(usersResponse.data.users)) {
        existingUsers = usersResponse.data.users;
        usersData = existingUsers;
        usersLoaded = true;
        usersLoadedAt = Date.now();
        cacheWrite('users', usersData);
      }
    }

    if (existingUsers) {
      const duplicateUserId = existingUsers.find(
        u => String(u.user_id || '').toLowerCase() === userId.toLowerCase()
      );
      if (duplicateUserId) {
        showToast(`User ID ${userId} is already registered to ${duplicateUserId.name}`, 'error');
        return;
      }
      const duplicateRfid = existingUsers.find(
        u => String(u.rfid_uid || '').toLowerCase() === rfidUid.toLowerCase()
      );
      if (duplicateRfid) {
        showToast(`RFID card is already registered to ${duplicateRfid.name}`, 'error');
        return;
      }
    }

    const response = await apiCall('register_user', userData);
    if (response.success) {
      showToast('User registered successfully', 'success');
      // Update the local list immediately, then confirm with the backend.
      usersData = usersData.concat([{
        rfid_uid: rfidUid,
        name: name,
        user_id: userId,
        department: department,
        user_type: userType,
        status: 'Active',
        current_status: 'OUTSIDE'
      }]);
      usersLoaded = true;
      usersLoadedAt = Date.now();
      cacheWrite('users', usersData);
      resetRegisterForm();
      switchUsersTab('registered');
      loadUsers({ force: true });
    } else {
      if (response.session_expired) return;
      showToast(response.message || 'Registration failed', 'error');
    }
  } catch (error) {
    showToast('Connection error. Please try again.', 'error');
  }
}

// ==================== CURRENTLY INSIDE ====================
async function loadCurrentInside(options = {}) {
  const minAge = options.minAge === undefined ? NAV_CACHE_TTL_MS : options.minAge;
  const cacheKey = 'inside';
  const cached = cacheRead(cacheKey);

  if (cached) {
    currentInsideData = cached.value.users;
    setText('insideCount', String(cached.value.count || 0));
    renderInsideTable(currentInsideData);
  }
  if (!options.force && cached && (Date.now() - cached.ts) < minAge) return;

  const seq = ++insideSeq;
  try {
    const response = await apiGet('get_current_inside');
    if (seq !== insideSeq) return;

    if (!response.success) {
      setText('insideCount', '--');
      setTableMessage('insideTableBody', 'Could not load data: ' + (response.message || 'unknown error'), 6);
      return;
    }

    currentInsideData = response.data.users || [];
    const payload = { count: response.data.count || 0, users: currentInsideData };
    cacheWrite(cacheKey, payload);
    setText('insideCount', String(response.data.count || 0));
    renderInsideTable(currentInsideData);
  } catch (error) {
    if (seq !== insideSeq) return;
    console.error('Inside load error:', error);
    setText('insideCount', '--');
    setTableMessage('insideTableBody', 'Could not reach the backend to load data. Retrying…', 6);
  }
}

function renderInsideTable(users) {
  const tbody = $('insideTableBody');

  if (users.length === 0) {
    setHTML(tbody, '<tr><td colspan="6" class="empty-cell">No users currently inside</td></tr>');
    return;
  }

  setHTML(tbody, users.map(user => `
    <tr>
      <td><strong>${escapeHtml(user.name)}</strong></td>
      <td>${escapeHtml(user.user_id)}</td>
      <td>${escapeHtml(user.department)}</td>
      <td>${escapeHtml(user.entry_time)}</td>
      <td>${escapeHtml(user.duration)}</td>
      <td><span class="badge badge-inside">INSIDE</span></td>
    </tr>
  `).join(''));
}

// ==================== HISTORY ====================
// Debounced so typing in a filter box does not fire one request per keystroke.
function scheduleHistoryLoad() {
  previewHistoryLocally();
  if (historyDebounceTimer) clearTimeout(historyDebounceTimer);
  historyDebounceTimer = setTimeout(() => loadHistory(), FILTER_DEBOUNCE_MS);
}

// Instant feedback while the debounced authoritative request is on its way.
// Only narrows the rows already on screen, and never paints an empty result
// the backend has not confirmed yet.
function previewHistoryLocally() {
  if (!historyData || historyData.length === 0) return;
  const params = readHistoryFilters();
  if (params.filter_date) return;
  const rows = filterHistoryRows(historyData, params);
  if (rows.length > 0) renderHistoryTable(rows);
}

function filterHistoryRows(records, params) {
  const name = (params.filter_name || '').toLowerCase();
  const rfid = (params.filter_rfid || '').toLowerCase();
  const action = (params.filter_action || '').toUpperCase();
  return records.filter(record =>
    (!name || String(record.name).toLowerCase().includes(name)) &&
    (!rfid || String(record.rfid_uid).toLowerCase().includes(rfid)) &&
    (!action || String(record.action).toUpperCase() === action)
  );
}

function readHistoryFilters() {
  const params = {};
  const date = $('historyDate').value;
  if (date) params.filter_date = date;
  const name = $('historyName').value;
  if (name) params.filter_name = name;
  const rfid = $('historyRFID').value;
  if (rfid) params.filter_rfid = rfid;
  const action = $('historyAction').value;
  if (action) params.filter_action = action;
  params.limit = 100;
  return params;
}

async function loadHistory(options = {}) {
  const minAge = options.minAge === undefined ? NAV_CACHE_TTL_MS : options.minAge;
  const params = readHistoryFilters();
  const cacheKey = `history|${JSON.stringify(params)}`;
  const cached = cacheRead(cacheKey);

  if (cached) {
    historyData = cached.value;
    renderHistoryTable(historyData);
  }
  if (!options.force && cached && (Date.now() - cached.ts) < minAge) return;

  const seq = ++historySeq;
  try {
    const response = await apiGet('get_history', params);
    if (seq !== historySeq) return;

    if (!response.success) {
      setTableMessage('historyTableBody', 'Could not load history: ' + (response.message || 'unknown error'), 7);
      return;
    }

    historyData = response.data.history || [];
    cacheWrite(cacheKey, historyData);
    renderHistoryTable(historyData);
  } catch (error) {
    if (seq !== historySeq) return;
    console.error('History load error:', error);
    setTableMessage('historyTableBody', 'Could not reach the backend to load history. Retrying…', 7);
  }
}

function renderHistoryTable(records) {
  const tbody = $('historyTableBody');

  if (records.length === 0) {
    setHTML(tbody, '<tr><td colspan="7" class="empty-cell">No records found</td></tr>');
    return;
  }

  setHTML(tbody, records.map(record => `
    <tr>
      <td>${escapeHtml(record.date)}</td>
      <td>${escapeHtml(record.time)}</td>
      <td><strong>${escapeHtml(record.name)}</strong></td>
      <td>${escapeHtml(record.user_id)}</td>
      <td><code>${escapeHtml(record.rfid_uid)}</code></td>
      <td><span class="badge badge-${slug(record.action)}">${escapeHtml(record.action)}</span></td>
      <td><span class="badge badge-${(record.status === 'ALLOWED' || record.status === 'AUTHORIZED') ? 'authorized' : 'denied'}">${escapeHtml(record.status)}</span></td>
    </tr>
  `).join(''));
}

// ==================== REPORTS ====================
function isoDateLocal(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Default range: last 7 days including today, so the page shows a report
// immediately instead of an empty table until the user picks dates.
function ensureReportDateRange() {
  if (reportRangeInitialised) return;
  const fromEl = $('reportFrom');
  const toEl = $('reportTo');
  if (!fromEl || !toEl) return;
  if (fromEl.value && toEl.value) return;
  const today = new Date();
  fromEl.value = isoDateLocal(new Date(today.getTime() - 6 * 24 * 60 * 60 * 1000));
  toEl.value = isoDateLocal(today);
  reportRangeInitialised = true;
}

function renderReportData(data) {
  setText('reportEntries', String(data.total_entries || 0));
  setText('reportExits', String(data.total_exits || 0));
  setText('reportVisits', String(data.total_visits || 0));
  setText('reportInside', String(data.currently_inside || 0));

  reportData = data.data || [];
  renderReportTable(reportData);
}

async function loadReport(options = {}) {
  const minAge = options.minAge === undefined ? REPORT_CACHE_TTL_MS : options.minAge;
  const fromDate = $('reportFrom').value;
  const toDate = $('reportTo').value;

  if (!fromDate || !toDate) {
    setTableMessage('reportTableBody', 'Select date range to generate report', 9);
    return;
  }

  const cacheKey = `report|${fromDate}|${toDate}`;
  const cached = cacheRead(cacheKey);
  if (cached) renderReportData(cached.value);
  if (!options.force && cached && (Date.now() - cached.ts) < minAge) return;

  const seq = ++reportSeq;
  try {
    const response = await apiGet('get_reports', { from_date: fromDate, to_date: toDate });
    if (seq !== reportSeq) return;

    if (!response.success) {
      setTableMessage('reportTableBody', 'Could not load report: ' + (response.message || 'unknown error'), 9);
      return;
    }

    const data = response.data;
    cacheWrite(cacheKey, data);
    renderReportData(data);
  } catch (error) {
    if (seq !== reportSeq) return;
    console.error('Report load error:', error);
    setTableMessage('reportTableBody', 'Could not reach the backend to load the report. Retrying…', 9);
  }
}

function renderReportTable(records) {
  const tbody = $('reportTableBody');

  if (records.length === 0) {
    setHTML(tbody, '<tr><td colspan="9" class="empty-cell">No data for selected date range</td></tr>');
    return;
  }

  setHTML(tbody, records.map(record => `
    <tr>
      <td>${escapeHtml(record.sno)}</td>
      <td>${escapeHtml(record.date)}</td>
      <td><code>${escapeHtml(record.rfid_uid)}</code></td>
      <td><strong>${escapeHtml(record.name)}</strong></td>
      <td>${escapeHtml(record.user_id)}</td>
      <td>${escapeHtml(record.department || '')}</td>
      <td>${escapeHtml(record.user_type || '')}</td>
      <td><span class="badge badge-${slug(record.action)}">${escapeHtml(record.action)}</span></td>
      <td><span class="badge badge-${(record.status === 'ALLOWED' || record.status === 'AUTHORIZED') ? 'authorized' : 'denied'}">${escapeHtml(record.status)}</span></td>
    </tr>
  `).join(''));
}

// ==================== EXCEL EXPORT ====================
async function exportExcel() {
  const fromDate = $('reportFrom').value;
  const toDate = $('reportTo').value;

  if (!fromDate || !toDate) {
    showToast('Please select date range first', 'error');
    return;
  }

  try {
    const response = await apiCall('export_excel', { from_date: fromDate, to_date: toDate });
    if (response.session_expired) return;
    if (!response.success || !response.data.data) {
      showToast('No data to export', 'error');
      return;
    }

    generateExcelFile(response.data.data, fromDate, toDate);
    showToast('Excel file downloaded', 'success');
  } catch (error) {
    showToast('Export failed. Please try again.', 'error');
  }
}

function generateExcelFile(data, fromDate, toDate) {
  const headers = ['S.No', 'Date', 'RFID UID', 'Name', 'User ID', 'Department', 'User Type', 'Action', 'Status'];

  let csv = headers.join(',') + '\n';

  data.forEach(row => {
    csv += [
      row.sno,
      row.date,
      `"${row.rfid_uid}"`,
      `"${row.name}"`,
      `"${row.user_id}"`,
      `"${row.department || ''}"`,
      `"${row.user_type || ''}"`,
      row.action,
      row.status
    ].join(',') + '\n';
  });

  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `innosecure_report_${fromDate}_to_${toDate}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

// ==================== USER MANAGEMENT ====================
function editUser(rfidUid) {
  const user = usersData.find(u => u.rfid_uid === rfidUid);
  if (!user) return;

  const newName = prompt('Enter new name:', user.name);
  if (newName === null) return;

  const newDept = prompt('Enter new department:', user.department);
  if (newDept === null) return;

  apiCall('update_user', {
    rfid_uid: rfidUid,
    name: newName,
    department: newDept
  }).then(response => {
    if (response.success) {
      showToast('User updated successfully', 'success');
      applyLocalUserUpdate(rfidUid, { name: newName, department: newDept });
    } else if (response.session_expired) {
      return;
    } else {
      showToast(response.message || 'Update failed', 'error');
    }
  }).catch(() => showToast('Connection error', 'error'));
}

async function toggleUserStatus(rfidUid, currentStatus) {
  const newStatus = currentStatus === 'Active' ? 'Inactive' : 'Active';
  const action = newStatus === 'Inactive' ? 'deactivate' : 'reactivate';

  if (!confirm(`Are you sure you want to ${action} this user?`)) return;

  try {
    const response = await apiCall('update_user', {
      rfid_uid: rfidUid,
      status: newStatus
    });

    if (response.success) {
      showToast(`User ${action}d successfully`, 'success');
      applyLocalUserUpdate(rfidUid, { status: newStatus });
    } else if (response.session_expired) {
      return;
    } else {
      showToast(response.message || 'Update failed', 'error');
    }
  } catch (error) {
    showToast('Connection error', 'error');
  }
}

// Update the visible row at once, then reconcile with the backend so the
// table never shows an optimistic value that the server rejected.
function applyLocalUserUpdate(rfidUid, changes) {
  const user = usersData.find(u => u.rfid_uid === rfidUid);
  if (user) Object.assign(user, changes);
  if (user) cacheWrite('users', usersData);
  renderCurrentUsersView();
  loadUsers({ force: true });
}

// ==================== TOAST ====================
function showToast(message, type = 'info') {
  const toast = $('toast');
  const toastMsg = $('toastMessage');

  toastMsg.textContent = message;
  toast.className = `toast ${type}`;
  toast.style.display = 'block';

  setTimeout(() => {
    toast.style.display = 'none';
  }, 3000);
}

// ==================== DASHBOARD CACHE ====================
// Last successful statistics for an instant paint after a reload. Never used
// for status: ESP32 / internet / sheets states always come from live sources.
const DASHBOARD_CACHE_KEY = 'innosecure_dashboard_cache';

function readDashboardCache() {
  try {
    const raw = sessionStorage.getItem(DASHBOARD_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.ts || (Date.now() - parsed.ts) > DASHBOARD_CACHE_TTL_MS) return null;
    return parsed.data && typeof parsed.data === 'object' ? parsed.data : null;
  } catch (error) {
    return null;
  }
}

function writeDashboardCache(data) {
  try {
    sessionStorage.setItem(DASHBOARD_CACHE_KEY, JSON.stringify({ ts: Date.now(), data: data }));
  } catch (error) {
    // Storage full or blocked: the live fetch is the source of truth anyway.
  }
}

// ==================== DEMO DATA ====================
function getDemoData(action, params) {
  const demoUsers = [
    { rfid_uid: 'A37B9122', name: 'Pavan Kumar', user_id: 'A866051240', department: 'CSE', user_type: 'Student', status: 'Active', registration_date: '2024-01-15 09:00:00', current_status: 'INSIDE' },
    { rfid_uid: 'B48C0233', name: 'Rahul Sharma', user_id: 'A866051241', department: 'ECE', user_type: 'Student', status: 'Active', registration_date: '2024-01-16 10:00:00', current_status: 'OUTSIDE' },
    { rfid_uid: 'C59D1344', name: 'Priya Patel', user_id: 'A866051242', department: 'CSE', user_type: 'Student', status: 'Active', registration_date: '2024-01-17 11:00:00', current_status: 'INSIDE' },
    { rfid_uid: 'D60E2455', name: 'Amit Singh', user_id: 'A866051243', department: 'ME', user_type: 'Staff', status: 'Active', registration_date: '2024-01-18 12:00:00', current_status: 'OUTSIDE' },
    { rfid_uid: 'E71F3566', name: 'Sneha Reddy', user_id: 'A866051244', department: 'CSE', user_type: 'Student', status: 'Active', registration_date: '2024-01-19 13:00:00', current_status: 'INSIDE' }
  ];

  const demoHistory = [
    { timestamp: '2024-01-20 09:15:00', date: '2024-01-20', time: '09:15:00', rfid_uid: 'A37B9122', name: 'Pavan Kumar', user_id: 'A866051240', action: 'ENTRY', status: 'AUTHORIZED' },
    { timestamp: '2024-01-20 09:30:00', date: '2024-01-20', time: '09:30:00', rfid_uid: 'C59D1344', name: 'Priya Patel', user_id: 'A866051242', action: 'ENTRY', status: 'AUTHORIZED' },
    { timestamp: '2024-01-20 10:00:00', date: '2024-01-20', time: '10:00:00', rfid_uid: 'E71F3566', name: 'Sneha Reddy', user_id: 'A866051244', action: 'ENTRY', status: 'AUTHORIZED' },
    { timestamp: '2024-01-20 10:30:00', date: '2024-01-20', time: '10:30:00', rfid_uid: 'F82G4677', name: 'Unknown', user_id: 'N/A', action: 'UNKNOWN', status: 'UNKNOWN RFID' },
    { timestamp: '2024-01-20 11:00:00', date: '2024-01-20', time: '11:00:00', rfid_uid: 'B48C0233', name: 'Rahul Sharma', user_id: 'A866051241', action: 'ENTRY', status: 'AUTHORIZED' }
  ];

  switch (action) {
    case 'login':
      return { success: true, message: 'Login successful', data: { token: 'demo_token', username: params.username, role: 'admin' } };

    case 'get_dashboard_data':
      return {
        success: true,
        data: {
          registered_users: 5,
          currently_inside: 3,
          today_entries: 47,
          today_exits: 29,
          latest_scan: { timestamp: '2024-01-20 20:32:15', name: 'Pavan Kumar', rfid_uid: 'A37B9122', action: 'ENTRY', status: 'AUTHORIZED' },
          last_sync: '2024-01-20 20:32:16',
          system_status: { esp32: 'ONLINE', rfid: 'READY', internet: 'CONNECTED', google_sheets: 'SYNCED' }
        }
      };

    case 'get_users':
      return { success: true, data: { users: demoUsers } };

    case 'get_current_inside':
      return {
        success: true,
        data: {
          count: 3,
          users: demoUsers.filter(u => u.current_status === 'INSIDE').map(u => ({
            ...u,
            entry_time: '09:15:00',
            duration: '2h 25m'
          }))
        }
      };

    case 'get_history':
      return { success: true, data: { history: demoHistory } };

    case 'get_reports':
      return {
        success: true,
        data: {
          from_date: params.from_date,
          to_date: params.to_date,
          total_entries: 47,
          total_exits: 29,
          total_visits: 18,
          currently_inside: 3,
          data: demoHistory.map((h, i) => ({ ...h, sno: i + 1, department: 'CSE', user_type: 'Student' }))
        }
      };

    case 'register_user':
      return { success: true, message: 'User registered', data: { rfid_uid: params.rfid_uid, name: params.name } };

    case 'update_user':
      return { success: true, message: 'User updated' };

    case 'enter_registration_mode':
      return { success: true, data: { mode: 'registration' } };

    case 'start_rfid_registration':
      return { success: true, data: { status: 'WAITING', message: 'Waiting for RFID card...' } };

    case 'get_rfid_registration_status':
      return { success: true, data: { status: 'IDLE', rfid_uid: '' } };

    case 'rfid_registration_result':
      return { success: true, message: 'RFID scanned', data: { rfid_uid: params.rfid_uid } };

    case 'export_excel':
      return {
        success: true,
        data: {
          data: demoHistory.map((h, i) => ({ ...h, sno: i + 1, department: 'CSE', user_type: 'Student' }))
        }
      };

    default:
      return { success: true, data: {} };
  }
}
