# OcuTrace

OcuTrace turns a phone video of the eyes into a nystagmus and saccade recording. It is a research prototype, not a medical device, and not for diagnosis.

**Live:** https://mark-esparza.github.io/ocutrace/

**Author:** Mark Esparza ([ORCID 0009-0000-5171-102X](https://orcid.org/0009-0000-5171-102X)) · [mark-esparza.github.io](https://mark-esparza.github.io)

> **Copyright © 2026 Mark Esparza.** OcuTrace is open-source software released under the
> [MIT License](LICENSE). See [NOTICE](NOTICE) for method credits and the medical-use
> disclaimer. If you use OcuTrace in research, please cite it (see [CITATION.cff](CITATION.cff)).

## How it works

1. Record a clip with the phone camera or choose one you already have. The video is processed in the browser and never uploaded.
2. Tap the center of one iris, then a fixed point on the face (a small sticker on the nose bridge works best) so head movement cancels out. Optionally tap the other eye to track both.
3. Choose the task the clip shows and track it. OcuTrace charts horizontal and vertical eye position with the stimulus target overlaid, marks fast events, reports the measures for that task with a per-trial table, and exports the trace and the measures as CSV.

## Task battery

The Stimulus tab runs each task on a second screen, with targets placed at known angles from the screen width and viewing distance. Every task starts with three 2 kHz beeps; the analysis finds them in the clip's sound and lines the video up with the targets, so latency and timing can be measured.

| Task | Measures |
| --- | --- |
| Fixation, 15 s | Square wave jerks per minute, drift, fixation stability (BCEA), primary position nystagmus |
| Gaze holding, right, left, up, down | Drift toward center, beat direction and frequency per position, eye position gain |
| Prosaccades, horizontal and vertical | Latency, gain and peak velocity per trial |
| Antisaccades | Direction error rate, corrected errors, latency of correct responses |
| Smooth pursuit, 0.4 Hz | Velocity gain, lag, catch-up saccades per second |
| Optokinetic, right then left | Slow phase velocity, gain and asymmetry |
| Positional (Dix-Hallpike, supine roll) | Onset, direction, duration, peak slow phase velocity and fading per position |
| Free recording | Nystagmus direction, slow phase velocity, beat frequency, square wave jerks |

With both eyes marked, the adducting to abducting peak velocity ratio for internuclear ophthalmoplegia is added to any task. The algorithm version is written into every saved file so a study can lock one version.

## Method

* The iris is located each frame as the darkest disk against a brighter surround, then refined to sub-pixel accuracy from the centroid of its dark pixels. Frames where iris contrast drops below 45% of the first frame are treated as blinks.
* A marked fixed point is followed by template matching and subtracted to remove head movement.
* Fast events are samples whose speed exceeds the larger of 20°/s and the median speed plus six robust standard deviations.
* Nystagmus is called when at least three fast phases go one way (70% agreement) and the median slow phase velocity between them is at least 2°/s the other way.
* Saccade latency runs from the target step to saccade onset (speed rising past 20% of its peak); responses under 80 ms count as anticipatory. Pursuit gain is fitted at the target frequency with catch-up saccades, found on velocity minus the fit, left out.

## Limits

* Degrees are estimated from iris size (11.7 mm iris, 12 mm eye radius) and are not calibrated against a lab tracker. The gaze holding task reports an eye position gain that checks the scale for each person.
* Below about 240 fps, peak saccade speeds read low and brief saccades can be missed.
* Latency includes the stimulus screen's display and sound delay, so keep the same devices across sessions.
* Torsional nystagmus is not measured.
* Validated so far only on synthetic clips and traces with known answers, not on patients.

## Development

The tool is a single static `index.html` with no external dependencies. Edit the files in `src/` (`core.js` tracker and analysis, `tasks.js` task plans and measures, `app.js` page logic, `page.html` markup), then run `node build.js` to rebuild it. `node test/synthetic.test.js` renders a synthetic eye with known right-beating nystagmus and checks that the tracker and analysis recover it. `node test/tasks.test.js` checks every task measure, the binocular ratio and the start beep detector against synthetic traces with known answers. Both exit non-zero if any check fails. CI runs it on every push, along with a check that `index.html` was rebuilt from `src/`.

## Citation

If you use this software, please cite it using the metadata in [CITATION.cff](CITATION.cff). GitHub shows a "Cite this repository" button with formatted citations.

## License

MIT License. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
