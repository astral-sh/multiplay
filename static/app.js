// === CodeMirror 6 imports ===
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from "@codemirror/view";
import { EditorState, Compartment } from "@codemirror/state";
import {
  syntaxHighlighting,
  HighlightStyle,
  indentOnInput,
  indentUnit,
  bracketMatching,
  foldGutter,
  foldKeymap,
} from "@codemirror/language";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { autocompletion, closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { python } from "@codemirror/lang-python";
import { json as jsonLang } from "@codemirror/lang-json";
import { tags } from "@lezer/highlight";

// === State persistence ===

const STORAGE_KEY = "multiplay_state";

function saveState() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        files: state.files.map((f) => ({ name: f.name, content: f.content })),
        dependencies: state.dependencies.slice(),
        activeIndex: state.activeIndex,
        ruffRepoPath: state.ruffRepoPath,
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
      dependencies: Array.isArray(data.dependencies)
        ? data.dependencies.filter((d) => typeof d === "string")
        : [],
      activeIndex: typeof data.activeIndex === "number" ? data.activeIndex : 0,
      ruffRepoPath: typeof data.ruffRepoPath === "string" ? data.ruffRepoPath : "",
      toolOrder: savedToolOrder,
      toolSettings: savedToolSettings,
    };
  } catch {
    return null;
  }
}

// === Constants ===

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
  dependencies: [],
  ruffRepoPath: "",
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
  refreshVenv: false,
  currentController: null,
};

// === Server-restart auto-reload ===
(function initServerReloadWatcher() {
  let knownServerId = null;
  const POLL_INTERVAL_MS = 2000;
  let serverDown = false;

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

// === DOM elements ===

const tabsEl = document.getElementById("tabs");
const depsInputEl = document.getElementById("dependencies");
const ruffRepoPathEl = document.getElementById("ruff-repo-path");
const mypyRepoPathEl = document.getElementById("mypy-repo-path");
const pycroscopeRepoPathEl = document.getElementById("pycroscope-repo-path");
const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");
const tempDirEl = document.getElementById("temp-dir");
const depErrorEl = document.getElementById("dep-error");
const themeToggleEl = document.getElementById("theme-toggle");

// === CodeMirror 6 editor setup ===

let editorView = null;
const languageCompartment = new Compartment();

const editorTheme = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "0.92rem",
  },
  ".cm-scroller": {
    fontFamily: "var(--mono)",
    lineHeight: "1.45",
    overflow: "auto",
  },
  ".cm-content": {
    caretColor: "var(--editor-text)",
    padding: "14px 0",
  },
  ".cm-gutters": {
    backgroundColor: "var(--editor-bg)",
    color: "color-mix(in srgb, var(--muted) 50%, transparent)",
    border: "none",
    borderRight: "1px solid var(--border)",
  },
  ".cm-lineNumbers .cm-gutterElement": {
    paddingRight: "8px",
    minWidth: "32px",
  },
  "&.cm-focused .cm-cursor": {
    borderLeftColor: "var(--editor-text)",
  },
  "&.cm-focused .cm-selectionBackground, ::selection": {
    backgroundColor: "rgba(13, 122, 111, 0.24) !important",
  },
  ".cm-selectionBackground": {
    backgroundColor: "rgba(13, 122, 111, 0.15)",
  },
  ".cm-activeLine": {
    backgroundColor: "transparent",
  },
  ".cm-selectionMatch": {
    backgroundColor: "rgba(13, 122, 111, 0.12)",
  },
  ".cm-tooltip.cm-tooltip-autocomplete": {
    fontFamily: "var(--mono)",
    fontSize: "0.85rem",
    border: "1px solid var(--border)",
    backgroundColor: "var(--panel)",
    color: "var(--ink)",
    borderRadius: "8px",
    boxShadow: "var(--shadow)",
  },
  ".cm-tooltip-autocomplete ul li": {
    padding: "4px 8px",
  },
  ".cm-tooltip-autocomplete ul li[aria-selected]": {
    backgroundColor: "var(--accent)",
    color: "#fff",
  },
  ".cm-completionLabel": {
    fontSize: "0.85rem",
  },
  ".cm-completionDetail": {
    fontSize: "0.78rem",
    fontStyle: "normal",
    color: "var(--muted)",
    marginLeft: "8px",
  },
  ".cm-tooltip-autocomplete ul li[aria-selected] .cm-completionDetail": {
    color: "rgba(255, 255, 255, 0.7)",
  },
  ".cm-completionIcon": {
    fontSize: "0.85rem",
    opacity: "0.7",
  },
});

const highlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: "var(--syn-keyword)", fontWeight: "600" },
  { tag: tags.controlKeyword, color: "var(--syn-keyword)", fontWeight: "600" },
  { tag: tags.operatorKeyword, color: "var(--syn-keyword)", fontWeight: "600" },
  { tag: tags.definitionKeyword, color: "var(--syn-keyword)", fontWeight: "600" },
  { tag: tags.moduleKeyword, color: "var(--syn-keyword)", fontWeight: "600" },
  { tag: tags.string, color: "var(--syn-string)" },
  { tag: tags.comment, color: "var(--syn-comment)", fontStyle: "italic" },
  { tag: tags.number, color: "var(--syn-number)" },
  { tag: tags.integer, color: "var(--syn-number)" },
  { tag: tags.float, color: "var(--syn-number)" },
  { tag: tags.function(tags.variableName), color: "var(--syn-builtin)", fontWeight: "600" },
  { tag: tags.function(tags.definition(tags.variableName)), color: "var(--syn-builtin)", fontWeight: "600" },
  { tag: tags.className, color: "var(--syn-builtin)", fontWeight: "600" },
  { tag: tags.definition(tags.className), color: "var(--syn-builtin)", fontWeight: "600" },
  { tag: tags.operator, color: "var(--syn-punct)" },
  { tag: tags.punctuation, color: "var(--syn-punct)" },
  { tag: tags.bracket, color: "var(--syn-punct)" },
  { tag: tags.meta, color: "var(--syn-decorator)", fontWeight: "600" },
  { tag: tags.bool, color: "var(--syn-decorator)", fontWeight: "600" },
  { tag: tags.atom, color: "var(--syn-keyword)", fontWeight: "600" },
  { tag: tags.null, color: "var(--syn-keyword)", fontWeight: "600" },
  { tag: tags.self, color: "var(--syn-keyword)", fontWeight: "600" },
  { tag: tags.special(tags.variableName), color: "var(--syn-builtin)" },
  { tag: tags.propertyName, color: "var(--syn-builtin)" },
]);

function languageForFile(filename) {
  const ext = extensionOf(filename);
  if (ext === ".py" || ext === ".pyi") return python();
  if (ext === ".json") return jsonLang();
  return [];
}

// === Completion source ===

function lspKindToType(kind) {
  const map = {
    1: "text",
    2: "function",
    3: "function",
    4: "function",
    5: "variable",
    6: "variable",
    7: "class",
    8: "interface",
    9: "namespace",
    10: "property",
    11: "enum",
    12: "constant",
    13: "enum",
    14: "keyword",
    15: "text",
    16: "constant",
    17: "text",
    18: "text",
    19: "text",
    20: "enum",
    21: "constant",
    22: "class",
    23: "keyword",
    24: "keyword",
    25: "type",
  };
  return map[kind] || "text";
}

