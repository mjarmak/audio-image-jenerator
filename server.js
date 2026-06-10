const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 3000);
const DEFAULT_LM_STUDIO_URL = process.env.LM_STUDIO_URL || "http://localhost:1234";
const PUBLIC_DIR = path.join(__dirname, "public");
const SAMPLE_RATE = 44100;
const MAX_BODY_BYTES = 64 * 1024;

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".wav": "audio/wav"
};

const NOTE_OFFSETS = {
  C: 0,
  "C#": 1,
  DB: 1,
  D: 2,
  "D#": 3,
  EB: 3,
  E: 4,
  F: 5,
  "F#": 6,
  GB: 6,
  G: 7,
  "G#": 8,
  AB: 8,
  A: 9,
  "A#": 10,
  BB: 10,
  B: 11
};

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      return sendJson(res, 204, {});
    }

    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname === "/api/health") {
      const baseUrl = cleanBaseUrl(url.searchParams.get("baseUrl") || DEFAULT_LM_STUDIO_URL);
      const models = await fetchLmStudioModels(baseUrl);
      return sendJson(res, 200, { ok: true, baseUrl, models });
    }

    if (req.method === "POST" && url.pathname === "/api/generate") {
      const requestBody = await readJson(req);
      const baseUrl = cleanBaseUrl(requestBody.baseUrl || DEFAULT_LM_STUDIO_URL);
      const prompt = String(requestBody.prompt || "").trim();
      const model = String(requestBody.model || "").trim();
      const durationSeconds = clamp(Number(requestBody.durationSeconds || 12), 3, 30);
      const temperature = clamp(Number(requestBody.temperature || 0.8), 0.1, 1.4);

      if (!prompt) {
        return sendJson(res, 400, { ok: false, error: "Enter a prompt before generating audio." });
      }

      const { plan, usedFallback, rawModelText } = await createAudioPlan({
        baseUrl,
        model,
        prompt,
        durationSeconds,
        temperature
      });

      const normalizedPlan = normalizePlan(plan, prompt, durationSeconds);
      const wavBuffer = renderWav(normalizedPlan, durationSeconds);
      const title = normalizedPlan.title || "lm-studio-audio";

      return sendJson(res, 200, {
        ok: true,
        usedFallback,
        rawModelText: usedFallback ? rawModelText : undefined,
        plan: normalizedPlan,
        audio: {
          base64: wavBuffer.toString("base64"),
          mimeType: "audio/wav",
          durationSeconds,
          sampleRate: SAMPLE_RATE,
          fileName: `${slugify(title)}.wav`
        }
      });
    }

    if (req.method === "GET") {
      return serveStatic(url.pathname, res);
    }

    sendJson(res, 405, { ok: false, error: "Method not allowed." });
  } catch (error) {
    const status = error.statusCode || 500;
    sendJson(res, status, { ok: false, error: error.message || "Unexpected server error." });
  }
});

server.listen(PORT, () => {
  console.log(`LM Studio WAV Generator running at http://localhost:${PORT}`);
  console.log(`LM Studio endpoint: ${DEFAULT_LM_STUDIO_URL}`);
});

function serveStatic(requestPath, res) {
  const safePath = requestPath === "/" ? "/index.html" : decodeURIComponent(requestPath);
  const resolved = path.normalize(path.join(PUBLIC_DIR, safePath));

  if (!resolved.startsWith(PUBLIC_DIR)) {
    return sendText(res, 403, "Forbidden");
  }

  fs.readFile(resolved, (error, content) => {
    if (error) {
      return sendText(res, 404, "Not found");
    }
    const ext = path.extname(resolved).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
    res.end(content);
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json; charset=utf-8"
  });

  if (statusCode === 204) {
    return res.end();
  }

  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let total = 0;
    let body = "";

    req.on("data", chunk => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        const error = new Error("Request body is too large.");
        error.statusCode = 413;
        req.destroy(error);
        return;
      }
      body += chunk.toString("utf8");
    });

    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        const error = new Error("Request body must be valid JSON.");
        error.statusCode = 400;
        reject(error);
      }
    });

    req.on("error", reject);
  });
}

function cleanBaseUrl(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("LM Studio URL must start with http:// or https://.");
  }
  return url.origin;
}

async function fetchLmStudioModels(baseUrl) {
  const response = await fetchWithTimeout(`${baseUrl}/v1/models`, {
    method: "GET",
    timeoutMs: 5000
  });

  if (!response.ok) {
    throw new Error(`LM Studio returned ${response.status} when listing models.`);
  }

  const data = await response.json();
  return Array.isArray(data.data) ? data.data.map(model => model.id).filter(Boolean) : [];
}

