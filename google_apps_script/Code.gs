/**
 * INNOSECURE - Innovation Lab RFID Entry & Exit Monitoring System
 * Google Apps Script Backend API
 * 
 * This script acts as the cloud API between ESP32 and Google Sheets
 */

// ==================== CONFIGURATION ====================
const SPREADSHEET_ID = '1EHQTxJaVCN-GivxZHYT8PT3Uekr-GH039y5aQ8yIQZ8';
const SHEET_USERS = 'Users';
const SHEET_ACCESS_LOG = 'Access_Log';
const SHEET_CURRENT_STATUS = 'Current_Status';
const SHEET_SETTINGS = 'Settings';
const SHEET_ADMIN_ACCOUNTS = 'Admin_Accounts';

// ==================== MAIN ENTRY POINT ====================
function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const action = data.action;
    const payload = data.data || {};
    
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
      case 'update_settings':
        return handleUpdateSettings(payload);
      case 'get_settings':
        return handleGetSettings(payload);
      case 'enter_registration_mode':
        return handleEnterRegistrationMode(payload);
      case 'start_rfid_registration':
        return handleStartRFIDRegistration(payload);
      case 'get_rfid_registration_status':
        return handleGetRFIDRegistrationStatus(payload);
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
      case 'get_settings':
        return handleGetSettings({});
      case 'get_rfid_registration_status':
        return handleGetRFIDRegistrationStatus({});
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
function getSpreadsheet() {
  return SpreadsheetApp.openById(SPREADSHEET_ID);
}

function getSheet(name) {
  return getSpreadsheet().getSheetByName(name);
}

function createResponse(success, message, data) {
  const response = {
    success: success,
    message: message || '',
    timestamp: new Date().toISOString()
  };
  if (data) {
    response.data = data;
  }
  return ContentService.createTextOutput(JSON.stringify(response))
    .setMimeType(ContentService.MimeType.JSON);
}

function getISTTimestamp() {
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istTime = new Date(now.getTime() + istOffset);
  return istTime;
}

