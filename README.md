# Multi-file Editor + Typechecker Server

Local Python web server with a tabbed multi-file editor. Any file change triggers:

1. Send all files to `/api/analyze`
2. Rewrite all files into a local temporary directory
3. Run:
   - `uvx mypy .`
   - `uvx pyright .`
   - `uvx pyrefly check .`
   - `uvx ty check .`
4. Display output from each tool in the UI

## Run

```bash
python3 /Users/carlmeyer/projects/multiplay/app.py --host 127.0.0.1 --port 8000
```

Then open:

- [http://127.0.0.1:8000](http://127.0.0.1:8000)

## Requirements

- Python 3.10+
- `uvx` available on `PATH`
- Network access on first run so `uvx` can fetch tool packages if not already cached

The server automatically uses temporary writable directories for `uvx` cache and tool installs.
