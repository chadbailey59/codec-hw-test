// Video codec hardware test.
//
// For each video codec the browser can negotiate, compare two kinds of signal:
//
//   Predictions (what the browser says):
//     - navigator.mediaCapabilities.encodingInfo()/decodingInfo() with
//       type 'webrtc'. powerEfficient is the browser's claim of hardware use.
//       This is the probe daily-js logs at join.
//     - WebCodecs isConfigSupported() with hardwareAcceleration
//       'prefer-hardware' and 'prefer-software'.
//
//   Observations (what ran):
//     - A WebRTC loopback call pinned to the codec. outbound-rtp and
//       inbound-rtp stats name the encoder and decoder implementation
//       (encoderImplementation, decoderImplementation) and report
//       powerEfficientEncoder/Decoder. Chromium only exposes these when the
//       page has camera permission, which is why the test asks for it.
//     - A WebCodecs encode and decode run with each hardwareAcceleration
//       value. Chromium fails 'prefer-hardware' when no hardware codec
//       matches, and the per-frame time is a second, independent hint.
//
// Implementation names are the closest a web page gets to the platform API
// that did the work (VideoToolbox, Media Foundation, VA-API, MediaCodec, or a
// software library such as libvpx, OpenH264, dav1d, or FFmpeg).

const WIDTH = 1280;
const HEIGHT = 720;
const FPS = 30;
const BITRATE = 2_500_000;
const CALL_MS = 10_000;
const SAMPLE_MS = 1_000;
const WEBCODECS_FRAMES = 60;
const VERSION = 2;
// Extra runs, one per scalability mode, added after the base test for each
// codec. Chromium only keeps a hardware encoder when the platform encoder
// supports the requested mode, so each mode can land on a different encoder.
const SCALABILITY_TESTS = [
  { base: 'VP9-0', modes: ['L1T1', 'L1T2', 'L1T3', 'L2T3_KEY', 'L3T3_KEY', 'L3T3'] },
  { base: 'AV1-0', modes: ['L1T3'] },
  { base: 'H264-42e01f', modes: ['L1T3'] },
  { base: 'H264-64001f', modes: ['L1T3'] },
  { base: 'H264-640c1f', modes: ['L1T3'] },
];
// VP8 simulcast: three encodings at quarter, half, and full size, each L1T3.
// The bitrates add up to BITRATE.
const SIMULCAST_ENCODINGS = [
  { rid: 'q', scaleResolutionDownBy: 4, maxBitrate: 150_000 },
  { rid: 'h', scaleResolutionDownBy: 2, maxBitrate: 500_000 },
  { rid: 'f', scaleResolutionDownBy: 1, maxBitrate: 1_850_000 },
];

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let report = null;

// ---------------------------------------------------------------------------
// Environment

async function collectEnvironment() {
  const env = {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: navigator.deviceMemory,
    browser: detectBrowser(),
    gpu: webglRenderer(),
    screen: `${screen.width}x${screen.height}@${window.devicePixelRatio}`,
  };
  if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
    try {
      env.uaData = await navigator.userAgentData.getHighEntropyValues([
        'platform', 'platformVersion', 'architecture', 'bitness', 'model', 'fullVersionList',
      ]);
    } catch {
      // Not fatal; the user agent string still identifies the browser.
    }
  }
  if (navigator.gpu && navigator.gpu.requestAdapter) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter && adapter.info) {
        env.webgpu = {
          vendor: adapter.info.vendor,
          architecture: adapter.info.architecture,
          device: adapter.info.device,
          description: adapter.info.description,
        };
      }
    } catch {
      // WebGPU is optional.
    }
  }
  return env;
}

