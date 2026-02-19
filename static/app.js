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
  debounceMs: 500,
  debounceTimer: null,
  requestNumber: 0,
  latestHandledRequest: 0,
  toolVersions: {},
};

const tabsEl = document.getElementById("tabs");
const filenameEl = document.getElementById("filename");
const highlightEl = document.getElementById("highlight");
const editorEl = document.getElementById("editor");
const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");
const tempDirEl = document.getElementById("temp-dir");
const addFileBtn = document.getElementById("add-file");
const removeFileBtn = document.getElementById("remove-file");

const PY_TOKEN_RE =
  /(#[^\n]*)|("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')|\b(False|None|True|and|as|assert|async|await|break|case|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|match|nonlocal|not|or|pass|raise|return|try|while|with|yield)\b|\b(abs|all|any|bool|dict|enumerate|filter|float|int|len|list|map|max|min|object|print|range|set|sorted|str|sum|tuple|type|zip)\b|(\b\d+(?:\.\d+)?\b)|(@[A-Za-z_]\w*)/gm;
const TOML_TOKEN_RE =
  /(^\s*\[\[[^\]\n]+\]\])|(^\s*\[[^\]\n]+\])|(^\s*(?:"[^"\n]+"|'[^'\n]+'|[A-Za-z0-9_.-]+)\s*(?==))|(#[^\n]*)|("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')|\b(true|false)\b|(\b[+-]?\d+(?:\.\d+)?\b)/gim;
const JSON_TOKEN_RE =
  /("(?:\\.|[^"\\\n])*"\s*(?=:))|("(?:\\.|[^"\\\n])*")|(\b(?:true|false)\b)|(\bnull\b)|(\b-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|([{}\[\],:])/gm;
const INI_TOKEN_RE =
  /(^\s*[;#].*$)|(^\s*\[[^\]\n]+\])|(^\s*[A-Za-z0-9_.-]+\s*(?==))|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')|(\b(?:true|false|yes|no|on|off)\b)|(\b[+-]?\d+(?:\.\d+)?\b)/gim;

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
    const btn = document.createElement("button");
    btn.className = "tab" + (idx === state.activeIndex ? " active" : "");
    btn.textContent = file.name;
    btn.type = "button";
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
  editorEl.scrollTop = 0;
  editorEl.scrollLeft = 0;
  refreshHighlight(file ? file.content : "");
  removeFileBtn.disabled = state.files.length <= 1;
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
  refreshHighlight();
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

function removeFile() {
  if (state.files.length <= 1) {
    return;
  }
  state.files.splice(state.activeIndex, 1);
  state.activeIndex = Math.max(0, state.activeIndex - 1);
  renderTabs();
  syncEditorFromState();
  scheduleAnalyze();
}

function bindEvents() {
  addFileBtn.addEventListener("click", addFile);
  removeFileBtn.addEventListener("click", removeFile);

  editorEl.addEventListener("input", (event) => {
    const content = event.target.value;
    refreshHighlight(content);
    updateActiveFileContent(content);
  });

  editorEl.addEventListener("scroll", () => {
    syncHighlightScroll();
  });

  filenameEl.addEventListener("change", (event) => {
    updateActiveFileName(event.target.value);
  });

  filenameEl.addEventListener("blur", (event) => {
    updateActiveFileName(event.target.value);
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
