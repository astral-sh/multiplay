# Multi-file Editor + Typechecker Server

Local Python web server with a tabbed multi-file editor. Any file change triggers:

1. Send all files to `/api/analyze`
2. Rewrite all files into a local temporary directory
3. Run:
   - `python -m ty check .`
   - optional: `cargo run --bin ty -- check --project <temp-project-path>` in your local Ruff clone
   - optional: `uv run --with-editable 'mypy @ <local-mypy-checkout>' mypy --color-output --pretty .`
   - optional: `uv run --with-editable 'pycroscope @ <local-pycroscope-checkout>' pycroscope --output-format concise .`
   - `python -m pyright --outputjson .` (then normalized to relative paths in UI)
   - `python -m pyrefly check .`
   - `python -m mypy --color-output --pretty .`
   - `zuban check --pretty .`
   - `python -m pycroscope --output-format concise .`
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
- provide a local Ruff clone path in the "Local checker directories (optional)" section
- this adds a `ty (/path/to/checkout)` checker card for side-by-side comparison
- backend runs it from that repo with `cargo run --bin ty -- check --project <temp-project-path>`
- this local-checkout run is not capped by the 2-second analyze timeout

Optional local Python checker checkouts:
- open the "Local checker directories (optional)" section in the header
- provide local checkout paths for `mypy` and/or `pycroscope`
- backend runs those tools via `uv run --with-editable '<tool> @ <checkout>' <tool> ...` instead of from the venv
- checker card titles include the local checkout path so you can confirm which build is active

On startup, the server creates a venv in the project directory and installs all
tools into it, then does an initial run to warm up and detect checker versions.
The UI shows each detected version in the checker pane header.

## Sharing

Click the **Share** button in the header to create a public GitHub Gist containing your
current files and dependencies. The gist ID is copied to your clipboard.

To load a shared gist, paste the gist ID (or full URL) into the **Gist ID or URL** input
in the header and click **Load**. This replaces the current files and dependencies with
the contents of the gist.

Sharing requires the [`gh` CLI](https://cli.github.com) installed and authenticated (`gh auth login`).
Loading gists only requires network access (no `gh` CLI needed).

## Dependencies

The header has a dependency field (comma/newline separated). When non-empty,
dependencies are installed into the venv with `uv pip install` alongside the
type checker tools. All tools run from the same venv, so they can resolve
imports from installed packages directly.

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

- Python 3.14+
- `uv` available on `PATH`
- `gh` CLI (optional, for sharing gists — install from https://cli.github.com)
- Network access on first run so `uv` can fetch tool packages if not already cached
