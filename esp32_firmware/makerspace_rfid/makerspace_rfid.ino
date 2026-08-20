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
enum SystemMode { NORMAL_MODE, REGISTRATION_MODE, WAITING_CARD_MODE };
SystemMode currentMode = NORMAL_MODE;

enum WifiState { WIFI_DISCONNECTED, WIFI_CONNECTING, WIFI_CONNECTED };
WifiState wifiState = WIFI_DISCONNECTED;

bool registrationWaitingCard = false;
String pendingRegistrationUID = "";
String lastScannedUID = "";
unsigned long lastScanTime = 0;
unsigned long lastSyncAttempt = 0;
unsigned long lastWifiCheck = 0;
unsigned long lastStatusSync = 0;
bool ledState = false;

// ==================== FUNCTION DECLARATIONS ====================
void connectWifi();
void checkWifi();
String makeApiCall(String action, String data);
String formatTimestamp();
String formatUID(byte *buffer, byte bufferSize);
void handleNormalScan(String uid);
void handleRegistrationScan(String uid);
void syncPendingEvents();
void blinkLED(int pin, int times, int delayMs);
void beepBuzzer(int durationMs);

// ==================== SETUP ====================
void setup() {
  Serial.begin(115200);
  
  pinMode(LED_GREEN_PIN, OUTPUT);
  pinMode(LED_RED_PIN, OUTPUT);
  pinMode(LED_BLUE_PIN, OUTPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  
  digitalWrite(LED_GREEN_PIN, LOW);
  digitalWrite(LED_RED_PIN, LOW);
  digitalWrite(LED_BLUE_PIN, LOW);
  
  display.begin();
  storage.begin();
  SPI.begin();
  mfrc522.PCD_Init();
  
  Serial.println("Makerspace RFID System Starting...");
  display.showWifiConnecting();
  connectWifi();
  
  configTime(GMT_OFFSET_SEC, DAYLIGHT_OFFSET_SEC, NTP_SERVER);
  
  display.showIdleScreen();
  digitalWrite(LED_GREEN_PIN, HIGH);
}

// ==================== MAIN LOOP ====================
void loop() {
  unsigned long currentTime = millis();
  
  if (currentTime - lastWifiCheck > WIFI_CHECK_INTERVAL_MS) {
    checkWifi();
    lastWifiCheck = currentTime;
  }
  
  if (wifiState == WIFI_CONNECTED && currentTime - lastStatusSync > STATUS_SYNC_INTERVAL_MS) {
    syncPendingEvents();
    lastStatusSync = currentTime;
  }
  
  if (!mfrc522.PICC_IsNewCardPresent() || !mfrc522.PICC_ReadCardSerial()) {
    return;
  }
  
  String uid = formatUID(mfrc522.uid.uidByte, mfrc522.uid.size);
  mfrc522.PICC_HaltA();
  mfrc522.PCD_StopCrypto1();
  
  if (uid == lastScannedUID && (currentTime - lastScanTime) < RFID_COOLDOWN_MS) {
    return;
  }
  
  lastScannedUID = uid;
  lastScanTime = currentTime;
  
  Serial.println("Card scanned: " + uid);
  
  switch (currentMode) {
    case NORMAL_MODE:
      handleNormalScan(uid);
      break;
    case REGISTRATION_MODE:
      handleRegistrationScan(uid);
      break;
    default:
      break;
  }
}

// ==================== WIFI FUNCTIONS ====================
void connectWifi() {
  wifiState = WIFI_CONNECTING;
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  
  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 30) {
    delay(500);
    Serial.print(".");
    attempts++;
  }
  
  if (WiFi.status() == WL_CONNECTED) {
    wifiState = WIFI_CONNECTED;
    Serial.println("\nWiFi connected: " + WiFi.localIP().toString());
    display.showWifiConnected();
    delay(1000);
  } else {
    wifiState = WIFI_DISCONNECTED;
    Serial.println("\nWiFi connection failed - Offline mode");
    display.showWifiDisconnected();
    delay(1000);
  }
}

void checkWifi() {
  if (WiFi.status() != WL_CONNECTED) {
    wifiState = WIFI_DISCONNECTED;
  } else {
    wifiState = WIFI_CONNECTED;
  }
}

// ==================== API CALLS ====================
String makeApiCall(String action, String data) {
  if (wifiState != WIFI_CONNECTED) return "{\"error\":\"offline\"}";
  
  HTTPClient http;
  http.begin(GAS_API_URL);
  http.addHeader("Content-Type", "application/json");
  
  String payload = "{\"action\":\"" + action + "\",\"data\":" + data + "}";
  
  Serial.println("API Call: " + action);
  Serial.println("Payload: " + payload);
  
  int httpCode = http.POST(payload);
  String response = "";
  
  if (httpCode > 0) {
    response = http.getString();
    Serial.println("Response: " + response);
  } else {
    Serial.println("HTTP Error: " + String(httpCode));
    response = "{\"error\":\"http_error\",\"code\":" + String(httpCode) + "}";
  }
  
  http.end();
  return response;
}