function formatISTDate(date) {
  const d = date || getISTTimestamp();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatISTTime(date) {
  const d = date || getISTTimestamp();
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  const seconds = String(d.getSeconds()).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

function formatISTDateTime(date) {
  return formatISTDate(date) + ' ' + formatISTTime(date);
}

function hashPassword(password) {
  var hash = 0;
  for (var i = 0; i < password.length; i++) {
    var char = password.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return 'h_' + Math.abs(hash).toString(36);
}

// ==================== ADMIN ACCOUNT MANAGEMENT ====================
function handleCreateAdminAccount(payload) {
  var sheet = getSheet(SHEET_ADMIN_ACCOUNTS);
  var data = sheet.getDataRange().getValues();
  
  var username = payload.username;
  var password = payload.password;
  var fullName = payload.fullName;
  
  if (!username || !password) {
    return createResponse(false, 'Username and password are required');
  }
  
  for (var i = 1; i < data.length; i++) {
    if (data[i][1] && data[i][1].toLowerCase() === username.toLowerCase()) {
      return createResponse(false, 'Username already exists');
    }
  }
  
  var passwordHash = hashPassword(password);
  var timestamp = formatISTDateTime();
  
  sheet.appendRow([fullName, username, passwordHash, timestamp]);
  
  return createResponse(true, 'Admin account created successfully', {
    username: username
  });
}

function handleLogin(payload) {
  var username = payload.username;
  var password = payload.password;
  
  if (!username || !password) {
    return createResponse(false, 'Username and password are required');
  }
  
  var sheet = getSheet(SHEET_ADMIN_ACCOUNTS);
  var data = sheet.getDataRange().getValues();
  var passwordHash = hashPassword(password);
  
  for (var i = 1; i < data.length; i++) {
    if (data[i][1] && data[i][1].toLowerCase() === username.toLowerCase() && data[i][2] === passwordHash) {
      return createResponse(true, 'Login successful', {
        token: 'auth_' + Date.now(),
        username: username,
        fullName: data[i][0],
        role: 'admin'
      });
    }
  }
  
  return createResponse(false, 'Invalid username or password');
}

// ==================== RFID VALIDATION ====================
function handleValidateRFID(payload) {
  var sheet = getSheet(SHEET_USERS);
  var data = sheet.getDataRange().getValues();
  var rfidUID = payload.rfid_uid;
  
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === rfidUID) {
      var statusSheet = getSheet(SHEET_CURRENT_STATUS);
      var statusData = statusSheet.getDataRange().getValues();
      var currentStatus = 'OUTSIDE';
      
      for (var j = 1; j < statusData.length; j++) {
        if (statusData[j][0] === rfidUID) {
          currentStatus = statusData[j][4];
          break;
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
  }
  
  return createResponse(true, 'User not found', { registered: false });
}

// ==================== LOG EVENT ====================
function handleLogEvent(payload) {
  var sheet = getSheet(SHEET_ACCESS_LOG);
  var timestamp = payload.timestamp || formatISTDateTime();
  var date = timestamp.split(' ')[0];
  var time = timestamp.split(' ')[1];
  
  sheet.appendRow([
    timestamp,
    date,
    time,
    payload.rfid_uid,
    payload.name || 'Unknown',
    payload.user_id || 'N/A',
    payload.action,
    payload.status || 'UNKNOWN'
  ]);
  
  if (payload.action === 'ENTRY' || payload.action === 'EXIT') {
    updateCurrentStatus(payload.rfid_uid, payload.action, payload.name, payload.user_id);
  }
  
  return createResponse(true, 'Event logged successfully');
}

function updateCurrentStatus(rfidUID, action, name, userId) {
  var sheet = getSheet(SHEET_CURRENT_STATUS);
  var data = sheet.getDataRange().getValues();
  
  var rowIndex = -1;
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === rfidUID) {
      rowIndex = i + 1;
      break;
    }
  }
  
  if (action === 'ENTRY') {
    var entryTime = formatISTTime();
    if (rowIndex > 0) {
      sheet.getRange(rowIndex, 5).setValue('INSIDE');
      sheet.getRange(rowIndex, 4).setValue(entryTime);
    } else {
      sheet.appendRow([rfidUID, name || 'Unknown', userId || 'N/A', entryTime, 'INSIDE']);
    }
  } else if (action === 'EXIT') {
    if (rowIndex > 0) {
      sheet.getRange(rowIndex, 5).setValue('OUTSIDE');
    }
  }
}

// ==================== USER REGISTRATION ====================
function handleRegisterUser(payload) {
  var sheet = getSheet(SHEET_USERS);
  var data = sheet.getDataRange().getValues();
  
  var rfidUID = payload.rfid_uid;
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === rfidUID) {
      return createResponse(false, 'RFID card already registered');
    }
  }
  
  var timestamp = formatISTDateTime();
  sheet.appendRow([
    rfidUID,
    payload.name,
    payload.user_id,
    payload.department,
    payload.user_type || 'Student',
    'Active',
    timestamp
  ]);
  
  var statusSheet = getSheet(SHEET_CURRENT_STATUS);
  statusSheet.appendRow([rfidUID, payload.name, payload.user_id, '', 'OUTSIDE']);
  
  return createResponse(true, 'User registered successfully', {
    rfid_uid: rfidUID,
    name: payload.name
  });
}

// ==================== CHECK RFID ====================
function handleCheckRFID(payload) {
  var sheet = getSheet(SHEET_USERS);
  var data = sheet.getDataRange().getValues();
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
  var usersSheet = getSheet(SHEET_USERS);
  var usersData = usersSheet.getDataRange().getValues();
  var registeredUsers = Math.max(0, usersData.length - 1);
  
  var statusSheet = getSheet(SHEET_CURRENT_STATUS);
  var statusData = statusSheet.getDataRange().getValues();
  var currentlyInside = 0;
  
  for (var i = 1; i < statusData.length; i++) {
    if (statusData[i][4] === 'INSIDE') {
      currentlyInside++;
    }
  }
  
  var logSheet = getSheet(SHEET_ACCESS_LOG);
  var logData = logSheet.getDataRange().getValues();
  var today = formatISTDate();
  
  var todayEntries = 0;
  var todayExits = 0;
  var latestScan = null;
  
  for (var i = 1; i < logData.length; i++) {
    if (logData[i][1] === today) {
      if (logData[i][6] === 'ENTRY') todayEntries++;
      if (logData[i][6] === 'EXIT') todayExits++;
    }
  }
  
  if (logData.length > 1) {
    var lastRow = logData[logData.length - 1];
    latestScan = {
      timestamp: lastRow[0],
      name: lastRow[4],
      rfid_uid: lastRow[3],
      action: lastRow[6],
      status: lastRow[7]
    };
  }
  
  var settingsSheet = getSheet(SHEET_SETTINGS);
  var settingsData = settingsSheet.getDataRange().getValues();
  var lastSync = '';
  for (var i = 1; i < settingsData.length; i++) {
    if (settingsData[i][0] === 'LAST_SYNC') {
      lastSync = settingsData[i][1];
      break;
    }
  }
  
  settingsSheet.getRange('A1:B100').clear();
  settingsSheet.appendRow(['SYSTEM_NAME', 'InnoSecure']);
  settingsSheet.appendRow(['TIMEZONE', 'Asia/Kolkata']);
  settingsSheet.appendRow(['RFID_COOLDOWN', '3000']);
  settingsSheet.appendRow(['REFRESH_INTERVAL', '5000']);
  settingsSheet.appendRow(['LAST_SYNC', formatISTDateTime()]);
  
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
  var sheet = getSheet(SHEET_USERS);
  var data = sheet.getDataRange().getValues();
  var users = [];
  
  var statusSheet = getSheet(SHEET_CURRENT_STATUS);
  var statusData = statusSheet.getDataRange().getValues();
  
  for (var i = 1; i < data.length; i++) {
    var currentStatus = 'OUTSIDE';
    
    for (var j = 1; j < statusData.length; j++) {
      if (statusData[j][0] === data[i][0]) {
        currentStatus = statusData[j][4];
        break;
      }
    }
    
    users.push({
      rfid_uid: data[i][0],
      name: data[i][1],
      user_id: data[i][2],
      department: data[i][3],
      user_type: data[i][4],
      status: data[i][5],
      registration_date: data[i][6],
      current_status: currentStatus
    });
  }
  
  return createResponse(true, 'Users retrieved', { users: users });
}

