// OcuTrace core: iris locator, template matcher, and oculomotor analysis.
// Pure functions, no DOM. Shared by the page and the Node tests.
// Copyright (c) 2026 Mark Esparza. Released under the MIT License; see LICENSE.

const OT = (() => {
  const HVID_MM = 11.7;      // average horizontal visible iris diameter
  const EYE_RADIUS_MM = 12;  // approximate rotation radius of the globe

  function integral(g, N) {
    const W = N + 1;
    const I = new Float64Array(W * W);
    for (let y = 0; y < N; y++) {
      let row = 0;
      for (let x = 0; x < N; x++) {
        row += g[y * N + x];
        I[(y + 1) * W + (x + 1)] = I[y * W + (x + 1)] + row;
      }
    }
    return I;
  }

  // Sum and area of the square [cx-h, cx+h] x [cy-h, cy+h], clamped to the image.
  function box(I, N, cx, cy, h) {
    const W = N + 1;
    const x0 = Math.max(0, Math.round(cx - h)), x1 = Math.min(N, Math.round(cx + h) + 1);
    const y0 = Math.max(0, Math.round(cy - h)), y1 = Math.min(N, Math.round(cy + h) + 1);
    if (x1 <= x0 || y1 <= y0) return { s: 0, a: 0 };
    const s = I[y1 * W + x1] - I[y0 * W + x1] - I[y1 * W + x0] + I[y0 * W + x0];
    return { s, a: (x1 - x0) * (y1 - y0) };
  }

  // Dark disk on a brighter surround: ring mean minus core mean.
  function irisScore(I, N, cx, cy, r) {
    const core = box(I, N, cx, cy, 0.7 * r);
    const inner = box(I, N, cx, cy, 1.15 * r);
    const outer = box(I, N, cx, cy, 1.7 * r);
    const ringA = outer.a - inner.a;
    if (core.a === 0 || ringA <= 0) return { score: -1e9, dark: 0, ring: 0 };
    const dark = core.s / core.a;
    const ring = (outer.s - inner.s) / ringA;
    return { score: ring - dark, dark, ring };
  }

  function locateIris(g, N, gx, gy, r, I, searchX, searchY) {
    I = I || integral(g, N);
    let best = { score: -1e9, x: gx, y: gy, dark: 0, ring: 0 };
    const rx = Math.max(2, Math.round(searchX ?? r)), ry = Math.max(2, Math.round(searchY ?? 0.7 * r));
    for (let dy = -ry; dy <= ry; dy++) {
      for (let dx = -rx; dx <= rx; dx++) {
        const cx = Math.round(gx) + dx, cy = Math.round(gy) + dy;
        const s = irisScore(I, N, cx, cy, r);
        if (s.score > best.score) best = { score: s.score, x: cx, y: cy, dark: s.dark, ring: s.ring };
      }
    }
    // Sub-pixel refinement: centroid of dark pixels inside the iris.
    const T = best.dark + 0.5 * (best.ring - best.dark);
    const R = 1.1 * r, R2 = R * R;
    let sw = 0, sx = 0, sy = 0;
    const x0 = Math.max(0, Math.floor(best.x - R)), x1 = Math.min(N - 1, Math.ceil(best.x + R));
    const y0 = Math.max(0, Math.floor(best.y - R)), y1 = Math.min(N - 1, Math.ceil(best.y + R));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const ddx = x - best.x, ddy = y - best.y;
        if (ddx * ddx + ddy * ddy > R2) continue;
        const w = T - g[y * N + x];
        if (w > 0) { sw += w; sx += w * x; sy += w * y; }
      }
    }
    let x = best.x, y = best.y;
    if (sw > 1e-6) { x = sx / sw; y = sy / sw; }
    return { x, y, score: best.score, dark: best.dark, ring: best.ring };
  }

  function estimateRadius(g, N, gx, gy, rMin, rMax) {
    const I = integral(g, N);
    let best = null;
    for (let r = rMin; r <= rMax; r += 1) {
      const span = Math.max(3, Math.round(0.6 * r));
      for (let dy = -span; dy <= span; dy++) for (let dx = -span; dx <= span; dx++) {
        const cx = Math.round(gx) + dx, cy = Math.round(gy) + dy;
        const s = irisScore(I, N, cx, cy, r);
        if (!best || s.score > best.score) best = { r, x: cx, y: cy, score: s.score };
      }
    }
    // The box score favours a small radius when the pupil is very dark, so measure the
    // limbus directly: the outermost strong dark-to-bright edge along each horizontal ray.
    const cx = best.x, cy = best.y, dMax = Math.min(3 * rMax, Math.floor(N / 2) - 2);
    const edge = sign => {
      const p = [];
      for (let d = 0; d <= dMax + 1; d++) {
        const x = cx + sign * d; let s = 0, c = 0;
        if (x < 0 || x >= N) { p.push(p.length ? p[p.length - 1] : 0); continue; }
        for (let yy = cy - 2; yy <= cy + 2; yy++) if (yy >= 0 && yy < N) { s += g[yy * N + x]; c++; }
        p.push(s / c);
      }
      let gmax = 0; const gr = [];
      for (let d = 1; d < p.length - 1; d++) { gr[d] = p[d + 1] - p[d - 1]; if (d >= rMin && gr[d] > gmax) gmax = gr[d]; }
      let at = best.r;
      for (let d = rMin; d < p.length - 1; d++) if (gr[d] >= 0.6 * gmax) at = d;
      // keep only the edge cluster that contains the outermost strong gradient
      return at;
    };
    const dL = edge(-1), dR = edge(1);
    const r = Math.max(rMin, Math.min(rMax * 1.5, (dL + dR) / 2));
    const loc = locateIris(g, N, cx + (dR - dL) / 2, cy, r, I, 3, 3);
    return { r, x: loc.x, y: loc.y, score: loc.score };
  }

  // Sum of absolute differences template match around a guess.
  function matchTemplate(g, N, tpl, th, gx, gy, search) {
    const tw = 2 * th + 1;
    let best = { sad: Infinity, x: gx, y: gy };
    const cx0 = Math.round(gx), cy0 = Math.round(gy);
    for (let dy = -search; dy <= search; dy++) {
      for (let dx = -search; dx <= search; dx++) {
        const cx = cx0 + dx, cy = cy0 + dy;
        if (cx - th < 0 || cy - th < 0 || cx + th >= N || cy + th >= N) continue;
        let sad = 0;
        for (let ty = 0; ty < tw; ty++) {
          const gi = (cy - th + ty) * N + (cx - th);
          const ti = ty * tw;
          for (let tx = 0; tx < tw; tx++) sad += Math.abs(g[gi + tx] - tpl[ti + tx]);
          if (sad >= best.sad) break;
        }
        if (sad < best.sad) best = { sad, x: cx, y: cy };
      }
    }
    if (!Number.isFinite(best.sad)) return best;
    // Parabolic sub-pixel refinement on the SAD surface.
    const sadAt = (cx, cy) => {
      if (cx - th < 0 || cy - th < 0 || cx + th >= N || cy + th >= N) return NaN;
      let sad = 0;
      for (let ty = 0; ty < tw; ty++) { const gi = (cy - th + ty) * N + (cx - th), ti = ty * tw; for (let tx = 0; tx < tw; tx++) sad += Math.abs(g[gi + tx] - tpl[ti + tx]); }
      return sad;
    };
    const vertex = (a, b, c) => { const d = a - 2 * b + c; return Number.isFinite(d) && d > 0 ? Math.max(-0.5, Math.min(0.5, (a - c) / (2 * d))) : 0; };
    const x = best.x + vertex(sadAt(best.x - 1, best.y), best.sad, sadAt(best.x + 1, best.y));
    const y = best.y + vertex(sadAt(best.x, best.y - 1), best.sad, sadAt(best.x, best.y + 1));
    return { sad: best.sad, x, y };
  }

  function cutTemplate(g, N, cx, cy, th) {
    const tw = 2 * th + 1, tpl = new Float32Array(tw * tw);
    for (let ty = 0; ty < tw; ty++) for (let tx = 0; tx < tw; tx++) {
      const x = Math.min(N - 1, Math.max(0, Math.round(cx) - th + tx));
      const y = Math.min(N - 1, Math.max(0, Math.round(cy) - th + ty));
      tpl[ty * tw + tx] = g[y * N + x];
    }
    return tpl;
  }

  // Pixel displacement to approximate degrees of eye rotation.
  function pxToDeg(dPx, irisRadiusPx) {
    const mm = dPx * (HVID_MM / 2) / irisRadiusPx;
    const s = Math.max(-1, Math.min(1, mm / EYE_RADIUS_MM));
    return Math.asin(s) * 180 / Math.PI;
  }
  function degToPx(deg, irisRadiusPx) {
    return EYE_RADIUS_MM * Math.sin(deg * Math.PI / 180) * irisRadiusPx / (HVID_MM / 2);
  }

  // ---------- analysis ----------
  const median = a => { const b = a.filter(Number.isFinite).sort((p, q) => p - q); if (!b.length) return NaN; const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
  function slope(ts, ys) {
    const n = ts.length; let mt = 0, my = 0;
    for (let i = 0; i < n; i++) { mt += ts[i]; my += ys[i]; }
    mt /= n; my /= n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) { num += (ts[i] - mt) * (ys[i] - my); den += (ts[i] - mt) ** 2; }
    return den > 0 ? num / den : NaN;
  }

  // samples: [{t, x, y, ok}] with x = degrees toward the subject's right, y = degrees up.
  function analyze(samples, opts = {}) {
    const n = samples.length;
    const t = samples.map(s => s.t);
    const ok = samples.map(s => !!s.ok && Number.isFinite(s.x) && Number.isFinite(s.y));
    const x = samples.map((s, i) => ok[i] ? s.x : NaN);
    const y = samples.map((s, i) => ok[i] ? s.y : NaN);
    const interp = new Array(n).fill(false);

    // Fill gaps of up to 3 samples.
    for (let i = 0; i < n; i++) {
      if (ok[i]) continue;
      let j = i; while (j < n && !ok[j]) j++;
      if (i > 0 && j < n && j - i <= 3) {
        for (let k = i; k < j; k++) {
          const f = (t[k] - t[i - 1]) / (t[j] - t[i - 1]);
          x[k] = x[i - 1] + f * (x[j] - x[i - 1]);
          y[k] = y[i - 1] + f * (y[j] - y[i - 1]);
          ok[k] = true; interp[k] = true;
        }
      }
      i = j - 1;
    }

    const mx = median(x), my = median(y);
    for (let i = 0; i < n; i++) if (ok[i]) { x[i] -= mx; y[i] -= my; }

    const dts = []; for (let i = 1; i < n; i++) dts.push(t[i] - t[i - 1]);
    const dt = median(dts);
    const fps = dt > 0 ? 1 / dt : NaN;
    const validN = ok.filter(Boolean).length;
    const duration = n > 1 ? t[n - 1] - t[0] : 0;
    const validDuration = validN * (dt || 0);

    const vx = new Array(n).fill(NaN), vy = new Array(n).fill(NaN), sp = new Array(n).fill(NaN);
    for (let i = 1; i < n - 1; i++) {
      if (!(ok[i - 1] && ok[i] && ok[i + 1])) continue;
      const d = t[i + 1] - t[i - 1];
      vx[i] = (x[i + 1] - x[i - 1]) / d; vy[i] = (y[i + 1] - y[i - 1]) / d;
      sp[i] = Math.hypot(vx[i], vy[i]);
    }
    const spMed = median(sp);
    const spMad = median(sp.map(v => Math.abs(v - spMed))) * 1.4826;
    const threshold = Math.max(opts.minThreshold || 20, spMed + 6 * spMad);

    // Fast events (saccades and nystagmus fast phases).
    const runs = [];
    for (let i = 0; i < n; i++) {
      if (!(sp[i] > threshold)) continue;
      let j = i; while (j + 1 < n && (sp[j + 1] > threshold || (sp[j + 2] > threshold && j + 2 < n))) j++;
      runs.push([i, j]); i = j;
    }
    const events = [];
    for (const [i0, i1] of runs) {
      const a = i0 - 1, b = i1 + 1;
      if (a < 0 || b >= n || !ok[a] || !ok[b]) continue;
      const dx = x[b] - x[a], dy = y[b] - y[a];
      const amp = Math.hypot(dx, dy);
      if (amp < 0.4) continue;
      let pv = 0; for (let k = i0; k <= i1; k++) if (sp[k] > pv) pv = sp[k];
      events.push({ i0, i1, t: t[a], tEnd: t[b], dx, dy, amp, peakVel: pv });
    }

    function axis(name) {
      const pos = name === 'h' ? x : y;
      const comp = e => name === 'h' ? e.dx : e.dy;
      const fast = events.filter(e => Math.abs(comp(e)) >= 0.5);
      const plus = fast.filter(e => comp(e) > 0).length, minus = fast.length - plus;
      const domSign = plus >= minus ? 1 : -1;
      const domCount = Math.max(plus, minus);
      const consistency = fast.length ? domCount / fast.length : 0;
      // Slow phases between events.
      const bounds = [{ i1: -2 }, ...events, { i0: n + 1 }];
      const spv = [];
      for (let k = 0; k < bounds.length - 1; k++) {
        const s0 = bounds[k].i1 + 2, s1 = bounds[k + 1].i0 - 2;
        if (s1 - s0 + 1 < 4) continue;
        const ts = [], ps = []; let clean = true;
        for (let i = s0; i <= s1; i++) { if (!ok[i]) { clean = false; break; } ts.push(t[i]); ps.push(pos[i]); }
        if (!clean || ts[ts.length - 1] - ts[0] < 0.1) continue;
        spv.push({ t: ts[0], tEnd: ts[ts.length - 1], v: slope(ts, ps) });
      }
      const medSpv = median(spv.map(s => s.v));
      const opp = spv.filter(s => Math.sign(s.v) === -domSign).length;
      const slowConsistency = spv.length ? opp / spv.length : 0;
      const beatHz = validDuration > 0 ? domCount / validDuration : 0;
      const present = domCount >= 3 && consistency >= 0.7 && Math.abs(medSpv) >= 2 &&
        Math.sign(medSpv) === -domSign && slowConsistency >= 0.6;
      const dir = name === 'h' ? (domSign > 0 ? 'Right-beating' : 'Left-beating') : (domSign > 0 ? 'Upbeat' : 'Downbeat');
      return { axis: name, present, direction: dir, fastCount: domCount, consistency, medSpv, slowConsistency, beatHz, spv, evidence: present ? domCount * Math.abs(medSpv) : 0 };
    }
    const h = axis('h'), v = axis('v');
    const nyst = h.evidence >= v.evidence ? h : v;

    // Square wave jerks: small opposite horizontal saccade pairs.
    const hs = events.filter(e => Math.abs(e.dx) >= Math.abs(e.dy));
    let swj = 0; const swjList = [];
    for (let k = 0; k < hs.length - 1; k++) {
      const a = hs[k], b = hs[k + 1];
      const A = Math.abs(a.dx), B = Math.abs(b.dx);
      const isi = b.t - a.tEnd;
      if (A >= 0.5 && A <= 5 && B >= 0.5 && B <= 5 && Math.sign(a.dx) !== Math.sign(b.dx) && B / A >= 0.5 && B / A <= 2 && isi >= 0.15 && isi <= 0.5) {
        swj++; swjList.push(a.t); k++;
      }
    }
    const swjPerMin = validDuration > 0 ? swj / (validDuration / 60) : 0;

    return {
      n, t, x, y, ok, interp, vx, vy, sp, fps, duration, validPct: n ? validN / n : 0, validDuration,
      threshold, events, h, v, nyst, swj, swjList, swjPerMin,
      medianPeakVel: median(events.map(e => e.peakVel)),
    };
  }

  // Deterministic waveform for the synthetic eye (degrees, subject frame).
  function syntheticWave(fs, seconds, seed = 7) {
    let s = seed; const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    const gauss = () => { let u = 0; for (let i = 0; i < 6; i++) u += rnd(); return (u - 3) / Math.sqrt(0.5); };
    const out = [];
    // Right-beating jerk nystagmus: slow drift left at 6 deg/s, fast reset right, 2.5 beats/s.
    const period = 0.4, fastDur = 0.025, spv = -6;
    const A = -spv * (period - fastDur);
    for (let i = 0; i < fs * seconds; i++) {
      const t = i / fs;
      const ph = (t + 0.13) % period;
      let h;
      if (ph < period - fastDur) h = A / 2 + spv * ph;
      else h = -A / 2 + A * ((ph - (period - fastDur)) / fastDur);
      const v = 0;
      const blink = t >= 3.0 && t < 3.15;
      out.push({ t, h: h + 0.04 * gauss(), v: v + 0.04 * gauss(), blink });
    }
    return out;
  }

  return { integral, box, irisScore, locateIris, estimateRadius, matchTemplate, cutTemplate, pxToDeg, degToPx, analyze, syntheticWave, median, HVID_MM, EYE_RADIUS_MM };
})();
if (typeof module !== 'undefined') module.exports = OT;
