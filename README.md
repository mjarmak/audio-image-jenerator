# ACE-Step Music Generator

A no-dependency local web app that connects to the ACE-Step REST API at `http://localhost:8001`, submits a music generation task, waits for it to finish, and returns a downloadable audio file.

## Run

1. Start the ACE-Step API server.

For this AMD/ROCm setup, use ACE-Step's ROCm launcher:

```powershell
cd C:\Projects\ACE-Step-1.5
.\start_api_server_rocm.bat
```

Do not use plain `uv run acestep-api` for AMD on this machine. The default `uv` environment may use the CUDA `.venv`, while the working AMD environment is `venv_rocm`.

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

## AMD / ROCm

This machine uses an AMD ROCm environment at:

```text
C:\Projects\ACE-Step-1.5\venv_rocm
```

Verify GPU detection with:

```powershell
cd C:\Projects\ACE-Step-1.5
$env:PYTHONIOENCODING="utf-8"
$env:HSA_OVERRIDE_GFX_VERSION="11.0.0"
$env:MIOPEN_FIND_MODE="FAST"
.\venv_rocm\Scripts\python.exe scripts\check_gpu.py
```

Expected result includes:

```text
PyTorch installed: 2.9.1+rocmsdk...
Build type: ROCm
torch.cuda.is_available(): True
GPU 0: AMD Radeon RX 7900 XT
```

If you prefer using `uv run`, point it at `venv_rocm`:

```powershell
cd C:\Projects\ACE-Step-1.5
$env:PYTHONIOENCODING="utf-8"
$env:HSA_OVERRIDE_GFX_VERSION="11.0.0"
$env:MIOPEN_FIND_MODE="FAST"
$env:UV_PROJECT_ENVIRONMENT="venv_rocm"
C:\Users\moham\.local\bin\uv.exe run --no-sync python scripts\check_gpu.py
```

If ACE-Step reports `GPU Memory: 0.00 GB`, it is probably running from the wrong environment. Stop it and start again with `.\start_api_server_rocm.bat`.

## If ACE-Step is not responding

Confirm the API server is reachable:

```powershell
Invoke-RestMethod http://localhost:8001/health
Invoke-RestMethod http://localhost:8001/v1/models
```

If model loading fails, use ACE-Step's own launch scripts or reduce the model configuration for your GPU/CPU setup.
