# InnoSecure Deployment Guide

## Step 1: Deploy Website to GitHub Pages

### Prerequisites
- GitHub account
- Git installed on your computer

### Commands to Run

```bash
# Navigate to project directory
cd C:\Users\Pavan kumar kp\makerspace-rfid

# Initialize git (if not already done)
git init

# Add all files
git add .

# Commit
git commit -m "Initial InnoSecure deployment"

# Create GitHub repository first at https://github.com/new
# Repository name: innosecure
# Then run:
git remote add origin https://github.com/YOUR_USERNAME/innosecure.git
git branch -M main
git push -u origin main
```

### Enable GitHub Pages
1. Go to your repository on GitHub
2. Click **Settings** → **Pages**
3. Source: **Deploy from a branch**
4. Branch: **main** / **/ (root)**
5. Click **Save**
6. Wait 2-3 minutes
7. Your site is live at: `https://YOUR_USERNAME.github.io/innosecure/`

---

## Step 2: Set Up Google Sheets

### Create Spreadsheet
1. Go to https://sheets.google.com
2. Click **+ Blank** to create new spreadsheet
3. Name it: **InnoSecure Database**
4. Copy the Spreadsheet ID from URL:
   - URL: `https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/edit`
   - The ID is the long string between `/d/` and `/edit`

### Create Sheets
Create these 5 sheets (tabs at bottom):

| Sheet Name | Headers |
|------------|---------|
| Users | RFID_UID, NAME, USER_ID, DEPARTMENT, USER_TYPE, STATUS, REGISTRATION_DATE |
| Access_Log | TIMESTAMP, DATE, TIME, RFID_UID, NAME, USER_ID, ACTION, STATUS |
| Current_status | RFID_UID, NAME, USER_ID, ENTRY_TIME, CURRENT_STATUS |
| Admin_Accounts | FULL_NAME, USERNAME, PASSWORD_HASH, CREATED_AT |
| Registration_Request | REQUEST_ID, STATUS, RFID_UID, CREATED_AT, UPDATED_AT |

---

## Step 3: Deploy Google Apps Script

### Open Apps Script
1. Open your Google Sheet
2. Click **Extensions** → **Apps Script**
3. Delete any existing code
4. Copy all code from `google_apps_script/Code.gs`
5. Paste into the Apps Script editor

### Configure
1. Find line: `const SPREADSHEET_ID = 'YOUR_SPREADSHEET_ID';`
2. Replace `YOUR_SPREADSHEET_ID` with your actual Spreadsheet ID
3. Click **Save** (disk icon)

### Initialize Sheets
1. In Apps Script editor, select function: `initializeSpreadsheet`
2. Click **Run**
3. Authorize when prompted
4. Check your Google Sheets - all sheets should be created

### Deploy as Web App
1. Click **Deploy** → **New deployment**
2. Click gear icon → **Web app**
3. Description: `InnoSecure API`
4. Execute as: **Me**
5. Who has access: **Anyone**
6. Click **Deploy**
7. Copy the Web app URL (looks like: `https://script.google.com/macros/s/AKfycbx.../exec`)

---

## Step 4: Connect Website to Apps Script

### Update app.js
1. Open `website/app.js`
2. Find line: `const API_URL = 'YOUR_GOOGLE_APPS_SCRIPT_URL';`
3. Replace with your actual Apps Script URL
4. Find line: `const DEMO_MODE = true;`
5. Change to: `const DEMO_MODE = false;`
6. Save the file

### Push Changes to GitHub
```bash
cd C:\Users\Pavan kumar kp\makerspace-rfid
git add website/app.js
git commit -m "Connect to Apps Script API"
git push
```

### Create Admin Account
1. Go to your live website
2. Click **Create Admin Account**
3. Enter your details
4. Username: `admin`
5. Password: `makerspace123`
6. Click **Create Account**
7. Login with those credentials

---

## Step 5: Set Up ESP32

### Install Arduino Libraries
1. Open Arduino IDE
2. Go to **Sketch** → **Include Library** → **Manage Libraries**
3. Install:
   - MFRC522
   - Adafruit SSD1306
   - Adafruit GFX Library
   - ArduinoJson

### Configure ESP32
1. Open `esp32_firmware/config.h`
2. Update:
   ```cpp
   #define WIFI_SSID "YOUR_WIFI_NAME"
   #define WIFI_PASSWORD "YOUR_WIFI_PASSWORD"
   #define GAS_API_URL "YOUR_APPS_SCRIPT_URL"
   ```
3. Upload `innosecure.ino` to ESP32

---

## Testing Checklist

- [ ] Website loads at GitHub Pages URL
- [ ] Can create admin account
- [ ] Can login with created credentials
- [ ] Dashboard shows data
- [ ] Users page shows registered users
- [ ] Can register new user via RFID
- [ ] RFID entry/exit works
- [ ] History shows records
- [ ] Reports generate correctly
- [ ] Excel export downloads
- [ ] ESP32 connects to WiFi
- [ ] ESP32 reads RFID cards
- [ ] Offline events sync when WiFi returns

---

## Troubleshooting

### Website shows "Invalid credentials"
- Clear browser localStorage
- Create a new admin account

### Apps Script error
- Check SPREADSHEET_ID is correct
- Redeploy the web app
- Copy new URL

### ESP32 won't connect
- Check WiFi credentials (2.4GHz only)
- Verify Apps Script URL is correct
- Check serial monitor for errors

### RFID not reading
- Check wiring connections
- Ensure 3.3V power to RC522
- Check SPI pins match code
