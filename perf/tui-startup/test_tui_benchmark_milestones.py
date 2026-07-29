import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import tui_benchmark
from terminal_screen import PtyCleanupError, TerminalScreen


HERE = Path(__file__).resolve().parent
FAKE_TUI = HERE / "fake_tui.py"


def trace_record(sequence, event, **fields):
    return {
        "version": 1,
        "runID": "run_test",
        "sequence": sequence,
        "elapsedMs": sequence + 0.25,
        "event": event,
        **fields,
    }


def encoded(record):
    return (json.dumps(record, separators=(",", ":")) + "\n").encode("utf-8")


def committed(text):
    screen = TerminalScreen(100, 30)
    frames = screen.feed(b"\x1b[?2026h\x1b[2J\x1b[H" + text.encode("utf-8") + b"\x1b[?2026l")
    return frames[-1]


def committed_cells(*placements):
    screen = TerminalScreen(100, 30)
    body = bytearray(b"\x1b[?2026h\x1b[2J\x1b[H")
    for row, column, text in placements:
        body.extend(f"\x1b[{row + 1};{column + 1}H".encode("ascii"))
        body.extend(text.encode("utf-8"))
    body.extend(b"\x1b[?2026l")
    return screen.feed(bytes(body))[-1]


class TraceJsonlParserTest(unittest.TestCase):
    def test_independent_arbitrary_fragments_use_final_fragment_receipt_clock(self):
        parser = tui_benchmark.TraceJsonlParser("run_test")
        records = (
            trace_record(0, "cli.entry", role="main"),
            trace_record(
                1,
                "prompt.mounted",
                role="main",
                workspaceGeneration=0,
                attemptGeneration=0,
            ),
        )
        stream = b"".join(encoded(record) for record in records)
        parsed = []
        for index, value in enumerate(stream):
            parsed.extend(parser.feed(bytes((value,)), index / 10))
        parser.finish()

        self.assertEqual([item[0]["event"] for item in parsed], ["cli.entry", "prompt.mounted"])
        self.assertEqual(parsed[-1][1], (len(stream) - 1) / 10)
        self.assertEqual(parser.records, 2)

    def test_multiple_records_in_one_receipt_share_only_harness_clock(self):
        parser = tui_benchmark.TraceJsonlParser("run_test")
        data = encoded(trace_record(0, "cli.entry", role="main")) + encoded(
            trace_record(
                1,
                "theme.settled",
                role="main",
                workspaceGeneration=0,
                attemptGeneration=0,
                outcome="resolved",
            )
        )
        parsed = parser.feed(data, 17.5)

        self.assertEqual([receipt for _, receipt in parsed], [17.5, 17.5])
        self.assertNotEqual(parsed[0][0]["elapsedMs"], parsed[0][1])

    def test_fails_closed_on_run_sequence_schema_json_and_eof(self):
        cases = []
        wrong_run = trace_record(0, "cli.entry", role="main")
        wrong_run["runID"] = "run_other"
        cases.append((encoded(wrong_run), "trace_run_id_mismatch"))
        cases.append((encoded(trace_record(1, "cli.entry", role="main")), "trace_sequence_mismatch"))
        cases.append(
            (
                encoded(
                    trace_record(
                        0,
                        "prompt.mounted",
                        role="main",
                        workspaceGeneration=1,
                        attemptGeneration=0,
                    )
                ),
                "trace_invalid_schema",
            )
        )
        cases.append((b'{"version":1,"version":1}\n', "trace_invalid_json"))
        cases.append(
            (
                encoded(
                    trace_record(
                        0,
                        "phase",
                        role="main",
                        phase=[],
                        outcome="ok",
                        durationMs=1,
                    )
                ),
                "trace_invalid_schema",
            )
        )
        for data, code in cases:
            with self.subTest(code=code):
                parser = tui_benchmark.TraceJsonlParser("run_test")
                with self.assertRaises(tui_benchmark.TraceFailure) as caught:
                    parser.feed(data, 1)
                self.assertEqual(caught.exception.code, code)

        parser = tui_benchmark.TraceJsonlParser("run_test")
        parser.feed(encoded(trace_record(0, "cli.entry", role="main"))[:-1], 1)
        with self.assertRaises(tui_benchmark.TraceFailure) as caught:
            parser.finish()
        self.assertEqual(caught.exception.code, "trace_eof_truncated")

        parser = tui_benchmark.TraceJsonlParser("run_test")
        with self.assertRaises(tui_benchmark.TraceFailure) as caught:
            parser.feed(
                encoded(
                    trace_record(
                        0,
                        "prompt.mounted",
                        role="main",
                        workspaceGeneration=0,
                        attemptGeneration=0,
                    )
                ),
                1,
            )
        self.assertEqual(caught.exception.code, "trace_event_order")

    def test_rejects_unknown_shell_event_until_trace_schema_adds_it(self):
        parser = tui_benchmark.TraceJsonlParser("run_test")
        record = trace_record(
            0,
            "shell.drawn",
            role="main",
            workspaceGeneration=0,
            attemptGeneration=0,
        )
        with self.assertRaises(tui_benchmark.TraceFailure) as caught:
            parser.feed(encoded(record), 1)
        self.assertEqual(caught.exception.code, "trace_invalid_schema")


