# OcuTrace

OcuTrace turns a phone video of the eyes into a nystagmus and saccade recording. It is a research prototype, not a medical device, and not for diagnosis.

**Live:** https://mark-esparza.github.io/ocutrace/

## How it works

1. Record a clip with the phone camera or choose one you already have. The video is processed in the browser and never uploaded.
2. Tap the center of one iris, then a fixed point on the face (a small sticker on the nose bridge works best) so head movement cancels out.
3. Track the clip. OcuTrace charts horizontal and vertical eye position, marks fast events, and reports slow phase velocity, beat frequency, square wave jerks and tracking quality. The trace exports as CSV.

A Stimulus tab runs fixation, gaze holding, saccade, smooth pursuit and optokinetic tasks on a second screen, and a Guide tab explains how to record a clip that tracks well.

## Method

* The iris is located each frame as the darkest disk against a brighter surround, then refined to sub-pixel accuracy from the centroid of its dark pixels. Frames where iris contrast drops below 45% of the first frame are treated as blinks.
* A marked fixed point is followed by template matching and subtracted to remove head movement.
* Fast events are samples whose speed exceeds the larger of 20°/s and the median speed plus six robust standard deviations.
* Nystagmus is called when at least three fast phases go one way (70% agreement) and the median slow phase velocity between them is at least 2°/s the other way.

## Limits

* Degrees are estimated from iris size (11.7 mm iris, 12 mm eye radius) and are not calibrated against a lab tracker.
* Below about 240 fps, peak saccade speeds read low and brief saccades can be missed.
* Torsional nystagmus is not measured.
* Validated so far only on synthetic clips with known nystagmus, not on patients.

## Development

The tool is a single static `index.html` with no external dependencies. Edit the files in `src/`, then run `node build.js` to rebuild it. `node test/synthetic.test.js` renders a synthetic eye with known right-beating nystagmus and checks that the tracker and analysis recover it.
