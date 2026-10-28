// Nintendo Switch Pro Controller (NS1) USB persona for the home menu.
//
//   GET /pro?a=1&down=1&ms=150      press buttons for ms
//   GET /pro?mask=0x0008&raw=1      raw bits, hold until changed
//   GET /usb                        link + handshake diagnostics
//   GET /status                     {"ok":true,...}
//
// The console only drives USB controllers it has a driver for, and the Pro
// Controller is the one it is built around. Identity: 057E:2009, strings
// "Nintendo Co., Ltd." / "Pro Controller", 209-byte report descriptor from
// espp's hid-rp (which matches a real controller dump byte-for-byte).
//
// Protocol (host -> device 0x80/0x01/0x10, device -> host 0x81/0x21/0x30),
// following espp::SwitchPro, which follows dekuNukem and nxbt:
//
//   attach            send 0x81 (device info: 0x01 0x00 0x03 + MAC reversed)
//   host 0x80 0x01    reply 0x81 with device info
//   host 0x80 0x02    reply 0x81 echoing the payload (handshake)
//   host 0x80 0x04    enable USB HID -> start streaming 0x30 input reports
//   host 0x01 ...     subcommand -> reply 0x21: [12]=ACK [13]=subcommand [14..]=data
//   host 0x10         rumble only, no reply
//
// All reports are 63-byte payloads; the report id makes them 64 on the wire.
#include <WiFi.h>
#include <WebServer.h>
#include <USB.h>
#include <USBHID.h>
#include <ArduinoOTA.h>

#include "wifi_secret.h"
static const char *SSID = WIFI_SSID;
static const char *PASS = WIFI_PASS;

typedef unsigned char u8;
typedef unsigned short u16;
typedef unsigned int u32;

static const u8 pro_report_desc[] = {
0x05,0x01,0x15,0x00,0x09,0x04,0xA1,0x01,0x85,0x30,0x05,0x01,0x05,0x09,0x1A,0x01,
    0x00,0x2A,0x0A,0x00,0x15,0x00,0x25,0x01,0x75,0x01,0x95,0x0A,0x55,0x00,0x65,0x00,
    0x81,0x02,0x05,0x09,0x1A,0x0B,0x00,0x2A,0x0E,0x00,0x15,0x00,0x25,0x01,0x75,0x01,
    0x95,0x04,0x81,0x02,0x75,0x01,0x95,0x02,0x81,0x03,0x0B,0x01,0x00,0x01,0x00,0xA1,
    0x00,0x0B,0x30,0x00,0x01,0x00,0x0B,0x31,0x00,0x01,0x00,0x0B,0x32,0x00,0x01,0x00,
    0x0B,0x35,0x00,0x01,0x00,0x15,0x00,0x27,0xFF,0xFF,0x00,0x00,0x75,0x10,0x95,0x04,
    0x81,0x02,0xC0,0x0B,0x39,0x00,0x01,0x00,0x15,0x00,0x25,0x07,0x35,0x00,0x46,0x3B,
    0x01,0x65,0x14,0x75,0x04,0x95,0x01,0x81,0x02,0x05,0x09,0x1A,0x0F,0x00,0x2A,0x12,
    0x00,0x15,0x00,0x25,0x01,0x75,0x01,0x95,0x04,0x81,0x02,0x75,0x08,0x95,0x34,0x81,
    0x03,0x06,0x00,0xFF,0x85,0x21,0x09,0x01,0x75,0x08,0x95,0x3F,0x81,0x03,0x85,0x81,
    0x09,0x02,0x75,0x08,0x95,0x3F,0x81,0x03,0x85,0x01,0x09,0x03,0x75,0x08,0x95,0x3F,
    0x91,0x83,0x85,0x10,0x09,0x04,0x75,0x08,0x95,0x3F,0x91,0x83,0x85,0x80,0x09,0x05,
    0x75,0x08,0x95,0x3F,0x91,0x83,0x85,0x82,0x09,0x06,0x75,0x08,0x95,0x3F,0x91,0x83,
    0xC0,
};

