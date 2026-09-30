/**
 * INNOSECURE - Innovation Lab RFID Campus Entry & Exit Monitoring System
 * ESP32 Firmware with Dual-Mode (Real Hardware + Hardware Simulation)
 *
 * Hardware:
 * - MFRC522 RFID Reader
 * - TFT Display through DisplayManager
 * - Buzzer
 * - ESP32
 *
 * LED functionality REMOVED
 *
 * Supports:
 * - Real MFRC522 RFID Reader via SPI
 * - TFT Display through display_manager.h
 * - Buzzer Audio Feedback
 * - Interactive Serial Monitor Hardware Simulation Menu
 * - Google Apps Script Cloud API & Google Sheets Synchronization
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <SPI.h>
#include <MFRC522.h>
#include <ArduinoJson.h>
#include <time.h>

#include "config.h"
#include "display_manager.h"
#include "local_storage.h"

// ==================== OBJECTS ====================

MFRC522 mfrc522(RC522_SS_PIN, RC522_RST_PIN);
DisplayManager display;
LocalStorage storage;

// ==================== STATE ====================

enum SystemMode {
  NORMAL_MODE,
  REGISTRATION_MODE,
  WAITING_CARD_MODE
};

SystemMode currentMode = NORMAL_MODE;

enum WifiState {
  WIFI_DISCONNECTED,
  WIFI_CONNECTING,
  WIFI_CONNECTED
};

WifiState wifiState = WIFI_DISCONNECTED;

bool registrationWaitingCard = false;

String pendingRegistrationUID = "";
String lastScannedUID = "";

unsigned long lastScanTime = 0;
unsigned long lastStatusSync = 0;
unsigned long lastWifiCheck = 0;

// ==================== WEB REGISTRATION REQUEST POLLING ====================

const unsigned long REG_POLL_INTERVAL_MS = 2000;
const unsigned long REG_MODE_TIMEOUT_MS = 70000;

unsigned long lastRegPollTime = 0;

bool regModeActive = false;
bool regModeEnteredByPoll = false;
String activeRegRequestId = "";
unsigned long regModeEnteredAt = 0;

// ==================== TEST DEFAULT CARDS ====================

const String DEFAULT_VALID_UID = "A1B2C3D4";
const String DEFAULT_INVALID_UID = "E2000019";

// ==================== FUNCTION DECLARATIONS ====================

void connectWifi();
void checkWifi();

String makeApiCall(String action, String data);
String formatTimestamp();
String formatUID(byte *buffer, byte bufferSize);

void handleNormalScan(String uid, String forceAction = "AUTO");
void handleRegistrationScan(String uid);

void syncPendingEvents();

void checkPendingRegistration();
void exitRegistrationMode();

void beepBuzzer(int durationMs);

void printTestMenu();
void processSerialCommand(String cmd);

void testApiConnection();
void testGoogleSheetsConnection();

void simulateRegistration(
  String uid,
  String name,
  String userId,
  String dept,
  String userType
);

// ==================== SETUP ====================

void setup() {

  Serial.begin(115200);
  delay(500);

  // Only buzzer is initialized.
  // LED initialization has been removed.
  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, LOW);

  // Initialize display
  display.begin();

  // Initialize local storage
  storage.begin();

  // Initialize SPI
  SPI.begin();

  // Initialize MFRC522
  mfrc522.PCD_Init();

  Serial.println("\n==================================================");
  Serial.println("  INNOSECURE CAMPUS ENTRY & EXIT MONITORING SYSTEM");
  Serial.println("  ESP32 Firmware + Hardware Simulation Controller");
  Serial.println("==================================================");

#if HARDWARE_SIMULATION_MODE

  Serial.println("[MODE] SIMULATION & REAL HARDWARE ACTIVE");

#else

  Serial.println("[MODE] REAL HARDWARE ONLY");

#endif

  display.showWifiConnecting();

  connectWifi();

  configTime(
    GMT_OFFSET_SEC,
    DAYLIGHT_OFFSET_SEC,
    NTP_SERVER
  );

  display.showIdleScreen();

  printTestMenu();
}

// ==================== MAIN LOOP ====================

void loop() {

  unsigned long currentTime = millis();

  // ==================== WIFI CHECK ====================

  if (currentTime - lastWifiCheck > WIFI_CHECK_INTERVAL_MS) {

    checkWifi();

    lastWifiCheck = currentTime;
  }

  // ==================== OFFLINE EVENT SYNC ====================

  if (
    wifiState == WIFI_CONNECTED &&
    currentTime - lastStatusSync > STATUS_SYNC_INTERVAL_MS
  ) {

    syncPendingEvents();

    lastStatusSync = currentTime;
  }

  // ==================== WEB REGISTRATION REQUEST POLL ====================
  // Non-blocking: returns immediately except once per REG_POLL_INTERVAL_MS.
  // Detects a WAITING request created by the website's READ RFID button and
  // switches this device into REGISTRATION_MODE automatically (no REGMODE
  // serial command needed).

  checkPendingRegistration();

  // ==================== SERIAL SIMULATION ====================

  if (Serial.available()) {

    String command = Serial.readStringUntil('\n');

    command.trim();

    if (command.length() > 0) {

      processSerialCommand(command);
    }
  }

  // ==================== PHYSICAL RFID SCAN ====================

  if (
    mfrc522.PICC_IsNewCardPresent() &&
    mfrc522.PICC_ReadCardSerial()
  ) {

    String uid = formatUID(
      mfrc522.uid.uidByte,
      mfrc522.uid.size
    );

    mfrc522.PICC_HaltA();

    mfrc522.PCD_StopCrypto1();

    // RFID cooldown protection
    if (
      uid == lastScannedUID &&
      (currentTime - lastScanTime) < RFID_COOLDOWN_MS
    ) {

      return;
    }

    lastScannedUID = uid;
    lastScanTime = currentTime;

    Serial.println(
      "\n[MFRC522 HARDWARE SCAN] Card UID Detected: " + uid
    );

    switch (currentMode) {

      case NORMAL_MODE:

        handleNormalScan(uid, "AUTO");

        break;

      case REGISTRATION_MODE:

        handleRegistrationScan(uid);

        break;

      default:

        break;
    }
  }
}

// ==================================================
// WIFI FUNCTIONS
// ==================================================

void connectWifi() {

  wifiState = WIFI_CONNECTING;

  Serial.print(
    "Connecting to Wi-Fi (" +
    String(WIFI_SSID) +
    ")"
  );

  WiFi.begin(
    WIFI_SSID,
    WIFI_PASSWORD
  );

  int attempts = 0;

  while (
    WiFi.status() != WL_CONNECTED &&
    attempts < 20
  ) {

    delay(500);

    Serial.print(".");

    attempts++;
  }

  if (WiFi.status() == WL_CONNECTED) {

    wifiState = WIFI_CONNECTED;

    Serial.println(
      "\n[Wi-Fi] CONNECTED! IP Address: " +
      WiFi.localIP().toString()
    );

    Serial.println(
      "[API URL] " +
      String(GAS_API_URL)
    );

    display.showWifiConnected();

    delay(1000);

  } else {

    wifiState = WIFI_DISCONNECTED;

    Serial.println(
      "\n[Wi-Fi] NOT CONNECTED "
      "(Running in Simulation / Offline Mode)"
    );

    display.showWifiDisconnected();

    delay(1000);
  }
}

// ==================================================

void checkWifi() {

  if (WiFi.status() != WL_CONNECTED) {

    if (wifiState == WIFI_CONNECTED) {

      Serial.println(
        "[Wi-Fi] Connection lost. "
        "Switching to offline cache."
      );
    }

    wifiState = WIFI_DISCONNECTED;

  } else {

    if (wifiState == WIFI_DISCONNECTED) {

      Serial.println(
        "[Wi-Fi] Connection restored."
      );
    }

    wifiState = WIFI_CONNECTED;
  }
}

// ==================================================
// API CALL
// ==================================================

String makeApiCall(
  String action,
  String data
) {

  if (wifiState != WIFI_CONNECTED) {

    return "{\"success\":false,\"message\":\"Wi-Fi offline\"}";
  }

  HTTPClient http;

  http.begin(GAS_API_URL);

  http.setFollowRedirects(
    HTTPC_STRICT_FOLLOW_REDIRECTS
  );

  http.setTimeout(15000);

  http.addHeader(
    "Content-Type",
    "application/json"
  );

  String payload =
    "{\"action\":\"" +
    action +
    "\",\"data\":" +
    data +
    "}";

  int httpCode = http.POST(payload);

  String response = "";

  if (httpCode > 0) {

    response = http.getString();

  } else {

    Serial.println(
      "[HTTP Error] Code: " +
      String(httpCode) +
      " (" +
      http.errorToString(httpCode) +
      ")"
    );

    response =
      "{\"success\":false,\"message\":\"HTTP Error " +
      String(httpCode) +
      "\"}";
  }

  http.end();

  return response;
}

// ==================================================
// NORMAL RFID SCAN
// ==================================================

void handleNormalScan(
  String uid,
  String forceAction
) {

  Serial.println(
    "\n--------------------------------------------------"
  );

  Serial.println(
    ">>> PROCESSING RFID SCAN: " +
    uid
  );

  // LED scanning indication REMOVED.

  LocalUser user;

  bool userFound = false;

  // ==================================================
  // 1. QUERY GOOGLE APPS SCRIPT
  // ==================================================

  if (wifiState == WIFI_CONNECTED) {

    String data =
      "{\"rfid_uid\":\"" +
      uid +
      "\"}";

    String response =
      makeApiCall(
        "validate_rfid",
        data
      );

    StaticJsonDocument<1024> doc;

    DeserializationError error =
      deserializeJson(
        doc,
        response
      );

    if (
      !error &&
      doc["success"].as<bool>() &&
      doc.containsKey("data")
    ) {

      JsonObject obj =
        doc["data"];

      if (
        obj.containsKey("registered") &&
        obj["registered"].as<bool>()
      ) {

        userFound = true;

        user.rfidUID = uid;

        user.name =
          obj["name"].as<String>();

        user.userId =
          obj["user_id"].as<String>();

        user.currentStatus =
          obj["current_status"].as<String>();

        if (
          user.currentStatus.length() == 0
        ) {

          user.currentStatus = "OUTSIDE";
        }

        // Cache user details locally
        storage.addOrUpdateUser(
          uid,
          user.name,
          user.userId,
          user.currentStatus
        );
      }
    }
  }

  // ==================================================
  // 2. LOCAL CACHE FALLBACK
  // ==================================================

  if (!userFound) {

    userFound =
      storage.getUser(
        uid,
        user
      );
  }

  // ==================================================
  // 3. UNKNOWN / INVALID CARD
  // ==================================================

  if (!userFound) {

    Serial.println(
      "RFID UID             : " +
      uid
    );

    Serial.println(
      "User Name            : [Unknown / Unregistered]"
    );

    Serial.println(
      "User ID              : N/A"
    );

    Serial.println(
      "Authorization Result : DENIED"
    );

    Serial.println(
      "Action               : ACCESS REJECTED"
    );

    Serial.println(
      "[HARDWARE FEEDBACK]  : Error Buzzer (500ms)"
    );

    display.showUnknownCard();

    beepBuzzer(500);

    delay(2000);

    // ==================================================
    // LOG UNKNOWN / DENIED ATTEMPT
    // ==================================================

    if (wifiState == WIFI_CONNECTED) {

      String timestamp =
        formatTimestamp();

      String data =
        "{\"rfid_uid\":\"" +
        uid +
        "\",\"name\":\"Unknown\",\"user_id\":\"N/A\",\"action\":\"UNKNOWN\",\"status\":\"DENIED\",\"timestamp\":\"" +
        timestamp +
        "\"}";

      String apiResp =
        makeApiCall(
          "log_event",
          data
        );

      Serial.println(
        "API Log Response     : " +
        apiResp
      );

    } else {

      storage.addPendingEvent(
        uid,
        "UNKNOWN",
        formatTimestamp()
      );
    }

    display.showIdleScreen();

    Serial.println(
      "--------------------------------------------------"
    );

    return;
  }

  // ==================================================
  // 4. DETERMINE ACTION
  // ==================================================

  String intendedAction =
    forceAction;

  if (intendedAction == "AUTO") {

    if (
      user.currentStatus == "INSIDE"
    ) {

      intendedAction = "EXIT";

    } else {

      intendedAction = "ENTRY";
    }
  }

  Serial.println(
    "RFID UID             : " +
    user.rfidUID
  );

  Serial.println(
    "User Name            : " +
    user.name
  );

  Serial.println(
    "User ID              : " +
    user.userId
  );

  Serial.println(
    "Current Status in DB : " +
    user.currentStatus
  );

  Serial.println(
    "Requested Action     : " +
    intendedAction
  );

  // ==================================================
  // 5. ENTRY
  // ==================================================

  if (intendedAction == "ENTRY") {

    // -----------------------------------------------
    // ALREADY INSIDE
    // -----------------------------------------------

    if (user.currentStatus == "INSIDE") {

      Serial.println(
        "Authorization Result : DENIED"
      );

      Serial.println(
        "ENTRY Result         : BLOCKED - Already INSIDE (Antipassback Violation)"
      );

      Serial.println(
        "[HARDWARE FEEDBACK]  : Error Buzzer (500ms)"
      );

      display.showAlreadyInside(
        user.name
      );

      beepBuzzer(500);

      delay(2000);

    }

    // -----------------------------------------------
    // ALLOW ENTRY
    // -----------------------------------------------

    else {

      Serial.println(
        "Authorization Result : AUTHORIZED"
      );

      Serial.println(
        "ENTRY Result         : SUCCESS (Status -> INSIDE)"
      );

      Serial.println(
        "[HARDWARE FEEDBACK]  : Confirmation Beep (200ms)"
      );

      display.showWelcome(
        user.name
      );

      beepBuzzer(200);

      storage.updateUserStatus(
        uid,
        "INSIDE"
      );

      // ---------------------------------------------
      // GOOGLE SHEETS
      // ---------------------------------------------

      if (wifiState == WIFI_CONNECTED) {

        String timestamp =
          formatTimestamp();

        String data =
          "{\"rfid_uid\":\"" +
          uid +
          "\",\"name\":\"" +
          user.name +
          "\",\"user_id\":\"" +
          user.userId +
          "\",\"action\":\"ENTRY\",\"status\":\"AUTHORIZED\",\"timestamp\":\"" +
          timestamp +
          "\"}";

        String apiResp =
          makeApiCall(
            "log_event",
            data
          );

        Serial.println(
          "API Response         : " +
          apiResp
        );

        Serial.println(
          "Google Sheets Sync   : SYNCED (Current_status = INSIDE)"
        );

      } else {

        storage.addPendingEvent(
          uid,
          "ENTRY",
          formatTimestamp()
        );

        Serial.println(
          "Google Sheets Sync   : QUEUED OFFLINE"
        );
      }

      delay(2000);
    }
  }

  // ==================================================
  // 6. EXIT
  // ==================================================

  else if (intendedAction == "EXIT") {

    // -----------------------------------------------
    // ALREADY OUTSIDE
    // -----------------------------------------------

    if (user.currentStatus == "OUTSIDE") {

      Serial.println(
        "Authorization Result : DENIED"
      );

      Serial.println(
        "EXIT Result          : BLOCKED - Already OUTSIDE (No Active Entry)"
      );

      Serial.println(
        "[HARDWARE FEEDBACK]  : Error Buzzer (500ms)"
      );

      display.showAlreadyOutside(
        user.name
      );

      beepBuzzer(500);

      delay(2000);

    }

    // -----------------------------------------------
    // ALLOW EXIT
    // -----------------------------------------------

    else {

      Serial.println(
        "Authorization Result : AUTHORIZED"
      );

      Serial.println(
        "EXIT Result          : SUCCESS (Status -> OUTSIDE)"
      );

      Serial.println(
        "[HARDWARE FEEDBACK]  : Confirmation Beep (200ms)"
      );

      display.showGoodbye(
        user.name
      );

      beepBuzzer(200);

      storage.updateUserStatus(
        uid,
        "OUTSIDE"
      );

      // ---------------------------------------------
      // GOOGLE SHEETS
      // ---------------------------------------------

      if (wifiState == WIFI_CONNECTED) {

        String timestamp =
          formatTimestamp();

        String data =
          "{\"rfid_uid\":\"" +
          uid +
          "\",\"name\":\"" +
          user.name +
          "\",\"user_id\":\"" +
          user.userId +
          "\",\"action\":\"EXIT\",\"status\":\"AUTHORIZED\",\"timestamp\":\"" +
          timestamp +
          "\"}";

        String apiResp =
          makeApiCall(
            "log_event",
            data
          );

        Serial.println(
          "API Response         : " +
          apiResp
        );

        Serial.println(
          "Google Sheets Sync   : SYNCED (Current_status = OUTSIDE)"
        );

      } else {

        storage.addPendingEvent(
          uid,
          "EXIT",
          formatTimestamp()
        );

        Serial.println(
          "Google Sheets Sync   : QUEUED OFFLINE"
        );
      }

      delay(2000);
    }
  }

  display.showIdleScreen();

  Serial.println(
    "--------------------------------------------------"
  );
}

// ==================================================
// WEB REGISTRATION REQUEST POLL
// ==================================================
// The website creates a WAITING row in Registration_Request when the user
// clicks READ RFID. This polls that state every REG_POLL_INTERVAL_MS and
// flips this device into REGISTRATION_MODE until the card is read, the
// request expires, or a safety timeout fires. NORMAL_MODE access logging is
// untouched: only REGISTRATION_MODE scans are routed to handleRegistrationScan.

void checkPendingRegistration() {

  unsigned long now = millis();

  // Safety net: never stay in registration mode forever (e.g. backend
  // unreachable). The backend also expires the request after its TTL.
  if (
    regModeActive &&
    regModeEnteredByPoll &&
    (now - regModeEnteredAt > REG_MODE_TIMEOUT_MS)
  ) {
    Serial.println(
      "[REGISTRATION] Timeout waiting for card"
    );
    exitRegistrationMode();
    return;
  }

  if (wifiState != WIFI_CONNECTED) {
    return;
  }

  if (now - lastRegPollTime < REG_POLL_INTERVAL_MS) {
    return;
  }

  lastRegPollTime = now;

  String resp =
    makeApiCall(
      "get_pending_rfid_registration",
      "{}"
    );

  StaticJsonDocument<256> doc;
  DeserializationError error =
    deserializeJson(doc, resp);

  if (
    error ||
    !doc["success"].as<bool>()
  ) {
    // Transient API failure: keep current state; the timeout safety net
    // and the next poll decide. Do not exit registration mode on a blip.
    return;
  }

  bool pending =
    doc["data"]["pending"].as<bool>();

  String requestId =
    doc["data"]["request_id"].as<String>();

  if (pending && requestId.length() == 0) {
    pending = false;
  }

  if (pending) {

    if (activeRegRequestId != requestId) {
      Serial.println(
        "[REGISTRATION] Pending request found: " +
        requestId
      );
      activeRegRequestId = requestId;
    }

    if (currentMode != REGISTRATION_MODE) {
      currentMode = REGISTRATION_MODE;
      registrationWaitingCard = true;
      regModeActive = true;
      regModeEnteredByPoll = true;
      regModeEnteredAt = now;
      Serial.println(
        "[REGISTRATION] Registration mode ENABLED"
      );
      Serial.println(
        "[REGISTRATION] Place RFID card near reader"
      );
      display.showIdleScreen();
    } else if (!regModeActive) {
      // Manual REGMODE already active: adopt the web request id so the
      // result is tied to it, but keep manual mode semantics (no auto-exit
      // when the request disappears).
      regModeActive = true;
      regModeEnteredByPoll = false;
      regModeEnteredAt = now;
    }

    return;
  }

  // Backend reports no live request (expired/cancelled/consumed): leave
  // registration mode, but only when the web flow put us here, so the
  // manual REGMODE command keeps its previous behaviour.
  if (regModeActive && regModeEnteredByPoll) {
    Serial.println(
      "[REGISTRATION] Request expired or cancelled"
    );
    exitRegistrationMode();
  }
}

void exitRegistrationMode() {
  currentMode = NORMAL_MODE;
  registrationWaitingCard = false;
  regModeActive = false;
  regModeEnteredByPoll = false;
  activeRegRequestId = "";
  Serial.println(
    "[REGISTRATION] Returning to NORMAL mode"
  );
  display.showIdleScreen();
}

// ==================================================
// REGISTRATION SCAN
// ==================================================

void handleRegistrationScan(
  String uid
) {

  Serial.println(
    "\n[REGISTRATION] Detected UID: " +
    uid
  );

  display.showCardDetected(
    uid
  );

  beepBuzzer(100);

  // Forward scanned UID to the Google Sheets Registration_Request row,
  // tied to the exact request_id this device polled for (if any).
  if (wifiState == WIFI_CONNECTED) {

    String data =
      "{\"rfid_uid\":\"" +
      uid +
      "\"";

    if (activeRegRequestId.length() > 0) {
      // NOTE: data already ends with the uid's closing quote; append only
      // ,\"request_id\":\"...\" so the JSON stays valid.
      data +=
        ",\"request_id\":\"" +
        activeRegRequestId +
        "\"";
    }

    data += "}";

    if (activeRegRequestId.length() > 0) {
      Serial.println(
        "[REGISTRATION] Sending rfid_registration_result for " +
        activeRegRequestId
      );
    } else {
      Serial.println(
        "[REGISTRATION] Sending rfid_registration_result"
      );
    }

    String resp =
      makeApiCall(
        "rfid_registration_result",
        data
      );

    Serial.println(
      "[REGISTRATION] Result response: " +
      resp
    );

    StaticJsonDocument<256> doc;
    DeserializationError error =
      deserializeJson(doc, resp);

    if (
      !error &&
      doc["success"].as<bool>()
    ) {
      Serial.println(
        "[REGISTRATION] Result stored: DETECTED"
      );
      exitRegistrationMode();
    } else {
      Serial.println(
        "[REGISTRATION] Result NOT stored: " +
        (
          error
          ? String("invalid response")
          : doc["message"].as<String>()
        )
      );

      // If this device entered registration mode via the web poll, the
      // next poll will exit cleanly (request gone); manual mode stays.
    }
  } else {
    Serial.println(
      "[REGISTRATION] Result NOT sent (Wi-Fi offline)"
    );
  }
}

// ==================================================
// OFFLINE SYNC
// ==================================================

void syncPendingEvents() {

  int pendingCount =
    storage.getPendingCount();

  if (pendingCount == 0) {

    return;
  }

  Serial.println(
    "\n[OFFLINE SYNC] Synchronizing " +
    String(pendingCount) +
    " pending events to Google Sheets..."
  );

  PendingEvent events[MAX_PENDING_EVENTS];

  int count;

  storage.getPendingEvents(
    events,
    count
  );

  for (int i = 0; i < count; i++) {

    String data =
      "{\"rfid_uid\":\"" +
      events[i].rfidUID +
      "\",\"action\":\"" +
      events[i].action +
      "\",\"timestamp\":\"" +
      events[i].timestamp +
      "\"}";

    String response =
      makeApiCall(
        "log_event",
        data
      );

    StaticJsonDocument<256> doc;

    DeserializationError error =
      deserializeJson(
        doc,
        response
      );

    if (
      !error &&
      doc["success"].as<bool>()
    ) {

      storage.clearPendingEvent(i);

      i--;

      count--;
    }
  }

  Serial.println(
    "[OFFLINE SYNC] Sync completed."
  );
}

// ==================================================
// API CONNECTION TEST
// ==================================================

void testApiConnection() {

  Serial.println(
    "\n========================================"
  );

  Serial.println(
    "  CHECKING API CONNECTION"
  );

  Serial.println(
    "========================================"
  );

  Serial.println(
    "Endpoint: " +
    String(GAS_API_URL)
  );

  if (wifiState != WIFI_CONNECTED) {

    Serial.println(
      "Status: FAILED (Wi-Fi disconnected)"
    );

    return;
  }

  unsigned long start =
    millis();

  HTTPClient http;

  http.begin(
    String(GAS_API_URL) +
    "?action=health"
  );

  http.setFollowRedirects(
    HTTPC_STRICT_FOLLOW_REDIRECTS
  );

  http.setTimeout(10000);

  int code =
    http.GET();

  unsigned long elapsed =
    millis() - start;

  if (code == 200) {

    String body =
      http.getString();

    Serial.println(
      "HTTP Status   : 200 OK"
    );

    Serial.println(
      "Response Time : " +
      String(elapsed) +
      " ms"
    );

    Serial.println(
      "API Response  : " +
      body
    );

    Serial.println(
      "Result        : API CONNECTION SUCCESSFUL"
    );

  } else {

    Serial.println(
      "HTTP Status   : " +
      String(code)
    );

    Serial.println(
      "Result        : API CONNECTION FAILED"
    );
  }

  http.end();

  Serial.println(
    "========================================"
  );
}

// ==================================================
// GOOGLE SHEETS TEST
// ==================================================

void testGoogleSheetsConnection() {

  Serial.println(
    "\n========================================"
  );

  Serial.println(
    "  CHECKING GOOGLE SHEETS CONNECTION"
  );

  Serial.println(
    "========================================"
  );

  if (wifiState != WIFI_CONNECTED) {

    Serial.println(
      "Status: FAILED (Wi-Fi disconnected)"
    );

    return;
  }

  String response =
    makeApiCall(
      "get_dashboard_data",
      "{}"
    );

  StaticJsonDocument<1536> doc;

  DeserializationError error =
    deserializeJson(
      doc,
      response
    );

  if (
    !error &&
    doc["success"].as<bool>() &&
    doc.containsKey("data")
  ) {

    JsonObject data =
      doc["data"];

    Serial.println(
      "Registered Users Count : " +
      String(
        data["registered_users"].as<int>()
      )
    );

    Serial.println(
      "Currently Inside       : " +
      String(
        data["currently_inside"].as<int>()
      )
    );

    Serial.println(
      "Today Total Entries    : " +
      String(
        data["today_entries"].as<int>()
      )
    );

    Serial.println(
      "Today Total Exits      : " +
      String(
        data["today_exits"].as<int>()
      )
    );

    Serial.println(
      "Last Sheets Sync Time  : " +
      data["last_sync"].as<String>()
    );

    Serial.println(
      "Google Sheets Status   : CONNECTED & SYNCHRONIZED"
    );

  } else {

    Serial.println(
      "Response: " +
      response
    );

    Serial.println(
      "Result  : GOOGLE SHEETS SYNC FAILED"
    );
  }

  Serial.println(
    "========================================"
  );
}

// ==================================================
// SIMULATE REGISTRATION
// ==================================================

void simulateRegistration(
  String uid,
  String name,
  String userId,
  String dept,
  String userType
) {

  Serial.println(
    "\n>>> SIMULATING USER REGISTRATION"
  );

  Serial.println(
    "UID       : " +
    uid
  );

  Serial.println(
    "Name      : " +
    name
  );

  Serial.println(
    "User ID   : " +
    userId
  );

  Serial.println(
    "Dept      : " +
    dept
  );

  Serial.println(
    "User Type : " +
    userType
  );

  // Save to local storage

  storage.addOrUpdateUser(
    uid,
    name,
    userId,
    "OUTSIDE"
  );

  // Send registration to Google Apps Script

  if (wifiState == WIFI_CONNECTED) {

    String data =
      "{\"rfid_uid\":\"" +
      uid +
      "\",\"name\":\"" +
      name +
      "\",\"user_id\":\"" +
      userId +
      "\",\"department\":\"" +
      dept +
      "\",\"user_type\":\"" +
      userType +
      "\"}";

    String resp =
      makeApiCall(
        "register_user",
        data
      );

    Serial.println(
      "API Response: " +
      resp
    );
  }

  display.showRegistrationSuccess(
    name
  );

  beepBuzzer(150);

  delay(1500);

  display.showIdleScreen();

  Serial.println(
    "Registration complete. "
    "User initialized with status: OUTSIDE."
  );
}

// ==================================================
// SERIAL TEST MENU
// ==================================================

void printTestMenu() {

  Serial.println(
    "\n===== INNOSECURE HARDWARE TEST ====="
  );

  Serial.println(
    "1. Simulate RFID Scan"
  );

  Serial.println(
    "2. Simulate ENTRY"
  );

  Serial.println(
    "3. Simulate EXIT"
  );

  Serial.println(
    "4. Simulate Invalid RFID"
  );

  Serial.println(
    "5. Check API Connection"
  );

  Serial.println(
    "6. Check Google Sheets Connection"
  );

  Serial.println(
    "===================================="
  );

  Serial.println(
    "Commands: 1-6 | SCAN <UID> | ENTRY <UID> | EXIT <UID> | REG <UID> <Name> <ID>"
  );

  Serial.println(
    "====================================\n"
  );
}

// ==================================================
// SERIAL COMMAND HANDLER
// ==================================================

void processSerialCommand(
  String cmd
) {

  cmd.trim();

  if (cmd.length() == 0) {

    return;
  }

  // ==================================================
  // MENU 1
  // ==================================================

  if (cmd == "1") {

    Serial.println(
      "\n[MENU 1] Simulating RFID Scan for Card: " +
      DEFAULT_VALID_UID
    );

    handleNormalScan(
      DEFAULT_VALID_UID,
      "AUTO"
    );

    printTestMenu();
  }

  // ==================================================
  // MENU 2
  // ==================================================

  else if (cmd == "2") {

    Serial.println(
      "\n[MENU 2] Simulating ENTRY for Card: " +
      DEFAULT_VALID_UID
    );

    handleNormalScan(
      DEFAULT_VALID_UID,
      "ENTRY"
    );

    printTestMenu();
  }

  // ==================================================
  // MENU 3
  // ==================================================

  else if (cmd == "3") {

    Serial.println(
      "\n[MENU 3] Simulating EXIT for Card: " +
      DEFAULT_VALID_UID
    );

    handleNormalScan(
      DEFAULT_VALID_UID,
      "EXIT"
    );

    printTestMenu();
  }

  // ==================================================
  // MENU 4
  // ==================================================

  else if (cmd == "4") {

    Serial.println(
      "\n[MENU 4] Simulating INVALID RFID: " +
      DEFAULT_INVALID_UID
    );

    handleNormalScan(
      DEFAULT_INVALID_UID,
      "AUTO"
    );

    printTestMenu();
  }

  // ==================================================
  // MENU 5
  // ==================================================

  else if (cmd == "5") {

    testApiConnection();

    printTestMenu();
  }

  // ==================================================
  // MENU 6
  // ==================================================

  else if (cmd == "6") {

    testGoogleSheetsConnection();

    printTestMenu();
  }

  // ==================================================
  // SCAN <UID>
  // ==================================================

  else if (
    cmd.startsWith("SCAN ")
  ) {

    String uid =
      cmd.substring(5);

    uid.trim();

    uid.toUpperCase();

    Serial.println(
      "\n[COMMAND] SCAN " +
      uid
    );

    handleNormalScan(
      uid,
      "AUTO"
    );

    printTestMenu();
  }

  // ==================================================
  // ENTRY <UID>
  // ==================================================

  else if (
    cmd.startsWith("ENTRY ")
  ) {

    String uid =
      cmd.substring(6);

    uid.trim();

    uid.toUpperCase();

    Serial.println(
      "\n[COMMAND] ENTRY " +
      uid
    );

    handleNormalScan(
      uid,
      "ENTRY"
    );

    printTestMenu();
  }

  // ==================================================
  // EXIT <UID>
  // ==================================================

  else if (
    cmd.startsWith("EXIT ")
  ) {

    String uid =
      cmd.substring(5);

    uid.trim();

    uid.toUpperCase();

    Serial.println(
      "\n[COMMAND] EXIT " +
      uid
    );

    handleNormalScan(
      uid,
      "EXIT"
    );

    printTestMenu();
  }

  // ==================================================
  // REG <UID> <Name> <ID>
  // ==================================================

  else if (
    cmd.startsWith("REG ")
  ) {

    String remaining =
      cmd.substring(4);

    remaining.trim();

    int firstSpace =
      remaining.indexOf(' ');

    if (firstSpace > 0) {

      String uid =
        remaining.substring(
          0,
          firstSpace
        );

      remaining =
        remaining.substring(
          firstSpace + 1
        );

      remaining.trim();

      int secondSpace =
        remaining.indexOf(' ');

      if (secondSpace > 0) {

        String name =
          remaining.substring(
            0,
            secondSpace
          );

        String userId =
          remaining.substring(
            secondSpace + 1
          );

        uid.trim();
        name.trim();
        userId.trim();

        uid.toUpperCase();

        Serial.println(
          "\n[COMMAND] REGISTRATION"
        );

        simulateRegistration(
          uid,
          name,
          userId,
          "ECE",
          "STUDENT"
        );

      } else {

        Serial.println(
          "[ERROR] Registration format:"
        );

        Serial.println(
          "REG <UID> <Name> <ID>"
        );
      }

    } else {

      Serial.println(
        "[ERROR] Registration format:"
      );

      Serial.println(
        "REG <UID> <Name> <ID>"
      );
    }

    printTestMenu();
  }

  // ==================================================
  // MODE REGISTRATION
  // ==================================================

  else if (
    cmd.equalsIgnoreCase("REGMODE")
  ) {

    currentMode =
      REGISTRATION_MODE;

    registrationWaitingCard = true;

    Serial.println(
      "\n[MODE] RFID REGISTRATION MODE ENABLED"
    );

    Serial.println(
      "Scan an RFID card..."
    );

    display.showIdleScreen();

    printTestMenu();
  }

  // ==================================================
  // MODE NORMAL
  // ==================================================

  else if (
    cmd.equalsIgnoreCase("NORMAL")
  ) {

    currentMode =
      NORMAL_MODE;

    registrationWaitingCard = false;

    Serial.println(
      "\n[MODE] NORMAL MODE ENABLED"
    );

    display.showIdleScreen();

    printTestMenu();
  }

  // ==================================================
  // UNKNOWN COMMAND
  // ==================================================

  else {

    Serial.println(
      "\n[ERROR] Unknown command: " +
      cmd
    );

    printTestMenu();
  }
}

// ==================================================
// BUZZER
// ==================================================

void beepBuzzer(
  int durationMs
) {

  digitalWrite(
    BUZZER_PIN,
    HIGH
  );

  delay(durationMs);

  digitalWrite(
    BUZZER_PIN,
    LOW
  );
}

// ==================================================
// FORMAT RFID UID
// ==================================================

String formatUID(
  byte *buffer,
  byte bufferSize
) {

  String uid = "";

  for (
    byte i = 0;
    i < bufferSize;
    i++
  ) {

    if (buffer[i] < 0x10) {

      uid += "0";
    }

    uid += String(
      buffer[i],
      HEX
    );
  }

  uid.toUpperCase();

  return uid;
}

// ==================================================
// TIMESTAMP
// ==================================================

String formatTimestamp() {

  struct tm timeinfo;

  if (
    !getLocalTime(
      &timeinfo
    )
  ) {

    return "TIME_UNAVAILABLE";
  }

  char buffer[30];

  strftime(
    buffer,
    sizeof(buffer),
    "%Y-%m-%d %H:%M:%S",
    &timeinfo
  );

  return String(buffer);
}