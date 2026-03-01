const STORAGE_KEY = "multiplay_state";
const DEFAULT_PYTHON_VERSION_OPTIONS = ["3.10", "3.11", "3.12", "3.13", "3.14", ""];
const DEFAULT_PYTHON_VERSION = "3.14";

function saveState() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        files: state.files.map((f) => ({ name: f.name, content: f.content })),
        pythonVersion: state.pythonVersion,
        activeIndex: state.activeIndex,
        ruffRepoPath: state.ruffRepoPath,
        tyBinaryPath: state.tyBinaryPath,
        toolOrder: toolOrder.slice(),
        toolSettings: state.toolSettings,
      }),
    );
  } catch {
    // localStorage may be full or unavailable
  }
}

function loadSavedState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!Array.isArray(data.files) || data.files.length === 0) return null;
    const files = data.files
      .filter((f) => f && typeof f.name === "string" && typeof f.content === "string")
      .map((f) => ({ name: f.name, content: f.content }));
    if (files.length === 0) return null;
    let savedToolOrder = null;
    if (Array.isArray(data.toolOrder) && data.toolOrder.every((t) => typeof t === "string")) {
      savedToolOrder = data.toolOrder;
    }
    let savedToolSettings = null;
    if (data.toolSettings && typeof data.toolSettings === "object" && !Array.isArray(data.toolSettings)) {
      savedToolSettings = {};
      for (const [key, val] of Object.entries(data.toolSettings)) {
        if (val && typeof val === "object") {
          savedToolSettings[key] = {
            enabled: val.enabled !== false,
            collapsed: !!val.collapsed,
          };
        }
      }
    }
    return {
      files,
      pythonVersion: typeof data.pythonVersion === "string" ? data.pythonVersion : DEFAULT_PYTHON_VERSION,
      activeIndex: typeof data.activeIndex === "number" ? data.activeIndex : 0,
      ruffRepoPath: typeof data.ruffRepoPath === "string" ? data.ruffRepoPath : "",
      tyBinaryPath: typeof data.tyBinaryPath === "string" ? data.tyBinaryPath : "",
      toolOrder: savedToolOrder,
      toolSettings: savedToolSettings,
    };
  } catch {
    return null;
  }
}

const DEFAULT_FILES = [
  {
    name: "main.py",
    content:
      "from helpers import greet\n\n" +
      "def run() -> None:\n" +
      "    print(greet('world'))\n\n" +
      "if __name__ == '__main__':\n" +
      "    run()\n",
  },
  { name: "helpers.py", content: "def greet(name: str) -> str:\n    return f'hello, {name}'\n" },
  { name: "pyproject.toml", content: "" },
];

const DEFAULT_TOOL_ORDER = ["ty", "pyright", "pyrefly", "mypy", "zuban", "pycroscope"];
let toolOrder = DEFAULT_TOOL_ORDER.slice();
const RUFF_TY_TOOL = "ty_ruff";
const PYTHON_LOCAL_TOOLS = ["mypy", "pycroscope"];

function toolConfigSection(tool) {
  const name = tool === RUFF_TY_TOOL ? "ty" : tool;
  return `[tool.${name}]`;
}

const TOOL_DOCS_URL = {
  ty: "https://docs.astral.sh/ty/reference/configuration/",
  ty_ruff: "https://docs.astral.sh/ty/reference/configuration/",
  pyright: "https://microsoft.github.io/pyright/#/configuration",
  pyrefly: "https://pyrefly.org/en/docs/configuration/",
  mypy: "https://mypy.readthedocs.io/en/stable/config_file.html",
  zuban: "https://docs.zubanls.com/en/latest/usage.html#configuration",
  pycroscope: "https://pycroscope.readthedocs.io/en/latest/configuration.html",
};

let draggedTool = null;
let draggedFileIndex = null;

const state = {
  files: [],
  pythonVersion: DEFAULT_PYTHON_VERSION,
  pythonVersionOptions: DEFAULT_PYTHON_VERSION_OPTIONS.slice(),
  ruffRepoPath: "",
  tyBinaryPath: "",
  resolvedTyBinaryPath: null,
  pythonToolRepoPaths: {},
  activeIndex: 0,
  renamingIndex: -1,
  debounceMs: 500,
  debounceTimer: null,
  requestNumber: 0,
  latestHandledRequest: 0,
  toolVersions: {},
  toolSettings: {},
  lastResults: {},
  currentController: null,
};

// Server-restart auto-reload: poll /api/health and reload if the server ID changes
(function initServerReloadWatcher() {
  let knownServerId = null;
  const POLL_INTERVAL_MS = 2000;
  let serverDown = false;

  // Create the disconnection banner (hidden by default)
  const banner = document.createElement("div");
  banner.className = "server-down-banner";
  banner.setAttribute("role", "alert");
  banner.innerHTML =
    '<span class="server-down-icon">&#x26A0;</span>' +
    '<span>Server disconnected &mdash; results may be stale</span>';
  document.body.prepend(banner);

  function setServerDown(down) {
    if (down === serverDown) return;
    serverDown = down;
    banner.classList.toggle("visible", down);
    document.body.classList.toggle("server-down", down);
  }

  async function poll() {
    try {
      const resp = await fetch("/api/health");
      if (!resp.ok) {
        setServerDown(true);
      } else {
        const body = await resp.json();
        const id = body.server_id;
        if (id) {
          if (knownServerId === null) {
            knownServerId = id;
          } else if (id !== knownServerId) {
            location.reload();
            return;
          }
        }
        setServerDown(false);
      }
    } catch {
      setServerDown(true);
    }
    setTimeout(poll, POLL_INTERVAL_MS);
  }

  setTimeout(poll, POLL_INTERVAL_MS);
})();

// Watch a local Ruff checkout directory for source changes and auto-rerun ty_ruff.
let _ruffDirWatchTimer = null;
let _ruffDirLastFingerprint = null;

function stopRuffDirWatcher() {
  if (_ruffDirWatchTimer !== null) {
    clearTimeout(_ruffDirWatchTimer);
    _ruffDirWatchTimer = null;
  }
  _ruffDirLastFingerprint = null;
}

function startRuffDirWatcher() {
  stopRuffDirWatcher();
  const ruffPath = state.ruffRepoPath;
  if (!ruffPath) return;

  async function poll() {
    // Stop if the path changed or ty_ruff was disabled since we started.
    if (state.ruffRepoPath !== ruffPath) {
      stopRuffDirWatcher();
      return;
    }
    const tyRuffSettings = state.toolSettings[RUFF_TY_TOOL];
    if (!tyRuffSettings || !tyRuffSettings.enabled) {
      scheduleNext();
      return;
    }

    try {
      const resp = await fetch("/api/dir-fingerprint?path=" + encodeURIComponent(ruffPath));
      if (!resp.ok) {
        scheduleNext();
        return;
      }
      const body = await resp.json();
      const fingerprint = body.fingerprint;
      if (typeof fingerprint !== "string" || !fingerprint) {
        scheduleNext();
        return;
      }

      if (_ruffDirLastFingerprint !== null && fingerprint !== _ruffDirLastFingerprint) {
        scheduleAnalyze({ onlyTools: [RUFF_TY_TOOL] });
      }
      _ruffDirLastFingerprint = fingerprint;
    } catch {
      // Network error or server down — skip this cycle.
    }
    scheduleNext();
  }

  function scheduleNext() {
    _ruffDirWatchTimer = setTimeout(poll, 1000);
  }

  // Seed immediately, then chain via setTimeout so polls never overlap.
  poll();
}

const tabsEl = document.getElementById("tabs");
const pythonVersionEl = document.getElementById("python-version");
const ruffRepoPathEl = document.getElementById("ruff-repo-path");
const tyBinaryPathEl = document.getElementById("ty-binary-path");
const tyBinaryPathNoteEl = document.getElementById("ty-binary-path-note");
const mypyRepoPathEl = document.getElementById("mypy-repo-path");
const pycroscopeRepoPathEl = document.getElementById("pycroscope-repo-path");
const lineNumbersEl = document.getElementById("line-numbers");
const highlightEl = document.getElementById("highlight");
const editorEl = document.getElementById("editor");
const colGuideWrapEl = document.getElementById("col-guide-wrap");
const colGuideEl = document.getElementById("col-guide");
const colGuideCursorEl = document.getElementById("col-guide-cursor");
const colGuideToggleEl = document.getElementById("col-guide-toggle");
const statusEl = document.getElementById("status");
const statusLineEl = document.getElementById("status-line");
const resultsEl = document.getElementById("results");
const depErrorEl = document.getElementById("dep-error");
const themeToggleEl = document.getElementById("theme-toggle");

// Theme handling
function initTheme() {
  const stored = localStorage.getItem("theme");
  if (stored === "dark" || stored === "light") {
    document.documentElement.setAttribute("data-theme", stored);
  }
  // If no stored preference, CSS media query handles system preference
}

function toggleTheme() {
  const current = document.documentElement.getAttribute("data-theme");
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;

  let newTheme;
  if (current === "dark") {
    newTheme = "light";
  } else if (current === "light") {
    newTheme = "dark";
  } else {
    // No explicit theme set, toggle from system preference
    newTheme = prefersDark ? "light" : "dark";
  }

  document.documentElement.setAttribute("data-theme", newTheme);
  localStorage.setItem("theme", newTheme);

  // Re-render results to update ANSI colors
  if (typeof renderResults === "function" && state.lastResults) {
    renderResults(state.lastResults);
  }
}

if (themeToggleEl) {
  themeToggleEl.addEventListener("click", toggleTheme);
}
initTheme();

const resetBtnEl = document.getElementById("reset-btn");
if (resetBtnEl) {
  resetBtnEl.addEventListener("click", handleReset);
}

const shareBtnEl = document.getElementById("share-btn");
if (shareBtnEl) {
  shareBtnEl.addEventListener("click", handleShare);
}

const gistInputEl = document.getElementById("gist-input");
const gistLoadBtnEl = document.getElementById("gist-load-btn");
if (gistLoadBtnEl) {
  gistLoadBtnEl.addEventListener("click", handleLoadGist);
}
if (gistInputEl) {
  gistInputEl.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      handleLoadGist();
    }
  });
}

function handleReset() {
  state.files = [
    { name: "main.py", content: "" },
    { name: "pyproject.toml", content: buildPyprojectContent() },
  ];
  state.activeIndex = 0;
  renderTabs();
  syncEditorFromState();
  scheduleAnalyze();
}

async function handleShare() {
  shareBtnEl.disabled = true;
  shareBtnEl.textContent = "Sharing...";
  try {
    const resp = await fetch("/api/share", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        files: state.files.map((f) => ({ name: f.name, content: f.content })),
      }),
    });
    const body = await resp.json();
    if (!resp.ok) {
      setStatus("Share failed: " + (body.error || resp.status));
      return;
    }
    const gistId = body.gist_id;
    try {
      await navigator.clipboard.writeText(gistId);
      setStatus("Gist ID copied to clipboard: " + gistId);
    } catch {
      setStatus("Shared! Gist ID: " + gistId);
    }
    const gistInputEl = document.getElementById("gist-input");
    if (gistInputEl) {
      gistInputEl.value = gistId;
    }
  } catch (err) {
    setStatus("Share error: " + err.message);
  } finally {
    shareBtnEl.disabled = false;
    shareBtnEl.textContent = "Share";
  }
}

function extractGistId(raw) {
  const trimmed = (raw || "").trim();
  if (!trimmed) return "";
  // Accept full URLs like https://gist.github.com/user/abc123 or just the ID
  const match = trimmed.match(/([a-f0-9]+)\s*$/i);
  return match ? match[1] : trimmed;
}

