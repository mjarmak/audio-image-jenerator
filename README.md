# LM Studio WAV Generator

A no-dependency local web app that connects to LM Studio's OpenAI-compatible API at `http://localhost:1234`, asks the loaded model for a structured sound plan, and renders a downloadable stereo `.wav` file.

## Run

1. Open LM Studio.
2. Load a chat model.
3. Start the local server:

```powershell
npm.cmd start
```

4. Open `http://localhost:3000`.

If port `3000` is already being used, the app automatically tries the next available port and prints the URL. You can also choose a port yourself:

```powershell
node server.js --port 3001
```

You can also run the server directly:

```powershell
node server.js
```

You can change the LM Studio endpoint with:

```powershell
$env:LM_STUDIO_URL="http://localhost:1234"
npm.cmd start
```

## Notes

LM Studio does not provide a native text-to-speech endpoint. This app uses the local model to create a compact JSON score, then synthesizes the WAV file locally with oscillators, noise, envelopes, panning, and PCM encoding.

## If LM Studio says "Failed to load model"

That error happens inside LM Studio before this app can talk to the model. Try these in order:

1. Use a smaller chat/instruct model first, such as a 3B to 7B GGUF model with a 4-bit quantization.
2. Lower the model's context length in LM Studio before loading it.
3. If you are using GPU acceleration, reduce GPU offload or turn off KV cache GPU offload if VRAM is tight.
4. Make sure the LM Studio server is running from the Developer tab.
5. Confirm the API is reachable:

```powershell
Invoke-RestMethod http://localhost:1234/v1/models
```

On Windows, LM Studio recommends AVX2 CPU support, at least 16GB RAM, and at least 4GB dedicated VRAM. Larger models can need much more than that.
