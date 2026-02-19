#!/usr/bin/env python3
"""Local web app server for editing multiple files and running type checkers."""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
import mimetypes
import os
import re
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
from urllib.parse import urlsplit


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
DEFAULT_DEPENDENCIES: list[str] = []


@dataclass(frozen=True)
class ToolSpec:
    name: str
    command: list[str]
    version_command: list[str]


TOOL_SPECS = [
    ToolSpec("ty", ["uvx", "ty", "check", "."], ["uvx", "ty", "--version"]),
    ToolSpec("pyright", ["uvx", "pyright", "--outputjson", "."], ["uvx", "pyright", "--version"]),
    ToolSpec("pyrefly", ["uvx", "pyrefly", "check", "."], ["uvx", "pyrefly", "--version"]),
    ToolSpec("mypy", ["uvx", "mypy", "--color-output", "."], ["uvx", "mypy", "--version"]),
    ToolSpec("zuban", ["uvx", "zuban", "check", "."], ["uvx", "zuban", "--version"]),
    ToolSpec(
        "pycroscope",
        ["uvx", "pycroscope", "--output-format", "concise", "."],
        ["uvx", "--from", "pycroscope", "python", "-c", "import importlib.metadata as m; print(m.version('pycroscope'))"],
    ),
]
TOOL_SPEC_BY_NAME = {spec.name: spec for spec in TOOL_SPECS}
TOOL_ORDER = [spec.name for spec in TOOL_SPECS]
RUFF_TY_TOOL_NAME = "ty_ruff"


APP_ROOT = Path(__file__).resolve().parent
STATIC_DIR = APP_ROOT / "static"
STATE_LOCK = threading.Lock()
PROJECT_DIR = Path(tempfile.mkdtemp(prefix="multifile-editor-"))
TOOL_VERSIONS: dict[str, str] = {spec.name: "unknown" for spec in TOOL_SPECS}
ANALYZE_TOOL_TIMEOUT_SECONDS = 2
PRIME_TOOL_TIMEOUT_SECONDS = 120
LOCAL_CHECKOUT_TOOL_TIMEOUT_SECONDS: int | None = None


def _json_response(handler: BaseHTTPRequestHandler, status: int, payload: dict[str, Any]) -> None:
    data = json.dumps(payload).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(data)))
    handler.end_headers()
    handler.wfile.write(data)


def _bytes_response(handler: BaseHTTPRequestHandler, status: int, content_type: str, data: bytes) -> None:
    handler.send_response(status)
    handler.send_header("Content-Type", content_type)
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


def _reset_project_dir(project_dir: Path, *, keep_venv: bool) -> None:
    if not project_dir.exists():
        project_dir.mkdir(parents=True, exist_ok=True)
        return

    for child in project_dir.iterdir():
        # Keep .venv across analyses to avoid reinstalling everything on each edit.
        if keep_venv and child.name == ".venv":
            continue
        if child.is_dir():
            shutil.rmtree(child)
        else:
            child.unlink()


def _write_files_to_project(project_dir: Path, files: list[dict[str, Any]], *, keep_venv: bool) -> None:
    _reset_project_dir(project_dir, keep_venv=keep_venv)
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

        destination = project_dir / rel
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(content, encoding="utf-8")


def _command_env() -> dict[str, str]:
    env = os.environ.copy()
    env.setdefault("TERM", "xterm-256color")
    env.setdefault("FORCE_COLOR", "1")
    env.setdefault("CLICOLOR_FORCE", "1")
    env.setdefault("PY_COLORS", "1")
    env.pop("NO_COLOR", None)
    return env


def _normalize_dependencies(raw: Any) -> list[str]:
    if raw is None:
        return []

    candidates: list[str]
    if isinstance(raw, str):
        candidates = re.split(r"[\n,]", raw)
    elif isinstance(raw, list):
        candidates = []
        for item in raw:
            if not isinstance(item, str):
                raise ValueError("Dependencies list must contain only strings")
            candidates.append(item)
    else:
        raise ValueError("Dependencies must be a list of strings or a comma/newline separated string")

    normalized: list[str] = []
    seen: set[str] = set()
    for dep in candidates:
        value = dep.strip()
        if not value or value in seen:
            continue
        seen.add(value)
        normalized.append(value)
    return normalized


def _normalize_enabled_tools(raw: Any) -> list[str]:
    return _normalize_enabled_tools_for_order(raw, TOOL_ORDER)


