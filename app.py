#!/usr/bin/env python3
"""Local web app for editing multiple files and running type checkers."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import tempfile
import threading
import time
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


DEFAULT_FILES = [
    {
        "name": "main.py",
        "content": (
            "from helpers import greet\n\n"
            "def run() -> None:\n"
            "    print(greet('world'))\n\n"
            "if __name__ == '__main__':\n"
            "    run()\n"
        ),
    },
    {"name": "helpers.py", "content": "def greet(name: str) -> str:\n    return f'hello, {name}'\n"},
]


@dataclass(frozen=True)
class ToolSpec:
    name: str
    command: list[str]


TOOL_SPECS = [
    ToolSpec("mypy", ["uvx", "mypy", "."]),
    ToolSpec("pyright", ["uvx", "pyright", "--outputjson", "."]),
    ToolSpec("pyrefly", ["uvx", "pyrefly", "check", "."]),
    ToolSpec("ty", ["uvx", "ty", "check", "."]),
]


STATE_LOCK = threading.Lock()
PROJECT_DIR = Path(tempfile.mkdtemp(prefix="multifile-editor-"))
UV_CACHE_DIR = Path(tempfile.mkdtemp(prefix="multifile-editor-uv-cache-"))
UV_TOOL_DIR = Path(tempfile.mkdtemp(prefix="multifile-editor-uv-tools-"))


INDEX_HTML = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Multi-file Typechecker Editor</title>
  <style>
    :root {
      --bg: #f0efe9;
      --panel: #fffdf8;
      --ink: #1f2328;
      --muted: #5a6470;
      --accent: #0d7a6f;
      --accent-strong: #085e56;
      --border: #d8d3c4;
      --error: #a22d2d;
      --shadow: 0 10px 25px rgba(31, 35, 40, 0.08);
      --mono: "JetBrains Mono", "SFMono-Regular", Menlo, Consolas, monospace;
      --sans: "IBM Plex Sans", "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: var(--sans);
      color: var(--ink);
      background:
        radial-gradient(circle at 20% 15%, #d4ece8 0%, transparent 40%),
        radial-gradient(circle at 80% 0%, #f5dfc2 0%, transparent 35%),
        var(--bg);
      min-height: 100vh;
    }
    .container {
      max-width: 1900px;
      margin: 24px auto;
      padding: 0 16px 20px;
      display: grid;
      grid-template-rows: auto auto 1fr;
      gap: 12px;
    }
    .workspace {
      display: grid;
      grid-template-columns: 1fr;
      gap: 12px;
      min-width: 0;
    }
    .header {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 12px;
      box-shadow: var(--shadow);
      padding: 14px 16px;
    }
    h1 {
      margin: 0 0 6px;
      font-size: 1.15rem;
      letter-spacing: 0.02em;
    }
    .status {
      margin: 0;
      color: var(--muted);
      font-size: 0.95rem;
    }
    .tabs-wrap {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 12px;
      box-shadow: var(--shadow);
      padding: 10px;
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      align-items: center;
    }
    .tab {
      border: 1px solid var(--border);
      background: #fbf9f2;
      border-radius: 999px;
      padding: 6px 12px;
      cursor: pointer;
      font-size: 0.92rem;
    }
    .tab.active {
      background: var(--accent);
      color: #fff;
      border-color: var(--accent);
    }
    .controls {
      margin-left: auto;
      display: flex;
      gap: 8px;
      align-items: center;
    }
    button, input {
      font: inherit;
    }
    .name-input {
      width: 220px;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 6px 10px;
      background: #fff;
    }
    .btn {
      border: 1px solid var(--accent);
      border-radius: 8px;
      padding: 6px 10px;
      background: #fff;
      color: var(--accent-strong);
      cursor: pointer;
    }
    .btn:hover {
      background: #e7f3f1;
    }
    .editor-wrap {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 12px;
      box-shadow: var(--shadow);
      overflow: hidden;
    }
    textarea {
      width: 100%;
      min-height: 420px;
      border: none;
      outline: none;
      resize: vertical;
      padding: 14px;
      font-family: var(--mono);
      font-size: 0.92rem;
      line-height: 1.45;
      background: #fff;
      color: #18202a;
    }
    .results {
      display: flex;
      flex-direction: column;
      gap: 12px;
      min-width: 0;
    }
    .result-card {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 12px;
      box-shadow: var(--shadow);
      overflow: hidden;
      min-height: 220px;
      display: flex;
      flex-direction: column;
    }
    .result-header {
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
      background: #f7f3ea;
      font-size: 0.92rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .result-header .meta {
      color: var(--muted);
      font-size: 0.8rem;
    }
    pre {
      margin: 0;
      padding: 12px;
      overflow: auto;
      font-family: var(--mono);
      font-size: 0.82rem;
      line-height: 1.4;
      flex: 1;
      white-space: pre-wrap;
      word-break: break-word;
      background: #fff;
    }
    .bad {
      color: var(--error);
      font-weight: 600;
    }
    @media (min-width: 1650px) {
      .workspace {
        grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr);
        align-items: start;
      }
      .result-card {
        min-height: 180px;
      }
    }
    @media (max-width: 980px) {
      .controls {
        margin-left: 0;
      }
      .name-input {
        width: 160px;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Multi-file editor with live type checking</h1>
      <p class="status" id="status">Idle</p>
      <p class="status" id="temp-dir"></p>
    </div>

    <div class="tabs-wrap">
      <div id="tabs"></div>
      <div class="controls">
        <input class="name-input" id="filename" placeholder="filename.py" />
        <button class="btn" id="add-file">Add file</button>
        <button class="btn" id="remove-file">Remove file</button>
      </div>
    </div>

    <div class="workspace">
      <div class="editor-wrap">
        <textarea id="editor" spellcheck="false"></textarea>
      </div>

      <div class="results" id="results"></div>
    </div>
  </div>

  <script>
    const initialFiles = __INITIAL_FILES__;
    const toolOrder = ["mypy", "pyright", "pyrefly", "ty"];

    const state = {
      files: initialFiles.slice(),
      activeIndex: 0,
      debounceMs: 500,
      debounceTimer: null,
      requestNumber: 0,
      latestHandledRequest: 0
    };

    const tabsEl = document.getElementById("tabs");
    const filenameEl = document.getElementById("filename");
    const editorEl = document.getElementById("editor");
    const statusEl = document.getElementById("status");
    const resultsEl = document.getElementById("results");
    const tempDirEl = document.getElementById("temp-dir");
    const addFileBtn = document.getElementById("add-file");
    const removeFileBtn = document.getElementById("remove-file");

    function setStatus(text) {
      statusEl.textContent = text;
    }

    function activeFile() {
      return state.files[state.activeIndex];
    }

    function renderTabs() {
      tabsEl.innerHTML = "";
      state.files.forEach((file, idx) => {
        const btn = document.createElement("button");
        btn.className = "tab" + (idx === state.activeIndex ? " active" : "");
        btn.textContent = file.name;
        btn.addEventListener("click", () => {
          state.activeIndex = idx;
          syncEditorFromState();
          renderTabs();
        });
        tabsEl.appendChild(btn);
      });
    }

    function syncEditorFromState() {
      const file = activeFile();
      filenameEl.value = file ? file.name : "";
      editorEl.value = file ? file.content : "";
      removeFileBtn.disabled = state.files.length <= 1;
    }

    function normalizeName(name) {
      return name.trim().replace(/\\\\/g, "/");
    }

    function isUniqueName(name, ignoreIndex) {
      return !state.files.some((f, idx) => idx !== ignoreIndex && f.name === name);
    }

    function scheduleAnalyze() {
      if (state.debounceTimer) {
        clearTimeout(state.debounceTimer);
      }
      state.debounceTimer = setTimeout(() => {
        analyze();
      }, state.debounceMs);
    }

    function updateActiveFileContent(content) {
      const file = activeFile();
      if (!file) {
        return;
      }
      file.content = content;
      scheduleAnalyze();
    }

    function updateActiveFileName(name) {
      const file = activeFile();
      if (!file) {
        return;
      }
      const normalized = normalizeName(name);
      if (!normalized || normalized === file.name) {
        return;
      }
      if (!isUniqueName(normalized, state.activeIndex)) {
        setStatus("Duplicate filename: " + normalized);
        filenameEl.classList.add("bad");
        return;
      }
      filenameEl.classList.remove("bad");
      file.name = normalized;
      renderTabs();
      scheduleAnalyze();
    }

    function renderResults(resultByTool) {
      resultsEl.innerHTML = "";
      toolOrder.forEach((tool) => {
        const result = resultByTool[tool] || {};
        const card = document.createElement("section");
        card.className = "result-card";

        const header = document.createElement("div");
        header.className = "result-header";
        const title = document.createElement("strong");
        title.textContent = tool;
        const meta = document.createElement("span");
        meta.className = "meta";
        const code = typeof result.returncode === "number" ? result.returncode : "?";
        const ms = typeof result.duration_ms === "number" ? result.duration_ms : 0;
        meta.textContent = "exit " + code + " | " + ms + "ms";
        header.appendChild(title);
        header.appendChild(meta);

        const pre = document.createElement("pre");
        const output = (result.output || "").trim();
        pre.textContent = output || "(no output)";

        card.appendChild(header);
        card.appendChild(pre);
        resultsEl.appendChild(card);
      });
    }

    async function analyze() {
      const requestId = ++state.requestNumber;
      setStatus("Analyzing...");

      const payload = {
        files: state.files.map((f) => ({ name: f.name, content: f.content }))
      };

      try {
        const resp = await fetch("/api/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        const body = await resp.json();
        if (requestId < state.latestHandledRequest) {
          return;
        }
        state.latestHandledRequest = requestId;
        if (!resp.ok) {
          setStatus("Request failed: " + (body.error || resp.status));
          return;
        }
        renderResults(body.results || {});
        tempDirEl.textContent = "Temp directory: " + (body.temp_dir || "");
        setStatus("Last analysis: " + new Date().toLocaleTimeString());
      } catch (err) {
        setStatus("Error: " + err.message);
      }
    }

    addFileBtn.addEventListener("click", () => {
      let n = state.files.length + 1;
      let name = "file_" + n + ".py";
      while (!isUniqueName(name, -1)) {
        n += 1;
        name = "file_" + n + ".py";
      }
      state.files.push({ name, content: "" });
      state.activeIndex = state.files.length - 1;
      renderTabs();
      syncEditorFromState();
      scheduleAnalyze();
    });

    removeFileBtn.addEventListener("click", () => {
      if (state.files.length <= 1) {
        return;
      }
      state.files.splice(state.activeIndex, 1);
      state.activeIndex = Math.max(0, state.activeIndex - 1);
      renderTabs();
      syncEditorFromState();
      scheduleAnalyze();
    });

    editorEl.addEventListener("input", (event) => {
      updateActiveFileContent(event.target.value);
    });

    filenameEl.addEventListener("change", (event) => {
      updateActiveFileName(event.target.value);
    });
    filenameEl.addEventListener("blur", (event) => {
      updateActiveFileName(event.target.value);
    });

    renderTabs();
    syncEditorFromState();
    renderResults({});
    analyze();
  </script>
</body>
</html>
"""