function detectBrowser() {
  const ua = navigator.userAgent;
  const brands = navigator.userAgentData ? navigator.userAgentData.brands.map((b) => b.brand) : [];
  if (/Firefox\//.test(ua)) return { name: 'Firefox', engine: 'Gecko', version: ua.match(/Firefox\/([\d.]+)/)[1] };
  if (brands.includes('Microsoft Edge') || /Edg\//.test(ua)) return { name: 'Edge', engine: 'Chromium', version: (ua.match(/Edg\/([\d.]+)/) || [])[1] };
  if (brands.includes('Google Chrome') || /Chrome\//.test(ua)) return { name: 'Chrome', engine: 'Chromium', version: (ua.match(/Chrome\/([\d.]+)/) || [])[1] };
  if (/Safari\//.test(ua)) return { name: 'Safari', engine: 'WebKit', version: (ua.match(/Version\/([\d.]+)/) || [])[1] };
  return { name: 'Other', engine: 'unknown' };
}

function webglRenderer() {
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    if (!gl) return null;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      vendor: gl.getParameter(ext ? ext.UNMASKED_VENDOR_WEBGL : gl.VENDOR),
      renderer: gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Browser hardware report (optional ground truth)
//
// Firefox's about:support raw data and Chrome's chrome://gpu report include
// extensions, changed settings, and file paths. Keep only the video codec
// lines and send nothing else.

let groundTruth = null;

function setupReportBox() {
  const b = detectBrowser();
  if (b.engine === 'Gecko') {
    $('reportFirefox').hidden = false;
  } else if (b.engine === 'Chromium') {
    $('reportChromium').hidden = false;
    if (b.name === 'Edge') {
      $('gpuUrl').textContent = 'edge://gpu';
      $('gpuCopy').dataset.copy = 'edge://gpu';
    }
  } else {
    // Safari has no hardware report page, so hide the whole section.
    $('reportBox').hidden = true;
  }

  for (const btn of document.querySelectorAll('button.copy')) {
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(btn.dataset.copy);
        btn.textContent = 'Copied';
      } catch {
        btn.textContent = 'Select and copy it';
      }
      setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
    });
  }

  $('pasteReport').addEventListener('click', async () => {
    try {
      $('groundTruth').value = await navigator.clipboard.readText();
      updateReport();
    } catch {
      $('reportStatus').textContent = "The browser didn't allow reading the clipboard. Click in the box and paste with Command+V or Ctrl+V.";
    }
  });
  $('reportFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    $('groundTruth').value = (await file.text()).slice(0, 5_000_000);
    updateReport();
  });
  $('groundTruth').addEventListener('input', updateReport);
}

function updateReport() {
  const text = $('groundTruth').value.trim();
  groundTruth = text ? extractGroundTruth(text) : null;
  $('reportPreview').hidden = !groundTruth;
  if (!text) {
    $('reportStatus').textContent = '';
  } else if (!groundTruth) {
    $('reportStatus').textContent = "This doesn't look like the report. Check that you copied the whole report, then paste it again.";
  } else {
    $('reportStatus').textContent = `Found ${groundTruth.lines.length} video codec ${groundTruth.lines.length === 1 ? "line" : "lines"}. Only ${groundTruth.lines.length === 1 ? "this line is" : "these lines are"} sent:`;
    $('reportPreview').textContent = groundTruth.lines.join('\n');
  }
}

// Returns { source, lines } or null.
function extractGroundTruth(text) {
  let json = null;
  try { json = JSON.parse(text); } catch { /* plain text report */ }

  // Firefox about:support raw data: media.codecSupportInfo is one line per
  // codec, for example "H264 SWDEC HWDEC".
  if (json && json.media && typeof json.media.codecSupportInfo === 'string') {
    const lines = json.media.codecSupportInfo.split('\n').map((l) => l.trim()).filter(Boolean);
    return lines.length ? { source: 'firefox-about-support', lines } : null;
  }

  // Chromium chrome://gpu: "Decode h264 baseline : 64x64 to 4096x4096 pixels".
  // The downloaded report is JSON, so flatten it into lines first. Entries are
  // often { description, value } objects.
  const candidates = [];
  if (json) {
    const walk = (v) => {
      if (Array.isArray(v)) return v.forEach(walk);
      if (v && typeof v === 'object') {
        if (typeof v.description === 'string' && typeof v.value === 'string') {
          candidates.push(`${v.description}: ${v.value}`);
          return;
        }
        Object.values(v).forEach(walk);
      } else if (typeof v === 'string') {
        candidates.push(...v.split('\n'));
      }
    };
    walk(json);
  } else {
    candidates.push(...text.split('\n'));
  }
  const lines = [...new Set(candidates
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => /^(Decode|Encode) [a-z0-9]/i.test(l))
    .map((l) => l.slice(0, 200)))];
  return lines.length ? { source: 'chromium-gpu', lines } : null;
}

// ---------------------------------------------------------------------------
// Codec list

function fmtpParams(line) {
  const out = {};
  for (const part of (line || '').split(';')) {
    const [k, v] = part.split('=');
    if (k) out[k.trim()] = (v || '').trim();
  }
  return out;
}

// One test per distinct codec profile. Returns the RTP codec objects to pin
// on each side, the mediaCapabilities content type, and the WebCodecs codec
// string.
function buildTests() {
  const send = RTCRtpSender.getCapabilities ? RTCRtpSender.getCapabilities('video').codecs : [];
  const recv = RTCRtpReceiver.getCapabilities ? RTCRtpReceiver.getCapabilities('video').codecs : [];
  const tests = new Map();

  const describe = (c) => {
    const mime = c.mimeType;
    const p = fmtpParams(c.sdpFmtpLine);
    switch (mime.toLowerCase()) {
      case 'video/vp8':
        return { key: 'VP8', label: 'VP8', contentType: 'video/VP8', wc: 'vp8' };
      case 'video/vp9': {
        const profile = p['profile-id'] || '0';
        if (!['0', '2'].includes(profile)) return null;
        return {
          key: `VP9-${profile}`, label: `VP9 profile ${profile}`,
          contentType: `video/VP9;profile-id=${profile}`,
          wc: profile === '0' ? 'vp09.00.31.08' : 'vp09.02.31.10',
        };
      }
      case 'video/h264': {
        if (p['packetization-mode'] !== '1') return null;
        const plid = (p['profile-level-id'] || '').toLowerCase();
        if (!plid) return null;
        return {
          key: `H264-${plid}`, label: `H.264 ${h264ProfileName(plid)} (${plid})`,
          contentType: `video/H264;packetization-mode=1;profile-level-id=${plid}`,
          // Level 4.0 (0x28) for WebCodecs. The RTP level, often 3.1, is exactly
          // 1280x720 at 30 fps, and Firefox rejects encodes at that limit.
          wc: `avc1.${plid.slice(0, 4).toUpperCase()}28`,
        };
      }
      case 'video/h265': {
        const profile = p['profile-id'] || '1';
        if (profile !== '1') return null;
        return { key: 'H265-1', label: 'H.265 main', contentType: 'video/H265', wc: 'hvc1.1.6.L93.B0' };
      }
      case 'video/av1': {
        const profile = p.profile || '0';
        if (profile !== '0') return null;
        return { key: 'AV1-0', label: 'AV1 main', contentType: 'video/AV1', wc: 'av01.0.08M.08' };
      }
      default:
        return null;
    }
  };

  for (const [list, side] of [[send, 'sendCodec'], [recv, 'recvCodec']]) {
    for (const c of list) {
      const d = describe(c);
      if (!d) continue;
      const t = tests.get(d.key) || { ...d };
      if (!t[side]) t[side] = c;
      tests.set(d.key, t);
    }
  }
  for (const { base, modes } of SCALABILITY_TESTS) {
    const t = tests.get(base);
    if (!t) continue;
    for (const mode of modes) {
      const key = `${base}-${mode}`;
      tests.set(key, { ...t, key, label: `${t.label}, ${mode}`, scalabilityMode: mode });
    }
  }
  const vp8 = tests.get('VP8');
  if (vp8) {
    const key = 'VP8-simulcast-L1T3';
    tests.set(key, { ...vp8, key, label: 'VP8, 3-layer simulcast, L1T3', scalabilityMode: 'L1T3', simulcast: true });
  }
  return [...tests.values()];
}

