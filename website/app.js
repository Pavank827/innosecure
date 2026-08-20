// ==================== CONFIGURATION ====================
const API_URL = 'https://script.google.com/macros/s/AKfycbyga0RcWMco2qesooHtQ2YrLzuek_NStm4HgxZ7HIzcQeq-kbrffSGsRoM4NhyNEU4vRA/exec';
const REFRESH_INTERVAL = 5000;
const DEMO_MODE = false;

// ==================== STATE ====================
let currentPage = 'dashboard';
let refreshTimer = null;
let isAuthenticated = false;
let authToken = null;
let registrationUID = '';
let usersData = [];
let currentInsideData = [];
let historyData = [];
let reportData = [];

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
  document.getElementById('loginForm').addEventListener('submit', handleLogin);
  document.getElementById('createAccountForm').addEventListener('submit', handleCreateAccount);
}

// ==================== SCREEN NAVIGATION ====================
function showLogin() {
  document.getElementById('loginScreen').style.display = 'flex';
  document.getElementById('createAccountScreen').style.display = 'none';
  document.getElementById('loginError').style.display = 'none';
  document.getElementById('createAccountForm').reset();
  document.getElementById('createAccountError').style.display = 'none';
  document.getElementById('createAccountSuccess').style.display = 'none';
}

function showCreateAccount() {
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('createAccountScreen').style.display = 'flex';
  document.getElementById('loginError').style.display = 'none';
}

// ==================== ADMIN ACCOUNT MANAGEMENT ====================
function getAdminAccounts() {
  const accounts = localStorage.getItem('innosecure_admin_accounts');
  return accounts ? JSON.parse(accounts) : [];
}

function saveAdminAccounts(accounts) {
  localStorage.setItem('innosecure_admin_accounts', JSON.stringify(accounts));
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

  const fullName = document.getElementById('createFullName').value.trim();
  const username = document.getElementById('createUsername').value.trim();
  const password = document.getElementById('createPassword').value;
  const confirmPassword = document.getElementById('createConfirmPassword').value;

  const errorEl = document.getElementById('createAccountError');
  const successEl = document.getElementById('createAccountSuccess');

  errorEl.style.display = 'none';
  successEl.style.display = 'none';

  // Check password
  if (password !== confirmPassword) {
    errorEl.textContent = 'Passwords do not match';
    errorEl.style.display = 'block';
    return;
  }

 else {
      errorEl.textContent = response.message || 'Account creation failed.';
      errorEl.style.display = 'block';
    }

  } catch (error) {
    console.error('Create account error:', error);

    errorEl.textContent = 'Connection failed. Please try again.';
    errorEl.style.display = 'block';
  }
}

  if (password.length < 4) {
    errorEl.textContent = 'Password must be at least 4 characters';
    errorEl.style.display = 'block';
    return;
  }

  const accounts = getAdminAccounts();
  const existingAccount = accounts.find(a => a.username.toLowerCase() === username.toLowerCase());
  if (existingAccount) {
    errorEl.textContent = 'Username already exists';
    errorEl.style.display = 'block';
    return;
  }

  const newAccount = {
    fullName: fullName,
    username: username,
    passwordHash: hashPassword(password),
    createdAt: new Date().toISOString()
  };

  accounts.push(newAccount);
  saveAdminAccounts(accounts);

  successEl.textContent = 'Admin account created successfully.';
  successEl.style.display = 'block';

  setTimeout(() => {
    showLogin();
  }, 2000);
}

// ==================== AUTHENTICATION ====================
async function handleLogin(e) {
  e.preventDefault();
  const username = document.getElementById('loginUsername').value;
  const password = document.getElementById('loginPassword').value;
  const errorEl = document.getElementById('loginError');
  
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
  document.getElementById('loginScreen').style.display = 'flex';
  document.getElementById('createAccountScreen').style.display = 'none';
  document.getElementById('mainApp').style.display = 'none';
  document.getElementById('loginUsername').value = '';
  document.getElementById('loginPassword').value = '';
  document.getElementById('loginError').style.display = 'none';
  if (refreshTimer) clearInterval(refreshTimer);
}

function showMainApp() {
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('mainApp').style.display = 'flex';
  startAutoRefresh();
  loadDashboard();
}

