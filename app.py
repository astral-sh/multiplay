#!/usr/bin/env python3
"""Local web app server for editing multiple files and running type checkers."""

from __future__ import annotations

import argparse
from collections.abc import Iterator
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
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit


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
    {"name": "pyproject.toml", "content": ""},
]
DEFAULT_DEPENDENCIES: list[str] = []
SUPPORTED_PYTHON_VERSIONS = ["3.10", "3.11", "3.12", "3.13", "3.14"]
DEFAULT_PYTHON_VERSION = "3.14"


@dataclass(frozen=True)
class ToolSpec:
    name: str
    command: list[str]
    version_command: list[str]


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
TOOL_VERSIONS: dict[str, str] = {spec.name: "unknown" for spec in TOOL_SPECS}
ANALYZE_TOOL_TIMEOUT_SECONDS = 10
LOCAL_CHECKOUT_TOOL_TIMEOUT_SECONDS: int | None = None
SESSION_MAX_IDLE_SECONDS = 30 * 60  # 30 minutes
SESSION_REAPER_INTERVAL_SECONDS = 60
SESSION_HEADER_NAME = "X-Session-Id"


@dataclass
class Session:
    id: str
    project_dir: Path
    lock: threading.Lock
    last_active: float  # time.monotonic()


class SessionManager:
    def __init__(self, fixed_project_dir: Path | None = None) -> None:
        self._sessions: dict[str, Session] = {}
        self._manager_lock = threading.Lock()
        self._fixed_project_dir = fixed_project_dir

    def get_or_create(self, session_id: str | None) -> tuple[Session, bool]:
        """Return (session, created). If session_id is None or unknown, create a new one."""
        with self._manager_lock:
            if session_id and session_id in self._sessions:
                session = self._sessions[session_id]
                session.last_active = time.monotonic()
                return session, False

            sid = session_id if session_id else uuid.uuid4().hex
            if self._fixed_project_dir is not None:
                project_dir = self._fixed_project_dir
                project_dir.mkdir(parents=True, exist_ok=True)
            else:
                project_dir = Path(tempfile.mkdtemp(prefix=f"multiplay-{sid[:8]}-"))
            session = Session(
                id=sid,
                project_dir=project_dir,
                lock=threading.Lock(),
                last_active=time.monotonic(),
            )
            self._sessions[sid] = session
            print(f"[session] Created {sid[:8]}… → {project_dir}")
            return session, True

    def reap_stale(self, max_idle_seconds: float) -> int:
        """Remove sessions idle longer than max_idle_seconds. Returns count removed."""
        now = time.monotonic()
        to_remove: list[Session] = []
        with self._manager_lock:
            for sid, session in list(self._sessions.items()):
                if now - session.last_active > max_idle_seconds:
                    to_remove.append(session)
                    del self._sessions[sid]

        for session in to_remove:
            print(f"[session] Reaping {session.id[:8]}… (idle {int(now - session.last_active)}s)")
            if self._fixed_project_dir is None:
                shutil.rmtree(session.project_dir, ignore_errors=True)

        return len(to_remove)

    def destroy_all(self) -> None:
        """Clean up all sessions (for shutdown)."""
        with self._manager_lock:
            if self._fixed_project_dir is None:
                for session in self._sessions.values():
                    shutil.rmtree(session.project_dir, ignore_errors=True)
            self._sessions.clear()

    @property
    def count(self) -> int:
        with self._manager_lock:
            return len(self._sessions)


HOSTED_MODE = os.environ.get("MULTIPLAY_HOSTED", "").strip() == "1"
_PROJECT_DIR_ENV = os.environ.get("MULTIPLAY_PROJECT_DIR", "").strip() or None
SESSION_MANAGER: SessionManager  # initialized in main()


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


def _normalize_python_version(raw: Any) -> str:
    if raw is None:
        return DEFAULT_PYTHON_VERSION
    if not isinstance(raw, str):
        raise ValueError("python_version must be a string")
    value = raw.strip()
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