class StartupMilestoneOracleTest(unittest.TestCase):
    generation = {"role": "main", "workspaceGeneration": 0, "attemptGeneration": 0}

    def test_marker_after_current_frame_uses_later_marker_receipt(self):
        oracle = tui_benchmark.StartupMilestoneOracle(tui_benchmark._prompt_matcher)
        oracle.observe_frame(
            committed_cells(
                (0, 0, "OC2"),
                (tui_benchmark.PROMPT_ROW, tui_benchmark.PROMPT_COLUMN, tui_benchmark.HOME_PLACEHOLDERS[0]),
            ),
            10,
        )
        oracle.observe_trace({"event": "prompt.mounted", **self.generation}, 30)

        self.assertEqual(oracle.first_frame_ms, 10)
        self.assertEqual(oracle.prompt_ms, 30)

    def test_frame_after_marker_uses_later_committed_frame_receipt(self):
        oracle = tui_benchmark.StartupMilestoneOracle(tui_benchmark._prompt_matcher)
        oracle.observe_trace({"event": "prompt.mounted", **self.generation}, 10)
        oracle.observe_frame(
            committed_cells(
                (0, 0, "OC2"),
                (tui_benchmark.PROMPT_ROW, tui_benchmark.PROMPT_COLUMN, tui_benchmark.HOME_PLACEHOLDERS[1]),
            ),
            30,
        )

        self.assertEqual(oracle.prompt_ms, 30)

    def test_shell_pairing_exists_without_inventing_a_slice_one_pipe_record(self):
        for marker_first in (False, True):
            with self.subTest(marker_first=marker_first):
                oracle = tui_benchmark.StartupMilestoneOracle(
                    lambda frame: frame.contains("Ask anything..."),
                    shell_matcher=lambda frame: frame.contains("Truthful startup shell"),
                )
                if marker_first:
                    oracle.observe_shell_drawn(0, 0, 11)
                    oracle.observe_frame(committed("Truthful startup shell"), 29)
                else:
                    oracle.observe_frame(committed("Truthful startup shell"), 11)
                    oracle.observe_shell_drawn(0, 0, 29)
                self.assertEqual(oracle.shell_ms, 29)

    def test_paint_erased_before_marker_never_counts(self):
        oracle = tui_benchmark.StartupMilestoneOracle(tui_benchmark._prompt_matcher)
        oracle.observe_frame(
            committed_cells(
                (0, 0, "OC2"),
                (tui_benchmark.PROMPT_ROW, tui_benchmark.PROMPT_COLUMN, tui_benchmark.HOME_PLACEHOLDERS[2]),
            ),
            10,
        )
        oracle.observe_frame(committed("OC2 loading"), 20)
        oracle.observe_trace({"event": "prompt.mounted", **self.generation}, 30)

        self.assertIsNone(oracle.prompt_ms)
        self.assertEqual(oracle.timeout_failure(TerminalScreen(100, 30)), "timeout_prompt_frame")

    def test_prompt_oracle_uses_compiled_home_fixture_cells_only(self):
        aligned = committed_cells(
            (tui_benchmark.PROMPT_ROW, 13, "┃"),
            (tui_benchmark.PROMPT_ROW, tui_benchmark.PROMPT_COLUMN, tui_benchmark.HOME_PLACEHOLDERS[0]),
        )
        self.assertEqual((tui_benchmark.PROMPT_ROW, tui_benchmark.PROMPT_COLUMN), (15, 16))
        self.assertEqual(
            aligned.cells[15][13:31],
            ("┃", " ", " ", "A", "s", "k", " ", "a", "n", "y", "t", "h", "i", "n", "g", ".", ".", "."),
        )
        self.assertTrue(tui_benchmark._prompt_matcher(aligned))
        self.assertFalse(
            tui_benchmark._prompt_matcher(
                committed_cells((tui_benchmark.PROMPT_ROW, tui_benchmark.PROMPT_COLUMN, "Ask anything..."))
            )
        )
        for row, column in ((15, 15), (15, 17), (14, 16), (16, 16), (0, 0)):
            with self.subTest(position=(row, column)):
                self.assertFalse(
                    tui_benchmark._prompt_matcher(committed_cells((row, column, tui_benchmark.HOME_PLACEHOLDERS[0])))
                )
        erased = committed_cells(
            (tui_benchmark.PROMPT_ROW, tui_benchmark.PROMPT_COLUMN, tui_benchmark.HOME_PLACEHOLDERS[0]),
            (tui_benchmark.PROMPT_ROW, tui_benchmark.PROMPT_COLUMN, " " * len(tui_benchmark.HOME_PLACEHOLDERS[0])),
        )
        self.assertFalse(tui_benchmark._prompt_matcher(erased))

    def test_first_frame_rejects_blank_diagnostic_only_and_fatal_cells(self):
        oracle = tui_benchmark.StartupMilestoneOracle(lambda frame: False)
        oracle.observe_frame(committed("Time to first draw: 1ms"), 1)
        self.assertIsNone(oracle.first_frame_ms)
        oracle.observe_frame(committed("OC2"), 2)
        self.assertEqual(oracle.first_frame_ms, 2)

        fatal = tui_benchmark.StartupMilestoneOracle(lambda frame: False)
        fatal.observe_frame(committed_cells((0, 0, "OC2 normal UI"), (20, 5, "Error: fixture-private-detail")), 3)
        self.assertEqual(fatal.failure, "terminal_fatal_diagnostic")
        self.assertNotIn("fixture-private-detail", fatal.failure)
        self.assertFalse(
            tui_benchmark._frame_has_fatal(
                committed_cells((0, 0, "Time to first draw: 1ms"), (20, 5, "OC2 normal UI text"))
            )
        )

    def test_generation_mismatch_and_duplicate_marker_fail_closed(self):
        oracle = tui_benchmark.StartupMilestoneOracle(lambda frame: True)
        oracle.observe_trace({"event": "prompt.mounted", **self.generation}, 1)
        oracle.observe_trace(
            {
                "event": "bootstrap.critical.ready",
                "role": "main",
                "workspaceGeneration": 0,
                "attemptGeneration": 1,
            },
            2,
        )
        self.assertEqual(oracle.failure, "trace_generation_mismatch")

        duplicate = tui_benchmark.StartupMilestoneOracle(lambda frame: True)
        duplicate.observe_trace({"event": "prompt.mounted", **self.generation}, 1)
        duplicate.observe_trace({"event": "prompt.mounted", **self.generation}, 2)
        self.assertEqual(duplicate.failure, "trace_duplicate_marker")


