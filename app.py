#!/usr/bin/env python3
"""Local web app server for editing multiple files and running type checkers."""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import re
import shutil
import signal
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid
import webbrowser
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

DEFAULT_PYPROJECT_TOML = """[project]
name = "sandbox"
version = "0.1.0"
requires-python = ">=3.10"
dependencies = []


[tool.ty]
[tool.ty.rules]
undefined-reveal = "ignore"


[tool.pyright]
reportWildcardImportFromLibrary = false
reportSelfClsParameterName = false
reportUnusedExpression = false


[tool.pyrefly]
[tool.pyrefly.errors]
unimported-directive = false


[tool.mypy]
color_output = true
pretty = true
check_untyped_defs = true


[tool.zuban]
pretty = true
check_untyped_defs = true


[tool.pycroscope]
import_paths = ["."]
"""

DEFAULT_FILES = [
    {"name": "main.py", "content": ""},
    {"name": "pyproject.toml", "content": DEFAULT_PYPROJECT_TOML},
]
SUPPORTED_PYTHON_VERSIONS = ["3.10", "3.11", "3.12", "3.13", "3.14", "3.15"]
DEFAULT_PYTHON_VERSION = "3.14"


@dataclass(frozen=True)
class ToolSpec:
    name: str
    command: list[str]
    version_command: list[str]


@dataclass(frozen=True)
class ProcessResult:
    stdout: str
    stderr: str
    returncode: int
    timed_out: bool = False
    cancelled: bool = False


TOOL_SPECS = [
    ToolSpec("ty", ["ty", "check"], ["ty", "--version"]),
    ToolSpec("pyright", ["pyright", "--outputjson"], ["pyright", "--version"]),
    ToolSpec("pyrefly", ["pyrefly", "check"], ["pyrefly", "--version"]),
    ToolSpec("mypy", ["mypy"], ["mypy", "--version"]),
    ToolSpec("zuban", ["zuban", "check"], ["zuban", "--version"]),
    ToolSpec(
        "pycroscope",
        ["pycroscope", "--output-format", "concise"],
        ["python", "-c", "import importlib.metadata as m; print(m.version('pycroscope'))"],
    ),
]
TOOL_SPEC_BY_NAME = {spec.name: spec for spec in TOOL_SPECS}
TOOL_ORDER = [spec.name for spec in TOOL_SPECS]
RUFF_TY_TOOL_NAME = "ty_ruff"
PYTHON_IMPLEMENTED_TOOLS = ("mypy", "pycroscope")


APP_ROOT = Path(__file__).resolve().parent
STATIC_DIR = APP_ROOT / "static"
SERVER_ID = uuid.uuid4().hex
STATE_LOCK = threading.Lock()
ACTIVE_ANALYSES_LOCK = threading.Lock()
ACTIVE_ANALYSES: dict[str, tuple[int, threading.Event]] = {}
# Keep completed generations so delayed older requests cannot restart work.
LATEST_ANALYSIS_REQUESTS: dict[str, tuple[int, float]] = {}
ANALYSIS_REQUEST_HISTORY_TTL_SECONDS = 60 * 60
ANALYSIS_REQUEST_HISTORY_MAX_CLIENTS = 1024
STAGING_DIR = Path(tempfile.mkdtemp(prefix="multifile-editor-"))
TOOL_VERSIONS: dict[str, str] = {spec.name: "unknown" for spec in TOOL_SPECS}
ANALYZE_TOOL_TIMEOUT_SECONDS = 10
LOCAL_CHECKOUT_TOOL_TIMEOUT_SECONDS: int | None = None
DEPENDENCY_COOLDOWN = "2 days"
DEPENDENCY_COOLDOWN_EXEMPTION = "0 seconds"
DEFAULT_DEPENDENCY_COOLDOWN_EXEMPT_PACKAGES = ["ty"]


def _json_response(handler: BaseHTTPRequestHandler, status: int, payload: dict[str, Any]) -> None:
    data = json.dumps(payload).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(data)))
    handler.end_headers()
    handler.wfile.write(data)


def _ndjson_start(handler: BaseHTTPRequestHandler) -> None:
    handler.send_response(HTTPStatus.OK)
    handler.send_header("Content-Type", "application/x-ndjson")
    handler.send_header("X-Content-Type-Options", "nosniff")
    handler.end_headers()


def _ndjson_send(handler: BaseHTTPRequestHandler, obj: dict[str, Any]) -> None:
    handler.wfile.write(json.dumps(obj).encode("utf-8") + b"\n")
    handler.wfile.flush()


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


def _reset_project_dir(project_dir: Path) -> None:
    if not project_dir.exists():
        project_dir.mkdir(parents=True, exist_ok=True)
        return

    for child in project_dir.iterdir():
        if child.name == ".venv":
            continue
        if child.is_dir():
            shutil.rmtree(child)
        else:
            child.unlink()


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

        destination = project_dir / rel
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(content, encoding="utf-8")


def _snapshot_project_dir(project_dir: Path, snapshot_dir: Path) -> None:
    """Copy the current project files without sharing the mutable virtualenv."""
    for child in project_dir.iterdir():
        destination = snapshot_dir / child.name
        if child.name == ".venv":
            continue
        elif child.is_dir():
            shutil.copytree(child, destination, symlinks=True)
        else:
            shutil.copy2(child, destination, follow_symlinks=False)


def _command_env() -> dict[str, str]:
    env = os.environ.copy()
    env.setdefault("TERM", "xterm-256color")
    env.setdefault("FORCE_COLOR", "1")
    env.setdefault("CLICOLOR_FORCE", "1")
    env.setdefault("PY_COLORS", "1")
    env.pop("NO_COLOR", None)
    env.pop("VIRTUAL_ENV", None)
    return env


