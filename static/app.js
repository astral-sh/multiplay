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
];

const DEFAULT_TOOL_ORDER = ["ty", "pyright", "pyrefly", "mypy", "zuban", "pycroscope"];
let toolOrder = DEFAULT_TOOL_ORDER.slice();
const RUFF_TY_TOOL = "ty_ruff";

let draggedTool = null;

const state = {
  files: [],
  dependencies: [],
  ruffRepoPath: "",
  activeIndex: 0,
  renamingIndex: -1,
  debounceMs: 500,
  debounceTimer: null,
  requestNumber: 0,
  latestHandledRequest: 0,
  toolVersions: {},
  toolSettings: {},
  lastResults: {},
};

// Server-restart auto-reload: poll /api/health and reload if the server ID changes
(function initServerReloadWatcher() {
  let knownServerId = null;
  const POLL_INTERVAL_MS = 2000;

  async function poll() {
    try {
      const resp = await fetch("/api/health");
      if (!resp.ok) return;
      const body = await resp.json();
      const id = body.server_id;
      if (!id) return;

      if (knownServerId === null) {
        knownServerId = id;
      } else if (id !== knownServerId) {
        location.reload();
        return;
      }
    } catch {
      // Server is down — keep polling until it comes back
    }
    setTimeout(poll, POLL_INTERVAL_MS);
  }

  setTimeout(poll, POLL_INTERVAL_MS);
})();

const tabsEl = document.getElementById("tabs");
const depsInputEl = document.getElementById("dependencies");
const ruffRepoPathEl = document.getElementById("ruff-repo-path");
const highlightEl = document.getElementById("highlight");
const editorEl = document.getElementById("editor");
const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");
const tempDirEl = document.getElementById("temp-dir");
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

