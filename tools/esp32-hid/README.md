# ESP32-S2 HID keyboard for the console

The Flipper's WiFi Devboard is an ESP32-S2 with native USB and WiFi, so it can be a
USB keyboard for the console and an HTTP endpoint for the Mac at the same time. No
kernel extension, no SIP change, no KDK - macOS is not involved at all.

## flash

```sh
arduino-cli core install esp32:esp32
arduino-cli compile --fqbn esp32:esp32:esp32s2 esp32_hid.ino
arduino-cli upload  --fqbn esp32:esp32:esp32s2 -p /dev/cu.usbmodem* esp32_hid.ino
```

Set `SSID`/`PASS` in the sketch first. The serial monitor prints the IP.

## wire

1. Flash with the devboard's own USB-C.
2. Move that cable to the **Switch dock** - the console now sees a USB keyboard.
3. Power the devboard from the Flipper header (or its own USB, if you have a second port).

## use

```sh
node tools/hid-type.cjs http://<devboard-ip> 'PRINT 1'
node tools/hid-type.cjs http://<devboard-ip> --stdin < bootstrap.txt
curl -s 'http://<devboard-ip>/status'
```

SmileBASIC inverts letter case on USB keyboards; the sketch applies that rule
(lowercase sends shift), which is why text goes through `/type` rather than raw
HID codes.
