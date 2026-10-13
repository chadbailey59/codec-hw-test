# codec-hw-test

A public page that checks whether a browser's hardware video codec claims are
true. It's live at https://codec-hw-test.chadbailey.net. The summary of all
submissions is at `/results.html`, and the raw JSON is at `/api/results`.

This file covers working on the code. Deployment steps and the location of
test-run findings are in `DEPLOY.md`, which is gitignored. Read it if it
exists. Add new findings where it says, not here.

## How the test works

For each video codec profile the browser can negotiate, `site/app.js` compares
two predictions with two observations:

- Predictions: `mediaCapabilities` `encodingInfo` and `decodingInfo` with type
  `webrtc` (the `powerEfficient` value is the probe daily-js logs at join), and
  WebCodecs `isConfigSupported` with `prefer-hardware` and `prefer-software`.
- Observations: a WebRTC loopback call pinned to the codec, read from
  `encoderImplementation`, `decoderImplementation`, and `powerEfficient*`
  stats, plus timed WebCodecs encode and decode runs.

The call holds 1280x720 with `degradationPreference: 'maintain-resolution'`, so
a software encoder isn't compared at a smaller size.

## Layout

The project has no build step and no dependencies outside the Python standard
library.

- `site/app.js`: the test. Constants at the top set size, frame rate, bitrate,
  and call length. Sections are marked with `// ----` banners.
- `site/index.html`, `site/style.css`: the test page.
- `site/results.html`, `site/results.js`: the summary of stored submissions.
- `server.py`: static file server plus `POST` and `GET /api/results`. It
  appends submissions to `data/results.jsonl`, caps bodies at 1 MB, and
  rate-limits each client IP (`CF-Connecting-IP`) to 20 posts an hour.
- `tools/vtcaps.swift`: macOS VideoToolbox ground truth. Run
  `swift tools/vtcaps.swift` on a Mac.
- `Dockerfile`, `docker-compose.yml`: the container. `deploy.sh` is gitignored;
  see `DEPLOY.md`.

## Run it locally

1. Run `python3 server.py`. It serves on port 8080 and writes to `./data/`.
2. Open http://localhost:8080 in the browser you want to test. Camera access
   needs a secure context, and `localhost` counts as one.

If you want to watch one codec in `chrome://webrtc-internals`, open
`/?debug`. Debug mode runs one codec, keeps the call open (120 seconds by
default), and logs every encoder or decoder change with its time. Every run
logs changes to the console with the prefix `[codec-hw-test]`.

## Deploy

Read `DEPLOY.md`. If it doesn't exist, you don't have deploy access.

## Gotchas

- Chromium only exposes implementation names and `powerEfficient*` stats when
  the page has camera permission. The page asks for the camera for that reason,
  then sends a canvas copy of the camera so every codec gets the same input.
  Don't remove the camera request.
- Only Chromium reports `encoderImplementation`, `decoderImplementation`, and
  `powerEfficient*`. Safari and Firefox return none of them, so their WebRTC
  checks show "can't tell".
- Chromium wraps platform codecs as `ExternalDecoder (X)`. Classify by the
  inner name. `MojoVideoDecoder` stays unknown and falls back to the
  `powerEfficient` stat.
- WebCodecs timings and WebRTC timings differ a lot, so per-frame time is a
  hint, not proof of hardware use.
- If you change the submission format, bump `VERSION` in `site/app.js` and
  keep `site/results.js` able to read older rows in `data/results.jsonl`.
- Don't run `pkill -f server.py` from a shell whose own command line contains
  that string. It kills the shell. Use `pkill -f '^python3 server.py'` or the
  PID instead.
