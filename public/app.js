const form = document.querySelector("#generator-form");
const refreshButton = document.querySelector("#refresh-models");
const generateButton = document.querySelector("#generate");
const baseUrlInput = document.querySelector("#base-url");
const modelSelect = document.querySelector("#model");
const promptInput = document.querySelector("#prompt");
const durationInput = document.querySelector("#duration");
const durationOutput = document.querySelector("#duration-output");
const temperatureInput = document.querySelector("#temperature");
const temperatureOutput = document.querySelector("#temperature-output");
const statusText = document.querySelector("#status");
const connectionDot = document.querySelector("#connection-dot");
const result = document.querySelector("#result");
const resultTitle = document.querySelector("#result-title");
const resultDescription = document.querySelector("#result-description");
const audio = document.querySelector("#audio");
const download = document.querySelector("#download");
const planJson = document.querySelector("#plan-json");

let currentObjectUrl = null;

durationInput.addEventListener("input", () => {
  durationOutput.value = `${durationInput.value}s`;
});

temperatureInput.addEventListener("input", () => {
  temperatureOutput.value = Number(temperatureInput.value).toFixed(1);
});

refreshButton.addEventListener("click", () => {
  refreshModels();
});

form.addEventListener("submit", async event => {
  event.preventDefault();
  await generateAudio();
});

refreshModels();

async function refreshModels() {
  setStatus("Checking LM Studio...", "pending");
  refreshButton.disabled = true;

  try {
    const response = await fetch(`/api/health?baseUrl=${encodeURIComponent(baseUrlInput.value)}`);
    const payload = await response.json();

    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || "LM Studio is not responding.");
    }

    modelSelect.innerHTML = '<option value="">Auto</option>';

    for (const model of payload.models) {
      const option = document.createElement("option");
      option.value = model;
      option.textContent = model;
      modelSelect.append(option);
    }

    const count = payload.models.length;
    setStatus(count ? `${count} model${count === 1 ? "" : "s"} available` : "No loaded models found", count ? "ok" : "error");
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    refreshButton.disabled = false;
  }
}

async function generateAudio() {
  setStatus("Generating WAV...", "pending");
  generateButton.disabled = true;
  download.classList.add("hidden");

  try {
    const response = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseUrl: baseUrlInput.value,
        model: modelSelect.value,
        prompt: promptInput.value,
        durationSeconds: Number(durationInput.value),
        temperature: Number(temperatureInput.value)
      })
    });

    const payload = await response.json();

    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || "Audio generation failed.");
    }

    showResult(payload);
    setStatus(payload.usedFallback ? "WAV generated with fallback plan" : "WAV generated", "ok");
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    generateButton.disabled = false;
  }
}

function showResult(payload) {
  if (currentObjectUrl) {
    URL.revokeObjectURL(currentObjectUrl);
  }

  const blob = base64ToBlob(payload.audio.base64, payload.audio.mimeType);
  currentObjectUrl = URL.createObjectURL(blob);

  audio.src = currentObjectUrl;
  download.href = currentObjectUrl;
  download.download = payload.audio.fileName;
  download.classList.remove("hidden");

  resultTitle.textContent = payload.plan.title || "Generated audio";
  resultDescription.textContent = payload.plan.description || "";
  planJson.textContent = JSON.stringify(payload.plan, null, 2);
  result.classList.remove("hidden");
}

function base64ToBlob(base64, mimeType) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return new Blob([bytes], { type: mimeType });
}

function setStatus(message, state) {
  statusText.textContent = message;
  connectionDot.classList.remove("ok", "error");

  if (state === "ok") {
    connectionDot.classList.add("ok");
  } else if (state === "error") {
    connectionDot.classList.add("error");
  }
}