async function handleLoadGist() {
  const gistId = extractGistId(gistInputEl ? gistInputEl.value : "");
  if (!gistId) {
    setStatus("Enter a gist ID or URL to load");
    return;
  }

  if (gistLoadBtnEl) {
    gistLoadBtnEl.disabled = true;
    gistLoadBtnEl.textContent = "Loading...";
  }

  try {
    const resp = await fetch("/api/gist/" + encodeURIComponent(gistId));
    const body = await resp.json();
    if (!resp.ok) {
      setStatus("Load gist failed: " + (body.error || resp.status));
      return;
    }

    const files = Array.isArray(body.files) ? body.files : [];
    const normalizedFiles = files
      .filter((f) => f && typeof f.name === "string" && typeof f.content === "string")
      .map((f) => ({ name: f.name, content: f.content }));

    if (normalizedFiles.length === 0) {
      setStatus("Gist contains no loadable files");
      return;
    }

    state.files = normalizedFiles;
    state.activeIndex = 0;

    saveState();
    renderTabs();
    syncEditorFromState();
    scheduleAnalyze();
    setStatus("Loaded " + normalizedFiles.length + " file(s) from gist " + gistId);
  } catch (err) {
    setStatus("Load gist error: " + err.message);
  } finally {
    if (gistLoadBtnEl) {
      gistLoadBtnEl.disabled = false;
      gistLoadBtnEl.textContent = "Load";
    }
  }
}

