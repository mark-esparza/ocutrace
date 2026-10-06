// Checks the recording check and the Eye-Tracking-BIDS export, including a zip that standard tools open.
// Usage: node test/export.test.js
const OT = require('../src/export.js');
const zlib = require('zlib'), fs = require('fs'), os = require('os'), path = require('path'), { execFileSync } = require('child_process');

let failures = 0;
function check(name, ok, got) { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (got ${got})`); if (!ok) failures++; }

// ---------- recording check ----------
{
  const good = OT.recordingCheck({ luma: 140, glare: 0.004, radius: 30, contrast: 70, validPct: 0.99, dts: new Array(600).fill(1000 / 60).map(v => v / 1000), saccadic: false });
  check('recording check: a good clip passes', good.status === 'ok', good.items.map(i => i.key + ':' + i.status).join(' '));
  const dim = OT.recordingCheck({ luma: 40, glare: 0.06, radius: 14, contrast: 25 });
  const st = k => dim.items.find(i => i.key === k).status;
  check('recording check: dark room fails', st('light') === 'fail', st('light'));
  check('recording check: glasses glare warns', st('glare') === 'warn', st('glare'));
  check('recording check: small iris warns', st('size') === 'warn', st('size'));
  check('recording check: every flagged item carries advice', dim.items.filter(i => i.status !== 'ok').every(i => i.advice.length > 20), 'advice present');
  const dts = []; for (let i = 0; i < 600; i++) dts.push((i % 10 === 0 ? 2 : 1) / 60);
  const jit = OT.recordingCheck({ dts, saccadic: true });
  check('recording check: dropped frames flagged', jit.items.find(i => i.key === 'timing').status !== 'ok', jit.items.find(i => i.key === 'timing').value);
  check('recording check: 60 fps saccade task notes peak velocity', !!jit.items.find(i => i.key === 'rate'), 'rate item present');
}

// ---------- BIDS export ----------
{
  const fs_ = 60, T0 = 1.2, plan = OT.makePlan('sacH', 10), N = Math.ceil((T0 + plan.duration + 0.5) * fs_);
  const samples = [];
  let goal = 0;
  for (let i = 0; i < N; i++) {
    const t = i / fs_, st = plan.stepAt(t - T0 - 0.2); if (st && t - T0 - 0.2 >= 0) goal = st.goal.x;
    const blink = t > 5 && t < 5.15;
    samples.push({ t, x: blink ? NaN : goal, y: blink ? NaN : 0, ok: !blink, x2: goal, y2: 0, ok2: true });
  }
  const res = OT.analyze(samples);
  const files = OT.bidsFiles(samples, res, { sub: 'P01', task: 'sacH', plan, t0: T0, eyes: ['right', 'left'], source: 'test', measuresCsv: 'a,b\n1,2\n' });
  const names = files.map(f => f.path);
  const stem = 'sub-P01/beh/sub-P01_task-sacH_recording-eye';
  for (const n of [`${stem}1_physio.tsv.gz`, `${stem}1_physio.json`, `${stem}1_physioevents.tsv.gz`, `${stem}1_physioevents.json`, `${stem}2_physio.tsv.gz`, `${stem}2_physio.json`, 'dataset_description.json'])
    check(`BIDS: has ${n.split('/').pop()}`, names.includes(n), names.includes(n));
  const side = JSON.parse(files.find(f => f.path === `${stem}1_physio.json`).text);
  const required = ['PhysioType', 'RecordedEye', 'SamplingFrequency', 'StartTime', 'Columns'];
  check('BIDS: sidecar has the required fields', required.every(k => k in side) && side.PhysioType === 'eyetrack', required.filter(k => !(k in side)).join(',') || 'all present');
  check('BIDS: columns in the required order', JSON.stringify(side.Columns) === JSON.stringify(['timestamp', 'x_coordinate', 'y_coordinate', 'pupil_size']), side.Columns.join(','));
  check('BIDS: coordinate units given', side.x_coordinate.Units === 'deg' && side.y_coordinate.Units === 'deg', side.x_coordinate.Units);
  check('BIDS: recorded eyes', side.RecordedEye === 'right' && JSON.parse(files.find(f => f.path === `${stem}2_physio.json`).text).RecordedEye === 'left', 'right, left');
  const rows = files.find(f => f.path === `${stem}1_physio.tsv.gz`).text.trim().split('\n');
  check('BIDS: one headerless row per frame, 4 columns', rows.length === N && rows.every(r => r.split('\t').length === 4) && !/[a-z]/i.test(rows[0].replace(/n\/a/g, '')), `${rows.length} rows`);
  check('BIDS: lost frames written as n/a', rows.some(r => r.split('\t')[1] === 'n/a'), 'n/a present');
  const evSide = JSON.parse(files.find(f => f.path === `${stem}1_physioevents.json`).text);
  check('BIDS: events sidecar names its onset source', evSide.OnsetSource === 'timestamp', evSide.OnsetSource);
  const ev = files.find(f => f.path === `${stem}1_physioevents.tsv.gz`).text.trim().split('\n').map(r => r.split('\t'));
  check('BIDS: events sorted by onset', ev.every((r, k) => k === 0 || +r[0] >= +ev[k - 1][0]), `${ev.length} events`);
  check('BIDS: stimulus steps, saccades and tracking loss all present', ['stimulus', 'saccade', 'tracking_lost', 'task'].every(t => ev.some(r => r[2] === t)), [...new Set(ev.map(r => r[2]))].join(','));
  check('BIDS: task start sits on the beep', ev.some(r => r[2] === 'task' && Math.abs(+r[0] - T0 * 1000) < 0.01), T0 * 1000);
  check('BIDS: event durations in seconds', ev.filter(r => r[2] === 'task').every(r => Math.abs(+r[1] - plan.duration) < 0.001), ev.find(r => r[2] === 'task')[1]);

  // Zip with gzip members, then open with standard tools.
  const entries = files.map(f => ({ path: 'ocutrace-bids/' + f.path, bytes: f.gzip ? zlib.gzipSync(Buffer.from(f.text)) : Buffer.from(f.text) }));
  const zipBytes = OT.zip(entries);
  const tmp = path.join(os.tmpdir(), `ocutrace-bids-${process.pid}.zip`); fs.writeFileSync(tmp, zipBytes);
  let ok = true, msg = '';
  try { msg = execFileSync('python3', ['-c', `import zipfile,gzip,sys;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;n=[i for i in z.namelist() if i.endswith('eye1_physio.tsv.gz')][0];print(len(z.namelist()), gzip.decompress(z.read(n)).decode().count(chr(10)))`, tmp]).toString().trim(); }
  catch (e) { ok = false; msg = e.message; }
  check('zip: opens in Python with valid CRCs and gzip members', ok && msg === `${files.length} ${N}`, msg);
  let unz = ''; try { unz = execFileSync('unzip', ['-t', tmp]).toString(); } catch (e) { unz = e.message; }
  check('zip: unzip -t reports no errors', /No errors detected/.test(unz), (unz.match(/No errors detected[^\n]*/) || [unz.slice(0, 80)])[0]);
  fs.unlinkSync(tmp);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