function h264ProfileName(plid) {
  const idc = plid.slice(0, 2);
  const iop = plid.slice(2, 4);
  if (idc === '42') return parseInt(iop, 16) & 0x40 ? 'constrained baseline' : 'baseline';
  if (idc === '4d') return 'main';
  if (idc === '64') return 'high';
  if (idc === 'f4') return 'high 4:4:4';
  return `profile ${idc}`;
}

// ---------------------------------------------------------------------------
// Predictions

async function mediaCapabilitiesProbe(test, direction) {
  const mc = navigator.mediaCapabilities;
  const fn = mc && (direction === 'encode' ? mc.encodingInfo : mc.decodingInfo);
  if (!fn) return { available: false };
  try {
    const video = { contentType: test.contentType, width: WIDTH, height: HEIGHT, bitrate: BITRATE, framerate: FPS };
    if (test.scalabilityMode) {
      // encodingInfo takes the mode itself. decodingInfo only asks whether the
      // stream has spatial layers.
      if (direction === 'encode') video.scalabilityMode = test.scalabilityMode;
      else video.spatialScalability = !test.scalabilityMode.startsWith('L1');
    }
    const r = await fn.call(mc, { type: 'webrtc', video });
    return { available: true, supported: r.supported, smooth: r.smooth, powerEfficient: r.powerEfficient };
  } catch (e) {
    return { available: true, error: e.name };
  }
}

async function webCodecsSupport(test, direction, accel) {
  const ctor = direction === 'encode' ? window.VideoEncoder : window.VideoDecoder;
  if (!ctor || !ctor.isConfigSupported) return { available: false };
  const config = { codec: test.wc, hardwareAcceleration: accel, codedWidth: WIDTH, codedHeight: HEIGHT };
  if (direction === 'encode') {
    Object.assign(config, { width: WIDTH, height: HEIGHT, bitrate: BITRATE, framerate: FPS });
    if (test.scalabilityMode) config.scalabilityMode = test.scalabilityMode;
    delete config.codedWidth;
    delete config.codedHeight;
  }
  try {
    const r = await ctor.isConfigSupported(config);
    return { available: true, supported: r.supported };
  } catch (e) {
    return { available: true, error: e.name };
  }
}

// ---------------------------------------------------------------------------
// Video source

let source = null;

async function startSource() {
  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext('2d');
  const video = $('preview');
  let camera = null;
  let cameraError = null;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: WIDTH }, height: { ideal: HEIGHT }, frameRate: { ideal: FPS } },
    });
    camera = stream.getVideoTracks()[0];
    video.srcObject = stream;
    await video.play().catch(() => {});
  } catch (e) {
    cameraError = e.name;
  }

  // Draw camera frames (or a moving pattern) plus noise onto a canvas, so
  // every codec sees the same continuously changing 1280x720 input.
  let n = 0;
  const timer = setInterval(() => {
    if (camera && video.readyState >= 2) {
      ctx.drawImage(video, 0, 0, WIDTH, HEIGHT);
    } else {
      ctx.fillStyle = `hsl(${(n * 3) % 360} 55% 45%)`;
      ctx.fillRect(0, 0, WIDTH, HEIGHT);
    }
    ctx.fillStyle = '#fff';
    ctx.font = '64px sans-serif';
    ctx.fillText(String(n), 40 + (n * 7) % (WIDTH - 200), 120 + (n * 3) % (HEIGHT - 160));
    for (let i = 0; i < 40; i++) {
      ctx.fillStyle = `rgba(${(i * 53 + n * 17) % 255},${(i * 97) % 255},${(n * 11) % 255},0.6)`;
      ctx.fillRect((i * 131 + n * 13) % WIDTH, (i * 71 + n * 5) % HEIGHT, 24, 24);
    }
    n++;
  }, 1000 / FPS);

  const track = canvas.captureStream(FPS).getVideoTracks()[0];
  source = { canvas, track, camera, cameraError, timer };
  return source;
}