const PY_TOKEN_RE =
  /(#[^\n]*)|("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')|\b(False|None|True|and|as|assert|async|await|break|case|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|match|nonlocal|not|or|pass|raise|return|try|while|with|yield)\b|\b(abs|all|any|bool|dict|enumerate|filter|float|int|len|list|map|max|min|object|print|range|set|sorted|str|sum|tuple|type|zip)\b|(\b\d+(?:\.\d+)?\b)|(@[A-Za-z_]\w*)/gm;
const TOML_TOKEN_RE =
  /(^\s*\[\[[^\]\n]+\]\])|(^\s*\[[^\]\n]+\])|(^\s*(?:"[^"\n]+"|'[^'\n]+'|[A-Za-z0-9_.-]+)\s*(?==))|(#[^\n]*)|("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')|\b(true|false)\b|(\b[+-]?\d+(?:\.\d+)?\b)/gim;
const JSON_TOKEN_RE =
  /("(?:\\.|[^"\\\n])*"\s*(?=:))|("(?:\\.|[^"\\\n])*")|(\b(?:true|false)\b)|(\bnull\b)|(\b-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|([{}\[\],:])/gm;
const INI_TOKEN_RE =
  /(^\s*[;#].*$)|(^\s*\[[^\]\n]+\])|(^\s*[A-Za-z0-9_.-]+\s*(?==))|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')|(\b(?:true|false|yes|no|on|off)\b)|(\b[+-]?\d+(?:\.\d+)?\b)/gim;
const OUTPUT_MAX_LINES = 500;
const OUTPUT_MAX_CHARS = 100_000;
const ANSI_SGR_RE = /\u001b\[([0-9;]*)m/g;
const ANSI_OSC_RE = /\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g;
const ANSI_CSI_RE = /\u001b\[([0-9:;?]*)([@-~])/g;
const ANSI_ISO2022_RE = /\u001b[\(\)\*\+\-\.\/][\x30-\x7E]/g;
const ANSI_SINGLE_ESC_RE = /\u001b[@-Z\\-_]/g;
const ANSI_FG_LIGHT = [
  "#1f2328",
  "#b42318",
  "#18794e",
  "#9a6700",
  "#155eef",
  "#7f56d9",
  "#0e9384",
  "#667085",
];
const ANSI_FG_BRIGHT_LIGHT = [
  "#343a46",
  "#d92d20",
  "#12b76a",
  "#dc6803",
  "#2970ff",
  "#9e77ed",
  "#16b364",
  "#98a2b3",
];
const ANSI_FG_DARK = [
  "#e4e4e4",
  "#f87171",
  "#4ade80",
  "#fbbf24",
  "#60a5fa",
  "#c084fc",
  "#2dd4bf",
  "#9ca3af",
];
const ANSI_FG_BRIGHT_DARK = [
  "#f5f5f5",
  "#fca5a5",
  "#86efac",
  "#fcd34d",
  "#93c5fd",
  "#d8b4fe",
  "#5eead4",
  "#d1d5db",
];

function getAnsiFg() {
  const theme = document.documentElement.getAttribute("data-theme");
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const isDark = theme === "dark" || (theme !== "light" && prefersDark);
  return isDark ? ANSI_FG_DARK : ANSI_FG_LIGHT;
}

function getAnsiFgBright() {
  const theme = document.documentElement.getAttribute("data-theme");
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const isDark = theme === "dark" || (theme !== "light" && prefersDark);
  return isDark ? ANSI_FG_BRIGHT_DARK : ANSI_FG_BRIGHT_LIGHT;
}

let _tempDirText = "";

function setStatus(text) {
  statusEl.textContent = text;
  statusEl.classList.toggle("status-busy", text === "Analyzing..." || text === "Loading...");
  _rebuildStatusLine();
}

function setTempDir(text) {
  _tempDirText = text;
  _rebuildStatusLine();
}

function _rebuildStatusLine() {
  // Keep the <span id="status"> intact; append temp-dir after a separator
  const existing = statusLineEl.querySelector(".status-sep");
  if (existing) existing.remove();
  const existingTd = statusLineEl.querySelector(".status-tempdir");
  if (existingTd) existingTd.remove();
  if (_tempDirText && statusEl.textContent) {
    const sep = document.createElement("span");
    sep.className = "status-sep";
    sep.textContent = " · ";
    statusLineEl.appendChild(sep);
    const td = document.createElement("span");
    td.className = "status-tempdir";
    td.textContent = _tempDirText;
    statusLineEl.appendChild(td);
  } else if (_tempDirText) {
    const td = document.createElement("span");
    td.className = "status-tempdir";
    td.textContent = _tempDirText;
    statusLineEl.appendChild(td);
  }
}

function activeFile() {
  return state.files[state.activeIndex];
}

function escapeHtml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function xterm256Color(index) {
  if (index < 0 || index > 255) {
    return null;
  }

  const base = [
    [0, 0, 0],
    [205, 49, 49],
    [13, 188, 121],
    [229, 229, 16],
    [36, 114, 200],
    [188, 63, 188],
    [17, 168, 205],
    [229, 229, 229],
    [102, 102, 102],
    [241, 76, 76],
    [35, 209, 139],
    [245, 245, 67],
    [59, 142, 234],
    [214, 112, 214],
    [41, 184, 219],
    [255, 255, 255],
  ];
  if (index < 16) {
    const [r, g, b] = base[index];
    return `rgb(${r}, ${g}, ${b})`;
  }
  if (index < 232) {
    const i = index - 16;
    const r = Math.floor(i / 36);
    const g = Math.floor((i % 36) / 6);
    const b = i % 6;
    const comp = [0, 95, 135, 175, 215, 255];
    return `rgb(${comp[r]}, ${comp[g]}, ${comp[b]})`;
  }
  const gray = 8 + (index - 232) * 10;
  return `rgb(${gray}, ${gray}, ${gray})`;
}

function ansiStyleToCss(style) {
  const parts = [];
  if (style.fg) {
    parts.push(`color:${style.fg}`);
  }
  if (style.bg) {
    parts.push(`background-color:${style.bg}`);
  }
  if (style.bold) {
    parts.push("font-weight:700");
  }
  if (style.italic) {
    parts.push("font-style:italic");
  }
  if (style.underline) {
    parts.push("text-decoration:underline");
  }
  if (style.dim) {
    parts.push("opacity:0.85");
  }
  return parts.join(";");
}

function sanitizeAnsiInput(raw) {
  let cleaned = typeof raw === "string" ? raw : "";
  cleaned = cleaned.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  cleaned = cleaned.replace(ANSI_OSC_RE, "");
  cleaned = cleaned.replace(ANSI_CSI_RE, (full, _params, finalByte) => (finalByte === "m" ? full : ""));
  cleaned = cleaned.replace(ANSI_ISO2022_RE, "");
  cleaned = cleaned.replace(ANSI_SINGLE_ESC_RE, "");
  return cleaned;
}

function clearDependencyInstallError() {
  depErrorEl.classList.add("hidden");
  depErrorEl.innerHTML = "";
}

function showDependencyInstallError(info) {
  const command = typeof info?.command === "string" && info.command ? info.command : "uv sync";
  const returnCode = typeof info?.returncode === "number" ? info.returncode : "?";
  const durationMs = typeof info?.duration_ms === "number" ? info.duration_ms : "?";
  const output = typeof info?.output === "string" ? info.output : "";

  depErrorEl.innerHTML =
    `<div class="dep-error-title">Dependency sync failed</div>` +
    `<p class="dep-error-meta">` +
    `Could not run <code>${escapeHtml(command)}</code> ` +
    `(exit ${escapeHtml(String(returnCode))}, ${escapeHtml(String(durationMs))}ms).` +
    `</p>` +
    `<pre>${ansiToHtml(output || "(no output)")}</pre>`;
  depErrorEl.classList.remove("hidden");
}

const TY_BINARY_PATH_DEFAULT_NOTE = tyBinaryPathNoteEl ? tyBinaryPathNoteEl.innerHTML : "";

function syncTyBinaryPathNote() {
  if (!tyBinaryPathNoteEl) return;
  const raw = state.tyBinaryPath;
  const resolved = state.resolvedTyBinaryPath;
  // Show error only when: user typed something, AND the server responded
  // with empty string (meaning validation failed). null = still waiting.
  if (raw && resolved !== null && !resolved) {
    tyBinaryPathNoteEl.textContent = "Path not found or is not a file: " + raw;
    tyBinaryPathNoteEl.classList.add("deps-note-error");
  } else {
    tyBinaryPathNoteEl.innerHTML = TY_BINARY_PATH_DEFAULT_NOTE;
    tyBinaryPathNoteEl.classList.remove("deps-note-error");
  }
}

function applyAnsiCodes(style, params) {
  const next = { ...style };
  let i = 0;
  while (i < params.length) {
    const code = params[i];
    if (Number.isNaN(code)) {
      i += 1;
      continue;
    }

    if (code === 0) {
      next.fg = null;
      next.bg = null;
      next.bold = false;
      next.dim = false;
      next.italic = false;
      next.underline = false;
      i += 1;
      continue;
    }

    if (code === 1) {
      next.bold = true;
      i += 1;
      continue;
    }
    if (code === 2) {
      next.dim = true;
      i += 1;
      continue;
    }
    if (code === 3) {
      next.italic = true;
      i += 1;
      continue;
    }
    if (code === 4) {
      next.underline = true;
      i += 1;
      continue;
    }
    if (code === 22) {
      next.bold = false;
      next.dim = false;
      i += 1;
      continue;
    }
    if (code === 23) {
      next.italic = false;
      i += 1;
      continue;
    }
    if (code === 24) {
      next.underline = false;
      i += 1;
      continue;
    }
    if (code === 39) {
      next.fg = null;
      i += 1;
      continue;
    }
    if (code === 49) {
      next.bg = null;
      i += 1;
      continue;
    }

    if (code >= 30 && code <= 37) {
      next.fg = getAnsiFg()[code - 30];
      i += 1;
      continue;
    }
    if (code >= 90 && code <= 97) {
      next.fg = getAnsiFgBright()[code - 90];
      i += 1;
      continue;
    }
    if (code >= 40 && code <= 47) {
      next.bg = getAnsiFg()[code - 40];
      i += 1;
      continue;
    }
    if (code >= 100 && code <= 107) {
      next.bg = getAnsiFgBright()[code - 100];
      i += 1;
      continue;
    }

    if (code === 38 || code === 48) {
      const isForeground = code === 38;
      const mode = params[i + 1];
      if (mode === 5) {
        const colorIndex = params[i + 2];
        const rgb = xterm256Color(colorIndex);
        if (rgb) {
          if (isForeground) {
            next.fg = rgb;
          } else {
            next.bg = rgb;
          }
        }
        i += 3;
        continue;
      }
      if (mode === 2) {
        const r = params[i + 2];
        const g = params[i + 3];
        const b = params[i + 4];
        if (![r, g, b].some((v) => Number.isNaN(v))) {
          const rgb = `rgb(${Math.max(0, Math.min(255, r))}, ${Math.max(0, Math.min(255, g))}, ${Math.max(
            0,
            Math.min(255, b),
          )})`;
          if (isForeground) {
            next.fg = rgb;
          } else {
            next.bg = rgb;
          }
        }
        i += 5;
        continue;
      }
    }

    i += 1;
  }

  return next;
}

function ansiToHtml(text) {
  const input = sanitizeAnsiInput(text);
  if (!input) {
    return escapeHtml("(no output)");
  }

  let html = "";
  let lastIndex = 0;
  let style = {
    fg: null,
    bg: null,
    bold: false,
    dim: false,
    italic: false,
    underline: false,
  };
  ANSI_SGR_RE.lastIndex = 0;

  function appendChunk(chunk) {
    if (!chunk) {
      return;
    }
    const escaped = escapeHtml(chunk);
    const css = ansiStyleToCss(style);
    html += css ? `<span style="${css}">${escaped}</span>` : escaped;
  }

  for (const match of input.matchAll(ANSI_SGR_RE)) {
    const idx = match.index || 0;
    if (idx > lastIndex) {
      appendChunk(input.slice(lastIndex, idx));
    }

    const paramsText = typeof match[1] === "string" ? match[1] : "";
    const params =
      paramsText.length === 0
        ? [0]
        : paramsText
            .split(";")
            .map((piece) => (piece.length === 0 ? 0 : Number.parseInt(piece, 10)));
    style = applyAnsiCodes(style, params);
    lastIndex = idx + match[0].length;
  }

  if (lastIndex < input.length) {
    appendChunk(input.slice(lastIndex));
  }

  return html || escapeHtml("(no output)");
}

function linkifyLocations(html) {
  const names = state.files.map((f) => f.name).filter(Boolean);
  if (names.length === 0) return html;
  const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(
    "(" + escaped.join("|") + "):(\\d+)(?::(\\d+))?",
    "g",
  );
  // Split on HTML tags so we only replace within text nodes
  const parts = html.split(/(<[^>]*>)/);
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].startsWith("<")) continue;
    parts[i] = parts[i].replace(pattern, (match, file, line, col) => {
      const dc = col ? ` data-col="${col}"` : "";
      return `<a class="loc-link" data-file="${escapeHtml(file)}" data-line="${line}"${dc}>${match}</a>`;
    });
  }
  return parts.join("");
}

function navigateToLine(line, col) {
  const content = editorEl.value;
  const lines = content.split("\n");
  if (line < 1 || line > lines.length) return;

  let start = 0;
  for (let i = 0; i < line - 1; i++) {
    start += lines[i].length + 1;
  }
  const clampedCol = Math.min(Math.max((col || 1) - 1, 0), lines[line - 1].length);
  const pos = start + clampedCol;

  editorEl.focus();
  editorEl.setSelectionRange(pos, pos);

  const style = getComputedStyle(editorEl);
  const lineHeight = parseFloat(style.lineHeight) || 20;
  const paddingTop = parseFloat(style.paddingTop) || 0;
  const editorHeight = editorEl.clientHeight;
  const targetScroll = (line - 1) * lineHeight - editorHeight / 2 + lineHeight / 2;
  editorEl.scrollTop = Math.max(0, targetScroll);

  // Flash the target line
  const shell = editorEl.closest(".editor-shell");
  if (shell) {
    shell.querySelectorAll(".line-glow").forEach((el) => el.remove());
    const glow = document.createElement("div");
    glow.className = "line-glow";
    glow.style.top = `${paddingTop + (line - 1) * lineHeight - editorEl.scrollTop}px`;
    glow.style.height = `${lineHeight}px`;
    shell.appendChild(glow);
    glow.addEventListener("animationend", () => glow.remove());
  }
}

function extensionOf(filename) {
  const name = (filename || "").trim().toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot);
}

function withVisibleTrailingNewline(source, html) {
  if (!html) {
    return " ";
  }
  if (source.endsWith("\n")) {
    return html + " ";
  }
  return html;
}

function renderPlain(source) {
  return withVisibleTrailingNewline(source, escapeHtml(source));
}

function renderByRegex(source, regex, classSelector) {
  let html = "";
  let lastIndex = 0;
  regex.lastIndex = 0;

  for (const match of source.matchAll(regex)) {
    const idx = match.index || 0;
    if (idx > lastIndex) {
      html += escapeHtml(source.slice(lastIndex, idx));
    }

    const token = match[0];
    const cls = classSelector(match);
    const escaped = escapeHtml(token);
    html += cls ? `<span class="${cls}">${escaped}</span>` : escaped;
    lastIndex = idx + token.length;
  }

  if (lastIndex < source.length) {
    html += escapeHtml(source.slice(lastIndex));
  }

  return withVisibleTrailingNewline(source, html);
}

function renderPython(source) {
  return renderByRegex(source, PY_TOKEN_RE, (match) => {
    if (match[1]) {
      return "py-comment";
    }
    if (match[2]) {
      return "py-string";
    }
    if (match[3]) {
      return "py-keyword";
    }
    if (match[4]) {
      return "py-builtin";
    }
    if (match[5]) {
      return "py-number";
    }
    if (match[6]) {
      return "py-decorator";
    }
    return "";
  });
}

function renderToml(source) {
  return renderByRegex(source, TOML_TOKEN_RE, (match) => {
    if (match[1] || match[2]) {
      return "toml-table";
    }
    if (match[3]) {
      return "toml-key";
    }
    if (match[4]) {
      return "toml-comment";
    }
    if (match[5]) {
      return "toml-string";
    }
    if (match[6]) {
      return "toml-bool";
    }
    if (match[7]) {
      return "toml-number";
    }
    return "";
  });
}

function renderJson(source) {
  return renderByRegex(source, JSON_TOKEN_RE, (match) => {
    if (match[1]) {
      return "json-key";
    }
    if (match[2]) {
      return "json-string";
    }
    if (match[3]) {
      return "json-bool";
    }
    if (match[4]) {
      return "json-null";
    }
    if (match[5]) {
      return "json-number";
    }
    if (match[6]) {
      return "json-punct";
    }
    return "";
  });
}

function renderIni(source) {
  return renderByRegex(source, INI_TOKEN_RE, (match) => {
    if (match[1]) {
      return "ini-comment";
    }
    if (match[2]) {
      return "ini-section";
    }
    if (match[3]) {
      return "ini-key";
    }
    if (match[4]) {
      return "ini-string";
    }
    if (match[5]) {
      return "ini-bool";
    }
    if (match[6]) {
      return "ini-number";
    }
    return "";
  });
}

function renderHighlightedCode(source, filename) {
  const ext = extensionOf(filename);
  if (ext === ".py" || ext === ".pyi") {
    return renderPython(source);
  }
  if (ext === ".toml") {
    return renderToml(source);
  }
  if (ext === ".json") {
    return renderJson(source);
  }
  if (ext === ".ini" || ext === ".cfg") {
    return renderIni(source);
  }
  return renderPlain(source);
}

function syncHighlightScroll() {
  highlightEl.scrollTop = editorEl.scrollTop;
  highlightEl.scrollLeft = editorEl.scrollLeft;
  lineNumbersEl.scrollTop = editorEl.scrollTop;
  if (typeof syncColGuideScroll === "function") syncColGuideScroll();
}

function updateEditorOverflowFade() {
  const shell = editorEl.closest(".editor-shell");
  if (!shell) return;
  const hasMore = editorEl.scrollHeight - editorEl.scrollTop - editorEl.clientHeight > 1;
  shell.classList.toggle("has-overflow-below", hasMore);
}

new ResizeObserver(updateEditorOverflowFade).observe(editorEl);

document.getElementById("editor-expand-btn").addEventListener("click", () => {
  const wrap = document.querySelector(".editor-wrap");
  // Expand so the editor's scroll content fits without scrolling
  const overflow = editorEl.scrollHeight - editorEl.clientHeight;
  if (overflow > 0) {
    const current = wrap.getBoundingClientRect().height;
    wrap.style.height = (current + overflow) + "px";
    updateEditorOverflowFade();
  }
});

function updateLineNumbers(source) {
  const lineCount = source ? source.split("\n").length : 1;
  let html = "";
  for (let i = 1; i <= lineCount; i++) {
    html += `<span class="ln" data-line="${i}">${i}</span>`;
  }
  lineNumbersEl.innerHTML = html;
}

function selectLine(lineNumber) {
  const content = editorEl.value;
  const lines = content.split("\n");
  if (lineNumber < 1 || lineNumber > lines.length) return;

  let start = 0;
  for (let i = 0; i < lineNumber - 1; i++) {
    start += lines[i].length + 1;
  }
  const end = start + lines[lineNumber - 1].length;

  editorEl.focus();
  editorEl.setSelectionRange(start, end);
}

lineNumbersEl.addEventListener("click", (event) => {
  const ln = event.target.closest(".ln");
  if (!ln) return;
  const lineNumber = parseInt(ln.dataset.line, 10);
  if (!isNaN(lineNumber)) {
    selectLine(lineNumber);
  }
});

lineNumbersEl.addEventListener("wheel", (event) => {
  editorEl.scrollTop += event.deltaY;
  editorEl.scrollLeft += event.deltaX;
  event.preventDefault();
}, { passive: false });

// Column guide
let colGuideCharWidth = 0;

function measureCharWidth() {
  const span = document.createElement("span");
  span.style.cssText = `
    position: absolute; visibility: hidden; white-space: pre;
    font-family: ${getComputedStyle(editorEl).fontFamily};
    font-size: ${getComputedStyle(editorEl).fontSize};
  `;
  span.textContent = "X".repeat(100);
  document.body.appendChild(span);
  colGuideCharWidth = span.offsetWidth / 100;
  span.remove();
}

function renderColumnGuide() {
  if (!colGuideCharWidth) measureCharWidth();
  const totalCols = 200;
  let html = "";
  for (let c = 1; c <= totalCols; c++) {
    const x = (c - 1) * colGuideCharWidth;
    if (c % 10 === 0) {
      html += `<span class="cg-num" style="left:${x - colGuideCharWidth * 1.5}px;width:${colGuideCharWidth * 3}px">${c}</span>`;
      html += `<span class="cg-tick major" style="left:${x}px"></span>`;
    } else if (c % 5 === 0) {
      html += `<span class="cg-tick major" style="left:${x}px"></span>`;
    } else {
      html += `<span class="cg-tick" style="left:${x}px"></span>`;
    }
  }
  colGuideEl.innerHTML = html;
}

function syncColGuideScroll() {
  colGuideEl.style.transform = `translateX(${-editorEl.scrollLeft}px)`;
  updateColGuideCursorPosition();
}

let lastCursorCol = 1;

function getCursorColumn() {
  const pos = editorEl.selectionStart;
  const text = editorEl.value;
  const lineStart = text.lastIndexOf("\n", pos - 1) + 1;
  return pos - lineStart + 1;
}

function updateColGuideCursorPosition() {
  if (colGuideWrapEl.classList.contains("collapsed")) return;
  if (!colGuideCharWidth) measureCharWidth();
  const x = (lastCursorCol - 1) * colGuideCharWidth - editorEl.scrollLeft;
  colGuideCursorEl.style.left = `calc(var(--gutter-width, 36px) + 12px + ${x}px)`;
}

function updateColGuideCursor() {
  if (colGuideWrapEl.classList.contains("collapsed")) return;
  lastCursorCol = getCursorColumn();
  colGuideCursorEl.textContent = lastCursorCol;
  colGuideCursorEl.hidden = false;
  updateColGuideCursorPosition();

  // Hide static numbers that would overlap with the cursor indicator
  const cursorDigits = String(lastCursorCol).length;
  colGuideEl.querySelectorAll(".cg-num").forEach((el) => {
    const staticCol = parseInt(el.textContent, 10);
    const staticDigits = String(staticCol).length;
    const minDist = (cursorDigits + staticDigits) / 2 + 1;
    el.style.visibility = Math.abs(lastCursorCol - staticCol) < minDist ? "hidden" : "";
  });
}

colGuideToggleEl.addEventListener("click", () => {
  const collapsed = colGuideWrapEl.classList.toggle("collapsed");
  localStorage.setItem("colGuideCollapsed", collapsed ? "1" : "0");
  if (!collapsed) updateColGuideCursor();
});

// Restore collapse state (default collapsed)
if (localStorage.getItem("colGuideCollapsed") === "0") {
  colGuideWrapEl.classList.remove("collapsed");
}

renderColumnGuide();

resultsEl.addEventListener("click", (event) => {
  const link = event.target.closest(".loc-link");
  if (!link) return;
  event.preventDefault();
  const fileName = link.dataset.file;
  const line = parseInt(link.dataset.line, 10);
  const col = link.dataset.col ? parseInt(link.dataset.col, 10) : 1;
  const fileIndex = state.files.findIndex((f) => f.name === fileName);
  if (fileIndex < 0) return;
  if (state.activeIndex !== fileIndex) {
    state.activeIndex = fileIndex;
    syncEditorFromState();
    renderTabs();
    saveState();
  }
  navigateToLine(line, col);
});

function refreshHighlight(content) {
  const file = activeFile();
  const source = typeof content === "string" ? content : file ? file.content : "";
  const filename = file ? file.name : "";
  highlightEl.innerHTML = renderHighlightedCode(source, filename);
  updateLineNumbers(source);
  syncHighlightScroll();
  updateEditorOverflowFade();
}

function renderTabs() {
  tabsEl.innerHTML = "";
  state.files.forEach((file, idx) => {
    const item = document.createElement("div");
    item.className = "tab-item";

    if (idx === state.renamingIndex) {
      const renameInput = document.createElement("input");
      renameInput.className = "tab tab-rename";
      renameInput.type = "text";
      renameInput.value = file.name;
      renameInput.spellcheck = false;
      renameInput.addEventListener("click", (event) => {
        event.stopPropagation();
      });
      renameInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          finishTabRename(idx, renameInput.value, true);
        } else if (event.key === "Escape") {
          event.preventDefault();
          cancelTabRename();
        }
      });
      renameInput.addEventListener("blur", () => {
        finishTabRename(idx, renameInput.value, false);
      });
      item.appendChild(renameInput);
      tabsEl.appendChild(item);
      requestAnimationFrame(() => {
        if (state.renamingIndex === idx) {
          renameInput.focus();
          renameInput.select();
        }
      });
      return;
    }

    const btn = document.createElement("button");
    btn.className = "tab tab-file" + (idx === state.activeIndex ? " active" : "");
    btn.textContent = file.name;
    btn.type = "button";
    btn.dataset.index = String(idx);
    btn.addEventListener("click", (event) => {
      if (state.renamingIndex >= 0 && state.renamingIndex !== idx) {
        cancelTabRename();
      }

      if (event.detail === 2) {
        startTabRename(idx);
        return;
      }

      if (state.activeIndex !== idx) {
        state.activeIndex = idx;
        saveState();
        syncEditorFromState();
        syncActiveTabClasses();
      } else {
        startTabRename(idx);
      }
    });
    btn.addEventListener("dblclick", (event) => {
      event.preventDefault();
      startTabRename(idx);
    });

    const removeBtn = document.createElement("button");
    removeBtn.className = "tab-icon tab-remove";
    removeBtn.type = "button";
    removeBtn.textContent = "×";
    const isPy = file.name.endsWith(".py") || file.name.endsWith(".pyi");
    const isLastPy = isPy && state.files.filter((f) => f.name.endsWith(".py") || f.name.endsWith(".pyi")).length <= 1;
    if (file.name === "pyproject.toml") {
      removeBtn.disabled = true;
      removeBtn.title = "pyproject.toml is required and cannot be removed";
    } else if (isLastPy) {
      removeBtn.disabled = true;
      removeBtn.title = "At least one Python file is required";
    } else if (state.files.length <= 1) {
      removeBtn.disabled = true;
      removeBtn.title = `Remove ${file.name}`;
    } else {
      removeBtn.disabled = false;
      removeBtn.title = `Remove ${file.name}`;
    }
    removeBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      removeFileAtIndex(idx);
    });

    // Drag-and-drop reordering
    item.draggable = true;
    item.addEventListener("dragstart", (event) => {
      draggedFileIndex = idx;
      item.classList.add("tab-dragging");
      event.dataTransfer.effectAllowed = "move";
    });
    item.addEventListener("dragend", () => {
      draggedFileIndex = null;
      item.classList.remove("tab-dragging");
      tabsEl.querySelectorAll(".tab-item").forEach((t) => {
        t.classList.remove("tab-drag-over-before", "tab-drag-over-after");
      });
    });
    item.addEventListener("dragover", (event) => {
      if (draggedFileIndex === null || draggedFileIndex === idx) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      const rect = item.getBoundingClientRect();
      const midX = rect.left + rect.width / 2;
      const before = event.clientX < midX;
      item.classList.toggle("tab-drag-over-before", before);
      item.classList.toggle("tab-drag-over-after", !before);
    });
    item.addEventListener("dragleave", () => {
      item.classList.remove("tab-drag-over-before", "tab-drag-over-after");
    });
    item.addEventListener("drop", (event) => {
      event.preventDefault();
      item.classList.remove("tab-drag-over-before", "tab-drag-over-after");
      if (draggedFileIndex === null || draggedFileIndex === idx) return;
      const rect = item.getBoundingClientRect();
      const midX = rect.left + rect.width / 2;
      const before = event.clientX < midX;
      const [movedFile] = state.files.splice(draggedFileIndex, 1);
      let toIndex = before ? idx : idx + 1;
      if (draggedFileIndex < idx) toIndex--;
      state.files.splice(toIndex, 0, movedFile);
      // Keep activeIndex pointing at the same file
      if (draggedFileIndex === state.activeIndex) {
        state.activeIndex = toIndex;
      } else if (draggedFileIndex < state.activeIndex && toIndex >= state.activeIndex) {
        state.activeIndex--;
      } else if (draggedFileIndex > state.activeIndex && toIndex <= state.activeIndex) {
        state.activeIndex++;
      }
      draggedFileIndex = null;
      saveState();
      renderTabs();
    });

    item.appendChild(btn);
    item.appendChild(removeBtn);
    tabsEl.appendChild(item);
  });

  const addBtn = document.createElement("button");
  addBtn.className = "tab-icon tab-add";
  addBtn.type = "button";
  addBtn.title = "Add file";
  addBtn.textContent = "+";
  addBtn.addEventListener("click", () => {
    addFile();
  });
  tabsEl.appendChild(addBtn);
}