// ==================== SCANNING HANDLERS ====================
void handleNormalScan(String uid) {
  blinkLED(LED_BLUE_PIN, 1, 200);
  
  LocalUser user;
  bool userExists = storage.getUser(uid, user);
  
  if (!userExists) {
    if (wifiState == WIFI_CONNECTED) {
      String data = "{\"rfid_uid\":\"" + uid + "\"}";
      String response = makeApiCall("validate_rfid", data);
      
      StaticJsonDocument<512> doc;
      DeserializationError error = deserializeJson(doc, response);
      
      if (!error && doc.containsKey("registered")) {
        if (doc["registered"].as<bool>()) {
          String name = doc["name"].as<String>();
          String userId = doc["user_id"].as<String>();
          String status = doc["current_status"].as<String>();
          storage.addOrUpdateUser(uid, name, userId, status);
          userExists = true;
          user.rfidUID = uid;
          user.name = name;
          user.userId = userId;
          user.currentStatus = status;
        }
      }
    }
    
    if (!userExists) {
      display.showUnknownCard();
      beepBuzzer(500);
      digitalWrite(LED_RED_PIN, HIGH);
      delay(2000);
      digitalWrite(LED_RED_PIN, LOW);
      
      if (wifiState == WIFI_CONNECTED) {
        String timestamp = formatTimestamp();
        String data = "{\"rfid_uid\":\"" + uid + "\",\"action\":\"UNKNOWN\",\"timestamp\":\"" + timestamp + "\"}";
        makeApiCall("log_event", data);
      }
      
      display.showIdleScreen();
      return;
    }
  }
  
  if (user.currentStatus == "OUTSIDE") {
    display.showWelcome(user.name);
    beepBuzzer(200);
    digitalWrite(LED_GREEN_PIN, HIGH);
    
    storage.updateUserStatus(uid, "INSIDE");
    
    if (wifiState == WIFI_CONNECTED) {
      String timestamp = formatTimestamp();
      String data = "{\"rfid_uid\":\"" + uid + "\",\"name\":\"" + user.name + "\",\"user_id\":\"" + user.userId + "\",\"action\":\"ENTRY\",\"status\":\"AUTHORIZED\",\"timestamp\":\"" + timestamp + "\"}";
      makeApiCall("log_event", data);
    } else {
      storage.addPendingEvent(uid, "ENTRY", formatTimestamp());
    }
    
    delay(2000);
    digitalWrite(LED_GREEN_PIN, LOW);
    
  } else if (user.currentStatus == "INSIDE") {
    display.showAlreadyInside(user.name);
    beepBuzzer(200);
    digitalWrite(LED_RED_PIN, HIGH);
    delay(2000);
    digitalWrite(LED_RED_PIN, LOW);
    
    storage.updateUserStatus(uid, "INSIDE");
    
    if (wifiState == WIFI_CONNECTED) {
      String timestamp = formatTimestamp();
      String data = "{\"rfid_uid\":\"" + uid + "\",\"name\":\"" + user.name + "\",\"user_id\":\"" + user.userId + "\",\"action\":\"EXIT\",\"status\":\"AUTHORIZED\",\"timestamp\":\"" + timestamp + "\"}";
      makeApiCall("log_event", data);
    } else {
      storage.addPendingEvent(uid, "EXIT", formatTimestamp());
    }
    
    delay(2000);
    
  } else {
    display.showGoodbye(user.name);
    beepBuzzer(200);
    digitalWrite(LED_GREEN_PIN, HIGH);
    
    storage.updateUserStatus(uid, "INSIDE");
    
    if (wifiState == WIFI_CONNECTED) {
      String timestamp = formatTimestamp();
      String data = "{\"rfid_uid\":\"" + uid + "\",\"name\":\"" + user.name + "\",\"user_id\":\"" + user.userId + "\",\"action\":\"ENTRY\",\"status\":\"AUTHORIZED\",\"timestamp\":\"" + timestamp + "\"}";
      makeApiCall("log_event", data);
    } else {
      storage.addPendingEvent(uid, "ENTRY", formatTimestamp());
    }
    
    delay(2000);
    digitalWrite(LED_GREEN_PIN, LOW);
  }
  
  display.showIdleScreen();
}

void handleRegistrationScan(String uid) {
  Serial.println("Registration scan: " + uid);
  
  display.showCardDetected(uid);
  beepBuzzer(100);
  
  LocalUser existing;
  if (storage.getUser(uid, existing)) {
    display.showAccessDenied("CARD ALREADY REGISTERED");
    delay(3000);
    display.showRegistrationMode();
    return;
  }
  
  pendingRegistrationUID = uid;
  registrationWaitingCard = false;
  
  if (wifiState == WIFI_CONNECTED) {
    String data = "{\"rfid_uid\":\"" + uid + "\"}";
    String response = makeApiCall("check_rfid", data);
    
    StaticJsonDocument<256> doc;
    DeserializationError error = deserializeJson(doc, response);
    if (!error && doc.containsKey("exists") && doc["exists"].as<bool>()) {
      display.showAccessDenied("CARD ALREADY REGISTERED");
      delay(3000);
      display.showRegistrationMode();
      return;
    }
  }
  
  String data = "{\"rfid_uid\":\"" + uid + "\",\"status\":\"waiting\"}";
  makeApiCall("register_rfid_scan", data);
  
  Serial.println("Waiting for registration details...");
}

