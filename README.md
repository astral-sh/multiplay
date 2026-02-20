# Multi-file Editor + Typechecker Server

Local Python web server with a tabbed multi-file editor. Any file change triggers:

1. Send all files to `/api/analyze`
2. Rewrite all files into a local temporary directory
3. Run:
   - `uvx ty check .`
   - optional: `cargo run --bin ty -- check --project <temp-project-path>` in your local Ruff clone
   - `uvx pyright --outputjson .` (then normalized to relative paths in UI)
   - `uvx pyrefly check .`
   - `uvx mypy --color-output --pretty .`
   - `uvx zuban check --pretty .`
   - `uvx pycroscope --output-format concise .`
4. Display output from each tool in the UI

## Run

```bash
uv run multiplay
```

Then open:

- [http://localhost:8000](http://localhost:8000)

## Notes

Pycroscope imports the code, so don't enter any code in the playground that you
don't want imported on your system.

Each type checker run has a 2-second timeout during analyze; if exceeded,
that tool returns a timeout error while others still complete.

Each checker card includes:
- an `On`/`Off` toggle (disabled tools are skipped by the backend)
- a `Configure` button to open/create the tool's config section in `pyproject.toml`
- a `Docs` button linking to the tool's configuration documentation
- a collapse/expand arrow to hide/show that checker's output panel
- a drag grip for reordering panels

Optional local Ruff `ty` checker:
- provide a local Ruff clone path in the header input
- this adds a `ty (/path/to/checkout)` checker card for side-by-side comparison
- backend runs it from that repo with `cargo run --bin ty -- check --project <temp-project-path>`
- this local-checkout run is not capped by the 2-second analyze timeout

On startup, the server primes `uvx` installs for all tools so the first
`/api/analyze` call is faster, and prints detected checker versions. The UI
also shows each detected version in the checker pane header.

## Dependencies

The header has a dependency field (comma/newline separated). When non-empty:
- dependencies are installed in the temp project with `uv add ...`
- all type checkers are pointed at that temp project's `.venv` interpreter

When dependency list is empty, no `uv add` is run and no `.venv` wiring is applied.
If dependency install fails, the UI shows a dedicated error panel with command,
exit code, requested dependencies, and full installer output.

## Configuration

Because we are simply running the type checker CLIs, you can add `ty.toml`,
`mypy.ini`, `pyrightconfig.json` etc files and they "just work".
Output panes preserve ANSI terminal color codes when the tool emits them.

## Project layout

- Backend server/API: `app.py`
- Frontend markup: `static/index.html`
- Frontend styles: `static/styles.css`
- Frontend behavior/highlighting: `static/app.js`

## Requirements

- Python 3.10+
- `uvx` available on `PATH`
- Network access on first run so `uvx` can fetch tool packages if not already cached

`uvx` uses your system-default cache and tool install directories.
