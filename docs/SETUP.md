# MAKERSPACE RFID ENTRY & EXIT MONITORING SYSTEM
## Complete Setup & Deployment Guide

---

## Table of Contents

1. [System Overview](#system-overview)
2. [Hardware Setup](#hardware-setup)
3. [Google Sheets Setup](#google-sheets-setup)
4. [Google Apps Script Setup](#google-apps-script-setup)
5. [ESP32 Firmware Setup](#esp32-firmware-setup)
6. [Website Deployment](#website-deployment)
7. [Testing Guide](#testing-guide)
8. [Troubleshooting](#troubleshooting)

---

## System Overview

```
RC522 RFID Reader → ESP32 → Wi-Fi → Google Apps Script → Google Sheets
                                                              ↓
                                              Professional Web Dashboard
                                                              ↓
                                                    Excel Export
```

### Components

| Component | Purpose |
|-----------|---------|
| ESP32 DevKit | Main controller |
| RC522 RFID Reader | Read RFID cards |
| OLED Display (128x64) | Show status messages |
| Buzzer | Audio feedback |
| 3x LEDs | Visual status indicators |
| Google Sheets | Cloud data storage |
| Google Apps Script | Cloud API |
| Static Website | User interface |

---

## Hardware Setup

### Required Components

- ESP32 DevKit V1
- RC522 RFID Reader Module
- 0.96" OLED Display (I2C, 128x64)
- Active Buzzer
- 3x LEDs (Green, Red, Blue)
- 3x 220Ω Resistors (for LEDs)
- Jumper Wires (Male-to-Male, Male-to-Female)
- Breadboard
- USB Cable (Micro-USB or USB-C)
- RFID Cards/Tags (for testing)

### Wiring Connections

#### RC522 RFID Reader → ESP32

| RC522 Pin | ESP32 Pin |
|-----------|-----------|
| SDA (SS) | GPIO 5 |
| SCK | GPIO 18 |
| MOSI | GPIO 23 |
| MISO | GPIO 19 |
| RST | GPIO 4 |
| 3.3V | 3.3V |
| GND | GND |

**Important**: RC522 must use 3.3V, NOT 5V!

#### OLED Display → ESP32

| OLED Pin | ESP32 Pin |
|----------|-----------|
| SDA | GPIO 21 |
| SCL | GPIO 22 |
| VCC | 3.3V |
| GND | GND |

#### LEDs → ESP32

| LED | ESP32 Pin | Resistor |
|-----|-----------|----------|
| Green | GPIO 2 | 220Ω |
| Red | GPIO 12 | 220Ω |
| Blue | GPIO 13 | 220Ω |

#### Buzzer → ESP32

| Buzzer Pin | ESP32 Pin |
|------------|-----------|
| + | GPIO 25 |
| - | GND |

---

## Google Sheets Setup

### Step 1: Create Spreadsheet

1. Go to [Google Sheets](https://sheets.google.com)
2. Click **+ Blank** to create new spreadsheet
3. Name it: `Makerspace Access Monitor`
4. Copy the Spreadsheet ID from URL:
   ```
   https://docs.google.com/spreadsheets/d/[SPREADSHEET_ID]/edit
   ```

### Step 2: Create Four Sheets

Create these tabs at the bottom:

#### Sheet 1: Users

| A | B | C | D | E | F | G |
|---|---|---|---|---|---|---|
| RFID_UID | NAME | USER_ID | DEPARTMENT | USER_TYPE | STATUS | REGISTRATION_DATE |

#### Sheet 2: Access_Log

| A | B | C | D | E | F | G | H |
|---|---|---|---|---|---|---|---|
| TIMESTAMP | DATE | TIME | RFID_UID | NAME | USER_ID | ACTION | STATUS |

#### Sheet 3: Current_Status

| A | B | C | D | E |
|---|---|---|---|---|
| RFID_UID | NAME | USER_ID | ENTRY_TIME | CURRENT_STATUS |

#### Sheet 4: Settings

| A | B |
|---|---|
| KEY | VALUE |

**Add initial settings:**

| KEY | VALUE |
|-----|-------|
| SYSTEM_NAME | Makerspace Access Monitor |
| TIMEZONE | Asia/Kolkata |
| RFID_COOLDOWN | 3000 |
| REFRESH_INTERVAL | 5000 |

---

## Google Apps Script Setup

### Step 1: Open Apps Script Editor

1. In your Google Sheet, go to **Extensions → Apps Script**
2. A new tab opens with the script editor

### Step 2: Add the Script

1. Delete any existing code in `Code.gs`
2. Copy the entire contents of `google_apps_script/Code.gs`
3. Paste it into the Apps Script editor

### Step 3: Configure Spreadsheet ID

At the top of `Code.gs`, find and replace:

```javascript
const SPREADSHEET_ID = 'YOUR_SPREADSHEET_ID';
```

With your actual Spreadsheet ID:

```javascript
const SPREADSHEET_ID = '1ABCxyz...your_actual_id_here';
```

### Step 4: Save and Deploy

1. Click the **Save** icon (Ctrl+S)
2. Click **Deploy → New deployment**
3. Click the gear icon → **Web app**
4. Configure:
   - **Description**: Makerspace RFID API v1
   - **Execute as**: Me (your email)
   - **Who has access**: Anyone
5. Click **Deploy**
6. Copy the **Web app URL**
7. Click **Done**

**Important**: Copy the URL! It looks like:
```
https://script.google.com/macros/s/AKfycbx.../exec
```

### Step 5: Test the API

Open a new browser tab and visit:
```
https://script.google.com/macros/s/YOUR_ID/exec?action=get_dashboard_data
```

You should see JSON response with system data.

---

## ESP32 Firmware Setup

### Step 1: Install Arduino IDE

1. Download Arduino IDE from [arduino.cc](https://www.arduino.cc/en/software)
2. Install it on your computer

### Step 2: Install ESP32 Board Package

1. Open Arduino IDE
2. Go to **File → Preferences**
3. In **Additional Boards Manager URLs**, add:
   ```
   https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json
   ```
4. Click **OK**
5. Go to **Tools → Board → Boards Manager**
6. Search for "esp32"
7. Install **esp32 by Espressif Systems**
8. Wait for installation to complete

### Step 3: Install Required Libraries

Go to **Sketch → Include Library → Manage Libraries** and install:

1. **MFRC522** by GithubCommunity (v1.4.10+)
2. **Adafruit SSD1306** by Adafruit (v2.5.7+)
3. **Adafruit GFX Library** by Adafruit (v1.11.5+)
4. **ArduinoJson** by Benoit Blanchon (v6.21.0+)

### Step 4: Open the Firmware

1. Open the file: `esp32_firmware/makerspace_rfid.ino`

### Step 5: Configure WiFi

Edit `config.h`:

```cpp
#define WIFI_SSID "YOUR_WIFI_SSID"
#define WIFI_PASSWORD "YOUR_WIFI_PASSWORD"
```

Replace with your actual WiFi credentials.

### Step 6: Configure API URL

Edit `config.h`:

```cpp
#define GAS_API_URL "https://script.google.com/macros/s/YOUR_SCRIPT_ID/exec"
```

Replace with the URL from Step 4 in Google Apps Script Setup.

### Step 7: Upload to ESP32

1. Connect ESP32 to computer via USB
2. In Arduino IDE, go to **Tools → Board → ESP32 Arduino → ESP32 Dev Module**
3. Go to **Tools → Port** and select the COM port
4. Click **Upload** (→ button)
5. Wait for "Done uploading" message

### Step 8: Verify Operation

1. Go to **Tools → Serial Monitor**
2. Set baud rate to **115200**
3. Press the **EN** button on ESP32
4. You should see:
   ```
   Makerspace RFID System Starting...
   .........
   WiFi connected: 192.168.1.xxx
   ```
5. The OLED display should show: `MAKERSPACE - SCAN RFID CARD`

---

## Website Deployment

### Option 1: GitHub Pages (Recommended)

#### Step 1: Create GitHub Repository

1. Go to [github.com](https://github.com)
2. Click **New repository**
3. Name it: `makerspace-rfid-monitor`
4. Make it **Public**
5. Click **Create repository**

#### Step 2: Upload Website Files

1. Upload these files from the `website/` folder:
   - `index.html`
   - `styles.css`
   - `app.js`

#### Step 3: Configure API URL

Edit `app.js` and change:

```javascript
const API_URL = 'YOUR_GOOGLE_APPS_SCRIPT_URL';
```

With your actual Apps Script URL.

#### Step 4: Enable GitHub Pages

1. Go to **Settings** tab
2. Scroll down to **Pages**
3. Under **Source**, select **Deploy from a branch**
4. Select **main** branch and **/ (root)** folder
5. Click **Save**

#### Step 5: Access Your Website

Your website will be available at:
```
https://YOUR_USERNAME.github.io/makerspace-rfid-monitor/
```

### Option 2: Netlify

1. Go to [netlify.com](https://netlify.com)
2. Sign up/Login
3. Drag and drop the `website/` folder
4. Your site is live!

### Option 3: Local Testing

Simply open `index.html` in a web browser.

---

## Testing Guide

### Test 1: Login

1. Open the website
2. Login with:
   - Username: `admin`
   - Password: `makerspace123`

### Test 2: Dashboard

1. Verify all 4 stat cards show numbers
2. Check system status shows all green
3. Check latest activity displays

### Test 3: Register New User

1. Go to **Users** page
2. Click **+ Register New User**
3. Wait for "RFID Reader Active" message
4. Scan an RFID card on the RC522 reader
5. Card UID should appear on website
6. Fill in user details
7. Click **Register User**
8. Success message should appear

### Test 4: Valid Entry

1. Ensure user is outside (Current_Status = OUTSIDE)
2. Scan the registered RFID card
3. Display shows: `WELCOME - NAME - ENTRY SUCCESS`
4. Dashboard updates entry count
5. User appears in "Currently Inside" page

### Test 5: Already Inside

1. Scan the same card again (while inside)
2. Display shows: `ALREADY INSIDE - NAME`
3. No duplicate entry is created

### Test 6: Valid Exit

1. (This will happen automatically after Test 5)
2. Scan the card again
3. Display shows: `GOODBYE - NAME - EXIT SUCCESS`
4. User removed from "Currently Inside"

### Test 7: Unknown Card

1. Scan an unregistered RFID card
2. Display shows: `UNKNOWN CARD - ACCESS DENIED`
3. Event logged in Access_Log

### Test 8: Offline Operation

1. Disconnect ESP32 from WiFi (or turn off router)
2. Scan an RFID card
3. Events should be stored locally
4. Reconnect WiFi
5. Events should auto-sync to Google Sheets

---

## Configuration Options

### ESP32 Configuration (`config.h`)

```cpp
// WiFi Settings
#define WIFI_SSID "YOUR_WIFI_SSID"
#define WIFI_PASSWORD "YOUR_WIFI_PASSWORD"
#define WIFI_TIMEOUT_MS 15000

// API Settings
#define GAS_API_URL "YOUR_SCRIPT_URL"

// Timing Settings
#define RFID_COOLDOWN_MS 3000          // 3 second cooldown between scans
#define STATUS_SYNC_INTERVAL_MS 30000  // Sync every 30 seconds
#define WIFI_CHECK_INTERVAL_MS 10000   // Check WiFi every 10 seconds

// Storage Settings
#define MAX_PENDING_EVENTS 50          // Max offline events to store
#define MAX_LOCAL_USERS 100            // Max users to store locally
```

### Website Configuration (`app.js`)

```javascript
const API_URL = 'YOUR_GOOGLE_APPS_SCRIPT_URL';
const REFRESH_INTERVAL = 5000;  // Auto-refresh every 5 seconds
const DEMO_MODE = false;        // Set true for demo/presentation
```

### Admin Credentials (`Code.gs`)

```javascript
// Change these for production!
if (username === 'admin' && password === 'makerspace123') {
  // Login success
}
```

---

## Troubleshooting

### ESP32 Issues

| Problem | Solution |
|---------|----------|
| Won't upload | Check COM port, hold BOOT button during upload |
| WiFi won't connect | Verify SSID/password, ensure 2.4GHz network |
| RFID not reading | Check wiring, ensure 3.3V power |
| Display not working | Check I2C connections, try address 0x3D |

### Website Issues

| Problem | Solution |
|---------|----------|
| Can't login | Verify admin credentials in Code.gs |
| No data loading | Check API URL in app.js |
| CORS error | Apps Script may need redeployment |
| Empty dashboard | Check Google Sheets has data |

### Apps Script Issues

| Problem | Solution |
|---------|----------|
| "ReferenceError" | Update SPREADSHEET_ID |
| "Sheet not found" | Create sheets with exact names |
| "No access" | Redeploy with "Anyone" access |
| Timeout error | Reduce data size, optimize code |

### Common Errors

**"Script not found"**
- Redeploy Apps Script
- Use new deployment URL

**"Permission denied"**
- Share Google Sheet with Apps Script
- Set deployment to "Anyone"

**"ESP32 keeps restarting"**
- Check power supply
- Verify wiring connections
- Check Serial Monitor for errors

---

## Demo Mode

For college presentations, enable Demo Mode:

1. Open `app.js`
2. Change: `const DEMO_MODE = false;` to `const DEMO_MODE = true;`
3. This provides simulated data without hardware

**Note**: Set `DEMO_MODE = false` for production use.

---

## Project Structure

```
makerspace-rfid/
├── esp32_firmware/
│   ├── makerspace_rfid.ino      # Main ESP32 firmware
│   ├── config.h                 # Configuration settings
│   ├── display_manager.h        # OLED display manager
│   ├── display_manager.cpp      # Display implementation
│   ├── local_storage.h          # Local storage manager
│   ├── local_storage.cpp        # Storage implementation
│   └── README.md                # ESP32 documentation
├── google_apps_script/
│   ├── Code.gs                  # Apps Script backend
│   └── README.md                # Setup instructions
├── website/
│   ├── index.html               # Main HTML
│   ├── styles.css               # CSS styling
│   └── app.js                   # JavaScript logic
└── docs/
    └── SETUP.md                 # This file
```

---

## Final Checklist

- [ ] Google Sheet created with 4 sheets
- [ ] Apps Script deployed as Web App
- [ ] ESP32 firmware uploaded
- [ ] WiFi credentials configured
- [ ] API URL configured in ESP32
- [ ] Website hosted online
- [ ] API URL configured in website
- [ ] Admin credentials changed (for production)
- [ ] All tests passed
- [ ] System working without laptop

---

## Support

For issues or questions:
1. Check Troubleshooting section
2. Verify all wiring connections
3. Check Serial Monitor output
4. Verify Google Sheets API access
5. Test API URL directly in browser