function syncActiveTabClasses() {
  tabsEl.querySelectorAll("button.tab-file").forEach((node) => {
    const index = Number.parseInt(node.dataset.index || "-1", 10);
    node.classList.toggle("active", index === state.activeIndex);
  });
}

function syncEditorFromState() {
  const file = activeFile();
  editorEl.value = file ? file.content : "";
  editorEl.scrollTop = 0;
  editorEl.scrollLeft = 0;
  refreshHighlight(file ? file.content : "");
}

function normalizeName(name) {
  return name.trim().replace(/\\/g, "/");
}


function normalizeToolList(raw) {
  if (!Array.isArray(raw)) {
    return [];
  }

  const seen = new Set();
  const normalized = [];
  for (const item of raw) {
    if (typeof item !== "string") {
      continue;
    }
    const value = item.trim();
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    normalized.push(value);
  }
  return normalized;
}

function normalizePythonVersionOptions(raw) {
  if (!Array.isArray(raw)) {
    return DEFAULT_PYTHON_VERSION_OPTIONS.slice();
  }

  const seen = new Set();
  const normalized = [];
  for (const item of raw) {
    if (typeof item !== "string") {
      continue;
    }
    const value = item.trim();
    // Allow "" (meaning "not specified") but skip other falsy/duplicate values.
    if (value !== "" && !value) {
      continue;
    }
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    normalized.push(value);
  }

  return normalized.length > 0 ? normalized : DEFAULT_PYTHON_VERSION_OPTIONS.slice();
}

function normalizePythonVersion(raw, options = state.pythonVersionOptions) {
  const allowed = Array.isArray(options) && options.length > 0 ? options : DEFAULT_PYTHON_VERSION_OPTIONS;
  const fallback = allowed.includes(DEFAULT_PYTHON_VERSION) ? DEFAULT_PYTHON_VERSION : allowed[allowed.length - 1];
  if (typeof raw !== "string") {
    return fallback;
  }
  const value = raw.trim();
  return allowed.includes(value) ? value : fallback;
}

function setPythonVersionOptions(rawOptions) {
  state.pythonVersionOptions = normalizePythonVersionOptions(rawOptions);
  pythonVersionEl.innerHTML = "";

  state.pythonVersionOptions.forEach((version) => {
    const option = document.createElement("option");
    option.value = version;
    option.textContent = version || "not specified";
    if (version === "") {
      option.title = "Don't pass --python-version to type checkers; let each tool detect the version automatically";
    }
    pythonVersionEl.appendChild(option);
  });

  state.pythonVersion = normalizePythonVersion(state.pythonVersion, state.pythonVersionOptions);
  pythonVersionEl.value = state.pythonVersion;
}

function normalizeRuffRepoPath(raw) {
  return typeof raw === "string" ? raw.trim() : "";
}

function normalizeTyBinaryPath(raw) {
  return typeof raw === "string" ? raw.trim() : "";
}

function normalizePythonToolRepoPath(raw) {
  return typeof raw === "string" ? raw.trim() : "";
}

function normalizePythonToolRepoPaths(raw) {
  const normalized = {};
  if (!raw || typeof raw !== "object") {
    return normalized;
  }

  PYTHON_LOCAL_TOOLS.forEach((tool) => {
    const value = normalizePythonToolRepoPath(raw[tool]);
    if (value) {
      normalized[tool] = value;
    }
  });
  return normalized;
}

function pythonToolRepoPathForTool(tool) {
  const value = state.pythonToolRepoPaths[tool];
  return typeof value === "string" ? value : "";
}

function pythonToolRepoPathsPayload() {
  const payload = {};
  PYTHON_LOCAL_TOOLS.forEach((tool) => {
    const value = pythonToolRepoPathForTool(tool);
    if (value) {
      payload[tool] = value;
    }
  });
  return payload;
}