// SPI flash banks the console reads for calibration (0x60 factory, 0x80 user).
static const u8 spi60[] = {
    0x00,0x80,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,
    0xFF,0xFF,0x10,0xFF,0xFF,0x03,0xA0,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0x02,0x01,
    0xFF,0xFF,0xFF,0xFF,0x20,0xF0,0xFF,0x89,0x00,0xF0,0x01,0x00,0x40,0x00,0x40,0x00,
    0x40,0xF9,0xFF,0x06,0x00,0x09,0x00,0xE7,0x3B,0xE7,0x3B,0xE7,0x3B,0x38,0x3C,0xFF,
    0xFF,0xFF,0xFF,0xFF,0x3D,0xFF,0xF7,0x7F,0x00,0x08,0x80,0x00,0x08,0x80,0x00,0x08,
    0x80,0x00,0x08,0x80,0xFF,0xF7,0x7F,0x4F,0xFF,0x50,0x82,0x82,0x82,0x0F,0x0F,0x0F,
    0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0x60,0xFF,0xFF,0xFF,0xFF,0xFF,
    0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0x70,0xFF,0xFF,0xFF,0xFF,
    0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0x80,0x50,0xFD,0x00,
    0x00,0xC6,0x0F,0x0F,0x30,0x61,0x96,0x30,0xF3,0xD4,0x14,0x54,0x41,0x15,0x54,0xC7,
    0x79,0x9C,0x33,0x36,0x63,0x0F,0x30,0x61,0x96,0x30,0xF3,0xD4,0x14,0x54,0x41,0x15,
    0x54,0xC7,0x79,0x9C,0x33,0x36,0x63,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,
};
static const u8 spi80[] = {
    0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,
    0xB2,0xA1,0xFF,0xF7,0x7F,0x00,0x08,0x80,0x00,0x00,0x00,0xB2,0xA1,0xFF,0xF7,0x7F,
    0x00,0x08,0x80,0x00,0x00,0x00,0xB2,0xA1,0xBE,0xFF,0x3E,0x00,0xF0,0x01,0x00,0x40,
    0x00,0x40,0x00,0x40,0xFE,0xFF,0xFE,0xFF,0x08,0x00,0xE7,0x3B,0xE7,0x3B,0xE7,0x3B,
};

#define DEVICE_INIT_REPORT  0x81
#define HOST_INIT_REPORT    0x80
#define HOST_OUTPUT_REPORT  0x01
#define HOST_RUMBLE_REPORT  0x10
#define DEVICE_RESPONSE_REPORT 0x21
#define DEVICE_INPUT_REPORT 0x30

#define PRO_ID 0x03
#define REPORT_SIZE 63

static volatile uint32_t proSent = 0, proOut = 0;
static volatile u8 lastOut[16] = {0};
static volatile u8 lastOutLen = 0;

static void onHostReport(const u8 *data, size_t len);

class ProController : public USBHIDDevice {
 public:
  ProController() { hid.addDevice(this, sizeof(pro_report_desc)); }
  void begin() { hid.begin(); }
  uint16_t _onGetDescriptor(u8 *dst) override {
    memcpy(dst, pro_report_desc, sizeof(pro_report_desc));
    return sizeof(pro_report_desc);
  }
  void _onOutput(uint8_t report_id, const u8 *buffer, uint16_t len) override {
    proOut++;
    lastOut[0] = report_id;
    lastOutLen = (u8)(len > 15 ? 15 : len);
    for (u8 i = 0; i < lastOutLen; i++) lastOut[i + 1] = buffer[i];
    onHostReport(buffer, len);
  }
  bool send(uint8_t id, const u8 *payload, size_t len) {
    bool ok = hid.SendReport(id, payload, len, 4);
    if (ok) proSent++;
    return ok;
  }
 private:
  USBHID hid;
};

WebServer server(80);
ProController pro;