def _normalize_enabled_tools(raw: Any) -> list[str]:
    return _normalize_enabled_tools_for_order(raw, TOOL_ORDER)


def _normalize_analysis_identity(raw_client_id: Any, raw_request_id: Any) -> tuple[str | None, int | None]:
    if raw_client_id is None and raw_request_id is None:
        return None, None
    if not isinstance(raw_client_id, str) or not raw_client_id.strip():
        raise ValueError("analysis_client_id must be a non-empty string")
    client_id = raw_client_id.strip()
    if len(client_id) > 128:
        raise ValueError("analysis_client_id must not exceed 128 characters")
    if isinstance(raw_request_id, bool) or not isinstance(raw_request_id, int) or raw_request_id <= 0:
        raise ValueError("analysis_request_id must be a positive integer")
    return client_id, raw_request_id


def _prune_analysis_request_history(now: float) -> None:
    completed = {
        client_id: last_seen
        for client_id, (_, last_seen) in LATEST_ANALYSIS_REQUESTS.items()
        if client_id not in ACTIVE_ANALYSES
    }
    for client_id, last_seen in completed.items():
        if now - last_seen >= ANALYSIS_REQUEST_HISTORY_TTL_SECONDS:
            del LATEST_ANALYSIS_REQUESTS[client_id]

    overflow = len(LATEST_ANALYSIS_REQUESTS) - ANALYSIS_REQUEST_HISTORY_MAX_CLIENTS
    if overflow <= 0:
        return

    completed = {
        client_id: last_seen
        for client_id, (_, last_seen) in LATEST_ANALYSIS_REQUESTS.items()
        if client_id not in ACTIVE_ANALYSES
    }
    for client_id, _ in sorted(completed.items(), key=lambda item: item[1])[:overflow]:
        del LATEST_ANALYSIS_REQUESTS[client_id]


def _register_analysis(client_id: str | None, request_id: int | None) -> threading.Event:
    cancel_event = threading.Event()
    if client_id is None or request_id is None:
        return cancel_event

    with ACTIVE_ANALYSES_LOCK:
        now = time.monotonic()
        _prune_analysis_request_history(now)
        latest = LATEST_ANALYSIS_REQUESTS.get(client_id)
        if latest is not None and request_id <= latest[0]:
            cancel_event.set()
            return cancel_event

        previous = ACTIVE_ANALYSES.get(client_id)
        LATEST_ANALYSIS_REQUESTS[client_id] = (request_id, now)
        ACTIVE_ANALYSES[client_id] = (request_id, cancel_event)
        if previous is not None:
            previous[1].set()
    return cancel_event


def _unregister_analysis(client_id: str | None, request_id: int | None, cancel_event: threading.Event) -> None:
    if client_id is None or request_id is None:
        return

    with ACTIVE_ANALYSES_LOCK:
        if ACTIVE_ANALYSES.get(client_id) == (request_id, cancel_event):
            del ACTIVE_ANALYSES[client_id]
            latest = LATEST_ANALYSIS_REQUESTS.get(client_id)
            if latest is not None and latest[0] == request_id:
                LATEST_ANALYSIS_REQUESTS[client_id] = (request_id, time.monotonic())
            _prune_analysis_request_history(time.monotonic())


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


def _normalize_ty_binary_path(raw: Any) -> Path | None:
    if raw is None:
        return None
    if not isinstance(raw, str):
        return None

    text = raw.strip()
    if not text:
        return None

    path = Path(text).expanduser()
    try:
        resolved = path.resolve(strict=True)
    except (FileNotFoundError, OSError):
        return None

    if not resolved.is_file():
        return None
    return resolved


def _normalize_ty_pypi_version(raw: Any) -> str | None:
    if raw is None:
        return None
    if not isinstance(raw, str):
        return None
    text = raw.strip()
    if not text:
        return None
    return text


def _normalize_typeshed_path(raw: Any) -> Path | None:
    if raw is None:
        return None
    if not isinstance(raw, str):
        raise ValueError("typeshed_path must be a string")

    text = raw.strip()
    if not text:
        return None

    path = Path(text).expanduser()
    try:
        resolved = path.resolve(strict=True)
    except FileNotFoundError as exc:
        raise ValueError(f"Typeshed path does not exist: {text!r}") from exc
    except OSError as exc:
        raise ValueError(f"Could not resolve typeshed path {text!r}: {exc}") from exc

    if not resolved.is_dir():
        raise ValueError(f"Typeshed path is not a directory: {text!r}")
    return resolved


def _get_dir_fingerprint(path: Path) -> str:
    """Return a fingerprint that changes when the repo's source state changes.

    Uses ``git rev-parse HEAD`` (detects branch switches, pulls, rebases) and
    ``git status --porcelain`` (detects uncommitted edits) which are both fast
    regardless of repo size.
    """
    env = os.environ.copy()
    env["GIT_OPTIONAL_LOCKS"] = "0"
    try:
        head = subprocess.run(
            ["git", "-C", str(path), "rev-parse", "HEAD"],
            capture_output=True, text=True, timeout=5, env=env,
        ).stdout.strip()
        status = subprocess.run(
            ["git", "-C", str(path), "status", "--porcelain"],
            capture_output=True, text=True, timeout=10, env=env,
        ).stdout.strip()
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return ""
    return head + "\n" + status


def _normalize_python_version(raw: Any) -> str | None:
    if raw is None:
        return DEFAULT_PYTHON_VERSION
    if not isinstance(raw, str):
        raise ValueError("python_version must be a string")
    value = raw.strip()
    # "" means "not specified" — let tools use their own heuristics.
    if value == "":
        return None
    if value not in SUPPORTED_PYTHON_VERSIONS:
        allowed = ", ".join(SUPPORTED_PYTHON_VERSIONS)
        raise ValueError(f"Unsupported python_version {value!r}; expected one of: {allowed}")
    return value


