/**
 * apu.js -- the Game Boy's sound: two square channels (one with a frequency
 * sweep), the wave channel and the noise channel, with their length counters
 * and envelopes, driven by the 512 Hz frame sequencer and mixed to stereo.
 *
 * step(cycles) advances everything; every `cycles per sample` of the output
 * rate a stereo sample (-1..1) is handed to onSample(left, right), averaged
 * over the cycles since the last one.
 */

export const CLOCK = 4194304;

const DUTY = [
  [0, 0, 0, 0, 0, 0, 0, 1], [1, 0, 0, 0, 0, 0, 0, 1],
  [1, 0, 0, 0, 0, 1, 1, 1], [0, 1, 1, 1, 1, 1, 1, 0],
];
// What each register reads back as in the bits it does not hold.
const READ_MASK = [
  0x80, 0x3f, 0x00, 0xff, 0xbf,        // NR10-14
  0xff, 0x3f, 0x00, 0xff, 0xbf,        // NR20 (none), NR21-24
  0x7f, 0xff, 0x9f, 0xff, 0xbf,        // NR30-34
  0xff, 0xff, 0x00, 0x00, 0xbf,        // NR40 (none), NR41-44
  0x00, 0x00, 0x70,                    // NR50-52
];

class Square {
  constructor(sweep) {
    this.hasSweep = sweep;
    this.reset();
  }
  reset() {
    this.nr0 = this.nr1 = this.nr2 = this.nr3 = this.nr4 = 0;
    this.on = false; this.timer = 0; this.step = 0;
    this.length = 0; this.vol = 0; this.envTimer = 0;
    this.shadow = 0; this.sweepTimer = 0; this.sweepOn = false;
  }
  get freq() { return this.nr3 | ((this.nr4 & 7) << 8); }
  get dac() { return (this.nr2 & 0xf8) !== 0; }
  period() { return (2048 - this.freq) * 4; }
  tick(c) {
    this.timer -= c;
    if (this.timer <= 0) {
      const p = this.period();
      const n = Math.floor(-this.timer / p) + 1;
      this.step = (this.step + n) & 7;
      this.timer += n * p;
    }
  }
  out() {
    return this.on ? DUTY[this.nr1 >> 6][this.step] * this.vol : 0;
  }
  trigger() {
    this.on = this.dac;
    if (this.length === 0) this.length = 64;
    this.timer = this.period();
    this.vol = this.nr2 >> 4;
    this.envTimer = this.nr2 & 7 || 8;
    if (this.hasSweep) {
      this.shadow = this.freq;
      const p = (this.nr0 >> 4) & 7, s = this.nr0 & 7;
      this.sweepTimer = p || 8;
      this.sweepOn = !!(p || s);
      if (s) this.sweepCalc();
    }
  }
  sweepCalc() {
    const d = this.shadow >> (this.nr0 & 7);
    const f = (this.nr0 & 8) ? this.shadow - d : this.shadow + d;
    if (f > 2047) this.on = false;
    return f;
  }
  clockSweep() {
    if (!this.hasSweep || --this.sweepTimer > 0) return;
    const p = (this.nr0 >> 4) & 7;
    this.sweepTimer = p || 8;
    if (!this.sweepOn || !p) return;
    const f = this.sweepCalc();
    if (f <= 2047 && (this.nr0 & 7)) {
      this.shadow = f;
      this.nr3 = f & 0xff;
      this.nr4 = (this.nr4 & ~7) | (f >> 8);
      this.sweepCalc();
    }
  }
  clockLength() {
    if ((this.nr4 & 0x40) && this.length > 0 && --this.length === 0) this.on = false;
  }
  clockEnv() {
    const p = this.nr2 & 7;
    if (!p || --this.envTimer > 0) return;
    this.envTimer = p;
    if ((this.nr2 & 8) ? this.vol < 15 : this.vol > 0) this.vol += (this.nr2 & 8) ? 1 : -1;
  }
}

class Wave {
  constructor() { this.ram = new Uint8Array(16); this.reset(); }
  reset() {
    this.nr0 = this.nr1 = this.nr2 = this.nr3 = this.nr4 = 0;
    this.on = false; this.timer = 0; this.pos = 0; this.length = 0;
  }
  get freq() { return this.nr3 | ((this.nr4 & 7) << 8); }
  get dac() { return (this.nr0 & 0x80) !== 0; }
  tick(c) {
    this.timer -= c;
    if (this.timer <= 0) {
      const p = (2048 - this.freq) * 2;
      const n = Math.floor(-this.timer / p) + 1;
      this.pos = (this.pos + n) & 31;
      this.timer += n * p;
    }
  }
  out() {
    if (!this.on) return 0;
    const b = this.ram[this.pos >> 1];
    const s = (this.pos & 1) ? b & 0xf : b >> 4;
    const code = (this.nr2 >> 5) & 3;
    return code === 0 ? 0 : s >> (code - 1);
  }
  trigger() {
    this.on = this.dac;
    if (this.length === 0) this.length = 256;
    this.timer = (2048 - this.freq) * 2;
    this.pos = 0;
  }
  clockLength() {
    if ((this.nr4 & 0x40) && this.length > 0 && --this.length === 0) this.on = false;
  }
}