def _json_response(handler: BaseHTTPRequestHandler, status: int, payload: dict[str, Any]) -> None:
    data = json.dumps(payload).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(data)))
    handler.end_headers()
    handler.wfile.write(data)


def _safe_relative_path(raw_name: str) -> Path:
    normalized = raw_name.strip().replace("\\", "/")
    if not normalized:
        raise ValueError("Filename cannot be empty")
    rel = Path(normalized)
    if rel.is_absolute():
        raise ValueError(f"Absolute path is not allowed: {raw_name!r}")
    if ".." in rel.parts:
        raise ValueError(f"Parent traversal is not allowed: {raw_name!r}")
    return rel


def _reset_project_dir(project_dir: Path) -> None:
    if project_dir.exists():
        shutil.rmtree(project_dir)
    project_dir.mkdir(parents=True, exist_ok=True)


def _write_files_to_project(project_dir: Path, files: list[dict[str, Any]]) -> None:
    _reset_project_dir(project_dir)
    seen: set[Path] = set()
    for entry in files:
        name = str(entry.get("name", ""))
        content = entry.get("content", "")
        if not isinstance(content, str):
            raise ValueError(f"Content for {name!r} must be a string")
        rel = _safe_relative_path(name)
        if rel in seen:
            raise ValueError(f"Duplicate filename: {name!r}")
        seen.add(rel)
        dest = project_dir / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(content, encoding="utf-8")


