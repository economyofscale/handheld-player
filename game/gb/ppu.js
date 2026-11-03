/**
 * ppu.js -- the Game Boy's picture unit: the LCD modes and their timing
 * (OAM scan, drawing, HBlank, VBlank), the STAT and VBlank interrupts, and a
 * scanline renderer for the background, the window and the sprites.
 *
 * Each visible line is drawn when its HBlank starts, with the registers as
 * they stand then, so scroll changes made by an LYC or HBlank handler land on
 * the right line. The frame is an array of shades 0 (light) .. 3 (dark).
 */

export const WIDTH = 160, HEIGHT = 144;

export class PPU {
  constructor(bus) {
    this.bus = bus;
    this.vram = new Uint8Array(0x2000);
    this.oam = new Uint8Array(0xa0);
    this.frame = new Uint8Array(WIDTH * HEIGHT); // shade per pixel
    this.bgIdx = new Uint8Array(WIDTH);          // BG colour index of this line
    this.claimed = new Uint8Array(WIDTH);
    this.reset();
  }

  reset() {
    this.lcdc = 0x91; this.stat = 0x85;
    this.scy = 0; this.scx = 0; this.ly = 0; this.lyc = 0;
    this.bgp = 0xfc; this.obp0 = 0xff; this.obp1 = 0xff;
    this.wy = 0; this.wx = 0;
    this.mode = 2; this.dot = 0;
    this.windowLine = 0;
    this.statLine = false;
    this.frameReady = false;
    this.vram.fill(0); this.oam.fill(0); this.frame.fill(0);
  }

  // ---- registers ----
  readReg(a) {
    switch (a) {
      case 0xff40: return this.lcdc;
      case 0xff41: return 0x80 | (this.stat & 0x78) | (this.ly === this.lyc ? 4 : 0) | ((this.lcdc & 0x80) ? this.mode : 0);
      case 0xff42: return this.scy; case 0xff43: return this.scx;
      case 0xff44: return this.ly; case 0xff45: return this.lyc;
      case 0xff47: return this.bgp; case 0xff48: return this.obp0; case 0xff49: return this.obp1;
      case 0xff4a: return this.wy; case 0xff4b: return this.wx;
    }
    return 0xff;
  }

  writeReg(a, v) {
    switch (a) {
      case 0xff40: {
        const was = this.lcdc & 0x80;
        this.lcdc = v;
        if (was && !(v & 0x80)) { // LCD off: back to line 0, blank screen
          this.ly = 0; this.dot = 0; this.mode = 0; this.windowLine = 0;
          this.statLine = false;
          this.frame.fill(0);
        } else if (!was && (v & 0x80)) {
          this.ly = 0; this.dot = 0; this.mode = 2; this.windowLine = 0;
          this.updateStat();
        }
        break;
      }
      case 0xff41: this.stat = v & 0x78; this.updateStat(); break;
      case 0xff42: this.scy = v; break; case 0xff43: this.scx = v; break;
      case 0xff44: break; // LY is read-only
      case 0xff45: this.lyc = v; this.updateStat(); break;
      case 0xff47: this.bgp = v; break; case 0xff48: this.obp0 = v; break; case 0xff49: this.obp1 = v; break;
      case 0xff4a: this.wy = v; break; case 0xff4b: this.wx = v; break;
    }
  }

  /** The STAT interrupt fires on a rising edge of the OR of its sources. */
  updateStat() {
    let line = false;
    if (this.lcdc & 0x80) {
      const s = this.stat;
      line = (this.ly === this.lyc && (s & 0x40)) ||
        (this.mode === 0 && (s & 0x08)) || (this.mode === 1 && (s & 0x10)) || (this.mode === 2 && (s & 0x20));
    }
    if (line && !this.statLine) this.bus.if |= 2;
    this.statLine = !!line;
  }

  /** Advance by `c` dots (clock cycles). */
  step(c) {
    if (!(this.lcdc & 0x80)) return;
    this.dot += c;
    for (;;) {
      if (this.mode === 2) {
        if (this.dot < 80) break;
        this.mode = 3;
      } else if (this.mode === 3) {
        if (this.dot < 252) break;
        this.renderLine();
        this.mode = 0;
        this.updateStat();
      } else if (this.mode === 0) {
        if (this.dot < 456) break;
        this.dot -= 456;
        this.ly++;
        if (this.ly === 144) {
          this.mode = 1;
          this.bus.if |= 1;
          this.frameReady = true;
        } else this.mode = 2;
        this.updateStat();
      } else {
        if (this.dot < 456) break;
        this.dot -= 456;
        this.ly++;
        if (this.ly === 154) { this.ly = 0; this.mode = 2; this.windowLine = 0; }
        this.updateStat();
      }
    }
  }