// ==================== GET CURRENT INSIDE ====================
function handleGetCurrentInside(payload) {
  var sheet = getSheet(SHEET_CURRENT_STATUS);
  var data = sheet.getDataRange().getValues();
  var insideUsers = [];
  
  var usersSheet = getSheet(SHEET_USERS);
  var usersData = usersSheet.getDataRange().getValues();
  
  for (var i = 1; i < data.length; i++) {
    if (data[i][4] === 'INSIDE') {
      var department = '';
      var userId = data[i][2];
      
      for (var j = 1; j < usersData.length; j++) {
        if (usersData[j][0] === data[i][0]) {
          department = usersData[j][3];
          break;
        }
      }
      
      var entryTime = data[i][3];
      var now = getISTTimestamp();
      var entryParts = entryTime.split(':');
      var entryDate = new Date(now);
      entryDate.setHours(parseInt(entryParts[0]), parseInt(entryParts[1]), parseInt(entryParts[2]));
      var diffMs = now - entryDate;
      var diffMins = Math.floor(diffMs / 60000);
      var hours = Math.floor(diffMins / 60);
      var mins = diffMins % 60;
      var duration = hours > 0 ? hours + 'h ' + mins + 'm' : mins + 'm';
      
      insideUsers.push({
        rfid_uid: data[i][0],
        name: data[i][1],
        user_id: userId,
        department: department,
        entry_time: entryTime,
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
  var sheet = getSheet(SHEET_ACCESS_LOG);
  var data = sheet.getDataRange().getValues();
  var history = [];
  
  var filterDate = params.filter_date || '';
  var filterName = params.filter_name || '';
  var filterRFID = params.filter_rfid || '';
  var filterAction = params.filter_action || '';
  var limit = parseInt(params.limit) || 100;
  
  for (var i = data.length - 1; i >= 1 && history.length < limit; i--) {
    var match = true;
    
    if (filterDate && data[i][1] !== filterDate) match = false;
    if (filterName && data[i][4].toLowerCase().indexOf(filterName.toLowerCase()) === -1) match = false;
    if (filterRFID && data[i][3].toLowerCase().indexOf(filterRFID.toLowerCase()) === -1) match = false;
    if (filterAction && data[i][6] !== filterAction) match = false;
    
    if (match) {
      history.push({
        timestamp: data[i][0],
        date: data[i][1],
        time: data[i][2],
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
  var sheet = getSheet(SHEET_ACCESS_LOG);
  var data = sheet.getDataRange().getValues();
  
  var fromDate = params.from_date || formatISTDate(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000));
  var toDate = params.to_date || formatISTDate();
  
  var totalEntries = 0;
  var totalExits = 0;
  var visits = {};
  
  for (var i = 1; i < data.length; i++) {
    if (data[i][1] >= fromDate && data[i][1] <= toDate) {
      if (data[i][6] === 'ENTRY') {
        totalEntries++;
        visits[data[i][3] + '_' + data[i][1]] = true;
      }
      if (data[i][6] === 'EXIT') totalExits++;
    }
  }
  
  var statusSheet = getSheet(SHEET_CURRENT_STATUS);
  var statusData = statusSheet.getDataRange().getValues();
  var currentlyInside = 0;
  for (var i = 1; i < statusData.length; i++) {
    if (statusData[i][4] === 'INSIDE') currentlyInside++;
  }
  
  var reportData = [];
  for (var i = 1; i < data.length; i++) {
    if (data[i][1] >= fromDate && data[i][1] <= toDate) {
      reportData.push({
        sno: reportData.length + 1,
        date: data[i][1],
        rfid_uid: data[i][3],
        name: data[i][4],
        user_id: data[i][5],
        action: data[i][6],
        status: data[i][7]
      });
    }
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
  var sheet = getSheet(SHEET_USERS);
  var data = sheet.getDataRange().getValues();
  
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === payload.rfid_uid) {
      if (payload.name) sheet.getRange(i + 1, 2).setValue(payload.name);
      if (payload.user_id) sheet.getRange(i + 1, 3).setValue(payload.user_id);
      if (payload.department) sheet.getRange(i + 1, 4).setValue(payload.department);
      if (payload.user_type) sheet.getRange(i + 1, 5).setValue(payload.user_type);
      if (payload.status) sheet.getRange(i + 1, 6).setValue(payload.status);
      
      if (payload.status === 'Inactive') {
        var statusSheet = getSheet(SHEET_CURRENT_STATUS);
        var statusData = statusSheet.getDataRange().getValues();
        for (var j = 1; j < statusData.length; j++) {
          if (statusData[j][0] === payload.rfid_uid) {
            statusSheet.getRange(j + 1, 5).setValue('OUTSIDE');
            break;
          }
        }
      }
      
      return createResponse(true, 'User updated successfully');
    }
  }
  
  return createResponse(false, 'User not found');
}

// ==================== DELETE USER ====================
function handleDeleteUser(payload) {
  var sheet = getSheet(SHEET_USERS);
  var data = sheet.getDataRange().getValues();
  
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === payload.rfid_uid) {
      sheet.deleteRow(i + 1);
      
      var statusSheet = getSheet(SHEET_CURRENT_STATUS);
      var statusData = statusSheet.getDataRange().getValues();
      for (var j = 1; j < statusData.length; j++) {
        if (statusData[j][0] === payload.rfid_uid) {
          statusSheet.deleteRow(j + 1);
          break;
        }
      }
      
      return createResponse(true, 'User deleted successfully');
    }
  }
  
  return createResponse(false, 'User not found');
}

// ==================== SETTINGS ====================
function handleUpdateSettings(payload) {
  var sheet = getSheet(SHEET_SETTINGS);
  var data = sheet.getDataRange().getValues();
  
  var keys = Object.keys(payload);
  for (var k = 0; k < keys.length; k++) {
    var key = keys[k];
    var value = payload[key];
    var found = false;
    for (var i = 1; i < data.length; i++) {
      if (data[i][0] === key) {
        sheet.getRange(i + 1, 2).setValue(value);
        found = true;
        break;
      }
    }
    if (!found) {
      sheet.appendRow([key, value]);
    }
  }
  
  return createResponse(true, 'Settings updated');
}

function handleGetSettings(payload) {
  var sheet = getSheet(SHEET_SETTINGS);
  var data = sheet.getDataRange().getValues();
  var settings = {};
  
  for (var i = 1; i < data.length; i++) {
    settings[data[i][0]] = data[i][1];
  }
  
  return createResponse(true, 'Settings retrieved', settings);
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
  var sheet = getSheet(SHEET_SETTINGS);
  var data = sheet.getDataRange().getValues();
  
  var found = false;
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === 'RFID_REG_STATUS') {
      sheet.getRange(i + 1, 2).setValue('WAITING');
      found = true;
      break;
    }
  }
  if (!found) {
    sheet.appendRow(['RFID_REG_STATUS', 'WAITING']);
  }
  
  return createResponse(true, 'RFID registration started', {
    status: 'WAITING',
    message: 'Waiting for RFID card...'
  });
}

function handleGetRFIDRegistrationStatus(payload) {
  var sheet = getSheet(SHEET_SETTINGS);
  var data = sheet.getDataRange().getValues();
  
  var status = 'IDLE';
  var rfidUid = '';
  
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === 'RFID_REG_STATUS') {
      status = data[i][1];
    }
    if (data[i][0] === 'RFID_REG_UID') {
      rfidUid = data[i][1];
    }
  }
  
  if (status === 'WAITING') {
    return createResponse(true, 'Status retrieved', {
      status: 'WAITING',
      rfid_uid: ''
    });
  } else if (status === 'DETECTED' && rfidUid) {
    var settingsSheet = getSheet(SHEET_SETTINGS);
    var settingsData = settingsSheet.getDataRange().getValues();
    for (var j = 1; j < settingsData.length; j++) {
      if (settingsData[j][0] === 'RFID_REG_STATUS') {
        settingsSheet.getRange(j + 1, 2).setValue('IDLE');
        break;
      }
    }
    for (var k = 1; k < settingsData.length; k++) {
      if (settingsData[k][0] === 'RFID_REG_UID') {
        settingsSheet.getRange(k + 1, 2).setValue('');
        break;
      }
    }
    
    return createResponse(true, 'RFID detected', {
      status: 'DETECTED',
      rfid_uid: rfidUid
    });
  }
  
  return createResponse(true, 'Status retrieved', {
    status: 'IDLE',
    rfid_uid: ''
  });
}