def _run_command(name: str, command: list[str], cwd: Path, timeout_seconds: int = 120) -> dict[str, Any]:
    started = time.perf_counter()
    env = os.environ.copy()
    env.setdefault("UV_CACHE_DIR", str(UV_CACHE_DIR))
    env.setdefault("UV_TOOL_DIR", str(UV_TOOL_DIR))
    try:
        completed = subprocess.run(
            command,
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            env=env,
            check=False,
        )
        stdout = completed.stdout or ""
        stderr = completed.stderr or ""
        if name == "pyright":
            output = _format_pyright_output(stdout, stderr, cwd)
        else:
            output = stdout + stderr
        rc = completed.returncode
    except FileNotFoundError as exc:
        output = f"Command not found: {exc}"
        rc = -1
    except subprocess.TimeoutExpired:
        output = f"Timed out after {timeout_seconds}s: {' '.join(command)}"
        rc = -2
    duration_ms = int((time.perf_counter() - started) * 1000)
    return {
        "tool": name,
        "command": " ".join(command),
        "returncode": rc,
        "duration_ms": duration_ms,
        "output": output,
    }


def _format_pyright_output(stdout: str, stderr: str, cwd: Path) -> str:
    try:
        payload = json.loads(stdout)
    except json.JSONDecodeError:
        return stdout + stderr

    lines: list[str] = []
    diagnostics = payload.get("generalDiagnostics")
    if isinstance(diagnostics, list):
        for item in diagnostics:
            if not isinstance(item, dict):
                continue

            file_path = item.get("file")
            display_path = "<unknown>"
            if isinstance(file_path, str) and file_path:
                display_path = _relativize_path(file_path, cwd)

            severity = item.get("severity")
            severity_text = severity if isinstance(severity, str) else "info"

            message = item.get("message")
            message_text = message if isinstance(message, str) else ""

            line_no = "?"
            col_no = "?"
            range_obj = item.get("range")
            if isinstance(range_obj, dict):
                start = range_obj.get("start")
                if isinstance(start, dict):
                    line_val = start.get("line")
                    col_val = start.get("character")
                    if isinstance(line_val, int):
                        line_no = str(line_val + 1)
                    if isinstance(col_val, int):
                        col_no = str(col_val + 1)

            rule_suffix = ""
            rule = item.get("rule")
            if isinstance(rule, str) and rule:
                rule_suffix = f" [{rule}]"

            lines.append(f"{display_path}:{line_no}:{col_no}: {severity_text}: {message_text}{rule_suffix}")

    summary = payload.get("summary")
    if isinstance(summary, dict):
        files = summary.get("filesAnalyzed")
        errors = summary.get("errorCount")
        warnings = summary.get("warningCount")
        info = summary.get("informationCount")
        time_in_sec = summary.get("timeInSec")
        lines.append(
            "summary: "
            f"files={files if isinstance(files, int) else '?'} "
            f"errors={errors if isinstance(errors, int) else '?'} "
            f"warnings={warnings if isinstance(warnings, int) else '?'} "
            f"information={info if isinstance(info, int) else '?'} "
            f"time={time_in_sec if isinstance(time_in_sec, (int, float)) else '?'}s"
        )

    if stderr.strip():
        lines.append("")
        lines.append("stderr:")
        lines.append(stderr.strip())

    if not lines:
        return "(no output)"
    return "\n".join(lines).rstrip() + "\n"


