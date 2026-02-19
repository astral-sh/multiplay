# Multi-file Editor + Typechecker Server

Local Python web server with a tabbed multi-file editor. Any file change triggers:

1. Send all files to `/api/analyze`
2. Rewrite all files into a local temporary directory
3. Run:
   - `uvx mypy --color-output .`
   - `uvx pyright --outputjson .` (then normalized to relative paths in UI)
   - `uvx pyrefly check .`
   - `uvx ty check .`
4. Display output from each tool in the UI

## Run

```bash
uv run app.py
```

Then open:

- [http://localhost:8000](http://localhost:8000)

On startup, the server primes `uvx` installs for all tools so the first
`/api/analyze` call is faster, and prints detected checker versions. The UI
also shows each detected version in the checker pane header.

## Configuring

Because we are simply running the type checker CLIs, you can add `ty.toml`,
`mypy.ini`, `pyrightconfig.json` etc files and they "just work".
Output panes preserve ANSI terminal color codes when the tool emits them.

## Project layout

- Backend server/API: `/Users/carlmeyer/projects/multiplay/app.py`
- Frontend markup: `/Users/carlmeyer/projects/multiplay/static/index.html`
- Frontend styles: `/Users/carlmeyer/projects/multiplay/static/styles.css`
- Frontend behavior/highlighting: `/Users/carlmeyer/projects/multiplay/static/app.js`

## Requirements

- Python 3.10+
- `uvx` available on `PATH`
- Network access on first run so `uvx` can fetch tool packages if not already cached

`uvx` uses your system-default cache and tool install directories.
