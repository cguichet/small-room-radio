// Rain Through a Window, rev D: circuit model (Sound Workshop). Run sample by sample at 4x the audio rate.
// Op-amp voltages are deviations from Vref (2.5 V). Ladder voltages are differential, in volts.

// Component-level laws shared by the audio engine and the page's readouts.
var RainLaw = (function () {
  var VT = 0.0258, C = 47e-9, PI = Math.PI;
  function fOfI(I) { return I / (8 * PI * C * VT); }               // ladder pole frequency
  // HP expo: Iref = 2.5 V / 180k, base network 1k to bias, 30k from the HP CUT wiper -> about 20 Hz to 10 kHz
  var HP_IREF = 2.5 / 180e3, HP_K1 = (1 / 30) / (1 + 1 / 30);
  // LP expo: Iref = 2.5 V / 118k, base network 1k to bias, 28k from LP CUT wiper, 15k from MOD wiper,
  // 24.3k from the CV buffer (x-0.5) on the reference side; a 220R emitter resistor caps the ladder near 1.3 mA
  var LP_IREF = 2.5 / 118e3, LP_G = 1 + 1 / 28 + 1 / 15 + 1 / 24.3, LP_K1 = (1 / 28) / LP_G, LP_K2 = (1 / 15) / LP_G, LP_KCV = (1 / 24.3) / LP_G;
  function cvBuf(v) { var o = 0.5 * v; return o > 2.4 ? 2.4 : o < -2.4 ? -2.4 : o; }
  // RES: control base = 1k to VF (1.6 V), 17.4k from RES wiper, 348k from 5 V; fixed base at VF
  var VF = 1.6, GS = 1 / 1e3, GP = 1 / 17.4e3, GQ = 1 / 348e3;
  var KMAX = 4.012;                                                 // set by the RES EDGE trimmer
  function hpI(x) { return HP_IREF * Math.exp(HP_K1 * (5 * x - 2.5) / VT); }
  function lpI(x, modV, cv) { return Math.min(1.3e-3, LP_IREF * Math.exp((LP_K1 * (5 * x - 2.5) + LP_K2 * (modV || 0) + LP_KCV * cvBuf(cv || 0)) / VT)); }
  function resU(x) { var vw = 5 * x; return (GP * (vw - VF) + GQ * (5 - VF)) / (GS + GP + GQ) / VT; }
  function resL(x) { return 1 / (1 + Math.exp(-resU(x))); }
  function resK(x, kmax) { return (kmax || KMAX) * resL(x); }
  function densVt(x) { var R = 10e3 * (1 - x); return 2.5 * R / (15e3 + R); }   // 5 V - 7.5k - DENSITY - 7.5k - GND
  // Volume: an audio-taper (log) pot, 50 dB of travel, so the quiet end has room; the last 5% fades to silence. (Nov 5; was a linear pot with a 1.5k wiper load)
  function volGain(x) { return x <= 0 ? 0 : Math.pow(10, -2.5 * (1 - x)) * (x < 0.05 ? x / 0.05 : 1); }
  // dominant pole pair of the Q-compensated ladder for feedback k (k < 4): ring time constant at pole freq f
  function ringTau(k, f) { var r = Math.pow(Math.max(k, 0), 0.25), s = 1 - r / Math.SQRT2; return s <= 0 ? Infinity : 1 / (2 * PI * f * s); }
  function ringQ(k) { var r = Math.pow(Math.max(k, 0), 0.25), s = 1 - r / Math.SQRT2; return s <= 0 ? Infinity : (r / Math.SQRT2) / (2 * s); }
  return { VT: VT, C: C, fOfI: fOfI, hpI: hpI, lpI: lpI, resU: resU, resL: resL, resK: resK, KMAX: KMAX,
    densVt: densVt, volGain: volGain, ringTau: ringTau, ringQ: ringQ, LP_K2: LP_K2,
    hpF: function (x) { return fOfI(hpI(x)); }, lpF: function (x, m, cv) { return fOfI(lpI(x, m, cv)); },
    cvOf: function (mode, x) { return mode === 1 ? -5 + 10 * x : mode === 2 ? 5 * x : 0; },
    lfoHz: function (x) { return 0.05 * Math.pow(160, x); } };
})();