function toolLabel(tool) {
  if (tool === RUFF_TY_TOOL) {
    const checkoutPath = normalizeRuffRepoPath(state.ruffRepoPath);
    return checkoutPath ? `ty (${checkoutPath})` : "ty (local checkout)";
  }
  if (tool === "ty" && state.tyBinaryPath) {
    return `ty (${state.tyBinaryPath})`;
  }
  const localPythonToolPath = pythonToolRepoPathForTool(tool);
  if (localPythonToolPath) {
    return `${tool} (${localPythonToolPath})`;
  }
  return tool;
}

function syncRuffToolPresence() {
  const hasRuffPath = state.ruffRepoPath.length > 0;
  const hasRuffTool = toolOrder.includes(RUFF_TY_TOOL);

  if (hasRuffPath && !hasRuffTool) {
    const tyIndex = toolOrder.indexOf("ty");
    const insertIndex = tyIndex >= 0 ? tyIndex + 1 : 0;
    toolOrder.splice(insertIndex, 0, RUFF_TY_TOOL);
  } else if (!hasRuffPath && hasRuffTool) {
    toolOrder = toolOrder.filter((tool) => tool !== RUFF_TY_TOOL);
    delete state.toolSettings[RUFF_TY_TOOL];
    delete state.lastResults[RUFF_TY_TOOL];
  }
}

function ensureToolSettings() {
  syncRuffToolPresence();
  const next = {};
  toolOrder.forEach((tool) => {
    const existing = state.toolSettings[tool];
    next[tool] = {
      enabled: !existing || existing.enabled !== false,
      collapsed: !!(existing && existing.collapsed),
    };
  });
  state.toolSettings = next;
}

function enabledTools() {
  return toolOrder.filter((tool) => {
    const settings = state.toolSettings[tool];
    return !settings || settings.enabled !== false;
  });
}


function updatePythonVersionFromInput({ triggerAnalyze = false } = {}) {
  const normalized = normalizePythonVersion(pythonVersionEl.value, state.pythonVersionOptions);
  pythonVersionEl.value = normalized;
  if (normalized === state.pythonVersion) {
    return;
  }
  state.pythonVersion = normalized;
  if (triggerAnalyze) {
    scheduleAnalyze();
  }
}

function updateRuffRepoPathFromInput({ triggerAnalyze, writeBack = true } = { triggerAnalyze: false }) {
  const normalized = normalizeRuffRepoPath(ruffRepoPathEl.value);
  if (writeBack) {
    ruffRepoPathEl.value = normalized;
  }
  if (normalized === state.ruffRepoPath) {
    return;
  }

  state.ruffRepoPath = normalized;
  ensureToolSettings();
  renderResults(state.lastResults);
  startRuffDirWatcher();

  if (triggerAnalyze) {
    scheduleAnalyze();
  }
}

function updateTyBinaryPathFromInput({ triggerAnalyze, writeBack = true } = { triggerAnalyze: false }) {
  const normalized = normalizeTyBinaryPath(tyBinaryPathEl.value);
  if (writeBack) {
    tyBinaryPathEl.value = normalized;
  }
  if (normalized === state.tyBinaryPath) {
    return;
  }

  state.tyBinaryPath = normalized;
  state.resolvedTyBinaryPath = null;
  syncTyBinaryPathNote();
  saveState();
  renderResults(state.lastResults);

  if (triggerAnalyze) {
    scheduleAnalyze();
  }
}

function updatePythonToolRepoPathFromInput(tool, inputEl, { triggerAnalyze, writeBack = true } = { triggerAnalyze: false }) {
  const normalized = normalizePythonToolRepoPath(inputEl.value);
  if (writeBack) {
    inputEl.value = normalized;
  }

  const previous = pythonToolRepoPathForTool(tool);
  if (normalized === previous) {
    return;
  }

  if (normalized) {
    state.pythonToolRepoPaths[tool] = normalized;
  } else {
    delete state.pythonToolRepoPaths[tool];
  }
  renderResults(state.lastResults);

  if (triggerAnalyze) {
    scheduleAnalyze();
  }
}

function isUniqueName(name, ignoreIndex) {
  return !state.files.some((f, idx) => idx !== ignoreIndex && f.name === name);
}

function scheduleAnalyze({ onlyTools } = {}) {
  saveState();
  if (state.debounceTimer) {
    clearTimeout(state.debounceTimer);
    // Merge with pending debounced call: if either is a full run, do full.
    if (!onlyTools || !state.pendingOnlyTools) {
      onlyTools = undefined;
    } else {
      onlyTools = [...new Set([...state.pendingOnlyTools, ...onlyTools])];
    }
  }
  state.pendingOnlyTools = onlyTools;
  state.debounceTimer = setTimeout(() => {
    const pending = state.pendingOnlyTools;
    state.pendingOnlyTools = undefined;
    state.debounceTimer = null;
    analyze({ onlyTools: pending });
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

function startTabRename(index) {
  if (index < 0 || index >= state.files.length) {
    return;
  }
  if (state.files[index].name === "pyproject.toml") {
    return;
  }
  state.activeIndex = index;
  state.renamingIndex = index;
  syncEditorFromState();
  renderTabs();
}

function cancelTabRename() {
  if (state.renamingIndex < 0) {
    return;
  }
  state.renamingIndex = -1;
  renderTabs();
}

function finishTabRename(index, rawName, keepOpenOnError) {
  if (state.renamingIndex !== index) {
    return true;
  }

  const file = state.files[index];
  if (!file) {
    state.renamingIndex = -1;
    renderTabs();
    return false;
  }

  const normalized = normalizeName(rawName);
  if (!normalized) {
    setStatus("Filename cannot be empty");
    if (keepOpenOnError) {
      return false;
    }
    state.renamingIndex = -1;
    renderTabs();
    return false;
  }

  if (!isUniqueName(normalized, index)) {
    setStatus("Duplicate filename: " + normalized);
    if (keepOpenOnError) {
      return false;
    }
    state.renamingIndex = -1;
    renderTabs();
    return false;
  }

  const changed = normalized !== file.name;
  file.name = normalized;
  state.renamingIndex = -1;
  renderTabs();
  refreshHighlight();
  if (changed) {
    scheduleAnalyze();
  }
  return true;
}

function renderResults(resultByTool) {
  resultsEl.innerHTML = "";
  ensureToolSettings();

  toolOrder.forEach((tool) => {
    const settings = state.toolSettings[tool];
    const enabled = !settings || settings.enabled !== false;
    const collapsed = !!(settings && settings.collapsed);
    const result = resultByTool[tool] || {};

    const card = document.createElement("section");
    card.className = "result-card";
    card.dataset.tool = tool;
    if (!enabled) {
      card.classList.add("tool-disabled");
    }
    if (collapsed) {
      card.classList.add("collapsed");
    }

    card.addEventListener("dragover", (event) => {
      if (draggedTool === null || draggedTool === tool) {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      const rect = card.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      const above = event.clientY < midY;
      card.classList.toggle("drag-over-above", above);
      card.classList.toggle("drag-over-below", !above);
    });

    card.addEventListener("dragleave", () => {
      card.classList.remove("drag-over-above", "drag-over-below");
    });

    card.addEventListener("drop", (event) => {
      event.preventDefault();
      card.classList.remove("drag-over-above", "drag-over-below");
      if (draggedTool === null || draggedTool === tool) {
        return;
      }
      const fromIndex = toolOrder.indexOf(draggedTool);
      if (fromIndex < 0) {
        return;
      }
      toolOrder.splice(fromIndex, 1);
      let toIndex = toolOrder.indexOf(tool);
      const rect = card.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      if (event.clientY >= midY) {
        toIndex += 1;
      }
      toolOrder.splice(toIndex, 0, draggedTool);
      draggedTool = null;
      saveState();
      renderResults(state.lastResults);
    });

    const header = document.createElement("div");
    header.className = "result-header";
    header.draggable = true;

    header.addEventListener("mouseover", (event) => {
      const overText =
        event.target !== header &&
        event.target !== grip &&
        !event.target.classList.contains("result-header");
      header.draggable = !overText;
    });
    header.addEventListener("mouseout", () => {
      header.draggable = true;
    });

    header.addEventListener("click", (event) => {
      const overText =
        event.target !== header &&
        event.target !== grip &&
        !event.target.classList.contains("result-header");
      if (overText) return;
      const current = state.toolSettings[tool];
      if (!current) return;
      current.collapsed = !current.collapsed;
      saveState();
      renderResults(state.lastResults);
    });

    header.addEventListener("dragstart", (event) => {
      draggedTool = tool;
      card.classList.add("dragging");
      event.dataTransfer.effectAllowed = "move";
    });

    header.addEventListener("dragend", () => {
      draggedTool = null;
      card.classList.remove("dragging");
      resultsEl.querySelectorAll(".result-card").forEach((c) => {
        c.classList.remove("drag-over-above", "drag-over-below");
      });
    });

    const grip = document.createElement("span");
    grip.className = "drag-grip";
    grip.textContent = "\u2261";
    header.appendChild(grip);

    const titleWrap = document.createElement("div");
    titleWrap.className = "result-title-wrap";

    const title = document.createElement("strong");
    const displayName = toolLabel(tool);
    const localPythonToolPath = pythonToolRepoPathForTool(tool);
    const suppressVersion = localPythonToolPath || (tool === "ty" && state.tyBinaryPath);
    const version = suppressVersion ? "" : state.toolVersions[tool];
    title.textContent =
      typeof version === "string" && version && version !== "unknown"
        ? `${displayName} v${version}`
        : `${displayName}`;
    titleWrap.appendChild(title);

    const right = document.createElement("div");
    right.className = "result-header-right";

    const meta = document.createElement("span");
    meta.className = "meta";
    if (!enabled) {
      meta.textContent = "disabled";
    } else if (typeof result.returncode === "number") {
      const code = result.returncode;
      const ms = typeof result.duration_ms === "number" ? result.duration_ms : 0;
      meta.textContent = "exit " + code + " | " + ms + "ms";
    } else {
      meta.textContent = "pending";
      meta.classList.add("meta-pending");
    }

    const toggleBtn = document.createElement("button");
    toggleBtn.type = "button";
    toggleBtn.className = "tool-toggle " + (enabled ? "enabled" : "disabled");
    toggleBtn.textContent = enabled ? "On" : "Off";
    toggleBtn.title = enabled ? `Turn off ${displayName}` : `Turn on ${displayName}`;
    toggleBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const current = state.toolSettings[tool];
      if (!current) {
        return;
      }
      const wasEnabled = current.enabled !== false;
      current.enabled = !wasEnabled;
      if (!current.enabled) {
        current.collapsed = true;
        delete state.lastResults[tool];
      } else {
        current.collapsed = false;
      }
      saveState();
      renderResults(state.lastResults);
      if (current.enabled) {
        scheduleAnalyze({ onlyTools: [tool] });
      }
    });

    const collapseBtn = document.createElement("button");
    collapseBtn.type = "button";
    collapseBtn.className = "tool-collapse";
    collapseBtn.textContent = collapsed ? "▼" : "▲";
    collapseBtn.title = collapsed ? `Show ${displayName} output` : `Hide ${displayName} output`;
    collapseBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const current = state.toolSettings[tool];
      if (!current) {
        return;
      }
      current.collapsed = !current.collapsed;
      saveState();
      renderResults(state.lastResults);
    });

    const configSection = toolConfigSection(tool);
    let configureBtn = null;
    if (configSection) {
      configureBtn = document.createElement("button");
      configureBtn.type = "button";
      configureBtn.className = "tool-configure";
      configureBtn.textContent = "Configure";
      configureBtn.title = `Open ${configSection} in pyproject.toml`;
      configureBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        openConfigFile(tool);
      });
    }

    const docsUrl = TOOL_DOCS_URL[tool];
    let docsBtn = null;
    if (docsUrl) {
      docsBtn = document.createElement("button");
      docsBtn.type = "button";
      docsBtn.className = "tool-docs";
      docsBtn.textContent = "Docs";
      docsBtn.title = `Open ${displayName} configuration docs`;
      docsBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        window.open(docsUrl, "_blank", "noopener");
      });
    }

    right.appendChild(meta);
    right.appendChild(toggleBtn);
    if (configureBtn) {
      right.appendChild(configureBtn);
    }
    if (docsBtn) {
      right.appendChild(docsBtn);
    }
    right.appendChild(collapseBtn);
    header.appendChild(titleWrap);
    header.appendChild(right);

    const pre = document.createElement("pre");
    if (!enabled) {
      pre.textContent = "Tool is turned off for this analysis.";
    } else {
      const output = typeof result.output === "string" ? result.output : "";
      let visible = output;
      let truncated = false;
      let truncMsg = "";
      const lines = output.split("\n");
      if (lines.length > OUTPUT_MAX_LINES) {
        visible = lines.slice(0, OUTPUT_MAX_LINES).join("\n");
        truncated = true;
        truncMsg = `Output truncated (showing ${OUTPUT_MAX_LINES} of ${lines.length} lines). Click to show all.`;
      }
      if (visible.length > OUTPUT_MAX_CHARS) {
        visible = visible.slice(0, OUTPUT_MAX_CHARS);
        truncated = true;
        truncMsg = `Output truncated (showing ~${Math.round(OUTPUT_MAX_CHARS / 1000)}k of ${Math.round(output.length / 1000)}k chars). Click to show all.`;
      }
      pre.innerHTML = linkifyLocations(ansiToHtml(visible));
      if (truncated) {
        const notice = document.createElement("div");
        notice.className = "truncation-notice";
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = truncMsg;
        btn.addEventListener("click", () => {
          pre.innerHTML = linkifyLocations(ansiToHtml(output));
          notice.remove();
        });
        notice.appendChild(btn);
        pre.appendChild(notice);
      }
    }

    const resizeHandle = document.createElement("div");
    resizeHandle.className = "resize-handle";
    initCardResize(resizeHandle, card);

    card.appendChild(header);
    card.appendChild(pre);
    card.appendChild(resizeHandle);
    resultsEl.appendChild(card);
  });
}

