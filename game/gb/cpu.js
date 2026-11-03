/**
 * cpu.js -- the Game Boy's SM83 CPU: every documented opcode, interrupts,
 * HALT (with its bug) and EI's one-instruction delay. step() runs one
 * instruction (or one idle HALT slot, or one interrupt dispatch) and returns
 * the clock cycles it took (4 per machine cycle).
 */

const FZ = 0x80, FN = 0x40, FH = 0x20, FC = 0x10;

export class CPU {
  constructor(bus) {
    this.bus = bus;
    this.reset();
  }

  /** The state the boot ROM leaves behind (DMG). */
  reset() {
    this.a = 0x01; this.f = 0xb0;
    this.b = 0x00; this.c = 0x13;
    this.d = 0x00; this.e = 0xd8;
    this.h = 0x01; this.l = 0x4d;
    this.sp = 0xfffe; this.pc = 0x0100;
    this.ime = false;
    this.eiDelay = 0;
    this.halted = false;
    this.haltBug = false;
  }

  // ---- 8-bit register file by opcode index: B C D E H L (HL) A ----
  get8(i) {
    switch (i) {
      case 0: return this.b; case 1: return this.c; case 2: return this.d; case 3: return this.e;
      case 4: return this.h; case 5: return this.l;
      case 6: return this.bus.read((this.h << 8) | this.l);
      default: return this.a;
    }
  }
  set8(i, v) {
    switch (i) {
      case 0: this.b = v; break; case 1: this.c = v; break; case 2: this.d = v; break; case 3: this.e = v; break;
      case 4: this.h = v; break; case 5: this.l = v; break;
      case 6: this.bus.write((this.h << 8) | this.l, v); break;
      default: this.a = v;
    }
  }
  get bc() { return (this.b << 8) | this.c; }
  get de() { return (this.d << 8) | this.e; }
  get hl() { return (this.h << 8) | this.l; }
  set hl(v) { this.h = (v >> 8) & 0xff; this.l = v & 0xff; }
  get16(i) { // BC DE HL SP
    switch (i) {
      case 0: return (this.b << 8) | this.c; case 1: return (this.d << 8) | this.e;
      case 2: return (this.h << 8) | this.l; default: return this.sp;
    }
  }
  set16(i, v) {
    v &= 0xffff;
    switch (i) {
      case 0: this.b = v >> 8; this.c = v & 0xff; break;
      case 1: this.d = v >> 8; this.e = v & 0xff; break;
      case 2: this.h = v >> 8; this.l = v & 0xff; break;
      default: this.sp = v;
    }
  }

  fetch8() { const v = this.bus.read(this.pc); this.pc = (this.pc + 1) & 0xffff; return v; }
  fetch16() { const lo = this.fetch8(); return lo | (this.fetch8() << 8); }
  push(v) {
    this.sp = (this.sp - 1) & 0xffff; this.bus.write(this.sp, v >> 8);
    this.sp = (this.sp - 1) & 0xffff; this.bus.write(this.sp, v & 0xff);
  }
  pop() {
    const lo = this.bus.read(this.sp); this.sp = (this.sp + 1) & 0xffff;
    const hi = this.bus.read(this.sp); this.sp = (this.sp + 1) & 0xffff;
    return lo | (hi << 8);
  }

  cond(cc) { // NZ Z NC C
    switch (cc) {
      case 0: return !(this.f & FZ); case 1: return !!(this.f & FZ);
      case 2: return !(this.f & FC); default: return !!(this.f & FC);
    }
  }