def _normalize_python_tool_repo_paths(raw: Any) -> dict[str, Path]:
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise ValueError("python_tool_repo_paths must be an object mapping tool names to directories")

    allowed = set(PYTHON_IMPLEMENTED_TOOLS)
    normalized: dict[str, Path] = {}
    for raw_tool_name, raw_path in raw.items():
        if not isinstance(raw_tool_name, str):
            raise ValueError("python_tool_repo_paths keys must be tool names")
        tool_name = raw_tool_name.strip()
        if tool_name not in allowed:
            raise ValueError(f"Unsupported python_tool_repo_paths tool: {raw_tool_name!r}")
        if not isinstance(raw_path, str):
            raise ValueError(f"Path for {tool_name!r} must be a string")

        text = raw_path.strip()
        if not text:
            continue

        path = Path(text).expanduser()
        try:
            resolved = path.resolve(strict=True)
        except FileNotFoundError as exc:
            raise ValueError(f"{tool_name} repo path does not exist: {text!r}") from exc
        except OSError as exc:
            raise ValueError(f"Could not resolve {tool_name} repo path {text!r}: {exc}") from exc

        if not resolved.is_dir():
            raise ValueError(f"{tool_name} repo path is not a directory: {text!r}")
        normalized[tool_name] = resolved

    return normalized


def _python_tool_repo_paths_payload(paths: dict[str, Path]) -> dict[str, str]:
    payload: dict[str, str] = {}
    for tool_name in PYTHON_IMPLEMENTED_TOOLS:
        path = paths.get(tool_name)
        if path is not None:
            payload[tool_name] = str(path)
    return payload


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