function handleMetadataMessage(msg) {
  if (Array.isArray(msg.python_versions)) {
    setPythonVersionOptions(msg.python_versions);
  }
  if (typeof msg.python_version === "string") {
    state.pythonVersion = normalizePythonVersion(msg.python_version, state.pythonVersionOptions);
    pythonVersionEl.value = state.pythonVersion;
  }
  if (msg.tool_versions && typeof msg.tool_versions === "object") {
    state.toolVersions = { ...state.toolVersions, ...msg.tool_versions };
  }
  if (Array.isArray(msg.tool_order) && msg.tool_order.length > 0) {
    const serverOrder = normalizeToolList(msg.tool_order);
    const serverSet = new Set(serverOrder);
    const merged = toolOrder.filter((t) => serverSet.has(t));
    const mergedSet = new Set(merged);
    for (const t of serverOrder) {
      if (!mergedSet.has(t)) {
        merged.push(t);
      }
    }
    toolOrder = merged;
  }
  if (typeof msg.ruff_repo_path === "string") {
    state.ruffRepoPath = normalizeRuffRepoPath(msg.ruff_repo_path);
  }
  if (typeof msg.ty_binary_path === "string") {
    state.resolvedTyBinaryPath = msg.ty_binary_path;
    syncTyBinaryPathNote();
  }
  if (msg.python_tool_repo_paths && typeof msg.python_tool_repo_paths === "object") {
    state.pythonToolRepoPaths = normalizePythonToolRepoPaths(msg.python_tool_repo_paths);
  }
  ensureToolSettings();
  // For partial runs (e.g. toggling a single tool on), the server only knows
  // about the subset we sent — don't let its enabled_tools list overwrite the
  // client-side state for the tools we didn't send.
  if (!state.currentOnlyTools && Array.isArray(msg.enabled_tools)) {
    const enabledSet = new Set(normalizeToolList(msg.enabled_tools));
    toolOrder.forEach((tool) => {
      const settings = state.toolSettings[tool];
      if (settings) {
        settings.enabled = enabledSet.has(tool);
      }
    });
  }
  if (typeof msg.temp_dir === "string" && msg.temp_dir) {
    setTempDir("Temp directory: " + msg.temp_dir);
  }

  if (state.currentOnlyTools) {
    // Partial run: only clear results for the tools being re-analyzed.
    for (const tool of state.currentOnlyTools) {
      delete state.lastResults[tool];
    }
    resetSpecificCardsToPending(state.currentOnlyTools);
  } else {
    state.lastResults = {};

    // Avoid a full DOM rebuild if the tool list hasn't changed — just reset
    // each card to "pending" status in place, which is much cheaper.
    // Compare against the DOM cards (not prevToolOrder) because localStorage
    // restore may have added tools after the initial renderResults() call.
    const renderedTools = [...resultsEl.querySelectorAll(".result-card")].map(
      (c) => c.dataset.tool,
    );
    const toolListChanged =
      renderedTools.length !== toolOrder.length ||
      renderedTools.some((t, i) => t !== toolOrder[i]);

    if (toolListChanged) {
      renderResults(state.lastResults);
    } else {
      resetCardsToPending();
    }
  }
}

function resetCardsToPending() {
  resultsEl.querySelectorAll(".result-card").forEach((card) => {
    const tool = card.dataset.tool;
    const settings = state.toolSettings[tool];
    const enabled = !settings || settings.enabled !== false;

    card.classList.toggle("tool-disabled", !enabled);
    const collapsed = !!(settings && settings.collapsed);
    card.classList.toggle("collapsed", collapsed);

    const collapseBtn = card.querySelector(".tool-collapse");
    if (collapseBtn) {
      collapseBtn.textContent = collapsed ? "▼" : "▲";
    }

    const toggleBtn = card.querySelector(".tool-toggle");
    if (toggleBtn) {
      toggleBtn.className = "tool-toggle " + (enabled ? "enabled" : "disabled");
      toggleBtn.textContent = enabled ? "On" : "Off";
    }

    const meta = card.querySelector(".meta");
    if (meta) {
      if (!enabled) {
        meta.textContent = "disabled";
        meta.classList.remove("meta-pending");
      } else {
        meta.textContent = "pending";
        meta.classList.add("meta-pending");
      }
    }

    const pre = card.querySelector("pre");
    if (pre) {
      if (!enabled) {
        pre.textContent = "Tool is turned off for this analysis.";
      } else {
        pre.textContent = "";
      }
    }
  });
}

function resetSpecificCardsToPending(tools) {
  const toolSet = new Set(tools);
  resultsEl.querySelectorAll(".result-card").forEach((card) => {
    if (!toolSet.has(card.dataset.tool)) return;

    card.classList.remove("tool-disabled");

    const meta = card.querySelector(".meta");
    if (meta) {
      meta.textContent = "pending";
      meta.classList.add("meta-pending");
    }

    const pre = card.querySelector("pre");
    if (pre) {
      pre.textContent = "";
    }
  });
}

function handleResultMessage(msg) {
  state.lastResults[msg.tool] = msg.data;
  updateResultCard(msg.tool, msg.data);
}

function handleDoneMessage() {
  setStatus("Last analysis: " + new Date().toLocaleTimeString());
}

function updateResultCard(tool, result) {
  const card = resultsEl.querySelector(`[data-tool="${tool}"]`);
  if (!card) return;

  const meta = card.querySelector(".meta");
  if (meta) {
    meta.classList.remove("meta-pending");
    const settings = state.toolSettings[tool];
    const enabled = !settings || settings.enabled !== false;
    if (!enabled) {
      meta.textContent = "disabled";
    } else if (typeof result.returncode === "number") {
      const code = result.returncode;
      const ms = typeof result.duration_ms === "number" ? result.duration_ms : 0;
      meta.textContent = "exit " + code + " | " + ms + "ms";
    }
  }

  const pre = card.querySelector("pre");
  if (pre) {
    const settings = state.toolSettings[tool];
    const enabled = !settings || settings.enabled !== false;
    if (!enabled) {
      pre.textContent = "Tool is turned off for this analysis.";
    } else {
      const output = typeof result.output === "string" ? result.output : "";
      let visible = output;
      let truncated = false;
      let truncMsg = "";
      const lines = output.split("\n");
      if (lines.length > OUTPUT_MAX_LINES) {
        visible = lines.slice(0, OUTPUT_MAX_LINES).join("\n");
        truncated = true;
        truncMsg = `Output truncated (showing ${OUTPUT_MAX_LINES} of ${lines.length} lines). Click to show all.`;
      }
      if (visible.length > OUTPUT_MAX_CHARS) {
        visible = visible.slice(0, OUTPUT_MAX_CHARS);
        truncated = true;
        truncMsg = `Output truncated (showing ~${Math.round(OUTPUT_MAX_CHARS / 1000)}k of ${Math.round(output.length / 1000)}k chars). Click to show all.`;
      }
      pre.innerHTML = linkifyLocations(ansiToHtml(visible));
      if (truncated) {
        const notice = document.createElement("div");
        notice.className = "truncation-notice";
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = truncMsg;
        btn.addEventListener("click", () => {
          pre.innerHTML = linkifyLocations(ansiToHtml(output));
          notice.remove();
        });
        notice.appendChild(btn);
        pre.appendChild(notice);
      }
    }
  }
}

async function analyze({ onlyTools } = {}) {
  const requestId = ++state.requestNumber;
  setStatus("Analyzing...");

  // Abort previous in-flight request
  if (state.currentController) {
    state.currentController.abort();
  }
  const controller = new AbortController();
  state.currentController = controller;
  state.currentOnlyTools = onlyTools || null;

  const toolsToSend = onlyTools || enabledTools();
  const payload = {
    files: state.files.map((f) => ({ name: f.name, content: f.content })),
    python_version: state.pythonVersion,
    ruff_repo_path: state.ruffRepoPath,
    ty_binary_path: state.tyBinaryPath,
    python_tool_repo_paths: pythonToolRepoPathsPayload(),
    enabled_tools: toolsToSend,
  };

  try {
    const resp = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (requestId < state.latestHandledRequest) {
      return;
    }
    state.latestHandledRequest = requestId;

    const contentType = resp.headers.get("Content-Type") || "";

    // Error path: regular JSON response
    if (!resp.ok || contentType.includes("application/json")) {
      const body = await resp.json();
      if (!resp.ok) {
        if (body?.error_type === "dependency_install_failed" && body?.dependency_install) {
          showDependencyInstallError(body.dependency_install);
          setStatus("Dependency install failed");
          return;
        }
        clearDependencyInstallError();
        setStatus("Request failed: " + (body.error || resp.status));
        return;
      }
    }

    clearDependencyInstallError();

    // NDJSON streaming path
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      // Keep the last (possibly incomplete) chunk in the buffer
      buffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let msg;
        try {
          msg = JSON.parse(trimmed);
        } catch {
          continue;
        }

        if (msg.type === "metadata") {
          handleMetadataMessage(msg);
        } else if (msg.type === "result") {
          handleResultMessage(msg);
        } else if (msg.type === "done") {
          handleDoneMessage();
        }
      }
    }

    // Process any remaining buffer
    if (buffer.trim()) {
      try {
        const msg = JSON.parse(buffer.trim());
        if (msg.type === "metadata") {
          handleMetadataMessage(msg);
        } else if (msg.type === "result") {
          handleResultMessage(msg);
        } else if (msg.type === "done") {
          handleDoneMessage();
        }
      } catch {
        // Incomplete JSON at end of stream, ignore
      }
    }
  } catch (err) {
    if (err.name === "AbortError") {
      return;
    }
    clearDependencyInstallError();
    setStatus("Error: " + err.message);
  } finally {
    if (state.currentController === controller) {
      state.currentController = null;
      state.currentOnlyTools = null;
    }
  }
}