def _normalize_enabled_tools_for_order(raw: Any, tool_order: list[str]) -> list[str]:
    allowed = set(tool_order)
    if raw is None:
        return list(tool_order)

    if not isinstance(raw, list):
        raise ValueError("enabled_tools must be a list of tool names")

    requested: set[str] = set()
    for item in raw:
        if not isinstance(item, str):
            raise ValueError("enabled_tools must contain only strings")
        name = item.strip()
        if not name:
            continue
        if name not in allowed:
            raise ValueError(f"Unknown tool: {name!r}")
        requested.add(name)

    return [tool_name for tool_name in tool_order if tool_name in requested]


def _normalize_ruff_repo_path(raw: Any) -> Path | None:
    if raw is None:
        return None
    if not isinstance(raw, str):
        raise ValueError("ruff_repo_path must be a string")

    text = raw.strip()
    if not text:
        return None

    path = Path(text).expanduser()
    try:
        resolved = path.resolve(strict=True)
    except FileNotFoundError as exc:
        raise ValueError(f"Ruff repo path does not exist: {text!r}") from exc
    except OSError as exc:
        raise ValueError(f"Could not resolve Ruff repo path {text!r}: {exc}") from exc

    if not resolved.is_dir():
        raise ValueError(f"Ruff repo path is not a directory: {text!r}")
    if not (resolved / "Cargo.toml").is_file():
        raise ValueError(f"Ruff repo path does not look like a cargo workspace: {text!r}")
    return resolved


def _tool_order_for_request(ruff_repo_path: Path | None) -> list[str]:
    order = list(TOOL_ORDER)
    if ruff_repo_path is None:
        return order

    try:
        ty_index = order.index("ty")
    except ValueError:
        order.insert(0, RUFF_TY_TOOL_NAME)
    else:
        order.insert(ty_index + 1, RUFF_TY_TOOL_NAME)
    return order


def _ensure_minimal_pyproject(project_dir: Path) -> None:
    pyproject = project_dir / "pyproject.toml"
    if pyproject.exists():
        return
    pyproject.write_text(
        (
            "[project]\n"
            "name = \"multifile-editor-temp\"\n"
            "version = \"0.0.0\"\n"
            "requires-python = \">=3.10\"\n"
            "dependencies = []\n"
        ),
        encoding="utf-8",
    )