static u8 inputReport[REPORT_SIZE];      // 0x30 payload
static u8 reply[REPORT_SIZE];            // 0x81 / 0x21 payload
static bool hidReady = false;
static bool announced = false;
static uint32_t announcedAt = 0;
static uint32_t sentAt = 0, releaseAt = 0;
static uint32_t buttons = 0;
static u8 counter = 0;
static const u8 mac[6] = {0x98, 0xB6, 0xE9, 0xEC, 0x5E, 0xFD};

// Button bits used by /pro?mask=
#define B_Y 0x0001
#define B_X 0x0002
#define B_B 0x0004
#define B_A 0x0008
#define B_DOWN 0x0100
#define B_UP 0x0200
#define B_RIGHT 0x0400
#define B_LEFT 0x0800
#define B_SR 0x1000
#define B_SL 0x2000
#define B_R 0x4000
#define B_ZR 0x8000
#define B_MINUS 0x00010000u
#define B_PLUS  0x00020000u
#define B_R3    0x00040000u
#define B_L3    0x00080000u
#define B_HOME  0x00100000u
#define B_CAPTURE 0x00200000u
#define B_L     0x00400000u
#define B_ZL    0x00800000u

static void rebuildInput() {
  memset(inputReport, 0, sizeof(inputReport));
  inputReport[0] = counter++;              // timer
  inputReport[1] = 0x8E;                   // battery full, USB powered
  uint32_t m = buttons;
  if (m & (B_Y | B_X | B_B | B_A)) {
    u8 b = 0;
    if (m & B_Y) b |= 0x01;
    if (m & B_X) b |= 0x02;
    if (m & B_B) b |= 0x04;
    if (m & B_A) b |= 0x08;
    inputReport[2] = b;
  }
  if (m & (B_DOWN | B_UP | B_RIGHT | B_LEFT | B_SR | B_SL | B_R | B_ZR)) {
    u8 b = 0;
    if (m & B_DOWN) b |= 0x01;
    if (m & B_UP) b |= 0x02;
    if (m & B_RIGHT) b |= 0x04;
    if (m & B_LEFT) b |= 0x08;
    if (m & B_SR) b |= 0x10;
    if (m & B_SL) b |= 0x20;
    if (m & B_R) b |= 0x40;
    if (m & B_ZR) b |= 0x80;
    inputReport[3] = b;
  }
  u8 b3 = 0;
  if (m & B_MINUS) b3 |= 0x01;
  if (m & B_PLUS) b3 |= 0x02;
  if (m & B_R3) b3 |= 0x04;
  if (m & B_L3) b3 |= 0x08;
  if (m & B_HOME) b3 |= 0x10;
  if (m & B_CAPTURE) b3 |= 0x20;
  if (m & B_L) b3 |= 0x40;
  if (m & B_ZL) b3 |= 0x80;
  inputReport[4] = b3;
  // sticks centred: 12-bit x,y -> 3 bytes each
  inputReport[5] = 0x00; inputReport[6] = 0x08; inputReport[7] = 0x80;
  inputReport[8] = 0x00; inputReport[9] = 0x08; inputReport[10] = 0x80;
  inputReport[11] = 0x00;                  // vibrator
}

static void sendDeviceInfo() {
  memset(reply, 0, sizeof(reply));
  reply[0] = 0x01;                         // device info command
  reply[1] = 0x00;
  reply[2] = PRO_ID;
  for (int i = 0; i < 6; i++) reply[3 + i] = mac[5 - i];   // reversed order
  pro.send(DEVICE_INIT_REPORT, reply, REPORT_SIZE);
}

