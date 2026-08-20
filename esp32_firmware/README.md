# ESP32 Firmware - Makerspace RFID Entry/Exit System

## Hardware Requirements

- ESP32 DevKit V1
- RC522 RFID Reader Module
- 0.96" OLED Display (I2C, 128x64)
- Buzzer (Active)
- 3x LEDs (Green, Red, Blue)
- Jumper Wires
- Breadboard

## Wiring Diagram

```
RC522 RFID Reader    ESP32 DevKit
─────────────────    ────────────
SDA (SS)           → GPIO 5
SCK                → GPIO 18
MOSI               → GPIO 23
MISO               → GPIO 19
RST                → GPIO 4
3.3V               → 3.3V
GND                → GND

OLED Display (I2C)  ESP32 DevKit
─────────────────   ────────────
SDA                → GPIO 21
SCL                → GPIO 22
VCC                → 3.3V
GND                → GND

Buzzer              ESP32 DevKit
─────────          ────────────
+                  → GPIO 25
-                  → GND

LEDs                ESP32 DevKit
────               ────────────
Green +            → GPIO 2 (via 220Ω)
Red +              → GPIO 12 (via 220Ω)
Blue +             → GPIO 13 (via 220Ω)
All LED -          → GND
```

## Required Libraries

Install these libraries via Arduino IDE Library Manager:

1. **MFRC522** by GithubCommunity (v1.4.10+)
2. **Adafruit SSD1306** by Adafruit (v2.5.7+)
3. **Adafruit GFX Library** by Adafruit (v1.11.5+)
4. **ArduinoJson** by Benoit Blanchon (v6.21.0+)
5. **WiFi** (built-in with ESP32 board package)
6. **HTTPClient** (built-in with ESP32 board package)

## Setup Instructions

### Step 1: Install ESP32 Board Package

1. Open Arduino IDE
2. Go to File → Preferences
3. In "Additional Boards Manager URLs" add:
   ```
   https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json
   ```
4. Go to Tools → Board → Boards Manager
5. Search for "esp32" and install "esp32 by Espressif Systems"

### Step 2: Configure WiFi

Edit `config.h` and change:

```cpp
#define WIFI_SSID "YOUR_WIFI_SSID"
#define WIFI_PASSWORD "YOUR_WIFI_PASSWORD"
```

### Step 3: Configure Google Apps Script URL

Edit `config.h` and change:

```cpp
#define GAS_API_URL "https://script.google.com/macros/s/YOUR_SCRIPT_ID/exec"
```

To get this URL:
1. Create the Google Apps Script (see google_apps_script/README.md)
2. Deploy it as a Web App
3. Copy the deployment URL

### Step 4: Upload Firmware

1. Connect ESP32 to computer via USB
2. In Arduino IDE, go to Tools → Board → ESP32 Arduino → ESP32 Dev Module
3. Select correct COM port
4. Click Upload

### Step 5: Verify Operation

1. Open Serial Monitor (115200 baud)
2. You should see:
   ```
   Makerspace RFID System Starting...
   WiFi connected: 192.168.1.xxx
   ```
3. OLED should show "MAKERSPACE - SCAN RFID CARD"

## Serial Commands

You can send these commands via Serial Monitor:

- `REG_START` - Enter registration mode
- `REG_USER:name|id|dept|type` - Register user with details
- `REG_CANCEL` - Cancel registration
- `STATUS` - Get current system status

## Local Storage

The ESP32 stores data locally using Preferences (NVS Flash):

- **Users**: RFID UID, Name, User ID, Current Status
- **Pending Events**: Events queued for sync when offline
- **Settings**: System configuration

Local storage ensures the system continues working even when WiFi is unavailable.

## Offline Operation

When WiFi disconnects:
- RFID scanning continues normally
- Events are stored locally in flash memory
- When WiFi reconnects, pending events auto-sync
- No data is lost during internet outages

## Troubleshooting

### RFID Reader Not Working
- Check wiring connections
- Ensure 3.3V power (NOT 5V)
- Verify SPI pins are correct

### OLED Not Displaying
- Check I2C connections
- Try address 0x3C or 0x3D
- Verify SDA/SCL pins

### WiFi Won't Connect
- Verify SSID and password
- Check WiFi signal strength
- Ensure 2.4GHz network (ESP32 doesn't support 5GHz)

### API Calls Failing
- Verify Apps Script URL in config.h
- Check internet connection
- Deploy Apps Script with proper permissions