function handleRFIDRegistrationResult(payload) {
  var sheet = getSheet(SHEET_SETTINGS);
  var data = sheet.getDataRange().getValues();
  
  var rfidUid = payload.rfid_uid;
  if (!rfidUid) {
    return createResponse(false, 'No RFID UID provided');
  }
  
  var foundStatus = false;
  var foundUid = false;
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === 'RFID_REG_STATUS') {
      sheet.getRange(i + 1, 2).setValue('DETECTED');
      foundStatus = true;
    }
    if (data[i][0] === 'RFID_REG_UID') {
      sheet.getRange(i + 1, 2).setValue(rfidUid);
      foundUid = true;
    }
  }
  
  if (!foundStatus) {
    sheet.appendRow(['RFID_REG_STATUS', 'DETECTED']);
  }
  if (!foundUid) {
    sheet.appendRow(['RFID_REG_UID', rfidUid]);
  }
  
  return createResponse(true, 'RFID registration result stored', {
    rfid_uid: rfidUid,
    status: 'DETECTED'
  });
}

// ==================== EXPORT EXCEL ====================
function handleExportExcel(payload) {
  var sheet = getSheet(SHEET_ACCESS_LOG);
  var data = sheet.getDataRange().getValues();
  
  var fromDate = payload.from_date || formatISTDate(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
  var toDate = payload.to_date || formatISTDate();
  
  var exportData = [];
  var sno = 1;
  
  var usersSheet = getSheet(SHEET_USERS);
  var usersData = usersSheet.getDataRange().getValues();
  
  for (var i = 1; i < data.length; i++) {
    if (data[i][1] >= fromDate && data[i][1] <= toDate) {
      var department = '';
      var userType = '';
      
      for (var j = 1; j < usersData.length; j++) {
        if (usersData[j][0] === data[i][3]) {
          department = usersData[j][3];
          userType = usersData[j][4];
          break;
        }
      }
      
      exportData.push({
        sno: sno++,
        date: data[i][1],
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
    logSheet.appendRow(['TIMESTAMP', 'DATE', 'TIME', 'RFID_UID', 'NAME', 'USER_ID', 'ACTION', 'STATUS']);
  }
  
  var statusSheet = ss.getSheetByName(SHEET_CURRENT_STATUS);
  if (!statusSheet) {
    statusSheet = ss.insertSheet(SHEET_CURRENT_STATUS);
    statusSheet.appendRow(['RFID_UID', 'NAME', 'USER_ID', 'ENTRY_TIME', 'CURRENT_STATUS']);
  }
  
  var settingsSheet = ss.getSheetByName(SHEET_SETTINGS);
  if (!settingsSheet) {
    settingsSheet = ss.insertSheet(SHEET_SETTINGS);
    settingsSheet.appendRow(['KEY', 'VALUE']);
    settingsSheet.appendRow(['SYSTEM_NAME', 'InnoSecure']);
    settingsSheet.appendRow(['TIMEZONE', 'Asia/Kolkata']);
    settingsSheet.appendRow(['RFID_COOLDOWN', '3000']);
    settingsSheet.appendRow(['REFRESH_INTERVAL', '5000']);
  }
  
  var adminSheet = ss.getSheetByName(SHEET_ADMIN_ACCOUNTS);
  if (!adminSheet) {
    adminSheet = ss.insertSheet(SHEET_ADMIN_ACCOUNTS);
    adminSheet.appendRow(['FULL_NAME', 'USERNAME', 'PASSWORD_HASH', 'CREATED_AT']);
  }
  
  return 'Spreadsheet initialized successfully';
}