// ==================== API CALLS ====================
async function apiCall(action, data = {}) {
  if (DEMO_MODE) {
    return getDemoData(action, data);
  }
  
  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, data })
    });
    
    if (!response.ok) throw new Error('HTTP error');
    return await response.json();
  } catch (error) {
    console.error('API Error:', error);
    throw error;
  }
}

async function apiGet(action, params = {}) {
  if (DEMO_MODE) {
    return getDemoData(action, params);
  }
  
  try {
    const queryString = new URLSearchParams({ action, ...params }).toString();
    const response = await fetch(`${API_URL}?${queryString}`);
    if (!response.ok) throw new Error('HTTP error');
    return await response.json();
  } catch (error) {
    console.error('API Error:', error);
    throw error;
  }
}

// ==================== NAVIGATION ====================
function navigateTo(page) {
  currentPage = page;
  
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById(`page-${page}`).classList.add('active');
  
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.querySelector(`[data-page="${page}"]`).classList.add('active');
  
  loadPageData(page);
}

function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
}

function loadPageData(page) {
  switch (page) {
    case 'dashboard': loadDashboard(); break;
    case 'users': loadUsers(); break;
    case 'inside': loadCurrentInside(); break;
    case 'history': loadHistory(); break;
    case 'reports': loadReport(); break;
  }
}

// ==================== AUTO REFRESH ====================
function startAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    loadPageData(currentPage);
  }, REFRESH_INTERVAL);
}

// ==================== DASHBOARD ====================
async function loadDashboard() {
  try {
    const response = await apiGet('get_dashboard_data');
    if (!response.success) return;
    
    const data = response.data;
    
    document.getElementById('statRegistered').textContent = data.registered_users || 0;
    document.getElementById('statInside').textContent = data.currently_inside || 0;
    document.getElementById('statEntries').textContent = data.today_entries || 0;
    document.getElementById('statExits').textContent = data.today_exits || 0;
    
    if (data.latest_scan) {
      const scan = data.latest_scan;
      const activityHTML = `
        <div class="activity-item">
          <div class="activity-icon ${scan.action.toLowerCase()}">
            ${scan.action === 'ENTRY' ? 
              '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"></polyline></svg>' :
              '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 18 13.5 8.5 8.5 13.5 1 6"></polyline></svg>'
            }
          </div>
          <div class="activity-info">
            <div class="activity-name">${scan.name}</div>
            <div class="activity-detail">${scan.action} &bull; ${scan.rfid_uid}</div>
          </div>
          <div class="activity-time">${formatTime(scan.timestamp)}</div>
        </div>
      `;
      document.getElementById('latestActivity').innerHTML = activityHTML;
    }
    
    if (data.system_status) {
      updateSystemStatus(data.system_status, data.last_sync);
    }
  } catch (error) {
    console.error('Dashboard load error:', error);
  }
}

function updateSystemStatus(status, lastSync) {
  const statusMap = {
    'statusESP32': status.esp32,
    'statusRFID': status.rfid,
    'statusInternet': status.internet,
    'statusSheets': status.google_sheets
  };
  
  for (const [id, value] of Object.entries(statusMap)) {
    const el = document.getElementById(id);
    if (el) {
      const isOnline = value === 'ONLINE' || value === 'READY' || value === 'CONNECTED' || value === 'SYNCED';
      el.innerHTML = `<span class="status-dot ${isOnline ? 'online' : 'offline'}"></span> ${value}`;
    }
  }
  
  if (lastSync) {
    document.getElementById('lastSyncTime').textContent = formatTime(lastSync);
  }
}

// ==================== USERS ====================
async function loadUsers() {
  try {
    const response = await apiGet('get_users');
    if (!response.success) return;
    
    usersData = response.data.users || [];
    renderUsersTable(usersData);
  } catch (error) {
    console.error('Users load error:', error);
  }
}