function stopSource() {
  if (!source) return;
  clearInterval(source.timer);
  source.track.stop();
  if (source.camera) source.camera.stop();
  source = null;
}

// ---------------------------------------------------------------------------
// Observation 1: WebRTC loopback call

// opts.durationMs: how long to keep the call up (default CALL_MS).
// opts.onSample(sample): called for every stats sample.
// opts.shouldStop(): return true to end the call early.
async function loopbackCall(test, opts = {}) {
  const durationMs = opts.durationMs || CALL_MS;
  if (!test.sendCodec || !test.recvCodec) {
    return { skipped: !test.sendCodec ? 'browser cannot send this codec' : 'browser cannot receive this codec' };
  }
  const pc1 = new RTCPeerConnection();
  const pc2 = new RTCPeerConnection();
  pc1.onicecandidate = (e) => e.candidate && pc2.addIceCandidate(e.candidate).catch(() => {});
  pc2.onicecandidate = (e) => e.candidate && pc1.addIceCandidate(e.candidate).catch(() => {});

  try {
    const sendEncodings = test.simulcast ? SIMULCAST_ENCODINGS.map((e) => ({ ...e })) : [{ maxBitrate: BITRATE }];
    if (test.scalabilityMode) for (const e of sendEncodings) e.scalabilityMode = test.scalabilityMode;
    const tx = pc1.addTransceiver(source.track, { direction: 'sendonly', sendEncodings });
    if (!tx.setCodecPreferences) return { skipped: 'setCodecPreferences unavailable' };
    tx.setCodecPreferences([test.sendCodec]);

    await pc1.setLocalDescription(await pc1.createOffer());
    await pc2.setRemoteDescription(pc1.localDescription);
    const rx = pc2.getTransceivers()[0];
    if (rx && rx.setCodecPreferences) {
      try { rx.setCodecPreferences([test.recvCodec]); } catch { /* answer still negotiates the single offered codec */ }
    }
    await pc2.setLocalDescription(await pc2.createAnswer());
    await pc1.setRemoteDescription(test.simulcast
      ? { type: 'answer', sdp: acceptSimulcast(pc2.localDescription.sdp) }
      : pc2.localDescription);

    // Keep 1280x720 so every encoder is compared at the same size. Some
    // browsers use a software encoder for small frames, and a short call
    // would otherwise start small while bandwidth estimation ramps up.
    try {
      const params = tx.sender.getParameters();
      params.degradationPreference = 'maintain-resolution';
      await tx.sender.setParameters(params);
    } catch { /* not supported everywhere */ }

    // Sample every 200 ms for the first 3 seconds, so a codec fallback right
    // after the call starts is caught, then every SAMPLE_MS.
    const samples = [];
    const start = performance.now();
    const seen = { encode: null, decode: null };
    while (performance.now() - start < durationMs && !(opts.shouldStop && opts.shouldStop())) {
      await sleep(performance.now() - start < 3000 ? 200 : SAMPLE_MS);
      const sample = await sampleStats(pc1, pc2, Math.round(performance.now() - start));
      samples.push(sample);
      logImplementationChanges(test, sample, seen);
      if (opts.onSample) opts.onSample(sample);
    }
    return summarizeCall(samples);
  } catch (e) {
    return { error: `${e.name}: ${e.message}` };
  } finally {
    pc1.close();
    pc2.close();
  }
}

// Chromium can't receive simulcast, so its answer drops the rid lines and the
// sender falls back to one encoding. Add them back to the answer pc1 sees so
// pc1 runs all three encoders. pc2 then decodes only one of the streams.
function acceptSimulcast(sdp) {
  if (/a=simulcast:recv/.test(sdp)) return sdp;
  const rids = SIMULCAST_ENCODINGS.map((e) => e.rid);
  const lines = [...rids.map((r) => `a=rid:${r} recv`), `a=simulcast:recv ${rids.join(';')}`];
  return sdp.replace(/\r\n$/, '') + '\r\n' + lines.join('\r\n') + '\r\n';
}

// Log each encoder or decoder change to the web inspector console, with the
// time since the call started.
function logImplementationChanges(test, sample, seen) {
  for (const dir of ['encode', 'decode']) {
    const impl = sample[dir] && sample[dir].implementation;
    if (impl && impl !== seen[dir]) {
      const msg = `[codec-hw-test] ${test.label} ${dir} at ${sample.t} ms: ${seen[dir] || '(start)'} -> ${impl}`;
      if (/fallback/i.test(impl)) console.warn(msg); else console.info(msg);
      debugLog(msg);
      seen[dir] = impl;
    }
  }
}

