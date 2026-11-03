/**
 * cart.js -- a Game Boy cartridge: the ROM image, its header, the memory
 * bank controller (none, MBC1, MBC2, MBC3 with a clock, MBC5) and the
 * battery-backed RAM.
 */

const TYPES = {
  0x00: ['none'], 0x01: ['mbc1'], 0x02: ['mbc1', 'ram'], 0x03: ['mbc1', 'ram', 'battery'],
  0x05: ['mbc2'], 0x06: ['mbc2', 'battery'],
  0x08: ['none', 'ram'], 0x09: ['none', 'ram', 'battery'],
  0x0f: ['mbc3', 'battery', 'rtc'], 0x10: ['mbc3', 'ram', 'battery', 'rtc'],
  0x11: ['mbc3'], 0x12: ['mbc3', 'ram'], 0x13: ['mbc3', 'ram', 'battery'],
  0x19: ['mbc5'], 0x1a: ['mbc5', 'ram'], 0x1b: ['mbc5', 'ram', 'battery'],
  0x1c: ['mbc5', 'rumble'], 0x1d: ['mbc5', 'ram', 'rumble'], 0x1e: ['mbc5', 'ram', 'battery', 'rumble'],
};
const RAM_SIZES = [0, 0, 8 * 1024, 32 * 1024, 128 * 1024, 64 * 1024];

export class Cart {
  /** @param {Uint8Array} rom the whole file */
  constructor(rom) {
    if (rom.length < 0x150) throw new Error('not a Game Boy ROM (too small)');
    // Pad to a power of two so bank numbers can simply wrap.
    let size = 0x8000;
    while (size < rom.length) size <<= 1;
    this.rom = new Uint8Array(size);
    this.rom.set(rom);
    this.banks = size >> 14;

    const type = rom[0x147];
    const feat = TYPES[type];
    if (!feat) throw new Error('unsupported cartridge type $' + type.toString(16));
    this.type = type;
    this.mbc = feat[0];
    this.battery = feat.includes('battery');
    this.hasRtc = feat.includes('rtc');

    let name = '';
    for (let i = 0x134; i < 0x143; i++) { const c = rom[i]; if (c < 32 || c > 126) break; name += String.fromCharCode(c); }
    this.title = name.trim();
    this.cgbOnly = rom[0x143] === 0xc0;
    let sum = 0;
    for (let i = 0x134; i <= 0x14c; i++) sum = (sum - rom[i] - 1) & 0xff;
    this.headerOk = sum === rom[0x14d];

    let ramSize = RAM_SIZES[rom[0x149]] || 0;
    if (this.mbc === 'mbc2') ramSize = 512;
    if (feat.includes('ram') && !ramSize) ramSize = 8 * 1024;
    this.ram = new Uint8Array(ramSize);
    this.ramDirty = false;

    this.ramEnable = false;
    this.bank1 = 1;      // low bank register (MBC1: 5 bits, MBC3: 7, MBC5: 8)
    this.bank2 = 0;      // MBC1: 2 bits; MBC5: bit 9; also the RAM bank
    this.mode = 0;       // MBC1 banking mode
    this.rtc = { s: 0, m: 0, h: 0, dl: 0, dh: 0 };
    this.rtcLatched = { s: 0, m: 0, h: 0, dl: 0, dh: 0 };
    this.rtcBase = Date.now();
    this.latchPrev = 0;
  }

  /** The ROM bank at $4000-$7fff and the one at $0000-$3fff. */
  romBank(hi) {
    const n = this.banks - 1;
    switch (this.mbc) {
      case 'mbc1':
        return hi ? (((this.bank2 << 5) | this.bank1) & n) : (this.mode ? (this.bank2 << 5) & n : 0);
      case 'mbc2': case 'mbc3':
        return hi ? this.bank1 & n : 0;
      case 'mbc5':
        return hi ? (((this.bank2 & 1) << 8) | this.bank1) & n : 0;
      default:
        return hi ? 1 & n : 0;
    }
  }

