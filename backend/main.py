import ast
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Literal

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

load_dotenv()

OLLAMA_URL = os.getenv(
    "OLLAMA_URL",
    "http://127.0.0.1:11434",
).rstrip("/")

# Debugging ke liye 1B model bahut chhota hai.
# Pehle: ollama pull qwen2.5-coder:7b
# RAM kam ho to .env mein OLLAMA_MODEL=gemma3:4b ya qwen2.5-coder:3b rakho.
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "qwen2.5-coder:7b")

OLLAMA_NUM_CTX = int(os.getenv("OLLAMA_NUM_CTX", "4096"))

FRONTEND_ORIGIN = os.getenv(
    "FRONTEND_ORIGIN",
    "http://localhost:3000",
)


# =========================================================
# SYSTEM PROMPT (short on purpose: small models follow
# short prompts much better than long ones)
# =========================================================

SYSTEM_PROMPT = """
You are GhostAI, a helpful coding assistant. Be clear and concise.
Use a subtle spooky tone only when it fits naturally. Correctness comes first.

Rules:
- Answer only what is asked. Do not invent facts, errors or test results.
- Never claim code was executed unless real execution evidence is provided.
- When debugging: find the exact faulty line, explain why it fails for the
  given input, then give the smallest fix and the complete corrected code.
- If execution evidence is provided, trust it over your own guess.
- Report each bug once. Do not invent extra bugs.
- If something cannot be determined, say so instead of guessing.
""".strip()


# =========================================================
# RESTRICTED PYTHON DEBUGGING RUNNER
# =========================================================
# Intended for small educational snippets in local development.
# This is NOT a secure sandbox for untrusted public traffic.
# Production use requires a proper OS/container security sandbox.

MAX_CODE_CHARS = 6000
CODE_TIMEOUT_SECONDS = 3

ALLOWED_CALLS = {
    "print",
    "len",
    "sum",
    "min",
    "max",
    "abs",
    "round",
    "range",
    "enumerate",
    "zip",
    "sorted",
    "reversed",
    "all",
    "any",
    "int",
    "float",
    "str",
    "bool",
    "list",
    "tuple",
    "dict",
    "set",
    "isinstance",
    # exceptions (for raise / try-except snippets)
    "Exception",
    "ValueError",
    "TypeError",
    "KeyError",
    "IndexError",
    "ZeroDivisionError",
}

# Safe, common method names (e.g. numbers.append(x), d.get("k")).
# "format" is intentionally excluded (format strings can reach attributes).
ALLOWED_METHODS = {
    "append",
    "extend",
    "pop",
    "insert",
    "remove",
    "sort",
    "reverse",
    "count",
    "index",
    "get",
    "items",
    "keys",
    "values",
    "update",
    "add",
    "upper",
    "lower",
    "strip",
    "split",
    "join",
    "replace",
    "startswith",
    "endswith",
}

ALLOWED_AST_NODES = (
    ast.Module,
    ast.FunctionDef,
    ast.arguments,
    ast.arg,
    ast.Return,
    ast.Assign,
    ast.AugAssign,
    ast.Expr,
    ast.For,
    ast.While,
    ast.If,
    ast.Compare,
    ast.BoolOp,
    ast.BinOp,
    ast.UnaryOp,
    ast.Call,
    ast.Name,
    ast.Load,
    ast.Store,
    ast.Constant,
    ast.List,
    ast.Tuple,
    ast.Dict,
    ast.Set,
    ast.Subscript,
    ast.Slice,
    ast.IfExp,
    ast.And,
    ast.Or,
    ast.Not,
    ast.Eq,
    ast.NotEq,
    ast.Lt,
    ast.LtE,
    ast.Gt,
    ast.GtE,
    ast.Is,
    ast.IsNot,
    ast.In,
    ast.NotIn,
    ast.Add,
    ast.Sub,
    ast.Mult,
    ast.Div,
    ast.FloorDiv,
    ast.Mod,
    ast.Pow,
    ast.USub,
    ast.UAdd,
    ast.Break,
    ast.Continue,
    ast.Pass,
    ast.ListComp,
    ast.DictComp,
    ast.SetComp,
    ast.GeneratorExp,
    ast.comprehension,
    ast.keyword,
    # newly allowed (safe subset)
    ast.JoinedStr,       # f-strings
    ast.FormattedValue,  # {x} inside f-strings
    ast.Attribute,       # only whitelisted method calls (checked below)
    ast.Try,
    ast.ExceptHandler,
    ast.Raise,
    ast.Assert,
)


