/*
 * game.js -- a Game Boy emulator as the handheld's cartridge.
 *
 * Load any .gb ROM you own: press SELECT on the title screen of the built-in
 * demo game (game/demo.js, shown while no ROM is loaded), click "Load ROM..." in
 * the side panel, or drop the file on the page. The
 * emulator itself is in game/gb/ (cpu, ppu, apu, cart, gb); this file is the
 * glue the handheld's contract asks for (README section 4):
 *
 *   attachGame({ canvas, title, click }) -> { start, update, onInput, stop }
 *
 * It is a classic script, as the handheld wants; the emulator modules come in
 * by import(), so the page has to be served over http (Player.bat does that),
 * not opened from disk.
 *
 * Supported: DMG games with no mapper, MBC1, MBC2, MBC3 (with clock) and MBC5,
 * battery saves (kept in this browser's localStorage). Not supported: Game
 * Boy Color-only games, link cable, rumble, camera.
 */
(function () {
  const here = document.currentScript ? document.currentScript.src : location.href;
  const at = (path) => new URL(path, here).href;

  const FRAME_MS = 1000 * 70224 / 4194304; // one Game Boy frame, ~16.74 ms
  const SHADES = [0xee, 0xa8, 0x58, 0x18];
  // 4 shades as little-endian RGBA words
  const PALETTE = SHADES.map((g) => (0xff << 24) | (g << 16) | (g << 8) | g);

  let modulePromise = null;
  const modules = () => modulePromise || (modulePromise = import(at('gb/gb.js')));

  // ---- the file picker, shared by the screen's A button and the side panel ----
  let pick = null; // set by the attached game: (file) => void
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.gb,.gbc,.bin,application/octet-stream';
  input.hidden = true;
  document.body.appendChild(input);
  input.addEventListener('change', () => {
    const f = input.files && input.files[0];
    input.value = '';
    if (f && pick) pick(f);
  });
  let pickerAt = 0;
const openPicker = () => {
  // A browser only opens the picker inside a user gesture: a key press counts at
  // once, a touch only when it ends. So this is tried on press and again on release.
  if (navigator.userActivation && !navigator.userActivation.isActive) return;
  pickerAt = performance.now();
  input.click();
};
  const romBtn = document.getElementById('romBtn');
  if (romBtn) romBtn.addEventListener('click', openPicker);
  window.addEventListener('dragover', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return;
    e.preventDefault();
    if (pick) pick(f);
  });

  // ---- sound: the emulator's samples through a ring buffer ----
  function createAudio() {
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC({ latencyHint: 'interactive' });
    const size = Math.ceil(ctx.sampleRate / 2);
    const ringL = new Float32Array(size), ringR = new Float32Array(size);
    let r = 0, w = 0, count = 0;
    const a = { ctx, rate: ctx.sampleRate, muted: false };
    // Keep at most ~150 ms queued, so the sound never lags far behind the picture.
    const limit = Math.floor(ctx.sampleRate * 0.15);
    a.push = (l, rr) => {
      if (count >= limit) return;
      ringL[w] = l; ringR[w] = rr;
      w = (w + 1) % size; count++;
    };
    a.clear = () => { r = w = count = 0; };
    const node = ctx.createScriptProcessor(1024, 0, 2);
    node.onaudioprocess = (e) => {
      const L = e.outputBuffer.getChannelData(0), R = e.outputBuffer.getChannelData(1);
      for (let i = 0; i < L.length; i++) {
        if (count > 0 && !a.muted) { L[i] = ringL[r]; R[i] = ringR[r]; } else { L[i] = R[i] = 0; }
        if (count > 0) { r = (r + 1) % size; count--; }
      }
    };
    node.connect(ctx.destination);
    return a;
  }

  // ---- battery saves ----
  const saveKey = (gb) => {
    const rom = gb.cart.rom;
    return 'gb-save:' + gb.cart.title + ':' + rom[0x14e].toString(16) + rom[0x14f].toString(16) + ':' + rom.length;
  };
  function loadSave(gb) {
    try {
      const s = localStorage.getItem(saveKey(gb));
      if (!s) return;
      const bin = atob(s);
      const ram = gb.cart.ram;
      for (let i = 0; i < ram.length && i < bin.length; i++) ram[i] = bin.charCodeAt(i);
    } catch (e) { /* no storage: play without a save */ }
  }
  function writeSave(gb) {
    if (!gb || !gb.cart.battery || !gb.cart.ram.length || !gb.cart.ramDirty) return;
    try {
      let s = '';
      const ram = gb.cart.ram;
      for (let i = 0; i < ram.length; i += 0x2000) s += String.fromCharCode.apply(null, ram.subarray(i, i + 0x2000));
      localStorage.setItem(saveKey(gb), btoa(s));
      gb.cart.ramDirty = false;
    } catch (e) { /* storage full or blocked */ }
  }

  window.attachGame = function ({ canvas, title, click }) {
    const ctx = canvas.getContext('2d');
    const image = ctx.createImageData(160, 144);
    const pixels = new Uint32Array(image.data.buffer);

    let mod = null;            // the emulator modules, once loaded
    let demoMod = null;        // the placeholder game, shown while no ROM is loaded
    let demo = null;
    let gb = null;             // the running machine
    let romBytes = null;       // the last ROM, kept so POWER ON again restarts it
    let notice = null;         // a message to show instead of the game
    let audio = null;
    let playing = false;       // powered on
    let acc = 0, last = 0, sinceSave = 0;
    const held = {};           // buttons currently down
    let pressedAt = 0;         // when SELECT / A last went down on a screen that opens the picker

    import(at('demo.js')).then((m) => { demoMod = m; }).catch((e) => console.warn(e));
    modules().then((m) => { mod = m; }).catch((e) => {
      console.error(e);
      notice = ['CAN NOT LOAD THE', 'EMULATOR. OPEN THIS', 'PAGE OVER HTTP', '(USE PLAYER.BAT)'];
    });

    /** A few lines of text on a blank screen. */
    function message(lines) {
      ctx.fillStyle = '#e8e8e8';
      ctx.fillRect(0, 0, 160, 144);
      ctx.fillStyle = '#181818';
      ctx.font = '8px "Press Start 2P", monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const y0 = 72 - lines.length * 6;
      lines.forEach((l, i) => ctx.fillText(l, 80, y0 + i * 12));
    }

    function startDemo() {
      if (demo || !demoMod) return;
      demo = demoMod.createDemo({ canvas, title, click });
      demo.start();
    }
    function stopDemo() { if (demo) demo.stop(); demo = null; }

    function ensureAudio() {
      if (audio) return audio;
      try { audio = createAudio(); } catch (e) { console.warn('no sound:', e.message); audio = null; }
      return audio;
    }

    function boot() {
      if (!romBytes || !mod || !playing) return;
      writeSave(gb);
      try {
        const a = ensureAudio();
        const machine = new mod.GameBoy(romBytes, a ? { sampleRate: a.rate, onSample: a.push } : {});
        if (machine.cart.cgbOnly) throw new Error('GAME BOY COLOR ONLY');
        loadSave(machine);
        gb = machine;
        stopDemo();
        notice = null;
        for (const b of Object.keys(held)) if (held[b]) gb.setButton(b, true);
        if (a) { a.clear(); a.ctx.resume(); }
        acc = 0; last = 0; sinceSave = 0;
      } catch (e) {
        gb = null; romBytes = null;
        console.warn(e);
        notice = [String(e.message || e).toUpperCase().slice(0, 40), '', 'PRESS A TO LOAD', 'ANOTHER FILE'];
      }
    }

    pick = async (file) => {
      try {
        const buf = new Uint8Array(await file.arrayBuffer());
        if (!mod) await modules().then((m) => { mod = m; });
        romBytes = buf;
        if (playing) boot();
        else notice = null;
      } catch (e) {
        console.warn(e);
        notice = ['COULD NOT READ', 'THAT FILE'];
      }
    };

    const draw = () => {
      const f = gb.ppu.frame;
      for (let i = 0; i < f.length; i++) pixels[i] = PALETTE[f[i]];
      ctx.putImageData(image, 0, 0);
    };

    window.addEventListener('pagehide', () => writeSave(gb));

    return {
      start() {
        playing = true;
        notice = null;
        if (audio) audio.ctx.resume();
        else ensureAudio(); // PRESS START is the gesture that lets sound begin
        if (romBytes) boot();
      },

      update(dt) {
        if (!gb) {
          if (notice) return message(notice);
          startDemo();
          if (demo) return demo.update(dt > 0 && dt < 0.25 ? dt : 1 / 60);
          return message(['LOADING...']);
        }
        const now = performance.now();
        if (!last) last = now;
        acc += Math.min(now - last, 100);
        last = now;
        if (audio) audio.muted = !!(window.handheld && window.handheld.state && window.handheld.state.soundOn === false);
        let n = 0;
        while (acc >= FRAME_MS && n < 4) { gb.runFrame(); acc -= FRAME_MS; n++; }
        if (acc > FRAME_MS * 2) acc = 0;
        if (n) draw();
        if (++sinceSave > 300) { sinceSave = 0; writeSave(gb); }
      },

      onInput(button, isDown) {
        held[button] = isDown;
        if (gb) { gb.setButton(button, isDown); return; }
        if (!playing) return;
        // No ROM yet: SELECT (or A / START on a message screen) opens the file picker.
        if (button === 'select' || (notice && (button === 'a' || button === 'start'))) {
          if (isDown) { pressedAt = performance.now(); openPicker(); }
          else if (pickerAt < pressedAt) openPicker();
        } else if (demo) demo.onInput(button, isDown);
      },

      stop() {
        // Powered off: the machine is gone, the ROM stays for the next power-on.
        writeSave(gb);
        playing = false;
        gb = null;
        stopDemo();
        for (const b of Object.keys(held)) held[b] = false;
        if (audio) { audio.clear(); audio.ctx.suspend(); }
      },
    };
  };
})();