static void replySubcommand(const u8 *data, size_t len) {
  // data: [0]=0x01 [1]=counter [2..9]=rumble [10]=subcommand id [11..]=subcommand data
  if (len < 11) return;
  u8 id = data[10];
  const u8 *sub = data + 11;
  size_t subLen = len > 11 ? len - 11 : 0;

  memcpy(reply, inputReport, REPORT_SIZE);
  reply[12] = 0x80;             // ACK
  reply[13] = id;
  reply[14] = 0x00;

  switch (id) {
    case 0x02: {                // request device info
      hidReady = true;
      static const u8 info[] = {0x03, 0x48, PRO_ID, 0x02,
                                0x98, 0xB6, 0xE9, 0xEC, 0x5E, 0xFD,
                                0x03, 0x02, 0x00, 0x00};
      reply[12] = 0x82;
      reply[13] = 0x02;
      memcpy(reply + 14, info, sizeof(info));
      break;
    }
    case 0x03:                  // set input report mode
      reply[12] = 0x80; reply[13] = 0x03;
      break;
    case 0x08:                  // set shipment
      reply[12] = 0x80; reply[13] = 0x08;
      break;
    case 0x10: {                // SPI flash read
      if (subLen < 5) { reply[12] = 0x83; reply[13] = 0x00; break; }
      u8 bank = sub[1];
      u8 addr = sub[0];
      u8 readLen = sub[4];
      const u8 *src = nullptr; size_t srcLen = 0;
      if (bank == 0x60) { src = spi60; srcLen = sizeof(spi60); }
      else if (bank == 0x80) { src = spi80; srcLen = sizeof(spi80); }
      if (!src || addr >= srcLen) { reply[12] = 0x83; reply[13] = 0x00; break; }
      size_t n = readLen;
      if (addr + n > srcLen) n = srcLen - addr;
      if (n > REPORT_SIZE - 19) n = REPORT_SIZE - 19;
      memcpy(reply + 19, src + addr, n);
      reply[12] = 0x90; reply[13] = 0x10;
      reply[14] = addr; reply[15] = bank;
      reply[16] = 0; reply[17] = 0;
      reply[18] = (u8)n;
      break;
    }
    case 0x30:                  // player lights
      reply[12] = 0x80; reply[13] = 0x30;
      break;
    case 0x40:                  // toggle IMU
      reply[12] = 0x80; reply[13] = 0x40;
      break;
    case 0x48:                  // enable vibration
      reply[12] = 0x82; reply[13] = 0x48;
      break;
    case 0x22:                  // NFC/IR state
      reply[12] = 0x80; reply[13] = 0x22;
      break;
    case 0x21: {                // NFC/IR config
      static const u8 params[] = {0x01, 0x00, 0xFF, 0x00, 0x08, 0x00, 0x1B, 0x01};
      reply[12] = 0xA0; reply[13] = 0x21;
      memcpy(reply + 14, params, sizeof(params));
      reply[47] = 0xC8;
      break;
    }
    default:
      reply[12] = 0x80; reply[13] = id; reply[14] = 0x03;
      break;
  }
  pro.send(DEVICE_RESPONSE_REPORT, reply, REPORT_SIZE);
}

static void onHostReport(const u8 *data, size_t len) {
  if (len < 1) return;
  switch (data[0]) {
    case HOST_INIT_REPORT: {
      u8 cmd = len > 1 ? data[1] : 0;
      if (cmd == 0x01) {
        sendDeviceInfo();
      } else if (cmd == 0x02) {
        memset(reply, 0, sizeof(reply));
        size_t n = len - 1; if (n > REPORT_SIZE) n = REPORT_SIZE;
        memcpy(reply, data + 1, n);
        pro.send(DEVICE_INIT_REPORT, reply, REPORT_SIZE);
      } else if (cmd == 0x03) {
        memset(reply, 0, sizeof(reply));
        reply[0] = 0x03;
        pro.send(DEVICE_INIT_REPORT, reply, REPORT_SIZE);
      } else if (cmd == 0x04) {
        hidReady = true;
        memset(reply, 0, sizeof(reply));
        reply[0] = 0x04;
        pro.send(DEVICE_INIT_REPORT, reply, REPORT_SIZE);
      }
      break;
    }
    case HOST_OUTPUT_REPORT:
      replySubcommand(data, len);
      break;
    case HOST_RUMBLE_REPORT:
    default:
      break;
  }
}

