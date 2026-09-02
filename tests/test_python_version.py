from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import app


class PythonVersionTests(unittest.TestCase):
    def test_analysis_uses_selected_python_for_dependency_environment(self) -> None:
        cases = [
            # version, enabled tools, runtime, expected
            ("3.10", ["pycroscope"], False, "3.10"),
            ("3.14", ["ty", "pyright", "pyrefly", "mypy", "zuban"], False, "3.14"),
            (None, ["mypy"], False, app.DEFAULT_PYTHON_VERSION),
            ("", ["pycroscope"], False, None),
            ("3.11", [], True, "3.11"),
            ("3.13", [], False, "3.13"),
        ]
        for version, enabled_tools, runtime, expected in cases:
            with self.subTest(
                version=version, enabled_tools=enabled_tools, runtime=runtime,
            ), tempfile.TemporaryDirectory() as tmp:
                handler = Mock(spec=app.AppHandler)
                handler.path = "/api/analyze"
                handler._read_json_body.return_value = {
                    "files": [
                        {"name": "main.py", "content": ""},
                        {"name": "pyproject.toml", "content": app.DEFAULT_PYPROJECT_TOML},
                    ],
                    "python_version": version,
                    "runtime_enabled": runtime,
                    "enabled_tools": enabled_tools,
                }
                with (
                    patch.object(app, "STAGING_DIR", Path(tmp)),
                    patch.object(app, "_run_process", return_value=app.ProcessResult("", "", 0)) as run,
                    patch.object(app, "_iter_all_tools", return_value=iter(())),
                    patch.object(app, "_ndjson_start"),
                    patch.object(app, "_ndjson_send") as send,
                ):
                    app.AppHandler.do_POST(handler)

                send.assert_called_with(handler, {"type": "done"})
                run.assert_called_once()
                command = run.call_args.args[0]
                self.assertEqual(command[:2], ["uv", "sync"])
                if expected is None:
                    self.assertNotIn("--python", command)
                else:
                    self.assertIn("--python", command)
                    self.assertEqual(command[command.index("--python") + 1], expected)


if __name__ == "__main__":
    unittest.main()
