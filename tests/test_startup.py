from __future__ import annotations

import io
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from typing import Any
from unittest.mock import patch

import app


class StartupTests(unittest.TestCase):
    def bootstrap_for_args(self, *args: str) -> dict[str, Any]:
        with (
            patch("sys.argv", ["multiplay", "--skip-prime", *args]),
            patch.object(app.AppHandler, "startup_overrides", {"code": "previous startup"}),
            patch.object(app, "AppServer") as server,
            patch.object(app, "_json_response") as respond,
            redirect_stdout(io.StringIO()),
        ):
            app.main()
            handler_class = server.call_args.args[1]
            handler = handler_class.__new__(handler_class)
            handler.path = "/api/bootstrap"
            handler.do_GET()
            return respond.call_args.args[2]

    def test_startup_without_flags_preserves_defaults(self) -> None:
        bootstrap = self.bootstrap_for_args()

        self.assertEqual(bootstrap["startup_overrides"], {})
        self.assertEqual(bootstrap["initial_files"], app.DEFAULT_FILES)
        self.assertEqual(bootstrap["initial_ruff_repo_path"], "")
        self.assertEqual(bootstrap["server_id"], app.SERVER_ID)

    def test_startup_normalizes_ruff_path_and_preserves_code(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp) / "ruff"
            repo.mkdir()
            (repo / "Cargo.toml").touch()
            code = "# hello\nif True:\n    print('world')\n\n"

            bootstrap = self.bootstrap_for_args(
                "--ruff-repo-path", str(repo / ".." / "ruff"), "--code", code,
            )

        self.assertEqual(
            bootstrap["startup_overrides"],
            {"ruff_repo_path": str(repo.resolve()), "code": code},
        )
        self.assertEqual(bootstrap["initial_files"], app.DEFAULT_FILES)
        self.assertEqual(bootstrap["initial_ruff_repo_path"], "")

    def test_explicit_empty_values_remain_overrides(self) -> None:
        bootstrap = self.bootstrap_for_args("--ruff-repo-path", "", "--code", "")

        self.assertEqual(bootstrap["startup_overrides"], {"ruff_repo_path": "", "code": ""})

    def test_invalid_ruff_path_fails_before_priming_or_starting_server(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            file = root / "file"
            file.touch()
            cases = [
                (root / "missing", "does not exist"),
                (file, "is not a directory"),
                (root, "does not look like a cargo workspace"),
            ]
            for path, message in cases:
                with self.subTest(path=path):
                    with (
                        patch("sys.argv", ["multiplay", "--ruff-repo-path", str(path)]),
                        patch.object(app, "_prime_tool_installs") as prime,
                        patch.object(app, "AppServer") as server,
                        redirect_stderr(io.StringIO()) as stderr,
                        self.assertRaises(SystemExit) as raised,
                    ):
                        app.main()

                    self.assertEqual(raised.exception.code, 2)
                    self.assertIn(f"--ruff-repo-path: Ruff repo path {message}", stderr.getvalue())
                    prime.assert_not_called()
                    server.assert_not_called()


if __name__ == "__main__":
    unittest.main()