async function createAudioPlan({ baseUrl, model, prompt, durationSeconds, temperature }) {
  const models = model ? [model] : await fetchLmStudioModels(baseUrl);
  const selectedModel = model || models[0];

  if (!selectedModel) {
    throw new Error("No model is loaded in LM Studio. Load a chat model, then try again.");
  }

  const messages = [
    {
      role: "system",
      content: [
        "You are an audio director for a procedural WAV synthesizer.",
        "Return only strict JSON. Do not use markdown, comments, prose, or trailing commas.",
        "The JSON must describe a short instrumental sound plan, not speech.",
        "Use musically useful note events and keep event counts compact."
      ].join(" ")
    },
    {
      role: "user",
      content: buildPlanPrompt(prompt, durationSeconds)
    }
  ];

  const response = await fetchWithTimeout(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: selectedModel,
      messages,
      temperature,
      max_tokens: 1800
    }),
    timeoutMs: 30000
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`LM Studio returned ${response.status}: ${text || response.statusText}`);
  }

  const data = await response.json();
  const rawModelText = data.choices?.[0]?.message?.content || data.choices?.[0]?.text || "";

  try {
    return {
      plan: parseJsonFromModelText(rawModelText),
      rawModelText,
      usedFallback: false
    };
  } catch {
    return {
      plan: createFallbackPlan(prompt, durationSeconds),
      rawModelText,
      usedFallback: true
    };
  }
}

function buildPlanPrompt(prompt, durationSeconds) {
  return [
    `Create a ${durationSeconds.toFixed(1)} second sound plan for this prompt: ${JSON.stringify(prompt)}.`,
    "Return this exact shape:",
    "{",
    '  "title": "short filename-safe title",',
    '  "description": "one short phrase",',
    '  "bpm": 60-150,',
    '  "tracks": [',
    "    {",
    '      "name": "track name",',
    '      "waveform": "sine|triangle|square|sawtooth|noise",',
    '      "gain": 0.05-0.8,',
    '      "pan": -1 to 1,',
    '      "attack": 0.001-0.8,',
    '      "decay": 0-0.8,',
    '      "sustain": 0.05-1,',
    '      "release": 0.01-1.5,',
    '      "events": [',
    '        {"time": 0, "duration": 0.5, "note": "C4", "frequency": 261.63, "velocity": 0.1-1}',
    "      ]",
    "    }",
    "  ]",
    "}",
    "Rules: include 2 to 5 tracks. Put all events between time 0 and the requested duration.",
    "Use note or frequency for pitched events. Use waveform noise for wind, percussion, surf, static, or texture.",
    "Keep the total number of events under 90."
  ].join("\n");
}

function parseJsonFromModelText(text) {
  const trimmed = String(text || "").trim();

  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) {
      throw new Error("Model response did not contain JSON.");
    }
    return JSON.parse(trimmed.slice(start, end + 1));
  }
}

function normalizePlan(plan, prompt, durationSeconds) {
  const fallback = createFallbackPlan(prompt, durationSeconds);
  const source = plan && typeof plan === "object" ? plan : fallback;
  const title = clampText(source.title || fallback.title, 64);
  const description = clampText(source.description || fallback.description, 140);
  const bpm = clamp(Number(source.bpm || fallback.bpm), 45, 180);
  const tracks = Array.isArray(source.tracks) ? source.tracks.slice(0, 6) : [];
  const normalizedTracks = tracks.map((track, index) => normalizeTrack(track, index, durationSeconds)).filter(Boolean);

  return {
    title,
    description,
    bpm,
    sampleRate: SAMPLE_RATE,
    durationSeconds,
    tracks: normalizedTracks.length ? normalizedTracks : fallback.tracks
  };
}

function normalizeTrack(track, index, durationSeconds) {
  if (!track || typeof track !== "object") {
    return null;
  }

  const waveform = normalizeWaveform(track.waveform);
  const events = Array.isArray(track.events) ? track.events.slice(0, 100) : [];
  const normalizedEvents = events
    .map(event => normalizeEvent(event, durationSeconds))
    .filter(Boolean)
    .sort((a, b) => a.time - b.time);

  if (!normalizedEvents.length) {
    return null;
  }

  return {
    name: clampText(track.name || `Track ${index + 1}`, 40),
    waveform,
    gain: clamp(Number(track.gain ?? 0.4), 0.02, 0.9),
    pan: clamp(Number(track.pan ?? 0), -1, 1),
    attack: clamp(Number(track.attack ?? 0.01), 0.001, 1),
    decay: clamp(Number(track.decay ?? 0.08), 0, 1),
    sustain: clamp(Number(track.sustain ?? 0.65), 0.02, 1),
    release: clamp(Number(track.release ?? 0.1), 0.005, 2),
    events: normalizedEvents
  };
}