async function sampleStats(pc1, pc2, t) {
  const [s1, s2] = await Promise.all([pc1.getStats(), pc2.getStats()]);
  let out = null;
  let inb = null;
  let codec = null;
  // With simulcast there is one outbound-rtp per encoding. Report the largest.
  let streams = 0;
  s1.forEach((s) => {
    if (s.type !== 'outbound-rtp' || s.kind !== 'video') return;
    streams++;
    if (!out || (s.frameWidth || 0) > (out.frameWidth || 0)) out = s;
  });
  s2.forEach((s) => { if (s.type === 'inbound-rtp' && s.kind === 'video') inb = s; });
  if (out && out.codecId) codec = s1.get(out.codecId);
  return {
    t,
    codec: codec ? `${codec.mimeType} ${codec.sdpFmtpLine || ''}`.trim() : undefined,
    encode: out && {
      implementation: out.encoderImplementation,
      powerEfficient: out.powerEfficientEncoder,
      frames: out.framesEncoded,
      totalTime: out.totalEncodeTime,
      width: out.frameWidth,
      height: out.frameHeight,
      fps: out.framesPerSecond,
      limitation: out.qualityLimitationReason,
      scalabilityMode: out.scalabilityMode,
      streams,
    },
    decode: inb && {
      implementation: inb.decoderImplementation,
      powerEfficient: inb.powerEfficientDecoder,
      frames: inb.framesDecoded,
      totalTime: inb.totalDecodeTime,
      width: inb.frameWidth,
      height: inb.frameHeight,
      fps: inb.framesPerSecond,
    },
  };
}

function summarizeCall(samples) {
  const last = samples[samples.length - 1] || {};
  const side = (name) => {
    const list = samples.map((s) => s[name]).filter(Boolean);
    const end = list[list.length - 1] || {};
    // Every implementation seen during the call, in order. A change means the
    // browser switched encoders, for example a hardware-to-software fallback.
    const implementations = [...new Set(list.map((s) => s.implementation).filter(Boolean))];
    const msPerFrame = end.frames ? round((end.totalTime * 1000) / end.frames, 2) : undefined;
    return {
      implementation: end.implementation,
      implementations,
      implementationClass: classifyImplementation(end.implementation),
      fallbackFrom: ((end.implementation || '').match(/\(fallback from:\s*(.*)\)$/) || [])[1],
      powerEfficient: end.powerEfficient,
      frames: end.frames,
      msPerFrame,
      resolution: end.width ? `${end.width}x${end.height}` : undefined,
      fps: end.fps,
      limitation: end.limitation,
      scalabilityMode: end.scalabilityMode,
      streams: end.streams,
    };
  };
  return { codec: last.codec, encode: side('encode'), decode: side('decode'), samples };
}

// Classify a WebRTC implementation name. Chromium wraps platform codecs as
// "ExternalEncoder (X)" or "ExternalDecoder (X)", where X can still be a
// software codec, so the inner names decide. Returns 'hardware', 'software',
// 'mixed', or 'unknown'.
const HW_NAMES = /videotoolbox|mediafoundation|\bmf|d3d11|d3d12|dxva|vaapi|v4l2|mediacodec|nvenc|nvdec|qsv|amf|vdavideodecoder|videoencodeaccelerator|vea\b|hardware/i;
const SW_NAMES = /libvpx|openh264|ffmpeg|dav1d|libaom|libgav1|svt|vpxvideo|software|fallback/i;

function classifyImplementation(name) {
  if (!name) return 'unknown';
  // Chromium reports a runtime fallback as "FFmpeg (fallback from:
  // ExternalDecoder (D3D11VideoDecoder))". The codec before the parenthesis
  // is the one running now; the one inside it failed or was rejected.
  const fallback = name.match(/^(.*?)\s*\(fallback from:/);
  if (fallback) return classifyImplementation(fallback[1]);
  const inner = name.match(/\(([^)]*)\)/);
  const parts = (inner ? inner[1] : name).split(/[,\s]+/).filter(Boolean);
  const classes = new Set(parts.map((p) => (HW_NAMES.test(p) ? 'hardware' : SW_NAMES.test(p) ? 'software' : null)).filter(Boolean));
  if (classes.size === 0) {
    if (HW_NAMES.test(name)) return 'hardware';
    if (SW_NAMES.test(name)) return 'software';
    return 'unknown';
  }
  return classes.size > 1 ? 'mixed' : [...classes][0];
}

// ---------------------------------------------------------------------------
// Observation 2: WebCodecs encode and decode runs

// Encode with each hardwareAcceleration value, then decode the software
// encoder's output (or the hardware encoder's, if software failed) with each
// value, so both decoder runs get identical input.
async function webCodecsRuns(test) {
  if (!window.VideoEncoder || !window.VideoFrame) {
    const na = { available: false };
    return { encode: { hardware: na, software: na }, decode: { hardware: na, software: na } };
  }
  const encSw = await webCodecsEncode(test, 'prefer-software');
  const encHw = await webCodecsEncode(test, 'prefer-hardware');
  const input = encSw.chunks ? encSw : encHw.chunks ? encHw : null;
  const noInput = { skipped: 'no encoded input' };
  const decode = {
    hardware: input ? await webCodecsDecode(test, 'prefer-hardware', input.chunks, input.decoderConfig) : noInput,
    software: input ? await webCodecsDecode(test, 'prefer-software', input.chunks, input.decoderConfig) : noInput,
  };
  for (const e of [encSw, encHw]) {
    delete e.chunks;
    delete e.decoderConfig;
  }
  return { encode: { hardware: encHw, software: encSw }, decode };
}

function withTimeout(promise, ms, label) {
  return Promise.race([promise, sleep(ms).then(() => { throw new Error(`${label} timed out`); })]);
}

