// OcuTrace export: Eye-Tracking-BIDS files (BIDS 1.11 physio with PhysioType "eyetrack") and a small
// stored-only zip writer, so a recording leaves the browser as a standard dataset with no libraries.
// Pure functions, no DOM. Shared by the page and the Node tests.
// Copyright (c) 2026 Mark Esparza. Released under the MIT License; see LICENSE.

(function (OT) {
  const label = s => String(s).replace(/[^A-Za-z0-9]/g, '') || 'x';
  const num = (v, d) => Number.isFinite(v) ? v.toFixed(d) : 'n/a';
  const tsv = rows => rows.map(r => r.join('\t')).join('\n') + '\n';

  // samples: tracked samples (degrees, after any calibration); res: OT.analyze(samples).
  // opts: { sub, task, plan, t0, eyes: ['right'|'left'|'n/a', ...], source, fps, calibration, measuresCsv }
  function bidsFiles(samples, res, opts) {
    const sub = label(opts.sub || '01'), task = label(opts.task || 'free');
    const base = `sub-${sub}/beh/sub-${sub}_task-${task}`;
    const files = [];
    const json = (path, obj) => files.push({ path, text: JSON.stringify(obj, null, 2) + '\n' });
    json('dataset_description.json', {
      Name: 'OcuTrace eye movement recording', BIDSVersion: '1.11.0', DatasetType: 'raw', License: 'Research use; see the recording site',
      GeneratedBy: [{ Name: 'OcuTrace', Version: OT.ALGO_VERSION, CodeURL: 'https://github.com/mark-esparza/ocutrace' }],
    });
    files.push({ path: 'README', text: `Exported by OcuTrace ${OT.ALGO_VERSION} from ${opts.source || 'a video clip'}.\n` +
      'Eye position is iris rotation relative to the head (fixed facial point when marked), in degrees, estimated from iris size.\n' +
      'Pupil size is not measured. Timestamps are milliseconds from the start of the clip, corrected for slow motion.\n' });
    const eyes = opts.eyes || ['n/a'];
    const two = samples.some(s => 'ok2' in s);
    const mx2 = two ? OT.median(samples.map(s => s.ok2 ? s.x2 : NaN)) : 0, my2 = two ? OT.median(samples.map(s => s.ok2 ? s.y2 : NaN)) : 0;
    const recs = [{ n: 1, x: i => res.ok[i] ? res.x[i] : NaN, y: i => res.ok[i] ? res.y[i] : NaN, eye: eyes[0] }];
    if (two) recs.push({ n: 2, x: i => samples[i].ok2 ? samples[i].x2 - mx2 : NaN, y: i => samples[i].ok2 ? samples[i].y2 - my2 : NaN, eye: eyes[1] || 'n/a' });
    for (const rec of recs) {
      const stem = `${base}_recording-eye${rec.n}`;
      const rows = [];
      for (let i = 0; i < res.n; i++) rows.push([num(res.t[i] * 1000, 3), num(rec.x(i), 4), num(rec.y(i), 4), 'n/a']);
      files.push({ path: `${stem}_physio.tsv.gz`, text: tsv(rows), gzip: true });
      json(`${stem}_physio.json`, {
        PhysioType: 'eyetrack', RecordedEye: rec.eye, SamplingFrequency: +res.fps.toFixed(3), StartTime: 0,
        Columns: ['timestamp', 'x_coordinate', 'y_coordinate', 'pupil_size'],
        timestamp: { Description: 'Frame time from the start of the clip, corrected for slow motion capture.', Units: 'ms' },
        x_coordinate: { Description: 'Horizontal eye rotation, positive toward the subject\'s right, median position removed.', Units: 'deg' },
        y_coordinate: { Description: 'Vertical eye rotation, positive up, median position removed.', Units: 'deg' },
        pupil_size: { Description: 'Pupil diameter. Not measured by OcuTrace, so every value is n/a.', Units: 'n/a' },
        SampleCoordinateSystem: 'eye-in-head', Manufacturer: 'OcuTrace (smartphone or consumer camera video)',
        SoftwareVersions: OT.ALGO_VERSION, TaskName: opts.plan ? opts.plan.name : 'Free recording',
        OcuTraceCalibration: opts.calibration || { h: 1, v: 1 },
      });
      if (rec.n !== 1) continue;
      const ev = [];
      for (const e of res.events) ev.push([e.t * 1000, (e.tEnd - e.t) * 1000, 'saccade', `amplitude=${e.amp.toFixed(2)}deg peak=${e.peakVel.toFixed(0)}deg/s dx=${e.dx.toFixed(2)} dy=${e.dy.toFixed(2)}`]);
      for (let i = 0; i < res.n; i++) {
        if (res.ok[i]) continue;
        let j = i; while (j + 1 < res.n && !res.ok[j + 1]) j++;
        ev.push([res.t[i] * 1000, (res.t[Math.min(res.n - 1, j + 1)] - res.t[i]) * 1000, 'tracking_lost', 'blink or lost iris']);
        i = j;
      }
      if (opts.plan && opts.t0 != null) {
        ev.push([opts.t0 * 1000, opts.plan.duration * 1000, 'task', `${opts.plan.name}; start beep`]);
        opts.plan.steps.forEach((st, k) => {
          const nxt = opts.plan.steps[k + 1], dur = (nxt ? nxt.t : opts.plan.duration) - st.t;
          const g = st.goal ? ` target=${st.goal.x},${st.goal.y}deg` : '';
          ev.push([(opts.t0 + st.t) * 1000, dur * 1000, 'stimulus', `${st.label}${g}`]);
        });
      }
      ev.sort((a, b) => a[0] - b[0]);
      // onset is on the physio timestamp clock (ms); BIDS requires duration in seconds.
      files.push({ path: `${stem}_physioevents.tsv.gz`, text: tsv(ev.map(r => [num(r[0], 3), num(r[1] / 1000, 4), r[2], r[3].replace(/\t/g, ' ')])), gzip: true });
      json(`${stem}_physioevents.json`, {
        Description: 'Saccades, tracking loss and stimulus steps found or shown during the recording.',
        TaskName: opts.plan ? opts.plan.name : 'Free recording',
        Columns: ['onset', 'duration', 'trial_type', 'message'], OnsetSource: 'timestamp',
        onset: { Description: 'Event start on the physio timestamp clock.', Units: 'ms' },
        trial_type: { Levels: { saccade: 'Fast eye movement found by OcuTrace', tracking_lost: 'Frames where the iris was not tracked', task: 'Whole task, aligned by the start beep', stimulus: 'One stimulus step and its target position' } },
      });
    }
    if (opts.measuresCsv) {
      json('derivatives/ocutrace/dataset_description.json', { Name: 'OcuTrace measures', BIDSVersion: '1.11.0', DatasetType: 'derivative', GeneratedBy: [{ Name: 'OcuTrace', Version: OT.ALGO_VERSION }] });
      files.push({ path: `derivatives/ocutrace/sub-${sub}/beh/sub-${sub}_task-${task}_desc-measures.csv`, text: opts.measuresCsv });
    }
    return files;
  }

  // Minimal zip (stored entries, no compression): enough to hand a folder tree to the browser download.
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(b) { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
  function zip(entries, date = new Date()) {
    const enc = new TextEncoder();
    const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
    const dosDate = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    const chunks = [], central = []; let offset = 0;
    for (const e of entries) {
      const name = enc.encode(e.path), data = e.bytes, crc = crc32(data);
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
      h.setUint16(10, dosTime, true); h.setUint16(12, dosDate, true); h.setUint32(14, crc, true);
      h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
      chunks.push(new Uint8Array(h.buffer), name, data);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
      c.setUint16(12, dosTime, true); c.setUint16(14, dosDate, true); c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true);
      c.setUint16(28, name.length, true); c.setUint32(42, offset, true);
      central.push(new Uint8Array(c.buffer), name);
      offset += 30 + name.length + data.length;
    }
    const cdSize = central.reduce((p, a) => p + a.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    const parts = [...chunks, ...central, new Uint8Array(end.buffer)];
    const out = new Uint8Array(parts.reduce((p, a) => p + a.length, 0)); let o = 0;
    for (const a of parts) { out.set(a, o); o += a.length; }
    return out;
  }

  Object.assign(OT, { bidsFiles, zip, crc32 });
})(typeof module !== 'undefined' ? require('./tasks.js') : OT);
if (typeof module !== 'undefined') module.exports = require('./core.js');
