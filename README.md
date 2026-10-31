# GhostAI — Haunted Terminal

A polished local-first AI chat app with a Next.js frontend and a FastAPI bridge to Ollama. The starter keeps inference on your computer through your existing `gemma3:1b` model.

## Stack
- Next.js App Router + React + TypeScript
- Custom responsive CSS design system (no UI framework lock-in)
- FastAPI backend
- Ollama (`gemma3:1b` by default)

## Requirements
- Node.js 20.9+ (Node 24 should work)
- Python 3.10+
- Ollama installed and running
- Model available locally: `ollama list` should show `gemma3:1b`

## Run on Windows

### 1. Start Ollama
Open Ollama normally. In a separate PowerShell terminal, verify:
```powershell
ollama list
ollama run gemma3:1b
```
You can exit the model prompt after verifying it works.

### 2. Start the FastAPI backend
Open PowerShell in `ghostai-pro\backend`:
```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
Copy-Item .env.example .env
python -m uvicorn main:app --reload --host 127.0.0.1 --port 8000
```
If PowerShell blocks activation, run this once for the current terminal:
```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\.venv\Scripts\Activate.ps1
```
Backend health check: open `http://127.0.0.1:8000/health` in your browser.

### 3. Start the frontend
Open a second PowerShell terminal in `ghostai-pro\frontend`:
```powershell
npm install
Copy-Item .env.local.example .env.local
npm run dev
```
Open `http://localhost:3000`.

## Configuration
Backend `.env`:
- `OLLAMA_URL=http://127.0.0.1:11434`
- `OLLAMA_MODEL=gemma3:1b`
- `FRONTEND_ORIGIN=http://localhost:3000`

Frontend `.env.local`:
- `NEXT_PUBLIC_API_URL=http://127.0.0.1:8000`

## Notes
- This is a local development app, not yet production-deployed.
- Chat history is stored in this browser's local storage. It is not a cloud sync.
- The backend sends chat requests to your local Ollama instance.
- Do not expose the local backend to the public internet without adding authentication, rate limiting, and deployment-specific security.
- A browser frontend can be deployed publicly, but local Ollama is only reachable on the machine where it runs. For a public demo, use a hosted backend/model or clearly document the local setup.


## Accuracy and slow responses

GhostAI uses the local model selected in `backend/.env`. Small models such as `gemma3:1b` can make mistakes, especially on multi-bug debugging tasks; a system prompt improves guidance but cannot guarantee correct answers. For stronger coding answers, if your computer has enough RAM and you accept slower responses, try `qwen2.5-coder:3b`: run `ollama pull qwen2.5-coder:3b`, then set `OLLAMA_MODEL=qwen2.5-coder:3b` in `backend/.env` and restart the backend. You can switch back to `gemma3:1b` any time.

The backend now sends only the most recent 12 chat messages to reduce slow responses and uses a 4096-token context.
