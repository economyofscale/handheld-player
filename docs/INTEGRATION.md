# Handheld Game Player: Integration Guide

This guide explains how the handheld player works and how to put your own browser game (or a Game Boy ROM) inside the 3D handheld. The built-in emulator and demo game are described in the main [README](../README.md); this is the full integration reference.

---

## 1. What's in the package

```
handheld-player/
├── index.html            WEB version: device + side panel (phones are redirected to mobile.html)
├── style.css / ui.js     side panel styling + wiring
├── mobile.html           PHONE version: only the device, everything by touch
├── mobile.css / ui-mobile.js
├── handheld.js           shared 3D device: model, power on/off, rotation, buttons, LCD pipeline
├── three.min.js          Three.js r128 (bundled, no CDN needed)
├── game/
│   ├── game.js           ← the cartridge: a Game Boy emulator host (shared by all versions)
│   └── gb/               the emulator: cpu.js, ppu.js, apu.js, cart.js, gb.js
├── Player.bat / serve.ps1  double-click to serve the folder locally and open it (Windows)
├── manifest.webmanifest  installable web app (Add to Home Screen)
├── sw.js                 offline cache for the installed web app
├── icons/                app icons (192 / 512 px), replace with your own
├── package.json          Android / iOS app build (Capacitor)
├── capacitor.config.json app id + name
└── scripts/copy-web.js   copies the phone version into www/ for the native apps
```

All three versions (web, phone, native app) share **the same `handheld.js` and `game/game.js`**. You change your game in one place. See §11 for the phone and app versions.

- There's no build step and no dependencies. These are plain `<script>` files.
- You can open `index.html` straight from disk. A local server is still better (see §3).
- Only the fonts (Inter, Press Start 2P) load from Google Fonts. Offline, they fall back to system fonts.

---

## 2. How the pieces fit together

```
 keyboard / mouse / touch
          │
          ▼
   ui.js + handheld.js ──── animates 3D buttons, legend highlights, click sounds
          │
          │  onInput(button, isDown)          (only while the device is ON)
          ▼
     game/game.js  ──── draws every frame into a 160×144 canvas
          │
          ▼
   handheld.js LCD pipeline ──── optional 4-shade green tint, pixel grid, 15% ghosting
          │
          ▼
   texture on the 3D screen (nearest-neighbour, crisp pixels)
```

The handheld is only the **shell**. It owns all input and the screen. Your game is only the **cartridge**: it draws pixels and reacts to buttons. Keep the two separate.

### Lifecycle

| Moment | What the handheld does | What your game gets |
|---|---|---|
| Page load | Builds the device and creates the 160×144 canvas | `window.attachGame({ canvas, title, click })` is called **once** |
| PRESS START | Turns to the back and pushes the cartridge in (first boot only), then plays the power-on sequence (~4 s in total; ~2.5 s when the cartridge is already inserted) | — |
| Screen booted | Switches to PLAYING | `start()` |
| Every frame while ON | Copies your canvas to the LCD | `update(dt)` (dt in seconds) |
| Key/button down/up | Animates the 3D button | `onInput(button, isDown)` |
| POWER OFF | Slider to OFF, screen dark | `stop()` (optional) |
| Tab hidden | Pauses the loop, releases all buttons | `onInput(..., false)` for each held button |

---

## 3. Quick start

1. Clone or download the repository.
2. Start a local server inside the folder (any of these):
   ```bash
   npx serve .
   # or
   python -m http.server 8080
   ```
3. Open `http://localhost:8080` (or the port shown) and click **PRESS START**.
4. Edit the configuration at the top of `index.html`:
   ```js
   window.HANDHELD_CONFIG = {
     title: 'My Game',      // shown under the screen, on the back label, passed to your game
     accent: '#7A3E6E'      // panel accent colour
   };
   ```
5. Replace `game/game.js` with your game (see §4).

Debugging: `window.handheld` in the browser console is the running core. For example, `handheld.mode` returns `IDLE`, `POWERING_ON` or `PLAYING`.

---

## 4. The game contract

`game/game.js` must define one global function:

```js
window.attachGame = function ({ canvas, title, click }) {
  const ctx = canvas.getContext('2d');   // canvas is 160 × 144

  return {
    start() {
      // screen finished booting: reset to title screen / first scene
    },
    update(dt) {
      // advance game state by dt seconds, then draw the full frame into ctx
    },
    onInput(button, isDown) {
      // button: 'up' | 'down' | 'left' | 'right' | 'a' | 'b' | 'select' | 'start'
    },
    stop() {
      // optional: device powered off; pause audio, save state, etc.
    }
  };
};
```