  read(addr) {
    if (addr < 0x4000) return this.rom[(this.romBank(0) << 14) | addr];
    return this.rom[(this.romBank(1) << 14) | (addr & 0x3fff)];
  }

  write(addr, v) {
    const r = addr >> 13; // 0: $0000, 1: $2000, 2: $4000, 3: $6000
    switch (this.mbc) {
      case 'mbc1':
        if (r === 0) this.ramEnable = (v & 0x0f) === 0x0a;
        else if (r === 1) this.bank1 = (v & 0x1f) || 1;
        else if (r === 2) this.bank2 = v & 3;
        else this.mode = v & 1;
        break;
      case 'mbc2':
        if (addr < 0x4000) {
          if (addr & 0x100) this.bank1 = (v & 0x0f) || 1;
          else this.ramEnable = (v & 0x0f) === 0x0a;
        }
        break;
      case 'mbc3':
        if (r === 0) this.ramEnable = (v & 0x0f) === 0x0a;
        else if (r === 1) this.bank1 = (v & 0x7f) || 1;
        else if (r === 2) this.bank2 = v & 0x0f;
        else {
          if (this.latchPrev === 0 && v === 1) this.latchClock();
          this.latchPrev = v;
        }
        break;
      case 'mbc5':
        if (r === 0) this.ramEnable = (v & 0x0f) === 0x0a;
        else if (addr < 0x3000 && r === 1) this.bank1 = v;
        else if (r === 1) this.bank2 = (this.bank2 & 0x0f) | ((v & 1) << 8);
        else if (r === 2) this.bank2 = (this.bank2 & 0x100) | (v & 0x0f);
        break;
    }
  }

  ramBank() {
    if (this.mbc === 'mbc1') return this.mode ? this.bank2 : 0;
    if (this.mbc === 'mbc5') return this.bank2 & 0x0f;
    return this.bank2 & 3;
  }

  readRam(addr) {
    if (!this.ramEnable) return 0xff;
    if (this.mbc === 'mbc2') return 0xf0 | this.ram[addr & 0x1ff];
    if (this.mbc === 'mbc3' && this.bank2 >= 8) {
      if (!this.hasRtc) return 0xff;
      return [this.rtcLatched.s, this.rtcLatched.m, this.rtcLatched.h, this.rtcLatched.dl, this.rtcLatched.dh][this.bank2 - 8] ?? 0xff;
    }
    if (!this.ram.length) return 0xff;
    return this.ram[((this.ramBank() << 13) | (addr & 0x1fff)) % this.ram.length];
  }

  writeRam(addr, v) {
    if (!this.ramEnable) return;
    if (this.mbc === 'mbc2') { this.ram[addr & 0x1ff] = v & 0x0f; this.ramDirty = true; return; }
    if (this.mbc === 'mbc3' && this.bank2 >= 8) {
      // The clock registers: set the base so the clock reads back this value.
      if (this.hasRtc) {
        this.latchClock();
        const k = ['s', 'm', 'h', 'dl', 'dh'][this.bank2 - 8];
        if (k) { this.rtcLatched[k] = v; this.setClock(this.rtcLatched); }
      }
      return;
    }
    if (!this.ram.length) return;
    this.ram[((this.ramBank() << 13) | (addr & 0x1fff)) % this.ram.length] = v;
    this.ramDirty = true;
  }

  clockSeconds() {
    return Math.floor((Date.now() - this.rtcBase) / 1000);
  }
  latchClock() {
    const t = this.clockSeconds();
    const days = Math.floor(t / 86400) & 0x1ff;
    const carry = Math.floor(t / 86400) > 0x1ff;
    this.rtcLatched = {
      s: t % 60, m: Math.floor(t / 60) % 60, h: Math.floor(t / 3600) % 24,
      dl: days & 0xff, dh: ((days >> 8) & 1) | (carry ? 0x80 : 0),
    };
  }
  setClock(c) {
    const days = c.dl | ((c.dh & 1) << 8);
    const t = days * 86400 + (c.h % 24) * 3600 + (c.m % 60) * 60 + (c.s % 60);
    this.rtcBase = Date.now() - t * 1000;
  }
}
