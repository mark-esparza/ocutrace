// OcuTrace task battery: the stimulus plans shared by the Stimulus screen and the analysis,
// the start beep detector that lines a clip up with its plan, and the measures for each task.
// Pure functions, no DOM. Shared by the page and the Node tests.
// Copyright (c) 2026 Mark Esparza. Released under the MIT License; see LICENSE.

(function (OT) {
  // Bump when any measure below changes, so a study can lock one version.
  const ALGO_VERSION = '0.3.0';

  // ---------- plans ----------
  // Positions are degrees of visual angle, x toward the subject's right, y up. Plan time 0 is the
  // third start beep. Each step says what is drawn (show) and where the eyes should go (goal).
  const SYNC = { freq: 2000, gap: 0.3, dur: 0.08, count: 3 };
  const PURSUIT_HZ = 0.4;
  const OKN_SPEED = 20; // deg/s
  const TASKS = {
    free: { name: 'Free recording', timed: false, amp: 0 },
    fixation: { name: 'Fixation', timed: true, amp: 0 },
    gaze: { name: 'Gaze holding', timed: true, amp: 15, ampV: 10 },
    sacH: { name: 'Prosaccades, horizontal', timed: true, amp: 10 },
    sacV: { name: 'Prosaccades, vertical', timed: true, amp: 8 },
    anti: { name: 'Antisaccades', timed: true, amp: 10 },
    pursuit: { name: 'Smooth pursuit, 0.4 Hz', timed: true, amp: 10 },
    okn: { name: 'Optokinetic, both directions', timed: true, amp: 0 },
    positional: { name: 'Positional (Dix-Hallpike and supine roll)', timed: true, amp: 0 },
  };
  function rng(seed) { let s = seed; return () => (s = (s * 16807) % 2147483647) / 2147483647; }
  const pt = (x, y) => ({ x, y });

  // amp is the horizontal target eccentricity; ampV (gaze holding only) the vertical one.
  function makePlan(task, amp, ampV) {
    const def = TASKS[task] || TASKS.free;
    amp = amp > 0 ? amp : def.amp;
    ampV = def.ampV ? (ampV > 0 ? ampV : Math.min(amp, def.ampV)) : amp;
    const steps = [];   // {t, show: {kind, x, y, dir}, goal: {x, y}|null, label, kind}
    const segments = []; // windows the measures read: {t0, t1, kind, ...}
    let duration = 0;
    const add = (t, show, goal, label, kind) => steps.push({ t, show, goal, label, kind });
    const dot = (x, y) => ({ kind: 'dot', x, y });
    if (task === 'fixation') {
      duration = 15; add(0, dot(0, 0), pt(0, 0), 'Look at the dot', 'fix');
      segments.push({ t0: 0.5, t1: 15, kind: 'fixation' });
    } else if (task === 'gaze') {
      const seq = [[0, 0, 3, 'Center'], [1, 0, 10, 'Right gaze'], [0, 0, 3, 'Center'], [-1, 0, 10, 'Left gaze'], [0, 0, 3, 'Center'],
        [0, 1, 10, 'Up gaze'], [0, 0, 3, 'Center'], [0, -1, 10, 'Down gaze'], [0, 0, 3, 'Center']];
      let t = 0;
      for (const [sx, sy, len, label] of seq) {
        const x = sx * amp, y = sy * ampV;
        add(t, dot(x, y), pt(x, y), label, sx || sy ? 'ecc' : 'center');
        segments.push({ t0: t + 1, t1: t + len, kind: sx || sy ? 'ecc' : 'center', label, x, y });
        t += len;
      }
      duration = t;
    } else if (task === 'sacH' || task === 'sacV') {
      const r = rng(11), vert = task === 'sacV';
      let t = 0, side = 0;
      add(0, dot(0, 0), pt(0, 0), 'Jump to the dot', 'center');
      t = 1.5;
      while (t < 30) {
        side = side === 0 ? (r() < 0.5 ? 1 : -1) : 0;
        const x = vert ? 0 : side * amp, y = vert ? side * amp : 0;
        add(t, dot(x, y), pt(x, y), 'Jump to the dot', side ? 'out' : 'back');
        t += 1 + r();
      }
      duration = t;
    } else if (task === 'anti') {
      const r = rng(23);
      let t = 0;
      for (let k = 0; k < 12; k++) {
        add(t, { kind: 'cross', x: 0, y: 0 }, pt(0, 0), 'Look at the cross', 'fix');
        t += 1 + 0.5 * r();
        const side = r() < 0.5 ? 1 : -1;
        add(t, dot(side * amp, 0), pt(-side * amp, 0), 'Look away from the dot', 'cue');
        t += 1.2;
      }
      add(t, { kind: 'cross', x: 0, y: 0 }, pt(0, 0), 'Look at the cross', 'fix');
      duration = t + 1;
    } else if (task === 'pursuit') {
      duration = 20;
      add(0, { kind: 'pursuit', x: 0, y: 0 }, null, 'Follow the dot', 'pursuit');
      segments.push({ t0: 1 / PURSUIT_HZ, t1: duration, kind: 'pursuit' });
    } else if (task === 'okn') {
      add(0, { kind: 'stripes', dir: 1 }, null, 'Stripes moving right', 'okn');
      add(15, { kind: 'blank' }, null, 'Rest', 'rest');
      add(18, { kind: 'stripes', dir: -1 }, null, 'Stripes moving left', 'okn');
      duration = 33;
      segments.push({ t0: 2, t1: 15, kind: 'okn', dir: 1, label: 'Stripes moving right' });
      segments.push({ t0: 20, t1: 33, kind: 'okn', dir: -1, label: 'Stripes moving left' });
    } else if (task === 'positional') {
      // Examiner-led. Each provoking position: a few seconds to move, then an observation window.
      const seq = [
        ['Seated, eyes open, look straight ahead', 6, null],
        ['Dix-Hallpike right: turn the head 45° right, lie back with the head hanging', 5, 'Dix-Hallpike right'],
        ['Hold. Keep the eyes open', 30, 'obs'],
        ['Sit up slowly', 12, null],
        ['Dix-Hallpike left: turn the head 45° left, lie back with the head hanging', 5, 'Dix-Hallpike left'],
        ['Hold. Keep the eyes open', 30, 'obs'],
        ['Sit up, then lie flat on the back, head centered', 12, null],
        ['Supine roll right: turn the head 90° to the right', 3, 'Supine roll right'],
        ['Hold. Keep the eyes open', 30, 'obs'],
        ['Head back to center', 10, null],
        ['Supine roll left: turn the head 90° to the left', 3, 'Supine roll left'],
        ['Hold. Keep the eyes open', 30, 'obs'],
        ['Head back to center, then sit up', 5, null],
      ];
      let t = 0, cur = null;
      for (const [label, len, tag] of seq) {
        add(t, { kind: 'text', text: label }, null, label, tag === 'obs' ? 'observe' : tag ? 'move' : 'rest');
        if (tag && tag !== 'obs') cur = { t0: t, label: tag, kind: 'positional' };
        else if (tag === 'obs' && cur) { cur.moveEnd = t; cur.t1 = t + len; segments.push(cur); cur = null; }
        t += len;
      }
      duration = t;
    }
    const plan = { task, name: def.name, amp, ampV, duration, steps, segments, pursuitHz: PURSUIT_HZ, oknSpeed: OKN_SPEED };
    plan.stepAt = t => { let s = steps[0] || null; for (const st of steps) { if (st.t <= t) s = st; else break; } return s; };
    plan.goal = t => {
      if (t < 0 || t > duration) return null;
      if (task === 'pursuit') return pt(amp * Math.sin(2 * Math.PI * PURSUIT_HZ * t), 0);
      const s = plan.stepAt(t); return s ? s.goal : null;
    };
    plan.show = t => {
      const s = plan.stepAt(Math.max(0, t)); if (!s) return { kind: 'blank', label: '' };
      const sh = { ...s.show, label: s.label };
      if (sh.kind === 'pursuit') { sh.kind = 'dot'; sh.x = t < 0 ? 0 : amp * Math.sin(2 * Math.PI * PURSUIT_HZ * t); }
      return sh;
    };
    return plan;
  }

  // ---------- start beep ----------
  // The stimulus plays three short tones at SYNC.freq, SYNC.gap apart; plan time 0 is the third.
  // slowFactor stretches the pattern for slow motion clips whose audio was slowed with the video.
  function findStartBeep(pcm, rate, opts = {}) {
    const F = opts.slowFactor || 1;
    const freq = SYNC.freq / F, gap = SYNC.gap * F, beepDur = SYNC.dur * F;
    const win = Math.max(32, Math.round(rate * 0.004 * F)), hop = Math.max(8, win >> 1);
    if (freq >= rate / 2 || pcm.length < win * 4) return null;
    const w = 2 * Math.cos(2 * Math.PI * freq / rate);
    const nWin = Math.floor((pcm.length - win) / hop) + 1;
    const ratio = new Float32Array(nWin), power = new Float32Array(nWin);
    for (let k = 0; k < nWin; k++) {
      let s1 = 0, s2 = 0, e = 0;
      const o = k * hop;
      for (let i = 0; i < win; i++) { const v = pcm[o + i]; const s0 = v + w * s1 - s2; s2 = s1; s1 = s0; e += v * v; }
      const p = s1 * s1 + s2 * s2 - w * s1 * s2;
      power[k] = p; ratio[k] = e > 0 ? p / (e * win / 2) : 0;
    }
    const sorted = Array.from(power).sort((a, b) => a - b);
    const floor = sorted[Math.floor(sorted.length * 0.5)] || 0;
    const peak = sorted[sorted.length - 1] || 0;
    if (!(peak > 0)) return null;
    const on = new Uint8Array(nWin);
    for (let k = 0; k < nWin; k++) on[k] = ratio[k] > 0.35 && power[k] > Math.max(floor * 30, peak * 0.02) ? 1 : 0;
    // Onsets of tone runs at least half a beep long.
    const minRun = Math.max(1, Math.floor(0.5 * beepDur * rate / hop));
    const onsets = [];
    for (let k = 0; k < nWin; k++) {
      if (!on[k] || (k > 0 && on[k - 1])) continue;
      let j = k; while (j + 1 < nWin && on[j + 1]) j++;
      if (j - k + 1 >= minRun) {
        // Refine to the first sample whose window power reaches half the run's peak.
        let pk = 0; for (let q = k; q <= j; q++) pk = Math.max(pk, power[q]);
        let q = k; while (q > 0 && power[q - 1] > pk * 0.25) q--;
        onsets.push({ t: (q * hop + win / 2) / rate, strength: pk });
      }
      k = j;
    }
    const tol = Math.max(0.03, 0.12 * gap);
    for (let a = 0; a < onsets.length; a++) {
      const b = onsets.find(o => Math.abs(o.t - onsets[a].t - gap) <= tol);
      if (!b) continue;
      const c = onsets.find(o => Math.abs(o.t - b.t - gap) <= tol);
      if (!c) continue;
      return { t0: c.t, first: onsets[a].t, onsets: onsets.length };
    }
    return null;
  }

  // ---------- helpers ----------
  const median = OT.median;
  const mean = a => { const b = a.filter(Number.isFinite); return b.length ? b.reduce((p, q) => p + q, 0) / b.length : NaN; };
  const sd = a => { const b = a.filter(Number.isFinite), m = mean(b); return b.length > 1 ? Math.sqrt(b.reduce((p, q) => p + (q - m) ** 2, 0) / (b.length - 1)) : NaN; };
  function slice(samples, ta, tb) { return samples.filter(s => s.t >= ta && s.t <= tb); }
  function sub(samples, ta, tb, threshold) {
    const s = slice(samples, ta, tb);
    return s.length >= 10 ? OT.analyze(s, { minThreshold: threshold }) : null;
  }
  function m(key, label, value, unit, basis, extra) { return { key, label, value, unit: unit || '', basis: basis || '', ...extra }; }
  const NEEDS_START = 'Needs the task start time. Find the start beep or enter it.';

  // Saccade onset: walk back from the fastest sample to where speed falls to 20% of peak,
  // interpolating between samples.
  function onsetTime(res, e) {
    let k = e.i0, pk = e.i0;
    for (let i = e.i0; i <= e.i1; i++) if (res.sp[i] > res.sp[pk]) pk = i;
    const lo = Math.max(10, 0.2 * res.sp[pk]);
    k = pk;
    while (k > 1 && res.sp[k - 1] > lo && res.sp[k - 1] < res.sp[k] + 1e-9) k--;
    const a = res.sp[k - 1], b = res.sp[k];
    if (!(Number.isFinite(a) && Number.isFinite(b)) || b <= a) return res.t[k];
    const f = Math.max(0, Math.min(1, (lo - a) / (b - a)));
    return res.t[k - 1] + f * (res.t[k] - res.t[k - 1]);
  }

  // Saccade onset by curve fit (Lai et al., IEEE JBHI 2020): fit eye position across the saccade with
  // a + b·tanh((t − tc)/τ), take onset where the curve has covered 3% of its jump, and use the fit's
  // R² as the trial's quality score. At 60 fps a saccade spans two or three frames, so the fitted
  // curve places onset between frames, where interpolating speed samples cannot.
  const FIT_ONSET = Math.atanh(0.94);  // (tanh + 1)/2 = 0.03
  const FIT_MIN_R2 = 0.9;       // and residual error at most 10% of the saccade's size
  const FIT_MAX_NRMSE = 0.1;
  function fitSaccade(t, y, ta, tb) {
    const ts = [], ys = [];
    for (let i = 0; i < t.length; i++) if (t[i] >= ta && t[i] <= tb && Number.isFinite(y[i])) { ts.push(t[i]); ys.push(y[i]); }
    const n = ts.length;
    if (n < 6) return null;
    const my = ys.reduce((p, q) => p + q, 0) / n;
    let sst = 0; for (const v of ys) sst += (v - my) ** 2;
    if (!(sst > 0)) return null;
    // For fixed tc and τ the model is linear in a and b, so solve those exactly.
    const sse = (tc, tau) => {
      let su = 0, suu = 0, sy = 0, suy = 0;
      for (let i = 0; i < n; i++) { const u = Math.tanh((ts[i] - tc) / tau); su += u; suu += u * u; sy += ys[i]; suy += u * ys[i]; }
      const det = n * suu - su * su; if (Math.abs(det) < 1e-12) return { e: Infinity };
      const b = (n * suy - su * sy) / det, a = (sy - b * su) / n;
      let e = 0; for (let i = 0; i < n; i++) e += (ys[i] - a - b * Math.tanh((ts[i] - tc) / tau)) ** 2;
      return { e, a, b };
    };
    const tauMin = 0.003, tauMax = 0.06;
    let best = { e: Infinity };
    const dt = (ts[n - 1] - ts[0]) / (n - 1);
    for (let tau = tauMin; tau <= tauMax; tau *= 1.3) {
      for (let tc = ts[0]; tc <= ts[n - 1]; tc += dt / 4) {
        const f = sse(tc, tau); if (f.e < best.e) best = { ...f, tc, tau };
      }
    }
    if (!Number.isFinite(best.e)) return null;
    // Refine with shrinking coordinate steps.
    let stc = dt / 4, stau = best.tau * 0.15;
    for (let it = 0; it < 60 && (stc > 1e-5 || stau > 1e-5); it++) {
      let moved = false;
      for (const [dtc, dtau] of [[stc, 0], [-stc, 0], [0, stau], [0, -stau]]) {
        const tc = best.tc + dtc, tau = Math.min(tauMax, Math.max(tauMin, best.tau + dtau));
        const f = sse(tc, tau); if (f.e < best.e - 1e-15) { best = { ...f, tc, tau }; moved = true; }
      }
      if (!moved) { stc /= 2; stau /= 2; }
    }
    const r2 = 1 - best.e / sst;
    return { onset: best.tc - FIT_ONSET * best.tau, amp: 2 * best.b, tc: best.tc, tau: best.tau, r2, rmse: Math.sqrt(best.e / n), n,
      ok: r2 >= FIT_MIN_R2 && Math.sqrt(best.e / n) <= FIT_MAX_NRMSE * Math.abs(2 * best.b) && best.tau > tauMin && best.tau < tauMax };
  }
  // Fit window for one detected saccade: up to 120 ms either side, stopping short of neighbouring events.
  function fitEvent(res, e, axis) {
    const k = res.events.indexOf(e);
    const prev = res.events[k - 1], next = res.events[k + 1];
    const ta = Math.max(e.t - 0.12, prev ? prev.tEnd : -Infinity);
    const tb = Math.min(e.tEnd + 0.12, next ? next.t : Infinity);
    return fitSaccade(res.t, axis === 'v' ? res.y : res.x, ta, tb);
  }

  // Recording check (lighting, glasses glare, iris size, frame timing, tracking), so a poor clip is
  // flagged before its numbers are read. Brightness is mean grey level of the eye crop (0–255), a proxy
  // for room light: usable traces fall off sharply in dim rooms and with glasses.
  function recordingCheck(mm) {
    const items = [];
    const add = (key, label, status, value, advice) => items.push({ key, label, status, value, advice });
    if (Number.isFinite(mm.luma)) {
      add('light', 'Lighting', mm.luma < 50 ? 'fail' : mm.luma < 80 ? 'warn' : 'ok', `grey level ${mm.luma.toFixed(0)} of 255`,
        mm.luma < 80 ? 'Add light in front of the face; dim rooms cut the share of usable frames sharply.' : '');
    }
    if (Number.isFinite(mm.glare)) {
      add('glare', 'Reflections and glasses glare', mm.glare > 0.08 ? 'fail' : mm.glare > 0.03 ? 'warn' : 'ok', `${(100 * mm.glare).toFixed(1)}% of the eye region saturated`,
        mm.glare > 0.03 ? 'Tilt or remove glasses, or move the light so its reflection is off the eye.' : '');
    }
    if (Number.isFinite(mm.radius)) {
      add('size', 'Iris size in the picture', mm.radius < 10 ? 'fail' : mm.radius < 18 ? 'warn' : 'ok', `${mm.radius.toFixed(0)} px radius`,
        mm.radius < 18 ? 'Move the phone closer so the iris is at least 36 px across.' : '');
    }
    if (Number.isFinite(mm.contrast)) {
      add('contrast', 'Iris contrast', mm.contrast < 20 ? 'fail' : mm.contrast < 35 ? 'warn' : 'ok', `${mm.contrast.toFixed(0)} grey levels`,
        mm.contrast < 35 ? 'The iris edge is faint; light the face from the front and avoid backlight.' : '');
    }
    if (Number.isFinite(mm.validPct)) {
      add('tracked', 'Frames tracked', mm.validPct < 0.8 ? 'fail' : mm.validPct < 0.95 ? 'warn' : 'ok', `${(100 * mm.validPct).toFixed(0)}%`,
        mm.validPct < 0.95 ? 'Blinks, glare or the eye leaving the frame lost the iris; check the trace for gaps.' : '');
    }
    if (mm.dts && mm.dts.length > 10) {
      const d = mm.dts.filter(v => v > 0), med = median(d);
      const jitter = Math.sqrt(d.reduce((p, v) => p + (v - med) ** 2, 0) / d.length) / med;
      const dropped = d.filter(v => v > 1.5 * med).length / d.length;
      add('timing', 'Frame timing', jitter > 0.5 || dropped > 0.1 ? 'fail' : jitter > 0.25 || dropped > 0.03 ? 'warn' : 'ok',
        `${(1 / med).toFixed(0)} fps, ${(100 * dropped).toFixed(1)}% frames late, spread ${(100 * jitter).toFixed(0)}%`,
        jitter > 0.25 || dropped > 0.03 ? 'Uneven frame timing blurs latency and speed; close other apps and record at a fixed frame rate.' : '');
      if (mm.saccadic && 1 / med < 100) add('rate', 'Frame rate for saccades', 'warn', `${(1 / med).toFixed(0)} fps`, 'Peak saccade velocity reads low below about 240 fps; latency and gain are still usable.');
    }
    const worst = items.some(i => i.status === 'fail') ? 'fail' : items.some(i => i.status === 'warn') ? 'warn' : 'ok';
    return { items, status: worst };
  }

  // Per-person degree scale from gaze holding: measured eccentricity ÷ target eccentricity, horizontal and vertical.
  function applyCalibration(samples, cal) {
    if (!cal || !(cal.h > 0) || !(cal.v > 0) || (cal.h === 1 && cal.v === 1)) return samples;
    return samples.map(s => {
      const o = { ...s, x: s.x / cal.h, y: s.y / cal.v };
      if ('x2' in s) { o.x2 = s.x2 / cal.h; o.y2 = s.y2 / cal.v; }
      return o;
    });
  }

  // ---------- per task ----------
  function fixationMeasures(samples, res, plan, t0) {
    const r = t0 == null ? res : sub(samples, t0 + plan.segments[0].t0, t0 + plan.segments[0].t1, res.threshold) || res;
    const x = [], y = [];
    for (let i = 0; i < r.n; i++) if (r.ok[i]) { x.push(r.x[i]); y.push(r.y[i]); }
    const sx = sd(x), sy = sd(y), mx = mean(x), my = mean(y);
    let cov = 0; for (let i = 0; i < x.length; i++) cov += (x[i] - mx) * (y[i] - my);
    const rho = x.length > 1 && sx > 0 && sy > 0 ? cov / (x.length - 1) / (sx * sy) : 0;
    const bcea = 2 * Math.PI * 1.14 * sx * sy * Math.sqrt(Math.max(0, 1 - rho * rho)); // 68% area
    const slow = [...r.h.spv.map(s => Math.abs(s.v)), ...r.v.spv.map(s => Math.abs(s.v))];
    const where = t0 == null ? 'whole clip' : `${plan.segments[0].t0}–${plan.segments[0].t1} s of the task`;
    return {
      headline: r.nyst.present ? `${r.nyst.direction} nystagmus during fixation` : 'Fixation recorded',
      sub: `${r.swj} square wave jerks, ${r.swjPerMin.toFixed(0)} per minute. Drift ${fmtN(median(slow))}°/s.`,
      res: r,
      measures: [
        m('swjPerMin', 'Square wave jerks', r.swjPerMin, 'per min', `${r.swj} found, ${where}`),
        m('drift', 'Drift velocity', median(slow), '°/s', 'Median absolute slow velocity between saccades'),
        m('bcea', 'Fixation stability (BCEA 68%)', bcea, 'deg²', 'Bivariate contour ellipse area'),
        m('intrusions', 'Saccadic intrusions', r.events.length, '', 'All fast events during fixation', { digits: 0 }),
        m('nystagmus', 'Primary position nystagmus', r.nyst.present ? 1 : 0, '', r.nyst.present ? `${r.nyst.direction}, ${fmtN(Math.abs(r.nyst.medSpv))}°/s` : 'Not present', { text: r.nyst.present ? 'Present' : 'None' }),
      ],
    };
  }

  function gazeMeasures(samples, res, plan, t0) {
    if (t0 == null) return needsStart(res);
    const centers = plan.segments.filter(s => s.kind === 'center').map(s => meanPos(res, t0 + s.t0, t0 + s.t1));
    const cx = mean(centers.map(c => c.x)), cy = mean(centers.map(c => c.y));
    const trials = [], measures = [];
    const gains = [], gainsH = [], gainsV = [];
    let found = 0;
    for (const s of plan.segments.filter(s => s.kind === 'ecc')) {
      const r = sub(samples, t0 + s.t0, t0 + s.t1, res.threshold);
      const p = meanPos(res, t0 + s.t0, t0 + s.t1);
      const horiz = s.x !== 0, ecc = horiz ? s.x : s.y;
      const posGain = ((horiz ? p.x - cx : p.y - cy)) / ecc;
      gains.push(posGain); (horiz ? gainsH : gainsV).push(posGain);
      if (!r) { trials.push([s.label, '–', '–', '–', '–', 'Too few frames']); continue; }
      const a = horiz ? r.h : r.v;
      const centripetal = -Math.sign(ecc) * a.medSpv; // drift back toward center is positive
      const ny = r.nyst.present ? r.nyst : null;
      if (ny) found++;
      trials.push([s.label, fmtN(posGain, 2), fmtN(centripetal), ny ? ny.direction : 'None', ny ? fmtN(ny.beatHz) : '–', ny ? `${fmtN(Math.abs(ny.medSpv))}°/s slow phases` : '']);
      measures.push(m(`drift_${s.label}`, `${s.label}: drift toward center`, centripetal, '°/s', ny ? `${ny.direction} nystagmus, ${fmtN(ny.beatHz)} beats/s` : 'No nystagmus pattern'));
    }
    const calibration = { h: median(gainsH), v: median(gainsV) };
    measures.push(m('posGain', 'Eye position gain', median(gains), '', 'Median eye eccentricity ÷ target eccentricity, a per-person check of the degree scale'));
    measures.push(m('calH', 'Calibration, horizontal', calibration.h, '', 'Right and left gaze; can be applied to this person\'s other clips'));
    measures.push(m('calV', 'Calibration, vertical', calibration.v, '', 'Up and down gaze'));
    return {
      calibration,
      headline: found ? `Nystagmus in ${found} of 4 gaze positions` : 'No gaze evoked nystagmus pattern',
      sub: `Targets at ±${plan.amp}° horizontal and ±${plan.ampV}° vertical.`,
      measures, trialCols: ['Position', 'Position gain', 'Drift to center (°/s)', 'Nystagmus', 'Beats/s', 'Note'], trials,
    };
  }
  function meanPos(res, ta, tb) {
    const x = [], y = [];
    for (let i = 0; i < res.n; i++) if (res.ok[i] && res.t[i] >= ta && res.t[i] <= tb) { x.push(res.x[i]); y.push(res.y[i]); }
    return { x: median(x), y: median(y) };
  }

  function saccadeMeasures(samples, res, plan, t0) {
    const anti = plan.task === 'anti', vert = plan.task === 'sacV';
    const comp = e => vert ? e.dy : e.dx;
    if (t0 == null) {
      const big = res.events.filter(e => Math.abs(comp(e)) >= 2);
      return {
        headline: `${big.length} saccades found`,
        sub: 'Latency, gain and errors need the task start time.',
        measures: [
          m('peakVel', 'Median peak velocity', median(big.map(e => e.peakVel)), '°/s', `${big.length} saccades of 2° or more`),
          m('latency', 'Latency', NaN, 'ms', NEEDS_START),
          m('gain', 'Gain', NaN, '', NEEDS_START),
        ],
      };
    }
    const trials = [], lat = [], gain = [], pv = [], q = [];
    let errors = 0, corrected = 0, correct = 0, missed = 0, anticip = 0, rejected = 0;
    const axis = vert ? 'v' : 'h';
    plan.steps.forEach((st, k) => {
      if (k === 0) return;
      if (anti && st.kind !== 'cue') return;
      const prev = plan.steps[k - 1].goal;
      const want = vert ? st.goal.y - prev.y : st.goal.x - prev.x;
      const cue = vert ? st.show.y - prev.y : st.show.x - prev.x;
      const ts = t0 + st.t, next = plan.steps[k + 1] ? t0 + plan.steps[k + 1].t : ts + 1.5;
      const minAmp = Math.max(1, 0.2 * Math.abs(want));
      const evs = res.events.filter(e => e.t >= ts - 0.05 && e.t < Math.min(next, ts + 0.9) && Math.abs(comp(e)) >= minAmp);
      const label = anti ? (cue > 0 ? (vert ? 'Cue up' : 'Cue right') : (vert ? 'Cue down' : 'Cue left')) : `${want > 0 ? '+' : ''}${want.toFixed(0)}°`;
      if (!evs.length) { missed++; trials.push([fmtN(st.t, 2), label, 'No response', '–', '–', '–', '–']); return; }
      const e = evs[0], fit = fitEvent(res, e, axis);
      const r2 = fit ? fmtN(fit.r2, 2) : '–';
      if (!fit || !fit.ok) {
        rejected++;
        trials.push([fmtN(st.t, 2), label, 'Rejected, poor fit', '–', '–', fmtN(e.peakVel, 0), r2]);
        return;
      }
      q.push(fit.r2);
      const L = fit.onset - ts;
      if (L < 0.08) { anticip++; trials.push([fmtN(st.t, 2), label, 'Anticipatory', fmtN(L * 1000, 0), '–', fmtN(e.peakVel, 0), r2]); return; }
      const towardCue = Math.sign(comp(e)) === Math.sign(cue);
      if (anti && towardCue) {
        errors++;
        const fix = evs.slice(1).find(f => Math.sign(comp(f)) !== Math.sign(cue));
        if (fix) corrected++;
        trials.push([fmtN(st.t, 2), label, fix ? 'Error, corrected' : 'Error', fmtN(L * 1000, 0), '–', fmtN(e.peakVel, 0), r2]);
        return;
      }
      if (!anti && !towardCue) { missed++; trials.push([fmtN(st.t, 2), label, 'Wrong direction', fmtN(L * 1000, 0), '–', fmtN(e.peakVel, 0), r2]); return; }
      correct++;
      const g = fit.amp / want;
      lat.push(L * 1000); gain.push(g); pv.push(e.peakVel);
      trials.push([fmtN(st.t, 2), label, 'Correct', fmtN(L * 1000, 0), fmtN(g, 2), fmtN(e.peakVel, 0), r2]);
    });
    const measures = [
      m('latency', anti ? 'Latency, correct antisaccades' : 'Latency', median(lat), 'ms', `Median of ${lat.length} trials; onset where a fitted tanh curve covers 3% of the jump`),
      m('gain', 'Gain', median(gain), '', `Fitted saccade amplitude ÷ target step, target ${plan.amp}°`),
      m('peakVel', 'Peak velocity', median(pv), '°/s', 'Read low below 240 fps'),
    ];
    if (anti) {
      const n = errors + correct;
      measures.unshift(m('errorRate', 'Direction error rate', n ? 100 * errors / n : NaN, '%', `${errors} of ${n} trials looked toward the cue; ${corrected} corrected`));
    }
    measures.push(m('trials', 'Trials scored', correct + errors, '', `${missed} missed or wrong direction, ${anticip} anticipatory (under 80 ms), ${rejected} rejected for a poor curve fit (R² under ${FIT_MIN_R2} or error over 10% of the saccade)`, { digits: 0 }));
    measures.push(m('fitQuality', 'Median fit quality (R²)', median(q), '', 'Agreement of each saccade with the fitted curve; trials under the cutoff are left out'));
    return {
      headline: anti ? `Antisaccade errors ${measures[0].value.toFixed(0)}%` : `Saccade latency ${fmtN(median(lat), 0)} ms, gain ${fmtN(median(gain), 2)}`,
      sub: `${plan.name}, ${correct + errors} scored trials. Latency includes the stimulus screen's display delay.`,
      measures, trialCols: ['Time (s)', 'Target', 'Response', 'Latency (ms)', 'Gain', 'Peak (°/s)', 'Fit R²'], trials,
    };
  }

  function pursuitMeasures(samples, res, plan, t0) {
    const w = 2 * Math.PI * plan.pursuitHz;
    const ta = t0 == null ? res.t[0] + 1 : t0 + plan.segments[0].t0, tb = t0 == null ? res.t[res.n - 1] : t0 + plan.segments[0].t1;
    const inWin = i => res.t[i] >= ta && res.t[i] <= tb && Number.isFinite(res.vx[i]);
    // Fit eye velocity to a sin(wt) + b cos(wt) + c, leaving out saccades. Catch-up saccades hide under
    // the general speed threshold while the eye is moving, so find them on velocity minus the fit and refit.
    let mask = new Array(res.n).fill(false);
    for (const e of res.events) for (let i = Math.max(0, e.i0 - 2); i <= Math.min(res.n - 1, e.i1 + 2); i++) mask[i] = true;
    let sol = null, used = 0, catchUp = [];
    for (let pass = 0; pass < 3; pass++) {
      const S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], R = [0, 0, 0]; used = 0;
      for (let i = 0; i < res.n; i++) {
        if (!inWin(i) || mask[i]) continue;
        const f = [Math.sin(w * res.t[i]), Math.cos(w * res.t[i]), 1];
        for (let a = 0; a < 3; a++) { R[a] += f[a] * res.vx[i]; for (let b = 0; b < 3; b++) S[a][b] += f[a] * f[b]; }
        used++;
      }
      sol = solve3(S, R);
      if (!sol) break;
      const resid = res.vx.map((v, i) => inWin(i) ? v - (sol[0] * Math.sin(w * res.t[i]) + sol[1] * Math.cos(w * res.t[i]) + sol[2]) : NaN);
      const med = median(resid), mad = median(resid.map(v => Math.abs(v - med))) * 1.4826;
      const thr = Math.max(15, med + 5 * mad);
      mask = new Array(res.n).fill(false); catchUp = [];
      for (let i = 0; i < res.n; i++) {
        if (!(Math.abs(resid[i]) > thr)) continue;
        let j = i; while (j + 1 < res.n && Math.abs(resid[j + 1]) > thr) j++;
        let amp = 0; for (let k = i; k <= j + 1 && k < res.n; k++) if (Number.isFinite(resid[k])) amp += resid[k] * (res.t[Math.min(res.n - 1, k + 1)] - res.t[k]);
        if (Math.abs(amp) >= 0.3) catchUp.push({ t: res.t[i], amp });
        for (let k = Math.max(0, i - 2); k <= Math.min(res.n - 1, j + 2); k++) mask[k] = true;
        i = j;
      }
    }
    const eyeAmp = sol ? Math.hypot(sol[0], sol[1]) : NaN;
    const gainV = eyeAmp / (plan.amp * w);
    let lagMs = NaN;
    if (t0 != null && sol) {
      // Target velocity amp*w*cos(w(t - t0)): its phase is w*t0.
      const phEye = Math.atan2(sol[0], sol[1]); // eye velocity = A cos(wt - phEye)
      let d = phEye - w * t0; d = Math.atan2(Math.sin(d), Math.cos(d));
      lagMs = d / w * 1000;
    }
    const dur = tb - ta;
    return {
      headline: `Pursuit gain ${fmtN(gainV, 2)}`,
      sub: `${catchUp.length} catch-up saccades, ${fmtN(catchUp.length / dur, 1)} per second. Target ±${plan.amp}° at ${plan.pursuitHz} Hz.`,
      measures: [
        m('gain', 'Pursuit velocity gain', gainV, '', `Eye ÷ target velocity at ${plan.pursuitHz} Hz with saccades removed, ${used} samples`),
        m('lag', 'Eye lag behind target', lagMs, 'ms', t0 == null ? NEEDS_START : 'Phase of eye velocity relative to target velocity'),
        m('catchUp', 'Catch-up saccades', catchUp.length / dur, 'per s', `${catchUp.length} over ${fmtN(dur, 1)} s, found on velocity minus the smooth fit`),
      ],
    };
  }
  function solve3(A, b) {
    const M = A.map((r, i) => [...r, b[i]]);
    for (let c = 0; c < 3; c++) {
      let p = c; for (let r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      if (Math.abs(M[p][c]) < 1e-9) return null;
      [M[c], M[p]] = [M[p], M[c]];
      for (let r = 0; r < 3; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k < 4; k++) M[r][k] -= f * M[c][k]; }
    }
    return [M[0][3] / M[0][0], M[1][3] / M[1][1], M[2][3] / M[2][2]];
  }

  function oknMeasures(samples, res, plan, t0) {
    if (t0 == null) {
      const h = res.h;
      return {
        headline: h.present ? `${h.direction} optokinetic nystagmus` : 'No consistent optokinetic nystagmus',
        sub: 'Both directions are in one clip, so the asymmetry needs the task start time.',
        measures: [m('spv', 'Slow phase velocity, whole clip', Math.abs(h.medSpv), '°/s', `${h.fastCount} fast phases`), m('asym', 'Asymmetry', NaN, '%', NEEDS_START)],
      };
    }
    const out = {}, trials = [];
    for (const s of plan.segments) {
      const r = sub(samples, t0 + s.t0, t0 + s.t1, res.threshold);
      const spv = r ? r.h.medSpv : NaN; // follows the stripes: positive when stripes move right
      const withStripes = r ? Math.sign(spv) === s.dir : false;
      out[s.dir] = { spv: Math.abs(spv), gain: Math.abs(spv) / plan.oknSpeed, beat: r ? r.h.beatHz : NaN, ok: withStripes, fast: r ? r.h.fastCount : 0 };
      trials.push([s.label, fmtN(Math.abs(spv)), fmtN(Math.abs(spv) / plan.oknSpeed, 2), fmtN(r ? r.h.beatHz : NaN), withStripes ? 'Follows the stripes' : 'Does not follow']);
    }
    const R = out[1], L = out[-1];
    const asym = 100 * (R.spv - L.spv) / (R.spv + L.spv);
    return {
      headline: `Optokinetic gain ${fmtN(R.gain, 2)} rightward, ${fmtN(L.gain, 2)} leftward`,
      sub: `Stripes at ${plan.oknSpeed}°/s. Asymmetry ${fmtN(asym, 0)}% (positive means rightward slow phases are faster).`,
      measures: [
        m('spvR', 'Slow phase velocity, stripes right', R.spv, '°/s', `${R.fast} fast phases, ${fmtN(R.beat)} beats/s`),
        m('spvL', 'Slow phase velocity, stripes left', L.spv, '°/s', `${L.fast} fast phases, ${fmtN(L.beat)} beats/s`),
        m('gainR', 'Gain, stripes right', R.gain, '', `÷ ${plan.oknSpeed}°/s stripe speed`),
        m('gainL', 'Gain, stripes left', L.gain, '', `÷ ${plan.oknSpeed}°/s stripe speed`),
        m('asym', 'Asymmetry', asym, '%', '(right − left) ÷ (right + left)'),
      ],
      trialCols: ['Direction', 'SPV (°/s)', 'Gain', 'Beats/s', 'Note'], trials,
    };
  }

  // Nystagmus time course: 2 s windows every 0.5 s.
  function nystagmusCourse(samples, ta, tb, threshold) {
    const out = [];
    for (let a = ta; a + 2 <= tb + 1e-9; a += 0.5) {
      const r = sub(samples, a, a + 2, threshold);
      if (!r) { out.push({ t: a + 1, active: false }); continue; }
      const pick = ax => ax.fastCount >= 2 && ax.consistency >= 0.7 && Math.abs(ax.medSpv) >= 2 && Math.sign(ax.medSpv) !== Math.sign(ax.direction === 'Right-beating' || ax.direction === 'Upbeat' ? 1 : -1);
      const h = pick(r.h) ? r.h : null, v = pick(r.v) ? r.v : null;
      const best = h && v ? (Math.abs(h.medSpv) >= Math.abs(v.medSpv) ? h : v) : h || v;
      let first = NaN, last = NaN;
      if (best) {
        const sign = best.direction === 'Right-beating' || best.direction === 'Upbeat' ? 1 : -1;
        const fast = r.events.filter(e => Math.sign(best.axis === 'h' ? e.dx : e.dy) === sign && Math.abs(best.axis === 'h' ? e.dx : e.dy) >= 0.5);
        // A beat starts with its slow phase, so the first beat began about one beat period before its fast phase.
        if (fast.length) { first = Math.max(a, fast[0].t - 1 / Math.max(0.5, best.beatHz)); last = fast[fast.length - 1].tEnd; }
      }
      out.push({ t: a + 1, a, active: !!best, spv: best ? Math.abs(best.medSpv) : 0, dir: best ? best.direction : '', h: h && h.direction, v: v && v.direction, first, last });
    }
    return out;
  }
  function positionalMeasures(samples, res, plan, t0) {
    const segs = t0 == null ? [{ t0: res.t[0], t1: res.t[res.n - 1], moveEnd: res.t[0], label: 'Whole clip', abs: true }] : plan.segments;
    const trials = [], measures = [];
    let any = 0;
    for (const s of segs) {
      const ta = s.abs ? s.t0 : t0 + s.t0, tb = s.abs ? s.t1 : t0 + s.t1;
      const course = nystagmusCourse(samples, ta, tb, res.threshold);
      const act = course.filter(c => c.active);
      if (!act.length) { trials.push([s.label, 'None', '–', '–', '–', '–']); measures.push(m(`pos_${s.label}`, s.label, 0, '°/s', 'No nystagmus pattern', { text: 'None' })); continue; }
      any++;
      const peak = act.reduce((p, c) => c.spv > p.spv ? c : p, act[0]);
      const start = Number.isFinite(act[0].first) ? act[0].first : act[0].a;
      const end = Number.isFinite(act[act.length - 1].last) ? act[act.length - 1].last : act[act.length - 1].a + 2;
      const onset = start - ta, duration = end - start;
      const after = course.find(c => c.t > peak.t && c.spv < peak.spv / 2);
      const half = after ? after.t - peak.t : NaN;
      const hs = new Set(act.map(c => c.h).filter(Boolean)), vs = new Set(act.map(c => c.v).filter(Boolean));
      const dir = [...vs, ...hs].join(' + ') || peak.dir;
      trials.push([s.label, dir, fmtN(onset, 1), fmtN(duration, 1), fmtN(peak.spv), Number.isFinite(half) ? fmtN(half, 1) : 'Did not fade']);
      measures.push(m(`pos_${s.label}`, s.label, peak.spv, '°/s', `${dir}; onset ${fmtN(onset, 1)} s after the move began, lasted ${fmtN(duration, 1)} s`));
    }
    return {
      headline: any ? `Nystagmus in ${any} of ${segs.length} positions` : 'No positional nystagmus pattern',
      sub: 'Peak slow phase velocity per position. Torsion is not measured.',
      measures, trialCols: ['Position', 'Direction', 'Onset (s)', 'Duration (s)', 'Peak SPV (°/s)', 'Time to half peak (s)'], trials,
    };
  }

  function needsStart(res) {
    return { headline: 'Task start time needed', sub: NEEDS_START, measures: [m('start', 'Task start', NaN, '', NEEDS_START)] };
  }

  // Internuclear ophthalmoplegia: adducting ÷ abducting peak velocity for horizontal saccades.
  // eyes: which tracked eye is the subject's right ('a' is the first marked eye, 'b' the second).
  function binocularMeasures(samples, res, rightEye) {
    if (!samples.some(s => s.ok2)) return null;
    const n = res.n;
    const xa = samples.map(s => s.ok ? s.x : NaN), xb = samples.map(s => s.ok2 ? s.x2 : NaN), t = samples.map(s => s.t);
    const vel = (x, i) => (Number.isFinite(x[i - 1]) && Number.isFinite(x[i + 1])) ? (x[i + 1] - x[i - 1]) / (t[i + 1] - t[i - 1]) : NaN;
    const ratios = { 1: [], [-1]: [] };
    for (const e of res.events) {
      if (Math.abs(e.dx) < 2 || Math.abs(e.dx) < Math.abs(e.dy)) continue;
      const dir = Math.sign(e.dx);
      let pa = 0, pb = 0;
      for (let i = Math.max(1, e.i0 - 1); i <= Math.min(n - 2, e.i1 + 1); i++) {
        const va = vel(xa, i) * dir, vb = vel(xb, i) * dir;
        if (va > pa) pa = va; if (vb > pb) pb = vb;
      }
      if (!(pa > 0 && pb > 0)) continue;
      const right = rightEye === 'a' ? pa : pb, left = rightEye === 'a' ? pb : pa;
      // Rightward saccade: the right eye abducts and the left eye adducts.
      ratios[dir].push(dir > 0 ? left / right : right / left);
    }
    const all = [...ratios[1], ...ratios[-1]];
    return [
      m('inoR', 'Adducting ÷ abducting velocity, rightward saccades', median(ratios[1]), '', `${ratios[1].length} saccades; left eye adducts. 1.0 means equal speed`),
      m('inoL', 'Adducting ÷ abducting velocity, leftward saccades', median(ratios[-1]), '', `${ratios[-1].length} saccades; right eye adducts`),
      m('ino', 'Adducting ÷ abducting velocity, all', median(all), '', 'Read from 240 fps clips; 60 fps underestimates both eyes'),
    ];
  }

  function taskMeasures(task, samples, res, plan, t0, opts = {}) {
    let out;
    if (task === 'fixation') out = fixationMeasures(samples, res, plan, t0);
    else if (task === 'gaze') out = gazeMeasures(samples, res, plan, t0);
    else if (task === 'sacH' || task === 'sacV' || task === 'anti') out = saccadeMeasures(samples, res, plan, t0);
    else if (task === 'pursuit') out = pursuitMeasures(samples, res, plan, t0);
    else if (task === 'okn') out = oknMeasures(samples, res, plan, t0);
    else if (task === 'positional') out = positionalMeasures(samples, res, plan, t0);
    else out = null;
    const bino = binocularMeasures(samples, res, opts.rightEye || 'a');
    if (bino) { out = out || { measures: [] }; out.measures = [...out.measures, ...bino]; }
    return out;
  }

  function fmtN(v, d = 1) { return Number.isFinite(v) ? v.toFixed(d) : '–'; }

  Object.assign(OT, { ALGO_VERSION, SYNC, TASKS, makePlan, findStartBeep, taskMeasures, binocularMeasures, onsetTime, nystagmusCourse, fitSaccade, fitEvent, applyCalibration, recordingCheck, FIT_MIN_R2, FIT_MAX_NRMSE });
})(typeof module !== 'undefined' ? require('./core.js') : OT);
if (typeof module !== 'undefined') module.exports = require('./core.js');