def _extract_python_code(text: str) -> str | None:
    """Extract Python code from a user message."""

    # 1) Fenced code block (```python, ```py or plain ```)
    blocks = re.findall(
        r"```(?:python|py)?[ \t]*\r?\n(.*?)```",
        text,
        flags=re.I | re.S,
    )

    if blocks:
        candidate = blocks[-1].strip()
        return candidate if candidate else None

    # 2) Raw code without fences: accept only if the whole message
    #    parses as Python AND contains code-like constructs.
    #    This avoids executing plain-language messages.
    stripped = text.strip()

    looks_like_code = bool(
        re.search(
            r"(?m)^\s*(def |for |while |if |print\s*\(|[A-Za-z_]\w*\s*=)",
            stripped,
        )
    )

    if looks_like_code:
        try:
            ast.parse(stripped, mode="exec")
            return stripped
        except SyntaxError:
            return None

    return None


def _validate_python_snippet(code: str) -> str | None:
    """Reject syntax outside the small local checker's allowlist."""

    if not code or len(code) > MAX_CODE_CHARS:
        return "Snippet is empty or exceeds the 6000-character limit."

    try:
        tree = ast.parse(code, mode="exec")
    except SyntaxError as exc:
        return (
            f"SyntaxError: {exc.msg} "
            f"(line {exc.lineno})"
        )

    defined_functions = {
        node.name
        for node in ast.walk(tree)
        if isinstance(node, ast.FunctionDef)
    }

    for node in ast.walk(tree):

        if not isinstance(node, ALLOWED_AST_NODES):
            return (
                "Execution skipped: "
                f"{type(node).__name__} is not allowed "
                "in the local checker."
            )

        if isinstance(node, ast.Name):
            if node.id.startswith("__") or "__" in node.id:
                return "Execution skipped: dunder names are not allowed."

        if isinstance(node, ast.Attribute):
            if node.attr.startswith("_"):
                return "Execution skipped: private/dunder attributes are not allowed."

            if node.attr not in ALLOWED_METHODS:
                return (
                    "Execution skipped: attribute "
                    f"'.{node.attr}' is not in the safe method allowlist."
                )

        if isinstance(node, ast.Call):

            if isinstance(node.func, ast.Name):
                if (
                    node.func.id not in ALLOWED_CALLS
                    and node.func.id not in defined_functions
                ):
                    return (
                        "Execution skipped: only allowlisted built-ins "
                        "and functions defined in the snippet are supported."
                    )

            elif isinstance(node.func, ast.Attribute):
                # Already validated against ALLOWED_METHODS above.
                pass

            else:
                return (
                    "Execution skipped: indirect function calls "
                    "are not supported."
                )

        if isinstance(node, ast.FunctionDef) and node.decorator_list:
            return "Execution skipped: decorators are not allowed."

    return None


def _run_python_snippet(code: str) -> str:
    """Run a validated snippet with a timeout and temporary directory."""

    validation_error = _validate_python_snippet(code)

    if validation_error:
        return validation_error

    try:
        with tempfile.TemporaryDirectory(
            prefix="ghostai-check-"
        ) as temp_dir:

            script_path = Path(temp_dir) / "snippet.py"
            script_path.write_text(
                code,
                encoding="utf-8",
            )

            completed = subprocess.run(
                [
                    sys.executable,
                    "-I",
                    str(script_path),
                ],
                cwd=temp_dir,
                stdin=subprocess.DEVNULL,
                capture_output=True,
                text=True,
                timeout=CODE_TIMEOUT_SECONDS,
                check=False,
                env={
                    "PATH": os.environ.get("PATH", ""),
                    # Windows par SYSTEMROOT ke bina Python start nahi hota
                    "SYSTEMROOT": os.environ.get("SYSTEMROOT", ""),
                    "PYTHONIOENCODING": "utf-8",
                },
            )

            stdout = completed.stdout.strip()
            stderr = completed.stderr.strip()

            if completed.returncode == 0:
                return (
                    "Execution completed successfully.\n"
                    "STDOUT:\n"
                    f"{stdout or '<no output>'}"
                )

            return (
                f"Execution failed with exit code "
                f"{completed.returncode}.\n"
                "STDOUT:\n"
                f"{stdout or '<empty>'}\n"
                "STDERR / traceback:\n"
                f"{stderr or '<empty>'}"
            )

    except subprocess.TimeoutExpired:
        return (
            "Execution stopped: snippet exceeded "
            f"{CODE_TIMEOUT_SECONDS} seconds."
        )

    except OSError as exc:
        return (
            "Execution unavailable: "
            f"{type(exc).__name__}: {exc}"
        )


# =========================================================
# FASTAPI APPLICATION
# =========================================================

app = FastAPI(
    title="GhostAI API",
    version="1.4.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        FRONTEND_ORIGIN,
        "http://127.0.0.1:3000",
    ],
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)


# =========================================================
# REQUEST MODELS
# =========================================================

class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]

    content: str = Field(
        min_length=1,
        max_length=20000,
    )


class ChatRequest(BaseModel):
    messages: list[ChatMessage] = Field(
        min_length=1,
        max_length=80,
    )

    model: str | None = None