def _relativize_path(path_text: str, cwd: Path) -> str:
    try:
        path = Path(path_text)
    except (TypeError, ValueError):
        return path_text

    if not path.is_absolute():
        return path.as_posix()

    candidates: list[tuple[Path, Path]] = [(path, cwd)]
    try:
        candidates.append((path.resolve(strict=False), cwd.resolve(strict=False)))
    except OSError:
        pass

    for abs_path, root in candidates:
        try:
            return abs_path.relative_to(root).as_posix()
        except ValueError:
            continue

    # If it's outside the temp project, keep an absolute path rather than a noisy ../../.. chain.
    return path.as_posix()


def _run_all_tools(project_dir: Path) -> dict[str, dict[str, Any]]:
    results: dict[str, dict[str, Any]] = {}
    for spec in TOOL_SPECS:
        try:
            results[spec.name] = _run_command(spec.name, spec.command, project_dir)
        except Exception as exc:  # pragma: no cover
            results[spec.name] = {
                "tool": spec.name,
                "command": " ".join(spec.command),
                "returncode": -3,
                "duration_ms": 0,
                "output": f"Internal error: {exc}",
            }
    return results


class AppHandler(BaseHTTPRequestHandler):
    server_version = "MultifileEditor/1.0"

    def log_message(self, format: str, *args: Any) -> None:
        print(f"[{self.log_date_time_string()}] {self.address_string()} - {format % args}")

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/" or self.path.startswith("/?"):
            html = INDEX_HTML.replace("__INITIAL_FILES__", json.dumps(DEFAULT_FILES))
            data = html.encode("utf-8")
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return

        if self.path == "/api/health":
            _json_response(self, HTTPStatus.OK, {"ok": True, "temp_dir": str(PROJECT_DIR)})
            return

        _json_response(self, HTTPStatus.NOT_FOUND, {"error": "Not found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/api/analyze":
            _json_response(self, HTTPStatus.NOT_FOUND, {"error": "Not found"})
            return

        try:
            body = self._read_json_body()
            files = body.get("files")
            if not isinstance(files, list) or not files:
                raise ValueError("Expected non-empty 'files' list")
            with STATE_LOCK:
                _write_files_to_project(PROJECT_DIR, files)
                results = _run_all_tools(PROJECT_DIR)
            _json_response(
                self,
                HTTPStatus.OK,
                {
                    "results": results,
                    "temp_dir": str(PROJECT_DIR),
                },
            )
        except ValueError as exc:
            _json_response(self, HTTPStatus.BAD_REQUEST, {"error": str(exc)})
        except json.JSONDecodeError:
            _json_response(self, HTTPStatus.BAD_REQUEST, {"error": "Invalid JSON payload"})
        except Exception as exc:  # pragma: no cover
            _json_response(self, HTTPStatus.INTERNAL_SERVER_ERROR, {"error": f"Unexpected error: {exc}"})

    def _read_json_body(self) -> dict[str, Any]:
        raw_length = self.headers.get("Content-Length", "0").strip()
        if not raw_length.isdigit():
            raise ValueError("Invalid Content-Length header")
        length = int(raw_length)
        if length <= 0:
            raise ValueError("Empty request body")
        payload = self.rfile.read(length)
        data = json.loads(payload.decode("utf-8"))
        if not isinstance(data, dict):
            raise ValueError("JSON payload must be an object")
        return data


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Local web app with multi-file editor and typecheckers")
    parser.add_argument("--host", default="127.0.0.1", help="Host to bind (default: 127.0.0.1)")
    parser.add_argument("--port", default=8000, type=int, help="Port to bind (default: 8000)")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    server = ThreadingHTTPServer((args.host, args.port), AppHandler)
    print(f"Serving app on http://{args.host}:{args.port}")
    print(f"Temporary project directory: {PROJECT_DIR}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down...")
    finally:
        server.server_close()
        shutil.rmtree(PROJECT_DIR, ignore_errors=True)
        shutil.rmtree(UV_CACHE_DIR, ignore_errors=True)
        shutil.rmtree(UV_TOOL_DIR, ignore_errors=True)


if __name__ == "__main__":
    main()