function renderUsersTable(users) {
  const tbody = document.getElementById('usersTableBody');
  
  if (users.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty-cell">No users registered</td></tr>';
    return;
  }
  
  tbody.innerHTML = users.map(user => `
    <tr>
      <td><strong>${escapeHtml(user.name)}</strong></td>
      <td>${escapeHtml(user.user_id)}</td>
      <td><code>${escapeHtml(user.rfid_uid)}</code></td>
      <td>${escapeHtml(user.department)}</td>
      <td>${escapeHtml(user.user_type)}</td>
      <td><span class="badge badge-${user.status.toLowerCase()}">${user.status}</span></td>
      <td><span class="badge badge-${user.current_status.toLowerCase()}">${user.current_status}</span></td>
      <td>
        <div style="display:flex;gap:4px;">
          <button class="btn-icon" onclick="editUser('${escapeHtml(user.rfid_uid)}')" title="Edit">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"></path>
              <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"></path>
            </svg>
          </button>
          <button class="btn-icon" onclick="toggleUserStatus('${escapeHtml(user.rfid_uid)}', '${user.status}')" title="${user.status === 'Active' ? 'Deactivate' : 'Activate'}">
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
  `).join('');
}

function filterUsers() {
  const query = document.getElementById('userSearch').value.toLowerCase();
  const filtered = usersData.filter(user => 
    user.name.toLowerCase().includes(query) ||
    user.user_id.toLowerCase().includes(query) ||
    user.rfid_uid.toLowerCase().includes(query) ||
    user.department.toLowerCase().includes(query)
  );
  renderUsersTable(filtered);
}

// ==================== REGISTRATION ====================
function startRegistration() {
  document.getElementById('registrationModal').style.display = 'flex';
  document.getElementById('regStep1').style.display = 'block';
  document.getElementById('regStep2').style.display = 'none';
  document.getElementById('regStep3').style.display = 'none';
  document.getElementById('registrationTitle').textContent = 'Register New User';
  
  if (!DEMO_MODE) {
    apiCall('enter_registration_mode', {}).catch(console.error);
  }
}

function closeRegistration() {
  document.getElementById('registrationModal').style.display = 'none';
  registrationUID = '';
}

function showRegistrationStep2(uid) {
  registrationUID = uid;
  document.getElementById('regStep1').style.display = 'none';
  document.getElementById('regStep2').style.display = 'block';
  document.getElementById('regDetectedUID').textContent = uid;
  document.getElementById('registrationForm').reset();
}

function showRegistrationSuccess(name, uid) {
  document.getElementById('regStep2').style.display = 'none';
  document.getElementById('regStep3').style.display = 'block';
  document.getElementById('regSuccessName').textContent = name;
  document.getElementById('regSuccessUID').textContent = 'RFID: ' + uid;
  
  setTimeout(() => {
    closeRegistration();
    loadUsers();
  }, 3000);
}

async function submitRegistration(e) {
  e.preventDefault();
  
  const userData = {
    rfid_uid: registrationUID,
    name: document.getElementById('regName').value,
    user_id: document.getElementById('regUserId').value,
    department: document.getElementById('regDept').value,
    user_type: document.getElementById('regType').value
  };
  
  try {
    const response = await apiCall('register_user', userData);
    if (response.success) {
      showRegistrationSuccess(userData.name, registrationUID);
      showToast('User registered successfully', 'success');
    } else {
      showToast(response.message || 'Registration failed', 'error');
    }
  } catch (error) {
    showToast('Connection error. Please try again.', 'error');
  }
}

// ==================== CURRENTLY INSIDE ====================
async function loadCurrentInside() {
  try {
    const response = await apiGet('get_current_inside');
    if (!response.success) return;
    
    currentInsideData = response.data.users || [];
    document.getElementById('insideCount').textContent = response.data.count || 0;
    renderInsideTable(currentInsideData);
  } catch (error) {
    console.error('Inside load error:', error);
  }
}

function renderInsideTable(users) {
  const tbody = document.getElementById('insideTableBody');
  
  if (users.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-cell">No users currently inside</td></tr>';
    return;
  }
  
  tbody.innerHTML = users.map(user => `
    <tr>
      <td><strong>${escapeHtml(user.name)}</strong></td>
      <td>${escapeHtml(user.user_id)}</td>
      <td>${escapeHtml(user.department)}</td>
      <td>${user.entry_time}</td>
      <td>${user.duration}</td>
      <td><span class="badge badge-inside">INSIDE</span></td>
    </tr>
  `).join('');
}

