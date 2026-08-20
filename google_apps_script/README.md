# Google Apps Script - Setup Guide

## Overview

This Google Apps Script acts as the cloud API for the Makerspace RFID system. It handles all data operations between the ESP32, website, and Google Sheets.

## Setup Instructions

### Step 1: Create Google Sheet

1. Go to [Google Sheets](https://sheets.google.com)
2. Create a new spreadsheet
3. Name it: **Makerspace Access Monitor**
4. Copy the Spreadsheet ID from the URL:
   ```
   https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/edit
   ```

### Step 2: Create Sheets

Create these 4 sheets in your spreadsheet:

1. **Users** - Registered user data
2. **Access_Log** - Entry/Exit event log
3. **Current_Status** - Current inside/outside status
4. **Settings** - System configuration

### Step 3: Set Up Sheet Headers

#### Sheet: Users
| A | B | C | D | E | F | G |
|---|---|---|---|---|---|---|
| RFID_UID | NAME | USER_ID | DEPARTMENT | USER_TYPE | STATUS | REGISTRATION_DATE |

#### Sheet: Access_Log
| A | B | C | D | E | F | G | H |
|---|---|---|---|---|---|---|---|
| TIMESTAMP | DATE | TIME | RFID_UID | NAME | USER_ID | ACTION | STATUS |

#### Sheet: Current_Status
| A | B | C | D | E |
|---|---|---|---|---|
| RFID_UID | NAME | USER_ID | ENTRY_TIME | CURRENT_STATUS |

#### Sheet: Settings
| A | B |
|---|---|
| KEY | VALUE |

Add initial settings:
| KEY | VALUE |
|-----|-------|
| SYSTEM_NAME | Makerspace Access Monitor |
| TIMEZONE | Asia/Kolkata |
| RFID_COOLDOWN | 3000 |
| REFRESH_INTERVAL | 5000 |

### Step 4: Create Apps Script

1. In your Google Sheet, go to **Extensions → Apps Script**
2. Delete any existing code
3. Copy the contents of `Code.gs` from this folder
4. Paste it into the Apps Script editor
5. Update `SPREADSHEET_ID` at the top with your spreadsheet ID
6. Click **Save**

### Step 5: Deploy as Web App

1. Click **Deploy → New deployment**
2. Click the gear icon → **Web app**
3. Configure:
   - **Description**: Makerspace RFID API
   - **Execute as**: Me
   - **Who has access**: Anyone
4. Click **Deploy**
5. Copy the **Web app URL**
6. This is your `GAS_API_URL` for the ESP32 config

### Step 6: Update ESP32 Configuration

Edit `config.h` in the ESP32 firmware:

```cpp
#define GAS_API_URL "https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec"
```

## API Actions

The script supports these actions via POST requests:

### From ESP32
- `validate_rfid` - Check if RFID is registered
- `log_event` - Log entry/exit event
- `register_user` - Register new user
- `check_rfid` - Check if RFID exists
- `register_rfid_scan` - Record RFID scan during registration

### From Website
- `get_dashboard_data` - Get dashboard statistics
- `get_users` - Get all registered users
- `get_current_inside` - Get users currently inside
- `get_history` - Get access history with filters
- `get_reports` - Get report data
- `update_user` - Update user details
- `delete_user` - Deactivate/remove user
- `update_settings` - Update system settings
- `get_settings` - Get current settings
- `enter_registration_mode` - Trigger registration mode
- `export_excel` - Get data for Excel export
- `login` - Admin authentication

## Security Notes

1. **Admin Credentials** (in Code.gs):
   - Username: `admin`
   - Password: `makerspace123`
   - Change these in production!

2. **API Access**: Set to "Anyone" so ESP32 and website can access

3. **Rate Limits**: Google Apps Script has quotas:
   - 6 minutes execution time per call
   - 90 minutes total daily execution
   - 50,000 URL fetches per day

## Testing

Test the API by visiting the deployed URL:

```
https://script.google.com/macros/s/YOUR_ID/exec?action=get_dashboard_data
```

You should see JSON response with system data.

## Troubleshooting

### "ReferenceError: SPREADSHEET_ID not defined"
- Update `SPREADSHEET_ID` in Code.gs

### "Sheet not found"
- Ensure sheet names match exactly: Users, Access_Log, Current_Status, Settings

### "No access"
- Redeploy with "Anyone" access
- Use new deployment URL

### ESP32 can't connect
- Verify URL is correct
- Check for typos in GAS_API_URL
- Ensure deployment is active