function normalizeEvent(event, durationSeconds) {
  if (!event || typeof event !== "object") {
    return null;
  }

  const time = clamp(Number(event.time ?? 0), 0, durationSeconds - 0.02);
  const duration = clamp(Number(event.duration ?? 0.4), 0.02, durationSeconds - time);
  const noteFrequency = noteToFrequency(event.note);
  const frequency = clamp(Number(event.frequency || noteFrequency || 220), 20, 6000);
  const velocity = clamp(Number(event.velocity ?? 0.7), 0.03, 1);

  return { time, duration, frequency, velocity };
}

function normalizeWaveform(waveform) {
  const normalized = String(waveform || "").toLowerCase();
  return ["sine", "triangle", "square", "sawtooth", "noise"].includes(normalized) ? normalized : "sine";
}

function createFallbackPlan(prompt, durationSeconds) {
  const seed = hashString(prompt);
  const moods = [
    ["C4", "E4", "G4", "B4", "A4", "G4", "E4", "D4"],
    ["A3", "C4", "E4", "G4", "F4", "E4", "C4", "B3"],
    ["D4", "F4", "A4", "C5", "B4", "A4", "F4", "E4"],
    ["G3", "B3", "D4", "F4", "E4", "D4", "B3", "A3"]
  ];
  const scale = moods[seed % moods.length];
  const bpm = 72 + (seed % 48);
  const beat = 60 / bpm;
  const events = [];
  const bassEvents = [];
  const textureEvents = [];

  for (let time = 0, index = 0; time < durationSeconds - 0.05; time += beat, index += 1) {
    const note = scale[(index + seed) % scale.length];
    events.push({
      time: round(time),
      duration: round(Math.min(beat * 0.82, durationSeconds - time)),
      note,
      velocity: 0.45 + ((seed + index) % 5) * 0.08
    });
  }

  for (let time = 0, index = 0; time < durationSeconds - 0.05; time += beat * 2, index += 1) {
    const root = scale[(index * 2 + seed) % scale.length].replace(/\d$/, "2");
    bassEvents.push({
      time: round(time),
      duration: round(Math.min(beat * 1.55, durationSeconds - time)),
      note: root,
      velocity: 0.5
    });
  }

  for (let time = 0; time < durationSeconds - 0.05; time += beat / 2) {
    textureEvents.push({
      time: round(time),
      duration: round(Math.min(0.045, durationSeconds - time)),
      frequency: 800 + (seed % 500),
      velocity: 0.14
    });
  }

  return {
    title: prompt ? `Local sketch ${prompt.slice(0, 28)}` : "Local sketch",
    description: "Fallback procedural sound plan",
    bpm,
    sampleRate: SAMPLE_RATE,
    durationSeconds,
    tracks: [
      {
        name: "Lead",
        waveform: "triangle",
        gain: 0.32,
        pan: -0.15,
        attack: 0.012,
        decay: 0.08,
        sustain: 0.5,
        release: 0.16,
        events
      },
      {
        name: "Bass",
        waveform: "sine",
        gain: 0.34,
        pan: 0,
        attack: 0.02,
        decay: 0.12,
        sustain: 0.68,
        release: 0.25,
        events: bassEvents
      },
      {
        name: "Texture",
        waveform: "noise",
        gain: 0.22,
        pan: 0.24,
        attack: 0.001,
        decay: 0.02,
        sustain: 0.2,
        release: 0.04,
        events: textureEvents
      }
    ]
  };
}

function renderWav(plan, durationSeconds) {
  const sampleCount = Math.floor(durationSeconds * SAMPLE_RATE);
  const left = new Float32Array(sampleCount);
  const right = new Float32Array(sampleCount);

  for (const track of plan.tracks) {
    const pan = clamp(track.pan, -1, 1);
    const leftGain = Math.cos(((pan + 1) * Math.PI) / 4);
    const rightGain = Math.sin(((pan + 1) * Math.PI) / 4);

    for (const event of track.events) {
      renderEvent({ left, right, track, event, leftGain, rightGain, sampleCount });
    }
  }

  applySoftDelay(left, right, 0.12, 0.16);
  applyFadeOut(left, right, Math.min(0.12, durationSeconds / 8));
  normalizeStereo(left, right);
  return encodeWav(left, right);
}

function renderEvent({ left, right, track, event, leftGain, rightGain, sampleCount }) {
  const startSample = Math.floor(event.time * SAMPLE_RATE);
  const eventSamples = Math.max(1, Math.floor(event.duration * SAMPLE_RATE));
  const endSample = Math.min(sampleCount, startSample + eventSamples);
  const baseGain = track.gain * event.velocity;
  let phase = 0;
  const phaseStep = (2 * Math.PI * event.frequency) / SAMPLE_RATE;
  let randomState = hashString(`${track.name}:${event.time}:${event.frequency}`) || 1;

  for (let sample = startSample; sample < endSample; sample += 1) {
    const localTime = (sample - startSample) / SAMPLE_RATE;
    const env = envelope(localTime, event.duration, track.attack, track.decay, track.sustain, track.release);
    const oscillator = sampleWaveform(track.waveform, phase, randomState);

    randomState = oscillator.nextState;
    const value = oscillator.value * env * baseGain;
    left[sample] += value * leftGain;
    right[sample] += value * rightGain;
    phase += phaseStep;
  }
}