async function webCodecsEncode(test, accel) {
  const chunks = [];
  let decoderConfig = null;
  let failure = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      chunks.push({ type: chunk.type, timestamp: chunk.timestamp, data });
      if (meta && meta.decoderConfig) decoderConfig = meta.decoderConfig;
    },
    error: (e) => { failure = `${e.name}: ${e.message}`; },
  });
  const config = { codec: test.wc, width: WIDTH, height: HEIGHT, bitrate: BITRATE, framerate: FPS, hardwareAcceleration: accel, latencyMode: 'realtime' };
  if (test.scalabilityMode) config.scalabilityMode = test.scalabilityMode;
  if (test.wc.startsWith('avc1')) config.avc = { format: 'annexb' };
  if (test.wc.startsWith('hvc1')) config.hevc = { format: 'annexb' };
  try {
    encoder.configure(config);
    const start = performance.now();
    for (let i = 0; i < WEBCODECS_FRAMES && !failure; i++) {
      const frame = new VideoFrame(source.canvas, { timestamp: Math.round((i * 1e6) / FPS) });
      encoder.encode(frame, { keyFrame: i === 0 });
      frame.close();
      // Let the encoder drain so the queue doesn't grow without bound.
      while (encoder.encodeQueueSize > 4 && !failure) await sleep(1);
    }
    if (!failure) await withTimeout(encoder.flush(), 20_000, 'encode');
    const elapsed = performance.now() - start;
    if (failure) return { ok: false, error: failure };
    return { ok: true, msPerFrame: round(elapsed / WEBCODECS_FRAMES, 2), frames: chunks.length, chunks, decoderConfig };
  } catch (e) {
    return { ok: false, error: failure || `${e.name}: ${e.message}` };
  } finally {
    if (encoder.state !== 'closed') encoder.close();
  }
}

async function webCodecsDecode(test, accel, chunks, decoderConfig) {
  if (!window.VideoDecoder) return { available: false };
  let failure = null;
  let frames = 0;
  const decoder = new VideoDecoder({
    output: (frame) => { frames++; frame.close(); },
    error: (e) => { failure = `${e.name}: ${e.message}`; },
  });
  try {
    const config = { ...(decoderConfig || { codec: test.wc }), hardwareAcceleration: accel, codedWidth: WIDTH, codedHeight: HEIGHT };
    decoder.configure(config);
    const start = performance.now();
    for (const c of chunks) {
      if (failure) break;
      decoder.decode(new EncodedVideoChunk({ type: c.type, timestamp: c.timestamp, data: c.data }));
      while (decoder.decodeQueueSize > 4 && !failure) await sleep(1);
    }
    if (!failure) await withTimeout(decoder.flush(), 20_000, 'decode');
    const elapsed = performance.now() - start;
    if (failure) return { ok: false, error: failure };
    return { ok: true, msPerFrame: round(elapsed / Math.max(frames, 1), 2), frames };
  } catch (e) {
    return { ok: false, error: failure || `${e.name}: ${e.message}` };
  } finally {
    if (decoder.state !== 'closed') decoder.close();
  }
}

// ---------------------------------------------------------------------------
// Verdicts

// The browser's prediction for one direction: mediaCapabilities powerEfficient,
// which is the signal daily-js logs.
function predicted(mc) {
  if (!mc || !mc.available || mc.error || mc.supported === undefined) return 'unknown';
  if (!mc.supported) return 'unsupported';
  return mc.powerEfficient ? 'hardware' : 'software';
}

// What ran, from the WebRTC implementation name, then the powerEfficient stat.
function observed(side) {
  if (!side) return { value: 'unknown', source: null };
  if (side.implementationClass === 'hardware' || side.implementationClass === 'software') {
    return { value: side.implementationClass, source: 'implementation' };
  }
  if (typeof side.powerEfficient === 'boolean') {
    return { value: side.powerEfficient ? 'hardware' : 'software', source: 'powerEfficient stat' };
  }
  return { value: 'unknown', source: null };
}

function verdict(pred, obs) {
  if (pred === 'unknown' || obs.value === 'unknown' || pred === 'unsupported') return null;
  return pred === obs.value;
}

// ---------------------------------------------------------------------------
// Run

