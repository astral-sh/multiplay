from __future__ import annotations

import io
import threading
import unittest
from contextlib import redirect_stderr, redirect_stdout
from http import HTTPStatus
from unittest.mock import patch

import app


class IdleShutdownTests(unittest.TestCase):
    def make_server(self, timeout: float | None = 10) -> app.AppServer:
        server = app.AppServer(("127.0.0.1", 0), app.AppHandler, shutdown_if_idle=timeout)
        self.addCleanup(server.server_close)
        return server

    def test_main_passes_timeout_and_closes_server(self) -> None:
        for args, expected in [((), None), (("--shutdown-if-idle", "1.5"), 1.5)]:
            with (
                self.subTest(args=args),
                patch("sys.argv", ["multiplay", "--skip-prime", *args]),
                patch.object(app, "AppServer") as server,
                redirect_stdout(io.StringIO()),
            ):
                app.main()
                self.assertEqual(server.call_args.kwargs["shutdown_if_idle"], expected)
                server.return_value.serve_forever.assert_called_once()
                server.return_value.server_close.assert_called_once()

    def test_invalid_timeout_fails_before_priming(self) -> None:
        for value in ["0", "-1", "nan", "inf", "not-a-number"]:
            with (
                self.subTest(value=value),
                patch("sys.argv", ["multiplay", "--shutdown-if-idle", value]),
                patch.object(app, "_prime_tool_installs") as prime,
                patch.object(app, "AppServer") as server,
                redirect_stderr(io.StringIO()) as stderr,
            ):
                with self.assertRaises(SystemExit) as raised:
                    app.main()
                self.assertEqual(raised.exception.code, 2)
                self.assertIn("--shutdown-if-idle", stderr.getvalue())
                prime.assert_not_called()
                server.assert_not_called()

    def test_only_analysis_requests_reset_idle_timer(self) -> None:
        shutdown_called = threading.Event()
        with patch.object(app.time, "monotonic", return_value=0) as now:
            server = self.make_server()
            now.return_value = 100
            with patch.object(app.ThreadingHTTPServer, "serve_forever"):
                server.serve_forever()
            with patch.object(server, "shutdown", side_effect=shutdown_called.set) as shutdown:
                now.return_value = 109
                server.service_actions()
                shutdown.assert_not_called()
                self.assertTrue(server.analysis_started())
                server.analysis_finished()

                now.return_value = 118
                handler = app.AppHandler.__new__(app.AppHandler)
                handler.server = server
                handler.path = "/api/health"
                with patch.object(app, "_json_response"):
                    handler.do_GET()
                server.service_actions()
                shutdown.assert_not_called()

                now.return_value = 119
                server.service_actions()
                self.assertTrue(shutdown_called.wait(timeout=1))
                server.service_actions()
                shutdown.assert_called_once()
                self.assertFalse(server.analysis_started())

    def test_idle_shutdown_waits_for_all_active_analyses(self) -> None:
        shutdown_called = threading.Event()
        with patch.object(app.time, "monotonic", return_value=0) as now:
            server = self.make_server()
            with patch.object(server, "shutdown", side_effect=shutdown_called.set) as shutdown:
                self.assertTrue(server.analysis_started())
                self.assertTrue(server.analysis_started())
                now.return_value = 20
                server.service_actions()
                shutdown.assert_not_called()
                server.analysis_finished()
                server.service_actions()
                shutdown.assert_not_called()
                server.analysis_finished()
                server.service_actions()
                self.assertTrue(shutdown_called.wait(timeout=1))

    def test_failed_analysis_request_is_tracked_and_released(self) -> None:
        shutdown_called = threading.Event()
        with patch.object(app.time, "monotonic", return_value=0) as now:
            server = self.make_server()
            handler = app.AppHandler.__new__(app.AppHandler)
            handler.server = server
            handler.path = "/api/analyze"

            def read_body() -> None:
                now.return_value = 20
                server.service_actions()
                self.assertFalse(shutdown_called.is_set())
                raise ValueError("Invalid request")

            with (
                patch.object(server, "shutdown", side_effect=shutdown_called.set),
                patch.object(handler, "_read_json_body", side_effect=read_body) as read,
                patch.object(app, "_json_response") as response,
            ):
                handler.do_POST()
                self.assertEqual(response.call_args.args[1], HTTPStatus.BAD_REQUEST)
                server.service_actions()
                self.assertTrue(shutdown_called.wait(timeout=1))
                handler.do_POST()
                self.assertEqual(response.call_args.args[1], HTTPStatus.SERVICE_UNAVAILABLE)
                self.assertTrue(handler.close_connection)
                self.assertEqual(server._active_analyses, 0)
                read.assert_called_once()

    def test_real_server_loop_exits_without_deadlock(self) -> None:
        server = self.make_server(0.02)
        errors: list[BaseException] = []

        def serve() -> None:
            try:
                server.serve_forever(poll_interval=10)
            except BaseException as exc:
                errors.append(exc)

        thread = threading.Thread(target=serve, daemon=True)
        thread.start()
        thread.join(timeout=2)
        self.assertFalse(thread.is_alive(), "Idle shutdown did not stop the server loop")
        self.assertEqual(errors, [])


if __name__ == "__main__":
    unittest.main()