Rules:

- **No own keyboard listeners.** The handheld already maps keys and forwards them. If you listen too, every press counts twice.
- **Draw the whole frame every `update`.** The LCD reads your canvas after every call.
- **Resolution is 160×144 (10:9).** Draw at that size, or draw bigger to an offscreen canvas and `drawImage` it down.
- **Colours:** draw in any colours. With *LCD effect: On*, the handheld maps brightness into 4 green shades. With it off, your colours show as they are.
- `click(freq, volume, duration)` plays a short UI click and respects the mute toggle, e.g. `click(4200, 0.03, 0.04)`. For real game audio, use your own Web Audio or `<audio>`.

### Default key mapping (handled by the handheld)

| Device button | Keys |
|---|---|
| Up / Down / Left / Right | Arrow keys, W A S D |
| A | X, K |
| B | Z, J |
| Select | Shift, Backspace |
| Start | Enter, Space |

You can also click the buttons on the 3D model, tap the legend rows on touch screens, and hold several at once. To change keys, edit `KEYMAP` in the constructor of `handheld.js`.

---

## 5. Integration recipes (pick the one that matches your game)

### A. Your own JavaScript / canvas game (simplest)

1. Put your game code in `game/` (split into as many files as you like and add `<script>` tags in `index.html` **before** `handheld.js`).
2. Wrap your main loop so the handheld drives it: move per-frame logic into `update(dt)` and remove your own `requestAnimationFrame` loop.
3. Translate input: wherever your game reads keys, read the state you store in `onInput` instead.
4. Render at 160×144, or render at a larger size to an offscreen canvas and scale it down:
   ```js
   ctx.imageSmoothingEnabled = false;
   ctx.drawImage(myBigCanvas, 0, 0, 160, 144);
   ```

If your game uses ES modules or a bundler (Vite, webpack), build it to a single script that sets `window.attachGame`, or change the `<script>` tags to `type="module"` and set the global from your entry file.

### B. Engine with an HTML5/web export (RPG Maker MV/MZ, Godot, Phaser, Construct, …)

Run the exported game in a hidden iframe from the **same folder/origin**. Each frame, copy its canvas to the handheld screen and pass button presses into it as keyboard events.

```js
// game/game.js
window.attachGame = function ({ canvas }) {
  const ctx = canvas.getContext('2d');
  const frame = document.createElement('iframe');
  frame.src = 'game/export/index.html';          // your engine's web export
  frame.style.cssText = 'position:fixed;left:-9999px;width:640px;height:576px;border:0';
  document.body.appendChild(frame);

  // device button -> key the engine expects
  const KEYS = {
    up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
    a: 'Enter', b: 'Escape', select: 'Shift', start: 'Escape'
  };
  const send = (type, code) => {
    const w = frame.contentWindow;
    if (!w) return;
    const ev = new w.KeyboardEvent(type, { key: code, code, bubbles: true });
    w.document.dispatchEvent(ev);
    w.dispatchEvent(ev);
  };

  return {
    start() {},
    update() {
      const doc = frame.contentDocument;
      const src = doc && doc.querySelector('canvas');
      if (!src) return;
      ctx.imageSmoothingEnabled = true;            // engines rarely run at 160×144
      // crop to 10:9 from the centre
      const sw = src.width, sh = src.height, target = 10 / 9;
      let cw = sw, ch = sh;
      if (sw / sh > target) cw = sh * target; else ch = sw / target;
      ctx.drawImage(src, (sw - cw) / 2, (sh - ch) / 2, cw, ch, 0, 0, 160, 144);
    },
    onInput(button, isDown) { send(isDown ? 'keydown' : 'keyup', KEYS[button]); },
    stop() {}
  };
};
```

Notes:

- **Same origin is required.** Put the export inside `game/` and use a local server. `file://` will block `contentDocument`.
- **WebGL engines** (RPG Maker MV/MZ, Godot, Phaser in WebGL mode) may give a blank frame when copied. Fixes:
  - Enable `preserveDrawingBuffer: true` in the engine's WebGL context creation, or
  - switch the engine to its Canvas2D renderer, or
  - copy the frame right after the engine renders, for example from the engine's own post-render hook.