  // ---- ALU ----
  alu(op, v) {
    const a = this.a;
    let r;
    switch (op) {
      case 0: // ADD
        r = a + v;
        this.f = ((r & 0xff) === 0 ? FZ : 0) | (((a & 0xf) + (v & 0xf)) > 0xf ? FH : 0) | (r > 0xff ? FC : 0);
        this.a = r & 0xff; break;
      case 1: { // ADC
        const c = (this.f & FC) ? 1 : 0;
        r = a + v + c;
        this.f = ((r & 0xff) === 0 ? FZ : 0) | (((a & 0xf) + (v & 0xf) + c) > 0xf ? FH : 0) | (r > 0xff ? FC : 0);
        this.a = r & 0xff; break;
      }
      case 2: // SUB
        r = a - v;
        this.f = FN | ((r & 0xff) === 0 ? FZ : 0) | (((a & 0xf) - (v & 0xf)) < 0 ? FH : 0) | (r < 0 ? FC : 0);
        this.a = r & 0xff; break;
      case 3: { // SBC
        const c = (this.f & FC) ? 1 : 0;
        r = a - v - c;
        this.f = FN | ((r & 0xff) === 0 ? FZ : 0) | (((a & 0xf) - (v & 0xf) - c) < 0 ? FH : 0) | (r < 0 ? FC : 0);
        this.a = r & 0xff; break;
      }
      case 4: this.a = a & v; this.f = (this.a === 0 ? FZ : 0) | FH; break;
      case 5: this.a = a ^ v; this.f = this.a === 0 ? FZ : 0; break;
      case 6: this.a = a | v; this.f = this.a === 0 ? FZ : 0; break;
      default: // CP
        r = a - v;
        this.f = FN | ((r & 0xff) === 0 ? FZ : 0) | (((a & 0xf) - (v & 0xf)) < 0 ? FH : 0) | (r < 0 ? FC : 0);
    }
  }

  inc8(v) {
    const r = (v + 1) & 0xff;
    this.f = (this.f & FC) | (r === 0 ? FZ : 0) | ((v & 0xf) === 0xf ? FH : 0);
    return r;
  }
  dec8(v) {
    const r = (v - 1) & 0xff;
    this.f = (this.f & FC) | FN | (r === 0 ? FZ : 0) | ((v & 0xf) === 0 ? FH : 0);
    return r;
  }

  /** SP + signed immediate, with the flags ADD SP,e and LD HL,SP+e share. */
  spPlus(e) {
    const sp = this.sp;
    this.f = (((sp & 0xf) + (e & 0xf)) > 0xf ? FH : 0) | (((sp & 0xff) + (e & 0xff)) > 0xff ? FC : 0);
    return (sp + (e << 24 >> 24)) & 0xffff;
  }

  daa() {
    let a = this.a, adj = 0, c = this.f & FC;
    const n = this.f & FN;
    if ((this.f & FH) || (!n && (a & 0xf) > 9)) adj |= 0x06;
    if (c || (!n && a > 0x99)) { adj |= 0x60; c = FC; }
    a = (n ? a - adj : a + adj) & 0xff;
    this.a = a;
    this.f = (a === 0 ? FZ : 0) | n | c;
  }

  /** The CB-prefixed rotates and shifts; sets the flags, returns the result. */
  cbShift(y, v) {
    let r, c;
    const cin = (this.f & FC) ? 1 : 0;
    switch (y) {
      case 0: c = v >> 7; r = ((v << 1) | c) & 0xff; break;         // RLC
      case 1: c = v & 1; r = (v >> 1) | (c << 7); break;            // RRC
      case 2: c = v >> 7; r = ((v << 1) | cin) & 0xff; break;       // RL
      case 3: c = v & 1; r = (v >> 1) | (cin << 7); break;          // RR
      case 4: c = v >> 7; r = (v << 1) & 0xff; break;               // SLA
      case 5: c = v & 1; r = (v >> 1) | (v & 0x80); break;          // SRA
      case 6: c = 0; r = ((v << 4) | (v >> 4)) & 0xff; break;       // SWAP
      default: c = v & 1; r = v >> 1;                               // SRL
    }
    this.f = (r === 0 ? FZ : 0) | (c ? FC : 0);
    return r;
  }