class Noise {
  constructor() { this.reset(); }
  reset() {
    this.nr1 = this.nr2 = this.nr3 = this.nr4 = 0;
    this.on = false; this.timer = 0; this.lfsr = 0x7fff;
    this.length = 0; this.vol = 0; this.envTimer = 0;
  }
  get dac() { return (this.nr2 & 0xf8) !== 0; }
  period() {
    const r = this.nr3 & 7;
    return (r ? r * 16 : 8) << (this.nr3 >> 4);
  }
  tick(c) {
    this.timer -= c;
    while (this.timer <= 0) {
      this.timer += this.period();
      const x = (this.lfsr ^ (this.lfsr >> 1)) & 1;
      this.lfsr = (this.lfsr >> 1) | (x << 14);
      if (this.nr3 & 8) this.lfsr = (this.lfsr & ~0x40) | (x << 6);
    }
  }
  out() { return this.on && !(this.lfsr & 1) ? this.vol : 0; }
  trigger() {
    this.on = this.dac;
    if (this.length === 0) this.length = 64;
    this.timer = this.period();
    this.vol = this.nr2 >> 4;
    this.envTimer = this.nr2 & 7 || 8;
    this.lfsr = 0x7fff;
  }
  clockLength() {
    if ((this.nr4 & 0x40) && this.length > 0 && --this.length === 0) this.on = false;
  }
  clockEnv() {
    const p = this.nr2 & 7;
    if (!p || --this.envTimer > 0) return;
    this.envTimer = p;
    if ((this.nr2 & 8) ? this.vol < 15 : this.vol > 0) this.vol += (this.nr2 & 8) ? 1 : -1;
  }
}

export class APU {
  /**
   * @param {number} rate output sample rate in Hz
   * @param {(l:number, r:number) => void} onSample
   */
  constructor(rate, onSample) {
    this.rate = rate;
    this.onSample = onSample;
    this.cyclesPerSample = CLOCK / rate;
    this.ch1 = new Square(true);
    this.ch2 = new Square(false);
    this.ch3 = new Wave();
    this.ch4 = new Noise();
    this.reset();
  }

  reset() {
    this.power = true;
    this.nr50 = 0x77; this.nr51 = 0xf3;
    this.seqTimer = 0; this.seqStep = 0;
    this.acc = 0; this.sumL = 0; this.sumR = 0;
    this.ch1.reset(); this.ch2.reset(); this.ch3.reset(); this.ch4.reset();
    // Post-boot values: channel 1 has played its start-up chime.
    this.ch1.nr0 = 0x80; this.ch1.nr1 = 0xbf; this.ch1.nr2 = 0xf3; this.ch1.nr3 = 0xff; this.ch1.nr4 = 0xbf;
    this.ch2.nr1 = 0x3f; this.ch2.nr3 = 0xff; this.ch2.nr4 = 0xbf;
    this.ch3.nr0 = 0x7f; this.ch3.nr1 = 0xff; this.ch3.nr2 = 0x9f; this.ch3.nr3 = 0xff; this.ch3.nr4 = 0xbf;
    this.ch4.nr1 = 0xff; this.ch4.nr4 = 0xbf;
  }

  readReg(a) {
    if (a >= 0xff30) return this.ch3.ram[a - 0xff30];
    if (a < 0xff10 || a > 0xff26) return 0xff;
    let v;
    switch (a) {
      case 0xff10: v = this.ch1.nr0; break; case 0xff11: v = this.ch1.nr1; break;
      case 0xff12: v = this.ch1.nr2; break; case 0xff13: v = this.ch1.nr3; break; case 0xff14: v = this.ch1.nr4; break;
      case 0xff16: v = this.ch2.nr1; break; case 0xff17: v = this.ch2.nr2; break;
      case 0xff18: v = this.ch2.nr3; break; case 0xff19: v = this.ch2.nr4; break;
      case 0xff1a: v = this.ch3.nr0; break; case 0xff1b: v = this.ch3.nr1; break; case 0xff1c: v = this.ch3.nr2; break;
      case 0xff1d: v = this.ch3.nr3; break; case 0xff1e: v = this.ch3.nr4; break;
      case 0xff20: v = this.ch4.nr1; break; case 0xff21: v = this.ch4.nr2; break;
      case 0xff22: v = this.ch4.nr3; break; case 0xff23: v = this.ch4.nr4; break;
      case 0xff24: v = this.nr50; break; case 0xff25: v = this.nr51; break;
      case 0xff26:
        v = (this.power ? 0x80 : 0) | (this.ch1.on ? 1 : 0) | (this.ch2.on ? 2 : 0) | (this.ch3.on ? 4 : 0) | (this.ch4.on ? 8 : 0);
        break;
      default: v = 0;
    }
    return v | READ_MASK[a - 0xff10];
  }