const PY_TOKEN_RE =
  /(#[^\n]*)|("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')|\b(False|None|True|and|as|assert|async|await|break|case|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|match|nonlocal|not|or|pass|raise|return|try|while|with|yield)\b|\b(abs|all|any|bool|dict|enumerate|filter|float|int|len|list|map|max|min|object|print|range|set|sorted|str|sum|tuple|type|zip)\b|(\b\d+(?:\.\d+)?\b)|(@[A-Za-z_]\w*)/gm;
const TOML_TOKEN_RE =
  /(^\s*\[\[[^\]\n]+\]\])|(^\s*\[[^\]\n]+\])|(^\s*(?:"[^"\n]+"|'[^'\n]+'|[A-Za-z0-9_.-]+)\s*(?==))|(#[^\n]*)|("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')|\b(true|false)\b|(\b[+-]?\d+(?:\.\d+)?\b)/gim;
const JSON_TOKEN_RE =
  /("(?:\\.|[^"\\\n])*"\s*(?=:))|("(?:\\.|[^"\\\n])*")|(\b(?:true|false)\b)|(\bnull\b)|(\b-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|([{}\[\],:])/gm;
const INI_TOKEN_RE =
  /(^\s*[;#].*$)|(^\s*\[[^\]\n]+\])|(^\s*[A-Za-z0-9_.-]+\s*(?==))|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')|(\b(?:true|false|yes|no|on|off)\b)|(\b[+-]?\d+(?:\.\d+)?\b)/gim;
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

function setStatus(text) {
  statusEl.textContent = text;
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
  const command = typeof info?.command === "string" && info.command ? info.command : "uv add ...";
  const returnCode = typeof info?.returncode === "number" ? info.returncode : "?";
  const durationMs = typeof info?.duration_ms === "number" ? info.duration_ms : "?";
  const dependencies = Array.isArray(info?.dependencies)
    ? info.dependencies.filter((dep) => typeof dep === "string" && dep.trim().length > 0)
    : [];
  const depsText = dependencies.length > 0 ? dependencies.join(", ") : "(none)";
  const output = typeof info?.output === "string" ? info.output : "";

  depErrorEl.innerHTML =
    `<div class="dep-error-title">Dependency install failed</div>` +
    `<p class="dep-error-meta">` +
    `Could not run <code>${escapeHtml(command)}</code> ` +
    `(exit ${escapeHtml(String(returnCode))}, ${escapeHtml(String(durationMs))}ms).` +
    `</p>` +
    `<p class="dep-error-meta">Requested: <code>${escapeHtml(depsText)}</code></p>` +
    `<pre>${ansiToHtml(output || "(no output)")}</pre>`;
  depErrorEl.classList.remove("hidden");
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
}

function refreshHighlight(content) {
  const file = activeFile();
  const source = typeof content === "string" ? content : file ? file.content : "";
  const filename = file ? file.name : "";
  highlightEl.innerHTML = renderHighlightedCode(source, filename);
  syncHighlightScroll();
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
        syncEditorFromState();
        syncActiveTabClasses();
      }
    });
    btn.addEventListener("dblclick", (event) => {
      event.preventDefault();
      startTabRename(idx);
    });

    const removeBtn = document.createElement("button");
    removeBtn.className = "tab-icon tab-remove";
    removeBtn.type = "button";
    removeBtn.title = `Remove ${file.name}`;
    removeBtn.textContent = "×";
    removeBtn.disabled = state.files.length <= 1;
    removeBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      removeFileAtIndex(idx);
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

function parseDependencies(raw) {
  if (typeof raw !== "string") {
    return [];
  }

  const seen = new Set();
  const deps = [];
  for (const part of raw.split(/[\n,]/)) {
    const value = part.trim();
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    deps.push(value);
  }
  return deps;
}

function dependenciesToText(dependencies) {
  return dependencies.join(", ");
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

function normalizeRuffRepoPath(raw) {
  return typeof raw === "string" ? raw.trim() : "";
}

function toolLabel(tool) {
  if (tool === RUFF_TY_TOOL) {
    const checkoutPath = normalizeRuffRepoPath(state.ruffRepoPath);
    return checkoutPath ? `ty (${checkoutPath})` : "ty (local checkout)";
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

function updateDependenciesFromInput({ triggerAnalyze } = { triggerAnalyze: false }) {
  const parsed = parseDependencies(depsInputEl.value);
  const nextText = dependenciesToText(parsed);
  const prevText = dependenciesToText(state.dependencies);
  depsInputEl.value = nextText;
  if (nextText === prevText) {
    return;
  }
  state.dependencies = parsed;
  if (triggerAnalyze) {
    scheduleAnalyze();
  }
}

function updateRuffRepoPathFromInput({ triggerAnalyze } = { triggerAnalyze: false }) {
  const normalized = normalizeRuffRepoPath(ruffRepoPathEl.value);
  ruffRepoPathEl.value = normalized;
  if (normalized === state.ruffRepoPath) {
    return;
  }

  state.ruffRepoPath = normalized;
  ensureToolSettings();
  renderResults(state.lastResults);

  if (triggerAnalyze) {
    scheduleAnalyze();
  }
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

function startTabRename(index) {
  if (index < 0 || index >= state.files.length) {
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
    card.draggable = true;
    card.dataset.tool = tool;
    if (!enabled) {
      card.classList.add("tool-disabled");
    }
    if (collapsed) {
      card.classList.add("collapsed");
    }

    card.addEventListener("dragstart", (event) => {
      draggedTool = tool;
      card.classList.add("dragging");
      event.dataTransfer.effectAllowed = "move";
    });

    card.addEventListener("dragend", () => {
      draggedTool = null;
      card.classList.remove("dragging");
      resultsEl.querySelectorAll(".result-card").forEach((c) => {
        c.classList.remove("drag-over-above", "drag-over-below");
      });
    });

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
      renderResults(state.lastResults);
    });

    const header = document.createElement("div");
    header.className = "result-header";

    const grip = document.createElement("span");
    grip.className = "drag-grip";
    grip.textContent = "\u2261";
    header.appendChild(grip);

    const titleWrap = document.createElement("div");
    titleWrap.className = "result-title-wrap";

    const title = document.createElement("strong");
    const displayName = toolLabel(tool);
    const version = state.toolVersions[tool];
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
      current.enabled = !(current.enabled !== false);
      renderResults(state.lastResults);
      scheduleAnalyze();
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
      renderResults(state.lastResults);
    });

    right.appendChild(meta);
    right.appendChild(toggleBtn);
    right.appendChild(collapseBtn);
    header.appendChild(titleWrap);
    header.appendChild(right);

    const pre = document.createElement("pre");
    if (!enabled) {
      pre.textContent = "Tool is turned off for this analysis.";
    } else {
      const output = typeof result.output === "string" ? result.output : "";
      pre.innerHTML = ansiToHtml(output);
    }

    card.appendChild(header);
    card.appendChild(pre);
    resultsEl.appendChild(card);
  });
}

async function analyze() {
  const requestId = ++state.requestNumber;
  setStatus("Analyzing...");

  const payload = {
    files: state.files.map((f) => ({ name: f.name, content: f.content })),
    dependencies: state.dependencies.slice(),
    ruff_repo_path: state.ruffRepoPath,
    enabled_tools: enabledTools(),
  };

  try {
    const resp = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const body = await resp.json();
    if (requestId < state.latestHandledRequest) {
      return;
    }
    state.latestHandledRequest = requestId;

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

    clearDependencyInstallError();
    if (body.tool_versions && typeof body.tool_versions === "object") {
      state.toolVersions = { ...state.toolVersions, ...body.tool_versions };
    }
    if (Array.isArray(body.tool_order) && body.tool_order.length > 0) {
      const serverOrder = normalizeToolList(body.tool_order);
      const serverSet = new Set(serverOrder);
      // Keep local ordering, drop tools the server no longer reports
      const merged = toolOrder.filter((t) => serverSet.has(t));
      const mergedSet = new Set(merged);
      // Append any new tools from the server at the end
      for (const t of serverOrder) {
        if (!mergedSet.has(t)) {
          merged.push(t);
        }
      }
      toolOrder = merged;
    }
    if (typeof body.ruff_repo_path === "string") {
      state.ruffRepoPath = normalizeRuffRepoPath(body.ruff_repo_path);
      ruffRepoPathEl.value = state.ruffRepoPath;
    }
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
    if (Array.isArray(body.dependencies)) {
      state.dependencies = body.dependencies
        .filter((dep) => typeof dep === "string")
        .map((dep) => dep.trim())
        .filter((dep) => dep.length > 0);
      depsInputEl.value = dependenciesToText(state.dependencies);
    }

    state.lastResults = body.results && typeof body.results === "object" ? body.results : {};
    renderResults(state.lastResults);
    tempDirEl.textContent = "Temp directory: " + (body.temp_dir || "");
    setStatus("Last analysis: " + new Date().toLocaleTimeString());
  } catch (err) {
    clearDependencyInstallError();
    setStatus("Error: " + err.message);
  }
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

function bindEvents() {
  editorEl.addEventListener("input", (event) => {
    const content = event.target.value;
    refreshHighlight(content);
    updateActiveFileContent(content);
  });

  editorEl.addEventListener("scroll", () => {
    syncHighlightScroll();
  });

  depsInputEl.addEventListener("change", () => {
    updateDependenciesFromInput({ triggerAnalyze: true });
  });

  depsInputEl.addEventListener("blur", () => {
    updateDependenciesFromInput({ triggerAnalyze: true });
  });

  ruffRepoPathEl.addEventListener("change", () => {
    updateRuffRepoPathFromInput({ triggerAnalyze: true });
  });

  ruffRepoPathEl.addEventListener("blur", () => {
    updateRuffRepoPathFromInput({ triggerAnalyze: true });
  });
}

function loadFromBootstrap(body) {
  clearDependencyInstallError();
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
  ruffRepoPathEl.value = state.ruffRepoPath;
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

  if (Array.isArray(body.initial_dependencies)) {
    state.dependencies = body.initial_dependencies
      .filter((dep) => typeof dep === "string")
      .map((dep) => dep.trim())
      .filter((dep) => dep.length > 0);
  } else {
    state.dependencies = [];
  }
  depsInputEl.value = dependenciesToText(state.dependencies);

  if (typeof body.temp_dir === "string" && body.temp_dir) {
    tempDirEl.textContent = "Temp directory: " + body.temp_dir;
  }

  state.lastResults = {};
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
    state.dependencies = [];
    state.ruffRepoPath = "";
    toolOrder = DEFAULT_TOOL_ORDER.slice();
    state.toolSettings = {};
    ensureToolSettings();
    state.lastResults = {};
    depsInputEl.value = "";
    ruffRepoPathEl.value = "";
    setStatus("Bootstrap failed, using defaults: " + err.message);
  }

  bindEvents();
  renderTabs();
  syncEditorFromState();
  analyze();
}

bootstrap();