async function run(event) {
  event.preventDefault();
  $('run').disabled = true;
  $('download').disabled = true;
  $('rows').innerHTML = '';
  $('summary').hidden = true;
  $('cameraWarning').hidden = true;
  $('resultsSection').hidden = false;
  const status = (msg) => { $('status').textContent = msg; };

  try {
    status('Collecting browser details…');
    const env = await collectEnvironment();
    $('env').textContent = JSON.stringify(env, null, 2);

    if (!window.RTCPeerConnection || !RTCRtpSender.getCapabilities) {
      status('This browser lacks the WebRTC features the test needs.');
      return;
    }

    status('Starting the camera…');
    await startSource();
    env.camera = source.camera ? source.camera.label || 'camera' : `unavailable (${source.cameraError})`;
    if (!source.camera) {
      // Chromium hides encoder and decoder names without camera permission, so
      // most checks can't be verified.
      $('cameraWarning').hidden = false;
    }

    const tests = buildTests();
    const progress = $('progress');
    progress.hidden = false;
    progress.max = tests.length;
    progress.value = 0;

    const results = [];
    for (const [i, test] of tests.entries()) {
      status(`Testing ${test.label} (${i + 1} of ${tests.length})…`);
      const result = {
        key: test.key,
        label: test.label,
        contentType: test.contentType,
        webCodecsCodec: test.wc,
        scalabilityMode: test.scalabilityMode,
        simulcast: test.simulcast || undefined,
        // Chromium lists the modes each codec accepts in getCapabilities().
        scalabilityModeAdvertised: test.scalabilityMode && test.sendCodec && test.sendCodec.scalabilityModes
          ? test.sendCodec.scalabilityModes.includes(test.scalabilityMode) : undefined,
        canSend: !!test.sendCodec,
        canReceive: !!test.recvCodec,
        predictions: {
          encode: {
            mediaCapabilities: await mediaCapabilitiesProbe(test, 'encode'),
            webCodecsHardware: await webCodecsSupport(test, 'encode', 'prefer-hardware'),
            webCodecsSoftware: await webCodecsSupport(test, 'encode', 'prefer-software'),
          },
          decode: {
            mediaCapabilities: await mediaCapabilitiesProbe(test, 'decode'),
            webCodecsHardware: await webCodecsSupport(test, 'decode', 'prefer-hardware'),
            webCodecsSoftware: await webCodecsSupport(test, 'decode', 'prefer-software'),
          },
        },
      };
      result.webrtc = await loopbackCall(test);
      result.webCodecs = await webCodecsRuns(test);
      for (const dir of ['encode', 'decode']) {
        const pred = predicted(result.predictions[dir].mediaCapabilities);
        const obs = observed(result.webrtc[dir]);
        result[`${dir}Verdict`] = { predicted: pred, observed: obs.value, observedFrom: obs.source, agree: verdict(pred, obs) };
        // pc2 decodes whichever simulcast stream it latches onto, often the
        // smallest, so the decode side says nothing about this test.
        if (test.simulcast && dir === 'decode') result.decodeVerdict.agree = null;
      }
      results.push(result);
      renderResult(result);
      progress.value = i + 1;
    }

    report = {
      version: VERSION,
      finishedAt: new Date().toISOString(),
      name: $('name').value.trim() || undefined,
      model: $('model').value.trim() || undefined,
      groundTruth: groundTruth || undefined,
      environment: env,
      results,
    };
    renderSummary(report);
    $('download').disabled = false;

    if ($('share').checked) {
      status('Sending results…');
      const res = await fetch('/api/results', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(stripSamples(report)),
      });
      status(res.ok ? 'Done. Thanks, your results were sent.' : `Done, but sending failed (HTTP ${res.status}). Use Download results and send the file to Chad.`);
    } else {
      status('Done. Results were not sent.');
    }
  } catch (e) {
    status(`The test stopped: ${e.name}: ${e.message}`);
    console.error(e);
  } finally {
    stopSource();
    $('progress').hidden = true;
    $('run').disabled = false;
  }
}

// Per-second samples make the upload large; keep them only in the download.
function stripSamples(r) {
  return { ...r, results: r.results.map((x) => ({ ...x, webrtc: { ...x.webrtc, samples: undefined } })) };
}

// ---------------------------------------------------------------------------
// Debug mode (?debug): run one codec, keep the call open, log every sample.

const DEBUG = new URLSearchParams(location.search).has('debug');
let debugStop = false;

function debugLog(msg) {
  if (!DEBUG) return;
  const el = $('debugLog');
  el.textContent += `${new Date().toISOString().slice(11, 23)}  ${msg}\n`;
  el.scrollTop = el.scrollHeight;
}

function setupDebugMode() {
  if (!DEBUG) return;
  $('debugPanel').hidden = false;
  const tests = window.RTCRtpSender && RTCRtpSender.getCapabilities ? buildTests() : [];
  for (const t of tests) {
    const opt = document.createElement('option');
    opt.value = t.key;
    opt.textContent = t.label + (t.sendCodec && t.recvCodec ? '' : ' (one direction only)');
    $('debugCodec').append(opt);
  }
  $('debugStart').addEventListener('click', async () => {
    const test = tests.find((t) => t.key === $('debugCodec').value);
    const seconds = Math.max(5, Number($('debugHold').value) || 120);
    $('debugStart').disabled = true;
    $('debugStop').disabled = false;
    $('run').disabled = true;
    debugStop = false;
    $('debugLog').textContent = '';
    try {
      debugLog(`Starting ${test.label} for up to ${seconds} s. Open edge://webrtc-internals or chrome://webrtc-internals in another tab now.`);
      for (const dir of ['encode', 'decode']) {
        const mc = await mediaCapabilitiesProbe(test, dir);
        debugLog(`mediaCapabilities ${dir}: ${JSON.stringify(mc)}`);
      }
      await startSource();
      debugLog(`Camera: ${source.camera ? source.camera.label || 'on' : 'unavailable (' + source.cameraError + ')'}`);
      let last = '';
      const result = await loopbackCall(test, {
        durationMs: seconds * 1000,
        shouldStop: () => debugStop,
        onSample: (smp) => {
          const e = smp.encode || {};
          const d = smp.decode || {};
          const line = `send ${e.width || '?'}x${e.height || '?'} ${e.fps ?? '?'}fps pe=${e.powerEfficient} | recv ${d.width || '?'}x${d.height || '?'} ${d.fps ?? '?'}fps pe=${d.powerEfficient} frames=${d.frames ?? '?'}`;
          // Only log the per-sample line when something besides frame counts changes.
          const key = line.replace(/frames=\d+/, '');
          if (key !== last) { debugLog(`t=${smp.t} ms  ${line}`); last = key; }
        },
      });
      debugLog(`Done. Encoders seen: ${(result.encode && result.encode.implementations || []).join(' -> ') || 'none'}. Decoders seen: ${(result.decode && result.decode.implementations || []).join(' -> ') || 'none'}.`);
      if (result.error || result.skipped) debugLog(`Call problem: ${result.error || result.skipped}`);
      console.log('[codec-hw-test] full debug result', result);
    } catch (e) {
      debugLog(`Error: ${e.name}: ${e.message}`);
    } finally {
      stopSource();
      $('debugStart').disabled = false;
      $('debugStop').disabled = true;
      $('run').disabled = false;
    }
  });
  $('debugStop').addEventListener('click', () => { debugStop = true; });
}