  writeReg(a, v) {
    if (a >= 0xff30) { if (a <= 0xff3f) this.ch3.ram[a - 0xff30] = v; return; }
    if (a === 0xff26) {
      const on = !!(v & 0x80);
      if (this.power && !on) {
        this.ch1.reset(); this.ch2.reset(); this.ch3.reset(); this.ch4.reset();
        this.nr50 = 0; this.nr51 = 0;
      } else if (!this.power && on) { this.seqStep = 0; }
      this.power = on;
      return;
    }
    if (!this.power || a < 0xff10 || a > 0xff25) return;
    const { ch1, ch2, ch3, ch4 } = this;
    switch (a) {
      case 0xff10: ch1.nr0 = v; break;
      case 0xff11: ch1.nr1 = v; ch1.length = 64 - (v & 63); break;
      case 0xff12: ch1.nr2 = v; if (!ch1.dac) ch1.on = false; break;
      case 0xff13: ch1.nr3 = v; break;
      case 0xff14: ch1.nr4 = v; if (v & 0x80) ch1.trigger(); break;
      case 0xff16: ch2.nr1 = v; ch2.length = 64 - (v & 63); break;
      case 0xff17: ch2.nr2 = v; if (!ch2.dac) ch2.on = false; break;
      case 0xff18: ch2.nr3 = v; break;
      case 0xff19: ch2.nr4 = v; if (v & 0x80) ch2.trigger(); break;
      case 0xff1a: ch3.nr0 = v; if (!ch3.dac) ch3.on = false; break;
      case 0xff1b: ch3.nr1 = v; ch3.length = 256 - v; break;
      case 0xff1c: ch3.nr2 = v; break;
      case 0xff1d: ch3.nr3 = v; break;
      case 0xff1e: ch3.nr4 = v; if (v & 0x80) ch3.trigger(); break;
      case 0xff20: ch4.nr1 = v; ch4.length = 64 - (v & 63); break;
      case 0xff21: ch4.nr2 = v; if (!ch4.dac) ch4.on = false; break;
      case 0xff22: ch4.nr3 = v; break;
      case 0xff23: ch4.nr4 = v; if (v & 0x80) ch4.trigger(); break;
      case 0xff24: this.nr50 = v; break;
      case 0xff25: this.nr51 = v; break;
    }
  }

  step(c) {
    if (this.power) {
      this.ch1.tick(c); this.ch2.tick(c); this.ch3.tick(c); this.ch4.tick(c);
      this.seqTimer += c;
      while (this.seqTimer >= 8192) {
        this.seqTimer -= 8192;
        const s = this.seqStep;
        if (!(s & 1)) { this.ch1.clockLength(); this.ch2.clockLength(); this.ch3.clockLength(); this.ch4.clockLength(); }
        if (s === 2 || s === 6) this.ch1.clockSweep();
        if (s === 7) { this.ch1.clockEnv(); this.ch2.clockEnv(); this.ch4.clockEnv(); }
        this.seqStep = (s + 1) & 7;
      }
      // Mix: each channel is 0..15, centred on 0 while its DAC is on.
      const n5 = this.nr51;
      let l = 0, r = 0, v;
      v = this.ch1.dac ? this.ch1.out() / 7.5 - 1 : 0; if (n5 & 0x10) l += v; if (n5 & 1) r += v;
      v = this.ch2.dac ? this.ch2.out() / 7.5 - 1 : 0; if (n5 & 0x20) l += v; if (n5 & 2) r += v;
      v = this.ch3.dac ? this.ch3.out() / 7.5 - 1 : 0; if (n5 & 0x40) l += v; if (n5 & 4) r += v;
      v = this.ch4.dac ? this.ch4.out() / 7.5 - 1 : 0; if (n5 & 0x80) l += v; if (n5 & 8) r += v;
      l *=(((this.nr50 >> 4) & 7) + 1) / 8 / 4;
      r *= ((this.nr50 & 7) + 1) / 8 / 4;
      this.sumL += l * c; this.sumR += r * c;
    }
    this.acc += c;
    if (this.acc >= this.cyclesPerSample) {
      this.onSample(this.sumL / this.acc, this.sumR / this.acc);
      this.sumL = this.sumR = 0;
      this.acc = 0;
    }
  }
}
