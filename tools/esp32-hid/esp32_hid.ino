// Networked USB HID keyboard: the WiFi Devboard types into the console.
//
// Flash to an ESP32-S2 (Flipper WiFi Devboard) with the Arduino core, then plug
// its USB-C into the Switch dock and power it from the Flipper's header.
//
//   GET /type?text=LOAD%20%22TXT%3ANS2%22%0ARUN   type text, newline = enter
//   GET /key?code=40                              press one HID usage (40 = enter)
//   GET /status                                   {"ok":true,"ip":"..."}
//
// SmileBASIC inverts letter case on USB keyboards, so lowercase characters are
// sent WITH shift and uppercase WITHOUT - the same rule mac2jb's sender uses.
#include <WiFi.h>
#include <WebServer.h>
#include <USB.h>
#include <USBHIDKeyboard.h>

static const char *SSID = "YOUR_SSID";
static const char *PASS = "YOUR_PASSWORD";

WebServer server(80);
USBHIDKeyboard keyboard;

struct Key { uint8_t usage; bool shift; };

// US layout, printable ASCII only; everything else is rejected rather than guessed.
static bool mapChar(char c, Key &out) {
  if (c >= 'a' && c <= 'z') { out = {uint8_t(4 + (c - 'a')), true}; return true; }
  if (c >= 'A' && c <= 'Z') { out = {uint8_t(4 + (c - 'A')), false}; return true; }
  if (c >= '1' && c <= '9') { out = {uint8_t(30 + (c - '1')), false}; return true; }
  if (c == '0') { out = {39, false}; return true; }
  switch (c) {
    case '\n': case '\r': out = {40, false}; return true;   // enter
    case '\t': out = {43, false}; return true;
    case ' ':  out = {44, false}; return true;
    case '-': out = {45, false}; return true;  case '_': out = {45, true}; return true;
    case '=': out = {46, false}; return true;  case '+': out = {46, true}; return true;
    case '[': out = {47, false}; return true;  case '{': out = {47, true}; return true;
    case ']': out = {48, false}; return true;  case '}': out = {48, true}; return true;
    case '\\': out = {49, false}; return true; case '|': out = {49, true}; return true;
    case ';': out = {51, false}; return true;  case ':': out = {51, true}; return true;
    case '\'': out = {52, false}; return true; case '"': out = {52, true}; return true;
    case '`': out = {53, false}; return true;  case '~': out = {53, true}; return true;
    case ',': out = {54, false}; return true;  case '<': out = {54, true}; return true;
    case '.': out = {55, false}; return true;  case '>': out = {55, true}; return true;
    case '/': out = {56, false}; return true;  case '?': out = {56, true}; return true;
    case '!': out = {30, true}; return true;   case '@': out = {31, true}; return true;
    case '#': out = {32, true}; return true;   case '$': out = {33, true}; return true;
    case '%': out = {34, true}; return true;   case '^': out = {35, true}; return true;
    case '&': out = {36, true}; return true;   case '*': out = {37, true}; return true;
    case '(': out = {38, true}; return true;   case ')': out = {39, true}; return true;
  }
  return false;
}

void setup() {
  Serial.begin(115200);
  USB.begin();
  keyboard.begin();
  WiFi.begin(SSID, PASS);
  for (int i = 0; i < 40 && WiFi.status() != WL_CONNECTED; i++) delay(500);
  Serial.println(WiFi.localIP());

  server.on("/status", [] {
    server.send(200, "application/json",
      String("{\"ok\":true,\"ip\":\"") + WiFi.localIP().toString() + "\"}");
  });

  server.on("/key", [] {
    if (!server.hasArg("code")) { server.send(400, "application/json", "{\"ok\":false}"); return; }
    uint8_t code = server.arg("code").toInt();
    keyboard.press(code);
    delay(20);
    keyboard.release(code);
    server.send(200, "application/json", "{\"ok\":true}");
  });

  server.on("/type", [] {
    String text = server.arg("text");
    int typed = 0, skipped = 0;
    for (size_t i = 0; i < text.length(); i++) {
      Key key;
      if (!mapChar(text[i], key)) { skipped++; continue; }
      if (key.shift) keyboard.press(KEY_LEFT_SHIFT);
      keyboard.press(key.usage);
      delay(10);
      keyboard.release(key.usage);
      if (key.shift) keyboard.release(KEY_LEFT_SHIFT);
      delay(10);
      typed++;
    }
    server.send(200, "application/json",
      String("{\"ok\":true,\"typed\":") + typed + ",\"skipped\":" + skipped + "}");
  });

  server.begin();
}

void loop() { server.handleClient(); }