def _venv_python_path(project_dir: Path) -> Path | None:
    candidates = [
        project_dir / ".venv" / "bin" / "python",
        project_dir / ".venv" / "Scripts" / "python.exe",
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return None


def _run_uv_add_dependencies(project_dir: Path, dependencies: list[str], timeout_seconds: int = 300) -> dict[str, Any]:
    if not dependencies:
        return {
            "ran": False,
            "command": "",
            "returncode": 0,
            "duration_ms": 0,
            "output": "",
            "dependencies": [],
        }

    _ensure_minimal_pyproject(project_dir)
    command = ["uv", "add", *dependencies]
    started = time.perf_counter()
    try:
        completed = subprocess.run(
            command,
            cwd=project_dir,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            env=_command_env(),
            check=False,
        )
        output = (completed.stdout or "") + (completed.stderr or "")
        returncode = completed.returncode
    except FileNotFoundError as exc:
        output = f"Command not found: {exc}"
        returncode = -1
    except subprocess.TimeoutExpired:
        output = f"Timed out after {timeout_seconds}s: {' '.join(command)}"
        returncode = -2

    duration_ms = int((time.perf_counter() - started) * 1000)
    return {
        "ran": True,
        "command": " ".join(command),
        "returncode": returncode,
        "duration_ms": duration_ms,
        "output": output,
        "dependencies": dependencies,
    }


def _insert_flag_before_target(command: list[str], flag: str, value: str) -> list[str]:
    if command and command[-1] == ".":
        return [*command[:-1], flag, value, command[-1]]
    return [*command, flag, value]


def _command_for_tool(spec: ToolSpec, venv_python: Path | None) -> list[str]:
    command = list(spec.command)
    if venv_python is None:
        return command

    if spec.name == "mypy":
        return _insert_flag_before_target(command, "--python-executable", str(venv_python))

    if spec.name == "pyright":
        return _insert_flag_before_target(command, "--pythonpath", str(venv_python))

    if spec.name == "pyrefly":
        return _insert_flag_before_target(command, "--python-interpreter-path", str(venv_python))

    if spec.name == "ty":
        return _insert_flag_before_target(command, "--python", str(venv_python))

    return command


def _run_command(
    name: str,
    command: list[str],
    cwd: Path,
    timeout_seconds: int | None = 120,
    env_overrides: dict[str, str] | None = None,
) -> dict[str, Any]:
    started = time.perf_counter()
    env = _command_env()
    if env_overrides:
        env.update(env_overrides)
    if name == "pycroscope":
        existing_pythonpath = env.get("PYTHONPATH", "")
        project_path = str(cwd)
        env["PYTHONPATH"] = (
            f"{project_path}{os.pathsep}{existing_pythonpath}"
            if existing_pythonpath
            else project_path
        )

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
        output = _format_pyright_output(stdout, stderr, cwd) if name == "pyright" else (stdout + stderr)
        returncode = completed.returncode
    except FileNotFoundError as exc:
        output = f"Command not found: {exc}"
        returncode = -1
    except subprocess.TimeoutExpired:
        output = f"Timed out after {timeout_seconds}s: {' '.join(command)}"
        returncode = -2

    duration_ms = int((time.perf_counter() - started) * 1000)
    return {
        "tool": name,
        "command": " ".join(command),
        "returncode": returncode,
        "duration_ms": duration_ms,
        "output": output,
    }


_VERSION_RE = re.compile(r"\b\d+(?:\.\d+){1,3}(?:[-+._a-zA-Z0-9]*)?\b")


def _extract_version(output: str) -> str:
    for line in output.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        match = _VERSION_RE.search(stripped)
        if match:
            return match.group(0)
    return "unknown"


def _detect_tool_versions(cwd: Path, timeout_seconds: int = 60) -> dict[str, dict[str, Any]]:
    version_results: dict[str, dict[str, Any]] = {}
    env = _command_env()

    for spec in TOOL_SPECS:
        started = time.perf_counter()
        try:
            completed = subprocess.run(
                spec.version_command,
                cwd=cwd,
                capture_output=True,
                text=True,
                timeout=timeout_seconds,
                env=env,
                check=False,
            )
            stdout = completed.stdout or ""
            stderr = completed.stderr or ""
            combined = (stdout + "\n" + stderr).strip()
            returncode = completed.returncode
            version = _extract_version(combined) if returncode == 0 else "unknown"
        except FileNotFoundError as exc:
            combined = f"Command not found: {exc}"
            returncode = -1
            version = "unknown"
        except subprocess.TimeoutExpired:
            combined = f"Timed out after {timeout_seconds}s: {' '.join(spec.version_command)}"
            returncode = -2
            version = "unknown"

        duration_ms = int((time.perf_counter() - started) * 1000)
        version_results[spec.name] = {
            "tool": spec.name,
            "command": " ".join(spec.version_command),
            "returncode": returncode,
            "duration_ms": duration_ms,
            "version": version,
            "output": combined,
        }

    return version_results


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

            severity = item.get("severity") if isinstance(item.get("severity"), str) else "info"
            message = item.get("message") if isinstance(item.get("message"), str) else ""

            line_no = "?"
            col_no = "?"
            range_obj = item.get("range")
            if isinstance(range_obj, dict):
                start = range_obj.get("start")
                if isinstance(start, dict):
                    line = start.get("line")
                    col = start.get("character")
                    if isinstance(line, int):
                        line_no = str(line + 1)
                    if isinstance(col, int):
                        col_no = str(col + 1)

            rule_suffix = ""
            rule = item.get("rule")
            if isinstance(rule, str) and rule:
                rule_suffix = f" [{rule}]"

            lines.append(f"{display_path}:{line_no}:{col_no}: {severity}: {message}{rule_suffix}")

    summary = payload.get("summary")
    if isinstance(summary, dict):
        files = summary.get("filesAnalyzed")
        errors = summary.get("errorCount")
        warnings = summary.get("warningCount")
        information = summary.get("informationCount")
        time_in_sec = summary.get("timeInSec")
        lines.append(
            "summary: "
            f"files={files if isinstance(files, int) else '?'} "
            f"errors={errors if isinstance(errors, int) else '?'} "
            f"warnings={warnings if isinstance(warnings, int) else '?'} "
            f"information={information if isinstance(information, int) else '?'} "
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

    for absolute_path, root in candidates:
        try:
            return absolute_path.relative_to(root).as_posix()
        except ValueError:
            continue

    return path.as_posix()


def _venv_env_overrides(venv_python: Path | None) -> dict[str, str] | None:
    if venv_python is None:
        return None

    venv_dir = venv_python.parent.parent
    venv_bin = venv_python.parent
    return {
        "VIRTUAL_ENV": str(venv_dir),
        "PATH": f"{venv_bin}{os.pathsep}{os.environ.get('PATH', '')}",
    }


def _ruff_ty_command(project_dir: Path, venv_python: Path | None) -> list[str]:
    command = ["cargo", "run", "--bin", "ty", "--", "check", "--project", str(project_dir)]
    if venv_python is not None:
        command.extend(["--python", str(venv_python)])
    return command


def _run_ruff_ty_from_repo(
    ruff_repo_path: Path,
    project_dir: Path,
    venv_python: Path | None,
    timeout_seconds: int | None,
) -> dict[str, Any]:
    return _run_command(
        RUFF_TY_TOOL_NAME,
        _ruff_ty_command(project_dir, venv_python),
        ruff_repo_path,
        timeout_seconds,
        _venv_env_overrides(venv_python),
    )


def _run_all_tools(
    project_dir: Path,
    venv_python: Path | None = None,
    enabled_tools: list[str] | None = None,
    timeout_seconds: int = 120,
) -> dict[str, dict[str, Any]]:
    results: dict[str, dict[str, Any]] = {}
    env_overrides = _venv_env_overrides(venv_python)

    selected_specs = TOOL_SPECS if enabled_tools is None else [TOOL_SPEC_BY_NAME[name] for name in enabled_tools]
    if not selected_specs:
        return results

    command_by_tool = {spec.name: _command_for_tool(spec, venv_python) for spec in selected_specs}
    with ThreadPoolExecutor(max_workers=max(1, len(selected_specs))) as executor:
        futures = {
            executor.submit(
                _run_command,
                tool_name,
                command,
                project_dir,
                timeout_seconds,
                env_overrides,
            ): tool_name
            for tool_name, command in command_by_tool.items()
        }
        for future in as_completed(futures):
            tool_name = futures[future]
            command = command_by_tool[tool_name]
            try:
                results[tool_name] = future.result()
            except Exception as exc:  # pragma: no cover
                results[tool_name] = {
                    "tool": tool_name,
                    "command": " ".join(command),
                    "returncode": -3,
                    "duration_ms": 0,
                    "output": f"Internal error: {exc}",
                }
    return results


def _prime_tool_installs() -> tuple[dict[str, dict[str, Any]], dict[str, dict[str, Any]]]:
    """Warm uvx tool installs and collect tool versions."""
    prime_dir = Path(tempfile.mkdtemp(prefix="multifile-editor-prime-"))
    try:
        _write_files_to_project(
            prime_dir,
            [{"name": "main.py", "content": "x: int = 1\n"}],
            keep_venv=False,
        )
        prime_results = _run_all_tools(prime_dir, timeout_seconds=PRIME_TOOL_TIMEOUT_SECONDS)
        version_results = _detect_tool_versions(prime_dir)
        return prime_results, version_results
    finally:
        shutil.rmtree(prime_dir, ignore_errors=True)


def _resolve_static_file(url_path: str) -> Path | None:
    if url_path == "/":
        candidate = STATIC_DIR / "index.html"
        return candidate if candidate.is_file() else None

    if not url_path.startswith("/static/"):
        return None

    relative = url_path[len("/static/") :]
    if not relative:
        return None

    static_root = STATIC_DIR.resolve()
    candidate = (static_root / relative).resolve()
    try:
        candidate.relative_to(static_root)
    except ValueError:
        return None

    if not candidate.is_file():
        return None
    return candidate


def _content_type_for(path: Path) -> str:
    guessed, _ = mimetypes.guess_type(str(path))
    if guessed is None:
        return "application/octet-stream"
    if guessed.startswith("text/") or guessed in {"application/javascript", "application/json"}:
        return f"{guessed}; charset=utf-8"
    return guessed


class AppHandler(BaseHTTPRequestHandler):
    server_version = "MultifileEditor/2.0"

    def log_message(self, format: str, *args: Any) -> None:
        print(f"[{self.log_date_time_string()}] {self.address_string()} - {format % args}")

    def do_GET(self) -> None:  # noqa: N802
        path = urlsplit(self.path).path

        if path == "/api/health":
            _json_response(self, HTTPStatus.OK, {"ok": True, "temp_dir": str(PROJECT_DIR)})
            return

        if path == "/api/bootstrap":
            _json_response(
                self,
                HTTPStatus.OK,
                {
                    "initial_files": DEFAULT_FILES,
                    "initial_dependencies": DEFAULT_DEPENDENCIES,
                    "tool_order": list(TOOL_ORDER),
                    "enabled_tools": list(TOOL_ORDER),
                    "initial_ruff_repo_path": "",
                    "tool_versions": dict(TOOL_VERSIONS),
                    "temp_dir": str(PROJECT_DIR),
                },
            )
            return

        static_file = _resolve_static_file(path)
        if static_file is not None:
            data = static_file.read_bytes()
            _bytes_response(self, HTTPStatus.OK, _content_type_for(static_file), data)
            return

        _json_response(self, HTTPStatus.NOT_FOUND, {"error": "Not found"})

    def do_POST(self) -> None:  # noqa: N802
        path = urlsplit(self.path).path
        if path != "/api/analyze":
            _json_response(self, HTTPStatus.NOT_FOUND, {"error": "Not found"})
            return

        try:
            body = self._read_json_body()
            files = body.get("files")
            if not isinstance(files, list) or not files:
                raise ValueError("Expected non-empty 'files' list")
            dependencies = _normalize_dependencies(body.get("dependencies", DEFAULT_DEPENDENCIES))
            ruff_repo_path = _normalize_ruff_repo_path(body.get("ruff_repo_path"))
            tool_order = _tool_order_for_request(ruff_repo_path)
            enabled_tools = _normalize_enabled_tools_for_order(body.get("enabled_tools"), tool_order)

            with STATE_LOCK:
                _write_files_to_project(PROJECT_DIR, files, keep_venv=bool(dependencies))
                dependency_install = _run_uv_add_dependencies(PROJECT_DIR, dependencies)
                if dependency_install["returncode"] != 0:
                    _json_response(
                        self,
                        HTTPStatus.BAD_REQUEST,
                        {
                            "error": "Dependency install failed",
                            "error_type": "dependency_install_failed",
                            "dependency_install": dependency_install,
                            "dependencies": dependencies,
                            "enabled_tools": enabled_tools,
                            "tool_order": tool_order,
                            "ruff_repo_path": str(ruff_repo_path) if ruff_repo_path is not None else "",
                            "tool_versions": dict(TOOL_VERSIONS),
                            "temp_dir": str(PROJECT_DIR),
                        },
                    )
                    return

                venv_python = _venv_python_path(PROJECT_DIR) if dependencies else None
                base_enabled_tools = [tool_name for tool_name in enabled_tools if tool_name in TOOL_SPEC_BY_NAME]
                results = _run_all_tools(
                    PROJECT_DIR,
                    venv_python,
                    base_enabled_tools,
                    timeout_seconds=ANALYZE_TOOL_TIMEOUT_SECONDS,
                )
                if ruff_repo_path is not None and RUFF_TY_TOOL_NAME in enabled_tools:
                    results[RUFF_TY_TOOL_NAME] = _run_ruff_ty_from_repo(
                        ruff_repo_path,
                        PROJECT_DIR,
                        venv_python,
                        LOCAL_CHECKOUT_TOOL_TIMEOUT_SECONDS,
                    )

            _json_response(
                self,
                HTTPStatus.OK,
                {
                    "results": results,
                    "tool_versions": dict(TOOL_VERSIONS),
                    "dependencies": dependencies,
                    "enabled_tools": enabled_tools,
                    "tool_order": tool_order,
                    "ruff_repo_path": str(ruff_repo_path) if ruff_repo_path is not None else "",
                    "dependency_install": dependency_install,
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
    parser.add_argument(
        "--skip-prime",
        action="store_true",
        help="Skip startup uvx priming (default: prime enabled)",
    )
    return parser.parse_args()


def main() -> None:
    if not STATIC_DIR.is_dir():
        raise SystemExit(f"Static directory not found: {STATIC_DIR}")

    args = parse_args()
    if not args.skip_prime:
        print("Priming tool installs (uvx)...")
        prime_results, version_results = _prime_tool_installs()
        for spec in TOOL_SPECS:
            version_info = version_results.get(spec.name, {})
            raw_version = version_info.get("version")
            TOOL_VERSIONS[spec.name] = raw_version if isinstance(raw_version, str) and raw_version else "unknown"

        for spec in TOOL_SPECS:
            result = prime_results.get(spec.name, {})
            version = TOOL_VERSIONS.get(spec.name, "unknown")
            returncode = result.get("returncode", "?")
            duration_ms = result.get("duration_ms", "?")
            print(f"  {spec.name} v{version}: rc={returncode} ({duration_ms}ms)")
            if returncode != 0:
                output = str(result.get("output", "")).strip()
                first_line = output.splitlines()[0] if output else ""
                if first_line:
                    print(f"    {first_line}")
    else:
        print("Skipping tool priming (--skip-prime)")

    server = ThreadingHTTPServer((args.host, args.port), AppHandler)
    print(f"Serving app on http://{args.host}:{args.port}")
    print(f"Static directory: {STATIC_DIR}")
    print(f"Temporary project directory: {PROJECT_DIR}")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down...")
    finally:
        server.server_close()
        shutil.rmtree(PROJECT_DIR, ignore_errors=True)


if __name__ == "__main__":
    main()