// ==================== HISTORY ====================
async function loadHistory() {
  const params = {};
  
  const date = document.getElementById('historyDate').value;
  if (date) params.filter_date = date;
  
  const name = document.getElementById('historyName').value;
  if (name) params.filter_name = name;
  
  const rfid = document.getElementById('historyRFID').value;
  if (rfid) params.filter_rfid = rfid;
  
  const action = document.getElementById('historyAction').value;
  if (action) params.filter_action = action;
  
  params.limit = 100;
  
  try {
    const response = await apiGet('get_history', params);
    if (!response.success) return;
    
    historyData = response.data.history || [];
    renderHistoryTable(historyData);
  } catch (error) {
    console.error('History load error:', error);
  }
}

function renderHistoryTable(records) {
  const tbody = document.getElementById('historyTableBody');
  
  if (records.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-cell">No records found</td></tr>';
    return;
  }
  
  tbody.innerHTML = records.map(record => `
    <tr>
      <td>${record.date}</td>
      <td>${record.time}</td>
      <td><strong>${escapeHtml(record.name)}</strong></td>
      <td>${escapeHtml(record.user_id)}</td>
      <td><code>${escapeHtml(record.rfid_uid)}</code></td>
      <td><span class="badge badge-${record.action.toLowerCase()}">${record.action}</span></td>
      <td><span class="badge badge-${record.status === 'AUTHORIZED' ? 'authorized' : 'denied'}">${record.status}</span></td>
    </tr>
  `).join('');
}

// ==================== REPORTS ====================
async function loadReport() {
  const fromDate = document.getElementById('reportFrom').value;
  const toDate = document.getElementById('reportTo').value;
  
  if (!fromDate || !toDate) return;
  
  try {
    const response = await apiGet('get_reports', { from_date: fromDate, to_date: toDate });
    if (!response.success) return;
    
    const data = response.data;
    document.getElementById('reportEntries').textContent = data.total_entries || 0;
    document.getElementById('reportExits').textContent = data.total_exits || 0;
    document.getElementById('reportVisits').textContent = data.total_visits || 0;
    document.getElementById('reportInside').textContent = data.currently_inside || 0;
    
    reportData = data.data || [];
    renderReportTable(reportData);
  } catch (error) {
    console.error('Report load error:', error);
  }
}

function renderReportTable(records) {
  const tbody = document.getElementById('reportTableBody');
  
  if (records.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty-cell">No data for selected date range</td></tr>';
    return;
  }
  
  tbody.innerHTML = records.map(record => `
    <tr>
      <td>${record.sno}</td>
      <td>${record.date}</td>
      <td><code>${escapeHtml(record.rfid_uid)}</code></td>
      <td><strong>${escapeHtml(record.name)}</strong></td>
      <td>${escapeHtml(record.user_id)}</td>
      <td>${escapeHtml(record.department || '')}</td>
      <td>${escapeHtml(record.user_type || '')}</td>
      <td><span class="badge badge-${record.action.toLowerCase()}">${record.action}</span></td>
      <td><span class="badge badge-${record.status === 'AUTHORIZED' ? 'authorized' : 'denied'}">${record.status}</span></td>
    </tr>
  `).join('');
}

// ==================== EXCEL EXPORT ====================
async function exportExcel() {
  const fromDate = document.getElementById('reportFrom').value;
  const toDate = document.getElementById('reportTo').value;
  
  if (!fromDate || !toDate) {
    showToast('Please select date range first', 'error');
    return;
  }
  
  try {
    const response = await apiCall('export_excel', { from_date: fromDate, to_date: toDate });
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
      loadUsers();
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
      loadUsers();
    } else {
      showToast(response.message || 'Update failed', 'error');
    }
  } catch (error) {
    showToast('Connection error', 'error');
  }
}

// ==================== TOAST ====================
function showToast(message, type = 'info') {
  const toast = document.getElementById('toast');
  const toastMsg = document.getElementById('toastMessage');
  
  toastMsg.textContent = message;
  toast.className = `toast ${type}`;
  toast.style.display = 'block';
  
  setTimeout(() => {
    toast.style.display = 'none';
  }, 3000);
}

// ==================== UTILITIES ====================
function formatTime(timestamp) {
  if (!timestamp) return '--';
  const parts = timestamp.split(' ');
  if (parts.length >= 2) {
    return parts[1];
  }
  return timestamp;
}

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
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