  /** One instruction; returns clock cycles. */
  step() {
    const bus = this.bus;
    const pend = bus.ie & bus.if & 0x1f;
    if (pend) {
      this.halted = false;
      if (this.ime) {
        let bit = 0;
        while (!(pend & (1 << bit))) bit++;
        this.ime = false;
        bus.if &= ~(1 << bit);
        this.push(this.pc);
        this.pc = 0x40 + bit * 8;
        return 20;
      }
    }
    if (this.halted) return 4;

    const op = bus.read(this.pc);
    if (this.haltBug) this.haltBug = false; else this.pc = (this.pc + 1) & 0xffff;
    let cyc = 4;
    const y = (op >> 3) & 7, z = op & 7;

    if (op < 0x40) {
      switch (z) {
        case 0:
          if (y === 0) break;
          if (y === 1) { const a = this.fetch16(); bus.write(a, this.sp & 0xff); bus.write((a + 1) & 0xffff, this.sp >> 8); cyc = 20; break; }
          if (y === 2) { this.fetch8(); break; } // STOP: treated as a two-byte NOP
          if (y === 3) { const e = this.fetch8() << 24 >> 24; this.pc = (this.pc + e) & 0xffff; cyc = 12; break; }
          { const e = this.fetch8() << 24 >> 24;
            if (this.cond(y - 4)) { this.pc = (this.pc + e) & 0xffff; cyc = 12; } else cyc = 8; }
          break;
        case 1:
          if (!(y & 1)) { this.set16(y >> 1, this.fetch16()); cyc = 12; }
          else {
            const hl = this.hl, v = this.get16(y >> 1), r = hl + v;
            this.f = (this.f & FZ) | (((hl & 0xfff) + (v & 0xfff)) > 0xfff ? FH : 0) | (r > 0xffff ? FC : 0);
            this.hl = r; cyc = 8;
          }
          break;
        case 2: {
          cyc = 8;
          switch (y) {
            case 0: bus.write(this.bc, this.a); break;
            case 1: this.a = bus.read(this.bc); break;
            case 2: bus.write(this.de, this.a); break;
            case 3: this.a = bus.read(this.de); break;
            case 4: { const hl = this.hl; bus.write(hl, this.a); this.hl = hl + 1; break; }
            case 5: { const hl = this.hl; this.a = bus.read(hl); this.hl = hl + 1; break; }
            case 6: { const hl = this.hl; bus.write(hl, this.a); this.hl = hl - 1; break; }
            default: { const hl = this.hl; this.a = bus.read(hl); this.hl = hl - 1; }
          }
          break;
        }
        case 3:
          this.set16(y >> 1, this.get16(y >> 1) + ((y & 1) ? -1 : 1)); cyc = 8; break;
        case 4: this.set8(y, this.inc8(this.get8(y))); cyc = y === 6 ? 12 : 4; break;
        case 5: this.set8(y, this.dec8(this.get8(y))); cyc = y === 6 ? 12 : 4; break;
        case 6: this.set8(y, this.fetch8()); cyc = y === 6 ? 12 : 8; break;
        default:
          switch (y) {
            case 0: { const c = this.a >> 7; this.a = ((this.a << 1) | c) & 0xff; this.f = c ? FC : 0; break; }
            case 1: { const c = this.a & 1; this.a = (this.a >> 1) | (c << 7); this.f = c ? FC : 0; break; }
            case 2: { const c = this.a >> 7; this.a = ((this.a << 1) | ((this.f & FC) ? 1 : 0)) & 0xff; this.f = c ? FC : 0; break; }
            case 3: { const c = this.a & 1; this.a = (this.a >> 1) | ((this.f & FC) ? 0x80 : 0); this.f = c ? FC : 0; break; }
            case 4: this.daa(); break;
            case 5: this.a ^= 0xff; this.f |= FN | FH; break;
            case 6: this.f = (this.f & FZ) | FC; break;
            default: this.f = (this.f & FZ) | ((this.f & FC) ? 0 : FC);
          }
      }
    } else if (op < 0x80) {
      if (op === 0x76) { // HALT
        if (!this.ime && (bus.ie & bus.if & 0x1f)) this.haltBug = true;
        else this.halted = true;
      } else {
        this.set8(y, this.get8(z));
        cyc = (y === 6 || z === 6) ? 8 : 4;
      }
    } else if (op < 0xc0) {
      this.alu(y, this.get8(z));
      cyc = z === 6 ? 8 : 4;
    } else {
      switch (z) {
        case 0:
          if (y < 4) { if (this.cond(y)) { this.pc = this.pop(); cyc = 20; } else cyc = 8; }
          else if (y === 4) { bus.write(0xff00 | this.fetch8(), this.a); cyc = 12; }
          else if (y === 5) { this.sp = this.spPlus(this.fetch8()); cyc = 16; }
          else if (y === 6) { this.a = bus.read(0xff00 | this.fetch8()); cyc = 12; }
          else { this.hl = this.spPlus(this.fetch8()); cyc = 12; }
          break;
        case 1:
          if (!(y & 1)) {
            const v = this.pop();
            switch (y >> 1) {
              case 0: this.b = v >> 8; this.c = v & 0xff; break;
              case 1: this.d = v >> 8; this.e = v & 0xff; break;
              case 2: this.h = v >> 8; this.l = v & 0xff; break;
              default: this.a = v >> 8; this.f = v & 0xf0;
            }
            cyc = 12;
          } else if (y === 1) { this.pc = this.pop(); cyc = 16; }
          else if (y === 3) { this.pc = this.pop(); this.ime = true; this.eiDelay = 0; cyc = 16; }
          else if (y === 5) { this.pc = this.hl; }
          else { this.sp = this.hl; cyc = 8; }
          break;
        case 2:
          if (y < 4) { const a = this.fetch16(); if (this.cond(y)) { this.pc = a; cyc = 16; } else cyc = 12; }
          else if (y === 4) { bus.write(0xff00 | this.c, this.a); cyc = 8; }
          else if (y === 5) { bus.write(this.fetch16(), this.a); cyc = 16; }
          else if (y === 6) { this.a = bus.read(0xff00 | this.c); cyc = 8; }
          else { this.a = bus.read(this.fetch16()); cyc = 16; }
          break;
        case 3:
          if (y === 0) { this.pc = this.fetch16(); cyc = 16; }
          else if (y === 1) cyc = this.cb();
          else if (y === 6) { this.ime = false; this.eiDelay = 0; }
          else if (y === 7) { this.eiDelay = 2; }
          // the other slots are unused opcodes: treated as NOP
          break;
        case 4:
          if (y < 4) { const a = this.fetch16(); if (this.cond(y)) { this.push(this.pc); this.pc = a; cyc = 24; } else cyc = 12; }
          break;
        case 5:
          if (!(y & 1)) {
            let v;
            switch (y >> 1) {
              case 0: v = this.bc; break; case 1: v = this.de; break; case 2: v = this.hl; break;
              default: v = (this.a << 8) | this.f;
            }
            this.push(v); cyc = 16;
          } else if (y === 1) { const a = this.fetch16(); this.push(this.pc); this.pc = a; cyc = 24; }
          break;
        case 6: this.alu(y, this.fetch8()); cyc = 8; break;
        default: this.push(this.pc); this.pc = y * 8; cyc = 16;
      }
    }

    if (this.eiDelay && --this.eiDelay === 0) this.ime = true;
    return cyc;
  }

  /** The CB-prefixed page; the prefix itself is already consumed. */
  cb() {
    const op = this.fetch8();
    const x = op >> 6, y = (op >> 3) & 7, z = op & 7;
    const mem = z === 6;
    const v = this.get8(z);
    if (x === 0) { this.set8(z, this.cbShift(y, v)); return mem ? 16 : 8; }
    if (x === 1) { // BIT
      this.f = (this.f & FC) | FH | ((v & (1 << y)) ? 0 : FZ);
      return mem ? 12 : 8;
    }
    this.set8(z, x === 2 ? v & ~(1 << y) : v | (1 << y)); // RES / SET
    return mem ? 16 : 8;
  }
}
