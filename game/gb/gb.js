/**
 * gb.js -- the Game Boy itself: the memory map and the little devices on it
 * (work RAM, joypad, timer, OAM DMA, serial), wired to the CPU, the picture
 * unit and the sound. Everything advances in lock-step, one instruction at a
 * time: the CPU says how many cycles it took, the rest catches up.
 */

import { CPU } from './cpu.js';
import { PPU } from './ppu.js';
import { APU } from './apu.js';
import { Cart } from './cart.js';

export const CYCLES_PER_FRAME = 70224;

/** Joypad bits as the handheld names its buttons. */
export const BUTTON = { right: 0x01, left: 0x02, up: 0x04, down: 0x08, a: 0x10, b: 0x20, select: 0x40, start: 0x80 };

const TIMER_SHIFT = [10, 4, 6, 8]; // TAC clock select -> bit of DIV that clocks TIMA

export class GameBoy {
  /**
   * @param {Uint8Array} romBytes
   * @param {object} [opts]
   * @param {number} [opts.sampleRate] audio rate; 0/absent runs silent
   * @param {(l:number, r:number) => void} [opts.onSample]
   */
  constructor(romBytes, opts = {}) {
    this.cart = new Cart(romBytes);
    this.wram = new Uint8Array(0x2000);
    this.hram = new Uint8Array(0x7f);
    this.io = new Uint8Array(0x80);
    this.ie = 0;
    this.if = 0xe1;
    this.joy = 0;              // pressed buttons (BUTTON bits)
    this.joySelect = 0x30;
    this.div = 0xab00; this.tima = 0; this.tma = 0; this.tac = 0xf8;
    this.serial = '';          // what the ROM sent to the link port
    this.ppu = new PPU(this);
    this.apu = new APU(opts.sampleRate || 44100, opts.onSample || (() => {}));
    this.audioOn = !!opts.sampleRate;
    this.cpu = new CPU(this);
    this.cycles = 0;
  }

  // ---- memory map ----
  read(a) {
    if (a < 0x8000) return this.cart.read(a);
    if (a < 0xa000) return this.ppu.vram[a - 0x8000];
    if (a < 0xc000) return this.cart.readRam(a);
    if (a < 0xe000) return this.wram[a - 0xc000];
    if (a < 0xfe00) return this.wram[a - 0xe000];
    if (a < 0xfea0) return this.ppu.oam[a - 0xfe00];
    if (a < 0xff00) return 0xff;
    if (a < 0xff80) return this.readIo(a);
    if (a < 0xffff) return this.hram[a - 0xff80];
    return this.ie;
  }

  write(a, v) {
    if (a < 0x8000) this.cart.write(a, v);
    else if (a < 0xa000) this.ppu.vram[a - 0x8000] = v;
    else if (a < 0xc000) this.cart.writeRam(a, v);
    else if (a < 0xe000) this.wram[a - 0xc000] = v;
    else if (a < 0xfe00) this.wram[a - 0xe000] = v;
    else if (a < 0xfea0) this.ppu.oam[a - 0xfe00] = v;
    else if (a < 0xff00) { /* unusable */ }
    else if (a < 0xff80) this.writeIo(a, v);
    else if (a < 0xffff) this.hram[a - 0xff80] = v;
    else this.ie = v;
  }

  readIo(a) {
    switch (a) {
      case 0xff00: {
        let v = 0xcf | this.joySelect;
        if (!(this.joySelect & 0x10)) v &= ~(this.joy & 0x0f);        // directions
        if (!(this.joySelect & 0x20)) v &= ~((this.joy >> 4) & 0x0f); // buttons
        return v;
      }
      case 0xff01: return this.io[1];
      case 0xff02: return this.io[2] | 0x7e;
      case 0xff04: return this.div >> 8;
      case 0xff05: return this.tima;
      case 0xff06: return this.tma;
      case 0xff07: return this.tac | 0xf8;
      case 0xff0f: return this.if | 0xe0;
    }
    if (a >= 0xff10 && a <= 0xff3f) return this.apu.readReg(a);
    if (a >= 0xff40 && a <= 0xff4b && a !== 0xff46) return this.ppu.readReg(a);
    if (a === 0xff46) return this.io[0x46];
    return 0xff;
  }

  writeIo(a, v) {
    switch (a) {
      case 0xff00: this.joySelect = v & 0x30; return;
      case 0xff01: this.io[1] = v; return;
      case 0xff02:
        this.io[2] = v;
        if (v === 0x81) { this.serial += String.fromCharCode(this.io[1]); this.io[2] = 0x01; }
        return;
      case 0xff04: // writing DIV clears it; that can clock TIMA by a falling edge
        if ((this.tac & 4) && (this.div & (1 << (TIMER_SHIFT[this.tac & 3] - 1)))) this.clockTima();
        this.div = 0; return;
      case 0xff05: this.tima = v; return;
      case 0xff06: this.tma = v; return;
      case 0xff07: this.tac = v & 7; return;
      case 0xff0f: this.if = v & 0x1f; return;
      case 0xff46: { // OAM DMA, done at once
        this.io[0x46] = v;
        const src = v << 8;
        for (let i = 0; i < 0xa0; i++) this.ppu.oam[i] = this.read(src + i);
        return;
      }
    }
    if (a >= 0xff10 && a <= 0xff3f) this.apu.writeReg(a, v);
    else if (a >= 0xff40 && a <= 0xff4b) this.ppu.writeReg(a, v);
  }

  clockTima() {
    if (++this.tima > 0xff) { this.tima = this.tma; this.if |= 4; }
  }

  tickTimer(c) {
    const old = this.div;
    this.div = (old + c) & 0xffff;
    if (this.tac & 4) {
      const sh = TIMER_SHIFT[this.tac & 3];
      const edges = ((old + c) >> sh) - (old >> sh);
      for (let i = 0; i < edges; i++) this.clockTima();
    }
  }

  // ---- input ----
  /** Press or release a button by the handheld's name ('up', 'a', 'start', ...). */
  setButton(name, down) {
    const bit = BUTTON[name];
    if (!bit) return;
    const was = this.joy;
    this.joy = down ? was | bit : was & ~bit;
    if (down && !(was & bit)) {
      // A press on a selected row raises the joypad interrupt.
      const dir = bit & 0x0f, btn = bit >> 4;
      if ((dir && !(this.joySelect & 0x10)) || (btn && !(this.joySelect & 0x20))) this.if |= 0x10;
    }
  }

  // ---- running ----
  /** Run one instruction. */
  step() {
    const c = this.cpu.step();
    this.tickTimer(c);
    this.ppu.step(c);
    if (this.audioOn) this.apu.step(c);
    this.cycles += c;
    return c;
  }

  /** Run until the picture unit finishes a frame (or `limit` cycles pass). */
  runFrame(limit = CYCLES_PER_FRAME * 2) {
    const ppu = this.ppu;
    ppu.frameReady = false;
    let n = 0;
    while (!ppu.frameReady && n < limit) n += this.step();
    return n;
  }
}
