const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = getRequestedPort();
const DEFAULT_ACE_STEP_URL = process.env.ACE_STEP_URL || "http://localhost:8001";
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_BODY_BYTES = 64 * 1024;
const MAX_PORT_ATTEMPTS = 20;
const POLL_INTERVAL_MS = 2000;
const GENERATION_TIMEOUT_MS = 10 * 60 * 1000;

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".wav": "audio/wav"
};

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      return sendJson(res, 204, {});
    }

    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname === "/api/health") {
      const baseUrl = cleanBaseUrl(url.searchParams.get("baseUrl") || DEFAULT_ACE_STEP_URL);
      const [health, models] = await Promise.all([fetchAceHealth(baseUrl), fetchAceModels(baseUrl)]);
      return sendJson(res, 200, { ok: true, baseUrl, health, models });
    }

    if (req.method === "POST" && url.pathname === "/api/generate") {
      const requestBody = await readJson(req);
      const result = await generateWithAceStep(requestBody);
      return sendJson(res, 200, { ok: true, ...result });
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

listenWithFallback(PORT);

function listenWithFallback(port, attempt = 0) {
  server.once("error", error => {
    if (error.code === "EADDRINUSE" && attempt < MAX_PORT_ATTEMPTS) {
      const nextPort = port + 1;
      console.warn(`Port ${port} is already in use. Trying ${nextPort}...`);
      listenWithFallback(nextPort, attempt + 1);
      return;
    }

    console.error(error.message);
    process.exitCode = 1;
  });

  server.listen(port, () => {
    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    console.log(`ACE-Step Music Generator running at http://localhost:${actualPort}`);
    console.log(`ACE-Step endpoint: ${DEFAULT_ACE_STEP_URL}`);
  });
}

function getRequestedPort() {
  const args = process.argv.slice(2);
  const portFlagIndex = args.findIndex(arg => arg === "--port" || arg === "-p");
  const portFlagValue = args.find(arg => arg.startsWith("--port="));
  const rawPort =
    portFlagValue?.split("=")[1] ||
    (portFlagIndex >= 0 ? args[portFlagIndex + 1] : undefined) ||
    process.env.PORT ||
    "3000";
  const port = Number(rawPort);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${rawPort}`);
  }

  return port;
}

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
        const error = createHttpError(413, "Request body is too large.");
        req.destroy(error);
        return;
      }
      body += chunk.toString("utf8");
    });

    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(createHttpError(400, "Request body must be valid JSON."));
      }
    });

    req.on("error", reject);
  });
}

async function generateWithAceStep(requestBody) {
  const baseUrl = cleanBaseUrl(requestBody.baseUrl || DEFAULT_ACE_STEP_URL);
  const prompt = String(requestBody.prompt || "").trim();
  const lyrics = String(requestBody.lyrics || "").trim();
  const model = String(requestBody.model || "").trim();
  const durationSeconds = clamp(Number(requestBody.durationSeconds || 30), 10, 600);
  const inferenceSteps = clamp(Number(requestBody.inferenceSteps || 8), 1, 200);
  const lmTemperature = clamp(Number(requestBody.temperature || 0.85), 0.1, 1.4);
  const thinking = Boolean(requestBody.thinking);

  if (!prompt) {
    throw createHttpError(400, "Enter a music prompt before generating.");
  }

  const releasePayload = {
    prompt,
    lyrics,
    thinking,
    audio_format: "wav",
    audio_duration: durationSeconds,
    inference_steps: inferenceSteps,
    lm_temperature: lmTemperature,
    batch_size: 1,
    task_type: "text2music",
    use_random_seed: true
  };

  if (model) {
    releasePayload.model = model;
  }

  const released = await postAceJson(baseUrl, "/release_task", releasePayload, 30000);
  const taskId = released?.data?.task_id;

  if (!taskId) {
    throw createHttpError(502, "ACE-Step did not return a task id.");
  }

  const taskResult = await waitForAceTask(baseUrl, taskId);
  const audioUrl = getTaskAudioUrl(taskResult);
  const downloaded = await downloadAceAudio(baseUrl, audioUrl);
  const metas = taskResult.metas && typeof taskResult.metas === "object" ? taskResult.metas : {};
  const title = taskResult.prompt || prompt;

  return {
    taskId,
    plan: {
      title: clampText(title, 80),
      description: taskResult.generation_info || "Generated by ACE-Step",
      prompt: taskResult.prompt || prompt,
      lyrics: taskResult.lyrics || lyrics,
      model: taskResult.dit_model || model || "",
      lmModel: taskResult.lm_model || "",
      seed: taskResult.seed_value || "",
      metas
    },
    audio: {
      base64: downloaded.buffer.toString("base64"),
      mimeType: downloaded.mimeType,
      durationSeconds: Number(metas.duration || durationSeconds),
      fileName: `${slugify(title)}.${downloaded.extension}`
    }
  };
}

async function fetchAceHealth(baseUrl) {
  const response = await fetchWithTimeout(`${baseUrl}/health`, {
    method: "GET",
    timeoutMs: 5000
  });
  const payload = await readAceResponse(response, "checking ACE-Step health");
  return payload.data || {};
}

async function fetchAceModels(baseUrl) {
  const response = await fetchWithTimeout(`${baseUrl}/v1/models`, {
    method: "GET",
    timeoutMs: 10000
  });
  const payload = await readAceResponse(response, "listing ACE-Step models");
  const data = payload.data || {};
  const models = Array.isArray(data.models) ? data.models : [];

  return {
    defaultModel: data.default_model || "",
    items: models
      .map(model => ({
        name: String(model.name || model.id || model).trim(),
        isDefault: Boolean(model.is_default),
        isLoaded: model.is_loaded === undefined ? undefined : Boolean(model.is_loaded)
      }))
      .filter(model => model.name)
  };
}

async function waitForAceTask(baseUrl, taskId) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < GENERATION_TIMEOUT_MS) {
    await delay(POLL_INTERVAL_MS);

    const payload = await postAceJson(baseUrl, "/query_result", { task_id_list: [taskId] }, 30000);
    const task = Array.isArray(payload.data) ? payload.data.find(item => item.task_id === taskId) || payload.data[0] : null;

    if (!task) {
      continue;
    }
    if (task.status === 0 || task.status === "queued" || task.status === "running") {
      continue;
    }
    if (task.status === 2 || task.status === "failed") {
      throw createHttpError(502, `ACE-Step generation failed${task.error ? `: ${task.error}` : "."}`);
    }
    if (task.status === 1 || task.status === "succeeded") {
      return parseAceTaskResult(task);
    }
  }

  throw createHttpError(504, "Timed out while waiting for ACE-Step to finish generation.");
}

function parseAceTaskResult(task) {
  if (!task.result) {
    throw createHttpError(502, "ACE-Step task succeeded without a result.");
  }

  const parsed = typeof task.result === "string" ? JSON.parse(task.result) : task.result;
  const results = Array.isArray(parsed) ? parsed : [parsed];
  const usable = results.find(result => result && (result.file || result.audio_url || result.url));

  if (!usable) {
    throw createHttpError(502, "ACE-Step result did not include an audio file URL.");
  }

  return usable;
}

function getTaskAudioUrl(taskResult) {
  return String(taskResult.file || taskResult.audio_url || taskResult.url || "").trim();
}

async function downloadAceAudio(baseUrl, audioUrl) {
  const url = buildAceUrl(baseUrl, audioUrl);
  const response = await fetchWithTimeout(url, {
    method: "GET",
    timeoutMs: 120000
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw createHttpError(502, `ACE-Step returned ${response.status} while downloading audio: ${text || response.statusText}`);
  }

  const mimeType = response.headers.get("content-type") || inferMimeType(url);
  const buffer = Buffer.from(await response.arrayBuffer());

  if (!buffer.length) {
    throw createHttpError(502, "ACE-Step returned an empty audio file.");
  }

  return {
    buffer,
    mimeType,
    extension: extensionFromMimeType(mimeType, url)
  };
}

async function postAceJson(baseUrl, pathname, payload, timeoutMs) {
  const response = await fetchWithTimeout(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    timeoutMs
  });

  return readAceResponse(response, `calling ACE-Step ${pathname}`);
}

async function readAceResponse(response, action) {
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json") ? await response.json() : { detail: await response.text() };

  if (!response.ok) {
    throw createHttpError(response.status, `ACE-Step returned ${response.status} while ${action}: ${payload.detail || payload.error || response.statusText}`);
  }
  if (payload.code && payload.code !== 200) {
    throw createHttpError(502, `ACE-Step failed while ${action}: ${payload.error || payload.detail || `code ${payload.code}`}`);
  }

  return payload;
}

function buildAceUrl(baseUrl, value) {
  if (/^https?:\/\//i.test(value)) {
    return value;
  }

  return new URL(value.startsWith("/") ? value : `/${value}`, baseUrl).toString();
}

function cleanBaseUrl(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("ACE-Step URL must start with http:// or https://.");
  }
  return url.origin;
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

function inferMimeType(url) {
  const pathname = new URL(url).pathname.toLowerCase();
  if (pathname.endsWith(".mp3")) return "audio/mpeg";
  if (pathname.endsWith(".flac")) return "audio/flac";
  if (pathname.endsWith(".opus")) return "audio/ogg";
  if (pathname.endsWith(".aac")) return "audio/aac";
  return "audio/wav";
}

function extensionFromMimeType(mimeType, url) {
  const normalized = String(mimeType || "").toLowerCase();
  if (normalized.includes("mpeg")) return "mp3";
  if (normalized.includes("flac")) return "flac";
  if (normalized.includes("opus")) return "opus";
  if (normalized.includes("aac")) return "aac";

  const extension = path.extname(new URL(url).pathname).replace(".", "").toLowerCase();
  return extension || "wav";
}

function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

function slugify(value) {
  const slug = String(value || "ace-step-audio")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 64);

  return slug || "ace-step-audio";
}