function RainCore(fsHost, opt) {
  opt = opt || {};
  var OS = 4, fs = fsHost * OS, T = 1 / fs, PI = Math.PI, L = RainLaw, VT = L.VT, V2 = 2 * VT;
  function onePole(fc) { return 1 - Math.exp(-2 * PI * fc / fs); }
  function sec(y) { return Math.abs(y) < 1e-4 ? 1 - y * y / 3 : Math.tanh(y) / y; }

  // ---- noise: 1M thermal noise x101 x101 (unchanged) ----
  var an1 = onePole(16000), an2 = onePole(55000), n1 = 0, n2 = 0, nScale = 1, SIGMA = 0.2;
  var seed = 22222;
  function rnd() { seed = (seed * 1664525 + 1013904223) >>> 0; return (seed + 0.5) / 4294967296; }
  var g2n = 0, haveG = false;
  function gauss() {
    if (haveG) { haveG = false; return g2n; }
    var u = rnd(), v = rnd(), r = Math.sqrt(-2 * Math.log(u));
    g2n = r * Math.sin(2 * PI * v); haveG = true; return r * Math.cos(2 * PI * v);
  }
  (function calibrate() { var s = 0, N = 400000; for (var i = 0; i < N; i++) { n1 += an1 * (gauss() - n1); n2 += an2 * (n1 - n2); if (i > 1000) s += n2 * n2; } nScale = SIGMA / Math.sqrt(s / (N - 1001)); })();
  var aR = onePole(106), rv = 0, sh = 0;

  // ---- controls ----
  var P = { density: 0.2, hp: 0.25, lp: 0.62, res: 0.8, mod: 0.55, vol: 0.75, poles: 1, cv: 0.5, rate: 0.4 }, S = {};
  var cvMode = 0, audioIn = false, lineIn = 0, lfoPh = 0, cvNow = 0;
  for (var k in P) S[k] = P[k];
  var KMAX = opt.kmax || L.KMAX;

  // ---- fixed component values ----
  var HP_DIV = 1 / 52;                         // 51k / 1k from the pole switch into the HP ladder's input base
  var SRC_G = 1 / 3;                           // source buffer: inverting x(-1/3) at Vref (30k in, 10k feedback)
  var G_TAP = 21, HALF = G_TAP / 2;            // single-ended taps read half the differential node voltage
  var G_MIX = 732e3 / 120e3 * HALF;            // pole-mix gain for a weight of 1
  var MIXERR = opt.mixErr || [0.0007, -0.0009, 0.0004];  // 0.1 % parts
  var RBX = opt.rbx || 5.6e3, RPAR = 1 / (1 / 1e3 + 1 / 2.2e3 + 1 / RBX), X_DIV = RPAR / RBX, V_DIV = RPAR / 2.2e3;
  var G_LT = opt.gLt || 41, HALF_L = G_LT / 2;   // LP taps
  var RC = 3.3e3, IDC = opt.idc || 450e-6, R1 = V_DIV * RC * HALF_L / KMAX, R2 = R1 * RBX / (HALF_L * RPAR), IMAX = 3.1 / RC;
  this.values = { R1: R1, R2: R2, RPAR: RPAR, X_DIV: X_DIV, V_DIV: V_DIV };
  var G_OUT = opt.gOut || 25;
  var RAIL = 2.4;
  function clip(v) { return v > RAIL ? RAIL : v < -RAIL ? -RAIL : v; }

  // ---- state ----
  var state = 0, prevState = 0, onset = 0, tN = 0, hpOutPrev = 0;
  var hz = [0, 0], ha = [1, 1], hy = [0, 0];
  var lz = [0, 0, 0, 0], la = [1, 1, 1, 1], ly = [0, 0, 0, 0], lb = 1, ld = 0;
  var dcx = 0, aDC = 1 - Math.exp(-2 * PI * 1.6 / fsHost);
  var env = 0, envDecay = Math.exp(-T / 0.22), ledPk = 0;
  var blipCount = 0, events = [];
  var mon = { vcMin: 5, tapPk: 0, hpPk: 0, outPk: 0 };
  var lastCv = NaN, D, gH = 0, gL = 0, fcCur = 1000, lastSh = NaN, lastLp = NaN, lastMod = NaN, kNow = 0, LNow = 0;

  function derived() {
    var fh = L.hpF(S.hp);
    gH = Math.tan(PI * Math.min(fh, 0.45 * fs) / fs);
    LNow = L.resL(S.res); kNow = KMAX * LNow;
    D = { vt: L.densVt(S.density), fh: fh, vol: L.volGain(S.vol), four: S.poles >= 0.5 };
  }
  derived();

  function step() {
    var n, t, y;
    n1 += an1 * (gauss() - n1); n2 += an2 * (n1 - n2);
    var nz = n2 * nScale;
    rv += aR * (nz * 22 - rv);
    // window comparator: node jumps to 5 V on a peak, 0 V on a dip, rests at 2.5 V
    state = nz > D.vt ? 1 : (nz < -D.vt ? -1 : 0);
    if (state !== 0) {
      sh = clip(rv);                                   // XOR goes low during any blip: the switch samples
      if (state !== prevState) { blipCount++; onset = state; }
    }
    prevState = state;

    // ---- source select: the audio input's tip switch flips a 74LVC1G3157 from the blip node to the input summer ----
    var srcV = audioIn ? clip(lineIn) : 2.5 * state;
    // ---- source buffer: x(-1/3) feeds the LP ladder and the Q-compensation ----
    var srcB = -SRC_G * srcV; tN++;
    if (opt.lpIn) srcB = opt.lpIn(tN * T);

    // ---- LP cutoff: expo converter, S&H through MOD ----
    if (cvMode === 2) { lfoPh += 2 * PI * L.lfoHz(S.rate) * T; if (lfoPh > 2 * PI) lfoPh -= 2 * PI; cvNow = L.cvOf(2, S.cv) * Math.sin(lfoPh); }
    else cvNow = L.cvOf(cvMode, S.cv);
    if (sh !== lastSh || S.lp !== lastLp || S.mod !== lastMod || cvNow !== lastCv) {
      fcCur = L.lpF(S.lp, S.mod * sh, cvNow); lastSh = sh; lastLp = S.lp; lastMod = S.mod; lastCv = cvNow;
      gL = Math.tan(PI * Math.min(fcCur, 0.4 * fs) / fs);
    }
    if (onset) { if (events.length < 96) events.push(onset * fcCur); onset = 0; }

    // ---- LP ladder with Q-compensated resonance through the current-steering VCA ----
    var xp = -X_DIV * srcB / V2;                       // x' at the input pair, normalised to 2Vt
    var Gn, Sn, Pc = lb, Qc = 0;                       // y4 = Pc * d + Qc (linearised)
    for (n = 0; n < 4; n++) {
      Gn = gL / (1 + gL * la[n]); Sn = lz[n] / (1 + gL * la[n]);
      Pc = Gn * Pc; Qc = Gn * Qc + Sn;
      if (n < 3) { Pc *= la[n]; Qc *= la[n]; }
    }
    var dl = (xp * (1 + kNow) - kNow * Qc) / (1 + kNow * Pc);
    var y4p = Pc * dl + Qc;
    // the VCA itself: tail current, steering fraction, collector limits
    var i = HALF_L * y4p * V2 / R1 + srcB / R2, itail = IDC + i;
    if (itail < 0) itail = 0;
    var i1 = LNow * itail; if (i1 > IMAX) i1 = IMAX;
    var vc = 5 - RC * i1; if (vc < mon.vcMin) mon.vcMin = vc;
    var fb = -V_DIV * RC * (i1 - LNow * IDC) / V2;
    dl = xp + fb;
    t = Math.tanh(dl); lb = sec(dl); ld = dl;
    for (n = 0; n < 4; n++) {
      y = (lz[n] + gL * t) / (1 + gL * la[n]);
      lz[n] = 2 * y - lz[n]; ly[n] = y; la[n] = sec(y); t = Math.tanh(y);
    }
    var tap = HALF_L * (D.four ? ly[3] : ly[1]) * V2;   // the pole switch picks tap 4 or tap 2
    tap = tap > 2.0 ? 2.0 : tap < -1.85 ? -1.85 : tap;
    if (opt.tapLP) opt.tapLP(tap);
    var at = Math.abs(tap); if (at > mon.tapPk) mon.tapPk = at;

    // ---- HP ladder after the pole switch: 2 equal poles, no feedback; pole-mixed into a 2-pole high-pass ----
    var dh = opt.src ? opt.src(tN * T) : tap * HP_DIV;
    t = Math.tanh(dh / V2);
    if (opt.tapHP) opt.tapHP(dh, -hpOutPrev);
    for (n = 0; n < 2; n++) {
      y = (hz[n] + gH * t) / (1 + gH * ha[n]);
      hz[n] = 2 * y - hz[n]; hy[n] = y; ha[n] = sec(y); t = Math.tanh(y);
    }
    var mix = (1 + MIXERR[0]) * dh - 2 * (1 + MIXERR[1]) * hy[0] * V2 + (1 + MIXERR[2]) * hy[1] * V2;
    var hpOut = clip(-G_MIX * mix); hpOutPrev = hpOut;
    var ah = Math.abs(hpOut); if (ah > mon.hpPk) mon.hpPk = ah;

    // ---- VOLUME (linear pot, law-faked) -> x25 with a diode pair across the feedback resistor ----
    var v = hpOut * D.vol;
    var o = clip(v + 0.6 * Math.tanh((G_OUT - 1) * v / 0.6));
    // LED: superdiode peak detector, 1 uF / 220k release, PNP current source 1.2 V -> 5.5 mA
    env = env * envDecay; if (o > env) env = o;
    return o;
  }

  this.set = function (name, val) { if (name in P) P[name] = Math.min(1, Math.max(0, val)); if (name === 'poles') { S.poles = P.poles; derived(); } };
  this.setCvMode = function (m) { cvMode = m | 0; };
  this.setAudio = function (on) { audioIn = !!on; };
  var lastIn = 0;
  this.process = function (out, n, inp) {
    var sm = 1 - Math.exp(-1 / (0.01 * fsHost)), changed = false;
    for (var i = 0; i < n; i++) {
      if ((i & 15) === 0) {
        for (var key in P) { var d = P[key] - S[key]; if (d !== 0) { S[key] = Math.abs(d) < 1e-5 ? P[key] : S[key] + d * sm * 16; changed = true; } }
        if (changed) { derived(); changed = false; }
      }
      var xin = inp ? 1.5 * inp[i] : 0;               // full scale = 1.5 V peak line level
      var acc = 0; for (var j = 0; j < OS; j++) { lineIn = lastIn + (xin - lastIn) * (j + 1) / OS; acc += step(); }
      lastIn = xin;
      var y = acc / OS;
      var ac = y - dcx; dcx += aDC * (y - dcx);         // 10 uF into the load
      var a = Math.abs(ac); if (a > mon.outPk) mon.outPk = a;
      var ma = Math.max(0, env - 0.02) / 220 * 1000; if (ma > ledPk) ledPk = ma;
      var o = ac / 1.6; out[i] = o > 1 ? 1 : o < -1 ? -1 : o;
    }
  };
  this.info = function () {
    var e = events; events = [];
    var c = blipCount; blipCount = 0;
    var led = Math.min(5.5, ledPk); ledPk = Math.max(0, env - 0.02) / 220 * 1000;
    return { blips: c, ev: e, fc: fcCur, fcBase: L.lpF(S.lp, 0), fhp: D.fh, k: kNow, led: led, four: D.four, cv: cvNow, audio: audioIn };
  };
  this.monitor = function () { var m = mon; mon = { vcMin: 5, tapPk: 0, hpPk: 0, outPk: 0 }; return m; };
}
if (typeof module !== 'undefined') module.exports = { RainCore: RainCore, RainLaw: RainLaw };

// AudioWorklet processor: the same model, off the main thread
class RainProc extends AudioWorkletProcessor {
  constructor() { super(); this.c = new RainCore(sampleRate); this.n = 0;
    this.port.onmessage = (e) => { const d = e.data; if (d.set) this.c.set(d.set, d.v); }; }
  process(i, o) { const ch = o[0][0]; this.c.process(ch, ch.length, null);
    for (let k = 1; k < o[0].length; k++) o[0][k].set(ch);
    this.n += ch.length; if (this.n >= sampleRate / 30) { this.n = 0; this.port.postMessage(this.c.info()); } return true; }
}
registerProcessor("rain-core", RainProc);