def _run_uv_pip_install(project_dir: Path, dependencies: list[str], timeout_seconds: int = 300) -> dict[str, Any]:
    if not dependencies:
        return {
            "ran": False,
            "command": "",
            "returncode": 0,
            "duration_ms": 0,
            "output": "",
            "dependencies": [],
        }

    env = _command_env()
    started = time.perf_counter()
    output_parts: list[str] = []

    # Create a venv if one doesn't already exist.
    venv_dir = project_dir / ".venv"
    if not venv_dir.exists():
        venv_command = ["uv", "venv", str(venv_dir)]
        try:
            completed = subprocess.run(
                venv_command,
                cwd=project_dir,
                capture_output=True,
                text=True,
                timeout=timeout_seconds,
                env=env,
                check=False,
            )
            output_parts.append((completed.stdout or "") + (completed.stderr or ""))
            if completed.returncode != 0:
                duration_ms = int((time.perf_counter() - started) * 1000)
                return {
                    "ran": True,
                    "command": " ".join(venv_command),
                    "returncode": completed.returncode,
                    "duration_ms": duration_ms,
                    "output": "".join(output_parts),
                    "dependencies": dependencies,
                }
        except FileNotFoundError as exc:
            return {
                "ran": True,
                "command": " ".join(venv_command),
                "returncode": -1,
                "duration_ms": int((time.perf_counter() - started) * 1000),
                "output": f"Command not found: {exc}",
                "dependencies": dependencies,
            }
        except subprocess.TimeoutExpired:
            return {
                "ran": True,
                "command": " ".join(venv_command),
                "returncode": -2,
                "duration_ms": int((time.perf_counter() - started) * 1000),
                "output": f"Timed out after {timeout_seconds}s: {' '.join(venv_command)}",
                "dependencies": dependencies,
            }

    # Install dependencies into the venv.
    venv_python = _venv_python_path(project_dir)
    if venv_python is None:
        return {
            "ran": True,
            "command": "uv pip install",
            "returncode": -1,
            "duration_ms": int((time.perf_counter() - started) * 1000),
            "output": f"Could not find Python in venv at {venv_dir}",
            "dependencies": dependencies,
        }
    install_command = ["uv", "pip", "install", "--python", str(venv_python), *dependencies]
    try:
        completed = subprocess.run(
            install_command,
            cwd=project_dir,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            env=env,
            check=False,
        )
        output_parts.append((completed.stdout or "") + (completed.stderr or ""))
        returncode = completed.returncode
    except FileNotFoundError as exc:
        output_parts.append(f"Command not found: {exc}")
        returncode = -1
    except subprocess.TimeoutExpired:
        output_parts.append(f"Timed out after {timeout_seconds}s: {' '.join(install_command)}")
        returncode = -2

    duration_ms = int((time.perf_counter() - started) * 1000)
    return {
        "ran": True,
        "command": " ".join(install_command),
        "returncode": returncode,
        "duration_ms": duration_ms,
        "output": "".join(output_parts),
        "dependencies": dependencies,
    }


def _command_for_local_python_tool(spec: ToolSpec, repo_path: Path) -> list[str]:
    if not spec.command:
        return list(spec.command)
    requirement = f"{spec.name} @ {repo_path}"
    return ["uv", "run", "--with-editable", requirement, spec.command[0], *spec.command[1:]]


def _command_for_tool(
    spec: ToolSpec,
    venv_python: Path | None,
    python_tool_repo_paths: dict[str, Path] | None = None,
    file_paths: list[str] | None = None,
    python_version: str = DEFAULT_PYTHON_VERSION,
) -> list[str]:
    repo_path = (python_tool_repo_paths or {}).get(spec.name)
    command = (
        _command_for_local_python_tool(spec, repo_path)
        if repo_path is not None
        else list(spec.command)
    )

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

    # Tools are installed into the venv. Run them with the venv's Python via
    # "python -m <tool>" so they can resolve imports from installed packages.
    if venv_python is not None and repo_path is None and command:
        if spec.name == "zuban":
            # zuban doesn't support "python -m zuban"; run the bin entry point
            # with --python-executable so it knows where to find dependencies.
            command = [*command, "--python-executable", str(venv_python)]
        else:
            command = [str(venv_python), "-m", command[0], *command[1:]]

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
) -> dict[str, Any]:
    started = time.perf_counter()
    env = _command_env()
    if env_overrides:
        env.update(env_overrides)
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


