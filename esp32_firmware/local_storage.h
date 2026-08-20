#ifndef LOCAL_STORAGE_H
#define LOCAL_STORAGE_H

#include <Arduino.h>
#include <Preferences.h>

struct PendingEvent {
  String rfidUID;
  String action; // ENTRY or EXIT
  String timestamp;
  bool used;
};

struct LocalUser {
  String rfidUID;
  String name;
  String userId;
  String currentStatus;
  bool used;
};

class LocalStorage {
public:
  void begin();
  
  void addPendingEvent(String rfidUID, String action, String timestamp);
  bool getPendingEvents(PendingEvent events[], int &count);
  void clearPendingEvent(int index);
  void clearAllPendingEvents();
  int getPendingCount();
  
  void addOrUpdateUser(String rfidUID, String name, String userId, String status);
  bool getUser(String rfidUID, LocalUser &user);
  void updateUserStatus(String rfidUID, String status);
  void removeUser(String rfidUID);
  void getAllUsers(LocalUser users[], int &count);
  
  void saveSettings(String key, String value);
  String getSettings(String key, String defaultValue);

private:
  Preferences prefs;
};

#endif