  renderLine() {
    const ly = this.ly, lcdc = this.lcdc;
    const vram = this.vram, bgIdx = this.bgIdx;
    const out = ly * WIDTH;
    const bgp = this.bgp;

    if (lcdc & 1) {
      // Background
      const map = (lcdc & 0x08) ? 0x1c00 : 0x1800;
      const unsigned = !!(lcdc & 0x10);
      const y = (ly + this.scy) & 255, row = (y >> 3) << 5, ty = (y & 7) << 1;
      for (let x = 0; x < WIDTH; x++) {
        const px = (x + this.scx) & 255;
        const t = vram[map + row + (px >> 3)];
        const addr = (unsigned ? t * 16 : 0x1000 + ((t << 24 >> 24) * 16)) + ty;
        const bit = 7 - (px & 7);
        const ci = (((vram[addr + 1] >> bit) & 1) << 1) | ((vram[addr] >> bit) & 1);
        bgIdx[x] = ci;
        this.frame[out + x] = (bgp >> (ci * 2)) & 3;
      }
      // Window
      const wx = this.wx - 7;
      if ((lcdc & 0x20) && ly >= this.wy && wx < WIDTH) {
        const wmap = (lcdc & 0x40) ? 0x1c00 : 0x1800;
        const wrow = (this.windowLine >> 3) << 5, wty = (this.windowLine & 7) << 1;
        for (let x = Math.max(0, wx); x < WIDTH; x++) {
          const px = x - wx;
          const t = vram[wmap + wrow + (px >> 3)];
          const addr = (unsigned ? t * 16 : 0x1000 + ((t << 24 >> 24) * 16)) + wty;
          const bit = 7 - (px & 7);
          const ci = (((vram[addr + 1] >> bit) & 1) << 1) | ((vram[addr] >> bit) & 1);
          bgIdx[x] = ci;
          this.frame[out + x] = (bgp >> (ci * 2)) & 3;
        }
        this.windowLine++;
      }
    } else {
      bgIdx.fill(0);
      this.frame.fill(0, out, out + WIDTH);
    }

    if (lcdc & 2) this.renderSprites(ly, out);
  }

  renderSprites(ly, out) {
    const tall = (this.lcdc & 4) ? 16 : 8;
    const oam = this.oam, vram = this.vram, claimed = this.claimed;
    // The first ten sprites on this line, in OAM order.
    const hit = [];
    for (let i = 0; i < 40 && hit.length < 10; i++) {
      const sy = oam[i * 4] - 16;
      if (ly >= sy && ly < sy + tall) hit.push(i);
    }
    if (!hit.length) return;
    // Lower X wins; on a tie the earlier sprite.
    hit.sort((p, q) => (oam[p * 4 + 1] - oam[q * 4 + 1]) || (p - q));
    claimed.fill(0);
    for (const i of hit) {
      const sx = oam[i * 4 + 1] - 8;
      if (sx <= -8 || sx >= WIDTH) continue;
      let tile = oam[i * 4 + 2];
      const attr = oam[i * 4 + 3];
      let row = ly - (oam[i * 4] - 16);
      if (attr & 0x40) row = tall - 1 - row;
      if (tall === 16) tile &= 0xfe;
      const addr = tile * 16 + row * 2;
      const lo = vram[addr], hi = vram[addr + 1];
      const pal = (attr & 0x10) ? this.obp1 : this.obp0;
      for (let p = 0; p < 8; p++) {
        const x = sx + p;
        if (x < 0 || x >= WIDTH || claimed[x]) continue;
        const bit = (attr & 0x20) ? p : 7 - p;
        const ci = (((hi >> bit) & 1) << 1) | ((lo >> bit) & 1);
        if (!ci) continue;
        claimed[x] = 1;
        if ((attr & 0x80) && this.bgIdx[x]) continue; // behind BG colours 1-3
        this.frame[out + x] = (pal >> (ci * 2)) & 3;
      }
    }
  }
}