function sampleWaveform(waveform, phase, randomState) {
  if (waveform === "noise") {
    const nextState = (1664525 * randomState + 1013904223) >>> 0;
    return { value: (nextState / 0xffffffff) * 2 - 1, nextState };
  }

  if (waveform === "square") {
    return { value: Math.sin(phase) >= 0 ? 1 : -1, nextState: randomState };
  }

  if (waveform === "triangle") {
    return { value: (2 / Math.PI) * Math.asin(Math.sin(phase)), nextState: randomState };
  }

  if (waveform === "sawtooth") {
    const cycle = phase / (2 * Math.PI);
    return { value: 2 * (cycle - Math.floor(cycle + 0.5)), nextState: randomState };
  }

  return { value: Math.sin(phase), nextState: randomState };
}

function envelope(time, duration, attack, decay, sustain, release) {
  const safeAttack = Math.min(attack, duration * 0.4);
  const safeRelease = Math.min(release, duration * 0.45);
  const safeDecay = Math.min(decay, Math.max(0, duration - safeAttack - safeRelease));

  if (time < safeAttack) {
    return time / Math.max(safeAttack, 0.001);
  }

  if (time < safeAttack + safeDecay) {
    const progress = (time - safeAttack) / Math.max(safeDecay, 0.001);
    return 1 - (1 - sustain) * progress;
  }

  if (time > duration - safeRelease) {
    const remaining = Math.max(0, duration - time);
    return sustain * (remaining / Math.max(safeRelease, 0.001));
  }

  return sustain;
}

function applySoftDelay(left, right, seconds, amount) {
  const delaySamples = Math.floor(seconds * SAMPLE_RATE);
  if (delaySamples <= 0) {
    return;
  }

  for (let index = delaySamples; index < left.length; index += 1) {
    left[index] += right[index - delaySamples] * amount;
    right[index] += left[index - delaySamples] * amount;
  }
}

function applyFadeOut(left, right, seconds) {
  const fadeSamples = Math.floor(seconds * SAMPLE_RATE);
  const start = Math.max(0, left.length - fadeSamples);

  for (let index = start; index < left.length; index += 1) {
    const gain = (left.length - index) / Math.max(1, fadeSamples);
    left[index] *= gain;
    right[index] *= gain;
  }
}

function normalizeStereo(left, right) {
  let peak = 0;
  for (let index = 0; index < left.length; index += 1) {
    peak = Math.max(peak, Math.abs(left[index]), Math.abs(right[index]));
  }

  if (peak <= 0.92) {
    return;
  }

  const scale = 0.92 / peak;
  for (let index = 0; index < left.length; index += 1) {
    left[index] *= scale;
    right[index] *= scale;
  }
}

function encodeWav(left, right) {
  const channels = 2;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = channels * bytesPerSample;
  const byteRate = SAMPLE_RATE * blockAlign;
  const dataSize = left.length * blockAlign;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);

  let offset = 44;
  for (let index = 0; index < left.length; index += 1) {
    buffer.writeInt16LE(floatToPcm16(left[index]), offset);
    buffer.writeInt16LE(floatToPcm16(right[index]), offset + 2);
    offset += 4;
  }

  return buffer;
}

function floatToPcm16(value) {
  const clamped = clamp(value, -1, 1);
  return Math.round(clamped < 0 ? clamped * 32768 : clamped * 32767);
}

function noteToFrequency(note) {
  const match = String(note || "").trim().match(/^([A-Ga-g])([#bB]?)(-?\d)$/);
  if (!match) {
    return null;
  }

  const name = `${match[1].toUpperCase()}${match[2] || ""}`.toUpperCase();
  const octave = Number(match[3]);
  const semitone = NOTE_OFFSETS[name];

  if (semitone === undefined || !Number.isFinite(octave)) {
    return null;
  }

  const midi = semitone + (octave + 1) * 12;
  return 440 * 2 ** ((midi - 69) / 12);
}

async function fetchWithTimeout(url, options = {}) {
  const timeoutMs = options.timeoutMs || 10000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`Timed out while connecting to ${url}.`);
    }
    throw new Error(`Could not connect to ${url}: ${error.message}`);
  } finally {
    clearTimeout(timer);
  }
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

function clampText(value, maxLength) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function slugify(value) {
  const slug = String(value || "lm-studio-audio")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 64);

  return slug || "lm-studio-audio";
}

function hashString(value) {
  let hash = 2166136261;
  const text = String(value || "");
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
