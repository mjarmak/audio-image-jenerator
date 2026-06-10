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
