# Changelog

All notable changes to OcuTrace are documented here. Version numbers follow
the algorithm version written into every saved file, so a study that locks a
version can find the matching release.

## [0.3.0] - 2026-10-13

First archived release.

### Tracking
- Iris located each frame as the darkest disk against a brighter surround,
  refined to sub-pixel accuracy; blinks flagged and short gaps interpolated.
- Optional fixed facial point (a nose sticker) tracked by template matching
  and subtracted to remove head movement.
- Optional second iris for binocular recording.

### Task battery
- Stimulus screen for fixation, gaze holding, horizontal and vertical
  prosaccades, antisaccades, smooth pursuit at 0.4 Hz, optokinetic stripes and
  positional testing, with targets at known visual angles.
- Three 2 kHz start tones found in the clip's audio to align the video with
  the stimulus schedule.
- Per-task measures: saccade latency, gain and peak velocity from a tanh curve
  fit with a per-trial quality score; antisaccade errors and corrections;
  pursuit gain, lag and catch-up saccades; optokinetic gain and asymmetry;
  gaze holding drift and eye position gain (usable as a per-person
  calibration); square wave jerks and BCEA during fixation; positional onset,
  direction, duration, peak slow phase velocity and fading; adducting to
  abducting velocity ratio with both eyes.

### Quality and export
- Recording check for lighting, glare, iris size and contrast, frame timing
  and frames tracked.
- CSV export of traces and measures; Eye-Tracking-BIDS (BIDS 1.11) export that
  passes the official validator.
- Synthetic test suite run in CI on every push.

### Limits
- Checked only against synthetic recordings with known answers, not in
  patients. Not a medical device.