// ---------------------------------------------------------------------------
// Rendering

function renderResult(r) {
  for (const dir of ['encode', 'decode']) {
    const p = r.predictions[dir];
    const call = r.webrtc[dir];
    const wcHw = r.webCodecs[dir].hardware;
    const wcSw = r.webCodecs[dir].software;
    const v = r[`${dir}Verdict`];
    const tr = document.createElement('tr');
    if (v.agree === false) tr.className = 'disagree';
    tr.append(
      td(dir === 'encode' ? r.label : ''),
      td(dir === 'encode' ? 'send (encode)' : 'receive (decode)'),
      td(describeMc(p.mediaCapabilities), classFor(predicted(p.mediaCapabilities))),
      td(describeSupport(p.webCodecsHardware)),
      td(call ? (call.implementations && call.implementations.length ? `${call.implementations.join(' → ')} (${call.implementationClass})` : 'not exposed') : r.webrtc.skipped || r.webrtc.error || '—',
        call ? classFor(call.implementationClass) : 'muted'),
      td(call && typeof call.powerEfficient === 'boolean' ? String(call.powerEfficient) : 'not exposed', call ? '' : 'muted'),
      td(call && call.msPerFrame !== undefined
        ? `${call.msPerFrame} ms, ${call.resolution || '?'}${dir === 'encode' && call.scalabilityMode ? `, ${call.scalabilityMode}` : ''}${dir === 'encode' && call.streams > 1 ? `, ${call.streams} streams` : ''}`
        : '—'),
      td(`${describeRun(wcHw)} / ${describeRun(wcSw)}`),
      td(v.agree === null ? 'can’t tell' : v.agree ? 'yes' : `no: says ${v.predicted}, ran ${v.observed}`, 'agree'),
    );
    $('rows').append(tr);
  }
}

function renderSummary(r) {
  let agree = 0;
  let disagree = 0;
  let unknown = 0;
  const misses = [];
  for (const x of r.results) {
    for (const dir of ['encode', 'decode']) {
      const v = x[`${dir}Verdict`];
      if (v.agree === true) agree++;
      else if (v.agree === false) { disagree++; misses.push(`${x.label} ${dir}`); }
      else unknown++;
    }
  }
  const el = $('summary');
  el.hidden = false;
  el.innerHTML = '';
  const p = document.createElement('p');
  if (agree + disagree === 0) {
    const engine = r.environment.browser.engine;
    p.textContent = engine === 'Chromium' && String(r.environment.camera).startsWith('unavailable')
      ? "None of the checks could be verified. Without camera access, the browser hides which encoder and decoder it used. Allow camera access and run the test again."
      : "None of the checks could be verified, because this browser doesn't report which encoder or decoder it used. Its predictions are still useful, so please send the results.";
  } else {
    p.textContent = `The browser's prediction matched what ran in ${agree} of ${agree + disagree} checks it could verify. ` +
      (disagree ? `It was wrong for: ${misses.join(', ')}. ` : '') +
      (unknown ? `${unknown} checks couldn't be verified, because the browser doesn't expose what ran or doesn't support the codec.` : '');
  }
  el.append(p);
}

function td(text, cls) {
  const el = document.createElement('td');
  el.textContent = text;
  if (cls) el.className = cls;
  return el;
}

function classFor(value) {
  if (value === 'hardware') return 'hw';
  if (value === 'software') return 'sw';
  return '';
}

function describeMc(mc) {
  if (!mc.available) return 'not available';
  if (mc.error) return `error: ${mc.error}`;
  if (!mc.supported) return 'unsupported';
  return mc.powerEfficient ? 'hardware (powerEfficient)' : 'software (not powerEfficient)';
}

function describeSupport(s) {
  if (!s.available) return 'not available';
  if (s.error) return `error: ${s.error}`;
  return s.supported ? 'supported' : 'unsupported';
}

function describeRun(x) {
  if (!x || x.available === false) return 'n/a';
  if (x.skipped) return 'skipped';
  if (!x.ok) return `failed (${(x.error || '').split(':')[0]})`;
  return `${x.msPerFrame} ms`;
}

function round(n, d) {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

// ---------------------------------------------------------------------------

setupReportBox();
setupDebugMode();
$('form').addEventListener('submit', run);
$('download').addEventListener('click', () => {
  if (!report) return;
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `codec-hw-test-${report.environment.browser.name.toLowerCase()}-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});
