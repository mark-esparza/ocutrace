const OT = require('../src/core.js');

let failures = 0;
function check(name, ok, got) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (got ${got})`);
  if (!ok) failures++;
}
const within = (x, lo, hi) => Number.isFinite(x) && x >= lo && x <= hi;

// Seeded pixel noise so every run renders the same clip (override with SEED=n).
let seed = Number(process.env.SEED) || 12345;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

const VW = 360, VH = 240, R = 24, CX = 180, CY = 120;
function renderFrame(hDeg, vDeg, blink) {
  const img = new Float32Array(VW * VH);
  const ix = CX - OT.degToPx(hDeg, R), iy = CY - OT.degToPx(vDeg, R);
  const SS = 3;
  for (let y = 0; y < VH; y++) for (let x = 0; x < VW; x++) {
    let acc = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const px = x + (sx + 0.5) / SS, py = y + (sy + 0.5) / SS;
      let v = 160; // skin
      const ex = (px - CX) / 68, ey = (py - CY) / 30;
      const inLens = ex * ex + ey * ey <= 1;
      if (inLens && !blink) {
        v = 228;
        const d = Math.hypot(px - ix, py - iy);
        if (d <= R) v = 72;
        if (d <= 9) v = 18;
      }
      acc += v;
    }
    img[y * VW + x] = acc / (SS * SS) + (rand() - 0.5) * 6;
  }
  return img;
}
function crop(img, sx, sy, side, N) {
  const g = new Float32Array(N * N), s = side / N;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const fx = sx + (x + 0.5) * s - 0.5, fy = sy + (y + 0.5) * s - 0.5;
    const x0 = Math.max(0, Math.min(VW - 2, Math.floor(fx))), y0 = Math.max(0, Math.min(VH - 2, Math.floor(fy)));
    const ax = Math.min(1, Math.max(0, fx - x0)), ay = Math.min(1, Math.max(0, fy - y0));
    const a = img[y0 * VW + x0], b = img[y0 * VW + x0 + 1], c = img[(y0 + 1) * VW + x0], d = img[(y0 + 1) * VW + x0 + 1];
    g[y * N + x] = (a * (1 - ax) + b * ax) * (1 - ay) + (c * (1 - ax) + d * ax) * ay;
  }
  return g;
}

const N = 120, fs = 60;
const wave = OT.syntheticWave(fs, 6);
// Setup: tap near the iris, estimate radius on a wide crop.
const f0 = renderFrame(wave[0].h, wave[0].v, false);
const tapX = CX + 3, tapY = CY - 2;
const wide = Math.round(0.3 * Math.min(VW, VH)) * 2; // 144 px
const ws = N / wide;
const est = OT.estimateRadius(crop(f0, tapX - wide / 2, tapY - wide / 2, wide, N), N, N / 2 - 0.5, N / 2 - 0.5, 3, 45);
let r = est.r / ws;
let cx = tapX - wide / 2 + (est.x + 0.5) / ws, cy = tapY - wide / 2 + (est.y + 0.5) / ws;
console.log('radius est (video px):', r.toFixed(2), 'true', R, 'center', cx.toFixed(1), cy.toFixed(1));

let refScore = null;
const samples = [];
const truth = [];
const t0 = Date.now();
for (const w of wave) {
  const img = renderFrame(w.h, w.v, w.blink);
  const side = 6 * r;
  let sx = Math.max(0, Math.min(VW - side, cx - side / 2)), sy = Math.max(0, Math.min(VH - side, cy - side / 2));
  const g = crop(img, sx, sy, side, N);
  const s = N / side;
  const loc = OT.locateIris(g, N, (cx - sx) * s - 0.5, (cy - sy) * s - 0.5, r * s);
  if (refScore === null) refScore = loc.score;
  const conf = loc.score / refScore;
  const nx = sx + (loc.x + 0.5) / s, ny = sy + (loc.y + 0.5) / s;
  const jump = Math.hypot(nx - cx, ny - cy);
  const ok = conf >= 0.45 && jump <= 1.5 * r;
  if (ok) { cx = nx; cy = ny; }
  samples.push({ t: w.t, x: ok ? OT.pxToDeg(-(nx - CX), r) : NaN, y: ok ? OT.pxToDeg(-(ny - CY), r) : NaN, ok });
  truth.push(w);
}
console.log('tracking ms/frame', ((Date.now() - t0) / wave.length).toFixed(1));
let err = [];
samples.forEach((s, i) => { if (s.ok && !truth[i].blink) err.push(Math.abs(s.x - truth[i].h)); });
console.log('median abs H error (deg, before centering):', OT.median(err).toFixed(3), 'max', Math.max(...err).toFixed(3));
const blinkFlagged = samples.filter((s, i) => truth[i].blink && !s.ok).length;
console.log('blink samples flagged invalid:', blinkFlagged, '/', truth.filter(t => t.blink).length);

const res = OT.analyze(samples);
console.log('fps', res.fps.toFixed(1), 'valid', (res.validPct * 100).toFixed(1) + '%', 'threshold', res.threshold.toFixed(1));
console.log('events', res.events.length, 'median peak vel', res.medianPeakVel.toFixed(1));
console.log('H:', res.h.direction, 'present', res.h.present, 'fast', res.h.fastCount, 'SPV', res.h.medSpv.toFixed(2), 'beatHz', res.h.beatHz.toFixed(2), 'cons', res.h.consistency.toFixed(2), res.h.slowConsistency.toFixed(2));
console.log('V:', res.v.direction, 'present', res.v.present, 'fast', res.v.fastCount, 'SPV', res.v.medSpv.toFixed(2));
console.log('SWJ', res.swj, res.swjPerMin.toFixed(1));

// Square wave jerk check on a synthetic fixation trace.
const fx = [];
for (let i = 0; i < 600; i++) {
  const t = i / 60; let h = 0.05 * Math.sin(i);
  for (const t0 of [1, 3, 5.5, 8]) { if (t >= t0 + 0.02 && t < t0 + 0.27) h += 1.2; }
  fx.push({ t, x: h, y: 0.03 * Math.cos(i * 1.3), ok: true });
}
const r2 = OT.analyze(fx);
console.log('Fixation test: events', r2.events.length, 'SWJ', r2.swj, 'per min', r2.swjPerMin.toFixed(1), 'nyst present', r2.nyst.present);
console.log(samples.slice(0,8).map((s,i)=>`${s.x.toFixed(2)} vs ${truth[i].h.toFixed(2)}`).join(' | '));
const diffs = samples.map((s,i)=> s.ok && !truth[i].blink ? s.x - truth[i].h : NaN).filter(Number.isFinite);
console.log('mean signed err', (diffs.reduce((a,b)=>a+b,0)/diffs.length).toFixed(3), 'sd', Math.sqrt(diffs.reduce((a,b)=>a+(b-diffs.reduce((p,q)=>p+q,0)/diffs.length)**2,0)/diffs.length).toFixed(3));

// Truth from OT.syntheticWave: right-beating, slow phase -6 deg/s, 2.5 beats/s, 15 beats of which one
// falls in the blink, no vertical nystagmus, one 150 ms blink. The fixation trace has 4 square wave jerks.
console.log('');
check('iris radius within 5% of true', within(r, 0.95 * R, 1.05 * R), r.toFixed(2));
check('median abs H error < 0.15 deg', OT.median(err) < 0.15, OT.median(err).toFixed(3));
const meanErr = diffs.reduce((a, b) => a + b, 0) / diffs.length;
check('mean signed H error within 0.1 deg', Math.abs(meanErr) < 0.1, meanErr.toFixed(3));
check('every blink frame flagged invalid', blinkFlagged === truth.filter(t => t.blink).length, blinkFlagged);
check('no non-blink frame flagged invalid', samples.every((s, i) => s.ok || truth[i].blink), samples.filter((s, i) => !s.ok && !truth[i].blink).length);
check('horizontal nystagmus present', res.h.present === true, res.h.present);
check('direction is right-beating', res.h.direction === 'Right-beating', res.h.direction);
check('13-15 fast phases', within(res.h.fastCount, 13, 15), res.h.fastCount);
check('slow phase velocity -6 deg/s +-10%', within(res.h.medSpv, -6.6, -5.4), res.h.medSpv.toFixed(2));
check('beat frequency 2.5 Hz +-0.3', within(res.h.beatHz, 2.2, 2.8), res.h.beatHz.toFixed(2));
check('no vertical nystagmus', res.v.present === false, res.v.present);
check('nystagmus not counted as square wave jerks', res.swj === 0, res.swj);
check('fixation: 4 square wave jerks', r2.swj === 4, r2.swj);
check('fixation: no nystagmus', r2.nyst.present === false, r2.nyst.present);

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
