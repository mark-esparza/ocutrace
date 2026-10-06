// Checks the task battery measures against synthetic eye traces with known answers.
// Usage: node test/tasks.test.js
const OT = require('../src/tasks.js');

let failures = 0;
function check(name, ok, got) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (got ${got})`);
  if (!ok) failures++;
}
const within = (x, lo, hi) => Number.isFinite(x) && x >= lo && x <= hi;
const val = (out, key) => (out.measures.find(m => m.key === key) || {}).value;

let seed = 4242;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const gauss = () => { let u = 0; for (let i = 0; i < 6; i++) u += rand(); return (u - 3) / Math.sqrt(0.5); };

// Minimum-jerk saccade profile; duration follows the main sequence unless scaled.
function addSaccade(arr, fs, t, amp, durScale = 1) {
  const D = (0.0022 * Math.abs(amp) + 0.021) * durScale;
  const i0 = Math.ceil(t * fs);
  for (let i = i0; i < arr.length; i++) {
    const tau = Math.min(1, (i / fs - t) / D);
    arr[i] += amp * (10 * tau ** 3 - 15 * tau ** 4 + 6 * tau ** 5);
  }
}
function toSamples(fs, xs, ys, noise = 0.03, x2) {
  return xs.map((x, i) => {
    const s = { t: i / fs, x: x + noise * gauss(), y: (ys ? ys[i] : 0) + noise * gauss(), ok: true };
    if (x2) { s.x2 = x2[i] + noise * gauss(); s.y2 = s.y; s.ok2 = true; }
    return s;
  });
}
function run(task, samples, plan, t0, opts) {
  const res = OT.analyze(samples);
  return OT.taskMeasures(task, samples, res, plan, t0, opts);
}

// ---------- prosaccades ----------
{
  const fs = 60, T0 = 1.3, plan = OT.makePlan('sacH', 10), N = Math.ceil((T0 + plan.duration + 1) * fs);
  const x = new Array(N).fill(0); let eye = 0;
  plan.steps.forEach((st, k) => { if (k === 0) return; const want = 0.9 * st.goal.x - eye; addSaccade(x, fs, T0 + st.t + 0.2, want); eye += want; });
  const out = run('sacH', toSamples(fs, x), plan, T0);
  check('prosaccade latency 200 ms (within one frame)', within(val(out, 'latency'), 183, 217), val(out, 'latency').toFixed(0));
  check('prosaccade gain 0.9 +-0.05', within(val(out, 'gain'), 0.85, 0.95), val(out, 'gain').toFixed(3));
  check('every prosaccade trial scored', val(out, 'trials') === plan.steps.length - 1, val(out, 'trials'));
  const noSync = run('sacH', toSamples(fs, x), plan, null);
  check('without a start time, latency is withheld', !Number.isFinite(val(noSync, 'latency')), val(noSync, 'latency'));
}
{
  const fs = 240, T0 = 0.7, plan = OT.makePlan('sacV', 8), N = Math.ceil((T0 + plan.duration + 1) * fs);
  const y = new Array(N).fill(0); let eye = 0;
  plan.steps.forEach((st, k) => { if (k === 0) return; const want = st.goal.y - eye; addSaccade(y, fs, T0 + st.t + 0.25, want); eye += want; });
  const out = run('sacV', toSamples(fs, new Array(N).fill(0), y), plan, T0);
  check('vertical latency 250 ms at 240 fps (+-8 ms)', within(val(out, 'latency'), 242, 258), val(out, 'latency').toFixed(1));
  // Main sequence peak for 8 deg with min-jerk: 1.875 * A / D.
  const D = 0.0022 * 8 + 0.021, truePk = 1.875 * 8 / D;
  check('vertical peak velocity within 10% at 240 fps', within(val(out, 'peakVel'), 0.9 * truePk, 1.1 * truePk), `${val(out, 'peakVel').toFixed(0)} vs ${truePk.toFixed(0)}`);
}

// ---------- curve-fit onset (Lai et al. 2020) ----------
{
  // 60 saccades at 60 fps whose onsets fall at random points between frames. Truth is the time the
  // minimum-jerk profile has covered 3% of its amplitude, the onset definition the fit uses.
  const s3 = (() => { let lo = 0, hi = 0.5; for (let k = 0; k < 60; k++) { const m = (lo + hi) / 2; (10 * m ** 3 - 15 * m ** 4 + 6 * m ** 5 < 0.03) ? lo = m : hi = m; } return lo; })();
  const biasFit = {}, biasOld = {};
  for (const [fs, noise, tolSd, tolBias, minKept] of [[60, 0.03, 3, 2, 60], [60, 0.1, 5, 3, 60], [30, 0.03, 7, 4, 57]]) {
    const N = Math.ceil(62 * fs), x = new Array(N).fill(0), truth = [];
    let pos = 0;
    for (let k = 0; k < 60; k++) {
      const t = 1 + k + rand() * 0.5, amp = (pos === 0 ? 1 : -1) * (6 + 6 * rand());
      addSaccade(x, fs, t, amp); pos = pos === 0 ? amp : 0;
      truth.push(t + s3 * (0.0022 * Math.abs(amp) + 0.021));
    }
    const res = OT.analyze(toSamples(fs, x, null, noise));
    const errFit = [], errOld = [];
    for (const tr of truth) {
      const e = res.events.find(ev => Math.abs(ev.t - tr) < 0.1); if (!e) continue;
      const f = OT.fitEvent(res, e, 'h'); if (f && f.ok) errFit.push((f.onset - tr) * 1000);
      errOld.push((OT.onsetTime(res, e) - tr) * 1000);
    }
    const mean = a => a.reduce((p, q) => p + q, 0) / a.length, sd = a => Math.sqrt(mean(a.map(v => (v - mean(a)) ** 2)));
    // At 30 fps a short saccade can fall between two frames, leaving the curve undetermined; those are rejected.
    check(`fit onset ${fs} fps, noise ${noise}°: at least ${minKept} of 60 trials kept`, errFit.length >= minKept, errFit.length);
    check(`fit onset ${fs} fps, noise ${noise}°: SD under ${tolSd} ms`, sd(errFit) < tolSd, `${sd(errFit).toFixed(2)} ms (old method ${sd(errOld).toFixed(2)} ms)`);
    check(`fit onset ${fs} fps, noise ${noise}°: bias under ${tolBias} ms`, Math.abs(mean(errFit)) < tolBias, `${mean(errFit).toFixed(2)} ms (old method ${mean(errOld).toFixed(2)} ms)`);
    biasFit[fs + '/' + noise] = mean(errFit); biasOld[fs + '/' + noise] = mean(errOld);
  }
  // The point of the fit: its bias does not move with frame rate, unlike interpolated speed onsets.
  const shiftFit = Math.abs(biasFit['60/0.03'] - biasFit['30/0.03']), shiftOld = Math.abs(biasOld['60/0.03'] - biasOld['30/0.03']);
  check('fit onset: bias shifts under 3 ms between 30 and 60 fps', shiftFit < 3, `${shiftFit.toFixed(2)} ms (old method ${shiftOld.toFixed(2)} ms)`);
  // Quality score: a saccade buried in tracking noise is rejected; a clean one is kept.
  const fs = 60, N = 4 * fs, clean = new Array(N).fill(0); addSaccade(clean, fs, 1.5, 10);
  const bad = clean.map((v, i) => Math.abs(i / fs - 1.5) < 0.12 ? v + 2.5 * gauss() : v);
  const fitOf = arr => { const r = OT.analyze(toSamples(fs, arr)); const e = r.events.reduce((p, c) => Math.abs(c.dx) > Math.abs(p.dx) ? c : p); return OT.fitEvent(r, e, 'h'); };
  const fc = fitOf(clean), fb = fitOf(bad);
  check('quality: clean saccade kept (R² > 0.98)', fc.ok && fc.r2 > 0.98, fc.r2.toFixed(3));
  check('quality: noisy saccade rejected', !fb || !fb.ok, fb ? fb.r2.toFixed(3) : 'no fit');
}

// ---------- per-person calibration ----------
{
  // A person whose eyes read 0.8x horizontally and 1.15x vertically on the population scale.
  const fs = 60, T0 = 0.8, plan = OT.makePlan('gaze', 15), N = Math.ceil((T0 + plan.duration + 0.5) * fs);
  const x = new Array(N).fill(0), y = new Array(N).fill(0); let target = { x: 0, y: 0 };
  plan.steps.forEach(st => { addSaccade(x, fs, T0 + st.t + 0.2, 0.8 * (st.goal.x - target.x)); addSaccade(y, fs, T0 + st.t + 0.2, 1.15 * (st.goal.y - target.y)); target = st.goal; });
  const smp = toSamples(fs, x, y);
  const out = run('gaze', smp, plan, T0);
  check('calibration: horizontal gain 0.80', within(out.calibration.h, 0.77, 0.83), out.calibration.h.toFixed(3));
  check('calibration: vertical gain 1.15', within(out.calibration.v, 1.11, 1.19), out.calibration.v.toFixed(3));
  const again = run('gaze', OT.applyCalibration(smp, out.calibration), plan, T0);
  check('calibration: applied, position gains return to 1', within(again.calibration.h, 0.98, 1.02) && within(again.calibration.v, 0.98, 1.02), `${again.calibration.h.toFixed(3)}, ${again.calibration.v.toFixed(3)}`);
  check('calibration: identity leaves samples untouched', OT.applyCalibration(smp, { h: 1, v: 1 }) === smp, 'same array');
}

// ---------- antisaccades ----------
{
  const fs = 60, T0 = 2.0, plan = OT.makePlan('anti', 10), N = Math.ceil((T0 + plan.duration + 1) * fs);
  const x = new Array(N).fill(0);
  const errTrials = new Set([1, 4, 8]);
  let cue = 0;
  plan.steps.forEach((st, k) => {
    if (st.kind === 'cue') {
      const c = st.show.x;
      if (errTrials.has(cue)) { addSaccade(x, fs, T0 + st.t + 0.18, c); addSaccade(x, fs, T0 + st.t + 0.45, -2 * c); }
      else addSaccade(x, fs, T0 + st.t + 0.3, -c);
      cue++;
    } else if (k > 0) {
      // back to center from wherever the eye ended
      const prevCue = plan.steps[k - 1].show.x;
      addSaccade(x, fs, T0 + st.t + 0.25, prevCue);
    }
  });
  const out = run('anti', toSamples(fs, x), plan, T0);
  const nCue = plan.steps.filter(s => s.kind === 'cue').length;
  check('antisaccade error rate 3 of 12', Math.abs(val(out, 'errorRate') - 100 * 3 / nCue) < 0.01, val(out, 'errorRate').toFixed(1));
  check('all three errors corrected', /3 corrected/.test(out.measures[0].basis), out.measures[0].basis);
  check('correct antisaccade latency 300 ms', within(val(out, 'latency'), 283, 317), val(out, 'latency').toFixed(0));
}

// ---------- smooth pursuit ----------
{
  const fs = 60, T0 = 0.9, plan = OT.makePlan('pursuit', 10), N = Math.ceil((T0 + plan.duration + 0.5) * fs);
  const w = 2 * Math.PI * plan.pursuitHz, G = 0.8, lag = 0.06;
  const x = [];
  for (let i = 0; i < N; i++) { const t = i / fs - T0; x.push(t < 0 ? 0 : G * plan.amp * Math.sin(w * (t - lag))); }
  // a few catch-up saccades
  for (const tc of [4, 7.5, 11, 14.5]) addSaccade(x, fs, T0 + tc, 1.2);
  const out = run('pursuit', toSamples(fs, x), plan, T0);
  check('pursuit velocity gain 0.8 +-0.05', within(val(out, 'gain'), 0.75, 0.85), val(out, 'gain').toFixed(3));
  check('pursuit lag 60 ms +-20', within(val(out, 'lag'), 40, 80), val(out, 'lag').toFixed(0));
  const nCatch = Math.round(val(out, 'catchUp') * (plan.duration - plan.segments[0].t0));
  check('all 4 catch-up saccades found', nCatch === 4, nCatch);
  const noSync = run('pursuit', toSamples(fs, x), plan, null);
  check('pursuit gain without a start time', within(val(noSync, 'gain'), 0.72, 0.88), val(noSync, 'gain').toFixed(3));
}

// ---------- optokinetic ----------
{
  const fs = 60, T0 = 1.1, plan = OT.makePlan('okn'), N = Math.ceil((T0 + plan.duration + 0.5) * fs);
  const x = new Array(N).fill(0);
  // Rightward stripes: slow phases right at 12 deg/s; leftward stripes: slow phases left at 16 deg/s.
  const seg = [[0, 15, 12], [18, 33, -16]];
  for (let i = 1; i < N; i++) {
    const t = i / fs - T0;
    const s = seg.find(([a, b]) => t >= a && t < b);
    x[i] = x[i - 1] + (s ? s[2] / fs : -x[i - 1] * 0.05);
  }
  for (const [a, b, v] of seg) for (let t = a + 0.35; t < b; t += 0.35) {
    const i = Math.round((T0 + t) * fs); addSaccade(x, fs, T0 + t, -(x[i] - 0) * 0.9);
  }
  const out = run('okn', toSamples(fs, x), plan, T0);
  check('OKN rightward SPV 12 deg/s +-10%', within(val(out, 'spvR'), 10.8, 13.2), val(out, 'spvR').toFixed(2));
  check('OKN leftward SPV 16 deg/s +-10%', within(val(out, 'spvL'), 14.4, 17.6), val(out, 'spvL').toFixed(2));
  check('OKN asymmetry -14% +-5', within(val(out, 'asym'), -19, -9), val(out, 'asym').toFixed(1));
}

// ---------- gaze holding ----------
{
  const fs = 60, T0 = 0.8, plan = OT.makePlan('gaze', 15), N = Math.ceil((T0 + plan.duration + 0.5) * fs);
  const x = new Array(N).fill(0), y = new Array(N).fill(0);
  let target = { x: 0, y: 0 };
  plan.steps.forEach(st => {
    addSaccade(x, fs, T0 + st.t + 0.2, st.goal.x - target.x); addSaccade(y, fs, T0 + st.t + 0.2, st.goal.y - target.y); target = st.goal;
  });
  // Gaze evoked nystagmus in right and left gaze: drift toward center at 4 deg/s, reset every 0.5 s.
  for (const st of plan.steps.filter(s => s.kind === 'ecc' && s.goal.x !== 0)) {
    const dir = Math.sign(st.goal.x);
    for (let t = st.t + 0.5; t < st.t + 10; t += 0.5) {
      const i0 = Math.round((T0 + t) * fs), i1 = Math.round((T0 + t + 0.47) * fs);
      for (let i = i0; i < x.length; i++) x[i] += -dir * 4 * (Math.min(i, i1) - i0) / fs;
      addSaccade(x, fs, T0 + t + 0.47, dir * 4 * 0.47);
    }
  }
  const out = run('gaze', toSamples(fs, x, y), plan, T0);
  const right = out.trials.find(r => r[0] === 'Right gaze'), up = out.trials.find(r => r[0] === 'Up gaze');
  check('right gaze: right-beating nystagmus', right[3] === 'Right-beating', right[3]);
  check('right gaze: drift toward center 4 deg/s +-15%', within(+right[2], 3.4, 4.6), right[2]);
  check('up gaze: no nystagmus', up[3] === 'None', up[3]);
  check('eye position gain near 1', within(val(out, 'posGain'), 0.9, 1.1), val(out, 'posGain').toFixed(3));
}

// ---------- fixation ----------
{
  const fs = 60, T0 = 0.5, plan = OT.makePlan('fixation'), N = Math.ceil((T0 + plan.duration + 0.5) * fs);
  const x = new Array(N).fill(0);
  for (const t of [2, 5, 8, 11]) { addSaccade(x, fs, T0 + t, 1.2); addSaccade(x, fs, T0 + t + 0.25, -1.2); }
  const out = run('fixation', toSamples(fs, x), plan, T0);
  check('fixation: 4 square wave jerks in 14.5 s', within(val(out, 'swjPerMin'), 16, 17.2), val(out, 'swjPerMin').toFixed(1));
  check('fixation: BCEA reported', val(out, 'bcea') > 0, val(out, 'bcea').toFixed(3));
}

// ---------- positional ----------
{
  const fs = 30, T0 = 1.5, plan = OT.makePlan('positional'), N = Math.ceil((T0 + plan.duration + 0.5) * fs);
  const x = new Array(N).fill(0), y = new Array(N).fill(0);
  const dh = plan.segments.find(s => s.label === 'Dix-Hallpike right');
  // Upbeat nystagmus starting 7 s after the move begins, SPV 10 deg/s decaying with a 6 s time constant, for 15 s.
  const start = dh.t0 + 7, stop = start + 15;
  let t = start;
  while (t < stop) {
    const spv = 10 * Math.exp(-(t - start) / 6), seg = 0.33;
    const i0 = Math.round((T0 + t) * fs), i1 = Math.round((T0 + t + seg) * fs);
    for (let i = i0; i < y.length; i++) y[i] += -spv * (Math.min(i, i1) - i0) / fs;
    addSaccade(y, fs, T0 + t + seg, spv * seg);
    t += seg + 0.05;
  }
  const out = run('positional', toSamples(fs, x, y, 0.03), plan, T0);
  const row = out.trials.find(r => r[0] === 'Dix-Hallpike right'), other = out.trials.find(r => r[0] === 'Supine roll left');
  check('Dix-Hallpike right: upbeat', /Upbeat/.test(row[1]), row[1]);
  check('Dix-Hallpike right: onset 7 s +-1', within(+row[2], 6, 8), row[2]);
  check('Dix-Hallpike right: peak SPV near 10 deg/s', within(+row[4], 7, 11), row[4]);
  check('Dix-Hallpike right: fades (time to half peak 2-7 s)', within(+row[5], 2, 7), row[5]);
  check('supine roll left: none', other[1] === 'None', other[1]);
}

// ---------- binocular (internuclear ophthalmoplegia) ----------
{
  const fs = 240, N = 12 * fs;
  const right = new Array(N).fill(0), left = new Array(N).fill(0);
  let pos = 0;
  for (let k = 0; k < 10; k++) {
    const t = 0.6 + k * 1.1, amp = pos === 0 ? 10 : -10;
    addSaccade(right, fs, t, amp);
    addSaccade(left, fs, t, amp, amp > 0 ? 1 / 0.6 : 1); // left eye adducts slowly on rightward saccades
    pos += amp;
  }
  const samples = toSamples(fs, right, null, 0.02, left);
  const res = OT.analyze(samples);
  const b = OT.binocularMeasures(samples, res, 'a');
  const r = b.find(m => m.key === 'inoR').value, l = b.find(m => m.key === 'inoL').value;
  check('INO: adducting/abducting rightward 0.6 +-0.08', within(r, 0.52, 0.68), r.toFixed(3));
  check('INO: leftward near 1', within(l, 0.9, 1.1), l.toFixed(3));
}

// ---------- start beep ----------
function beepPcm(rate, F, t0, extra) {
  const n = Math.round(rate * (t0 + 3 * F)), pcm = new Float32Array(n);
  for (let i = 0; i < n; i++) pcm[i] = 0.05 * gauss() + 0.04 * Math.sin(2 * Math.PI * 180 * i / rate) * Math.sin(2 * Math.PI * 3 * i / rate);
  const tone = (at, f, dur, a) => { for (let i = Math.round(at * rate); i < Math.min(n, Math.round((at + dur) * rate)); i++) pcm[i] += a * Math.sin(2 * Math.PI * f * (i / rate - at)); };
  for (const e of extra) tone(e, 1000 / F, 0.15 * F, 0.3);
  for (let k = 0; k < 3; k++) tone(t0 - (2 - k) * OT.SYNC.gap * F, OT.SYNC.freq / F, OT.SYNC.dur * F, 0.25);
  return pcm;
}
{
  const t0 = 2.37, pcm = beepPcm(44100, 1, t0, [0.5, 1.0]);
  const r = OT.findStartBeep(pcm, 44100);
  check('start beep found within 5 ms', r && Math.abs(r.t0 - t0) < 0.005, r ? r.t0.toFixed(4) : 'none');
  const quiet = beepPcm(44100, 1, 1, []).map((v, i) => i > 30000 ? 0.05 * gauss() : v);
  check('no false start beep in noise', !OT.findStartBeep(new Float32Array(44100 * 3).map(() => 0.05 * gauss()), 44100), 'none expected');
  void quiet;
  const slow = beepPcm(48000, 8, 6.1, [1.0]);
  const rs = OT.findStartBeep(slow, 48000, { slowFactor: 8 });
  check('start beep in 8x slow motion audio within 40 ms', rs && Math.abs(rs.t0 - 6.1) < 0.04, rs ? rs.t0.toFixed(3) : 'none');
}

// ---------- plans ----------
{
  const p = OT.makePlan('anti', 10);
  const cue = p.steps.find(s => s.kind === 'cue');
  check('antisaccade goal mirrors the cue', cue.goal.x === -cue.show.x, `${cue.show.x} -> ${cue.goal.x}`);
  check('plans are deterministic', JSON.stringify(OT.makePlan('sacH', 10).steps) === JSON.stringify(OT.makePlan('sacH', 10).steps), 'same');
  check('algorithm version recorded', /^\d+\.\d+\.\d+$/.test(OT.ALGO_VERSION), OT.ALGO_VERSION);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