const TOOL_DEFAULT_CONFIG = {
  ty: '[tool.ty.rules]\nundefined-reveal = "ignore"',
  pyright:
    "reportWildcardImportFromLibrary = false\nreportSelfClsParameterName = false\nreportUnusedExpression = false",
  mypy: "color_output = true\npretty = true\ncheck_untyped_defs = true",
  zuban: "pretty = true\ncheck_untyped_defs = true",
};

function buildPyprojectContent() {
  const projectSection = '[project]\nname = "sandbox"\nversion = "0.1.0"\nrequires-python = ">=3.10"\ndependencies = []';
  const seen = new Set();
  const withDefaults = [];
  const withoutDefaults = [];
  for (const name of toolOrder) {
    const header = toolConfigSection(name);
    if (!seen.has(header)) {
      seen.add(header);
      const defaults = TOOL_DEFAULT_CONFIG[name] || "";
      if (defaults) {
        withDefaults.push(`${header}\n${defaults}`);
      } else {
        withoutDefaults.push(header);
      }
    }
  }
  const sections = [...withDefaults, ...withoutDefaults];
  return projectSection + "\n\n\n" + sections.join("\n\n\n") + "\n";
}

/** Fill in empty pyproject.toml content in state.files using current toolOrder. */
function populateDefaultPyprojectToml() {
  const pyproj = state.files.find((f) => f.name === "pyproject.toml");
  if (pyproj && !pyproj.content) {
    pyproj.content = buildPyprojectContent();
  }
}

function openConfigFile(tool) {
  const section = toolConfigSection(tool);
  if (!section) return;

  if (state.renamingIndex >= 0) {
    cancelTabRename();
  }

  const existingIndex = state.files.findIndex((f) => f.name === "pyproject.toml");
  if (existingIndex >= 0) {
    state.activeIndex = existingIndex;
  } else {
    state.files.push({ name: "pyproject.toml", content: buildPyprojectContent() });
    state.activeIndex = state.files.length - 1;
  }

  renderTabs();
  syncEditorFromState();

  // Place the cursor at the end of the [tool.<name>] header line.
  const content = editorEl.value;
  const sectionIndex = content.indexOf(section);
  if (sectionIndex >= 0) {
    let cursorPos = sectionIndex + section.length;
    if (content[cursorPos] === "\n") cursorPos++;
    editorEl.focus();
    editorEl.setSelectionRange(cursorPos, cursorPos);
  } else {
    editorEl.focus();
  }

  scheduleAnalyze();
}

function addFile() {
  if (state.renamingIndex >= 0) {
    cancelTabRename();
  }

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
}

function removeFileAtIndex(index) {
  if (state.files.length <= 1) {
    return;
  }

  const removedActive = state.activeIndex === index;
  state.files.splice(index, 1);

  if (state.renamingIndex === index) {
    state.renamingIndex = -1;
  } else if (state.renamingIndex > index) {
    state.renamingIndex -= 1;
  }

  if (removedActive) {
    state.activeIndex = Math.max(0, index - 1);
  } else if (state.activeIndex > index) {
    state.activeIndex -= 1;
  }

  renderTabs();
  syncEditorFromState();
  scheduleAnalyze();
}

function isPythonFile() {
  const file = activeFile();
  if (!file) return false;
  const ext = extensionOf(file.name);
  return ext === ".py" || ext === ".pyi";
}

function bindEvents() {
  editorEl.addEventListener("input", (event) => {
    const content = event.target.value;
    refreshHighlight(content);
    updateActiveFileContent(content);
    updateColGuideCursor();
  });

  editorEl.addEventListener("keydown", (event) => {
    if (!isPythonFile()) return;

    // Tab / Shift+Tab: indent or dedent selected lines
    if (event.key === "Tab") {
      const val = editorEl.value;
      const start = editorEl.selectionStart;
      const end = editorEl.selectionEnd;

      // Find the start of the first selected line and end of the last
      const blockStart = val.lastIndexOf("\n", start - 1) + 1;
      const blockEnd = val.indexOf("\n", end - (end > start && val[end - 1] === "\n" ? 1 : 0));
      const blockEndFinal = blockEnd < 0 ? val.length : blockEnd;
      const block = val.slice(blockStart, blockEndFinal);
      const lines = block.split("\n");

      let newLines;
      let deltaFirst = 0; // change in length of first line (for selectionStart adjustment)
      let deltaTotal = 0; // total change in length (for selectionEnd adjustment)

      if (event.shiftKey) {
        // Dedent: remove up to 4 leading spaces (or one tab) from each line
        newLines = lines.map((line, i) => {
          const m = line.match(/^( {1,4}|\t)/);
          const removed = m ? m[0].length : 0;
          if (i === 0) deltaFirst = -removed;
          deltaTotal -= removed;
          return removed > 0 ? line.slice(removed) : line;
        });
      } else {
        // Indent: add 4 spaces to the start of each line
        newLines = lines.map((line, i) => {
          if (i === 0) deltaFirst = 4;
          deltaTotal += 4;
          return "    " + line;
        });
      }

      event.preventDefault();
      const newBlock = newLines.join("\n");

      // Replace the block range by selecting it, then using execCommand for undo support
      editorEl.setSelectionRange(blockStart, blockEndFinal);
      document.execCommand("insertText", false, newBlock);

      // Restore selection over the modified lines
      const newStart = Math.max(blockStart, start + deltaFirst);
      const newEnd = Math.max(newStart, end + deltaTotal);
      editorEl.setSelectionRange(newStart, newEnd);
      return;
    }

    // Enter: autoindent
    if (event.key === "Enter") {
      const val = editorEl.value;
      const pos = editorEl.selectionStart;

      // Find the current line (text from the previous newline up to cursor)
      const lineStart = val.lastIndexOf("\n", pos - 1) + 1;
      const lineText = val.slice(lineStart, pos);

      // Current line's leading whitespace
      const indentMatch = lineText.match(/^[ \t]*/);
      const currentIndent = indentMatch ? indentMatch[0] : "";

      // Determine the stripped line content (ignoring comments)
      const stripped = lineText.replace(/#.*$/, "").trimEnd();

      let newIndent = currentIndent;
      if (stripped.endsWith(":")) {
        // Increase indent after colon (def, class, if, for, while, with, try, etc.)
        newIndent = currentIndent + "    ";
      } else if (/^[ \t]*(return|break|continue|pass|raise)\b/.test(lineText)) {
        // Dedent after block-terminating keywords
        if (currentIndent.length >= 4) {
          newIndent = currentIndent.slice(4);
        } else {
          newIndent = "";
        }
      }

      event.preventDefault();
      const insertion = "\n" + newIndent;
      // Use execCommand so the insertion is undoable (Ctrl+Z)
      document.execCommand("insertText", false, insertion);
    }
  });

  editorEl.addEventListener("scroll", () => {
    syncHighlightScroll();
    updateEditorOverflowFade();
  });

  editorEl.addEventListener("keyup", updateColGuideCursor);
  editorEl.addEventListener("click", updateColGuideCursor);
  editorEl.addEventListener("select", updateColGuideCursor);

  pythonVersionEl.addEventListener("change", () => {
    updatePythonVersionFromInput({ triggerAnalyze: true });
  });

  pythonVersionEl.addEventListener("blur", () => {
    updatePythonVersionFromInput({ triggerAnalyze: true });
  });

  ruffRepoPathEl.addEventListener("input", () => {
    updateRuffRepoPathFromInput({ triggerAnalyze: true, writeBack: false });
  });

  ruffRepoPathEl.addEventListener("change", () => {
    updateRuffRepoPathFromInput({ triggerAnalyze: true });
  });

  ruffRepoPathEl.addEventListener("blur", () => {
    updateRuffRepoPathFromInput({ triggerAnalyze: true });
  });

  tyBinaryPathEl.addEventListener("input", () => {
    updateTyBinaryPathFromInput({ triggerAnalyze: true, writeBack: false });
  });

  tyBinaryPathEl.addEventListener("change", () => {
    updateTyBinaryPathFromInput({ triggerAnalyze: true });
  });

  tyBinaryPathEl.addEventListener("blur", () => {
    updateTyBinaryPathFromInput({ triggerAnalyze: true });
  });

  mypyRepoPathEl.addEventListener("input", () => {
    updatePythonToolRepoPathFromInput("mypy", mypyRepoPathEl, { triggerAnalyze: true, writeBack: false });
  });

  mypyRepoPathEl.addEventListener("change", () => {
    updatePythonToolRepoPathFromInput("mypy", mypyRepoPathEl, { triggerAnalyze: true });
  });

  mypyRepoPathEl.addEventListener("blur", () => {
    updatePythonToolRepoPathFromInput("mypy", mypyRepoPathEl, { triggerAnalyze: true });
  });

  pycroscopeRepoPathEl.addEventListener("input", () => {
    updatePythonToolRepoPathFromInput("pycroscope", pycroscopeRepoPathEl, { triggerAnalyze: true, writeBack: false });
  });

  pycroscopeRepoPathEl.addEventListener("change", () => {
    updatePythonToolRepoPathFromInput("pycroscope", pycroscopeRepoPathEl, { triggerAnalyze: true });
  });

  pycroscopeRepoPathEl.addEventListener("blur", () => {
    updatePythonToolRepoPathFromInput("pycroscope", pycroscopeRepoPathEl, { triggerAnalyze: true });
  });
}

function loadFromBootstrap(body) {
  clearDependencyInstallError();
  setPythonVersionOptions(body.python_versions);
  const files = Array.isArray(body.initial_files) ? body.initial_files : [];
  const normalizedFiles = files
    .filter((f) => f && typeof f.name === "string" && typeof f.content === "string")
    .map((f) => ({ name: f.name, content: f.content }));

  state.files = normalizedFiles.length > 0 ? normalizedFiles : DEFAULT_FILES.slice();
  state.activeIndex = 0;

  const bootstrapToolOrder = normalizeToolList(body.tool_order);
  if (bootstrapToolOrder.length > 0) {
    toolOrder = bootstrapToolOrder;
  } else {
    toolOrder = DEFAULT_TOOL_ORDER.slice();
  }

  if (typeof body.initial_ruff_repo_path === "string") {
    state.ruffRepoPath = normalizeRuffRepoPath(body.initial_ruff_repo_path);
  } else {
    state.ruffRepoPath = "";
  }
  if (typeof body.initial_ty_binary_path === "string") {
    state.tyBinaryPath = normalizeTyBinaryPath(body.initial_ty_binary_path);
  } else {
    state.tyBinaryPath = "";
  }
  if (body.initial_python_tool_repo_paths && typeof body.initial_python_tool_repo_paths === "object") {
    state.pythonToolRepoPaths = normalizePythonToolRepoPaths(body.initial_python_tool_repo_paths);
  } else {
    state.pythonToolRepoPaths = {};
  }
  ruffRepoPathEl.value = state.ruffRepoPath;
  tyBinaryPathEl.value = state.tyBinaryPath;
  mypyRepoPathEl.value = pythonToolRepoPathForTool("mypy");
  pycroscopeRepoPathEl.value = pythonToolRepoPathForTool("pycroscope");
  ensureToolSettings();

  if (Array.isArray(body.enabled_tools)) {
    const enabledSet = new Set(normalizeToolList(body.enabled_tools));
    toolOrder.forEach((tool) => {
      const settings = state.toolSettings[tool];
      if (settings) {
        settings.enabled = enabledSet.has(tool);
      }
    });
  }

  if (body.tool_versions && typeof body.tool_versions === "object") {
    state.toolVersions = { ...body.tool_versions };
  } else {
    state.toolVersions = {};
  }

  state.pythonVersion = normalizePythonVersion(body.initial_python_version, state.pythonVersionOptions);
  pythonVersionEl.value = state.pythonVersion;

  if (typeof body.temp_dir === "string" && body.temp_dir) {
    setTempDir("Temp directory: " + body.temp_dir);
  }

  state.lastResults = {};
  populateDefaultPyprojectToml();
}

function showRestoredOptionsToast() {
  const restored = [];
  // Check if pyproject.toml has non-empty dependencies
  const pyproj = state.files.find((f) => f.name === "pyproject.toml");
  if (pyproj && pyproj.content) {
    const depsMatch = pyproj.content.match(/^dependencies\s*=\s*\[([^\]]*)\]/m);
    if (depsMatch && depsMatch[1].trim()) {
      restored.push("Dependencies (in pyproject.toml): " + depsMatch[1].trim());
    }
  }
  if (state.tyBinaryPath) {
    restored.push("Custom ty binary: " + state.tyBinaryPath);
  }
  if (state.ruffRepoPath) {
    restored.push("Local Ruff clone: " + state.ruffRepoPath);
  }
  PYTHON_LOCAL_TOOLS.forEach((tool) => {
    const path = pythonToolRepoPathForTool(tool);
    if (path) {
      const label = tool.charAt(0).toUpperCase() + tool.slice(1);
      restored.push("Local " + label + " checkout: " + path);
    }
  });
  if (restored.length === 0) return;

  const toast = document.createElement("div");
  toast.className = "restored-toast";
  toast.setAttribute("role", "status");

  const heading = document.createElement("div");
  heading.className = "restored-toast-heading";
  heading.textContent = "Settings restored from previous session";
  toast.appendChild(heading);

  const list = document.createElement("ul");
  list.className = "restored-toast-list";
  restored.forEach((item) => {
    const li = document.createElement("li");
    li.textContent = item;
    list.appendChild(li);
  });
  toast.appendChild(list);

  document.body.appendChild(toast);

  // Trigger reflow then add visible class for transition
  toast.offsetHeight; // eslint-disable-line no-unused-expressions
  toast.classList.add("visible");

  setTimeout(() => {
    toast.classList.remove("visible");
    toast.addEventListener("transitionend", () => toast.remove(), { once: true });
    // Fallback removal in case transitionend doesn't fire
    setTimeout(() => toast.remove(), 500);
  }, 3000);
}

