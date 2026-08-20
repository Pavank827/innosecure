# INNOSECURE

## Innovation Lab RFID Entry & Exit Monitoring System

A professional, reliable, and low-cost Innovation Lab access monitoring system using ESP32, RC522 RFID reader, Google Sheets, and a hosted web dashboard.

---

## Features

- **RFID-based Access Control** - Entry and exit using RFID cards
- **Automatic Entry/Exit Detection** - System determines if user is entering or exiting
- **Duplicate Entry Protection** - Prevents multiple entry records
- **Invalid Exit Prevention** - Blocks exit if user is not inside
- **Real-time Dashboard** - Live monitoring of all activity
- **User Registration** - Register new users via website + physical RFID scan
- **Currently Inside View** - See who is currently in the Innovation Lab
- **Complete History** - Full access log with filters
- **Reports & Excel Export** - Generate and download reports
- **Offline Operation** - Continues working when WiFi is unavailable
- **Auto-sync** - Pending events upload when connection returns
- **Cloud-hosted Website** - Accessible from anywhere, laptop-independent
- **Admin Authentication** - Secure login for administrators

---

## System Architecture

```
┌─────────────────┐
│  RC522 RFID     │
│  Reader         │
└────────┬────────┘
         │ SPI
         ▼
┌─────────────────┐     Wi-Fi     ┌─────────────────┐
│  ESP32 DevKit   │──────────────▶│  Google Apps    │
│  + OLED Display │               │  Script API     │
│  + Buzzer + LEDs│               └────────┬────────┘
└─────────────────┘                        │
                                           ▼
                               ┌─────────────────┐
                               │  Google Sheets  │
                               │  (Database)     │
                               └────────┬────────┘
                                        │
                                        ▼
                               ┌─────────────────┐
                               │  Web Dashboard  │
                               │  (GitHub Pages) │
                               └─────────────────┘
```

---

## Quick Start

### 1. Hardware Setup

See `docs/SETUP.md` for complete wiring instructions.

**Required Components:**
- ESP32 DevKit V1
- RC522 RFID Reader
- 0.96" OLED Display (I2C)
- Active Buzzer
- 3x LEDs (Green, Red, Blue)
- Jumper Wires
- Breadboard

### 2. Google Sheets Setup

1. Create new Google Sheet
2. Create 5 sheets: Users, Access_Log, Current_status, Admin_Accounts, Registration_Request
3. Add headers as specified in `docs/SETUP.md`

### 3. Google Apps Script Setup

1. Open Extensions → Apps Script
2. Paste contents of `google_apps_script/Code.gs`
3. Update SPREADSHEET_ID
4. Deploy as Web App (Anyone access)
5. Copy deployment URL

### 4. ESP32 Firmware

1. Install Arduino IDE + ESP32 board package
2. Install required libraries (MFRC522, Adafruit SSD1306, ArduinoJson)
3. Edit `config.h` with WiFi credentials and API URL
4. Upload firmware to ESP32

### 5. Website Deployment

1. Upload `website/` files to GitHub repository
2. Edit `app.js` with your API URL
3. Enable GitHub Pages
4. Access your website

---

## Project Structure

```
innosecure/
├── esp32_firmware/           # ESP32 Arduino code
│   ├── innosecure.ino        # Main firmware
│   ├── config.h              # Configuration
│   ├── display_manager.*     # OLED display
│   └── local_storage.*       # Offline storage
├── google_apps_script/       # Cloud API
│   └── Code.gs               # Apps Script code
├── website/                  # Web dashboard
│   ├── index.html            # HTML structure
│   ├── styles.css            # CSS styling
│   └── app.js                # JavaScript logic
└── docs/                     # Documentation
    └── SETUP.md              # Complete setup guide
```

---

## How It Works

### Entry Flow
1. User scans RFID card on RC522 reader
2. ESP32 identifies user from local/cloud database
3. If user is OUTSIDE → Record ENTRY, set status to INSIDE
4. Display shows "WELCOME - NAME"
5. Event logged to Google Sheets
6. Dashboard updates automatically

### Exit Flow
1. User scans RFID card again
2. ESP32 checks current status
3. If user is INSIDE → Record EXIT, set status to OUTSIDE
4. Display shows "GOODBYE - NAME"
5. User removed from "Currently Inside"

### Registration Flow
1. Admin clicks "Register New User" on website
2. ESP32 enters Registration Mode
3. Display shows "SCAN YOUR CARD"
4. User scans new RFID card
5. UID sent to website
6. Admin enters user details
7. User saved to Google Sheets
8. System returns to normal mode

---

## Configuration

### ESP32 (`config.h`)

```cpp
#define WIFI_SSID "YOUR_WIFI"
#define WIFI_PASSWORD "YOUR_PASSWORD"
#define GAS_API_URL "YOUR_APPS_SCRIPT_URL"
#define RFID_COOLDOWN_MS 3000
```

### Website (`app.js`)

```javascript
const API_URL = 'YOUR_APPS_SCRIPT_URL';
const REFRESH_INTERVAL = 5000;
const DEMO_MODE = false;
```

---

## Testing Checklist

- [ ] Login works with admin credentials
- [ ] Dashboard shows correct statistics
- [ ] New user registration works
- [ ] RFID card triggers entry
- [ ] Same card triggers exit
- [ ] Duplicate entry blocked
- [ ] Invalid exit blocked
- [ ] Unknown card shows access denied
- [ ] Currently Inside page updates
- [ ] History page shows records
- [ ] Reports generate correctly
- [ ] Excel export downloads
- [ ] Website works without laptop
- [ ] ESP32 works offline
- [ ] Events sync when WiFi returns

---

## Troubleshooting

See `docs/SETUP.md` for detailed troubleshooting guide.

**Common Issues:**
- ESP32 won't connect to WiFi → Check credentials, use 2.4GHz
- RFID not reading → Check wiring, ensure 3.3V power
- Website shows no data → Verify API URL in app.js
- Apps Script error → Check SPREADSHEET_ID, redeploy

---

## License

This project is for educational purposes. Free to use and modify.

---

## Credits

Built for college project demonstration.
