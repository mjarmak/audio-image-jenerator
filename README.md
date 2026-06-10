# ACE-Step Music Generator

A no-dependency local web app that connects to the ACE-Step REST API at `http://localhost:8001`, submits a music generation task, waits for it to finish, and returns a downloadable audio file.

## Run

1. Start the ACE-Step API server:

```powershell
cd C:\path\to\ACE-Step-1.5
uv run acestep-api
```

2. Start this app:

```powershell
npm.cmd start
```

3. Open `http://localhost:3000`.

If port `3000` is already being used, the app automatically tries the next available port and prints the URL. You can also choose a port yourself:

```powershell
node server.js --port 3001
```

You can change the ACE-Step endpoint with:

```powershell
$env:ACE_STEP_URL="http://localhost:8001"
npm.cmd start
```

## Notes

ACE-Step uses an asynchronous API:

1. `POST /release_task` creates a generation task.
2. `POST /query_result` polls until the task succeeds or fails.
3. `GET /v1/audio?path=...` downloads the generated audio.

This app wraps that workflow behind its own `/api/generate` endpoint so the browser only has to make one request.

ACE-Step requires generated audio durations of at least 10 seconds. The app requests WAV output by default.

## If ACE-Step is not responding

Confirm the API server is reachable:

```powershell
Invoke-RestMethod http://localhost:8001/health
Invoke-RestMethod http://localhost:8001/v1/models
```

If model loading fails, use ACE-Step's own launch scripts or reduce the model configuration for your GPU/CPU setup.