async function bootstrap() {
  setStatus("Loading...");
  renderResults({});

  try {
    const resp = await fetch("/api/bootstrap");
    const body = await resp.json();
    if (!resp.ok) {
      throw new Error(body.error || "bootstrap failed");
    }
    loadFromBootstrap(body);
  } catch (err) {
    state.files = DEFAULT_FILES.slice();
    state.pythonVersion = DEFAULT_PYTHON_VERSION;
    setPythonVersionOptions(DEFAULT_PYTHON_VERSION_OPTIONS);
    state.ruffRepoPath = "";
    state.tyBinaryPath = "";
    state.pythonToolRepoPaths = {};
    toolOrder = DEFAULT_TOOL_ORDER.slice();
    state.toolSettings = {};
    ensureToolSettings();
    state.lastResults = {};
    pythonVersionEl.value = state.pythonVersion;
    ruffRepoPathEl.value = "";
    tyBinaryPathEl.value = "";
    mypyRepoPathEl.value = "";
    pycroscopeRepoPathEl.value = "";
    populateDefaultPyprojectToml();
    setStatus("Bootstrap failed, using defaults: " + err.message);
  }

  // Restore persisted editor state (files, active tab) from localStorage
  const saved = loadSavedState();
  if (saved) {
    state.files = saved.files;
    state.activeIndex = Math.min(saved.activeIndex, saved.files.length - 1);
    state.pythonVersion = normalizePythonVersion(saved.pythonVersion, state.pythonVersionOptions);
    pythonVersionEl.value = state.pythonVersion;
    state.ruffRepoPath = saved.ruffRepoPath;
    ruffRepoPathEl.value = state.ruffRepoPath;
    state.tyBinaryPath = saved.tyBinaryPath;
    tyBinaryPathEl.value = state.tyBinaryPath;
    if (saved.toolOrder) {
      // Merge saved order with current toolOrder: keep saved order for tools
      // that still exist, append any new tools from the server.
      const currentSet = new Set(toolOrder);
      const merged = saved.toolOrder.filter((t) => currentSet.has(t));
      const mergedSet = new Set(merged);
      for (const t of toolOrder) {
        if (!mergedSet.has(t)) {
          merged.push(t);
        }
      }
      toolOrder = merged;
    }
    if (saved.toolSettings) {
      for (const [tool, settings] of Object.entries(saved.toolSettings)) {
        if (state.toolSettings[tool]) {
          state.toolSettings[tool].enabled = settings.enabled;
          state.toolSettings[tool].collapsed = settings.collapsed;
        }
      }
    }
    ensureToolSettings();
  }

  showRestoredOptionsToast();
  bindEvents();
  renderTabs();
  syncEditorFromState();
  startRuffDirWatcher();
  analyze();
}

// Reset editor-wrap inline height when crossing the 980px breakpoint so CSS
// media-query defaults take effect cleanly after a user resize.
(function initEditorBreakpointReset() {
  const mql = window.matchMedia("(max-width: 980px)");
  const editorWrap = document.querySelector(".editor-wrap");

  mql.addEventListener("change", (e) => {
    if (e.matches) {
      // Entered small-screen mode: shrink to CSS min-height (120px)
      editorWrap.style.height = "120px";
    } else {
      // Entered medium/large-screen mode: clear inline height so grid stretch applies
      editorWrap.style.height = "";
    }
  });
})();

// Drag-to-resize the bottom edge of the editor panel (small screens only).
(function initEditorResize() {
  const handle = document.getElementById("editor-resize-handle");
  const editorWrap = document.querySelector(".editor-wrap");
  if (!handle || !editorWrap) return;

  let dragging = false;
  let startY = 0;
  let startHeight = 0;

  handle.addEventListener("pointerdown", (e) => {
    if (window.innerWidth >= 981) return;
    e.preventDefault();
    dragging = true;
    startY = e.clientY;
    startHeight = editorWrap.getBoundingClientRect().height;
    editorWrap.classList.add("resizing");
    document.body.style.cursor = "ns-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  });

  function onMove(e) {
    if (!dragging) return;
    const delta = e.clientY - startY;
    const newHeight = Math.max(120, startHeight + delta);
    editorWrap.style.height = newHeight + "px";
  }

  function onUp() {
    if (!dragging) return;
    dragging = false;
    editorWrap.classList.remove("resizing");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
  }
})();

// Drag-to-resize the bottom edge of a result card.
function initCardResize(handle, card) {
  let dragging = false;
  let startY = 0;
  let startHeight = 0;

  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    dragging = true;
    startY = e.clientY;
    startHeight = card.getBoundingClientRect().height;
    card.classList.add("resizing");
    document.body.style.cursor = "ns-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  });

  function onMove(e) {
    if (!dragging) return;
    const delta = e.clientY - startY;
    const newHeight = Math.max(60, startHeight + delta);
    card.style.maxHeight = newHeight + "px";
    card.style.height = newHeight + "px";
  }

  function onUp() {
    if (!dragging) return;
    dragging = false;
    card.classList.remove("resizing");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
  }
}

// Drag-to-resize panel divider between editor and results panels.
(function initPanelResize() {
  const PANEL_RATIO_KEY = "multiplay_panel_ratio";
  const divider = document.getElementById("panel-divider");
  const container = document.querySelector(".container");
  if (!divider || !container) return;

  // Restore saved ratio
  const saved = localStorage.getItem(PANEL_RATIO_KEY);
  if (saved) {
    const ratio = parseFloat(saved);
    if (ratio > 0 && ratio < 1) applyRatio(ratio);
  }

  function applyRatio(ratio) {
    container.style.setProperty("--left-panel-fr", ratio + "fr");
    container.style.setProperty("--right-panel-fr", 1 - ratio + "fr");
  }

  let dragging = false;

  function onPointerDown(e) {
    // Only on wide screens where the divider is visible
    if (window.innerWidth < 981) return;
    e.preventDefault();
    dragging = true;
    divider.classList.add("dragging");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);
  }

  function onPointerMove(e) {
    if (!dragging) return;
    const rect = container.getBoundingClientRect();
    const x = e.clientX - rect.left;
    // Clamp ratio between 20% and 80%
    const ratio = Math.min(0.8, Math.max(0.2, x / rect.width));
    applyRatio(ratio);
  }

  function onPointerUp() {
    if (!dragging) return;
    dragging = false;
    divider.classList.remove("dragging");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    document.removeEventListener("pointermove", onPointerMove);
    document.removeEventListener("pointerup", onPointerUp);

    // Persist the current ratio
    const left = container.style.getPropertyValue("--left-panel-fr");
    if (left) {
      try { localStorage.setItem(PANEL_RATIO_KEY, parseFloat(left)); } catch {}
    }
  }

  divider.addEventListener("pointerdown", onPointerDown);

  // Double-click resets to default
  divider.addEventListener("dblclick", () => {
    container.style.removeProperty("--left-panel-fr");
    container.style.removeProperty("--right-panel-fr");
    try { localStorage.removeItem(PANEL_RATIO_KEY); } catch {}
  });
})();

// Forward wheel events from non-scrollable left-column elements to the results
// panel so trackpad scrolling over the config/tabs/editor area scrolls results
// when those elements have no scrollbar of their own.
(function initLeftColumnScrollForwarding() {
  // Check whether an element can still scroll in a given axis/direction.
  function canScroll(el, axis, delta) {
    const T = 1; // tolerance for sub-pixel rounding
    if (axis === "x") {
      if (el.scrollWidth - el.clientWidth < T) return false;
      return delta < 0 ? el.scrollLeft > T
                       : el.scrollLeft + el.clientWidth < el.scrollWidth - T;
    }
    if (el.scrollHeight - el.clientHeight < T) return false;
    return delta < 0 ? el.scrollTop > T
                     : el.scrollTop + el.clientHeight < el.scrollHeight - T;
  }

  // Forward a wheel event to the results panel, but only for axes that the
  // source element cannot scroll itself.  This preserves native horizontal
  // scrolling (e.g. wide editor content) while still forwarding vertical
  // scroll to the results panel when the left column has nothing to scroll.
  function forwardWheel(e, scrollableEl) {
    if (window.innerWidth < 981) return;

    const fwdX = scrollableEl && canScroll(scrollableEl, "x", e.deltaX) ? 0 : e.deltaX;
    const fwdY = scrollableEl && canScroll(scrollableEl, "y", e.deltaY) ? 0 : e.deltaY;

    if (fwdX === 0 && fwdY === 0) return;     // nothing to forward

    resultsEl.scrollBy({ left: fwdX, top: fwdY });
    if (fwdX === e.deltaX && fwdY === e.deltaY) e.preventDefault();
  }

  const targets = document.querySelectorAll(".header-config, .tabs-wrap");
  targets.forEach((el) => {
    el.addEventListener("wheel", (e) => forwardWheel(e, null), { passive: false });
  });

  // Editor area: forward to results only for axes the editor can't scroll.
  const editorWrap = document.querySelector(".editor-wrap");
  editorWrap.addEventListener("wheel", (e) => {
    forwardWheel(e, editorEl);
  }, { passive: false, capture: true });
})();

bootstrap();