class BenchmarkMilestoneIntegrationTest(unittest.TestCase):
    def run_mode(self, mode, timeout=0.4, extra=()):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / "state"
            tui_benchmark.prepare_state(state)
            return tui_benchmark.run_once(
                [sys.executable, str(FAKE_TUI), mode, *extra],
                state,
                Path(directory),
                timeout,
                "none",
                b"Ask anything...",
            )

    def assert_success(self, result):
        self.assertIsNone(result["failure"])
        self.assertTrue(result["pty_handshake_ok"])
        self.assertEqual(result["ttfd_ms"], 12.5)
        self.assertIsNotNone(result["first_byte_ms"])
        self.assertIsNotNone(result["ready_ms"])
        self.assertIsNotNone(result["first_frame_ms"])
        self.assertIsNotNone(result["prompt_ms"])
        self.assertIsNotNone(result["critical_ready_ms"])
        self.assertIsNotNone(result["theme_settled_ms"])
        self.assertIsNone(result["shell_ms"])
        self.assertIsNone(result["interactive_ms"])
        self.assertEqual((result["workspace_generation"], result["attempt_generation"]), (0, 0))
        self.assertEqual(result["trace_records"], 4)

    def descendant_identity(self, pid_file):
        values = tuple(int(value) for value in pid_file.read_text(encoding="ascii").split())
        return values + (values[0],) * (3 - len(values))

    def assert_pid_gone(self, pid):
        deadline = time.monotonic() + 1
        while True:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                return
            if time.monotonic() >= deadline:
                self.fail("fake TUI descendant survived benchmark cleanup")
            time.sleep(0.01)

    def test_only_trace_writer_is_inheritable_and_environment_is_replaced(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            tui_benchmark.prepare_state(state)
            with mock.patch.dict(
                os.environ,
                {
                    "OC2_TUI_STARTUP_PROFILE": "stale",
                    "OC2_TUI_STARTUP_PROFILE_FD": "999",
                    "OC2_RUN_ID": "stale",
                    "OC2_TUI_STARTUP_PROFILE_WORKER": "1",
                },
            ):
                env = tui_benchmark.child_environment(state)
            self.assertFalse(any(key in env for key in (*tui_benchmark.TRACE_ENV_KEYS, "OC2_TUI_STARTUP_PROFILE_WORKER")))
            read_fd, write_fd = tui_benchmark._open_trace_pipe(env, "run_test")
            try:
                self.assertFalse(os.get_inheritable(read_fd))
                self.assertTrue(os.get_inheritable(write_fd))
                self.assertEqual(env["OC2_TUI_STARTUP_PROFILE"], "1")
                self.assertEqual(env["OC2_TUI_STARTUP_PROFILE_FD"], str(write_fd))
                self.assertEqual(env["OC2_RUN_ID"], "run_test")
            finally:
                os.close(read_fd)
                os.close(write_fd)

    def test_fragmented_trace_and_pty_reach_content_free_milestones(self):
        result = self.run_mode("success-fragmented", timeout=1)
        self.assert_success(result)
        serialized = json.dumps(result)
        self.assertNotIn("Ask anything", serialized)
        self.assertNotIn("Fix a TODO", serialized)
        self.assertNotIn("private", serialized)

    def test_reversed_marker_and_frame_order_use_the_later_receipt(self):
        marker_first = self.run_mode("success-marker-first")
        frame_first = self.run_mode("success-frame-first")
        self.assert_success(marker_first)
        self.assert_success(frame_first)

        self.assertGreaterEqual(marker_first["prompt_ms"], marker_first["critical_ready_ms"])
        self.assertGreaterEqual(frame_first["prompt_ms"], frame_first["first_frame_ms"])
        self.assertGreater(frame_first["prompt_ms"], frame_first["first_frame_ms"])
        self.assertNotEqual(marker_first["run_id"], frame_first["run_id"])

    def test_raw_prompt_bytes_and_paint_then_erase_do_not_count(self):
        for mode in ("raw-only", "paint-erase", "misaligned-prompt"):
            with self.subTest(mode=mode):
                result = self.run_mode(mode, timeout=0.18)
                self.assertEqual(result["failure"], "timeout_prompt_frame")
                self.assertIsNotNone(result["ready_ms"])
                self.assertIsNone(result["prompt_ms"])

    def test_named_early_exit_timeout_eof_unknown_desync_and_fatal_failures(self):
        cases = (
            ("early-exit", "child_exited_early"),
            ("timeout", "timeout_first_frame"),
            ("pty-eof", "pty_eof_before_milestones"),
            ("trace-eof", "trace_eof_before_milestones"),
            ("unknown-sequence", "terminal_unknown_sequence"),
            ("desynchronized", "terminal_desynchronized"),
            ("fatal-frame", "terminal_fatal_diagnostic"),
        )
        for mode, failure in cases:
            with self.subTest(mode=mode):
                result = self.run_mode(mode, timeout=0.16)
                self.assertEqual(result["failure"], failure)
                self.assertNotIn("private fixture detail", json.dumps(result))

    def test_cleanup_failure_is_named_after_resources_are_actually_stopped(self):
        original = tui_benchmark.stop_pty_child

        def stop_then_report(pid, fd):
            original(pid, fd)
            raise PtyCleanupError("injected descendant verification failure")

        with mock.patch.object(tui_benchmark, "stop_pty_child", side_effect=stop_then_report):
            result = self.run_mode("success-frame-first")
        self.assertEqual(result["failure"], "descendant_cleanup_failed")

    def test_escaped_descendant_cleanup_failure_is_named_without_leaking(self):
        original = tui_benchmark._cleanup_tracked_descendants

        def cleanup_then_report(records):
            self.assertTrue(original(records))
            return False

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state = root / "state"
            pid_file = root / "descendant.pid"
            tui_benchmark.prepare_state(state)
            with mock.patch.object(tui_benchmark, "_cleanup_tracked_descendants", side_effect=cleanup_then_report):
                result = tui_benchmark.run_once(
                    [
                        sys.executable,
                        str(FAKE_TUI),
                        "success-escaped-descendant",
                        "--pid-file",
                        str(pid_file),
                    ],
                    state,
                    root,
                    1,
                    "none",
                    b"Ask anything...",
                )
            self.assertEqual(result["failure"], "descendant_cleanup_failed")
            self.assert_pid_gone(self.descendant_identity(pid_file)[0])

    def test_process_group_cleanup_removes_stubborn_descendant(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state = root / "state"
            pid_file = root / "descendant.pid"
            tui_benchmark.prepare_state(state)
            result = tui_benchmark.run_once(
                [sys.executable, str(FAKE_TUI), "success-descendant", "--pid-file", str(pid_file)],
                state,
                root,
                1,
                "none",
                b"Ask anything...",
            )
            self.assert_success(result)
            descendant = self.descendant_identity(pid_file)[0]
            self.assert_pid_gone(descendant)

    def test_leader_exit_is_detected_while_descendant_holds_both_streams(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state = root / "state"
            pid_file = root / "descendant.pid"
            tui_benchmark.prepare_state(state)
            result = tui_benchmark.run_once(
                [sys.executable, str(FAKE_TUI), "early-exit-descendant", "--pid-file", str(pid_file)],
                state,
                root,
                0.5,
                "none",
                b"Ask anything...",
            )
            self.assertEqual(result["failure"], "child_exited_early")
            descendant = int(pid_file.read_text(encoding="ascii"))
            self.assert_pid_gone(descendant)

    def test_start_new_session_descendant_is_cleaned_after_success_timeout_and_early_exit(self):
        cases = (
            ("success-escaped-descendant", None, 1),
            ("timeout-escaped-descendant", "timeout_first_frame", 0.18),
            ("early-exit-escaped-descendant", "child_exited_early", 0.5),
        )
        for mode, failure, timeout in cases:
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                state = root / "state"
                pid_file = root / "descendant.pid"
                tui_benchmark.prepare_state(state)
                result = tui_benchmark.run_once(
                    [sys.executable, str(FAKE_TUI), mode, "--pid-file", str(pid_file)],
                    state,
                    root,
                    timeout,
                    "none",
                    b"Ask anything...",
                )
                self.assertEqual(result["failure"], failure)
                pid, group, session = self.descendant_identity(pid_file)
                self.assertEqual((group, session), (pid, pid))
                self.assert_pid_gone(pid)

    def test_start_new_session_descendant_is_cleaned_after_read_exception(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state = root / "state"
            pid_file = root / "descendant.pid"
            tui_benchmark.prepare_state(state)
            original = tui_benchmark.read_pty

            def fail_after_descendant(fd):
                if pid_file.exists():
                    raise RuntimeError("injected PTY read failure")
                return original(fd)

            with mock.patch.object(tui_benchmark, "read_pty", side_effect=fail_after_descendant):
                with self.assertRaisesRegex(RuntimeError, "injected PTY read failure"):
                    tui_benchmark.run_once(
                        [
                            sys.executable,
                            str(FAKE_TUI),
                            "exception-escaped-descendant",
                            "--pid-file",
                            str(pid_file),
                        ],
                        state,
                        root,
                        1,
                        "none",
                        b"Ask anything...",
                    )
            pid, group, session = self.descendant_identity(pid_file)
            self.assertEqual((group, session), (pid, pid))
            self.assert_pid_gone(pid)

    def test_legacy_cli_shape_and_fields_remain_available(self):
        parser = tui_benchmark.build_parser()
        args = parser.parse_args(
            [
                "--label",
                "legacy",
                "--samples",
                "1",
                "--mode",
                "warm",
                "--theme-response",
                "dark",
                "--ready-text",
                "ready",
                "--",
                "command",
            ]
        )
        self.assertEqual(args.command, ["--", "command"])

        result = self.run_mode("success-frame-first")
        for field in (
            "first_byte_ms",
            "ready_ms",
            "ttfd_ms",
            "bytes_until_ready",
            "timed_out",
            "pty_handshake_ok",
        ):
            self.assertIn(field, result)

    def test_invalid_sample_keeps_jsonl_record_and_returns_nonzero(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "result.jsonl"
            args = SimpleNamespace(
                label="failure",
                state_root=root / "states",
                keep_state=False,
                output=output,
                force=False,
                cwd=root,
                samples=1,
                mode="cold-like",
                timeout=1,
                theme_response="none",
                ready_text="Ask anything...",
                command=["--", "command"],
            )
            parser = mock.Mock()
            parser.parse_args.return_value = args
            invalid = tui_benchmark._empty_result("timeout_first_frame", True, "run_test")
            with mock.patch.object(tui_benchmark, "build_parser", return_value=parser):
                with mock.patch.object(tui_benchmark, "run_once", return_value=invalid):
                    self.assertEqual(tui_benchmark.main(), 1)
            records = [json.loads(line) for line in output.read_text(encoding="utf-8").splitlines()]
            self.assertEqual(records[0]["failure"], "timeout_first_frame")
            self.assertEqual(records[-1]["summary"]["valid"], 0)


if __name__ == "__main__":
    unittest.main()