# =========================================================
# HEALTH AND ROOT ENDPOINTS
# =========================================================

@app.get("/")
async def root():
    return {
        "name": "GhostAI API",
        "version": "1.4.0",
        "docs": "/docs",
        "health": "/health",
    }


@app.get("/health")
async def health():
    try:
        async with httpx.AsyncClient(
            timeout=3.0
        ) as client:

            response = await client.get(
                f"{OLLAMA_URL}/api/tags"
            )

            response.raise_for_status()
            data = response.json()

            tags = data.get("models", [])

            model_names = [
                item.get("name", "")
                for item in tags
                if isinstance(item, dict)
            ]

            model_ready = any(
                name == OLLAMA_MODEL
                or name.startswith(OLLAMA_MODEL + ":")
                for name in model_names
            )

            return {
                "status": "ok",
                "ollama": "connected",
                "model": OLLAMA_MODEL,
                "model_ready": model_ready,
            }

    except (httpx.HTTPError, ValueError):
        return {
            "status": "ok",
            "ollama": "disconnected",
            "model": OLLAMA_MODEL,
            "model_ready": False,
        }


# =========================================================
# CHAT ENDPOINT
# =========================================================

@app.post("/api/chat")
async def chat(payload: ChatRequest):

    model = (payload.model or OLLAMA_MODEL).strip()

    if not model or len(model) > 100:
        raise HTTPException(
            status_code=400,
            detail="Invalid model name.",
        )

    # Preserve the existing frontend request format.
    # Send only the most recent 12 messages to Ollama.
    messages = [
        {
            "role": "system",
            "content": SYSTEM_PROMPT,
        }
    ]

    messages.extend(
        {
            "role": item.role,
            "content": item.content,
        }
        for item in payload.messages[-12:]
    )

    # Inspect the latest user message for supported Python code.
    latest_user_message = next(
        (
            item.content
            for item in reversed(payload.messages)
            if item.role == "user"
        ),
        "",
    )

    python_code = _extract_python_code(
        latest_user_message
    )

    if python_code:
        execution_evidence = _run_python_snippet(
            python_code
        )

        # Attach the evidence INSIDE the latest user message
        # (small models often ignore a late system message).
        for msg in reversed(messages):
            if msg["role"] == "user":
                msg["content"] += (
                    "\n\n[Real execution result of the code above, "
                    "produced by a local Python checker]\n"
                    f"{execution_evidence}\n\n"
                    "Use this result as evidence. If it says execution "
                    "was skipped, do not claim the code ran. "
                    "Explain the actual result, then give the smallest "
                    "fix. Do not claim the corrected code was executed."
                )
                break

    request_body = {
        "model": model,
        "messages": messages,
        "stream": False,
        "keep_alive": "5m",
        "options": {
            "temperature": 0.0,
            "num_ctx": OLLAMA_NUM_CTX,
        },
    }

    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(
                180.0,
                connect=5.0,
            )
        ) as client:

            response = await client.post(
                f"{OLLAMA_URL}/api/chat",
                json=request_body,
            )

            if response.status_code >= 400:
                try:
                    error_data = response.json()

                    if isinstance(error_data, dict):
                        detail = error_data.get(
                            "error",
                            "Ollama returned an error.",
                        )
                    else:
                        detail = "Ollama returned an error."

                except ValueError:
                    detail = "Ollama returned an error."

                raise HTTPException(
                    status_code=502,
                    detail=detail,
                )

            data = response.json()

    except httpx.ConnectError as exc:
        raise HTTPException(
            status_code=503,
            detail=(
                "Cannot connect to Ollama. Start Ollama "
                "and make sure it is listening on port 11434."
            ),
        ) from exc

    except httpx.TimeoutException as exc:
        raise HTTPException(
            status_code=504,
            detail=(
                "The model took too long to respond. "
                "Try a shorter prompt or check Ollama."
            ),
        ) from exc

    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=502,
            detail="Could not communicate with Ollama.",
        ) from exc

    except ValueError as exc:
        raise HTTPException(
            status_code=502,
            detail="Ollama returned an unreadable response.",
        ) from exc

    if not isinstance(data, dict):
        raise HTTPException(
            status_code=502,
            detail="Ollama returned an invalid response format.",
        )

    message_data = data.get("message", {})

    if not isinstance(message_data, dict):
        raise HTTPException(
            status_code=502,
            detail="Ollama returned an invalid message format.",
        )

    message = message_data.get("content", "")

    if not isinstance(message, str) or not message.strip():
        raise HTTPException(
            status_code=502,
            detail="Ollama returned an empty response.",
        )

    return {
        "message": message.strip(),
        "model": model,
    }


# =========================================================
# LOCAL DEVELOPMENT ENTRY POINT
# =========================================================

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "main:app",
        host="127.0.0.1",
        port=8000,
        reload=True,
    )