- **Key events:** some engines read keys only on `document`, others only on `window`. The snippet above sends to both. If an engine ignores synthetic events, call its input API instead. In RPG Maker MV/MZ, for example, set `frame.contentWindow.Input._currentState['ok'] = isDown` (names: `up`, `down`, `left`, `right`, `ok`, `escape`, `shift`, `pageup`, `pagedown`).
- **Resolution / aspect:** engines usually render at 4:3 or 16:9. Either crop (as above), letterbox, or set the engine's screen size to a 10:9 multiple such as 480×432 or 640×576. RPG Maker MV/MZ lets you set the screen size in the database/system settings or via a plugin.
- **Performance:** the hidden iframe still renders at full size. Keep the engine's resolution small.

### C. A real Game Boy ROM (built in: this is what `game/game.js` does now)

The player ships with its own Game Boy emulator in `game/gb/`, so it runs ROM files directly. No ROM is included: use ones you own or made yourself.

- **Load a ROM:** press **A** on the "no cartridge" screen, click **Load ROM…** in the side panel, or drop a `.gb` file on the page. POWER OFF and PRESS START again restarts the same ROM; load another file at any time to swap it.
- **Run it over http**, not from disk (the emulator loads as ES modules). Double-click `Player.bat` on Windows, or serve the folder with any web server.
- **Buttons:** the handheld's keys (Arrows/WASD, X/K = A, Z/J = B, Shift/Backspace = Select, Enter/Space = Start).
- **What it emulates:** the DMG CPU, picture unit (background, window, sprites, STAT/LYC interrupts), timer, joypad, OAM DMA and four-channel sound; cartridges with no mapper, MBC1, MBC2, MBC3 (with clock) and MBC5. Battery saves are kept in the browser's localStorage, per game.
- **Not covered:** Game Boy Color-only games (dual-mode games play in grey), link cable, rumble, the Game Boy Camera, cycle-exact timing tricks.
- **Files:** `cpu.js` (all opcodes, interrupts, HALT), `ppu.js` (modes and scanline renderer), `apu.js` (two square channels, wave, noise, mixer), `cart.js` (header, mappers, RAM), `gb.js` (memory map, timer, joypad, DMA, frame loop). `game.js` is the handheld glue: pacing at 59.7 Hz, canvas, Web Audio, file loading, saves.
- Turn **LCD effect: Off** for the plain grey screen.

---

## 6. Customising the device

Everything visual lives in `handheld.js`, in `initScene()`:

| What | Where to look |
|---|---|
| Case shape (square lower-left, straight bottom, rounded corners) | `bottomCurve`, `bodyShape` |
| Silver finish, scratches, smudges | `brushedC`, `smudgeC`, `silver`, `silverDark` |
| Button colour / material | `charcoal` (D-pad, Select, Start), `abMat` (A/B) |
| Screen size and position | `lcdWell`, `screen`, `glass`, the bezel `slab(...)` |
| Power slider, OFF • ON label | `slider`, `OFFX` / `ONX`, `labelCanvas('OFF  •  ON', …)` |
| Speaker dots | the "speaker: round cluster" loop |
| Side wheel | `wheel`, `ribMat` |
| Back: cartridge slot, raised lower back, screws, label | `RAISE`, `cart`, `backPanel`, `drawTitles()` |
| LCD green palette / grid / ghosting | `PAL`, `gridC`, `paintScreen()` |
| Power-on timing | the `POWERING_ON` branches in `loop()` (phase 0 = cartridge insert, `CART_T`) |
| Cartridge look / label | `cartG`, `cartPlastic`, `drawCartLabel()` |

The panel text and layout are in `index.html` / `style.css`. The panel behaviour is in `ui.js`.

---

## 7. Deploying

The folder is a static site. Upload it as-is to GitHub Pages, Netlify, Vercel, Cloudflare Pages or any web host. If your game loads extra files (ROM, iframe export, assets), keep them inside the same folder so they're served from the same origin.

---

## 8. Checklist

- [ ] `game/game.js` defines `window.attachGame` and returns `start`, `update`, `onInput` (and optionally `stop`)
- [ ] The game draws a full 160×144 frame in every `update`
- [ ] The game has no keyboard listeners of its own
- [ ] Every button from the table in §4 does something sensible in-game
- [ ] PRESS START → game starts; POWER OFF → game stops; PRESS START again → game restarts cleanly
- [ ] It runs from a local server (`npx serve .`) with no console errors
- [ ] The phone version works too (see §11)
- [ ] `HANDHELD_CONFIG.title` is set

---

