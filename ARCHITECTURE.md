# Architecture

```text
Browser (Next.js / React / TypeScript)
  ├── Responsive UI, conversation history in localStorage
  └── HTTP requests to FastAPI (127.0.0.1:8000)
             └── HTTP requests to Ollama (127.0.0.1:11434)
                        └── gemma3:1b on this computer
```

## Design decisions
- Chat history is browser-local for the starter; no user accounts or cloud sync.
- FastAPI isolates the browser UI from Ollama's native API and provides a health endpoint.
- CORS is restricted to the local development origin by default.
- The UI reports backend connectivity and has retryable errors.
- Public deployment requires a separately hosted inference endpoint and security hardening.