def _detect_tool_versions(cwd: Path, venv_python: Path | None = None, timeout_seconds: int = 60) -> dict[str, dict[str, Any]]:
    version_results: dict[str, dict[str, Any]] = {}
    env = _command_env()
    overrides = _venv_env_overrides(venv_python)
    if overrides:
        env.update(overrides)

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


def _ruff_ty_command(
    ruff_repo_path: Path,
    venv_python: Path | None,
    python_version: str = DEFAULT_PYTHON_VERSION,
) -> list[str]:
    manifest = ruff_repo_path / "Cargo.toml"
    command = ["cargo", "run", "--quiet", "--manifest-path", str(manifest), "--bin", "ty", "--", "check"]
    command.extend(["--python-version", python_version])
    if venv_python is not None:
        command.extend(["--python", str(venv_python)])
    return command


def _run_ruff_ty_from_repo(
    ruff_repo_path: Path,
    project_dir: Path,
    venv_python: Path | None,
    python_version: str,
    timeout_seconds: int | None,
) -> dict[str, Any]:
    return _run_command(
        RUFF_TY_TOOL_NAME,
        _ruff_ty_command(ruff_repo_path, venv_python, python_version),
        project_dir,
        timeout_seconds,
        _venv_env_overrides(venv_python),
    )


def _run_all_tools(
    project_dir: Path,
    venv_python: Path | None = None,
    python_tool_repo_paths: dict[str, Path] | None = None,
    enabled_tools: list[str] | None = None,
    timeout_seconds: int = 120,
    file_paths: list[str] | None = None,
    python_version: str = DEFAULT_PYTHON_VERSION,
) -> dict[str, dict[str, Any]]:
    results: dict[str, dict[str, Any]] = {}
    env_overrides = _venv_env_overrides(venv_python)

    selected_specs = TOOL_SPECS if enabled_tools is None else [TOOL_SPEC_BY_NAME[name] for name in enabled_tools]
    if not selected_specs:
        return results

    command_by_tool = {
        spec.name: _command_for_tool(spec, venv_python, python_tool_repo_paths, file_paths, python_version)
        for spec in selected_specs
    }
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


def _iter_all_tools(
    project_dir: Path,
    venv_python: Path | None = None,
    python_tool_repo_paths: dict[str, Path] | None = None,
    enabled_tools: list[str] | None = None,
    timeout_seconds: int = 120,
    file_paths: list[str] | None = None,
    ruff_repo_path: Path | None = None,
    python_version: str = DEFAULT_PYTHON_VERSION,
) -> Iterator[tuple[str, dict[str, Any]]]:
    """Yield (tool_name, result) pairs as each tool finishes."""
    env_overrides = _venv_env_overrides(venv_python)
    selected_specs = TOOL_SPECS if enabled_tools is None else [TOOL_SPEC_BY_NAME[name] for name in enabled_tools if name in TOOL_SPEC_BY_NAME]

    command_by_tool: dict[str, list[str]] = {
        spec.name: _command_for_tool(spec, venv_python, python_tool_repo_paths, file_paths, python_version)
        for spec in selected_specs
    }

    # Include ruff_ty in the same executor so it runs in parallel.
    # The caller only passes ruff_repo_path when ty_ruff is enabled.
    include_ruff_ty = ruff_repo_path is not None

    total_workers = len(command_by_tool) + (1 if include_ruff_ty else 0)
    if total_workers == 0:
        return

    with ThreadPoolExecutor(max_workers=max(1, total_workers)) as executor:
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
        if include_ruff_ty:
            assert ruff_repo_path is not None
            futures[executor.submit(
                _run_ruff_ty_from_repo,
                ruff_repo_path,
                project_dir,
                venv_python,
                python_version,
                LOCAL_CHECKOUT_TOOL_TIMEOUT_SECONDS,
            )] = RUFF_TY_TOOL_NAME

        for future in as_completed(futures):
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
    """Install all tools into a throwaway venv to warm the uv cache and detect versions."""
    prime_dir = Path(tempfile.mkdtemp(prefix="multiplay-prime-"))
    try:
        tool_packages = [spec.name for spec in TOOL_SPECS]
        _run_uv_pip_install(prime_dir, tool_packages)
        venv_python = _venv_python_path(prime_dir)
        return _detect_tool_versions(prime_dir, venv_python)
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
    metadata: dict[str, Any] = {}
    files: list[dict[str, str]] = []
    for filename, info in raw_files.items():
        content = info.get("content", "")
        if filename == "_multiplay_metadata.json":
            try:
                metadata = json.loads(content)
            except json.JSONDecodeError:
                pass
            continue
        files.append({"name": filename, "content": content})

    dependencies = metadata.get("dependencies", [])
    if not isinstance(dependencies, list):
        dependencies = []

    return {"files": files, "dependencies": dependencies}