## 9. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Device not visible, console error | A typo in `game/game.js` stops later scripts. Fix the error shown in the console. |
| Screen stays dark/green after boot | `update` isn't drawing, or `attachGame` returned nothing. |
| Every key press counts twice | Your game still has its own key listeners. Remove them. |
| Iframe game shows a blank screen | Cross-origin (use a local server, same folder) or WebGL `preserveDrawingBuffer` (see §5B). |
| Blurry pixels | Draw at 160×144 with `imageSmoothingEnabled = false`. |
| Colours look green | That's the LCD effect. Toggle **LCD effect: Off** in the panel. |
| Keys don't respond | Click once on the page so the browser window has focus. |

---

## 11. Phone and app versions (Android / iOS)

### How the phone version behaves (`mobile.html`)

- Only the 3D device fills the screen, with no side panel.
- **Tap the power switch on the top edge** to boot the game. A pulsing "Power" pointer shows where it is while the device is off. Tap the switch again to power off.
- **Tap the buttons on the device** (D-pad, A, B, Select, Start) to play. They work exactly like the keys, including multi-touch (e.g. Right + A) and a short vibration on Android.
- **Tap the wheel on the right edge** to turn sound on or off. The wheel turns and a "SOUND ON/OFF" message appears.
- While off, drag to rotate and pinch to zoom. While playing, the device stays front-facing.
- The device is automatically scaled so it's never cut off on narrow screens.
- A Bluetooth keyboard still works with the same key mapping.

The switch and wheel taps also work in the web version, as an extra to the panel buttons.

### Option 1: Web app, no app store (easiest)

1. Upload the folder to any **https** host (GitHub Pages, Netlify, …).
2. Open the link on the phone. Phones are sent to `mobile.html` automatically (add `?desktop` to the URL to force the panel version).
3. Use **"Add to Home Screen"** (Safari share menu on iPhone, Chrome menu on Android). It then opens full-screen with its own icon and works offline thanks to `sw.js`.
4. When you update files, change `CACHE = 'handheld-v1'` in `sw.js` to a new name so phones download the new version.

### Option 2: Real Android / iOS apps (Capacitor)

Capacitor wraps the phone version in a native app shell. Your code stays the same.

Requirements:

- **Node.js** (LTS) on your PC
- **Android:** Android Studio (works on Windows, macOS, Linux)
- **iOS:** a **Mac with Xcode** is required by Apple for building and uploading iOS apps. From Windows you need a Mac (or a cloud Mac / cloud build service).
- For store publishing: a Google Play developer account and/or an Apple Developer Program membership

Steps (in the `handheld-player` folder):

```bash
npm install                 # installs Capacitor
# edit capacitor.config.json: set your own appId (e.g. ch.yourname.handheld) and appName
npm run build               # copies the phone version into www/ (mobile.html becomes www/index.html)
npx cap add android         # once: creates the android/ project
npx cap add ios             # once, on a Mac: creates the ios/ project
npm run android             # build + sync + open in Android Studio, then press Run
npm run ios                 # on a Mac: build + sync + open in Xcode, then press Run
```

After every change to your game, run `npm run android` / `npm run ios` again (or `npm run build && npx cap sync`).

Recommended native settings:

- **Portrait only:**
  - Android: in `android/app/src/main/AndroidManifest.xml`, add `android:screenOrientation="portrait"` to the `<activity>`.
  - iOS: in Xcode → target → General → Device Orientation, keep only Portrait.
- **App icon / splash:** replace the icons with your own artwork (Android Studio: Image Asset; Xcode: Assets → AppIcon).
- **Fonts offline:** the app loads Inter and Press Start 2P from Google Fonts. Without internet it falls back to system fonts. To make it fully offline, download the font files, put them in a `fonts/` folder, reference them with `@font-face` in `mobile.css` and add the folder to `scripts/copy-web.js`.
- **Sound on iPhone:** iOS only allows audio after the first tap. Tapping the power switch counts as that tap, so sound works from the boot sequence onwards. The phone's silent switch may still mute web audio.

### Phone checklist

- [ ] Tapping the switch boots the game; tapping it again powers off
- [ ] All 8 buttons respond to touch, also two at once
- [ ] Tapping the wheel toggles sound and shows the message
- [ ] Nothing is cut off on a small phone (e.g. 360 × 740) or in the app
- [ ] `capacitor.config.json` has your own `appId` before the first `npx cap add`

---

## 12. Continuing with Claude later

To continue this work in a new conversation, share this guide and the `handheld-player` folder (or connect the folder in the Claude desktop app). Also say which recipe (§5 A/B/C) your game uses and what the engine's web export or ROM looks like.