async function tyCompletionSource(context) {
  if (!isPythonFile()) return null;

  // Match either "." followed by optional identifier, or a bare identifier
  const dotBefore = context.matchBefore(/\.\w*/);
  const wordBefore = context.matchBefore(/\w+/);

  if (!context.explicit) {
    // Automatic trigger: only after "." or while typing an identifier (2+ chars)
    if (!dotBefore && (!wordBefore || wordBefore.to - wordBefore.from < 2)) return null;
  }

  const from = dotBefore ? dotBefore.from + 1 : wordBefore ? wordBefore.from : context.pos;

  try {
    const line = context.state.doc.lineAt(context.pos);
    const resp = await fetch("/api/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: activeFile().name,
        line: line.number - 1,
        column: context.pos - line.from,
        files: state.files.map((f) => ({
          name: f.name,
          content: f.name === activeFile().name ? context.state.doc.toString() : f.content,
        })),
      }),
    });
    const data = await resp.json();
    if (!data.items || data.items.length === 0) return null;

    // Client-side prefix filtering so we can use filter: false to preserve
    // the server's ranking order
    const typed = context.state.doc.sliceString(from, context.pos).toLowerCase();
    const filtered = typed
      ? data.items.filter((item) => {
          const text = (item.filterText || item.label).toLowerCase();
          return text.startsWith(typed);
        })
      : data.items;
    if (filtered.length === 0) return null;

    return {
      from,
      filter: false,
      options: filtered.map((item) => ({
        label: item.label,
        type: lspKindToType(item.kind),
        detail: item.detail || undefined,
        apply: item.additionalTextEdits && item.additionalTextEdits.length > 0
          ? (view, completion, fromPos, toPos) => {
              // Build all changes: the main insertion + additional edits (e.g. auto-import)
              const changes = [{ from: fromPos, to: toPos, insert: item.insertText || item.label }];
              for (const edit of item.additionalTextEdits) {
                const startLine = view.state.doc.line(edit.range.start.line + 1);
                const endLine = view.state.doc.line(edit.range.end.line + 1);
                changes.push({
                  from: startLine.from + edit.range.start.character,
                  to: endLine.from + edit.range.end.character,
                  insert: edit.newText,
                });
              }
              view.dispatch({ changes, userEvent: "input.complete" });
            }
          : item.insertText || item.label,
      })),
    };
  } catch {
    return null;
  }
}

function createEditor(parent) {
  const extensions = [
    lineNumbers(),
    highlightActiveLine(),
    history(),
    bracketMatching(),
    indentOnInput(),
    indentUnit.of("    "),
    closeBrackets(),
    drawSelection(),
    foldGutter(),
    highlightSelectionMatches(),
    keymap.of([
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...foldKeymap,
      indentWithTab,
    ]),
    languageCompartment.of(python()),
    editorTheme,
    syntaxHighlighting(highlightStyle),
    autocompletion({
      override: [tyCompletionSource],
      activateOnTyping: true,
    }),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        updateActiveFileContent(update.state.doc.toString());
      }
    }),
  ];

  editorView = new EditorView({
    state: EditorState.create({ doc: "", extensions }),
    parent,
  });
}

// === Theme handling ===

function initTheme() {
  const stored = localStorage.getItem("theme");
  if (stored === "dark" || stored === "light") {
    document.documentElement.setAttribute("data-theme", stored);
  }
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
    newTheme = prefersDark ? "light" : "dark";
  }

  document.documentElement.setAttribute("data-theme", newTheme);
  localStorage.setItem("theme", newTheme);

  if (typeof renderResults === "function" && state.lastResults) {
    renderResults(state.lastResults);
  }
}

if (themeToggleEl) {
  themeToggleEl.addEventListener("click", toggleTheme);
}
initTheme();

// === Header buttons ===

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
  for (const file of state.files) {
    if (file.name === "pyproject.toml") {
      file.content = buildPyprojectContent();
    } else {
      file.content = "";
    }
  }
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
        dependencies: state.dependencies.slice(),
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

    const deps = Array.isArray(body.dependencies)
      ? body.dependencies.filter((d) => typeof d === "string").map((d) => d.trim()).filter((d) => d.length > 0)
      : [];
    state.dependencies = deps;
    depsInputEl.value = dependenciesToText(state.dependencies);

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

// === ANSI rendering ===

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

