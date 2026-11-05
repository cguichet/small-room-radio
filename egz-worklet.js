// Circuit-level simulation of the e-guzheng: eleven struck bridged-T resonators, one per note.
// Self-contained on purpose: the page turns this function's source into the audio worklet.
function createKalimbaCore(sampleRate, opt) {
  'use strict';
  var OS = 4;                       // oversampling factor for the overtone bus and the clipper
  var fs = sampleRate * OS, dt = 1 / fs;
  var N = 11;

  // ---- shared circuit values -------------------------------------------------
  var VCC = 5;
  var CF = 47e-12;                  // across the soft clipper's feedback resistor
  var CL_IS = 2.52e-9, CL_NVT = 0.0453;          // 1N4148, used in the soft clipper
  var OUT_GAIN = 1.4;               // soft-clip output volts to full scale

  // ---- the eleven notes -------------------------------------------------------
  var MIDI = [50, 52, 54, 57, 59, 62, 64, 66, 69, 71, 74];
  var NAMES = ['D3', 'E3', 'F\u266f3', 'A3', 'B3', 'D4', 'E4', 'F\u266f4', 'A4', 'B4', 'D5'];
  var E24 = [1.0, 1.1, 1.2, 1.3, 1.5, 1.6, 1.8, 2.0, 2.2, 2.4, 2.7, 3.0, 3.3, 3.6, 3.9, 4.3, 4.7, 5.1, 5.6, 6.2, 6.8, 7.5, 8.2, 9.1];
  var padTarget = new Float64Array(N), padP = new Float64Array(N), v;
  var tdK = new Float64Array(N), tdKick = new Float64Array(N);     // touch-drone feedback fraction at the + input, set by the touch strips (below)

  // ---- the voice ---------------------------------------------------------------
  // One op-amp bridged-T resonator per voice, built with a modest Q. A piezo disc kicks it and a trimmer
  // divider on the output sets its resting pitch. A spring-return slider hangs from the trimmer's wiper:
  // one half of its track is in series with the pitch feedback, the other half in series with a small
  // damping feed, so a bend raises the pitch without changing how long the note rings. Each voice feeds a
  // sliver of its own output back to its own + input through an analog switch; one clock, far above audio, chops
  // all eleven switches, and its duty cycle is the sustain control. No audio is shared, so the voices stay independent.
  // Each switch's control pin gets the clock through its own resistor, so a finger on a bare copper pad can
  // override it for one voice: to +5 V holds the switch closed (hold), to ground holds it open (damp).
  var VREF = 2.5;                   // signal ground on a single 5 V supply
  var RES_A0 = 2e6;                 // op-amp DC gain (126 dB). The ring and the drone point lean on it, so the design wants a high-gain part.
  var POT = 2e3, R_BOT = 1.37e3, R_LOAD = 2.74e3;   // tuning trimmer, its end-stop and its wiper load
  var P_BEND = 10e3, R_END = 10;                    // bend slider, and the resistance left at either end of its track
  var RD = 40.2e3, BEND_ST = 3;                     // damping divider's leg to Vref, and the bend at the slider's stop in semitones
  var SHARE_MAX = 1 / 0.9, R_P = 536;               // with its switch always closed a voice cancels 111% of its loss, so DECAY reaches the drone point at 90 % of
  // its travel and the top 10 % self-oscillates; R_P is the resistor from each + input to Vref
  // (R&D: 536 ohm rather than 100. Every feed into the + node is a current, so a larger Rp gives the touch strips more push for
  // the same skin; the sustain resistors are scaled up with it, so their share does not change.)
  var SHARE_NOM = 0.8;                              // share of loss cancelled at the default setting, which the ring times are designed around
  // Sustain clock: a comparator sets the duty cycle from the knob's voltage against a ramp that runs between
  // a third and two thirds of the supply. The knob is a 10k pot with 10k either side, so its travel just spans the ramp.
  var V_LO = VCC / 3, V_HI = 2 * VCC / 3, KNOB_POT = 10e3, KNOB_PAD = 10e3;
  var R_MIX = 100e3, RRF_MIN = 10e3, RRF_POT = 500e3;           // inverting mixer with the clip diodes
  var VSAT = 2.4;                   // op-amp output swing either side of Vref
  var Q_PIEZO = 400e-9, C_PIEZO = 20e-9;            // charge from a full tap and the disc's own capacitance (assumed)
  var TAP_PEAK = 1.2, TAP_RISE = 0.002;             // design target for a full tap, and how fast a tap lands
  var E12 = [1.0, 1.2, 1.5, 1.8, 2.2, 2.7, 3.3, 3.9, 4.7, 5.6, 6.8, 8.2];
  function nearestIn(series, x) {
    var dec = Math.pow(10, Math.floor(Math.log(x) / Math.LN10)), best = x, err = Infinity;
    for (var k = -1; k < 2; k++) for (var i = 0; i < series.length; i++) {
      var val = series[i] * dec * Math.pow(10, k), e = Math.abs(Math.log(val / x));
      if (e < err) { err = e; best = val; }
    }
    return best;
  }
  function nearestE96(x) {
    var val = Math.pow(10, Math.round(96 * Math.log(x) / Math.LN10) / 96);
    var dec = Math.pow(10, Math.floor(Math.log(val) / Math.LN10 + 1e-9) - 2);
    return Math.round(val / dec) * dec;
  }
  function kOf(s) {                  // fraction of the output on the trimmer's wiper, before the bend network loads it
    var x = (s + 1) * 0.5, b = R_BOT / POT, L = R_LOAD / POT;
    return (b + x) * L / ((1 + b) * L + (b + x) * (1 - x));
  }
  // The resistors around one voice, reduced to what the op-amp output, node X and the minus input see.
  // s is the trimmer (-1 flat .. +1 sharp), x the bend slider (0 at rest .. 1 at its stop).
  // Inside: T is the trimmer's wiper. Slider half (1-x) runs from T to B, where Rb goes to Vref and R2 to the
  // minus input. Slider half x runs from T to D, where Rd goes to Vref and Rx to node X.
  function resNet(d, s, x, open) {   // open: the skew switch at the trimmer's top is open, so T hangs off Vref alone
    var xs = (s + 1) * 0.5;
    var gTO = open ? 0 : 1 / ((1 - xs) * POT + 1), gTg = 1 / (xs * POT + R_BOT) + 1 / R_LOAD + (d.rs ? 1 / d.rs : 0);
    var gTB = 1 / ((1 - x) * P_BEND + R_END), gTD = 1 / (x * P_BEND + R_END);
    var g2 = 1 / d.r2, gx = 1 / d.rx;
    var e = gTB + 1 / d.rb + g2, f = gTD + 1 / RD + gx;
    var sc = gTO + gTg + gTB + gTD - gTB * gTB / e - gTD * gTD / f;
    return {
      kT: gTO / sc,                                             // fraction of the output on the trimmer's wiper
      yno: g2 * gTB * gTO / (e * sc),                           // output -> minus input: sets pitch, and adds loss
      ynn: g2 - g2 * g2 * (1 / e + gTB * gTB / (e * e * sc)),
      ynx: g2 * gx * gTB * gTD / (e * f * sc),
      yxo: gx * gTD * gTO / (f * sc),                           // output -> node X: damping only
      yxx: 1 / d.r1 + gx - gx * gx * (1 / f + gTD * gTD / (f * f * sc))
    };
  }
  function resGain(K) { return RES_A0 / (1 + RES_A0 * (1 - K)); }   // closed-loop factor with a fraction K fed to the + input
  function resMatrix(d, y, K) {      // continuous-time state matrix; states are the two capacitor voltages (C2, then C1)
    var G = resGain(K), H = 1 - G;
    var a0 = -y.ynn * H - (y.yno + y.ynx) * G, a1 = y.ynn * H + y.yno * G - y.ynx * H;   // current into C2
    var x0 = (y.yxo - y.yxx) * G - y.ynx * H, x1 = -y.yxx * H - y.yxo * G + y.ynx * H;    // current the resistors push into X
    return [a0 / d.c, a1 / d.c, (x0 - a0) / d.c, (x1 - a1) / d.c];
  }
  // Chopped-feed skew: the trimmer's top reaches the op-amp output through an analog switch closed for a fraction dk of
  // each clock period. Far above audio, the voice sees the duty-weighted average of the two circuits.
  function avgMatrix(d, yc, yo, Kc, Ko, dk) {
    var Ac = resMatrix(d, yc, Kc), Ao = resMatrix(d, yo, Ko);
    return [Ao[0] + dk * (Ac[0] - Ao[0]), Ao[1] + dk * (Ac[1] - Ao[1]), Ao[2] + dk * (Ac[2] - Ao[2]), Ao[3] + dk * (Ac[3] - Ao[3])];
  }
  function resPole(d, s, x, Kc) {    // Kc is the sustain fraction with trimmer centred and slider at rest
    var y = resNet(d, s, x), A;
    if (d.dk) A = avgMatrix(d, y, resNet(d, s, x, 1), (Kc || 0) * y.kT / (d.kT0 || y.kT), 0, d.dk);
    else A = resMatrix(d, y, (Kc || 0) * y.kT / (d.kT0 || y.kT));
    var sig = (A[0] + A[3]) * 0.5, w2 = A[0] * A[3] - A[1] * A[2] - sig * sig;
    return { f: Math.sqrt(w2 > 0 ? w2 : 0) / (2 * Math.PI), tau: -1 / sig, sig: sig };
  }
  function solveRes(d, vars, resid) {   // Newton's method on the named resistors, in log space
    var n = vars.length, i, j, r, c;
    for (var it = 0; it < 40; it++) {
      var r0 = resid(d), worst = 0, M = [];
      for (i = 0; i < n; i++) { worst = Math.max(worst, Math.abs(r0[i])); M.push(new Array(n + 1)); }
      if (worst < 1e-11) break;
      for (j = 0; j < n; j++) {
        var keep = d[vars[j]]; d[vars[j]] = keep * 1.0005; var r1 = resid(d); d[vars[j]] = keep;
        for (i = 0; i < n; i++) M[i][j] = (r1[i] - r0[i]) / Math.log(1.0005);
      }
      for (i = 0; i < n; i++) M[i][n] = -r0[i];
      for (i = 0; i < n; i++) {
        var pv = i; for (r = i + 1; r < n; r++) if (Math.abs(M[r][i]) > Math.abs(M[pv][i])) pv = r;
        var tmp = M[i]; M[i] = M[pv]; M[pv] = tmp;
        for (r = 0; r < n; r++) if (r !== i) { var fct = M[r][i] / M[i][i]; for (c = i; c <= n; c++) M[r][c] -= fct * M[i][c]; }
      }
      for (j = 0; j < n; j++) { var step = M[j][n] / M[j][j]; d[vars[j]] *= Math.exp(step > 0.5 ? 0.5 : (step < -0.5 ? -0.5 : step)); }
    }
  }
  // Skew circuit option (opt.skewHw): each voice's trimmer feed is chopped by its own switch at a nominal duty of 1/9.
  var SKH = opt && opt.skewHw ? 1 : 0, SKH_D0 = 1 / 9;
  var designRes = [];
  for (v = 0; v < N; v++) {
    var fr = 440 * Math.pow(2, (MIDI[v] - 69) / 12), wr = 2 * Math.PI * fr, kc = kOf(0);
    var tauT = 0.4 * Math.sqrt(130.81 / fr) * (1 - SHARE_NOM);   // bare ring: a fifth of the played ring, low notes longer than high
    var ST2 = Math.pow(2, BEND_ST / 6), MD = RD / P_BEND;        // pitch feedback has to rise by ST2 for the full bend
    var dr = { name: NAMES[v], midi: MIDI[v], f0: fr, dk: SKH ? SKH_D0 : 0 };
    dr.c = nearestIn(E12, tauT * kc / 0.54e6);
    // Rough values first. The pitch feedback carries a little under a third of the loss; the damping feed carries the rest.
    var g0 = 2 * dr.c / ((2 + 2 * (ST2 - 1) * (MD + 1)) * tauT);
    dr.r1 = nearestIn(E24, g0 / (wr * wr * dr.c * dr.c));
    dr.r2 = kc / (ST2 * g0);
    dr.rb = P_BEND * dr.r2 / ((ST2 - 1) * dr.r2 - P_BEND);
    dr.rx = kc / (2 * (ST2 - 1) * (MD + 1) * g0);
    if (SKH) { dr.r2 *= SKH_D0; dr.rx *= SKH_D0; }             // the chopped feed only passes SKH_D0 of the time at rest
    var atRest = function (q) { return [Math.log(resPole(q, 0, 0).f / q.f0)]; };
    var bent = function (q) {         // on the note at rest, BEND_ST sharp at the stop, and the same bare ring at both ends
      var p0 = resPole(q, 0, 0), p1 = resPole(q, 0, 1);
      return [Math.log(p0.f / q.f0), Math.log(p1.f / p0.f) - BEND_ST * Math.LN2 / 12, Math.log(p1.tau / p0.tau)];
    };
    for (var pass = 0; pass < 3; pass++) {
      solveRes(dr, ['r2', 'rb', 'rx'], bent);
      dr.rb = nearestE96(dr.rb); dr.rx = nearestE96(dr.rx);    // 1% parts for the bend network
      solveRes(dr, ['r2'], atRest);                            // centre the trimmer on the note
      dr.kT0 = resNet(dr, 0, 0).kT;
      // feedback fraction that exactly cancels this voice's loss with its trimmer centred and its slider at rest
      var K0 = 0, s0 = resPole(dr, 0, 0, 0).sig, K1 = 2 * dr.r1 * dr.c * -s0, s1 = resPole(dr, 0, 0, K1).sig;
      for (var isec = 0; isec < 8 && s1 !== s0; isec++) { var K2 = K1 - s1 * (K1 - K0) / (s1 - s0); K0 = K1; s0 = s1; K1 = K2; s1 = resPole(dr, 0, 0, K1).sig; }
      dr.kcrit = K1;
      dr.rs = R_P * (dr.kT0 / (SHARE_MAX * dr.kcrit) - 1);     // sustain resistor from the trimmer's wiper, through the switch, to the + input
    }
    dr.tauBare = resPole(dr, 0, 0).tau;
    dr.tau = resPole(dr, 0, 0, SHARE_NOM * dr.kcrit).tau;      // ring at the default sustain setting
    dr.bend = []; dr.tauBent = [];
    for (var ib = 1; ib <= 3; ib++) {                           // a third, two thirds and all of the slider's travel
      dr.bend.push(12 * Math.log(resPole(dr, 0, ib / 3).f / fr) / Math.LN2);
      dr.tauBent.push(resPole(dr, 0, ib / 3, SHARE_NOM * dr.kcrit).tau);
    }
    // piezo strike: a series capacitor sets how much of the disc's charge reaches the resonator
    var frac = dr.c * TAP_PEAK * Math.sqrt(1 + wr * wr * TAP_RISE * TAP_RISE) / Q_PIEZO;
    if (frac > 0.9) frac = 0.9;
    dr.ck = nearestIn(E12, C_PIEZO * frac / (1 - frac));
    dr.qk = Q_PIEZO * dr.ck / (C_PIEZO + dr.ck);
    dr.flat = 12 * Math.log(resPole(dr, -1, 0).f / fr) / Math.LN2;
    dr.sharp = 12 * Math.log(resPole(dr, 1, 0).f / fr) / Math.LN2;
    designRes.push(dr);
  }
  // Factory variants: bass and alto are the tenor board with C1 and C2 doubled or halved. Every resistor, the
  // trimmer and the slider stay put, so the voices land an octave down or up with the same Q, the same tuning and
  // bend ranges and the same drone point. Ring times double or halve with the period. Taps land at the same level;
  // the short dust strikes land about 6 dB softer on bass and 6 dB harder on alto.
  var OCT = opt && opt.octave ? Math.round(opt.octave) : 0;
  if (OCT) {
    var cs = Math.pow(2, -OCT);
    for (v = 0; v < N; v++) {
      var dv = designRes[v];
      dv.c *= cs; dv.f0 /= cs; dv.midi += 12 * OCT;
      dv.name = dv.name.replace(/\d$/, function (n) { return String(+n + OCT); });
      dv.tau *= cs; dv.tauBare *= cs;
      for (var jb = 0; jb < dv.tauBent.length; jb++) dv.tauBent[jb] *= cs;
    }
  }
  var ra = new Float64Array(N), rb = new Float64Array(N), rvo = new Float64Array(N), rpk = new Float64Array(N);
  var c00 = new Float64Array(N), c01 = new Float64Array(N), c10 = new Float64Array(N), c11 = new Float64Array(N);
  var d0 = new Float64Array(N), d1 = new Float64Array(N);
  // The parts as built can differ from the values the design assumed (used for tolerance checks).
  var K_ERR = opt && opt.kErr ? opt.kErr : 1, KERR_V = opt && opt.kErrV ? opt.kErrV : null;   // per-voice build spread (tests)
  // A built instrument's voices never tip at exactly the same point. With spread on, each voice's sustain feed is off by a
  // fixed random amount (standard deviation opt.spread, about 1% after trimming), the same set every time.
  if (!KERR_V && opt && opt.spread) {
    KERR_V = []; var sd = 7, rnd = function () { sd = (sd * 16807) % 2147483647; return sd / 2147483647; };
    for (v = 0; v < N; v++) { var gs = 0; for (var ig = 0; ig < 12; ig++) gs += rnd(); KERR_V.push(1 + opt.spread * (gs - 6)); }
  }
  if (opt && opt.a0) RES_A0 = opt.a0;
  var tuneRes = new Float64Array(N), ikick = new Float64Array(N), onset = new Int32Array(N);
  var bendTarget = new Float64Array(N), bendNow = new Float64Array(N), bendUsed = new Float64Array(N);
  var s00 = new Float64Array(N), s01 = new Float64Array(N), s10 = new Float64Array(N), s11 = new Float64Array(N);
  var sf0 = new Float64Array(N), sf1 = new Float64Array(N), si0 = new Float64Array(N), si1 = new Float64Array(N);
  var rG = new Float64Array(N), rsat = new Int8Array(N);
  var susV = new Float64Array(N);
  for (v = 0; v < N; v++) susV[v] = SHARE_NOM;
  var pedal = SHARE_NOM / SHARE_MAX, pedalTarget = SHARE_NOM / SHARE_MAX, seed = 12345, NOISE_I = 1e-8 * 2.3283064365386963e-10;
  function expm2(A) {                // exp(A dt) for a 2x2 matrix, exact for ringing and overdamped cases alike
    var sig = (A[0] + A[3]) * 0.5, w2 = A[0] * A[3] - A[1] * A[2] - sig * sig, cs, sn;
    if (w2 > 1e-9) { var w = Math.sqrt(w2); cs = Math.cos(w * dt); sn = Math.sin(w * dt) / w; }
    else if (w2 < -1e-9) { var wh = Math.sqrt(-w2), ep = Math.exp(wh * dt), em = 1 / ep; cs = 0.5 * (ep + em); sn = 0.5 * (ep - em) / wh; }
    else { cs = 1; sn = dt; }
    var E = Math.exp(sig * dt);
    return [E * (cs + sn * (A[0] - sig)), E * sn * A[1], E * sn * A[2], E * (cs + sn * (A[3] - sig))];
  }
  function held(A, Ad, b0, b1) {     // response over one step to a constant input entering through [b0, b1]
    var det = A[0] * A[3] - A[1] * A[2], m0 = (Ad[0] - 1) * b0 + Ad[1] * b1, m1 = Ad[2] * b0 + (Ad[3] - 1) * b1;
    return [(A[3] * m0 - A[1] * m1) / det, (-A[2] * m0 + A[0] * m1) / det];
  }
  // Breath (R&D): a voltage e added at the + input. vo gains G e directly, and the network sees that through the same
  // vector as vo itself (the one the rail-stuck case uses for its fixed output).
  var pe0 = new Float64Array(N), pe1 = new Float64Array(N);
  var hwAo = new Float64Array(N * 4), hwdA = new Float64Array(N * 4);
  // Self-FM skew (R&D, idealised). Each voice has its own skew circuit: it takes the voice's slope (the rate of change of
  // its output, a quarter cycle ahead of it) and speeds up or slows down the whole resonator within each cycle, the way a
  // DX7 operator's feedback does. The resonator runs at 1 / (1 - u) times its normal rate, u = SKEW x slope / SK_AREF: it
  // hurries on one side of each cycle and lingers on the other, which leans the sine toward a sawtooth, and because the
  // speed-up and slow-down cancel over a cycle the pitch stays put. Louder notes lean further. Nothing is added to the
  // voice's energy, so it cannot set a voice off. One global SKEW control sets the depth for every voice.
  // The per-sample step at speed w is exp(A w dt), written out from the resonator's own pole (sigma +- j omega) with short
  // series for the cosine, sine and exponential: at these step sizes they are exact to a part in a billion.
  var SK_AREF = 0.6, SK_UMAX = 0.82;
  var skB = 0, skA = new Float64Array(N * 4), skSig = new Float64Array(N), skW2 = new Float64Array(N), skQa = new Float64Array(N), skQb = new Float64Array(N), skQn = new Float64Array(N);
  // Phase skew (the original math model, applied to the phase alone). The PM-form accumulator dphi/dt = w / (1 - m cos phi)
  // integrates to w t = phi - m sin phi (Kepler's equation). Each voice's state gives its own phase theta (in-phase
  // and quadrature); solving theta = phi - m sin phi for phi and sending A sin phi to the mix leans the sine toward a
  // sawtooth by exactly the same law, at any level, with the pitch and the resonator's own behaviour untouched.
  var phM = 0, phMT = 0, PH_MMAX = 0.9;
  function skSet(v, A) {
    var w0 = 2 * Math.PI * designRes[v].f0, G_ = rG[v], sg = (A[0] + A[3]) * 0.5;
    skQa[v] = G_ * (A[0] - A[2]) / (w0 * SK_AREF); skQb[v] = G_ * (A[1] - A[3]) / (w0 * SK_AREF);   // slope of vo, per radian, over SK_AREF
    skSig[v] = sg; skW2[v] = A[0] * A[3] - A[1] * A[2] - sg * sg; skQn[v] = skW2[v] > 0 ? w0 * SK_AREF / Math.sqrt(skW2[v]) : 0;
    skA[v * 4] = A[0] - sg; skA[v * 4 + 1] = A[1]; skA[v * 4 + 2] = A[2]; skA[v * 4 + 3] = A[3] - sg;
  }
  function resCoeffs(v) {
    // Sustain, pitch feedback and damping are all tapped from the trimmer's wiper, so they scale together when the voice is retuned.
    var d = designRes[v], y = resNet(d, tuneRes[v], bendUsed[v]), K = K_ERR * (KERR_V ? KERR_V[v] : 1) * susV[v] * d.kcrit * y.kT / d.kT0 + tdK[v], c = d.c;
    // op-amp in its linear range
    var A, yo;
    if (SKH) {                        // chopped feed: keep both circuits, and rest at the nominal duty
      yo = resNet(d, tuneRes[v], bendUsed[v], 1);
      var Ac_ = resMatrix(d, y, K), Ao_ = resMatrix(d, yo, tdK[v]), q4_ = v * 4;
      for (var m_ = 0; m_ < 4; m_++) { hwAo[q4_ + m_] = Ao_[m_]; hwdA[q4_ + m_] = Ac_[m_] - Ao_[m_]; }
      A = avgMatrix(d, y, yo, K, tdK[v], SKH_D0);
      var y_ = {}; for (var kk in y) y_[kk] = yo[kk] + SKH_D0 * (y[kk] - yo[kk]); y = y_;   // the rail-stuck case sees the average network
    } else A = resMatrix(d, y, K);
    var Ad = expm2(A), h = held(A, Ad, 0, 1 / c);
    c00[v] = Ad[0]; c01[v] = Ad[1]; c10[v] = Ad[2]; c11[v] = Ad[3]; d0[v] = h[0]; d1[v] = h[1];
    rG[v] = resGain(K);
    var u0 = (y.ynn - y.yno - y.ynx) / c, u1 = (y.yxo - y.yxx + 2 * y.ynx - y.ynn + y.yno) / c, hp = held(A, Ad, u0 * rG[v], u1 * rG[v]);
    pe0[v] = hp[0]; pe1[v] = hp[1];
    skSet(v, A);
    // op-amp stuck at a rail: the output is a fixed voltage and the network just relaxes
    var S = [-y.ynn / c, (y.ynn - y.ynx) / c, (y.ynn - y.ynx) / c, (2 * y.ynx - y.yxx - y.ynn) / c], Sd = expm2(S);
    var hf = held(S, Sd, (y.ynn - y.yno - y.ynx) / c, (y.yxo - y.yxx + 2 * y.ynx - y.ynn + y.yno) / c), hi = held(S, Sd, 0, 1 / c);
    s00[v] = Sd[0]; s01[v] = Sd[1]; s10[v] = Sd[2]; s11[v] = Sd[3]; sf0[v] = hf[0]; sf1[v] = hf[1]; si0[v] = hi[0]; si1[v] = hi[1];
  }
  for (v = 0; v < N; v++) resCoeffs(v);

  // Touch drone (R&D). Each voice samples its own output through 10k into a clip node with a back-to-back Schottky pair
  // (BAT54S) to Vref, so the node follows the output until it nears about a quarter of a volt and then flattens. A two-
  // resistor divider after the clip scales it by alpha, the voice's critical feed over D3's, so one ladder serves every
  // voice. The scaled node drives a series ladder of resistors with a copper pad at each tap; a fingertip bridges a tap to
  // a common return electrode, which reaches the op-amp's + input through 100k. The + node is only Rp (100 ohm) to Vref,
  // so each touch is a current into it: a push in step with the output. Sustain below the drone point leaves a small
  // deficit; the unclipped push of a touch beats it and the voice starts, then the clipped push stops growing while the
  // loss keeps growing, and the drone settles where they balance. The page solves the ladder, skin and finger overlap for
  // each strip and sends the transfer conductance G; here the clipped push is reduced to its fundamental (a describing
  // function of the envelope), which the resonator, a narrow filter, is all it responds to.
  var TD_RF = 10e3, TD_IS = 1.5e-8, TD_NVT = 1.05 * 0.025852, TD_NA = 512, TD_AMAX = 2.6;
  var TD_KREF = 0; for (v = 0; v < N; v++) if (designRes[v].kcrit > TD_KREF) TD_KREF = designRes[v].kcrit;
  var tdAlpha = new Float64Array(N), tdG = new Float64Array(N), tdEnv = new Float64Array(N), tdDecay = new Float64Array(N);
  for (v = 0; v < N; v++) { tdAlpha[v] = designRes[v].kcrit / TD_KREF; designRes[v].tdAlpha = tdAlpha[v]; }
  function tdClip(vo) {              // clip node voltage for an output voltage (10k into the Schottky pair)
    var sg = vo < 0 ? -1 : 1, va = vo * sg, lo = 0, hi = va;
    for (var k = 0; k < 50; k++) { var m = 0.5 * (lo + hi), i = 2 * TD_IS * Math.sinh(m / TD_NVT); if (m + i * TD_RF > va) hi = m; else lo = m; }
    return sg * 0.5 * (lo + hi);
  }
  var tdDF = new Float64Array(TD_NA + 2);   // fundamental of the clip node over the output's amplitude, 1 when small
  (function () {
    tdDF[0] = 1;
    for (var ia = 1; ia < TD_NA + 2; ia++) {
      var A = ia * TD_AMAX / TD_NA, acc = 0, M = 64;
      for (var j = 0; j < M; j++) { var th = (j + 0.5) * Math.PI / M; acc += tdClip(A * Math.sin(th)) * Math.sin(th); }
      tdDF[ia] = (2 / M) * acc / A;
    }
  })();
  function tdRatio(A) { var p = A * TD_NA / TD_AMAX, i = p | 0; if (i >= TD_NA) return tdDF[TD_NA] * TD_AMAX / Math.max(A, TD_AMAX); return tdDF[i] + (tdDF[i + 1] - tdDF[i]) * (p - i); }


  // Level LED on each voice: the op-amp's output reaches the base of an NPN transistor through a capacitor, a resistor
  // holds the base just below turn-on from a shared bias rail, and the LED sits in the collector. The emitter resistor
  // sets the current, so the LED lights on the upper half of each cycle, by an amount close to the note's level.
  var LED_C = 1e-6, LED_RB = 10e3, LED_RE = 330, LED_VB = VCC * 100 / (1200 + 100), LED_IS = 6.734e-15, LED_VT = 0.025852;
  var LED_BETA = opt && opt.ledBeta ? opt.ledBeta : 200;
  var LED_N = 2048, LED_SPAN = 3.2, LED_SCALE = LED_N / LED_SPAN, ledTab = new Float64Array(LED_N + 2);
  (function () {
    for (var i = 1; i < LED_N + 2; i++) {             // emitter current for each base voltage
      var vb = i / LED_SCALE, ie = ledTab[i - 1] || 1e-12;
      for (var it = 0; it < 100; it++) {
        var f = LED_VT * Math.log(ie / LED_IS + 1) + ie * LED_RE - vb, df = LED_VT / (ie + LED_IS) + LED_RE, nx = ie - f / df;
        if (nx <= 0) nx = ie * 0.1;
        var done = Math.abs(nx - ie) < 1e-12 * (1 + nx / 1e-9); ie = nx; if (done) break;
      }
      ledTab[i] = ie;
    }
  })();
  var LED_KC = dt / LED_C, LED_A = LED_BETA / (LED_BETA + 1), LED_FULL = 1.7e-3;
  var ledX = new Float64Array(N), ledAcc = new Float64Array(N), ledCount = 0;
  // Overtone bus: each driver's emitter voltage, a half-wave copy of a loud note, goes through its own resistor to a shared
  // bus. One capacitor passes the sum to an inverting op-amp whose feedback is the overtone pot, and that feeds the mix.
  // Inverted, the half-wave takes the top off each cycle and then folds it over, which is what raises the octave.
  var OT_R = 68e3, OT_C = 10e-6, OT_POT = 10e3, OT_RM = 4.7e3, OT_SIGN = opt && opt.otSign ? opt.otSign : -1;
  var OT_KC = dt / (OT_C * OT_R / N), otVc = 0, otKnob = 0, otRf = 0, otRfTarget = 0, otPeak = 0;
  // Drone limiter: the overtone bus's coupling capacitor already holds the average emitter voltage, the eleven voices'
  // summed level smoothed over about 60 ms. A spare op-amp section takes the bus through another RC (100k, 1 uF) and
  // amplifies how far it sits above the LIMIT pot's voltage; through a diode, that pulls the DECAY knob's wiper down.
  // So the louder the instrument as a whole, the less feedback every voice gets, and only a few can drone. Off, it never pulls.
  var LIM_G = opt && opt.limG ? opt.limG : 5, LIM_K = 1 - Math.exp(-(4 / sampleRate) / 0.1), limOn = 0, limTh = 0, limLP = 0, limPull = 0, LIM_PER = 0.051;
  var biasLP = 0, biasPeak = 0, BIAS_K = 1 - Math.exp(-dt / 0.02);

  // Dust noise. A 1M resistor's thermal noise, about 20 uV rms once the op-amp's input capacitance has rolled it off near
  // 16 kHz, is amplified by two non-inverting stages of 101 each, to about 0.2 V rms around VREF. Two comparators make a
  // window around VREF: one goes high on a peak above VREF + Vt, the other goes low on a dip below VREF - Vt. Their outputs
  // meet through two equal 4.7k resistors, so the node idles at 2.5 V, jumps to 5 V on a peak and to 0 V on a dip: half
  // the blips go up, half go down. Vt comes from a resistor chain, 5 V - 9.1k - DENSITY rheostat - 9.1k - ground, whose
  // two inner ends sit symmetrically about 2.5 V. At zero the window closes and the stream is two-level white noise. The
  // DUST pot, from the node to VREF, sets the level, and the result can feed every voice's X node, the clipper, or both.
  var DN_SIGMA = 0.2, DN_RCH = 8.2e3, DN_RHEO = 10e3, DN_POT = 10e3, DN_RSUM = 4.7e3;
  var DN_SWING = (VCC / 2) * DN_POT / (DN_POT + DN_RSUM / 2);       // a blip's height at the top of the DUST pot
  var DN_RV = opt && opt.dustRv ? opt.dustRv : 15e3, DN_RM = opt && opt.dustRm ? opt.dustRm : 68e3;
  // Strikes. A blip lasts tens of microseconds, far too short to carry a tap's worth of charge, so the resonator route takes
  // the two comparator outputs through a dual one-shot (74HC123) that stretches every blip to 0.3 ms. A second pair of
  // 4.7k resistors sums the one-shots the same way, the HIT pot sets the level, a buffer drives the voices, and each voice
  // takes it through 4.7k. At full HIT one blip lands about twice as hard as a firm tap; near 80% it matches one.
  var DN_HOLD = opt && opt.dustHold ? opt.dustHold : 0.3e-3, DN_RH = opt && opt.dustRh ? opt.dustRh : 4.7e3;
  // A higher note answers the same charge more strongly (smaller capacitors), so each voice has its own strike resistor,
  // sized from a single-strike test so every note peaks at about 2.4 V, just at the rails, at full level. Raw blips use the same resistors.
  var DN_RHV = [3.0e3, 3.6e3, 3.6e3, 3.6e3, 4.3e3, 4.7e3, 4.3e3, 5.1e3, 5.1e3, 5.6e3, 6.2e3], DN_GV = new Float64Array(N);
  for (v = 0; v < N; v++) DN_GV[v] = opt && opt.dustRh ? 1 : DN_RH / DN_RHV[v];
  var DN_QUIET = opt && opt.dustQuiet ? 1 : 0;   // tests only: no noise, strikes fired by hand
  // Variable-size strikes: the strike window passes the slow noise instead of a fixed voltage, buffered with gain so its
  // rms is DN_VAR_RMS; each strike takes whatever height and sign the slow noise has at that moment, clipped at the rails.
  var DN_VAR_RMS = 1.0, DN_RDROP = opt && opt.dustRdrop ? opt.dustRdrop : 100e3, dnDrop = 0, dnDropTarget = 0;
  var dnHoldN = Math.round(DN_HOLD / dt), dnUp = 0, dnDn = 0, dnHit = 0, dnHitTarget = 0, dnRaw = 0, dnRawTarget = 0;
  function dnVt(p) { var rc = DN_RHEO * (1 - p);   // the knob is wired so that clockwise closes the window: left is sparsest
    return (VCC / 2) * rc / (2 * DN_RCH + rc); }
  var DN_A1 = 1 - Math.exp(-dt * 2 * Math.PI * 16e3), DN_A2 = 1 - Math.exp(-dt * 2 * Math.PI * 54e3);
  var dnSlow = 0, DN_SLOW_A = 1 - Math.exp(-dt * 2 * Math.PI * 700), dnSlowNorm = 1;
  var dn1 = 0, dn2 = 0, dn3 = 0, dnSpare = 0, dnHave = 0, dnNorm = 1, dnSeed = 98765;
  var dnThr = 0, dnThrTarget = 0, dnLvl = 0, dnLvlTarget = 0, dnToVoices = 0, dnToMix = 0, dnDensity = 0, dnHigh = 0, dnCount = 0, dnLast = 0, dnEdges = 0;
  // which resonators the dust reaches: all, the odd-numbered notes (1st, 3rd ... 11th from the left) or the even ones; and
  // whether each blip goes to all of them at once or to one picked at random. Hardware: two resistor buses (odd, even) and a
  // 16-channel analog mux whose address is a counter running off the 25 kHz sustain clock, sampled at random by the blips.
  // Target sets, by note number counted from the left (1 = D3 ... 11 = D5).
  var DN_SETS = { all: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], odd: [1, 3, 5, 7, 9, 11], even: [2, 4, 6, 8, 10],
    s4: [1, 3, 4, 6, 8, 9, 11], s5: [2, 4, 5, 7, 9, 10], s6: [3, 5, 6, 8, 10, 11], s7: [4, 6, 7, 9, 11],
    low: [1, 2, 3, 4, 5, 6], high: [6, 7, 8, 9, 10, 11], roots: [1, 6, 11], fifths: [1, 4, 6, 9, 11], one: [6] };
  var dnSet = 'all', dnRandom = 0, dnTarget = -1, dnMask = new Uint8Array(N), dnPick = [];
  function dnSetMask() {
    dnPick = []; for (var i = 0; i < N; i++) dnMask[i] = 0;
    DN_SETS[dnSet].forEach(function (k) { dnMask[k - 1] = 1; dnPick.push(k - 1); });
  }
  dnSetMask();
  function dnRand() { dnSeed = (Math.imul(dnSeed, 1103515245) + 12345) | 0; return ((dnSeed >>> 8) + 0.5) / 16777216; }
  function dnGauss() {
    if (dnHave) { dnHave = 0; return dnSpare; }
    var u = dnRand(), w = 2 * Math.PI * dnRand(), r = Math.sqrt(-2 * Math.log(u));
    dnSpare = r * Math.sin(w); dnHave = 1; return r * Math.cos(w);
  }
  function dnStep() {                // amplified noise at the comparator's + input, in units of its rms
    dn1 += DN_A1 * (dnGauss() - dn1); dn2 += DN_A2 * (dn1 - dn2); dn3 += DN_A2 * (dn2 - dn3);
    var x = dn3 * dnNorm; dnSlow += DN_SLOW_A * (x - dnSlow);   // the same noise through one RC at 700 Hz: slow enough to hold still through a strike
    return x;
  }
  (function () {                     // scale so the filtered noise has unit rms
    var s2 = 0, M = 200000, x;
    for (var i = 0; i < 2000; i++) dnStep();
    for (i = 0; i < M; i++) { x = dnStep(); s2 += x * x; }
    dnNorm = 1 / Math.sqrt(s2 / M);
    var q2 = 0; for (i = 0; i < M; i++) { dnStep(); q2 += dnSlow * dnSlow; }
    dnSlowNorm = 1 / Math.sqrt(q2 / M);
  })();

  var CTRL = 4, ctrlCount = 0;       // pad and slider maths run every CTRL output samples
  var ctrlDt = CTRL / sampleRate;
  for (v = 0; v < N; v++) tdDecay[v] = Math.exp(-ctrlDt * designRes[v].f0 / 1.5);   // envelope follower lets go over about 1.5 cycles
  // a tap lands within a couple of milliseconds, and a finger lifts more slowly
  var P_ATTACK = 1 - Math.exp(-ctrlDt / 0.002), P_RELEASE = 1 - Math.exp(-ctrlDt / 0.025);

  var P_SLOW = 1 - Math.exp(-ctrlDt / 0.02), ONSET_TICKS = Math.round(0.04 / ctrlDt);
  var B_PUSH = 1 - Math.exp(-ctrlDt / 0.004), B_SPRING = 1 - Math.exp(-ctrlDt / 0.012);
  function controlRes() {
    for (var v = 0; v < N; v++) {
      // A tap lands fast; once the finger is down, force can only change slowly.
      var tgt = padTarget[v], p = padP[v], p0 = p;
      if (tgt > p) { p += (tgt - p) * (onset[v] > 0 ? P_ATTACK : P_SLOW); } else { p += (tgt - p) * P_RELEASE; }
      if (onset[v] > 0) onset[v]--;
      padP[v] = p;
      // the piezo turns a change in force into charge, and Ck passes its share into the resonator
      ikick[v] = designRes[v].qk * (p - p0) / ctrlDt;
      if (tdKick[v] !== 0) { ikick[v] += designRes[v].qk * tdKick[v] / ctrlDt; tdKick[v] = 0; }   // a fingertip landing on a strip jolts the voice a little
      // bend slider: follows the finger closely, and its spring takes a moment longer to bring it home
      var bt = bendTarget[v], bn = bendNow[v];
      if (bn !== bt) {
        bn += (bt - bn) * (bt > bn ? B_PUSH : B_SPRING);
        if (Math.abs(bt - bn) < 2e-4) bn = bt;
        bendNow[v] = bn;
        if (bn === bt || Math.abs(bn - bendUsed[v]) > 4e-4) { bendUsed[v] = bn; resCoeffs(v); }
      }
    }
    // Touch drone: follow each touched voice's envelope and set its push from the clipped fundamental.
    for (v = 0; v < N; v++) {
      if (tdG[v] === 0 && tdK[v] === 0) { tdEnv[v] = 0; continue; }
      var av2 = rvo[v] < 0 ? -rvo[v] : rvo[v], ev = tdEnv[v] * tdDecay[v]; tdEnv[v] = av2 > ev ? av2 : ev;
      var kt = tdG[v] === 0 ? 0 : tdAlpha[v] * R_P * tdG[v] * tdRatio(tdEnv[v]);
      var dk = kt - tdK[v]; if (dk < 0) dk = -dk;
      if (dk > 0.003 * designRes[v].kcrit || (kt === 0 && tdK[v] !== 0)) { tdK[v] = kt; resCoeffs(v); }
    }
    // Decay clock: the knob's wiper voltage against the ramp gives the duty cycle every voice's switch follows.
    pedal += (pedalTarget - pedal) * P_ATTACK;
    var up = KNOB_PAD + (1 - pedal) * KNOB_POT, dn = KNOB_PAD + pedal * KNOB_POT, vc = VCC * dn / (up + dn);
    limLP += (otVc - limLP) * LIM_K;
    if (limOn) { limPull = LIM_G * (limLP - limTh); if (limPull < 0) limPull = 0; vc -= limPull; } else limPull = 0;
    var duty = (vc - V_LO) / (V_HI - V_LO); if (duty < 0) duty = 0; else if (duty > 1) duty = 1;
    // A resonator cannot follow the clock, only its average: the share of loss cancelled is in proportion to the duty cycle.
    for (v = 0; v < N; v++) {
      var sv = SHARE_MAX * duty;
      if (Math.abs(sv - susV[v]) > 0.002 * susV[v] + 1e-6) { susV[v] = sv; resCoeffs(v); }
    }
  }

  // ---- mix bus, soft clipper, output ------------------------------------------
  var gainKnob = 0.45, levelKnob = 0.8, rf = RRF_MIN, level = 0, rfTarget = RRF_MIN, levelTarget = 0;
  function knobs() {
    var g3 = gainKnob * gainKnob * gainKnob;                        // log-taper pot
    rfTarget = RRF_MIN + RRF_POT * g3;
    levelTarget = levelKnob * levelKnob * levelKnob;
  }
  knobs(); rf = rfTarget; level = levelTarget;
  var vf = 0, K_CF = dt / CF;
  var dcA = 1 / (1 + 2 * Math.PI * 18 * dt), dcX = 0, dcY = 0;
  var clipPeak = 0, outPeak = 0;

  // decimation filter: Kaiser-windowed sinc
  var TAPS = 16 * OS, fir = new Float64Array(TAPS), ring = new Float64Array(TAPS), ringPos = 0;
  (function () {
    function i0(x) { var s = 1, t = 1; for (var k = 1; k < 30; k++) { t *= (x / (2 * k)) * (x / (2 * k)); s += t; } return s; }
    var beta = 8, fc = 0.46 / OS, sum = 0;
    for (var n = 0; n < TAPS; n++) {
      var m = n - (TAPS - 1) / 2, r = 2 * n / (TAPS - 1) - 1;
      var w = i0(beta * Math.sqrt(1 - r * r)) / i0(beta);
      var h = m === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * m) / (Math.PI * m);
      fir[n] = h * w; sum += fir[n];
    }
    for (n = 0; n < TAPS; n++) fir[n] /= sum;
  })();

  // Breath strips (R&D). One shared noise source, the dust circuit's amplified noise taken up to about 1 V rms by a spare
  // op-amp section, drives every strip's comb through 1k. The comb is interleaved with the ladder taps, so a fingertip
  // carries the noise from the comb through the skin to the taps it covers; the ladder's far end reaches the + input
  // through 100k, with a per-voice shunt to Vref in front of it that evens the voices out (D3 has none). The + node is
  // Rp to Vref, so the finger's current becomes a small voltage there, and the resonator picks its own pitch out of the
  // noise: a sustained note with no self-oscillation, as loud as the finger and the Decay setting allow. Because the
  // comb is a stiff source and the body sits on it, several fingers do not share out one push.
  // Skew circuit: the slope network (10k with a per-voice capacitor, corner at 3.3 times the note) and the shared ramp's
  // height, set by the SKEW knob: 2.4 V at its bottom (gentle) down to 0.2 V at its top (strong). The ramp is shaped so a
  // slope u of its height gives a duty of SKH_D0 / (1 - u)^2, the law that keeps the pitch steady (pitch goes as the
  // square root of the duty). It spans u from -1.5 to 2/3, where the duty reaches 100 %.
  var HP_K = new Float64Array(N), hpC = new Float64Array(N), hwH = 2.4, HW_UMAX = 0.5, HW_UNEG = 0.5;
  for (v = 0; v < N; v++) HP_K[v] = 1 - Math.exp(-dt * 2 * Math.PI * designRes[v].f0 / 0.3);
  var BR_RMS = 1.0, BR_BW = 16e3, BR_K = 1 - Math.exp(-2 * Math.PI * BR_BW / (sampleRate * OS));
  var BR_SIG = BR_RMS * Math.sqrt((2 - BR_K) / BR_K), brSeed = 987654321, brLP = 0, brAny = 0;
  var BR_F = [1.0000, 0.7287, 0.6141, 0.4987, 0.4751, 0.3815, 0.3186, 0.2795, 0.2117, 0.2117, 0.1519]   // D3 none; then 270k, 160k, 100k, 91k, 62k, 47k, 39k, 27k, 27k, 18k (shunt fraction Rsh / (Rsh + 100k))
  var brP = new Float64Array(N);     // volts at the + input per volt of noise
  function process(out, frames) {
    var SMOOTH = 1 - Math.exp(-1 / (0.01 * sampleRate)), v;
    for (var n = 0; n < frames; n++) {
      if (ctrlCount === 0) controlRes();
      if (++ctrlCount >= CTRL) ctrlCount = 0;
      rf += (rfTarget - rf) * SMOOTH;
      level += (levelTarget - level) * SMOOTH;
      phM += (phMT - phM) * SMOOTH; if (phMT === 0 && phM < 1e-4) phM = 0;
      otRf += (otRfTarget - otRf) * SMOOTH; if (otRfTarget === 0 && otRf < 1) otRf = 0;
      dnThr += (dnThrTarget - dnThr) * SMOOTH; dnLvl += (dnLvlTarget - dnLvl) * SMOOTH; if (dnLvlTarget === 0 && dnLvl < 1e-6) dnLvl = 0;
      dnHit += (dnHitTarget - dnHit) * SMOOTH; if (dnHitTarget === 0 && dnHit < 1e-6) dnHit = 0;
      dnRaw += (dnRawTarget - dnRaw) * SMOOTH; if (dnRawTarget === 0 && dnRaw < 1e-6) dnRaw = 0;
      dnDrop += (dnDropTarget - dnDrop) * SMOOTH; if (dnDropTarget === 0 && dnDrop < 1e-6) dnDrop = 0;
      var gf = 1 / rf;
      for (var o = 0; o < OS; o++) {
        var iin, w = vf;
        var sum = 0, leSum = 0;
        // dust: comparator, coupling capacitor into the level pot, then the two routes
        var ikd = 0;
        var brN = 0;
        if (brAny) {                 // white Gaussian noise through a one-pole roll-off at BR_BW
          brSeed = (Math.imul(brSeed, 1664525) + 1013904223) | 0; var u1_ = (brSeed >>> 0) / 4294967296 + 1e-12;
          brSeed = (Math.imul(brSeed, 1664525) + 1013904223) | 0; var u2_ = (brSeed >>> 0) / 4294967296;
          brLP += BR_K * (Math.sqrt(-2 * Math.log(u1_)) * Math.cos(6.283185307 * u2_) * BR_SIG - brLP); brN = brLP;
        }
        if (dnLvl > 1e-6 || dnLvlTarget > 0 || dnHit > 1e-6 || dnHitTarget > 0 || dnRaw > 1e-6 || dnRawTarget > 0 || dnDrop > 1e-6 || dnDropTarget > 0) {
          var nz = DN_QUIET ? 0 : dnStep() * DN_SIGMA, st = nz > dnThr ? 1 : (nz < -dnThr ? -1 : 0);
          dnHigh += st !== 0 ? 1 : 0; dnCount++;
          if (st !== 0 && st !== dnLast) {
            dnEdges++;
            // Non-retriggerable one-shots (74HC221), each held off while the other is running, so every strike is the same
            // 0.3 ms pulse: blips that arrive during a strike are ignored rather than stretching it.
            if (dnUp === 0 && dnDn === 0) { dnTarget = dnPick[(dnRand() * dnPick.length) | 0]; if (st > 0) dnUp = dnHoldN; else dnDn = dnHoldN; }
          }
          dnLast = st;
          var vd = st * DN_SWING * dnLvl;
          var sh = (dnUp > 0 ? 1 : 0) - (dnDn > 0 ? 1 : 0); if (dnUp > 0) dnUp--; if (dnDn > 0) dnDn--;
          // the resonator send: one strike per blip, of random size, to one note of the set at random
          var vvar = 0;
          if (sh !== 0) { vvar = dnSlow * dnSlowNorm * DN_VAR_RMS; if (vvar > VSAT) vvar = VSAT; else if (vvar < -VSAT) vvar = -VSAT; }
          var ikr = vvar !== 0 && dnHit > 0 ? vvar * dnHit / DN_RH : 0;
        } else { vd = 0; ikr = 0; }
        for (v = 0; v < N; v++) {
          var a = ra[v], b = rb[v], ik = ikick[v];
          if (ikr !== 0 && v === dnTarget) ik += ikr * DN_GV[v];
          // circuit noise
          seed = (Math.imul(seed, 1664525) + 1013904223) | 0; ik += seed * NOISE_I;
          var an, bn, vo;
          if (rsat[v]) {
            vo = rsat[v] * VSAT;
            an = s00[v] * a + s01[v] * b + sf0[v] * vo + si0[v] * ik; bn = s10[v] * a + s11[v] * b + sf1[v] * vo + si1[v] * ik;
            var lin = rG[v] * (an - bn);
            if (rsat[v] > 0 ? lin < VSAT : lin > -VSAT) { rsat[v] = 0; vo = lin; }   // the loop closes again
          } else {
            if (SKH) {
              // Skew circuit: a capacitor and resistor take the slope of the voice's output (the high-pass state is the capacitor's
              // voltage); a comparator holds it against the shared shaped ramp, and that sets this sample's duty on the trimmer feed.
              var vs_ = rvo[v] - hpC[v]; hpC[v] += HP_K[v] * vs_;
              var uh = vs_ / hwH; if (uh > HW_UMAX) uh = HW_UMAX; else if (uh < -HW_UNEG) uh = -HW_UNEG;
              var om = 1 - uh, dk_ = SKH_D0 / (om * om), q4h = v * 4;
              var A0_ = hwAo[q4h] + dk_ * hwdA[q4h], A1_ = hwAo[q4h + 1] + dk_ * hwdA[q4h + 1], A2_ = hwAo[q4h + 2] + dk_ * hwdA[q4h + 2], A3_ = hwAo[q4h + 3] + dk_ * hwdA[q4h + 3];
              var sgh = 0.5 * (A0_ + A3_), t2h = (A0_ * A3_ - A1_ * A2_ - sgh * sgh) * dt * dt, xh = sgh * dt;
              var Exh = 1 + xh * (1 + xh * (0.5 + xh / 6)), Cch = Exh * (1 - t2h * (0.5 - t2h / 24)), Snh = Exh * dt * (1 - t2h * (1 / 6 - t2h / 120));
              an = (Cch + Snh * (A0_ - sgh)) * a + Snh * A1_ * b + d0[v] * ik;
              bn = Snh * A2_ * a + (Cch + Snh * (A3_ - sgh)) * b + d1[v] * ik;
            } else if (skB > 0) {
              var u_ = skB * (skQa[v] * a + skQb[v] * b); if (u_ > SK_UMAX) u_ = SK_UMAX; else if (u_ < -SK_UMAX) u_ = -SK_UMAX;
              var hw = dt / (1 - u_), t2 = skW2[v] * hw * hw, x_ = skSig[v] * hw, ikw = ik / (1 - u_);   // the inputs speed up with the rest of the network
              var Ex = 1 + x_ * (1 + x_ * (0.5 + x_ / 6)), Cc = Ex * (1 - t2 * (0.5 - t2 / 24)), Sn = Ex * hw * (1 - t2 * (1 / 6 - t2 / 120)), q4 = v * 4;
              an = (Cc + Sn * skA[q4]) * a + Sn * skA[q4 + 1] * b + d0[v] * ikw;
              bn = Sn * skA[q4 + 2] * a + (Cc + Sn * skA[q4 + 3]) * b + d1[v] * ikw;
            } else { an = c00[v] * a + c01[v] * b + d0[v] * ik; bn = c10[v] * a + c11[v] * b + d1[v] * ik; }
            var ep = brP[v] > 0 ? brN * brP[v] : 0;
            if (ep !== 0) { an += pe0[v] * ep; bn += pe1[v] * ep; }
            vo = rG[v] * (an - bn + ep);
            if (vo > VSAT) { rsat[v] = 1; vo = VSAT; } else if (vo < -VSAT) { rsat[v] = -1; vo = -VSAT; }   // op-amp hits a rail
          }
          ra[v] = an; rb[v] = bn; rvo[v] = vo;
          var av = vo < 0 ? -vo : vo; if (av > rpk[v]) rpk[v] = av;
          // level LED: the coupling capacitor's charge is the only state; base current and the bias resistor move it
          var lx = ledX[v], vb = LED_VB + vo - lx, ie = 0;
          if (vb > 0) { var lp = vb * LED_SCALE, li = lp | 0; if (li > LED_N) { li = LED_N; lp = LED_N; } ie = ledTab[li] + (ledTab[li + 1] - ledTab[li]) * (lp - li); }
          ledX[v] = lx + LED_KC * (ie * (1 - LED_A) + (vo - lx) / LED_RB);
          ledAcc[v] += ie;
          if (phM > 1e-4 && !rsat[v]) {
            var qd = (skQa[v] * an + skQb[v] * bn) * skQn[v], A2p = vo * vo + qd * qd;
            if (A2p > 1e-8) {
              var Ap = Math.sqrt(A2p), sp = vo / Ap, cp = qd / Ap, dl = phM * sp / (1 - phM * cp), sd, cd, d2;
              for (var it_ = 0; it_ < 2; it_++) {
                d2 = dl * dl; sd = dl * (1 - d2 * (0.16666667 - d2 * (0.0083333333 - d2 * 0.000198413))); cd = 1 - d2 * (0.5 - d2 * (0.041666667 - d2 * 0.0013888889));
                dl -= (dl - phM * (sp * cd + cp * sd)) / (1 - phM * (cp * cd - sp * sd));
                if (dl > 1.7) dl = 1.7; else if (dl < -1.7) dl = -1.7;
              }
              d2 = dl * dl; sd = dl * (1 - d2 * (0.16666667 - d2 * (0.0083333333 - d2 * 0.000198413))); cd = 1 - d2 * (0.5 - d2 * (0.041666667 - d2 * 0.0013888889));
              sum += vo * cd + qd * sd;
            } else sum += vo;
          } else sum += vo;
          leSum += ie;
        }
        ledCount++;
        // overtone bus: the eleven resistors look like one source, the average emitter voltage behind OT_R / N
        iin = sum / R_MIX;
        if (dnToMix) iin += vd / DN_RM;
        var otI = (leSum * LED_RE / N - otVc) * (N / OT_R); otVc += OT_KC * otI * (OT_R / N);
        var vot = OT_SIGN * otI * otRf;
        if (otRf > 0) {
          if (vot > VSAT) vot = VSAT; else if (vot < -VSAT) vot = -VSAT;
          var ao = vot < 0 ? -vot : vot; if (ao > otPeak) otPeak = ao;
          iin += vot / OT_RM;
        }
        // how far the clipper's input sits off centre, averaged over about 20 ms (display and tests only)
        biasLP += (iin * R_MIX - biasLP) * BIAS_K; var ab_ = biasLP < 0 ? -biasLP : biasLP; if (ab_ > biasPeak) biasPeak = ab_;
        // gain stage with Rf, Cf and a diode pair in the feedback loop
        for (var k = 0; k < 4; k++) {
          var ex = Math.exp(w / CL_NVT), inv = 1 / ex;
          var hv = w - vf - K_CF * (iin - w * gf - CL_IS * (ex - inv));
          var dh = 1 + K_CF * (gf + CL_IS / CL_NVT * (ex + inv));
          var dw = hv / dh;
          if (dw > 0.15) dw = 0.15; else if (dw < -0.15) dw = -0.15;
          w -= dw;
          if (dw < 1e-6 && dw > -1e-6) break;
        }
        vf = w;
        var a = vf < 0 ? -vf : vf; if (a > clipPeak) clipPeak = a;
        // output level pot and DC block
        var z = vf * level;
        dcY = dcA * (dcY + z - dcX); dcX = z;
        ring[ringPos] = dcY; ringPos = (ringPos + 1) % TAPS;
      }
      var acc = 0, idx = ringPos;
      for (var t = 0; t < TAPS; t++) { acc += fir[t] * ring[idx]; if (++idx === TAPS) idx = 0; }
      acc *= OUT_GAIN;
      var ab = acc < 0 ? -acc : acc; if (ab > outPeak) outPeak = ab;
      out[n] = acc > 1 ? 1 : (acc < -1 ? -1 : acc);
    }
  }

  function limitVoices(x) { return 0.5 + 10.5 * x; }
  var levels = new Float64Array(N), leds = new Float64Array(N);
  return {
    N: N, process: process,
    designs: designRes, octave: OCT, spreadV: KERR_V,
    freqAt: function (v, s, x) { return resPole(designRes[v], s, x || 0).f; },
    setPad: function (v, p) {
      if (v < 0 || v >= N) return;
      p = p < 0 ? 0 : (p > 1 ? 1 : p);
      if (p > 0 && padTarget[v] <= 0) onset[v] = ONSET_TICKS;   // a new contact
      padTarget[v] = p;
    },
    setTune: function (v, s) {
      if (v < 0 || v >= N) return;
      tuneRes[v] = s < -1 ? -1 : (s > 1 ? 1 : s); resCoeffs(v);
    },
    setBend: function (v, x) { if (v >= 0 && v < N) bendTarget[v] = x < 0 ? 0 : (x > 1 ? 1 : x); },
    bendNow: bendNow,
    bendAt: function (v, s, x) { var d = designRes[v]; return 12 * Math.log(resPole(d, s, x).f / resPole(d, s, 0).f) / Math.LN2; },
    setGain: function (x) { gainKnob = x; knobs(); },
    // LIMIT knob: 0 is off; otherwise the bus level it allows, in units of one voice droning at about full level
    touchKick: function (v, x) { if (v >= 0 && v < N) tdKick[v] = x; },
    setTouchG: function (v, g) { if (v >= 0 && v < N) tdG[v] = g > 0 ? g : 0; },
    touchRth: function (share) { var d = 1 - share; return d > 0 ? R_P / (TD_KREF * d) : Infinity; },   // ladder total that just starts a drone, at a total feedback share   // ladder total that just starts a drone, at Sustain x
    touchK: tdK, touchEnv: tdEnv,
    setSustain: function (x) { pedalTarget = x < 0 ? 0 : (x > 1 ? 1 : x); },
    sustainOf: function (x) { return SHARE_MAX * x; },
    sustainDefault: SHARE_NOM / SHARE_MAX,
    setLimit: function (x) { x = x < 0 ? 0 : (x > 1 ? 1 : x); limOn = x > 0.005 ? 1 : 0; limTh = limitVoices(x) * LIM_PER; },
    limitOf: function (x) { return x > 0.005 ? limitVoices(x) : 0; },
    limiter: function () { return { bus: limLP, pull: limPull }; },
    setLevel: function (x) { levelKnob = x; knobs(); },
    // overtone pot: a linear 10k in the inverting stage's feedback, so the knob sets its gain directly
    setOvertone: function (x) { otKnob = x < 0 ? 0 : (x > 1 ? 1 : x); otRfTarget = OT_POT * otKnob; },
    overtoneOf: function (x) { return (OT_POT * x / OT_R) * (R_MIX / OT_RM); },   // weight of the half-wave against the voice itself
    // DENSITY: a linear 10k from VREF up to about 0.89 V above it, so the knob moves the threshold from 0 to about 4.4 rms
    setDensity: function (x) { x = x < 0 ? 0 : (x > 1 ? 1 : x); dnThrTarget = dnVt(x); if (!(dnLvl + dnHit + dnRaw + dnDrop + dnLvlTarget + dnHitTarget + dnRawTarget + dnDropTarget)) dnThr = dnThrTarget; },
    // DUST: level pot, log taper
    setDust: function (x) { x = x < 0 ? 0 : (x > 1 ? 1 : x); dnLvlTarget = x * x * x; },
    dustRate: function (x) { var z = dnVt(x) / DN_SIGMA; return 38000 * Math.exp(-0.53 * z * z); },   // blips a second, up and down together, from the measured crossing rate at VREF
    _strike: function (v, sign) { dnTarget = v; if (sign > 0) dnUp = dnHoldN; else dnDn = dnHoldN; },
    setHit: function (x) { x = x < 0 ? 0 : (x > 1 ? 1 : x); dnHitTarget = x; },   // to random resonator: a linear pot sets each strike's height
    setDustRoute: function (voices, mix) { dnToVoices = voices ? 1 : 0; dnToMix = mix ? 1 : 0; },
    setDustTargets: function (set, random) { dnSet = DN_SETS.hasOwnProperty(set) ? set : 'all'; dnRandom = random ? 1 : 0; dnSetMask(); },
    densityOf: function (x) {        // share of time outside the window, for a Gaussian at the comparators
      var z = dnVt(x) / DN_SIGMA / Math.SQRT2, tt = 1 / (1 + 0.3275911 * z);
      return tt * (0.254829592 + tt * (-0.284496736 + tt * (1.421413741 + tt * (-1.453152027 + tt * 1.061405429)))) * Math.exp(-z * z);
    },
    gainOf: function (x) { return (RRF_MIN + RRF_POT * x * x * x) / R_MIX; },
    // breath strip: g is the ladder's transfer conductance, amps into the + input per volt on the comb
    setBreath: function (v, g) { if (v < 0 || v >= N) return; brP[v] = g > 0 ? g * R_P * BR_F[v] : 0; brAny = 0; for (var i = 0; i < N; i++) if (brP[i] > 0) brAny = 1; },
    breathF: BR_F,
    // SKEW: 0 off; 1 gives a note at 0.6 V (half a full tap) a self-FM index of 0.8; louder notes lean further, up to SK_UMAX
    skewHw: SKH,
    setSkew: function (x) { x = x < 0 ? 0 : (x > 1 ? 1 : x); hwH = 2.4 * Math.pow(0.2 / 2.4, x); if (SKH) return; phMT = PH_MMAX * x; },
    resOut: rvo, levels: levels, leds: leds, ledFull: LED_FULL,
    meters: function () {
      // per-voice level for the display: the ring's amplitude at each op-amp since the last call,
      // and each level LED's average current over the same stretch, in amps
      var lc = ledCount > 0 ? LED_A / ledCount : 0; ledCount = 0;
      for (var v = 0; v < N; v++) { levels[v] = rpk[v] / 1.5; rpk[v] = 0; leds[v] = ledAcc[v] * lc; ledAcc[v] = 0; }
      var r = { clip: clipPeak, peak: outPeak, ot: otPeak, bias: biasPeak, dust: dnCount ? dnHigh / dnCount : 0, dustRate: dnCount ? dnEdges / (dnCount * dt) : 0 }; clipPeak = 0; outPeak = 0; otPeak = 0; biasPeak = 0; dnHigh = 0; dnCount = 0; dnEdges = 0; return r;
    }
  };
}
function applyMsg(core, m) {
  if (m.t === 'pad') core.setPad(m.i, m.p);
  else if (m.t === 'tune') core.setTune(m.i, m.s);
  else if (m.t === 'bend') core.setBend(m.i, m.x);
  else if (m.t === 'gain') core.setGain(m.x);
  else if (m.t === 'level') core.setLevel(m.x);
  else if (m.t === 'sustain') core.setSustain(m.x);
  else if (m.t === 'lim') core.setLimit(m.x);
  else if (m.t === 'ot') core.setOvertone(m.x);
  else if (m.t === 'dens') core.setDensity(m.x);
  else if (m.t === 'dust') core.setDust(m.x);
  else if (m.t === 'hit') core.setHit(m.x);
  else if (m.t === 'touch') core.setTouchG(m.i, m.g);
  else if (m.t === 'tkick') core.touchKick(m.i, m.x);
  else if (m.t === 'breath') core.setBreath(m.i, m.g);
  else if (m.t === 'skew') core.setSkew(m.x);
  else if (m.t === 'route') core.setDustRoute(m.v, m.m);
  else if (m.t === 'targets') core.setDustTargets(m.s, m.r);
}
// AudioWorklet processor: the same circuit model, off the main thread
class KalimbaProcessor extends AudioWorkletProcessor {
  constructor(o) { super(); var self = this; var p = o.processorOptions || {};
    this.core = createKalimbaCore(sampleRate, { octave: p.octave || 0, spread: p.spread || 0, skewHw: !!p.hw }); this.n = 0; this.every = Math.round(sampleRate / 30);
    this.port.onmessage = function (e) { applyMsg(self.core, e.data); }; }
  process(inputs, outputs) { var out = outputs[0], a = out[0]; this.core.process(a, a.length);
    for (var ch = 1; ch < out.length; ch++) out[ch].set(a);
    this.n += a.length; if (this.n >= this.every) { this.n = 0; var m = this.core.meters(); this.port.postMessage({ lv: Array.from(this.core.levels), led: Array.from(this.core.leds), clip: m.clip }); }
    return true; }
}
registerProcessor("kalimba", KalimbaProcessor);