def _venv_python_path(project_dir: Path) -> Path | None:
    candidates = [
        project_dir / ".venv" / "bin" / "python",
        project_dir / ".venv" / "Scripts" / "python.exe",
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return None


def _canonical_package_name(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def _normalize_dependency_cooldown_exempt_packages(raw: Any) -> list[str]:
    if raw is None:
        return list(DEFAULT_DEPENDENCY_COOLDOWN_EXEMPT_PACKAGES)
    if not isinstance(raw, list):
        raise ValueError("dependency_cooldown_exempt_packages must be a list of package names")

    seen: set[str] = set()
    normalized: list[str] = []
    for item in raw:
        if not isinstance(item, str):
            raise ValueError("dependency_cooldown_exempt_packages must contain only strings")
        name = item.strip()
        if not name:
            continue
        if not re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?", name):
            raise ValueError(f"Invalid dependency cooldown exempt package name: {name!r}")
        canonical = _canonical_package_name(name)
        if canonical in seen:
            continue
        seen.add(canonical)
        normalized.append(canonical)
    return normalized


def _uv_sync_command(dependency_cooldown_exempt_packages: list[str] | None = None) -> list[str]:
    command = ["uv", "sync", "--exclude-newer", DEPENDENCY_COOLDOWN]
    packages = dependency_cooldown_exempt_packages
    if packages is None:
        packages = DEFAULT_DEPENDENCY_COOLDOWN_EXEMPT_PACKAGES
    for package in packages:
        command.extend(["--exclude-newer-package", f"{package}={DEPENDENCY_COOLDOWN_EXEMPTION}"])
    return command


def _run_uv_sync(
    project_dir: Path,
    timeout_seconds: int = 300,
    dependency_cooldown_exempt_packages: list[str] | None = None,
    cancel_event: threading.Event | None = None,
) -> dict[str, Any]:
    env = _command_env()
    started = time.perf_counter()
    command = _uv_sync_command(dependency_cooldown_exempt_packages)
    try:
        completed = _run_process(
            command,
            cwd=project_dir,
            timeout=timeout_seconds,
            env=env,
            cancel_event=cancel_event,
        )
        if completed.cancelled:
            output = "Cancelled because a newer analysis was requested."
            returncode = -3
        elif completed.timed_out:
            output = f"Timed out after {timeout_seconds}s: {' '.join(command)}"
            returncode = -2
        else:
            output = completed.stdout + completed.stderr
            returncode = completed.returncode
    except FileNotFoundError as exc:
        output = f"Command not found: {exc}"
        returncode = -1

    duration_ms = int((time.perf_counter() - started) * 1000)
    return {
        "ran": True,
        "command": " ".join(command),
        "returncode": returncode,
        "duration_ms": duration_ms,
        "output": output,
    }


def _command_for_local_python_tool(spec: ToolSpec, repo_path: Path) -> list[str]:
    if not spec.command:
        return list(spec.command)
    requirement = f"{spec.name} @ {repo_path}"
    return ["uv", "run", "--frozen", "--with-editable", requirement, spec.command[0], *spec.command[1:]]


def _command_for_tool(
    spec: ToolSpec,
    python_tool_repo_paths: dict[str, Path] | None = None,
    file_paths: list[str] | None = None,
    python_version: str | None = DEFAULT_PYTHON_VERSION,
    ty_binary_path: Path | None = None,
    venv_python: Path | None = None,
    typeshed_path: Path | None = None,
    ty_pypi_version: str | None = None,
) -> list[str]:
    # Custom ty binary: use the binary directly instead of the PyPI version.
    if spec.name == "ty" and ty_binary_path is not None:
        command = [str(ty_binary_path), "check"]
        if python_version:
            command.extend(["--python-version", python_version])
        if typeshed_path is not None:
            command.extend(["--typeshed", str(typeshed_path)])
        if venv_python is not None:
            command.extend(["--python", str(venv_python)])
        py_files = [f for f in (file_paths or []) if f.endswith(".py")]
        return [*command, *(py_files or ["."])]

    repo_path = (python_tool_repo_paths or {}).get(spec.name)
    if repo_path is not None:
        command = _command_for_local_python_tool(spec, repo_path)
    else:
        # Run tools via `uv run --with=<tool>` so they use the project's venv.
        with_spec = f"{spec.name}=={ty_pypi_version}" if (spec.name == "ty" and ty_pypi_version) else spec.name
        command = ["uv", "run", "--frozen", f"--with={with_spec}", *spec.command]

    if python_version:
        if spec.name == "mypy":
            command.extend(["--python-version", python_version])
        elif spec.name == "pyright":
            command.extend(["--pythonversion", python_version])
        elif spec.name == "pyrefly":
            command.extend(["--python-version", python_version])
        elif spec.name == "ty":
            command.extend(["--python-version", python_version])
        elif spec.name == "zuban":
            command.extend(["--python-version", python_version])

    if typeshed_path is not None:
        if spec.name == "mypy":
            command.extend(["--custom-typeshed-dir", str(typeshed_path)])
        elif spec.name == "pyright":
            command.extend(["--typeshedpath", str(typeshed_path)])
        elif spec.name == "pyrefly":
            command.extend(["--typeshed-path", str(typeshed_path)])
        elif spec.name == "ty":
            command.extend(["--typeshed", str(typeshed_path)])
        # zuban/pycroscope currently have no CLI flag for overriding typeshed.

    if spec.name == "pycroscope":
        command.extend(["--config-file", "pyproject.toml"])

    # zuban needs --python-executable to find packages installed in the project venv.
    if spec.name == "zuban" and venv_python is not None and repo_path is None:
        command.extend(["--python-executable", str(venv_python)])

    # Pass explicit files so that zuban/pycroscope don't type-check the venv.
    # The other type checkers handle "." fine, but explicit files work for all.
    py_files = [f for f in (file_paths or []) if f.endswith(".py")]
    return [*command, *(py_files or ["."])]


def _run_command(
    name: str,
    command: list[str],
    cwd: Path,
    timeout_seconds: int | None = 120,
    env_overrides: dict[str, str] | None = None,
    cancel_event: threading.Event | None = None,
) -> dict[str, Any]:
    started = time.perf_counter()
    env = _command_env()
    if env_overrides:
        env.update(env_overrides)
    try:
        completed = _run_process(
            command,
            cwd=cwd,
            timeout=timeout_seconds,
            env=env,
            cancel_event=cancel_event,
        )
        if completed.cancelled:
            output = "Cancelled because a newer analysis was requested."
            returncode = -3
        elif completed.timed_out:
            output = f"Timed out after {timeout_seconds}s: {' '.join(command)}"
            returncode = -2
        else:
            stdout = completed.stdout
            stderr = completed.stderr
            output = _format_pyright_output(stdout, stderr, cwd) if name == "pyright" else (stdout + stderr)
            returncode = completed.returncode
    except FileNotFoundError as exc:
        output = f"Command not found: {exc}"
        returncode = -1

    duration_ms = int((time.perf_counter() - started) * 1000)
    return {
        "tool": name,
        "command": " ".join(command),
        "returncode": returncode,
        "duration_ms": duration_ms,
        "output": output,
    }


def _terminate_process_tree(process: subprocess.Popen[str]) -> None:
    if os.name == "nt" and process.poll() is not None:
        return

    if os.name == "nt":
        try:
            subprocess.run(
                ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                capture_output=True,
                timeout=2,
                check=False,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired):
            try:
                process.terminate()
            except OSError:
                return
    else:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            return
        except OSError:
            try:
                process.terminate()
            except OSError:
                return

    try:
        process.wait(timeout=0.5)
    except subprocess.TimeoutExpired:
        if os.name == "nt":
            try:
                process.kill()
            except OSError:
                pass

    if os.name != "nt":
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        except OSError:
            try:
                process.kill()
            except OSError:
                pass


def _run_process(
    command: list[str],
    *,
    cwd: Path,
    timeout: int | None,
    env: dict[str, str],
    cancel_event: threading.Event | None = None,
) -> ProcessResult:
    if cancel_event is not None and cancel_event.is_set():
        return ProcessResult("", "", -3, cancelled=True)

    creationflags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0) if os.name == "nt" else 0
    process = subprocess.Popen(
        command,
        cwd=cwd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=env,
        start_new_session=os.name != "nt",
        creationflags=creationflags,
    )
    deadline = None if timeout is None else time.monotonic() + timeout

    while True:
        if cancel_event is not None and cancel_event.is_set():
            _terminate_process_tree(process)
            stdout, stderr = process.communicate()
            return ProcessResult(stdout or "", stderr or "", -3, cancelled=True)

        wait_seconds = 0.1
        if deadline is not None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                _terminate_process_tree(process)
                stdout, stderr = process.communicate()
                return ProcessResult(stdout or "", stderr or "", -2, timed_out=True)
            wait_seconds = min(wait_seconds, remaining)

        try:
            stdout, stderr = process.communicate(timeout=wait_seconds)
        except subprocess.TimeoutExpired:
            continue
        return ProcessResult(stdout or "", stderr or "", process.returncode)


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
        version_command = ["uv", "run", f"--with={spec.name}", *spec.version_command]
        started = time.perf_counter()
        try:
            completed = subprocess.run(
                version_command,
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
            combined = f"Timed out after {timeout_seconds}s: {' '.join(version_command)}"
            returncode = -2
            version = "unknown"

        duration_ms = int((time.perf_counter() - started) * 1000)
        version_results[spec.name] = {
            "tool": spec.name,
            "command": " ".join(version_command),
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


def _ruff_ty_command(
    ruff_repo_path: Path,
    venv_python: Path | None,
    python_version: str | None = DEFAULT_PYTHON_VERSION,
    typeshed_path: Path | None = None,
) -> list[str]:
    manifest = ruff_repo_path / "Cargo.toml"
    command = ["cargo", "run", "--quiet", "--manifest-path", str(manifest), "--bin", "ty", "--", "check"]
    if python_version:
        command.extend(["--python-version", python_version])
    if typeshed_path is not None:
        command.extend(["--typeshed", str(typeshed_path)])
    if venv_python is not None:
        command.extend(["--python", str(venv_python)])
    return command


def _run_ruff_ty_from_repo(
    ruff_repo_path: Path,
    project_dir: Path,
    venv_python: Path | None,
    python_version: str | None,
    typeshed_path: Path | None,
    timeout_seconds: int | None,
    cancel_event: threading.Event | None = None,
) -> dict[str, Any]:
    return _run_command(
        RUFF_TY_TOOL_NAME,
        _ruff_ty_command(ruff_repo_path, venv_python, python_version, typeshed_path),
        project_dir,
        timeout_seconds,
        _venv_env_overrides(venv_python),
        cancel_event,
    )


def _iter_all_tools(
    project_dir: Path,
    python_tool_repo_paths: dict[str, Path] | None = None,
    enabled_tools: list[str] | None = None,
    timeout_seconds: int = 120,
    file_paths: list[str] | None = None,
    ruff_repo_path: Path | None = None,
    python_version: str | None = DEFAULT_PYTHON_VERSION,
    ty_binary_path: Path | None = None,
    typeshed_path: Path | None = None,
    ty_pypi_version: str | None = None,
    cancel_event: threading.Event | None = None,
) -> Iterator[tuple[str, dict[str, Any]]]:
    """Yield (tool_name, result) pairs as each tool finishes."""
    if cancel_event is not None and cancel_event.is_set():
        return

    selected_specs = TOOL_SPECS if enabled_tools is None else [TOOL_SPEC_BY_NAME[name] for name in enabled_tools if name in TOOL_SPEC_BY_NAME]
    unsupported_typeshed_tools = {"zuban", "pycroscope"} if typeshed_path is not None else set()

    # venv_python is needed for: custom ty binary (--python flag) and zuban (--python-executable).
    venv_python = _venv_python_path(project_dir)

    skipped_results: dict[str, dict[str, Any]] = {}
    runnable_specs: list[ToolSpec] = []
    for spec in selected_specs:
        if spec.name in unsupported_typeshed_tools:
            skipped_results[spec.name] = {
                "tool": spec.name,
                "command": "",
                "returncode": 0,
                "duration_ms": 0,
                "output": "(custom typeshed not supported)",
            }
        else:
            runnable_specs.append(spec)

    command_by_tool: dict[str, list[str]] = {
        spec.name: _command_for_tool(spec, python_tool_repo_paths, file_paths, python_version, ty_binary_path, venv_python, typeshed_path, ty_pypi_version)
        for spec in runnable_specs
    }

    # Include ruff_ty in the same executor so it runs in parallel.
    # The caller only passes ruff_repo_path when ty_ruff is enabled.
    include_ruff_ty = ruff_repo_path is not None

    total_workers = len(command_by_tool) + (1 if include_ruff_ty else 0)
    if total_workers == 0:
        for tool_name, result in skipped_results.items():
            yield tool_name, result
        return

    for tool_name, result in skipped_results.items():
        if cancel_event is not None and cancel_event.is_set():
            return
        yield tool_name, result

    # For ruff_ty (cargo-built ty), we need venv_python for package resolution.
    ruff_ty_venv_python = _venv_python_path(project_dir) if include_ruff_ty else None

    with ThreadPoolExecutor(max_workers=max(1, total_workers)) as executor:
        futures = {
            executor.submit(
                _run_command,
                tool_name,
                command,
                project_dir,
                LOCAL_CHECKOUT_TOOL_TIMEOUT_SECONDS if (tool_name == "ty" and ty_binary_path is not None) else timeout_seconds,
                None,
                cancel_event,
            ): tool_name
            for tool_name, command in command_by_tool.items()
        }
        if include_ruff_ty:
            assert ruff_repo_path is not None
            futures[executor.submit(
                _run_ruff_ty_from_repo,
                ruff_repo_path,
                project_dir,
                ruff_ty_venv_python,
                python_version,
                typeshed_path,
                LOCAL_CHECKOUT_TOOL_TIMEOUT_SECONDS,
                cancel_event,
            )] = RUFF_TY_TOOL_NAME

        for future in as_completed(futures):
            if cancel_event is not None and cancel_event.is_set():
                for pending in futures:
                    pending.cancel()
                return
            tool_name = futures[future]
            try:
                yield tool_name, future.result()
            except Exception as exc:
                yield tool_name, {
                    "tool": tool_name,
                    "command": "",
                    "returncode": -3,
                    "duration_ms": 0,
                    "output": f"Internal error: {exc}",
                }


def _prime_tool_installs() -> dict[str, dict[str, Any]]:
    """Write a default pyproject.toml and run uv sync, then detect versions."""
    pyproject_path = STAGING_DIR / "pyproject.toml"
    if not pyproject_path.exists():
        pyproject_path.write_text(DEFAULT_PYPROJECT_TOML, encoding="utf-8")
    _run_uv_sync(STAGING_DIR)
    return _detect_tool_versions(STAGING_DIR)


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


def _fetch_gist(gist_id: str) -> dict[str, Any]:
    url = f"https://api.github.com/gists/{gist_id}"
    req = urllib.request.Request(url, headers={"Accept": "application/vnd.github+json"})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"Failed to fetch gist {gist_id}: HTTP {exc.code}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Failed to fetch gist {gist_id}: {exc.reason}") from exc

    raw_files = data.get("files", {})

    # Check for metadata with original filename mapping.
    meta_info = raw_files.get("_multiplay_metadata.json")
    if meta_info:
        try:
            meta = json.loads(meta_info.get("content", "{}"))
            file_mapping = meta.get("file_mapping", {})
            if file_mapping:
                files: list[dict[str, str]] = []
                for gist_name, info in raw_files.items():
                    if gist_name == "_multiplay_metadata.json":
                        continue
                    original_name = file_mapping.get(gist_name, gist_name)
                    files.append({"name": original_name, "content": info.get("content", "")})
                return {"files": files}
        except (json.JSONDecodeError, KeyError):
            pass  # Fall through to legacy handling.

    # Legacy: no metadata file.
    files = []
    for filename, info in raw_files.items():
        content = info.get("content", "")
        if filename == "_multiplay_metadata.json":
            continue
        files.append({"name": filename, "content": content})

    return {"files": files}


def _github_token() -> str:
    token = os.environ.get("MULTIPLAY_GH_TOKEN", "").strip()
    if token:
        return token

    try:
        completed = subprocess.run(
            ["gh", "auth", "token"],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return ""

    if completed.returncode != 0:
        return ""
    return (completed.stdout or "").strip()


def _create_gist(files: list[dict[str, Any]]) -> dict[str, str]:
    gist_files: dict[str, dict[str, str]] = {}
    file_mapping: dict[str, str] = {}  # safe gist name -> original name
    used_names: set[str] = set()

    for entry in files:
        name = str(entry.get("name", ""))
        content = entry.get("content", "")
        rel = _safe_relative_path(name)
        original = str(rel)

        # Create a flat filename safe for gists (no directory separators).
        safe = original.replace("/", "-")
        if safe in used_names:
            stem, ext = os.path.splitext(safe)
            counter = 1
            while f"{stem}_{counter}{ext}" in used_names:
                counter += 1
            safe = f"{stem}_{counter}{ext}"

        used_names.add(safe)
        file_mapping[safe] = original
        gist_files[safe] = {"content": content}

    # Include metadata so the original nested filenames can be recovered.
    gist_files["_multiplay_metadata.json"] = {
        "content": json.dumps({"version": 1, "file_mapping": file_mapping})
    }

    token = _github_token()
    if not token:
        raise RuntimeError(
            "Missing GitHub token. Set MULTIPLAY_GH_TOKEN or authenticate gh CLI (`gh auth login`)."
        )

    payload = json.dumps({"public": True, "files": gist_files}).encode("utf-8")
    req = urllib.request.Request(
        "https://api.github.com/gists",
        data=payload,
        method="POST",
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        message = f"HTTP {exc.code}"
        try:
            err_data = json.loads(exc.read().decode("utf-8"))
            err_msg = str(err_data.get("message", "")).strip()
            if err_msg:
                message = f"{message}: {err_msg}"
        except Exception:
            pass
        raise RuntimeError(f"GitHub gist create failed: {message}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"GitHub gist create failed: {exc.reason}") from exc

    gist_url = data.get("html_url", "")
    gist_id = data.get("id", "")
    if not gist_id:
        raise RuntimeError("GitHub gist create returned no gist id")
    return {"gist_url": gist_url, "gist_id": gist_id}


class AppHandler(BaseHTTPRequestHandler):
    server_version = "MultifileEditor/2.0"
    protocol_version = "HTTP/1.1"

    def handle_one_request(self) -> None:
        try:
            super().handle_one_request()
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True

    def log_message(self, format: str, *args: Any) -> None:
        print(f"[{self.log_date_time_string()}] {self.address_string()} - {format % args}")

    def do_GET(self) -> None:  # noqa: N802
        path = urlsplit(self.path).path

        if path == "/api/health":
            _json_response(self, HTTPStatus.OK, {"ok": True, "server_id": SERVER_ID, "staging_dir": str(STAGING_DIR)})
            return

        if path == "/api/bootstrap":
            _json_response(
                self,
                HTTPStatus.OK,
                {
                    "initial_files": DEFAULT_FILES,
                    "initial_python_version": DEFAULT_PYTHON_VERSION,
                    "python_versions": [*SUPPORTED_PYTHON_VERSIONS, ""],
                    "tool_order": list(TOOL_ORDER),
                    "enabled_tools": list(TOOL_ORDER),
                    "initial_ruff_repo_path": "",
                    "initial_ty_binary_path": "",
                    "initial_typeshed_path": "",
                    "initial_python_tool_repo_paths": {},
                    "initial_dependency_cooldown_exempt_packages": list(DEFAULT_DEPENDENCY_COOLDOWN_EXEMPT_PACKAGES),
                    "tool_versions": dict(TOOL_VERSIONS),
                    "staging_dir": str(STAGING_DIR),
                },
            )
            return

        if path == "/api/dir-fingerprint":
            qs = parse_qs(urlsplit(self.path).query)
            raw_path = (qs.get("path") or [None])[0]
            try:
                resolved = _normalize_ruff_repo_path(raw_path)
            except ValueError as exc:
                _json_response(self, HTTPStatus.BAD_REQUEST, {"error": str(exc)})
                return
            if resolved is None:
                _json_response(self, HTTPStatus.BAD_REQUEST, {"error": "Missing path parameter"})
                return
            fingerprint = _get_dir_fingerprint(resolved)
            _json_response(self, HTTPStatus.OK, {"fingerprint": fingerprint})
            return

        if path.startswith("/api/gist/"):
            gist_id = path[len("/api/gist/"):]
            if not gist_id:
                _json_response(self, HTTPStatus.BAD_REQUEST, {"error": "Missing gist ID"})
                return
            try:
                result = _fetch_gist(gist_id)
                _json_response(self, HTTPStatus.OK, result)
            except RuntimeError as exc:
                _json_response(self, HTTPStatus.BAD_REQUEST, {"error": str(exc)})
            return

        static_file = _resolve_static_file(path)
        if static_file is not None:
            data = static_file.read_bytes()
            _bytes_response(self, HTTPStatus.OK, _content_type_for(static_file), data)
            return

        _json_response(self, HTTPStatus.NOT_FOUND, {"error": "Not found"})

    def do_POST(self) -> None:  # noqa: N802
        path = urlsplit(self.path).path

        if path == "/api/share":
            self._handle_share()
            return

        if path == "/api/format":
            self._handle_format()
            return

        if path != "/api/analyze":
            _json_response(self, HTTPStatus.NOT_FOUND, {"error": "Not found"})
            return

        try:
            body = self._read_json_body()
            files = body.get("files")
            if not isinstance(files, list) or not files:
                raise ValueError("Expected non-empty 'files' list")
            python_version = _normalize_python_version(body.get("python_version"))
            ruff_repo_path = _normalize_ruff_repo_path(body.get("ruff_repo_path"))
            ty_binary_path = _normalize_ty_binary_path(body.get("ty_binary_path"))
            ty_pypi_version = _normalize_ty_pypi_version(body.get("ty_pypi_version"))
            typeshed_path = _normalize_typeshed_path(body.get("typeshed_path"))
            python_tool_repo_paths = _normalize_python_tool_repo_paths(body.get("python_tool_repo_paths"))
            dependency_cooldown_exempt_packages = _normalize_dependency_cooldown_exempt_packages(
                body.get("dependency_cooldown_exempt_packages")
            )
            tool_order = _tool_order_for_request(ruff_repo_path)
            enabled_tools = _normalize_enabled_tools_for_order(body.get("enabled_tools"), tool_order)
            analysis_client_id, analysis_request_id = _normalize_analysis_identity(
                body.get("analysis_client_id"), body.get("analysis_request_id")
            )
            cancel_event = _register_analysis(analysis_client_id, analysis_request_id)
            try:
                if cancel_event.is_set():
                    self.close_connection = True
                    return

                with tempfile.TemporaryDirectory(prefix="multiplay-analysis-") as tmp:
                    analysis_dir = Path(tmp)
                    with STATE_LOCK:
                        _write_files_to_project(STAGING_DIR, files)
                        _snapshot_project_dir(STAGING_DIR, analysis_dir)

                    if cancel_event.is_set():
                        self.close_connection = True
                        return

                    sync_result = _run_uv_sync(
                        analysis_dir,
                        dependency_cooldown_exempt_packages=dependency_cooldown_exempt_packages,
                        cancel_event=cancel_event,
                    )
                    if cancel_event.is_set():
                        self.close_connection = True
                        return
                    if sync_result["returncode"] != 0:
                        _json_response(
                            self,
                            HTTPStatus.BAD_REQUEST,
                            {
                                "error": "uv sync failed",
                                "error_type": "dependency_install_failed",
                                "dependency_install": sync_result,
                                "python_version": python_version or "",
                                "enabled_tools": enabled_tools,
                                "tool_order": tool_order,
                                "ruff_repo_path": str(ruff_repo_path) if ruff_repo_path is not None else "",
                                "ty_binary_path": str(ty_binary_path) if ty_binary_path is not None else "",
                                "ty_pypi_version": ty_pypi_version or "",
                                "typeshed_path": str(typeshed_path) if typeshed_path is not None else "",
                                "python_tool_repo_paths": _python_tool_repo_paths_payload(python_tool_repo_paths),
                                "dependency_cooldown_exempt_packages": dependency_cooldown_exempt_packages,
                                "tool_versions": dict(TOOL_VERSIONS),
                                "staging_dir": str(STAGING_DIR),
                            },
                        )
                        return

                    base_enabled_tools = [tool_name for tool_name in enabled_tools if tool_name in TOOL_SPEC_BY_NAME]
                    file_paths = [str(entry.get("name", "")) for entry in files]

                    # Stream NDJSON: metadata, then each tool result, then done.
                    _ndjson_start(self)
                    _ndjson_send(self, {
                        "type": "metadata",
                        "tool_versions": dict(TOOL_VERSIONS),
                        "python_version": python_version or "",
                        "python_versions": [*SUPPORTED_PYTHON_VERSIONS, ""],
                        "enabled_tools": enabled_tools,
                        "tool_order": tool_order,
                        "ruff_repo_path": str(ruff_repo_path) if ruff_repo_path is not None else "",
                        "ty_binary_path": str(ty_binary_path) if ty_binary_path is not None else "",
                        "ty_pypi_version": ty_pypi_version or "",
                        "typeshed_path": str(typeshed_path) if typeshed_path is not None else "",
                        "python_tool_repo_paths": _python_tool_repo_paths_payload(python_tool_repo_paths),
                        "dependency_cooldown_exempt_packages": dependency_cooldown_exempt_packages,
                        "staging_dir": str(STAGING_DIR),
                    })

                    for tool_name, result in _iter_all_tools(
                        analysis_dir,
                        python_tool_repo_paths,
                        base_enabled_tools,
                        timeout_seconds=ANALYZE_TOOL_TIMEOUT_SECONDS,
                        file_paths=file_paths,
                        ruff_repo_path=ruff_repo_path if RUFF_TY_TOOL_NAME in enabled_tools else None,
                        python_version=python_version,
                        ty_binary_path=ty_binary_path,
                        typeshed_path=typeshed_path,
                        ty_pypi_version=ty_pypi_version,
                        cancel_event=cancel_event,
                    ):
                        if cancel_event.is_set():
                            self.close_connection = True
                            return
                        _ndjson_send(self, {"type": "result", "tool": tool_name, "data": result})
                    if cancel_event.is_set():
                        self.close_connection = True
                        return
                    _ndjson_send(self, {"type": "done"})
            except (BrokenPipeError, ConnectionResetError):
                cancel_event.set()
                self.close_connection = True
            finally:
                _unregister_analysis(analysis_client_id, analysis_request_id, cancel_event)
        except ValueError as exc:
            _json_response(self, HTTPStatus.BAD_REQUEST, {"error": str(exc)})
        except json.JSONDecodeError:
            _json_response(self, HTTPStatus.BAD_REQUEST, {"error": "Invalid JSON payload"})
        except Exception as exc:  # pragma: no cover
            _json_response(self, HTTPStatus.INTERNAL_SERVER_ERROR, {"error": f"Unexpected error: {exc}"})

    def _handle_share(self) -> None:
        try:
            body = self._read_json_body()
            files = body.get("files")
            if not isinstance(files, list) or not files:
                raise ValueError("Expected non-empty 'files' list")
            result = _create_gist(files)
            _json_response(self, HTTPStatus.OK, result)
        except ValueError as exc:
            _json_response(self, HTTPStatus.BAD_REQUEST, {"error": str(exc)})
        except json.JSONDecodeError:
            _json_response(self, HTTPStatus.BAD_REQUEST, {"error": "Invalid JSON payload"})
        except RuntimeError as exc:
            _json_response(self, HTTPStatus.INTERNAL_SERVER_ERROR, {"error": str(exc)})
        except Exception as exc:  # pragma: no cover
            _json_response(self, HTTPStatus.INTERNAL_SERVER_ERROR, {"error": f"Unexpected error: {exc}"})

    def _handle_format(self) -> None:
        try:
            body = self._read_json_body()
            files = body.get("files")
            if not isinstance(files, list) or not files:
                raise ValueError("Expected non-empty 'files' list")

            with tempfile.TemporaryDirectory(prefix="ruff-format-") as tmp:
                tmp_path = Path(tmp)
                py_names: list[str] = []
                for entry in files:
                    name = str(entry.get("name", ""))
                    content = entry.get("content", "")
                    if not name or not isinstance(content, str):
                        continue
                    rel = _safe_relative_path(name)
                    file_path = tmp_path / rel
                    file_path.parent.mkdir(parents=True, exist_ok=True)
                    file_path.write_text(content, encoding="utf-8")
                    if name.endswith((".py", ".pyi")):
                        py_names.append(name)

                if not py_names:
                    _json_response(self, HTTPStatus.OK, {"files": {}, "duration_ms": 0})
                    return

                env = _command_env()
                started = time.perf_counter()
                try:
                    completed = subprocess.run(
                        ["uvx", "ruff", "format", tmp],
                        cwd=tmp_path,
                        capture_output=True,
                        text=True,
                        timeout=10,
                        env=env,
                        check=False,
                    )
                except FileNotFoundError as exc:
                    _json_response(self, HTTPStatus.INTERNAL_SERVER_ERROR, {"error": f"Command not found: {exc}"})
                    return
                except subprocess.TimeoutExpired:
                    _json_response(self, HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "ruff format timed out"})
                    return

                duration_ms = int((time.perf_counter() - started) * 1000)

                if completed.returncode != 0:
                    stderr = completed.stderr or ""
                    _json_response(self, HTTPStatus.BAD_REQUEST, {
                        "error": "ruff format failed",
                        "output": stderr,
                        "returncode": completed.returncode,
                        "duration_ms": duration_ms,
                    })
                    return

                formatted_files: dict[str, str] = {}
                for name in py_names:
                    rel = _safe_relative_path(name)
                    formatted_files[name] = (tmp_path / rel).read_text(encoding="utf-8")
                _json_response(self, HTTPStatus.OK, {
                    "files": formatted_files,
                    "duration_ms": duration_ms,
                })
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
        help="Skip startup tool install priming (default: prime enabled)",
    )
    parser.add_argument(
        "--open",
        action="store_true",
        help="Open the app in the default browser after starting",
    )
    return parser.parse_args()


def main() -> None:
    if not STATIC_DIR.is_dir():
        raise SystemExit(f"Static directory not found: {STATIC_DIR}")

    args = parse_args()

    if not args.skip_prime:
        print("Priming tool installs...")
        version_results = _prime_tool_installs()
        for spec in TOOL_SPECS:
            version_info = version_results.get(spec.name, {})
            raw_version = version_info.get("version")
            TOOL_VERSIONS[spec.name] = raw_version if isinstance(raw_version, str) and raw_version else "unknown"
            print(f"  {spec.name} v{TOOL_VERSIONS[spec.name]}")
    else:
        print("Skipping tool priming (--skip-prime)")

    port = args.port
    while True:
        try:
            server = ThreadingHTTPServer((args.host, port), AppHandler)
            break
        except OSError:
            port += 1
    print(f"Static directory: {STATIC_DIR}")
    print(f"Staging directory: {STAGING_DIR}")
    url = f"http://{args.host}:{port}"
    print(f"\nServing app on \033[1;4;32m{url}\033[0m")

    if args.open:
        webbrowser.open(url)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down...")
    finally:
        # On Windows, temp directories aren't automatically cleaned up.
        if os.name == "nt":
            shutil.rmtree(STAGING_DIR, ignore_errors=True)


if __name__ == "__main__":
    main()
