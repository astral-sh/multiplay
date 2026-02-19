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

const DEFAULT_TOOL_ORDER = ["mypy", "pyright", "pyrefly", "ty"];
let toolOrder = DEFAULT_TOOL_ORDER.slice();

const state = {
  files: [],
  activeIndex: 0,
  renamingIndex: -1,
  debounceMs: 500,
  debounceTimer: null,
  requestNumber: 0,
  latestHandledRequest: 0,
  toolVersions: {},
};

const tabsEl = document.getElementById("tabs");
const highlightEl = document.getElementById("highlight");
const editorEl = document.getElementById("editor");
const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");
const tempDirEl = document.getElementById("temp-dir");

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
const ANSI_FG = [
  "#1f2328",
  "#b42318",
  "#18794e",
  "#9a6700",
  "#155eef",
  "#7f56d9",
  "#0e9384",
  "#667085",
];
const ANSI_FG_BRIGHT = [
  "#343a46",
  "#d92d20",
  "#12b76a",
  "#dc6803",
  "#2970ff",
  "#9e77ed",
  "#16b364",
  "#98a2b3",
];

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
      next.fg = ANSI_FG[code - 30];
      i += 1;
      continue;
    }
    if (code >= 90 && code <= 97) {
      next.fg = ANSI_FG_BRIGHT[code - 90];
      i += 1;
      continue;
    }
    if (code >= 40 && code <= 47) {
      next.bg = ANSI_FG[code - 40];
      i += 1;
      continue;
    }
    if (code >= 100 && code <= 107) {
      next.bg = ANSI_FG_BRIGHT[code - 100];
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

  toolOrder.forEach((tool) => {
    const result = resultByTool[tool] || {};
    const card = document.createElement("section");
    card.className = "result-card";

    const header = document.createElement("div");
    header.className = "result-header";

    const title = document.createElement("strong");
    const version = state.toolVersions[tool];
    title.textContent =
      typeof version === "string" && version && version !== "unknown"
        ? `${tool} v${version}`
        : `${tool}`;

    const meta = document.createElement("span");
    meta.className = "meta";
    const code = typeof result.returncode === "number" ? result.returncode : "?";
    const ms = typeof result.duration_ms === "number" ? result.duration_ms : 0;
    meta.textContent = "exit " + code + " | " + ms + "ms";

    header.appendChild(title);
    header.appendChild(meta);

    const pre = document.createElement("pre");
    const output = typeof result.output === "string" ? result.output : "";
    pre.innerHTML = ansiToHtml(output);

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
      setStatus("Request failed: " + (body.error || resp.status));
      return;
    }

    if (body.tool_versions && typeof body.tool_versions === "object") {
      state.toolVersions = { ...state.toolVersions, ...body.tool_versions };
    }

    renderResults(body.results || {});
    tempDirEl.textContent = "Temp directory: " + (body.temp_dir || "");
    setStatus("Last analysis: " + new Date().toLocaleTimeString());
  } catch (err) {
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
}

function loadFromBootstrap(body) {
  const files = Array.isArray(body.initial_files) ? body.initial_files : [];
  const normalizedFiles = files
    .filter((f) => f && typeof f.name === "string" && typeof f.content === "string")
    .map((f) => ({ name: f.name, content: f.content }));

  state.files = normalizedFiles.length > 0 ? normalizedFiles : DEFAULT_FILES.slice();
  state.activeIndex = 0;

  if (Array.isArray(body.tool_order) && body.tool_order.length > 0) {
    toolOrder = body.tool_order.slice();
  }

  if (body.tool_versions && typeof body.tool_versions === "object") {
    state.toolVersions = { ...body.tool_versions };
  } else {
    state.toolVersions = {};
  }

  if (typeof body.temp_dir === "string" && body.temp_dir) {
    tempDirEl.textContent = "Temp directory: " + body.temp_dir;
  }
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
    setStatus("Bootstrap failed, using defaults: " + err.message);
  }

  bindEvents();
  renderTabs();
  syncEditorFromState();
  analyze();
}

bootstrap();
