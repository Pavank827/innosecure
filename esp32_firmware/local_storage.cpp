#include "local_storage.h"

void LocalStorage::begin() {
  prefs.begin("rfid_system", false);
}

void LocalStorage::addPendingEvent(String rfidUID, String action, String timestamp) {
  int count = prefs.getInt("pending_count", 0);
  if (count >= MAX_PENDING_EVENTS) return;
  
  String key = "pending_" + String(count);
  String data = rfidUID + "|" + action + "|" + timestamp;
  prefs.putString(key.c_str(), data);
  count++;
  prefs.putInt("pending_count", count);
}

bool LocalStorage::getPendingEvents(PendingEvent events[], int &count) {
  count = prefs.getInt("pending_count", 0);
  for (int i = 0; i < count; i++) {
    String key = "pending_" + String(i);
    String data = prefs.getString(key.c_str(), "");
    if (data.length() > 0) {
      int sep1 = data.indexOf('|');
      int sep2 = data.indexOf('|', sep1 + 1);
      events[i].rfidUID = data.substring(0, sep1);
      events[i].action = data.substring(sep1 + 1, sep2);
      events[i].timestamp = data.substring(sep2 + 1);
      events[i].used = false;
    }
  }
  return count > 0;
}

void LocalStorage::clearPendingEvent(int index) {
  int count = prefs.getInt("pending_count", 0);
  if (index < 0 || index >= count) return;
  
  for (int i = index; i < count - 1; i++) {
    String key = "pending_" + String(i);
    String nextKey = "pending_" + String(i + 1);
    String data = prefs.getString(nextKey.c_str(), "");
    prefs.putString(key.c_str(), data);
  }
  
  String lastKey = "pending_" + String(count - 1);
  prefs.remove(lastKey.c_str());
  count--;
  prefs.putInt("pending_count", count);
}

void LocalStorage::clearAllPendingEvents() {
  int count = prefs.getInt("pending_count", 0);
  for (int i = 0; i < count; i++) {
    String key = "pending_" + String(i);
    prefs.remove(key.c_str());
  }
  prefs.putInt("pending_count", 0);
}

int LocalStorage::getPendingCount() {
  return prefs.getInt("pending_count", 0);
}

void LocalStorage::addOrUpdateUser(String rfidUID, String name, String userId, String status) {
  LocalUser user;
  if (getUser(rfidUID, user)) {
    updateUserStatus(rfidUID, status);
    return;
  }
  
  int count = prefs.getInt("user_count", 0);
  if (count >= MAX_LOCAL_USERS) return;
  
  String key = "user_" + rfidUID;
  String data = name + "|" + userId + "|" + status;
  prefs.putString(key.c_str(), data);
  
  String idxKey = "user_idx_" + String(count);
  prefs.putString(idxKey.c_str(), rfidUID);
  count++;
  prefs.putInt("user_count", count);
}

bool LocalStorage::getUser(String rfidUID, LocalUser &user) {
  String key = "user_" + rfidUID;
  String data = prefs.getString(key.c_str(), "");
  if (data.length() == 0) return false;
  
  user.rfidUID = rfidUID;
  int sep1 = data.indexOf('|');
  int sep2 = data.indexOf('|', sep1 + 1);
  user.name = data.substring(0, sep1);
  user.userId = data.substring(sep1 + 1, sep2);
  user.currentStatus = data.substring(sep2 + 1);
  user.used = true;
  return true;
}

void LocalStorage::updateUserStatus(String rfidUID, String status) {
  LocalUser user;
  if (!getUser(rfidUID, user)) return;
  
  String key = "user_" + rfidUID;
  String data = user.name + "|" + user.userId + "|" + status;
  prefs.putString(key.c_str(), data);
}

void LocalStorage::removeUser(String rfidUID) {
  String key = "user_" + rfidUID;
  prefs.remove(key.c_str());
}

void LocalStorage::getAllUsers(LocalUser users[], int &count) {
  count = prefs.getInt("user_count", 0);
  for (int i = 0; i < count; i++) {
    String idxKey = "user_idx_" + String(i);
    String uid = prefs.getString(idxKey.c_str(), "");
    if (uid.length() > 0) {
      getUser(uid, users[i]);
    }
  }
}

void LocalStorage::saveSettings(String key, String value) {
  String pkey = "set_" + key;
  prefs.putString(pkey.c_str(), value);
}

String LocalStorage::getSettings(String key, String defaultValue) {
  String pkey = "set_" + key;
  return prefs.getString(pkey.c_str(), defaultValue);
}