// ==================== SYNC FUNCTIONS ====================
void syncPendingEvents() {
  int pendingCount = storage.getPendingCount();
  if (pendingCount == 0) return;
  
  Serial.println("Syncing " + String(pendingCount) + " pending events...");
  
  PendingEvent events[MAX_PENDING_EVENTS];
  int count;
  storage.getPendingEvents(events, count);
  
  for (int i = 0; i < count; i++) {
    String data = "{\"rfid_uid\":\"" + events[i].rfidUID + "\",\"action\":\"" + events[i].action + "\",\"timestamp\":\"" + events[i].timestamp + "\"}";
    String response = makeApiCall("log_event", data);
    
    StaticJsonDocument<128> doc;
    DeserializationError error = deserializeJson(doc, response);
    if (!error && doc.containsKey("success") && doc["success"].as<bool>()) {
      storage.clearPendingEvent(i);
      i--;
      count--;
    }
  }
}

// ==================== UTILITY FUNCTIONS ====================
String formatTimestamp() {
  struct tm timeinfo;
  if (!getLocalTime(&timeinfo)) {
    return "0000-00-00 00:00:00";
  }
  
  char dateBuf[11];
  char timeBuf[9];
  strftime(dateBuf, sizeof(dateBuf), "%Y-%m-%d", &timeinfo);
  strftime(timeBuf, sizeof(timeBuf), "%H:%M:%S", &timeinfo);
  
  return String(dateBuf) + " " + String(timeBuf);
}

String formatUID(byte *buffer, byte bufferSize) {
  String uid = "";
  for (byte i = 0; i < bufferSize; i++) {
    if (buffer[i] < 0x10) uid += "0";
    uid += String(buffer[i], HEX);
    uid.toUpperCase();
  }
  return uid;
}

void blinkLED(int pin, int times, int delayMs) {
  for (int i = 0; i < times; i++) {
    digitalWrite(pin, HIGH);
    delay(delayMs);
    digitalWrite(pin, LOW);
    delay(delayMs);
  }
}

void beepBuzzer(int durationMs) {
  digitalWrite(BUZZER_PIN, HIGH);
  delay(durationMs);
  digitalWrite(BUZZER_PIN, LOW);
}

// ==================== SERIAL COMMAND HANDLER ====================
void serialEvent() {
  while (Serial.available()) {
    String command = Serial.readStringUntil('\n');
    command.trim();
    
    if (command == "REG_START") {
      currentMode = REGISTRATION_MODE;
      registrationWaitingCard = true;
      pendingRegistrationUID = "";
      display.showRegistrationMode();
      Serial.println("Registration mode activated");
      
    } else if (command.startsWith("REG_USER:")) {
      String userData = command.substring(9);
      int sep1 = userData.indexOf('|');
      int sep2 = userData.indexOf('|', sep1 + 1);
      int sep3 = userData.indexOf('|', sep2 + 1);
      int sep4 = userData.indexOf('|', sep3 + 1);
      
      if (sep1 > 0 && sep2 > 0 && sep3 > 0 && sep4 > 0) {
        String uid = userData.substring(0, sep1);
        String name = userData.substring(sep1 + 1, sep2);
        String userId = userData.substring(sep2 + 1, sep3);
        String dept = userData.substring(sep3 + 1, sep4);
        String userType = userData.substring(sep4 + 1);
        
        storage.addOrUpdateUser(uid, name, userId, "OUTSIDE");
        
        if (wifiState == WIFI_CONNECTED) {
          String data = "{\"rfid_uid\":\"" + uid + "\",\"name\":\"" + name + "\",\"user_id\":\"" + userId + "\",\"department\":\"" + dept + "\",\"user_type\":\"" + userType + "\"}";
          makeApiCall("register_user", data);
        }
        
        display.showRegistrationSuccess(name);
        beepBuzzer(100);
        delay(3000);
        
        currentMode = NORMAL_MODE;
        registrationWaitingCard = false;
        pendingRegistrationUID = "";
        display.showIdleScreen();
        Serial.println("User registered: " + name);
      }
      
    } else if (command == "REG_CANCEL") {
      currentMode = NORMAL_MODE;
      registrationWaitingCard = false;
      pendingRegistrationUID = "";
      display.showIdleScreen();
      Serial.println("Registration cancelled");
      
    } else if (command == "STATUS") {
      String status = "Mode:" + String(currentMode == NORMAL_MODE ? "NORMAL" : "REGISTRATION");
      status += "|WiFi:" + String(wifiState == WIFI_CONNECTED ? "CONNECTED" : "DISCONNECTED");
      status += "|Pending:" + String(storage.getPendingCount());
      Serial.println(status);
    }
  }
}