function setStatus(text) {
  statusEl.textContent = text;
  statusEl.classList.toggle("status-busy", text === "Analyzing..." || text === "Loading...");
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
  const command = typeof info?.command === "string" && info.command ? info.command : "uv pip install ...";
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

// === Location links ===

function linkifyLocations(html) {
  const names = state.files.map((f) => f.name).filter(Boolean);
  if (names.length === 0) return html;
  const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(
    "(" + escaped.join("|") + "):(\\d+)(?::(\\d+))?",
    "g",
  );
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

// === Editor navigation ===

function navigateToLine(line, col) {
  if (!editorView) return;
  const doc = editorView.state.doc;
  if (line < 1 || line > doc.lines) return;

  const lineObj = doc.line(line);
  const clampedCol = Math.min(Math.max((col || 1) - 1, 0), lineObj.length);
  const pos = lineObj.from + clampedCol;

  editorView.dispatch({
    selection: { anchor: pos },
    effects: EditorView.scrollIntoView(pos, { y: "center" }),
  });
  editorView.focus();

  // Flash the target line
  const shell = editorView.dom.closest(".editor-shell");
  if (shell) {
    shell.querySelectorAll(".line-glow").forEach((el) => el.remove());
    const lineBlock = editorView.lineBlockAt(pos);
    const editorRect = editorView.dom.getBoundingClientRect();
    const glow = document.createElement("div");
    glow.className = "line-glow";
    glow.style.top = `${lineBlock.top - editorView.documentTop + editorView.dom.querySelector(".cm-scroller").scrollTop}px`;
    glow.style.height = `${lineBlock.height}px`;
    shell.appendChild(glow);
    glow.addEventListener("animationend", () => glow.remove());
  }
}

function extensionOf(filename) {
  const name = (filename || "").trim().toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot);
}

// === Results click handler ===

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

// === Editor sync ===

function syncEditorFromState() {
  if (!editorView) return;
  const file = activeFile();
  const content = file ? file.content : "";
  const filename = file ? file.name : "";

  // Replace document content
  editorView.dispatch({
    changes: { from: 0, to: editorView.state.doc.length, insert: content },
  });

  // Switch language mode
  editorView.dispatch({
    effects: languageCompartment.reconfigure(languageForFile(filename)),
  });
}

// === Tab management ===

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
    removeBtn.textContent = "\u00d7";
    removeBtn.disabled = state.files.length <= 1;
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

// === Helper functions ===

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

function updateDependenciesFromInput({ triggerAnalyze = false } = {}) {
  const parsed = parseDependencies(depsInputEl.value);
  state.dependencies = parsed;
  state.refreshVenv = true;
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
  // Update language mode when filename changes
  if (editorView && changed) {
    editorView.dispatch({
      effects: languageCompartment.reconfigure(languageForFile(normalized)),
    });
  }
  if (changed) {
    scheduleAnalyze();
  }
  return true;
}

// === Results rendering ===

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
    const version = localPythonToolPath ? "" : state.toolVersions[tool];
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
    collapseBtn.textContent = collapsed ? "\u25bc" : "\u25b2";
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

// === Streaming analysis handling ===

function handleMetadataMessage(msg) {
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
  if (msg.python_tool_repo_paths && typeof msg.python_tool_repo_paths === "object") {
    state.pythonToolRepoPaths = normalizePythonToolRepoPaths(msg.python_tool_repo_paths);
  }
  ensureToolSettings();
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
    tempDirEl.textContent = "Temp directory: " + msg.temp_dir;
  }

  if (state.currentOnlyTools) {
    for (const tool of state.currentOnlyTools) {
      delete state.lastResults[tool];
    }
    resetSpecificCardsToPending(state.currentOnlyTools);
  } else {
    state.lastResults = {};

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
      collapseBtn.textContent = collapsed ? "\u25bc" : "\u25b2";
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

// === Analysis ===

async function analyze({ onlyTools } = {}) {
  const requestId = ++state.requestNumber;
  setStatus("Analyzing...");

  if (state.currentController) {
    state.currentController.abort();
  }
  const controller = new AbortController();
  state.currentController = controller;
  state.currentOnlyTools = onlyTools || null;

  const toolsToSend = onlyTools || enabledTools();
  const refreshVenv = state.refreshVenv;
  state.refreshVenv = false;
  const payload = {
    files: state.files.map((f) => ({ name: f.name, content: f.content })),
    dependencies: state.dependencies.slice(),
    refresh_venv: refreshVenv,
    ruff_repo_path: state.ruffRepoPath,
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

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
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
        // Incomplete JSON at end of stream
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

// === Config file management ===

function buildPyprojectContent() {
  const seen = new Set();
  const sections = [];
  for (const name of toolOrder) {
    const header = toolConfigSection(name);
    if (!seen.has(header)) {
      seen.add(header);
      sections.push(header);
    }
  }
  return sections.join("\n\n\n") + "\n";
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

  // Place cursor at the section header
  if (editorView) {
    const content = editorView.state.doc.toString();
    const sectionIndex = content.indexOf(section);
    if (sectionIndex >= 0) {
      let cursorPos = sectionIndex + section.length;
      if (content[cursorPos] === "\n") cursorPos++;
      editorView.dispatch({
        selection: { anchor: cursorPos },
        effects: EditorView.scrollIntoView(cursorPos, { y: "center" }),
      });
      editorView.focus();
    } else {
      editorView.focus();
    }
  }

  scheduleAnalyze();
}

// === File management ===

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

// === Event bindings ===

function bindEvents() {
  depsInputEl.addEventListener("input", () => {
    updateDependenciesFromInput({ triggerAnalyze: true });
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

// === Bootstrap ===

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
  if (body.initial_python_tool_repo_paths && typeof body.initial_python_tool_repo_paths === "object") {
    state.pythonToolRepoPaths = normalizePythonToolRepoPaths(body.initial_python_tool_repo_paths);
  } else {
    state.pythonToolRepoPaths = {};
  }
  ruffRepoPathEl.value = state.ruffRepoPath;
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
    state.pythonToolRepoPaths = {};
    toolOrder = DEFAULT_TOOL_ORDER.slice();
    state.toolSettings = {};
    ensureToolSettings();
    state.lastResults = {};
    depsInputEl.value = "";
    ruffRepoPathEl.value = "";
    mypyRepoPathEl.value = "";
    pycroscopeRepoPathEl.value = "";
    setStatus("Bootstrap failed, using defaults: " + err.message);
  }

  const saved = loadSavedState();
  if (saved) {
    state.files = saved.files;
    state.activeIndex = Math.min(saved.activeIndex, saved.files.length - 1);
    state.dependencies = saved.dependencies;
    depsInputEl.value = dependenciesToText(state.dependencies);
    state.ruffRepoPath = saved.ruffRepoPath;
    ruffRepoPathEl.value = state.ruffRepoPath;
    if (saved.toolOrder) {
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

  // Create the CM6 editor
  const cmContainer = document.getElementById("cm-editor");
  if (cmContainer) {
    createEditor(cmContainer);
  }

  bindEvents();
  renderTabs();
  syncEditorFromState();
  state.refreshVenv = true;
  analyze();
}

// === Resize handlers ===

// Reset editor-wrap inline height when crossing the 980px breakpoint
(function initEditorBreakpointReset() {
  const mql = window.matchMedia("(max-width: 980px)");
  const editorWrap = document.querySelector(".editor-wrap");

  mql.addEventListener("change", (e) => {
    if (e.matches) {
      editorWrap.style.height = "120px";
    } else {
      editorWrap.style.height = "";
    }
  });
})();

// Drag-to-resize the bottom edge of the editor panel (small screens only)
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

// Drag-to-resize the bottom edge of a result card
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

// Drag-to-resize panel divider between editor and results panels
(function initPanelResize() {
  const PANEL_RATIO_KEY = "multiplay_panel_ratio";
  const divider = document.getElementById("panel-divider");
  const container = document.querySelector(".container");
  if (!divider || !container) return;

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

    const left = container.style.getPropertyValue("--left-panel-fr");
    if (left) {
      try { localStorage.setItem(PANEL_RATIO_KEY, parseFloat(left)); } catch {}
    }
  }

  divider.addEventListener("pointerdown", onPointerDown);

  divider.addEventListener("dblclick", () => {
    container.style.removeProperty("--left-panel-fr");
    container.style.removeProperty("--right-panel-fr");
    try { localStorage.removeItem(PANEL_RATIO_KEY); } catch {}
  });
})();

// Forward wheel events from non-scrollable left-column elements to the results panel
(function initLeftColumnScrollForwarding() {
  const targets = document.querySelectorAll(".header-config, .tabs-wrap");
  targets.forEach((el) => {
    el.addEventListener("wheel", (e) => {
      if (window.innerWidth < 981) return;
      resultsEl.scrollBy({ left: e.deltaX, top: e.deltaY });
      e.preventDefault();
    }, { passive: false });
  });

  const editorWrap = document.querySelector(".editor-wrap");
  editorWrap.addEventListener("wheel", (e) => {
    if (window.innerWidth < 981) return;
    // With CM6, check if the editor's scroller has overflow
    const scroller = editorWrap.querySelector(".cm-scroller");
    if (scroller && scroller.scrollHeight > scroller.clientHeight) return;
    resultsEl.scrollBy({ left: e.deltaX, top: e.deltaY });
    e.preventDefault();
  }, { passive: false, capture: true });
})();

// === Start ===

bootstrap();
