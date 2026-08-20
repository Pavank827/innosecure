#ifndef CONFIG_H
#define CONFIG_H

// ==================== WIFI CONFIGURATION ====================
#define WIFI_SSID "YOUR_WIFI_SSID"
#define WIFI_PASSWORD "YOUR_WIFI_PASSWORD"
#define WIFI_TIMEOUT_MS 15000

// ==================== GOOGLE APPS SCRIPT ====================
// Replace with your deployed Google Apps Script Web App URL
#define GAS_API_URL "https://script.google.com/macros/s/YOUR_SCRIPT_ID/exec"

// ==================== RC522 RFID PINS ====================
#define RC522_SS_PIN    5
#define RC522_RST_PIN   4
// SPI: MOSI=23, MISO=19, SCK=18 (default HSPI)

// ==================== DISPLAY PINS (I2C OLED 128x64) ====================
#define OLED_SDA        21
#define OLED_SCL        22
#define OLED_WIDTH      128
#define OLED_HEIGHT     64

// ==================== BUZZER PIN ====================
#define BUZZER_PIN      25

// ==================== SYSTEM SETTINGS ====================
#define RFID_COOLDOWN_MS        3000
#define STATUS_SYNC_INTERVAL_MS 30000
#define WIFI_CHECK_INTERVAL_MS  10000
#define MAX_PENDING_EVENTS      50
#define MAX_LOCAL_USERS         100

// ==================== LED PINS ====================
#define LED_GREEN_PIN   2
#define LED_RED_PIN     12
#define LED_BLUE_PIN    13

// ==================== TIMEZONE ====================
#define NTP_SERVER "pool.ntp.org"
#define GMT_OFFSET_SEC 19800   // UTC+5:30 for India
#define DAYLIGHT_OFFSET_SEC 0

#endif
