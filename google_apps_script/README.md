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

Create these 5 sheets in your spreadsheet:

1. **Users** - Registered user data
2. **Access_Log** - Entry/Exit event log
3. **Current_status** - Current inside/outside status
4. **Admin_Accounts** - Admin account credentials
5. **Registration_Request** - RFID registration requests

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
| A | B | C | D | E | F |
|---|---|---|---|---|---|
| RFID_UID | NAME | USER_ID | ENTRY_TIME | EXIT_TIME | CURRENT_STATUS |

#### Sheet: Admin_Accounts
| A | B | C | D |
|---|---|---|---|
| FULL_NAME | USERNAME | PASSWORD_HASH | CREATED_AT |

#### Sheet: Registration_Request
| A | B | C | D | E |
|---|---|---|---|---|
| REQUEST_ID | STATUS | RFID_UID | CREATED_AT | UPDATED_AT |

### Step 4: Create Apps Script

1. In your Google Sheet, go to **Extensions → Apps Script**
2. Delete any existing code
3. Copy the contents of `Code.gs` from this folder
4. Paste it into the Apps Script editor
5. Update `SPREADSHEET_ID` at the top with your spreadsheet ID
6. Click **Save**

> **Important:** editing the script is not enough. Apps Script keeps serving the
> *deployed version*, so every time you change `Code.gs` you must publish it
> again (Step 5). Otherwise the ESP32 and website keep calling the old code.

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

**To update an existing deployment** after editing `Code.gs`:
**Deploy → Manage deployments → (edit) → Version: New version → Deploy**.
Using "New deployment" creates a *different* URL; "New version" keeps the same
URL, which is what the ESP32 and website already have configured.

### Step 6: Update ESP32 Configuration

Edit `config.h` in the ESP32 firmware:

```cpp
#define GAS_API_URL "https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec"
```

## API Actions

The script supports these actions via POST requests. Marked **(auth)** actions
require a valid `auth_token` in the payload as soon as at least one row exists
in `Admin_Accounts`.

### From ESP32
- `validate_rfid` - Check if RFID is registered
- `log_event` - Log entry/exit event
- `register_user` - Register new user
- `check_rfid` - Check if RFID exists
- `register_rfid_scan` - Record RFID scan during registration
- `get_pending_rfid_registration` - Discover a waiting web registration request
- `rfid_registration_result` - Store the card UID for a request

### From Website
- `get_dashboard_data` - Get dashboard statistics
- `get_users` - Get all registered users
- `get_current_inside` - Get users currently inside
- `get_history` - Get access history with filters
- `get_reports` - Get report data
- `update_user` - Update user details **(auth)**
- `delete_user` - Remove user **(auth)**
- `delete_history_record` - Remove one Access_Log row **(auth, POST only)**

  The client echoes the eight columns it rendered (timestamp, date, time,
  RFID UID, name, user ID, action, status). A row is deleted only when all
  eight match exactly, and at most one row (the newest match) is removed, so
  a stale table can never delete a different record. Two rows with identical
  content are indistinguishable by design; the newest of the pair is deleted
  first. This action is not reachable via GET.
- `enter_registration_mode` - Trigger registration mode
- `start_rfid_registration` - Start RFID registration process
- `get_rfid_registration_status` - Get RFID registration status
- `rfid_registration_result` - Store RFID scan result
- `export_excel` - Get data for Excel export **(auth)**
- `login` - Admin authentication (returns a signed `token`)
- `create_admin_account` - Create new admin account **(auth once accounts exist)**

A GET request with `?action=health` is used by the ESP32 `5` serial command.

## Security Notes

1. **Admin credentials**: there are no hardcoded accounts. Create the first
   account from the website, then log in. Passwords are stored in
   `Admin_Accounts.PASSWORD_HASH` as `s2_<salted SHA-256>`; the salt is a
   secret generated automatically and kept in Script Properties (`AUTH_SECRET`).
   Rows written by older versions (`h_...`) are still accepted and are upgraded
   to the new format on the next successful login.

2. **Session tokens**: `login` returns `t1_<expiry>_<signature>_<username>`,
   signed with `AUTH_SECRET` and valid for 12 hours. `app.js` attaches it
   automatically as `auth_token`.

3. **API Access**: Set to "Anyone" so ESP32 and website can access. Anyone who
   knows the URL can call the *read* actions - keep the spreadsheet private and
   rotate the deployment URL if it leaks.

4. **Rate Limits**: Google Apps Script has quotas:
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
- Ensure sheet names match exactly: Users, Access_Log, Current_status, Admin_Accounts, Registration_Request

### "No access"
- Redeploy with "Anyone" access
- Use new deployment URL

### ESP32 can't connect
- Verify URL is correct
- Check for typos in GAS_API_URL
- Ensure deployment is active

### ESP32 logs HTTP 400 for every request
- Google answers POSTs with `302 Found`. Older firmware let the ESP32 HTTPClient
  follow it automatically, which kept the POST's `Content-Length` header on the
  follow-up GET - Google rejects that with `400 Bad Request`. The firmware now
  disables automatic redirects and follows the `Location` with a clean GET
  (`makeApiCall()` / `sendHttps()`), so rebuild and re-upload the sketch in
  `esp32_firmware/makerspace_rfid/`.

### Responses still look stale after editing Code.gs
- Redeploy: **Deploy → Manage deployments → New version**. The web app keeps
  serving the previously deployed version until you do.
