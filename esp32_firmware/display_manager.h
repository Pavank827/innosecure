#ifndef DISPLAY_MANAGER_H
#define DISPLAY_MANAGER_H

#include <Arduino.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
#define OLED_RESET -1

class DisplayManager {
public:
  void begin();
  void showWelcome(String name);
  void showGoodbye(String name);
  void showRegistrationMode();
  void showCardDetected(String uid);
  void showRegistrationSuccess(String name);
  void showRegistrationFailed(String reason);
  void showAlreadyInside(String name);
  void showInvalidExit(String name);
  void showUnknownCard();
  void showAccessDenied(String reason);
  void showIdleScreen();
  void showWifiConnecting();
  void showWifiConnected();
  void showWifiDisconnected();
  void showError(String message);
  void showSyncStatus(int pendingCount);
  void clear();

private:
  Adafruit_SSD1306 display;
  void showCenteredText(String text, int y, int size = 1);
  void showBottomText(String text, int size = 1);
};

#endif
