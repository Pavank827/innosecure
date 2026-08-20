#include "display_manager.h"
#include "config.h"

void DisplayManager::begin() {
  Wire.begin(OLED_SDA, OLED_SCL);
  display.begin(SSD1306_SWITCHCAPVCC, 0x3C);
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  display.display();
}

void DisplayManager::showCenteredText(String text, int y, int size) {
  display.setTextSize(size);
  int16_t x1, y1;
  uint16_t w, h;
  display.getTextBounds(text, 0, 0, &x1, &y1, &w, &h);
  display.setCursor((SCREEN_WIDTH - w) / 2, y);
  display.print(text);
}

void DisplayManager::showBottomText(String text, int size) {
  display.setTextSize(size);
  int16_t x1, y1;
  uint16_t w, h;
  display.getTextBounds(text, 0, 0, &x1, &y1, &w, &h);
  display.setCursor((SCREEN_WIDTH - w) / 2, SCREEN_HEIGHT - h - 4);
  display.print(text);
}

void DisplayManager::showWelcome(String name) {
  display.clearDisplay();
  showCenteredText("WELCOME", 8, 2);
  display.drawLine(20, 30, 108, 30, SSD1306_WHITE);
  if (name.length() > 16) name = name.substring(0, 16);
  showCenteredText(name, 38, 1);
  showCenteredText("ENTRY SUCCESS", 52, 1);
  display.display();
}

void DisplayManager::showGoodbye(String name) {
  display.clearDisplay();
  showCenteredText("GOODBYE", 8, 2);
  display.drawLine(20, 30, 108, 30, SSD1306_WHITE);
  if (name.length() > 16) name = name.substring(0, 16);
  showCenteredText(name, 38, 1);
  showCenteredText("EXIT SUCCESS", 52, 1);
  display.display();
}

void DisplayManager::showRegistrationMode() {
  display.clearDisplay();
  showCenteredText("REGISTRATION", 8, 2);
  showCenteredText("MODE", 28, 2);
  display.drawLine(20, 50, 108, 50, SSD1306_WHITE);
  showCenteredText("SCAN YOUR CARD", 54, 1);
  display.display();
}

void DisplayManager::showCardDetected(String uid) {
  display.clearDisplay();
  showCenteredText("CARD", 8, 2);
  showCenteredText("DETECTED", 28, 2);
  display.drawLine(20, 50, 108, 50, SSD1306_WHITE);
  if (uid.length() > 16) uid = uid.substring(0, 16);
  showCenteredText(uid, 54, 1);
  display.display();
}

void DisplayManager::showRegistrationSuccess(String name) {
  display.clearDisplay();
  showCenteredText("REGISTRATION", 8, 2);
  showCenteredText("SUCCESSFUL", 28, 2);
  display.drawLine(20, 50, 108, 50, SSD1306_WHITE);
  if (name.length() > 16) name = name.substring(0, 16);
  showCenteredText(name, 54, 1);
  display.display();
}

void DisplayManager::showRegistrationFailed(String reason) {
  display.clearDisplay();
  showCenteredText("REGISTRATION", 8, 2);
  showCenteredText("FAILED", 28, 2);
  display.drawLine(20, 50, 108, 50, SSD1306_WHITE);
  if (reason.length() > 16) reason = reason.substring(0, 16);
  showCenteredText(reason, 54, 1);
  display.display();
}

void DisplayManager::showAlreadyInside(String name) {
  display.clearDisplay();
  showCenteredText("ALREADY", 8, 2);
  showCenteredText("INSIDE", 28, 2);
  display.drawLine(20, 50, 108, 50, SSD1306_WHITE);
  if (name.length() > 16) name = name.substring(0, 16);
  showCenteredText(name, 54, 1);
  display.display();
}

void DisplayManager::showInvalidExit(String name) {
  display.clearDisplay();
  showCenteredText("INVALID", 8, 2);
  showCenteredText("EXIT", 28, 2);
  display.drawLine(20, 50, 108, 50, SSD1306_WHITE);
  showCenteredText("NO ACTIVE ENTRY", 54, 1);
  display.display();
}

void DisplayManager::showUnknownCard() {
  display.clearDisplay();
  showCenteredText("UNKNOWN", 8, 2);
  showCenteredText("CARD", 28, 2);
  display.drawLine(20, 50, 108, 50, SSD1306_WHITE);
  showCenteredText("ACCESS DENIED", 54, 1);
  display.display();
}

void DisplayManager::showAccessDenied(String reason) {
  display.clearDisplay();
  showCenteredText("ACCESS", 8, 2);
  showCenteredText("DENIED", 28, 2);
  display.drawLine(20, 50, 108, 50, SSD1306_WHITE);
  if (reason.length() > 16) reason = reason.substring(0, 16);
  showCenteredText(reason, 54, 1);
  display.display();
}

void DisplayManager::showIdleScreen() {
  display.clearDisplay();
  showCenteredText("MAKERSPACE", 5, 2);
  display.drawLine(15, 28, 113, 28, SSD1306_WHITE);
  showCenteredText("SCAN RFID CARD", 36, 1);
  showBottomText("System Ready", 1);
  display.display();
}

void DisplayManager::showWifiConnecting() {
  display.clearDisplay();
  showCenteredText("CONNECTING", 20, 2);
  showCenteredText("TO WIFI...", 40, 1);
  display.display();
}

void DisplayManager::showWifiConnected() {
  display.clearDisplay();
  showCenteredText("WIFI", 18, 2);
  showCenteredText("CONNECTED", 38, 2);
  display.display();
}

void DisplayManager::showWifiDisconnected() {
  display.clearDisplay();
  showCenteredText("WIFI", 18, 2);
  showCenteredText("DISCONNECTED", 38, 2);
  showCenteredText("Offline Mode Active", 54, 1);
  display.display();
}

void DisplayManager::showError(String message) {
  display.clearDisplay();
  showCenteredText("ERROR", 8, 2);
  display.drawLine(30, 30, 98, 30, SSD1306_WHITE);
  if (message.length() > 16) message = message.substring(0, 16);
  showCenteredText(message, 40, 1);
  display.display();
}

void DisplayManager::showSyncStatus(int pendingCount) {
  display.clearDisplay();
  showCenteredText("SYNC STATUS", 8, 2);
  display.drawLine(15, 30, 113, 30, SSD1306_WHITE);
  String msg = "Pending: " + String(pendingCount);
  showCenteredText(msg, 40, 1);
  display.display();
}

void DisplayManager::clear() {
  display.clearDisplay();
  display.display();
}
