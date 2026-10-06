// OcuTrace page: capture, marking, tracking loop, charts, and stimulus screen.
// Copyright (c) 2026 Mark Esparza. Released under the MIT License; see LICENSE.

(() => {
  const $ = s => document.querySelector(s);
  const N = 120;               // tracking crop size, px
  const WIDE = 200;            // crop size used to size the iris at the tap
  const MAX_SECONDS = 240;

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
    iris2: null,       // the other eye, optional
    ref: null,         // {x, y}
    marking: 'iris',
    result: null,
    task: null,        // {task, plan, t0, out}
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
  function irisRadius2() { return state.iris2 ? state.iris2.r0 * (+$('#irisSize').value / 100) : 0; }
  function irisAt(x, y) {
    const side = 0.6 * Math.min(state.src.vw, state.src.vh);
    const c = cropGray(state.src.drawable, state.src.vw, state.src.vh, x, y, side, WIDE);
    const est = OT.estimateRadius(c.g, WIDE, (x - c.sx) * c.s - 0.5, (y - c.sy) * c.s - 0.5, 3, 60);
    return { x: c.sx + (est.x + 0.5) / c.s, y: c.sy + (est.y + 0.5) / c.s, r0: est.r / c.s };
  }
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
    if (state.iris2) {
      const x = state.iris2.x * k, y = state.iris2.y * k, rr = irisRadius2() * k;
      ctx.strokeStyle = '#1f8fff'; ctx.lineWidth = lw;
      ctx.beginPath(); ctx.arc(x, y, rr, 0, Math.PI * 2); ctx.stroke();
    }
    if (state.ref) {
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = lw;
      const s = 10 * lw, x = state.ref.x * k, y = state.ref.y * k;
      ctx.strokeRect(x - s / 2, y - s / 2, s, s);
    }
    $('#markSource').textContent = `${src.label}, ${src.vw} × ${src.vh}`;
    $('#trackBtn').disabled = !state.iris || state.busy;
    $('#clearRefBtn').disabled = !state.ref || state.busy;
    $('#clearEye2Btn').disabled = !state.iris2 || state.busy;
  }
  frameCanvas.addEventListener('pointerdown', e => {
    if (!state.src || state.busy || !state.marking) return;
    const rect = frameCanvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width * state.src.vw;
    const y = (e.clientY - rect.top) / rect.height * state.src.vh;
    if (state.marking === 'iris') {
      state.iris = irisAt(x, y);
      $('#irisSize').value = 100;
      state.marking = 'ref';
      $('#markStatus').textContent = 'Iris marked. Adjust the outline if it does not sit on the iris edge, then tap a fixed point or track.';
    } else if (state.marking === 'iris2') {
      state.iris2 = irisAt(x, y);
      state.marking = null;
      $('#markStatus').textContent = 'Other eye marked in blue. Both eyes will be tracked.';
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
  $('#markEye2Btn').addEventListener('click', () => { state.marking = 'iris2'; $('#markStatus').textContent = 'Tap the center of the other iris.'; renderFrame(); });
  $('#clearEye2Btn').addEventListener('click', () => { state.iris2 = null; renderFrame(); });

  // ---------- tracker ----------
  function makeIrisTracker(src, iris, r) {
    let cx = iris.x, cy = iris.y, refScore = null;
    return drawable => {
      const c = cropGray(drawable, src.vw, src.vh, cx, cy, 6 * r, N);
      const loc = OT.locateIris(c.g, N, (cx - c.sx) * c.s - 0.5, (cy - c.sy) * c.s - 0.5, r * c.s);
      const nx = c.sx + (loc.x + 0.5) / c.s, ny = c.sy + (loc.y + 0.5) / c.s;
      if (refScore === null && loc.score > 0) refScore = loc.score;
      const conf = refScore ? loc.score / refScore : 0;
      const ok = conf >= 0.45 && Math.hypot(nx - cx, ny - cy) <= 1.5 * r;
      if (ok) { cx = nx; cy = ny; }
      return { ok, x: nx, y: ny };
    };
  }
  function makeRefTracker(src, ref, r) {
    let rx = ref.x, ry = ref.y, tpl = null;
    const TH = 12, SEARCH = 16;
    return drawable => {
      const rc = cropGray(drawable, src.vw, src.vh, rx, ry, 6 * r, N);
      const gx = (rx - rc.sx) * rc.s - 0.5, gy = (ry - rc.sy) * rc.s - 0.5;
      if (!tpl) tpl = OT.cutTemplate(rc.g, N, gx, gy, TH);
      const m = OT.matchTemplate(rc.g, N, tpl, TH, gx, gy, SEARCH);
      if (!Number.isFinite(m.sad)) return { ok: false, x: rx, y: ry };
      rx = rc.sx + (m.x + 0.5) / rc.s; ry = rc.sy + (m.y + 0.5) / rc.s;
      return { ok: true, x: rx, y: ry };
    };
  }
  // Iris positions relative to the fixed point (when marked), measured from the first good frame.
  function makeTracker(src, iris, r, ref, iris2, r2) {
    const e1 = makeIrisTracker(src, iris, r), e2 = iris2 ? makeIrisTracker(src, iris2, r2) : null;
    const rt = ref ? makeRefTracker(src, ref, r) : null;
    let o1 = null, o2 = null;
    return function step(drawable) {
      const a = e1(drawable), b = e2 ? e2(drawable) : null, f = rt ? rt(drawable) : { ok: true, x: 0, y: 0 };
      const out = { ok: a.ok && f.ok };
      if (out.ok) { const ex = a.x - f.x, ey = a.y - f.y; if (!o1) o1 = { x: ex, y: ey }; out.dx = ex - o1.x; out.dy = ey - o1.y; }
      if (b) {
        out.ok2 = b.ok && f.ok;
        if (out.ok2) { const ex = b.x - f.x, ey = b.y - f.y; if (!o2) o2 = { x: ex, y: ey }; out.dx2 = ex - o2.x; out.dy2 = ey - o2.y; }
      }
      return out;
    };
  }
  function toDeg(trk, r, r2, mirrored) {
    const sx = mirrored ? 1 : -1;
    const out = trk.ok ? { x: OT.pxToDeg(sx * trk.dx, r), y: OT.pxToDeg(-trk.dy, r), ok: true } : { x: NaN, y: NaN, ok: false };
    if ('ok2' in trk) Object.assign(out, trk.ok2 ? { x2: OT.pxToDeg(sx * trk.dx2, r2), y2: OT.pxToDeg(-trk.dy2, r2), ok2: true } : { x2: NaN, y2: NaN, ok2: false });
    return out;
  }
  // Which tracked eye is the subject's right: in an unmirrored front view it is the one further left in the picture.
  function rightEyeKey() {
    if (!state.iris2) return 'a';
    const firstIsLeftInImage = state.iris.x < state.iris2.x;
    return firstIsLeftInImage !== $('#mirrored').checked ? 'a' : 'b';
  }

  async function trackSynthetic() {
    const r = irisRadius(), r2 = irisRadius2();
    const step = makeTracker(state.src, state.iris, r, state.ref, state.iris2, r2);
    const samples = [];
    for (let i = 0; i < synWave.length; i++) {
      const w = synWave[i];
      drawSynEye(w.h, w.v, w.blink);
      const d = toDeg(step(synCanvas), r, r2, false);
      samples.push({ t: w.t, ...d });
      if (i % 40 === 0) { setProgress(i / synWave.length); await sleep(0); }
    }
    drawSynEye(synWave[0].h, synWave[0].v, false);
    return samples;
  }

  function trackVideo() {
    return new Promise((resolve, reject) => {
      const r = irisRadius(), r2 = irisRadius2();
      const F = +$('#slowmo').value || 1;
      const mirrored = $('#mirrored').checked;
      const step = makeTracker(state.src, state.iris, r, state.ref, state.iris2, r2);
      const samples = [];
      const limit = Math.min(vid.duration || MAX_SECONDS * F, MAX_SECONDS * F);
      let last = -1, done = false;
      const finish = () => { if (done) return; done = true; vid.pause(); resolve(samples); };
      const handle = mediaTime => {
        if (mediaTime === last) return;
        last = mediaTime;
        samples.push({ t: mediaTime / F, ...toDeg(step(vid), r, r2, mirrored) });
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
    state.iris2 = null;
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
    state.iris = null; state.iris2 = null; state.ref = null; state.marking = 'iris';
    describeVideo();
    $('#anStart').value = ''; $('#syncStatus').textContent = '';
    if (OT.TASKS[$('#anTask').value].timed) findBeep();
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
  $('#slowmo').addEventListener('change', () => { describeVideo(); refreshResult(); });
  $('#mirrored').addEventListener('change', refreshResult);

  // ---------- task and start beep ----------
  function syncTaskFields() {
    const def = OT.TASKS[$('#anTask').value];
    $('#anAmpField').hidden = !(def.amp > 0);
    $('#anAmpVField').hidden = !def.ampV;
    $('#anStartField').hidden = $('#beepField').hidden = !def.timed;
    if (!def.timed) $('#syncStatus').textContent = '';
  }
  $('#anTask').addEventListener('change', () => {
    const def = OT.TASKS[$('#anTask').value];
    if (def.amp > 0) $('#anAmp').value = def.amp;
    if (def.ampV) $('#anAmpV').value = def.ampV;
    syncTaskFields();
    if (def.timed && state.src && state.src.kind === 'video' && !$('#anStart').value) findBeep();
    refreshResult();
  });
  $('#anAmp').addEventListener('change', refreshResult);
  $('#anAmpV').addEventListener('change', refreshResult);
  $('#anStart').addEventListener('change', () => { $('#syncStatus').textContent = $('#anStart').value ? 'Task start entered by hand.' : ''; refreshResult(); });
  $('#beepBtn').addEventListener('click', () => findBeep());
  let beepRun = 0;
  async function findBeep() {
    const status = $('#syncStatus'), run = ++beepRun;
    status.classList.remove('err');
    if (!pendingFile || !state.src || state.src.kind !== 'video') { status.textContent = 'Load a clip first. The synthetic eye has no sound.'; return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { status.textContent = 'This browser cannot read the sound track. Enter the task start by hand.'; return; }
    status.textContent = 'Listening for the start beep…';
    try {
      const buf = await pendingFile.arrayBuffer();
      const ac = new AC();
      const audio = await new Promise((res, rej) => { const p = ac.decodeAudioData(buf, res, rej); if (p && p.then) p.then(res, rej); });
      ac.close && ac.close();
      if (run !== beepRun) return;
      const ch = audio.getChannelData(0);
      const F = +$('#slowmo').value || 1;
      let hit = OT.findStartBeep(ch, audio.sampleRate, { slowFactor: 1 });
      if (!hit && F > 1) hit = OT.findStartBeep(ch, audio.sampleRate, { slowFactor: F });
      if (!hit) { status.textContent = 'No start beep found. Check that the clip has sound, or enter the time the third beep sounds.'; status.classList.add('err'); return; }
      $('#anStart').value = hit.t0.toFixed(3);
      status.textContent = `Start beep found at ${hit.t0.toFixed(2)} s into the clip.`;
      refreshResult();
    } catch (e) {
      if (run !== beepRun) return;
      status.textContent = 'The sound track could not be read. Enter the time the third beep sounds.'; status.classList.add('err');
    }
  }
  function taskContext() {
    const task = $('#anTask').value, def = OT.TASKS[task];
    const plan = OT.makePlan(task, +$('#anAmp').value || def.amp, def.ampV ? +$('#anAmpV').value || def.ampV : 0);
    const F = +$('#slowmo').value || 1;
    const start = parseFloat($('#anStart').value);
    const synthetic = state.src && state.src.kind === 'synthetic';
    const t0 = def.timed && !synthetic && Number.isFinite(start) ? start / F : null;
    return { task, def, plan: def.timed ? plan : null, t0 };
  }
  function refreshResult() { if (state.samples && !state.busy) showResult(state.samples, state.resultLabel, state.resultSynthetic); }

  // ---------- results ----------
  const SLOW_DIR = { 'Right-beating': 'leftward', 'Left-beating': 'rightward', 'Upbeat': 'downward', 'Downbeat': 'upward' };
  const FAST_DIR = { 'Right-beating': 'rightward', 'Left-beating': 'leftward', 'Upbeat': 'upward', 'Downbeat': 'downward' };
  function showResult(samples, label, synthetic) {
    state.samples = samples; state.resultLabel = label; state.resultSynthetic = synthetic;
    const res = OT.analyze(samples);
    state.result = res;
    const tc = taskContext();
    const out = tc.task !== 'free' || samples.some(s => s.ok2) ? OT.taskMeasures(tc.task, samples, res, tc.plan, tc.t0, { rightEye: rightEyeKey() }) : null;
    state.task = { ...tc, out };
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
    if (out && out.headline) {
      call.textContent = out.headline;
      $('#verdictSub').textContent = `${out.sub} A prototype reading, not a diagnosis.`;
      $('#verdictBox').className = 'verdict' + (/nystagmus/i.test(out.headline) && !/^No /.test(out.headline) ? ' found' : '');
    }
    const axisName = ny.axis === 'h' ? 'horizontal' : 'vertical';
    let rows = [
      ['Slow phase velocity', fmt(Math.abs(ny.medSpv)), '°/s', ny.spv.length ? `Median of ${ny.spv.length} slow phases, ${axisName}` : 'No clean slow phases between events'],
      ['Beat frequency', fmt(ny.beatHz), 'beats/s', ny.fastCount ? `${ny.fastCount} ${FAST_DIR[ny.direction]} fast phases` : 'No fast phases found'],
      ['Square wave jerks', fmt(res.swjPerMin, 0), 'per min', `${res.swj} found. Read only from fixation recordings`],
      ['Fast events', String(res.events.length), '', res.events.length ? `Median peak speed ${fmt(res.medianPeakVel, 0)}°/s` : 'None above threshold'],
      ['Frames tracked', fmt(res.validPct * 100, 0), '%', `${res.n} frames over ${fmt(res.duration, 1)} s`],
      ['Frame rate', fmt(res.fps, 0), 'fps', synthetic ? 'Synthetic clip' : 'After slow motion correction'],
    ];
    if (out) {
      const digits = u => u === 'ms' || u === '%' || u === 'per min' ? 0 : u === '' || u === 'deg²' ? 2 : 1;
      const taskRows = out.measures.map(mm => [mm.label, mm.text || fmt(mm.value, mm.digits ?? digits(mm.unit)), Number.isFinite(mm.value) && !mm.text ? mm.unit : '', mm.basis]);
      rows = tc.task === 'free' ? [...rows, ...taskRows] : [...taskRows, ...rows.slice(4)];
    }
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

    const td = $('#trialDetails');
    if (out && out.trials && out.trials.length) {
      td.hidden = false;
      $('#trialSummary').textContent = `Trials (${out.trials.length})`;
      const head = $('#trialTable thead'), body = $('#trialTable tbody');
      head.innerHTML = ''; body.innerHTML = '';
      const hr = document.createElement('tr');
      out.trialCols.forEach(c => { const th = document.createElement('th'); th.textContent = c; hr.appendChild(th); });
      head.appendChild(hr);
      out.trials.forEach(row => { const tr = document.createElement('tr'); row.forEach(v => { const c = document.createElement('td'); c.textContent = v; tr.appendChild(c); }); body.appendChild(tr); });
    } else td.hidden = true;

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
    // Target trace when the clip is lined up with a stimulus plan.
    const tk = state.task, tgt = tk && tk.plan && tk.t0 != null ? t.map(tt => tk.plan.goal(tt - tk.t0)) : null;
    if (tgt) for (const g of tgt) if (g) { limH = Math.max(limH, Math.abs(g.x)); limV = Math.max(limV, Math.abs(g.y)); }
    limH = Math.ceil(limH * 1.1); limV = Math.ceil(limV * 1.1);
    const ink = css('--graph-label'), ink2 = css('--graph-sep'), red = css('--graph-ev'), blue = css('--graph-v'), pen = css('--graph-h');
    const minor = css('--graph-minor'), major = css('--graph-major'), bg = css('--graph-bg');
    const family = css('--font') || 'sans-serif';
    const chans = [
      { name: 'Horizontal', unit: '°', h: 132, lo: -limH, hi: limH, data: res.x, color: pen, width: 1.7, up: 'R', down: 'L', target: tgt && tgt.map(g => g ? g.x : NaN) },
      { name: 'Vertical', unit: '°', h: 92, lo: -limV, hi: limV, data: res.y, color: blue, width: 1.5, up: 'Up', down: 'Dn', target: tgt && tgt.map(g => g ? g.y : NaN) },
      { name: 'Events', h: 32 },
      { name: 'Speed', unit: '°/s', h: 104, lo: 0, hi: spMax * 1.08, data: res.sp, color: pen, width: 1.3 },
    ];
    $('#legendTarget').hidden = !tgt;
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
      if (c.target) {
        ctx.strokeStyle = css('--graph-target'); ctx.lineWidth = 1.4; ctx.setLineDash([5, 3]); ctx.beginPath();
        let on = false;
        for (let i = 0; i < t.length; i++) {
          const v = c.target[i];
          if (!Number.isFinite(v)) { on = false; continue; }
          const px = X(t[i]), py = Y(Math.max(c.lo, Math.min(c.hi, v)));
          if (on) ctx.lineTo(px, py); else { ctx.moveTo(px, py); on = true; }
        }
        ctx.stroke(); ctx.setLineDash([]);
      }
      if (tk && tk.t0 != null && tk.t0 >= t0 && tk.t0 <= t1) { ctx.setLineDash([2, 3]); vline(X(tk.t0), top, bot, css('--graph-target'), 1); ctx.setLineDash([]); }
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
    const smp = state.samples, two = smp.some(s => 'ok2' in s);
    const mx2 = two ? OT.median(smp.map(s => s.ok2 ? s.x2 : NaN)) : 0, my2 = two ? OT.median(smp.map(s => s.ok2 ? s.y2 : NaN)) : 0;
    const tk = state.task, timed = tk && tk.plan && tk.t0 != null;
    const head = ['t_s', 'h_deg', 'v_deg', 'valid', 'interpolated', 'speed_deg_s', 'event'];
    if (two) head.push('h2_deg', 'v2_deg', 'valid2');
    if (timed) head.push('task_t_s', 'target_h_deg', 'target_v_deg');
    const rows = [head.join(',')];
    for (let i = 0; i < res.n; i++) {
      const r = [res.t[i].toFixed(4), res.ok[i] ? res.x[i].toFixed(3) : '', res.ok[i] ? res.y[i].toFixed(3) : '', res.ok[i] ? 1 : 0, res.interp[i] ? 1 : 0, Number.isFinite(res.sp[i]) ? res.sp[i].toFixed(1) : '', evAt[i]];
      if (two) { const s = smp[i]; r.push(s.ok2 ? (s.x2 - mx2).toFixed(3) : '', s.ok2 ? (s.y2 - my2).toFixed(3) : '', s.ok2 ? 1 : 0); }
      if (timed) { const tt = res.t[i] - tk.t0, g = tk.plan.goal(tt); r.push(tt.toFixed(4), g ? g.x.toFixed(2) : '', g ? g.y.toFixed(2) : ''); }
      rows.push(r.join(','));
    }
    return rows.join('\n') + '\n';
  }
  const q = v => { const t = String(v == null ? '' : v); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  function buildSummary() {
    const res = state.result, tk = state.task; if (!res) return '';
    const F = +$('#slowmo').value || 1;
    const meta = [
      ['algorithm_version', OT.ALGO_VERSION], ['source', state.resultLabel], ['task', tk.task], ['task_name', OT.TASKS[tk.task].name],
      ['task_start_clip_s', tk.t0 != null ? (tk.t0 * F).toFixed(3) : ''], ['target_amplitude_deg', tk.plan && tk.plan.amp ? tk.plan.amp : ''],
      ['capture_speed_factor', F], ['frame_rate_fps', res.fps.toFixed(1)], ['duration_s', res.duration.toFixed(2)], ['frames_tracked_pct', (res.validPct * 100).toFixed(1)],
      ['eyes_tracked', state.samples.some(s => 'ok2' in s) ? 2 : 1], ['fixed_point', state.ref ? 'yes' : 'no'], ['mirrored', $('#mirrored').checked ? 'yes' : 'no'],
      ['generated', new Date().toISOString()],
    ];
    const lines = ['section,name,value,unit,basis'];
    meta.forEach(([k, v]) => lines.push(['recording', k, v, '', ''].map(q).join(',')));
    const measures = tk.out ? tk.out.measures : [];
    const base = [
      { label: 'Nystagmus', text: res.nyst.present ? res.nyst.direction : 'None', unit: '', basis: '' },
      { label: 'Slow phase velocity', value: Math.abs(res.nyst.medSpv), unit: 'deg/s', basis: 'Dominant axis, whole clip' },
      { label: 'Beat frequency', value: res.nyst.beatHz, unit: 'beats/s', basis: '' },
      { label: 'Square wave jerks', value: res.swjPerMin, unit: 'per min', basis: `${res.swj} found` },
      { label: 'Fast events', value: res.events.length, unit: '', basis: `Median peak speed ${fmt(res.medianPeakVel, 0)} deg/s` },
    ];
    [...measures, ...base].forEach(mm => lines.push(['measure', mm.label, mm.text || (Number.isFinite(mm.value) ? +mm.value.toFixed(4) : ''), (mm.unit || '').replace('°', 'deg'), mm.basis].map(q).join(',')));
    if (tk.out && tk.out.trials) {
      lines.push('', ['trial', ...tk.out.trialCols].map(q).join(','));
      tk.out.trials.forEach((r, k) => lines.push([k + 1, ...r].map(q).join(',')));
    }
    return lines.join('\n') + '\n';
  }
  function csvName(kind = 'trace') {
    const base = (state.src && state.src.kind === 'video' ? state.src.label.replace(/\.[^.]+$/, '') : 'synthetic-eye').replace(/[^\w-]+/g, '-').slice(0, 60);
    const task = state.task && state.task.task !== 'free' ? `-${state.task.task}` : '';
    return `ocutrace-${base}${task}-${kind}-${new Date().toISOString().slice(0, 10)}.csv`;
  }
  $('#saveSummary').addEventListener('click', async () => {
    if (!downloads || !state.result) return;
    try { await downloads.save({ filename: csvName('measures'), data: buildSummary() }); $('#csvStatus').textContent = 'Measures saved.'; }
    catch (e) { $('#csvStatus').textContent = e && e.code === 'declined' ? 'Save cancelled.' : 'Saving is not available here.'; }
  });
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
    $('#saveSummary').hidden = true;
    window.claude.use('downloads').then(d => { downloads = d; $('#saveCsv').hidden = $('#saveSummary').hidden = !d; }).catch(() => {});
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
  let stimRun = null, wakeLock = null, actx = null;
  const PRE_ROLL = 3; // seconds of instructions before the first target; the beeps end it
  // Screen geometry: degrees of visual angle to canvas pixels, from the screen's physical width and distance.
  function geometry() {
    const W = +$('#scrW').value, D = +$('#scrD').value;
    // iOS reports the portrait width even when rotated, so take the side that matches the current orientation.
    const sw = screen.width || window.innerWidth, sh = screen.height || window.innerHeight;
    const cssW = window.innerWidth > window.innerHeight ? Math.max(sw, sh) : Math.min(sw, sh);
    const cmPerCss = W > 0 && cssW > 0 ? W / cssW : NaN;
    const dpr = window.devicePixelRatio || 1;
    const halfW = stim.clientWidth * cmPerCss / 2, halfH = stim.clientHeight * cmPerCss / 2;
    const deg = cm => Math.atan(cm / D) * 180 / Math.PI;
    return {
      ok: Number.isFinite(cmPerCss) && D > 0 && halfW > 0,
      maxH: deg(halfW - 1), maxV: deg(halfH - 1),
      px: d => D * Math.tan(d * Math.PI / 180) / cmPerCss * dpr,
      pxPerDeg: D * Math.PI / 180 / cmPerCss * dpr,
    };
  }
  // The largest standard amplitude that fits this screen, so the analysis knows where targets were.
  function fitAmp(task, geo) {
    const def = OT.TASKS[task];
    if (!(def.amp > 0) || !geo.ok) return { amp: def.amp, ampV: def.ampV || 0 };
    const amp = Math.max(1, Math.min(def.amp, Math.floor(task === 'sacV' ? geo.maxV : geo.maxH)));
    const ampV = def.ampV ? Math.max(1, Math.min(def.ampV, amp, Math.floor(geo.maxV))) : 0;
    return { amp, ampV };
  }
  const planFor = (task, geo) => { const f = fitAmp(task, geo); return OT.makePlan(task, f.amp, f.ampV); };
  function describeGeometry() {
    const task = $('#task').value, def = OT.TASKS[task], geo = geometry();
    const el = $('#geomStatus');
    if (!geo.ok) { el.textContent = 'Enter the screen width and viewing distance so targets land at known angles.'; return; }
    if (!(def.amp > 0)) { el.textContent = task === 'okn' ? `Stripes move at ${OT.makePlan('okn').oknSpeed}°/s at this distance.` : 'This task has no target amplitude.'; return; }
    const plan = planFor(task, geo), a = plan.amp;
    const v = task === 'gaze' ? `, ±${plan.ampV}° vertical` : '';
    const small = a < def.amp || (def.ampV && plan.ampV < def.ampV);
    el.textContent = `Targets at ±${a}°${v}${small ? '. The standard angles do not fit this screen; full screen or a closer seat helps' : ''}. Enter ${a}°${v ? ` and ${plan.ampV}°` : ''} in Analyze.`;
  }
  ['#task', '#scrW', '#scrD'].forEach(sel => $(sel).addEventListener('input', () => { describeGeometry(); if (!stimRun) drawIdle(); }));
  function sizeStage() {
    const dpr = window.devicePixelRatio || 1;
    stim.width = Math.round(stim.clientWidth * dpr); stim.height = Math.round(stim.clientHeight * dpr);
    describeGeometry();
    if (!stimRun) drawIdle();
  }
  new ResizeObserver(sizeStage).observe(stage);
  function drawIdle() {
    if (!stim.width) return;
    const geo = geometry(), task = $('#task').value;
    drawStim(0, planFor(task, geo), geo);
  }
  function wrapText(ctx, text, x, y, maxW, lh) {
    const words = text.split(' '), lines = []; let line = '';
    for (const w of words) { const t = line ? line + ' ' + w : w; if (ctx.measureText(t).width > maxW && line) { lines.push(line); line = w; } else line = t; }
    lines.push(line);
    lines.forEach((l, k) => ctx.fillText(l, x, y + (k - (lines.length - 1) / 2) * lh));
  }
  const INSTRUCT = {
    fixation: 'Keep looking at the dot',
    gaze: 'Follow the dot and hold your eyes on it',
    sacH: 'Look at the dot as soon as it jumps',
    sacV: 'Look at the dot as soon as it jumps',
    anti: 'When a dot appears, look away from it, the same distance on the other side',
    pursuit: 'Follow the dot smoothly with your eyes',
    okn: 'Look at the stripes as they pass. Do not follow one stripe',
    positional: 'Examiner: follow the steps on the screen. A beep marks each step',
  };
  function drawStim(t, plan, geo) {
    const ctx = stim.getContext('2d'), W = stim.width, H = stim.height, cx = W / 2, cy = H / 2;
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    const pxd = geo.ok ? geo.px : (d => d / 15 * W * 0.42);
    const s = Math.max(6, geo.ok ? 0.25 * geo.pxPerDeg : Math.min(W, H) * 0.018);
    const font = (px, w = 600) => `${w} ${Math.round(px)}px ${css('--font') || 'sans-serif'}`;
    if (t < 0) {
      ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = font(Math.min(W, H) * 0.06);
      wrapText(ctx, INSTRUCT[plan.task] || '', cx, cy - H * 0.12, W * 0.85, Math.min(W, H) * 0.08);
      ctx.font = font(Math.min(W, H) * 0.12, 700);
      ctx.fillText(String(Math.ceil(-t)), cx, cy + H * 0.2);
      return 'Get ready';
    }
    const sh = plan.show(t);
    const X = x => cx + pxd(x), Y = y => cy - pxd(y);
    if (sh.kind === 'dot') {
      ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(X(sh.x), Y(sh.y), s, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#e0261b'; ctx.beginPath(); ctx.arc(X(sh.x), Y(sh.y), s * 0.35, 0, Math.PI * 2); ctx.fill();
    } else if (sh.kind === 'cross') {
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = Math.max(2, s * 0.35);
      ctx.beginPath(); ctx.moveTo(cx - s * 1.4, cy); ctx.lineTo(cx + s * 1.4, cy); ctx.moveTo(cx, cy - s * 1.4); ctx.lineTo(cx, cy + s * 1.4); ctx.stroke();
    } else if (sh.kind === 'stripes') {
      const ppd = geo.ok ? geo.pxPerDeg : W / 30;
      const sw = Math.max(12, 2.5 * ppd), seg = plan.stepAt(t);
      const off = (((t - seg.t) * plan.oknSpeed * ppd * sh.dir) % (2 * sw) + 2 * sw) % (2 * sw);
      ctx.fillStyle = '#ffffff';
      for (let x = -2 * sw + off; x < W + 2 * sw; x += 2 * sw) ctx.fillRect(x, 0, sw, H);
    } else if (sh.kind === 'text') {
      ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = font(Math.min(W, H) * 0.065);
      wrapText(ctx, sh.text, cx, cy, W * 0.86, Math.min(W, H) * 0.09);
    } else if (sh.kind === 'blank') {
      ctx.fillStyle = '#555'; ctx.fillRect(0, 0, W, H);
    }
    return sh.label;
  }
  function tone(at, freq, dur, gain = 0.5) {
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = 'sine'; o.frequency.value = freq;
    g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(gain, at + 0.004);
    g.gain.setValueAtTime(gain, at + dur - 0.004); g.gain.linearRampToValueAtTime(0, at + dur);
    o.connect(g); g.connect(actx.destination); o.start(at); o.stop(at + dur + 0.02);
  }
  async function startStim() {
    stopStim();
    // Safari only allows sound started directly inside the tap, so open the audio before any await.
    const AC = window.AudioContext || window.webkitAudioContext;
    let resumed = null;
    try { if (AC) { actx = new AC(); resumed = actx.resume(); } } catch (e) { actx = null; }
    const task = $('#task').value, geo = geometry(), plan = planFor(task, geo);
    try { if (navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { wakeLock = null; }
    try { if (resumed) await resumed; } catch (e) { actx = null; }
    let t0perf;
    if (actx && actx.state === 'running') {
      const T = actx.currentTime + PRE_ROLL, { freq, gap, dur, count } = OT.SYNC;
      for (let k = 0; k < count; k++) tone(T - (count - 1 - k) * gap, freq, dur);
      // Step beeps for the examiner-led positional test.
      if (task === 'positional') plan.steps.slice(1).forEach(st => tone(T + st.t, 1000, 0.15, 0.35));
      tone(T + plan.duration, 660, 0.25, 0.35);
      const lat = (actx.outputLatency || 0) + (actx.baseLatency || 0);
      t0perf = performance.now() + (T - actx.currentTime + lat) * 1000;
      $('#stimStatus').textContent = plan.amp ? `Targets at ±${plan.amp}°${plan.task === 'gaze' ? `, ±${plan.ampV}° vertical` : ''}. Enter ${plan.amp}°${plan.task === 'gaze' ? ` and ${plan.ampV}°` : ''} in Analyze.` : '';
    } else {
      t0perf = performance.now() + PRE_ROLL * 1000;
      $('#stimStatus').textContent = 'Sound is not available, so there is no start beep. Note when the first target appears and enter it in Analyze.';
    }
    const frame = () => {
      const t = (performance.now() - t0perf) / 1000;
      const label = drawStim(t, plan, geo);
      hud.textContent = t < 0 ? `${OT.TASKS[task].name} · starts in ${Math.ceil(-t)} s` : `${label} · ${Math.max(0, plan.duration - t).toFixed(0)} s left`;
      if (t >= plan.duration) { stopStim(true); hud.textContent = 'Done. Stop the phone recording.'; return; }
      stimRun = requestAnimationFrame(frame);
    };
    stimRun = requestAnimationFrame(frame);
  }
  // A manual stop silences any beeps still scheduled; a natural end lets the end tone finish.
  function stopStim(natural) {
    if (stimRun) cancelAnimationFrame(stimRun);
    stimRun = null; hud.textContent = 'Ready';
    if (actx) { const a = actx; actx = null; setTimeout(() => a.close().catch(() => {}), natural === true ? 800 : 0); }
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
    drawIdle();
  }
  $('#stimStart').addEventListener('click', startStim);
  $('#stimStop').addEventListener('click', stopStim);
  $('#task').addEventListener('change', stopStim);
  $('#stimFull').addEventListener('click', () => {
    const p = stage.requestFullscreen ? stage.requestFullscreen() : null;
    if (p && p.catch) p.catch(() => { $('#stimStatus').textContent = 'Full screen is not available here. Rotate the device or enlarge the window instead.'; });
    else if (!p) $('#stimStatus').textContent = 'Full screen is not available here. Rotate the device or enlarge the window instead.';
  });
  document.addEventListener('fullscreenchange', sizeStage);

  // ---------- boot ----------
  $('#algoVersion').textContent = OT.ALGO_VERSION;
  syncTaskFields();
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
