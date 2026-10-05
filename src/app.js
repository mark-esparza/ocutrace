(() => {
  const $ = s => document.querySelector(s);
  const N = 120;               // tracking crop size, px
  const WIDE = 200;            // crop size used to size the iris at the tap
  const MAX_SECONDS = 60;

  // ---------- small helpers ----------
  const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const fmt = (v, d = 1) => Number.isFinite(v) ? v.toFixed(d) : '–';
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const ctxCache = {};
  function cropCtx(n) {
    if (!ctxCache[n]) { const c = document.createElement('canvas'); c.width = c.height = n; ctxCache[n] = c.getContext('2d', { willReadFrequently: true }); }
    return ctxCache[n];
  }
  function cropGray(drawable, vw, vh, cx, cy, side, n) {
    side = Math.min(side, vw, vh);
    const sx = Math.max(0, Math.min(vw - side, cx - side / 2));
    const sy = Math.max(0, Math.min(vh - side, cy - side / 2));
    const ctx = cropCtx(n);
    ctx.clearRect(0, 0, n, n);
    ctx.drawImage(drawable, sx, sy, side, side, 0, 0, n, n);
    const d = ctx.getImageData(0, 0, n, n).data;
    const g = new Float32Array(n * n);
    for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
    return { g, sx, sy, s: n / side };
  }

  // ---------- synthetic eye ----------
  const SYN = { vw: 480, vh: 320, fs: 60, seconds: 6, R: 56, CX: 240, CY: 160 };
  const synCanvas = document.createElement('canvas'); synCanvas.width = SYN.vw; synCanvas.height = SYN.vh;
  const synCtx = synCanvas.getContext('2d');
  const synWave = OT.syntheticWave(SYN.fs, SYN.seconds);
  // Drawn like an infrared goggle camera: grey skin, bright sclera, dark iris and pupil, two LED glints.
  function drawSynEye(hDeg, vDeg, blink) {
    const c = synCtx, { CX, CY, R } = SYN;
    const skin = c.createRadialGradient(CX, CY, 40, CX, CY, 300);
    skin.addColorStop(0, '#a3a3a3'); skin.addColorStop(1, '#6e6e6e');
    c.fillStyle = skin; c.fillRect(0, 0, SYN.vw, SYN.vh);
    c.fillStyle = '#2a2a2a'; c.beginPath(); c.arc(CX + 190, 60, 9, 0, Math.PI * 2); c.fill();   // nose bridge sticker
    c.save();
    c.beginPath(); c.ellipse(CX, CY, 150, 66, 0, 0, Math.PI * 2); c.clip();
    if (blink) { c.fillStyle = '#8f8f8f'; c.fillRect(0, 0, SYN.vw, SYN.vh); }
    else {
      const sc = c.createRadialGradient(CX, CY, 20, CX, CY, 160);
      sc.addColorStop(0, '#e6e6e6'); sc.addColorStop(1, '#bdbdbd');
      c.fillStyle = sc; c.fillRect(CX - 160, CY - 80, 320, 160);
      const ix = CX - OT.degToPx(hDeg, R), iy = CY - OT.degToPx(vDeg, R);
      const ig = c.createRadialGradient(ix, iy, R * 0.35, ix, iy, R);
      ig.addColorStop(0, '#5d5d5d'); ig.addColorStop(0.85, '#4a4a4a'); ig.addColorStop(1, '#333');
      c.fillStyle = ig; c.beginPath(); c.arc(ix, iy, R, 0, Math.PI * 2); c.fill();
      c.fillStyle = '#060606'; c.beginPath(); c.arc(ix, iy, R * 0.4, 0, Math.PI * 2); c.fill();
      c.fillStyle = '#ffffff';
      for (const dx of [-0.16, 0.16]) { c.beginPath(); c.arc(ix + dx * R, iy - 0.2 * R, R * 0.055, 0, Math.PI * 2); c.fill(); }
      const lid = c.createLinearGradient(0, CY - 66, 0, CY - 40);
      lid.addColorStop(0, 'rgba(40,40,40,0.55)'); lid.addColorStop(1, 'rgba(40,40,40,0)');
      c.fillStyle = lid; c.fillRect(CX - 160, CY - 70, 320, 34);
    }
    c.restore();
    c.strokeStyle = '#3c3c3c'; c.lineWidth = 3;
    c.beginPath(); c.ellipse(CX, CY, 150, 66, 0, Math.PI * 1.04, Math.PI * 1.96); c.stroke();
  }

  // ---------- state ----------
  const state = {
    src: null,         // {kind, vw, vh, drawable, label}
    iris: null,        // {x, y, r0}
    ref: null,         // {x, y}
    marking: 'iris',
    result: null,
    samples: null,
    busy: false,
  };
  const vid = $('#vid');
  const frameCanvas = $('#frame');
  let downloads = null;

  // ---------- tabs ----------
  const tabs = ['analyze', 'stimulus', 'guide'];
  function showTab(name) {
    tabs.forEach(t => {
      $('#tab-' + t).setAttribute('aria-selected', String(t === name));
      $('#panel-' + t).hidden = t !== name;
    });
    if (name !== 'stimulus') stopStim();
    if (name === 'stimulus') sizeStage();
    if (name === 'analyze') drawStrip();
    try { localStorage.setItem('ocutrace-tab', name); } catch (e) {}
  }
  tabs.forEach((t, i) => {
    const b = $('#tab-' + t);
    b.addEventListener('click', () => showTab(t));
    b.addEventListener('keydown', e => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      showTab(next); $('#tab-' + next).focus();
    });
  });

  // ---------- marking ----------
  function irisRadius() { return state.iris ? state.iris.r0 * (+$('#irisSize').value / 100) : 0; }
  function renderFrame() {
    const src = state.src; if (!src) return;
    const ctx = frameCanvas.getContext('2d');
    const maxW = 960;
    const scale = Math.min(1, maxW / src.vw);
    frameCanvas.width = Math.round(src.vw * scale); frameCanvas.height = Math.round(src.vh * scale);
    ctx.drawImage(src.drawable, 0, 0, frameCanvas.width, frameCanvas.height);
    // Show the frame in grayscale, the way the tracker reads it.
    try {
      const im = ctx.getImageData(0, 0, frameCanvas.width, frameCanvas.height), d = im.data;
      for (let j = 0; j < d.length; j += 4) { const v = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2]; d[j] = d[j + 1] = d[j + 2] = v; }
      ctx.putImageData(im, 0, 0);
    } catch (e) { /* leave the frame in color */ }
    const k = frameCanvas.width / src.vw;
    const lw = Math.max(2, frameCanvas.width / 320);
    if (state.iris) {
      const x = state.iris.x * k, y = state.iris.y * k, rr = irisRadius() * k;
      ctx.strokeStyle = '#ff3b24'; ctx.lineWidth = lw;
      ctx.beginPath(); ctx.arc(x, y, rr, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x - rr - 6 * lw, y); ctx.lineTo(x - rr + 3 * lw, y); ctx.moveTo(x + rr - 3 * lw, y); ctx.lineTo(x + rr + 6 * lw, y);
      ctx.moveTo(x, y - rr - 6 * lw); ctx.lineTo(x, y - rr + 3 * lw); ctx.moveTo(x, y + rr - 3 * lw); ctx.lineTo(x, y + rr + 6 * lw);
      ctx.stroke();
    }
    if (state.ref) {
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = lw;
      const s = 10 * lw, x = state.ref.x * k, y = state.ref.y * k;
      ctx.strokeRect(x - s / 2, y - s / 2, s, s);
    }
    $('#markSource').textContent = `${src.label}, ${src.vw} × ${src.vh}`;
    $('#trackBtn').disabled = !state.iris || state.busy;
    $('#clearRefBtn').disabled = !state.ref || state.busy;
  }
  frameCanvas.addEventListener('pointerdown', e => {
    if (!state.src || state.busy || !state.marking) return;
    const rect = frameCanvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width * state.src.vw;
    const y = (e.clientY - rect.top) / rect.height * state.src.vh;
    if (state.marking === 'iris') {
      const side = 0.6 * Math.min(state.src.vw, state.src.vh);
      const c = cropGray(state.src.drawable, state.src.vw, state.src.vh, x, y, side, WIDE);
      const est = OT.estimateRadius(c.g, WIDE, (x - c.sx) * c.s - 0.5, (y - c.sy) * c.s - 0.5, 3, 60);
      state.iris = { x: c.sx + (est.x + 0.5) / c.s, y: c.sy + (est.y + 0.5) / c.s, r0: est.r / c.s };
      $('#irisSize').value = 100;
      state.marking = 'ref';
      $('#markStatus').textContent = 'Iris marked. Adjust the outline if it does not sit on the iris edge, then tap a fixed point or track.';
    } else {
      state.ref = { x, y };
      state.marking = null;
      $('#markStatus').textContent = 'Fixed point marked. Ready to track.';
    }
    renderFrame();
  });
  $('#irisSize').addEventListener('input', renderFrame);
  $('#markIrisBtn').addEventListener('click', () => { state.marking = 'iris'; $('#markStatus').textContent = 'Tap the center of one iris.'; renderFrame(); });
  $('#markRefBtn').addEventListener('click', () => { state.marking = 'ref'; $('#markStatus').textContent = 'Tap a fixed point such as a sticker on the nose bridge.'; renderFrame(); });
  $('#clearRefBtn').addEventListener('click', () => { state.ref = null; renderFrame(); });

  // ---------- tracker ----------
  function makeTracker(src, iris, r, ref) {
    let cx = iris.x, cy = iris.y, rx = ref && ref.x, ry = ref && ref.y;
    let refScore = null, tpl = null;
    const TH = 12, SEARCH = 16;
    let origin = null;
    return function step(drawable) {
      const c = cropGray(drawable, src.vw, src.vh, cx, cy, 6 * r, N);
      const loc = OT.locateIris(c.g, N, (cx - c.sx) * c.s - 0.5, (cy - c.sy) * c.s - 0.5, r * c.s);
      const nx = c.sx + (loc.x + 0.5) / c.s, ny = c.sy + (loc.y + 0.5) / c.s;
      if (refScore === null && loc.score > 0) refScore = loc.score;
      const conf = refScore ? loc.score / refScore : 0;
      let ok = conf >= 0.45 && Math.hypot(nx - cx, ny - cy) <= 1.5 * r;
      if (ok) { cx = nx; cy = ny; }
      if (ref) {
        const rc = cropGray(drawable, src.vw, src.vh, rx, ry, 6 * r, N);
        const gx = (rx - rc.sx) * rc.s - 0.5, gy = (ry - rc.sy) * rc.s - 0.5;
        if (!tpl) tpl = OT.cutTemplate(rc.g, N, gx, gy, TH);
        const m = OT.matchTemplate(rc.g, N, tpl, TH, gx, gy, SEARCH);
        if (Number.isFinite(m.sad)) { rx = rc.sx + (m.x + 0.5) / rc.s; ry = rc.sy + (m.y + 0.5) / rc.s; } else ok = false;
      }
      const ex = nx - (ref ? rx : 0), ey = ny - (ref ? ry : 0);
      if (ok && !origin) origin = { x: ex, y: ey };
      if (!ok || !origin) return { ok: false };
      return { ok, dx: ex - origin.x, dy: ey - origin.y };
    };
  }
  function toDeg(trk, r, mirrored) {
    if (!trk.ok) return { x: NaN, y: NaN, ok: false };
    return { x: OT.pxToDeg(mirrored ? trk.dx : -trk.dx, r), y: OT.pxToDeg(-trk.dy, r), ok: true };
  }

  async function trackSynthetic() {
    const r = irisRadius();
    const step = makeTracker(state.src, state.iris, r, state.ref);
    const samples = [];
    for (let i = 0; i < synWave.length; i++) {
      const w = synWave[i];
      drawSynEye(w.h, w.v, w.blink);
      const d = toDeg(step(synCanvas), r, false);
      samples.push({ t: w.t, ...d });
      if (i % 40 === 0) { setProgress(i / synWave.length); await sleep(0); }
    }
    drawSynEye(synWave[0].h, synWave[0].v, false);
    return samples;
  }

  function trackVideo() {
    return new Promise((resolve, reject) => {
      const r = irisRadius();
      const F = +$('#slowmo').value || 1;
      const mirrored = $('#mirrored').checked;
      const step = makeTracker(state.src, state.iris, r, state.ref);
      const samples = [];
      const limit = Math.min(vid.duration || MAX_SECONDS * F, MAX_SECONDS * F);
      let last = -1, done = false;
      const finish = () => { if (done) return; done = true; vid.pause(); resolve(samples); };
      const handle = mediaTime => {
        if (mediaTime === last) return;
        last = mediaTime;
        samples.push({ t: mediaTime / F, ...toDeg(step(vid), r, mirrored) });
        setProgress(mediaTime / limit);
      };
      vid.currentTime = 0;
      if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
        const onFrame = (now, meta) => {
          if (done) return;
          handle(meta.mediaTime);
          if (meta.mediaTime >= limit) finish(); else vid.requestVideoFrameCallback(onFrame);
        };
        vid.addEventListener('ended', finish, { once: true });
        vid.playbackRate = 0.5;
        vid.requestVideoFrameCallback(onFrame);
        vid.play().catch(err => { done = true; reject(err); });
      } else {
        (async () => {
          const dt = 1 / 30;
          for (let t = 0; t < limit; t += dt) {
            await seek(t);
            handle(vid.currentTime);
          }
          finish();
        })().catch(reject);
      }
    });
  }
  function seek(t) {
    return new Promise(res => {
      const on = () => { vid.removeEventListener('seeked', on); res(); };
      vid.addEventListener('seeked', on);
      vid.currentTime = t;
    });
  }
  function setProgress(f) { const p = $('#prog'), v = Math.max(0, Math.min(1, f)); p.hidden = false; p.firstElementChild.style.width = (v * 100).toFixed(1) + '%'; p.setAttribute('aria-valuenow', String(Math.round(v * 100))); }

  $('#trackBtn').addEventListener('click', async () => {
    if (!state.iris || state.busy) return;
    state.busy = true; renderFrame();
    $('#markStatus').textContent = state.src.kind === 'video' ? 'Tracking. The clip plays at half speed while each frame is measured.' : 'Tracking the synthetic eye.';
    try {
      const samples = state.src.kind === 'video' ? await trackVideo() : await trackSynthetic();
      if (samples.length < 20) throw new Error('Too few frames were read from this clip. Try a longer recording.');
      showResult(samples, state.src.label, state.src.kind === 'synthetic');
      $('#markStatus').textContent = `Tracked ${samples.length} frames.`;
    } catch (err) {
      $('#markStatus').textContent = (err && err.message) || 'Tracking stopped. Try the clip again.';
      $('#markStatus').classList.add('err');
      setTimeout(() => $('#markStatus').classList.remove('err'), 6000);
    } finally {
      state.busy = false; $('#prog').hidden = true; renderFrame();
      if (state.src.kind === 'video') { await seek(firstFrameTime()); renderFrame(); }
    }
  });

  // ---------- sources ----------
  function loadSynthetic() {
    drawSynEye(synWave[0].h, synWave[0].v, false);
    state.src = { kind: 'synthetic', vw: SYN.vw, vh: SYN.vh, drawable: synCanvas, label: 'Synthetic eye' };
    // Pre-place marks the way a user would.
    const side = 0.6 * Math.min(SYN.vw, SYN.vh);
    const c = cropGray(synCanvas, SYN.vw, SYN.vh, SYN.CX + 4, SYN.CY - 3, side, WIDE);
    const est = OT.estimateRadius(c.g, WIDE, (SYN.CX + 4 - c.sx) * c.s - 0.5, (SYN.CY - 3 - c.sy) * c.s - 0.5, 3, 60);
    state.iris = { x: c.sx + (est.x + 0.5) / c.s, y: c.sy + (est.y + 0.5) / c.s, r0: est.r / c.s };
    state.ref = { x: SYN.CX + 190, y: 60 };
    state.marking = null;
    $('#irisSize').value = 100;
    $('#srcStatus').textContent = 'Below is a computer drawn eye, run through the same tracker, so you can see a complete reading before loading your own clip.';
    $('#markStatus').textContent = 'The iris and the nose sticker are already marked on the synthetic eye. Track it again, or load your own clip above.';
    renderFrame();
  }
  $('#synBtn').addEventListener('click', async () => {
    if (state.busy) return;
    loadSynthetic(); $('#trackBtn').click();
  });

  let objectUrl = null, triedDataUrl = false, pendingFile = null, loadTimer = null;
  function firstFrameTime() { return Math.min(0.1, (vid.duration || 1) / 2); }
  function onVideoFile(file) {
    if (!file || state.busy) return;
    pendingFile = file; triedDataUrl = false;
    $('#srcStatus').classList.remove('err');
    $('#srcStatus').textContent = `Opening ${file.name || 'video'}…`;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(file);
    vid.src = objectUrl; vid.load();
    armLoadTimer();
  }
  function armLoadTimer() {
    clearTimeout(loadTimer);
    loadTimer = setTimeout(() => vid.dispatchEvent(new Event('error')), 10000);
  }
  vid.addEventListener('loadedmetadata', async () => {
    clearTimeout(loadTimer);
    if (!vid.videoWidth) { $('#srcStatus').textContent = 'This file has no video track.'; $('#srcStatus').classList.add('err'); return; }
    await seek(firstFrameTime());
    state.src = { kind: 'video', vw: vid.videoWidth, vh: vid.videoHeight, drawable: vid, label: pendingFile && pendingFile.name ? pendingFile.name : 'Your video' };
    state.iris = null; state.ref = null; state.marking = 'iris';
    describeVideo();
    $('#markStatus').textContent = 'Tap the center of one iris.';
    renderFrame();
    $('#markCard').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  });
  vid.addEventListener('error', () => {
    clearTimeout(loadTimer);
    if (!pendingFile || state.src && state.src.kind === 'video' && vid.videoWidth) return;
    if (!triedDataUrl && pendingFile.size < 150e6) {
      triedDataUrl = true;
      const fr = new FileReader();
      fr.onload = () => { vid.src = fr.result; vid.load(); armLoadTimer(); };
      fr.readAsDataURL(pendingFile);
      return;
    }
    $('#srcStatus').textContent = 'This browser could not open the clip. Try an MP4 or MOV recorded on the phone, or open the page in another browser.';
    $('#srcStatus').classList.add('err');
  });
  $('#recInput').addEventListener('change', e => onVideoFile(e.target.files[0]));
  $('#fileInput').addEventListener('change', e => onVideoFile(e.target.files[0]));
  function describeVideo() {
    if (!state.src || state.src.kind !== 'video') return;
    const F = +$('#slowmo').value || 1, secs = vid.duration / F, limit = Math.min(secs, MAX_SECONDS);
    $('#srcStatus').textContent = `${vid.videoWidth} × ${vid.videoHeight}, ${fmt(secs, 1)} s of real time` +
      (secs > MAX_SECONDS ? `. Only the first ${MAX_SECONDS} s will be analyzed.` : '.') +
      ` Tracking takes about ${fmt(limit * F * 2, 0)} s.`;
  }
  $('#slowmo').addEventListener('change', describeVideo);

  // ---------- results ----------
  const SLOW_DIR = { 'Right-beating': 'leftward', 'Left-beating': 'rightward', 'Upbeat': 'downward', 'Downbeat': 'upward' };
  const FAST_DIR = { 'Right-beating': 'rightward', 'Left-beating': 'leftward', 'Upbeat': 'upward', 'Downbeat': 'downward' };
  function showResult(samples, label, synthetic) {
    state.samples = samples;
    const res = OT.analyze(samples);
    state.result = res;
    $('#resultSource').textContent = synthetic
      ? 'Synthetic eye with right-beating nystagmus built in at 6°/s and 2.5 beats/s. Not patient data.'
      : `${label}, ${fmt(res.duration, 1)} s at ${fmt(res.fps, 0)} fps.`;
    const ny = res.nyst, call = $('#verdictText');
    $('#verdictBox').className = 'verdict' + (ny.present ? ' found' : '');
    if (ny.present) {
      call.className = 'call';
      call.textContent = `${ny.direction} nystagmus`;
      $('#verdictSub').textContent = `Slow phases drift ${SLOW_DIR[ny.direction]} at ${fmt(Math.abs(ny.medSpv))}°/s, ${fmt(ny.beatHz)} beats per second. A prototype reading, not a diagnosis.`;
    } else {
      call.className = 'call';
      call.textContent = 'No nystagmus pattern';
      const drift = Math.max(Math.abs(res.h.medSpv) || 0, Math.abs(res.v.medSpv) || 0);
      $('#verdictSub').textContent = `Drift between fast events peaked at ${fmt(drift)}°/s, with no consistent beat direction above the 2°/s cutoff. A prototype reading, not a diagnosis.`;
    }
    const axisName = ny.axis === 'h' ? 'horizontal' : 'vertical';
    const rows = [
      ['Slow phase velocity', fmt(Math.abs(ny.medSpv)), '°/s', ny.spv.length ? `Median of ${ny.spv.length} slow phases, ${axisName}` : 'No clean slow phases between events'],
      ['Beat frequency', fmt(ny.beatHz), 'beats/s', ny.fastCount ? `${ny.fastCount} ${FAST_DIR[ny.direction]} fast phases` : 'No fast phases found'],
      ['Square wave jerks', fmt(res.swjPerMin, 0), 'per min', `${res.swj} found. Read only from fixation recordings`],
      ['Fast events', String(res.events.length), '', res.events.length ? `Median peak speed ${fmt(res.medianPeakVel, 0)}°/s` : 'None above threshold'],
      ['Frames tracked', fmt(res.validPct * 100, 0), '%', `${res.n} frames over ${fmt(res.duration, 1)} s`],
      ['Frame rate', fmt(res.fps, 0), 'fps', synthetic ? 'Synthetic clip' : 'After slow motion correction'],
    ];
    const mb = $('#measures tbody'); mb.innerHTML = '';
    for (const [name, v, unit, basis] of rows) {
      const tr = document.createElement('tr');
      const a = document.createElement('td'); a.textContent = name;
      const b = document.createElement('td'); b.className = 'val'; b.textContent = v;
      if (unit) { const s = document.createElement('span'); s.textContent = unit; b.appendChild(s); }
      const c = document.createElement('td'); c.className = 'basis'; c.textContent = basis;
      tr.append(a, b, c); mb.appendChild(tr);
    }
    const note = $('#fpsNote');
    if (res.fps < 100) {
      note.hidden = false;
      note.innerHTML = '<svg width="18" height="18" viewBox="0 0 28 28" aria-hidden="true"><path d="M14 2 L27 25 H1 Z" fill="#ffd200" stroke="#7a5c00" stroke-linejoin="round"/><rect x="12.6" y="9" width="2.8" height="9" fill="#000"/><circle cx="14" cy="21.3" r="1.6" fill="#000"/></svg><span></span>';
      note.lastChild.textContent = `At ${fmt(res.fps, 0)} fps, peak speeds read low and brief saccades can be missed. Record in 240 fps slow motion when saccade speed matters.`;
    }
    else note.hidden = true;

    const tb = $('#evTable tbody'); tb.innerHTML = '';
    res.events.slice(0, 40).forEach(e => {
      const tr = document.createElement('tr');
      [[fmt(e.t, 2), 1], [isFastPhase(e) ? 'Fast phase' : 'Saccade', 0], [dirOf(e), 0], [fmt(e.amp, 2), 1], [fmt(e.peakVel, 0), 1]].forEach(([txt, num]) => {
        const td = document.createElement('td'); td.textContent = txt; if (num) td.className = 'num'; tr.appendChild(td);
      });
      tb.appendChild(tr);
    });
    $('#evSummary').textContent = `Fast events (${res.events.length})`;
    $('#evMore').textContent = res.events.length > 40 ? `${res.events.length - 40} more are in the CSV.` : (res.events.length ? '' : 'No fast events crossed the threshold.');
    $('#csvBox').hidden = true; $('#csvStatus').textContent = '';
    $('#strip').setAttribute('aria-label', `Recorder strip, ${fmt(res.duration, 1)} seconds. ${call.textContent}.`);
    drawStrip();
  }
  function isFastPhase(e) {
    const ny = state.result && state.result.nyst; if (!ny || !ny.present) return false;
    const comp = ny.axis === 'h' ? e.dx : e.dy;
    const sign = (ny.direction === 'Right-beating' || ny.direction === 'Upbeat') ? 1 : -1;
    return Math.sign(comp) === sign && Math.abs(comp) >= 0.5;
  }
  const dirOf = e => Math.abs(e.dx) >= Math.abs(e.dy) ? (e.dx > 0 ? 'Right' : 'Left') : (e.dy > 0 ? 'Up' : 'Down');

  // ---------- recorder strip ----------
  function niceStep(span, target) {
    const raw = span / target, p = Math.pow(10, Math.floor(Math.log10(raw)));
    const m = raw / p; return (m < 1.5 ? 1 : m < 3 ? 2 : m < 7 ? 5 : 10) * p;
  }
  function drawStrip() {
    const res = state.result; if (!res || $('#panel-analyze').hidden) return;
    const paper = $('#paper'), cv = $('#strip');
    const t = res.t, t0 = t[0], t1 = t[t.length - 1] || 1, dur = Math.max(0.5, t1 - t0);
    const GUT = 66, RIGHT = 10, TOP = 8, AXIS = 28;
    const viewW = paper.clientWidth || 600;
    const W = Math.max(viewW, Math.round(GUT + RIGHT + dur * 45));
    let limH = 1, limV = 1, spMax = res.threshold * 1.5;
    for (let i = 0; i < res.n; i++) if (res.ok[i]) { limH = Math.max(limH, Math.abs(res.x[i])); limV = Math.max(limV, Math.abs(res.y[i])); }
    for (const v of res.sp) if (Number.isFinite(v)) spMax = Math.max(spMax, v);
    limH = Math.ceil(limH * 1.1); limV = Math.ceil(limV * 1.1);
    const ink = css('--graph-label'), ink2 = css('--graph-sep'), red = css('--graph-ev'), blue = css('--graph-v'), pen = css('--graph-h');
    const minor = css('--graph-minor'), major = css('--graph-major'), bg = css('--graph-bg');
    const family = css('--font') || 'sans-serif';
    const chans = [
      { name: 'Horizontal', unit: '°', h: 132, lo: -limH, hi: limH, data: res.x, color: pen, width: 1.7, up: 'R', down: 'L' },
      { name: 'Vertical', unit: '°', h: 92, lo: -limV, hi: limV, data: res.y, color: blue, width: 1.5, up: 'Up', down: 'Dn' },
      { name: 'Events', h: 32 },
      { name: 'Speed', unit: '°/s', h: 104, lo: 0, hi: spMax * 1.08, data: res.sp, color: pen, width: 1.3 },
    ];
    const H = TOP + chans.reduce((a, c) => a + c.h, 0) + AXIS;
    const dpr = window.devicePixelRatio || 1;
    cv.style.width = W + 'px'; cv.style.height = H + 'px';
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
    const X = v => GUT + (v - t0) / dur * (W - GUT - RIGHT);
    const xs = niceStep(dur, Math.max(3, Math.floor((W - GUT - RIGHT) / 70)));
    const hline = (y, x0, x1, col, w = 1) => { ctx.strokeStyle = col; ctx.lineWidth = w; ctx.beginPath(); ctx.moveTo(x0, Math.round(y) + 0.5); ctx.lineTo(x1, Math.round(y) + 0.5); ctx.stroke(); };
    const vline = (x, y0, y1, col, w = 1) => { ctx.strokeStyle = col; ctx.lineWidth = w; ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, y0); ctx.lineTo(Math.round(x) + 0.5, y1); ctx.stroke(); };
    const steps = (lo, hi, st, fn) => { for (let v = Math.ceil(lo / st - 1e-9) * st; v <= hi + 1e-9; v += st) fn(+v.toFixed(6)); };

    let top = TOP;
    for (const c of chans) {
      const bot = top + c.h;
      const Y = c.data ? (v => top + 7 + (1 - (v - c.lo) / (c.hi - c.lo)) * (c.h - 14)) : null;
      const ys = c.data ? niceStep(c.hi - c.lo, c.h > 110 ? 4 : 2) : 0;
      // chart paper: minor then major
      steps(t0, t1, xs / 5, v => vline(X(v), top, bot, minor));
      if (Y) steps(c.lo, c.hi, ys / 5, v => hline(Y(v), GUT, W - RIGHT, minor));
      steps(t0, t1, xs, v => vline(X(v), top, bot, major));
      if (Y) steps(c.lo, c.hi, ys, v => hline(Y(v), GUT, W - RIGHT, major));
      // blinks and lost frames
      ctx.fillStyle = '#ffffff'; ctx.globalAlpha = 0.14;
      for (let i = 0; i < res.n; i++) if (!res.ok[i]) { const xa = X(t[Math.max(0, i - 1)]), xb = X(t[Math.min(res.n - 1, i + 1)]); ctx.fillRect(xa, top, Math.max(1.5, xb - xa), c.h); }
      ctx.globalAlpha = 1;
      // gutter labels
      ctx.fillStyle = ink; ctx.font = `600 12.5px ${family}`;
      if (c.data) {
        ctx.save(); ctx.translate(14, (top + bot) / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(c.name, 0, 0); ctx.restore();
        ctx.font = `400 11px ${family}`; ctx.fillStyle = ink; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
        steps(c.lo, c.hi, ys, v => ctx.fillText(`${v > 0 && c.lo < 0 ? '+' : ''}${+v.toFixed(2)}${c.unit}`, GUT - 7, Y(v)));
      } else {
        ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.fillText(c.name, GUT - 7, (top + bot) / 2);
      }
      if (c.up) {
        ctx.font = `600 11px ${family}`; ctx.fillStyle = ink; ctx.textAlign = 'left';
        ctx.textBaseline = 'top'; ctx.fillText(c.up, GUT + 5, top + 3);
        ctx.textBaseline = 'bottom'; ctx.fillText(c.down, GUT + 5, bot - 3);
      }
      // pens
      if (c.name === 'Speed') {
        ctx.setLineDash([6, 4]); hline(Y(res.threshold), GUT, W - RIGHT, red, 1.2); ctx.setLineDash([]);
      }
      if (c.data) {
        ctx.strokeStyle = c.color; ctx.lineWidth = c.width; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.beginPath();
        let pen = false;
        for (let i = 0; i < t.length; i++) {
          const v = c.data[i];
          if (!Number.isFinite(v)) { pen = false; continue; }
          const px = X(t[i]), py = Y(Math.max(c.lo, Math.min(c.hi, v)));
          if (pen) ctx.lineTo(px, py); else { ctx.moveTo(px, py); pen = true; }
        }
        ctx.stroke();
      } else {
        ctx.fillStyle = red;
        for (const e of res.events) {
          const full = isFastPhase(e), x = X((e.t + e.tEnd) / 2), hh = full ? c.h - 10 : (c.h - 10) * 0.5;
          ctx.fillRect(Math.round(x) - 1, bot - 5 - hh, 2.5, hh);
        }
      }
      if (c.name === 'Speed') {
        ctx.font = `400 11px ${family}`; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
        const lab = `threshold ${fmt(res.threshold, 0)}°/s`, lw = ctx.measureText(lab).width;
        ctx.fillStyle = bg; ctx.fillRect(GUT + 22, Y(res.threshold) - 16, lw + 8, 13);
        ctx.fillStyle = red; ctx.fillText(lab, GUT + 26, Y(res.threshold) - 3);
      }
      hline(bot, 0, W, ink2, 1);
      top = bot;
    }
    // time axis
    ctx.font = `400 11px ${family}`; ctx.fillStyle = ink; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    steps(t0, t1, xs, v => ctx.fillText(`${+v.toFixed(2)} s`, Math.min(W - RIGHT - 12, Math.max(GUT + 10, X(v))), top + 8));
  }
  new ResizeObserver(() => drawStrip()).observe($('#paper'));
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', drawStrip);
  new MutationObserver(drawStrip).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(drawStrip);

  // ---------- CSV ----------
  function buildCsv() {
    const res = state.result; if (!res) return '';
    const evAt = new Array(res.n).fill('');
    res.events.forEach((e, k) => { for (let i = e.i0; i <= e.i1; i++) evAt[i] = String(k + 1); });
    const rows = ['t_s,h_deg,v_deg,valid,interpolated,speed_deg_s,event'];
    for (let i = 0; i < res.n; i++) {
      rows.push([res.t[i].toFixed(4), res.ok[i] ? res.x[i].toFixed(3) : '', res.ok[i] ? res.y[i].toFixed(3) : '', res.ok[i] ? 1 : 0, res.interp[i] ? 1 : 0, Number.isFinite(res.sp[i]) ? res.sp[i].toFixed(1) : '', evAt[i]].join(','));
    }
    return rows.join('\n') + '\n';
  }
  function csvName() {
    const base = (state.src && state.src.kind === 'video' ? state.src.label.replace(/\.[^.]+$/, '') : 'synthetic-eye').replace(/[^\w-]+/g, '-').slice(0, 60);
    return `ocutrace-${base}-${new Date().toISOString().slice(0, 10)}.csv`;
  }
  $('#saveCsv').addEventListener('click', async () => {
    if (!downloads) return;
    try { await downloads.save({ filename: csvName(), data: buildCsv() }); $('#csvStatus').textContent = 'Saved.'; }
    catch (e) { $('#csvStatus').textContent = e && e.code === 'declined' ? 'Save cancelled.' : 'Saving is not available here. Use Copy instead.'; }
  });
  $('#copyCsv').addEventListener('click', () => {
    const text = buildCsv();
    const fallback = () => { const box = $('#csvBox'); box.hidden = false; box.value = text; box.focus(); box.select(); $('#csvStatus').textContent = 'Copying is blocked here. The CSV is selected below; copy it from the box.'; };
    try {
      navigator.clipboard.writeText(text).then(() => { $('#csvStatus').textContent = `Copied ${state.result.n} rows.`; }, fallback);
    } catch (e) { fallback(); }
  });
  if (window.claude && typeof window.claude.use === 'function') {
    window.claude.use('downloads').then(d => { downloads = d; $('#saveCsv').hidden = !d; }).catch(() => {});
  } else {
    // Ordinary web page (for example GitHub Pages): save through a download link.
    downloads = {
      save: async ({ filename, data }) => {
        const url = URL.createObjectURL(new Blob([data], { type: 'text/csv' }));
        const a = document.createElement('a'); a.href = url; a.download = filename;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        return { status: 'saved' };
      },
    };
    $('#saveCsv').hidden = false;
  }

  // ---------- stimulus ----------
  const stage = $('#stage'), stim = $('#stim'), hud = $('#hud');
  let stimRun = null, wakeLock = null;
  function sizeStage() {
    const dpr = window.devicePixelRatio || 1;
    stim.width = Math.round(stim.clientWidth * dpr); stim.height = Math.round(stim.clientHeight * dpr);
    if (!stimRun) drawStim(0, $('#task').value, true);
  }
  new ResizeObserver(sizeStage).observe(stage);
  function rng(seed) { let s = seed; return () => (s = (s * 16807) % 2147483647) / 2147483647; }
  function sacSchedule(seed) { const r = rng(seed), out = []; let t = 1; let side = 1; while (t < 40) { out.push({ t, side }); t += 1 + r(); side = side === 0 ? (r() < 0.5 ? 1 : -1) : 0; } return out; }
  const sacPlan = sacSchedule(11);
  const gazePlan = [[0, 0, 3, 'Center'], [1, 0, 10, 'Right gaze'], [0, 0, 3, 'Center'], [-1, 0, 10, 'Left gaze'], [0, 0, 3, 'Center'], [0, 1, 10, 'Up gaze'], [0, 0, 3, 'Center'], [0, -1, 10, 'Down gaze'], [0, 0, 3, 'Center']];
  const TASK_LEN = { fixation: 20, gaze: gazePlan.reduce((a, g) => a + g[2], 0), sacH: 40, sacV: 40, pursuit: 20, okn: 30 };
  function dot(ctx, x, y, s) {
    ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(x, y, s, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#e0261b'; ctx.beginPath(); ctx.arc(x, y, s * 0.35, 0, Math.PI * 2); ctx.fill();
  }
  function drawStim(t, task, idle) {
    const ctx = stim.getContext('2d'), W = stim.width, H = stim.height;
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    const s = Math.max(6, Math.min(W, H) * 0.018), cx = W / 2, cy = H / 2, ax = W * 0.42, ay = H * 0.38;
    let label = '';
    if (task === 'okn') {
      const dir = +$('#oknDir').value, sw = W * 0.06, off = ((t * W * 0.25 * dir) % (2 * sw) + 2 * sw) % (2 * sw);
      ctx.fillStyle = '#ffffff';
      for (let x = -2 * sw + off; x < W + 2 * sw; x += 2 * sw) ctx.fillRect(x, 0, sw, H);
      label = dir > 0 ? 'Stripes moving right' : 'Stripes moving left';
    } else if (task === 'fixation') { dot(ctx, cx, cy, s); label = 'Look at the dot'; }
    else if (task === 'pursuit') { dot(ctx, cx + (idle ? 0 : ax * Math.sin(2 * Math.PI * 0.4 * t)), cy, s); label = 'Follow the dot'; }
    else if (task === 'gaze') {
      let acc = 0, cur = gazePlan[0];
      for (const g of gazePlan) { if (t < acc + g[2]) { cur = g; break; } acc += g[2]; cur = g; }
      dot(ctx, cx + cur[0] * ax, cy - cur[1] * ay, s); label = cur[3];
    } else {
      let cur = { side: 0 };
      for (const p of sacPlan) { if (p.t <= t) cur = p; else break; }
      const vert = task === 'sacV';
      dot(ctx, cx + (vert ? 0 : cur.side * ax), cy - (vert ? cur.side * ay : 0), s); label = 'Jump to the dot';
    }
    return label;
  }
  async function startStim() {
    stopStim();
    const task = $('#task').value, len = TASK_LEN[task], t0 = performance.now();
    try { if (navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { wakeLock = null; }
    const frame = () => {
      const t = (performance.now() - t0) / 1000;
      const label = drawStim(t, task, false);
      hud.textContent = `${label} · ${Math.max(0, len - t).toFixed(0)} s left`;
      if (t >= len) { stopStim(); hud.textContent = 'Done'; return; }
      stimRun = requestAnimationFrame(frame);
    };
    stimRun = requestAnimationFrame(frame);
  }
  function stopStim() {
    if (stimRun) cancelAnimationFrame(stimRun);
    stimRun = null; hud.textContent = 'Ready';
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
    if (stim.width) drawStim(0, $('#task').value, true);
  }
  $('#stimStart').addEventListener('click', startStim);
  $('#stimStop').addEventListener('click', stopStim);
  $('#task').addEventListener('change', stopStim);
  $('#oknDir').addEventListener('change', () => { if (!stimRun) drawStim(0, 'okn', true); });
  $('#stimFull').addEventListener('click', () => {
    const p = stage.requestFullscreen ? stage.requestFullscreen() : null;
    if (p && p.catch) p.catch(() => { $('#stimStatus').textContent = 'Full screen is not available here. Rotate the device or enlarge the window instead.'; });
    else if (!p) $('#stimStatus').textContent = 'Full screen is not available here. Rotate the device or enlarge the window instead.';
  });
  document.addEventListener('fullscreenchange', sizeStage);

  // ---------- boot ----------
  let startTab = 'analyze';
  try { const s = localStorage.getItem('ocutrace-tab'); if (tabs.includes(s)) startTab = s; } catch (e) {}
  loadSynthetic();
  showTab(startTab);
  (async () => {
    state.busy = true;
    const samples = await trackSynthetic();
    state.busy = false; $('#prog').hidden = true;
    showResult(samples, state.src.label, true);
    renderFrame();
  })();
})();
