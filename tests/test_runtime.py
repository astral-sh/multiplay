from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import app


class RuntimeTests(unittest.TestCase):
    def test_run_runtime_matches_script_argv_and_import_path(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project_dir = Path(tmp)
            package_dir = project_dir / "nested"
            package_dir.mkdir()
            (package_dir / "helper.py").write_text("VALUE = 42\n", encoding="utf-8")
            (package_dir / "script.py").write_text(
                "import sys\n"
                "from helper import VALUE\n"
                "print(sys.argv)\n"
                "print(VALUE)\n",
                encoding="utf-8",
            )

            result = app._run_runtime(
                project_dir,
                Path(sys.executable),
                ["nested/script.py"],
                timeout_seconds=10,
            )

        self.assertEqual(result["returncode"], 0)
        self.assertEqual(result["output"], "['nested/script.py']\n42\n")

    def test_run_runtime_normalizes_entrypoint_name(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project_dir = Path(tmp)
            (project_dir / "main.py").write_text("print('normalized')\n", encoding="utf-8")

            result = app._run_runtime(
                project_dir,
                Path(sys.executable),
                ["  main.py  "],
                timeout_seconds=10,
            )

        self.assertEqual(result["returncode"], 0)
        self.assertEqual(result["output"], "normalized\n")

    def test_runtime_enabled_is_off_by_default_and_requires_boolean(self) -> None:
        self.assertFalse(app._normalize_runtime_enabled(None))
        self.assertTrue(app._normalize_runtime_enabled(True))
        with self.assertRaisesRegex(ValueError, "runtime_enabled must be a boolean"):
            app._normalize_runtime_enabled("true")

    def test_uv_sync_uses_selected_python_version(self) -> None:
        command = app._uv_sync_command(python_version="3.12")

        self.assertEqual(command[-2:], ["--python", "3.12"])

    def test_uv_sync_omits_python_version_when_runtime_is_disabled(self) -> None:
        command = app._uv_sync_command()

        self.assertNotIn("--python", command)

    def test_run_runtime_executes_entrypoint_with_builtin_reveal_type(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project_dir = Path(tmp)
            (project_dir / "main.py").write_text(
                "print('before')\n"
                "value = reveal_type(42)\n"
                "print(f'after {value}')\n",
                encoding="utf-8",
            )

            result = app._run_runtime(
                project_dir,
                Path(sys.executable),
                ["main.py"],
                timeout_seconds=10,
            )

        self.assertEqual(result["returncode"], 0)
        self.assertEqual(result["output"], "before\nRuntime type is 'int'\nafter 42\n")

    def test_reveal_type_fallback_does_not_modify_typing(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project_dir = Path(tmp)
            (project_dir / "main.py").write_text(
                "import typing\n"
                "print(hasattr(typing, 'reveal_type'))\n"
                "print(reveal_type(42))\n",
                encoding="utf-8",
            )
            bootstrap_without_typing_reveal = (
                "import typing\n"
                "del typing.reveal_type\n"
                f"{app.RUNTIME_BOOTSTRAP}"
            )

            completed = subprocess.run(
                [sys.executable, "-u", "-c", bootstrap_without_typing_reveal, "main.py"],
                cwd=project_dir,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                check=False,
            )

        self.assertEqual(completed.returncode, 0)
        self.assertEqual(completed.stdout, "False\nRuntime type is 'int'\n42\n")

    def test_run_runtime_timeout_keeps_output_and_hides_bootstrap(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project_dir = Path(tmp)
            (project_dir / "main.py").write_text(
                "import time\n"
                "print('ready')\n"
                "time.sleep(60)\n",
                encoding="utf-8",
            )

            result = app._run_runtime(
                project_dir,
                Path(sys.executable),
                ["main.py"],
                timeout_seconds=0.1,
            )

        self.assertEqual(result["returncode"], -2)
        self.assertIn("ready\n", result["output"])
        self.assertIn(f"Timed out after 0.1s: {sys.executable} main.py", result["output"])
        self.assertNotIn("runpy.run_path", result["output"])


if __name__ == "__main__":
    unittest.main()