def _create_gist(files: list[dict[str, Any]], dependencies: list[str]) -> dict[str, str]:
    tmp = Path(tempfile.mkdtemp(prefix="multiplay-gist-"))
    try:
        paths: list[str] = []
        for entry in files:
            name = str(entry.get("name", ""))
            content = entry.get("content", "")
            rel = _safe_relative_path(name)
            dest = tmp / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_text(content, encoding="utf-8")
            paths.append(str(dest))

        metadata_path = tmp / "_multiplay_metadata.json"
        metadata_path.write_text(json.dumps({"dependencies": dependencies}), encoding="utf-8")
        paths.append(str(metadata_path))

        result = subprocess.run(
            ["gh", "gist", "create", "--public", *paths],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        if result.returncode != 0:
            stderr = (result.stderr or "").strip()
            raise RuntimeError(f"gh gist create failed (exit {result.returncode}): {stderr}")

        gist_url = result.stdout.strip()
        if not gist_url:
            raise RuntimeError("gh gist create returned no URL")

        gist_id = gist_url.rstrip("/").rsplit("/", 1)[-1]
        return {"gist_url": gist_url, "gist_id": gist_id}
    except FileNotFoundError as exc:
        raise RuntimeError(
            "gh CLI not found. Install it (https://cli.github.com) and run `gh auth login`."
        ) from exc
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


class AppHandler(BaseHTTPRequestHandler):
    server_version = "MultifileEditor/2.0"

    def handle_one_request(self) -> None:
        try:
            super().handle_one_request()
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True

    def log_message(self, format: str, *args: Any) -> None:
        print(f"[{self.log_date_time_string()}] {self.address_string()} - {format % args}")

    def _get_or_create_session(self) -> Session:
        """Get or create a session from the X-Session-Id header."""
        client_id = self.headers.get(SESSION_HEADER_NAME)
        session, _created = SESSION_MANAGER.get_or_create(client_id)
        return session

    def do_GET(self) -> None:  # noqa: N802
        path = urlsplit(self.path).path

        if path == "/api/health":
            session = self._get_or_create_session()
            _json_response(self, HTTPStatus.OK, {
                "ok": True,
                "server_id": SERVER_ID,
                "session_id": session.id[:8],
            })
            return

        if path == "/api/bootstrap":
            session = self._get_or_create_session()
            _json_response(self, HTTPStatus.OK,
                {
                    "initial_files": DEFAULT_FILES,
                    "initial_dependencies": DEFAULT_DEPENDENCIES,
                    "initial_python_version": DEFAULT_PYTHON_VERSION,
                    "python_versions": list(SUPPORTED_PYTHON_VERSIONS),
                    "tool_order": list(TOOL_ORDER),
                    "enabled_tools": list(TOOL_ORDER),
                    "local_checkers_enabled": not HOSTED_MODE,
                    "initial_ruff_repo_path": "",
                    "initial_python_tool_repo_paths": {},
                    "tool_versions": dict(TOOL_VERSIONS),
                    "hosted_mode": HOSTED_MODE,
                    "session_id": session.id[:8],
                    "temp_dir": str(session.project_dir),
                },
            )
            return

        if path == "/api/dir-fingerprint":
            if HOSTED_MODE:
                _json_response(self, HTTPStatus.FORBIDDEN, {"error": "Local checker directories are not available in hosted mode"})
                return
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

        if path != "/api/analyze":
            _json_response(self, HTTPStatus.NOT_FOUND, {"error": "Not found"})
            return

        try:
            session = self._get_or_create_session()
            project_dir = session.project_dir

            body = self._read_json_body()
            files = body.get("files")
            if not isinstance(files, list) or not files:
                raise ValueError("Expected non-empty 'files' list")
            dependencies = _normalize_dependencies(body.get("dependencies", DEFAULT_DEPENDENCIES))
            python_version = _normalize_python_version(body.get("python_version"))
            refresh_venv = bool(body.get("refresh_venv"))
            if HOSTED_MODE:
                ruff_repo_path = None
                python_tool_repo_paths = {}
            else:
                ruff_repo_path = _normalize_ruff_repo_path(body.get("ruff_repo_path"))
                python_tool_repo_paths = _normalize_python_tool_repo_paths(body.get("python_tool_repo_paths"))
            tool_order = _tool_order_for_request(ruff_repo_path)
            enabled_tools = _normalize_enabled_tools_for_order(body.get("enabled_tools"), tool_order)

            with session.lock:
                _write_files_to_project(project_dir, files)

                if refresh_venv:
                    venv_dir = project_dir / ".venv"
                    if venv_dir.exists():
                        shutil.rmtree(venv_dir)
                    tool_packages = [spec.name for spec in TOOL_SPECS]
                    packages_to_install = tool_packages + dependencies
                else:
                    packages_to_install = dependencies

                dependency_install = _run_uv_pip_install(
                    project_dir, packages_to_install
                )
                if dependency_install["returncode"] != 0:
                    _json_response(self, HTTPStatus.BAD_REQUEST,
                        {
                            "error": "Dependency install failed",
                            "error_type": "dependency_install_failed",
                            "dependency_install": dependency_install,
                            "dependencies": dependencies,
                            "python_version": python_version,
                            "enabled_tools": enabled_tools,
                            "tool_order": tool_order,
                            "ruff_repo_path": str(ruff_repo_path) if ruff_repo_path is not None else "",
                            "python_tool_repo_paths": _python_tool_repo_paths_payload(python_tool_repo_paths),
                            "tool_versions": dict(TOOL_VERSIONS),
                            "session_id": session.id[:8],
                            "temp_dir": str(project_dir),
                        },
                    )
                    return

                venv_python = _venv_python_path(project_dir)
                base_enabled_tools = [tool_name for tool_name in enabled_tools if tool_name in TOOL_SPEC_BY_NAME]
                file_paths = [str(entry.get("name", "")) for entry in files]

                # Stream NDJSON: metadata, then each tool result, then done.
                _ndjson_start(self)
                _ndjson_send(self, {
                    "type": "metadata",
                    "tool_versions": dict(TOOL_VERSIONS),
                    "dependencies": dependencies,
                    "python_version": python_version,
                    "python_versions": list(SUPPORTED_PYTHON_VERSIONS),
                    "enabled_tools": enabled_tools,
                    "tool_order": tool_order,
                    "ruff_repo_path": str(ruff_repo_path) if ruff_repo_path is not None else "",
                    "python_tool_repo_paths": _python_tool_repo_paths_payload(python_tool_repo_paths),
                    "dependency_install": dependency_install,
                    "hosted_mode": HOSTED_MODE,
                    "session_id": session.id[:8],
                    "temp_dir": str(project_dir),
                })

                try:
                    for tool_name, result in _iter_all_tools(
                        project_dir,
                        venv_python,
                        python_tool_repo_paths,
                        base_enabled_tools,
                        timeout_seconds=ANALYZE_TOOL_TIMEOUT_SECONDS,
                        file_paths=file_paths,
                        ruff_repo_path=ruff_repo_path if RUFF_TY_TOOL_NAME in enabled_tools else None,
                        python_version=python_version,
                    ):
                        _ndjson_send(self, {"type": "result", "tool": tool_name, "data": result})
                    _ndjson_send(self, {"type": "done"})
                except (BrokenPipeError, ConnectionResetError):
                    pass
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
            dependencies = _normalize_dependencies(body.get("dependencies"))
            result = _create_gist(files, dependencies)
            _json_response(self, HTTPStatus.OK, result)
        except ValueError as exc:
            _json_response(self, HTTPStatus.BAD_REQUEST, {"error": str(exc)})
        except json.JSONDecodeError:
            _json_response(self, HTTPStatus.BAD_REQUEST, {"error": "Invalid JSON payload"})
        except RuntimeError as exc:
            _json_response(self, HTTPStatus.INTERNAL_SERVER_ERROR, {"error": str(exc)})
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
    return parser.parse_args()


def _session_reaper_loop(manager: SessionManager, interval: float, max_idle: float) -> None:
    """Background thread that periodically reaps stale sessions."""
    while True:
        time.sleep(interval)
        try:
            reaped = manager.reap_stale(max_idle)
            if reaped:
                print(f"[session] Reaped {reaped} stale session(s), {manager.count} active")
        except Exception as exc:  # pragma: no cover
            print(f"[session] Reaper error: {exc}")


def main() -> None:
    global SESSION_MANAGER

    if HOSTED_MODE and _PROJECT_DIR_ENV:
        raise SystemExit("MULTIPLAY_HOSTED=1 and MULTIPLAY_PROJECT_DIR cannot be used together")

    fixed_dir = Path(_PROJECT_DIR_ENV) if _PROJECT_DIR_ENV else None
    SESSION_MANAGER = SessionManager(fixed_project_dir=fixed_dir)

    if not STATIC_DIR.is_dir():
        raise SystemExit(f"Static directory not found: {STATIC_DIR}")

    args = parse_args()

    if not args.skip_prime:
        print("Priming tool installs (warming uv cache)...")
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

    reaper = threading.Thread(
        target=_session_reaper_loop,
        args=(SESSION_MANAGER, SESSION_REAPER_INTERVAL_SECONDS, SESSION_MAX_IDLE_SECONDS),
        daemon=True,
    )
    reaper.start()

    if HOSTED_MODE:
        print("Hosted mode: local checkers disabled, session ID shown in UI")
    else:
        print("Local mode: local checkers enabled, temp dir shown in UI")
    if _PROJECT_DIR_ENV:
        print(f"Project directory: {_PROJECT_DIR_ENV} (shared across all sessions)")
    print(f"Per-tab sessions (idle timeout: {SESSION_MAX_IDLE_SECONDS}s)")

    print(f"Static directory: {STATIC_DIR}")
    print(f"\nServing app on \033[1;4;32mhttp://{args.host}:{port}\033[0m")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down...")
    finally:
        SESSION_MANAGER.destroy_all()
        # os._exit() is a thin wrapper around the _exit(2) syscall that
        # terminates the process immediately, skipping atexit handlers,
        # finally blocks in other threads, and stdio buffer flushing.
        # That's exactly what we want here: without it, interpreter
        # shutdown blocks on concurrent.futures' _python_exit(), which
        # joins every ThreadPoolExecutor worker thread — including any
        # still inside subprocess.run() waiting for a child process.
        # Skipping buffer flushing is fine because the server is
        # stateless and we already called print() above (which flushes).
        os._exit(0)


if __name__ == "__main__":
    main()