static void streamInput() {
  uint32_t now = millis();
  if (releaseAt && now >= releaseAt) { buttons = 0; releaseAt = 0; rebuildInput(); }
  if (!(bool)USB) { announced = false; hidReady = false; return; }
  // Announce until the host answers: the console expects the controller to send
  // its 0x81 device info, but the endpoint is not ready the instant we mount.
  if (proOut == 0 && now - announcedAt >= 200 && tud_hid_n_ready(0)) {
    announcedAt = now;
    sendDeviceInfo();
  }
  if (!hidReady) return;
  if (!tud_hid_n_ready(0)) return;
  if (now - sentAt < 8) return;   // 125 Hz
  sentAt = now;
  pro.send(DEVICE_INPUT_REPORT, inputReport, REPORT_SIZE);
}

static bool flag(const char *n) {
  if (!server.hasArg(n)) return false;
  String v = server.arg(n); return v == "1" || v == "true" || v == "on";
}

void setup() {
  Serial.begin(115200);
  rebuildInput();
  USB.manufacturerName("Nintendo Co., Ltd.");
  USB.productName("Pro Controller");
  USB.begin();
  pro.begin();
  WiFi.begin(SSID, PASS);
  for (int i = 0; i < 40 && WiFi.status() != WL_CONNECTED; i++) delay(500);

  server.on("/status", [] {
    server.send(200, "application/json",
      String("{\"ok\":true,\"ip\":\"") + WiFi.localIP().toString() +
      "\",\"fw\":\"pro-1\",\"ready\":" + (hidReady ? "true" : "false") + "}");
  });
  server.on("/reboot", [] {
    server.send(200, "application/json", "{\"ok\":true,\"reboot\":true}");
    delay(150);
    ESP.restart();
  });

  server.on("/usb", [] {
    String body = String("{\"mounted\":") + ((bool)USB ? "true" : "false") +
      ",\"hidReady\":" + (tud_hid_n_ready(0) ? "true" : "false") +
      ",\"handshake\":" + (hidReady ? "true" : "false") +
      ",\"reportsSent\":" + (uint32_t)proSent +
      ",\"outReports\":" + (uint32_t)proOut +
      ",\"uptimeMs\":" + (uint32_t)millis() + ",\"lastOut\":\"";
    for (u8 i = 0; i <= lastOutLen; i++) {
      if (i) body += ' ';
      if (lastOut[i] < 0x10) body += '0';
      body += String(lastOut[i], HEX);
    }
    body += "\"}";
    server.send(200, "application/json", body);
  });
  server.on("/pro", [] {
    if (server.hasArg("mask")) buttons = (uint32_t)strtoul(server.arg("mask").c_str(), NULL, 0);
    if (flag("a")) buttons |= B_A;
    if (flag("b")) buttons |= B_B;
    if (flag("x")) buttons |= B_X;
    if (flag("y")) buttons |= B_Y;
    if (flag("l")) buttons |= B_L;
    if (flag("r")) buttons |= B_R;
    if (flag("zl")) buttons |= B_ZL;
    if (flag("zr")) buttons |= B_ZR;
    if (flag("plus")) buttons |= B_PLUS;
    if (flag("minus")) buttons |= B_MINUS;
    if (flag("home")) buttons |= B_HOME;
    if (flag("capture")) buttons |= B_CAPTURE;
    if (flag("up")) buttons |= B_UP;
    if (flag("down")) buttons |= B_DOWN;
    if (flag("left")) buttons |= B_LEFT;
    if (flag("right")) buttons |= B_RIGHT;
    rebuildInput();
    bool raw = flag("raw");
    long ms = server.hasArg("ms") ? server.arg("ms").toInt() : 150;
    releaseAt = (raw || buttons == 0) ? 0 : millis() + (ms > 0 ? ms : 150);
    streamInput();
    server.send(200, "application/json", String("{\"ok\":true,\"mask\":") + (uint32_t)buttons + "}");
  });

  server.begin();
  ArduinoOTA.setHostname("esp32-hid");
  ArduinoOTA.begin();
}

void loop() {
  server.handleClient();
  ArduinoOTA.handle();
  streamInput();
}
