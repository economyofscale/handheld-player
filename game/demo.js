/*
 * demo.js -- the placeholder game the handheld shows while no ROM is loaded:
 * a blob that runs and jumps through a looping landscape, collecting coins.
 * Everything is drawn in code (no assets), as a stand-in cartridge.
 *
 *   createDemo({ canvas, title, click }) -> { start, update(dt), onInput, stop }
 */

const W = 160, H = 144, GY = 120;
const C = ['#EEEEEE', '#A8A8A8', '#585858', '#181818']; // 4 shades, light -> dark
const BLOB = [
  '....3333....',
  '..33000033..',
  '.3000000003.',
  '.3003003003.',
  '300030030003',
  '301000000103',
  '300000000003',
  '300003300003',
  '.3000000003.',
  '.3000000003.',
  '..33000033..',
  '....3333....',
];

const coinAt = (k) => ({ x: k * 44 + 30, h: 14 + ((k * 37) % 3) * 9 });

function wrap(s, max) {
  const words = String(s).toUpperCase().split(/\s+/);
  const lines = [];
  let cur = '';
  words.forEach((w) => {
    if ((cur + ' ' + w).trim().length > max && cur) { lines.push(cur); cur = w; }
    else cur = (cur + ' ' + w).trim();
  });
  if (cur) lines.push(cur);
  return lines.slice(0, 4);
}

export function createDemo({ canvas, title, click }) {
  const g = canvas.getContext('2d');
  const st = { phase: 'title', t: 0, scroll: 0, py: 0, vy: 0, held: {}, got: new Set(), score: 0, paused: false, face: 1 };

  function sprite(map, x, y, flip) {
    for (let r = 0; r < map.length; r++) {
      const row = map[r];
      for (let c = 0; c < row.length; c++) {
        const ch = row[flip ? row.length - 1 - c : c];
        if (ch === '.') continue;
        g.fillStyle = C[+ch];
        g.fillRect(x + c, y + r, 1, 1);
      }
    }
  }
  function text(s, x, y, col, align) {
    g.fillStyle = col;
    g.font = '8px "Press Start 2P", monospace';
    g.textBaseline = 'top';
    g.textAlign = align || 'center';
    g.fillText(s, x, y);
  }

  function draw() {
    g.fillStyle = C[0];
    g.fillRect(0, 0, W, H);
    const s = st.scroll;
    g.fillStyle = C[1];
    for (let x = 0; x < W; x++) {
      const u = x + s * 0.3;
      const h = 16 + 7 * Math.sin(u * 0.045) + 5 * Math.sin(u * 0.12 + 1.3);
      g.fillRect(x, GY - h, 1, h);
    }
    g.fillRect(0, GY, W, H - GY);
    g.fillStyle = C[3];
    g.fillRect(0, GY, W, 1);
    g.fillStyle = C[2];
    for (let row = 0; row < 3; row++) {
      const y = GY + 1 + row * 8;
      g.fillRect(0, y + 7, W, 1);
      const off = ((-s) % 16 + 16) % 16 + (row % 2 ? 8 : 0);
      for (let x = off - 16; x < W; x += 16) g.fillRect(x, y, 1, 7);
    }
    if (st.phase === 'play') {
      const k0 = Math.floor((s - 20) / 44), k1 = Math.ceil((s + W) / 44);
      for (let k = k0; k <= k1; k++) {
        if (st.got.has(k)) continue;
        const c = coinAt(k);
        const cx = Math.round(c.x - s), cy = GY - c.h - 6;
        g.fillStyle = C[3]; g.fillRect(cx + 1, cy, 4, 6); g.fillRect(cx, cy + 1, 6, 4);
        g.fillStyle = C[0]; g.fillRect(cx + 2, cy + 1, 2, 4);
      }
    }
    sprite(BLOB, st.phase === 'title' ? 74 : 52, Math.round(GY - 12 - st.py), st.face < 0);
    if (st.phase === 'title') {
      const lines = wrap(title || 'DEMO GAME', 17);
      const y0 = 26 - (lines.length - 1) * 6;
      lines.forEach((ln, i) => text(ln, 80, y0 + i * 12, C[3]));
      if (Math.floor(st.t * 2) % 2 === 0) text('PRESS START', 80, 66, C[2]);
      text('SELECT: LOAD ROM', 80, 84, C[2]);
    } else {
      text('SCORE ' + String(st.score).padStart(4, '0'), 6, 6, C[3], 'left');
      if (st.paused) {
        g.fillStyle = C[0]; g.fillRect(44, 54, 72, 20);
        g.fillStyle = C[3]; g.fillRect(44, 54, 72, 1); g.fillRect(44, 73, 72, 1);
        text('PAUSE', 80, 60, C[3]);
      }
    }
  }

  return {
    start() { st.phase = 'title'; st.t = 0; st.scroll = 0; st.py = 0; st.vy = 0; st.held = {}; draw(); },
    stop() { st.held = {}; },
    onInput(b, down) {
      st.held[b] = down;
      if (!down) return;
      if (st.phase === 'title') {
        if (b === 'start' || b === 'a') { st.phase = 'play'; st.score = 0; st.got = new Set(); st.py = 0; st.vy = 0; }
        return;
      }
      if (b === 'start') st.paused = !st.paused;
      if (!st.paused && (b === 'a' || b === 'up') && st.py === 0) st.vy = 165;
    },
    update(dt) {
      st.t += dt;
      if (st.phase === 'title') {
        st.scroll += 18 * dt;
        st.py = Math.abs(Math.sin(st.t * 3.2)) * 22;
      } else if (!st.paused) {
        const sp = st.held.b ? 90 : 55;
        if (st.held.right) { st.scroll += sp * dt; st.face = 1; }
        if (st.held.left) { st.scroll -= sp * dt; st.face = -1; }
        st.vy -= 430 * dt;
        st.py = Math.max(0, st.py + st.vy * dt);
        if (st.py === 0 && st.vy < 0) st.vy = 0;
        const k0 = Math.floor((st.scroll + 40) / 44);
        for (let k = k0 - 1; k <= k0 + 2; k++) {
          if (st.got.has(k)) continue;
          const c = coinAt(k);
          const cx = c.x - st.scroll;
          if (cx > 46 && cx < 64 && st.py + 12 > c.h && st.py < c.h + 6) {
            st.got.add(k); st.score += 10;
            if (click) click(4200, 0.03, 0.04);
          }
        }
      }
      draw();
    },
  };
}
