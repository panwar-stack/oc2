import errno
import json
import os
import subprocess
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


def encoded_raw_number(record, field, raw):
    text = json.dumps(record, separators=(",", ":"))
    original = f'"{field}":{json.dumps(record[field], separators=(",", ":"))}'
    replacement = f'"{field}":{raw}'
    if text.count(original) != 1:
        raise AssertionError(f"field replacement was ambiguous: {field}")
    return (text.replace(original, replacement) + "\n").encode("utf-8")


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
    def assert_schema_invalid_without_milestone(self, record):
        parser = tui_benchmark.TraceJsonlParser("run_test")
        oracle = tui_benchmark.StartupMilestoneOracle(tui_benchmark._prompt_matcher)
        with self.assertRaises(tui_benchmark.TraceFailure) as caught:
            parser.feed(encoded(record), 1)
        self.assertEqual(caught.exception.code, "trace_invalid_schema")
        self.assertEqual(parser.records, 0)
        self.assertIsNone(oracle.first_frame_ms)
        self.assertIsNone(oracle.prompt_ms)
        self.assertIsNone(oracle.critical_ready_ms)
        self.assertIsNone(oracle.theme_settled_ms)
        self.assertIsNone(oracle.failure)

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

    def test_every_record_shape_rejects_inexact_common_numeric_types(self):
        generation = {"role": "main", "workspaceGeneration": 0, "attemptGeneration": 0}
        records = (
            trace_record(0, "cli.entry", role="main"),
            trace_record(0, "phase", role="main", phase="renderer.create", outcome="ok", durationMs=1.25),
            trace_record(
                0,
                "rpc.request",
                role="main",
                requestID=1,
                request="config.providers",
                encodedBytes=10,
            ),
            trace_record(
                0,
                "rpc.response",
                role="main",
                requestID=1,
                request="config.providers",
                encodedBytes=10,
                removableDuplicateBytes=0,
            ),
            trace_record(
                0,
                "rpc.dispatch",
                role="worker",
                requestID=1,
                request="config.providers",
                durationMs=1.25,
            ),
            trace_record(0, "prompt.mounted", **generation),
            trace_record(0, "bootstrap.critical.ready", **generation),
            trace_record(0, "input.accepted", **generation),
            trace_record(0, "theme.reconciled", **generation),
            trace_record(0, "theme.settled", **generation, outcome="resolved"),
        )
        huge = 1 << 53
        common = {
            "version": (True, False, 1.0, -0.0, huge),
            "sequence": (True, False, 0.0, 1.0, -0.0, -1, (1 << 53)),
            "elapsedMs": (True, False, 0.0, 1.0, -0.0, -1, huge),
        }
        for record in records:
            for field, values in common.items():
                for value in values:
                    with self.subTest(event=record["event"], field=field, value=repr(value)[:24]):
                        malformed = dict(record)
                        malformed[field] = value
                        self.assert_schema_invalid_without_milestone(malformed)

    def test_integer_fields_reject_bool_float_negative_zero_and_oversize(self):
        huge = 1 << 53
        variants = (True, False, 0.0, 1.0, -0.0, -1, huge)
        records_and_fields = (
            (
                trace_record(
                    0,
                    "rpc.request",
                    role="main",
                    requestID=1,
                    request="config.providers",
                    encodedBytes=10,
                ),
                ("requestID", "encodedBytes"),
            ),
            (
                trace_record(
                    0,
                    "rpc.response",
                    role="main",
                    requestID=1,
                    request="config.providers",
                    encodedBytes=10,
                    removableDuplicateBytes=0,
                ),
                ("requestID", "encodedBytes", "removableDuplicateBytes"),
            ),
            (
                trace_record(
                    0,
                    "rpc.dispatch",
                    role="worker",
                    requestID=1,
                    request="config.providers",
                    durationMs=1.25,
                ),
                ("requestID",),
            ),
            (
                trace_record(
                    0,
                    "prompt.mounted",
                    role="main",
                    workspaceGeneration=0,
                    attemptGeneration=0,
                ),
                ("workspaceGeneration", "attemptGeneration"),
            ),
            (
                trace_record(
                    0,
                    "theme.settled",
                    role="main",
                    workspaceGeneration=0,
                    attemptGeneration=0,
                    outcome="resolved",
                ),
                ("workspaceGeneration", "attemptGeneration"),
            ),
        )
        for record, fields in records_and_fields:
            for field in fields:
                expected = record[field]
                for value in variants:
                    if type(value) is int and value == expected:
                        continue
                    with self.subTest(event=record["event"], field=field, value=repr(value)):
                        malformed = dict(record)
                        malformed[field] = value
                        self.assert_schema_invalid_without_milestone(malformed)

    def test_duration_fields_reject_bool_negative_zero_negative_and_unbounded_values(self):
        huge = 1 << 53
        for event, role in (("phase", "main"), ("rpc.dispatch", "worker")):
            record = (
                trace_record(0, event, role=role, phase="renderer.create", outcome="ok", durationMs=1.25)
                if event == "phase"
                else trace_record(
                    0,
                    event,
                    role=role,
                    requestID=1,
                    request="config.providers",
                    durationMs=1.25,
                )
            )
            for value in (True, False, 0.0, 1.0, -0.0, -1, huge):
                with self.subTest(event=event, value=repr(value)[:24]):
                    malformed = dict(record)
                    malformed["durationMs"] = value
                    self.assert_schema_invalid_without_milestone(malformed)

    def test_finite_positive_fractional_elapsed_and_duration_remain_schema_valid(self):
        parser = tui_benchmark.TraceJsonlParser("run_test")
        stream = encoded(
            {
                "version": 1,
                "runID": "run_test",
                "sequence": 0,
                "elapsedMs": 1.25,
                "event": "cli.entry",
                "role": "main",
            }
        ) + encoded(
            {
                "version": 1,
                "runID": "run_test",
                "sequence": 1,
                "elapsedMs": 2.5,
                "event": "phase",
                "role": "main",
                "phase": "renderer.create",
                "outcome": "ok",
                "durationMs": 1.25,
            }
        )
        self.assertEqual([record["event"] for record, _ in parser.feed(stream, 3.0)], ["cli.entry", "phase"])

    def test_every_record_shape_rejects_noncanonical_numeric_lexemes(self):
        generation = {"role": "main", "workspaceGeneration": 0, "attemptGeneration": 0}
        records = (
            trace_record(0, "cli.entry", role="main"),
            trace_record(0, "phase", role="main", phase="renderer.create", outcome="ok", durationMs=1.25),
            trace_record(
                0,
                "rpc.request",
                role="main",
                requestID=1,
                request="config.providers",
                encodedBytes=10,
            ),
            trace_record(
                0,
                "rpc.response",
                role="main",
                requestID=1,
                request="config.providers",
                encodedBytes=10,
                removableDuplicateBytes=0,
            ),
            trace_record(
                0,
                "rpc.dispatch",
                role="worker",
                requestID=1,
                request="config.providers",
                durationMs=1.25,
            ),
            trace_record(0, "prompt.mounted", **generation),
            trace_record(0, "bootstrap.critical.ready", **generation),
            trace_record(0, "input.accepted", **generation),
            trace_record(0, "theme.reconciled", **generation),
            trace_record(0, "theme.settled", **generation, outcome="resolved"),
        )
        common = {
            "version": ("1.0", "1e0", "-0"),
            "sequence": ("0.0", "0e0", "-0"),
            "elapsedMs": ("0.250", "2.50", "1e0", "-0", "-0.0", "1E-7", "1e-07", "1.0e-7"),
        }
        for record in records:
            for field, raw_values in common.items():
                for raw in raw_values:
                    with self.subTest(event=record["event"], field=field, raw=raw):
                        parser = tui_benchmark.TraceJsonlParser("run_test")
                        with self.assertRaises(tui_benchmark.TraceFailure) as caught:
                            parser.feed(encoded_raw_number(record, field, raw), 1)
                        self.assertEqual(caught.exception.code, "trace_invalid_schema")
                        self.assertEqual(parser.records, 0)

    def test_integer_semantic_fields_reject_decimal_exponent_and_negative_zero_lexemes(self):
        records_and_fields = (
            (
                trace_record(
                    0,
                    "rpc.request",
                    role="main",
                    requestID=1,
                    request="config.providers",
                    encodedBytes=10,
                ),
                ("requestID", "encodedBytes"),
            ),
            (
                trace_record(
                    0,
                    "rpc.response",
                    role="main",
                    requestID=1,
                    request="config.providers",
                    encodedBytes=10,
                    removableDuplicateBytes=0,
                ),
                ("requestID", "encodedBytes", "removableDuplicateBytes"),
            ),
            (
                trace_record(
                    0,
                    "prompt.mounted",
                    role="main",
                    workspaceGeneration=0,
                    attemptGeneration=0,
                ),
                ("workspaceGeneration", "attemptGeneration"),
            ),
        )
        for record, fields in records_and_fields:
            for field in fields:
                for raw in ("0.0", "1.0", "0e0", "1e0", "-0"):
                    with self.subTest(event=record["event"], field=field, raw=raw):
                        parser = tui_benchmark.TraceJsonlParser("run_test")
                        with self.assertRaises(tui_benchmark.TraceFailure) as caught:
                            parser.feed(encoded_raw_number(record, field, raw), 1)
                        self.assertEqual(caught.exception.code, "trace_invalid_schema")
                        self.assertEqual(parser.records, 0)

    def test_canonical_timing_integer_decimal_and_small_exponent_lexemes_are_valid(self):
        records = (
            trace_record(0, "cli.entry", role="main"),
            trace_record(0, "cli.entry", role="main"),
            trace_record(0, "cli.entry", role="main"),
        )
        raw_values = ("1", "0.25", "1e-7")
        for record, raw in zip(records, raw_values):
            with self.subTest(raw=raw):
                parser = tui_benchmark.TraceJsonlParser("run_test")
                parsed = parser.feed(encoded_raw_number(record, "elapsedMs", raw), 1)
                self.assertEqual(parsed[0][0]["event"], "cli.entry")

    def test_513th_record_limit_rejects_before_any_state_or_milestone_mutation(self):
        parser = tui_benchmark.TraceJsonlParser("run_test")
        oracle = tui_benchmark.StartupMilestoneOracle(tui_benchmark._prompt_matcher)
        parser.feed(encoded(trace_record(0, "cli.entry", role="main")), 1)
        for sequence in range(1, tui_benchmark.TRACE_MAX_RECORDS):
            record = trace_record(
                sequence,
                "phase",
                role="main",
                phase="renderer.create",
                outcome="ok",
                durationMs=1.25,
            )
            parser.feed(encoded(record), 1)
        rejected = trace_record(
            tui_benchmark.TRACE_MAX_RECORDS,
            "prompt.mounted",
            role="main",
            workspaceGeneration=0,
            attemptGeneration=0,
        )
        with self.assertRaises(tui_benchmark.TraceFailure) as caught:
            parser.feed(encoded(rejected), 1)
        self.assertEqual(caught.exception.code, "trace_record_limit")
        self.assertEqual(parser.records, tui_benchmark.TRACE_MAX_RECORDS)
        self.assertEqual(parser._sequence, tui_benchmark.TRACE_MAX_RECORDS)
        self.assertIsNone(oracle.prompt_ms)
        self.assertIsNone(oracle.failure)


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

    def run_supervision_setup_failure(self, target, side_effect):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state = root / "state"
            tui_benchmark.prepare_state(state)
            read_fd, write_fd = os.pipe()

            def fixed_pipe(env, run_id):
                os.set_inheritable(read_fd, False)
                os.set_inheritable(write_fd, True)
                env["OC2_TUI_STARTUP_PROFILE"] = "1"
                env["OC2_TUI_STARTUP_PROFILE_FD"] = str(write_fd)
                env["OC2_RUN_ID"] = run_id
                return read_fd, write_fd

            with mock.patch.object(tui_benchmark, "_open_trace_pipe", side_effect=fixed_pipe):
                with mock.patch.object(
                    tui_benchmark.secrets,
                    "token_hex",
                    side_effect=("a" * 32, "b" * 48),
                ):
                    with mock.patch.object(target[0], target[1], side_effect=side_effect):
                        result = tui_benchmark.run_once(
                            [sys.executable, str(FAKE_TUI), "timeout"],
                            state,
                            root,
                            1,
                            "none",
                            b"Ask anything...",
                        )
            self.assertEqual(result["failure"], "supervision_setup_failed")
            self.assertEqual(tui_benchmark._token_processes("supervision_" + "b" * 48), {})
            for descriptor in (read_fd, write_fd):
                with self.assertRaises(OSError) as caught:
                    os.fstat(descriptor)
                self.assertEqual(caught.exception.errno, errno.EBADF)

    def test_supervision_constructor_and_start_failures_are_named_and_clean(self):
        self.run_supervision_setup_failure(
            (tui_benchmark, "ChildExitObserver"),
            RuntimeError("injected exit observer constructor failure"),
        )
        self.run_supervision_setup_failure(
            (tui_benchmark, "DescendantSupervisor"),
            RuntimeError("injected descendant supervisor constructor failure"),
        )
        self.run_supervision_setup_failure(
            (tui_benchmark.DescendantSupervisor, "start"),
            RuntimeError("injected descendant supervisor start failure"),
        )

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
                    "OC2_TUI_BENCHMARK_SUPERVISION_TOKEN": "stale",
                },
            ):
                env = tui_benchmark.child_environment(state)
            self.assertFalse(
                any(
                    key in env
                    for key in (
                        *tui_benchmark.TRACE_ENV_KEYS,
                        "OC2_TUI_STARTUP_PROFILE_WORKER",
                        tui_benchmark.SUPERVISION_ENV,
                    )
                )
            )
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

    def test_token_enumerator_matches_exact_same_uid_environment_value(self):
        token = "supervision_test_exact"
        exact_env = os.environ.copy()
        exact_env[tui_benchmark.SUPERVISION_ENV] = token
        near_env = os.environ.copy()
        near_env[tui_benchmark.SUPERVISION_ENV] = token + "_other"
        exact = subprocess.Popen([sys.executable, "-c", "import time;time.sleep(5)"], env=exact_env, start_new_session=True)
        near = subprocess.Popen([sys.executable, "-c", "import time;time.sleep(5)"], env=near_env, start_new_session=True)
        try:
            deadline = time.monotonic() + 1
            while True:
                matches = tui_benchmark._token_processes(token)
                if exact.pid in matches:
                    break
                if time.monotonic() >= deadline:
                    self.fail("exact supervision token was not discoverable")
                time.sleep(0.01)
            self.assertNotIn(near.pid, matches)
        finally:
            for process in (exact, near):
                process.terminate()
                process.wait()

    def test_token_enumerator_fails_closed_on_unsupported_host(self):
        with mock.patch.object(tui_benchmark.sys, "platform", "unsupported"):
            with mock.patch.object(tui_benchmark, "_numeric_process_table", return_value={}):
                with self.assertRaisesRegex(OSError, "unsupported"):
                    tui_benchmark._token_processes("supervision_test")

    def test_supervision_token_is_child_only_and_never_reported(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state = root / "state"
            token_file = root / "token"
            tui_benchmark.prepare_state(state)
            with mock.patch.dict(os.environ, {tui_benchmark.SUPERVISION_ENV: "stale_parent_value"}):
                result = tui_benchmark.run_once(
                    [sys.executable, str(FAKE_TUI), "success-frame-first", "--token-file", str(token_file)],
                    state,
                    root,
                    1,
                    "none",
                    b"Ask anything...",
                )
                self.assertEqual(os.environ[tui_benchmark.SUPERVISION_ENV], "stale_parent_value")
            self.assert_success(result)
            token = token_file.read_text(encoding="ascii")
            self.assertRegex(token, r"^supervision_[0-9a-f]{48}$")
            self.assertNotIn(token, json.dumps(result))

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
                result = self.run_mode(mode, timeout=0.6)
                self.assertEqual(result["failure"], "timeout_prompt_frame")
                self.assertIsNotNone(result["ready_ms"])
                self.assertIsNone(result["prompt_ms"])

    def test_named_early_exit_timeout_eof_unknown_desync_and_fatal_failures(self):
        cases = (
            ("early-exit", "child_exited_early", 0.6),
            ("timeout", "timeout_first_frame", 0.6),
            ("pty-eof", "pty_eof_before_milestones", 0.6),
            ("trace-eof", "trace_eof_before_milestones", 0.6),
            ("unknown-sequence", "terminal_unknown_sequence", 0.6),
            ("desynchronized", "terminal_desynchronized", 0.6),
            ("fatal-frame", "terminal_fatal_diagnostic", 0.6),
        )
        for mode, failure, timeout in cases:
            with self.subTest(mode=mode):
                result = self.run_mode(mode, timeout=timeout)
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
                1,
                "none",
                b"Ask anything...",
            )
            self.assertEqual(result["failure"], "child_exited_early")
            descendant = int(pid_file.read_text(encoding="ascii"))
            self.assert_pid_gone(descendant)

    def test_start_new_session_descendant_is_cleaned_after_success_timeout_and_early_exit(self):
        cases = (
            ("success-escaped-descendant", None, 1),
            ("timeout-escaped-descendant", "timeout_first_frame", 0.6),
            ("early-exit-escaped-descendant", "child_exited_early", 1),
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

    def test_token_authority_cleans_60_to_90ms_reparent_stress_without_ancestry(self):
        for delay in (60, 75, 90):
            with self.subTest(delay=delay), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                state = root / "state"
                pid_file = root / "descendant.pid"
                tui_benchmark.prepare_state(state)
                with mock.patch.object(tui_benchmark.DescendantSupervisor, "_scan", return_value=None):
                    result = tui_benchmark.run_once(
                        [
                            sys.executable,
                            str(FAKE_TUI),
                            "early-exit-escaped-descendant",
                            "--pid-file",
                            str(pid_file),
                            "--exit-delay-ms",
                            str(delay),
                        ],
                        state,
                        root,
                        1,
                        "none",
                        b"Ask anything...",
                    )
                self.assertEqual(result["failure"], "child_exited_early")
                pid, group, session = self.descendant_identity(pid_file)
                self.assertEqual((group, session), (pid, pid))
                self.assert_pid_gone(pid)

    def test_emergency_token_cleanup_survives_true_pre_signal_exception(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state = root / "state"
            pid_file = root / "descendant.pid"
            token_file = root / "token"
            tui_benchmark.prepare_state(state)
            with mock.patch.object(
                tui_benchmark,
                "stop_pty_child",
                side_effect=PtyCleanupError("injected before any signal"),
            ):
                result = tui_benchmark.run_once(
                    [
                        sys.executable,
                        str(FAKE_TUI),
                        "success-escaped-descendant",
                        "--pid-file",
                        str(pid_file),
                        "--token-file",
                        str(token_file),
                    ],
                    state,
                    root,
                    1,
                    "none",
                    b"Ask anything...",
                )
            self.assertEqual(result["failure"], "descendant_cleanup_failed")
            self.assertEqual(tui_benchmark._token_processes(token_file.read_text(encoding="ascii")), {})
            self.assert_pid_gone(self.descendant_identity(pid_file)[0])

    def test_emergency_token_cleanup_survives_primary_cleanup_exception(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state = root / "state"
            pid_file = root / "descendant.pid"
            token_file = root / "token"
            tui_benchmark.prepare_state(state)
            with mock.patch.object(
                tui_benchmark,
                "_cleanup_tracked_descendants",
                side_effect=RuntimeError("injected primary cleanup failure"),
            ):
                result = tui_benchmark.run_once(
                    [
                        sys.executable,
                        str(FAKE_TUI),
                        "success-escaped-descendant",
                        "--pid-file",
                        str(pid_file),
                        "--token-file",
                        str(token_file),
                    ],
                    state,
                    root,
                    1,
                    "none",
                    b"Ask anything...",
                )
            self.assertEqual(result["failure"], "descendant_cleanup_failed")
            self.assertEqual(tui_benchmark._token_processes(token_file.read_text(encoding="ascii")), {})
            self.assert_pid_gone(self.descendant_identity(pid_file)[0])

    def test_trace_batch_cannot_shadow_descendants_when_finish_raises(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state = root / "state"
            pid_file = root / "descendant.pid"
            token_file = root / "token"
            tui_benchmark.prepare_state(state)
            with mock.patch.object(
                tui_benchmark.DescendantSupervisor,
                "finish",
                side_effect=RuntimeError("injected finish failure after trace tuple"),
            ):
                result = tui_benchmark.run_once(
                    [
                        sys.executable,
                        str(FAKE_TUI),
                        "success-escaped-descendant",
                        "--pid-file",
                        str(pid_file),
                        "--token-file",
                        str(token_file),
                    ],
                    state,
                    root,
                    1,
                    "none",
                    b"Ask anything...",
                )
            self.assertEqual(result["failure"], "descendant_tracking_failed")
            token = token_file.read_text(encoding="ascii")
            self.assertEqual(tui_benchmark._token_processes(token), {})
            self.assert_pid_gone(self.descendant_identity(pid_file)[0])

    def test_snapshot_timeout_retries_independently_and_reports_tracking_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state = root / "state"
            pid_file = root / "descendant.pid"
            token_file = root / "token"
            tui_benchmark.prepare_state(state)
            original = tui_benchmark._token_processes
            calls = 0

            def timeout_once(token):
                nonlocal calls
                calls += 1
                if calls == 1:
                    raise subprocess.TimeoutExpired(["ps"], 0.5)
                return original(token)

            with mock.patch.object(tui_benchmark.DescendantSupervisor, "_scan", return_value=None):
                with mock.patch.object(tui_benchmark, "_token_processes", side_effect=timeout_once):
                    result = tui_benchmark.run_once(
                        [
                            sys.executable,
                            str(FAKE_TUI),
                            "success-escaped-descendant",
                            "--pid-file",
                            str(pid_file),
                            "--token-file",
                            str(token_file),
                        ],
                        state,
                        root,
                        1,
                        "none",
                        b"Ask anything...",
                    )
            self.assertEqual(result["failure"], "descendant_tracking_failed")
            self.assertGreaterEqual(calls, 3)
            self.assertEqual(original(token_file.read_text(encoding="ascii")), {})
            self.assert_pid_gone(self.descendant_identity(pid_file)[0])

    def test_signal_spawned_detached_token_child_is_reenumerated_and_cleaned(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state = root / "state"
            pid_file = root / "descendant.pid"
            spawned_pid_file = root / "spawned.pid"
            token_file = root / "token"
            tui_benchmark.prepare_state(state)
            result = tui_benchmark.run_once(
                [
                    sys.executable,
                    str(FAKE_TUI),
                    "success-signal-spawn-descendant",
                    "--pid-file",
                    str(pid_file),
                    "--spawned-pid-file",
                    str(spawned_pid_file),
                    "--token-file",
                    str(token_file),
                ],
                state,
                root,
                1,
                "none",
                b"Ask anything...",
            )
            self.assert_success(result)
            self.assertTrue(spawned_pid_file.exists())
            self.assert_pid_gone(self.descendant_identity(pid_file)[0])
            self.assert_pid_gone(self.descendant_identity(spawned_pid_file)[0])
            self.assertEqual(tui_benchmark._token_processes(token_file.read_text(encoding="ascii")), {})

    def test_emergency_sanitizes_trace_tuple_and_still_kills_root(self):
        token = "supervision_malformed_known"
        env = os.environ.copy()
        env[tui_benchmark.SUPERVISION_ENV] = token
        child = subprocess.Popen(
            [sys.executable, "-c", "import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(60)"],
            env=env,
            start_new_session=True,
        )
        malformed_trace_tuple = (({"event": "cli.entry"}, 1.25),)
        enumerated, cleaned = tui_benchmark._emergency_token_cleanup(
            token,
            child.pid,
            (child.pid, child.pid),
            malformed_trace_tuple,
        )
        self.assertTrue(enumerated)
        self.assertTrue(cleaned)
        child.returncode = 0
        self.assertEqual(tui_benchmark._token_processes(token), {})
        self.assert_pid_gone(child.pid)

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

    def test_read_failure_remains_primary_when_cleanup_also_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state = root / "state"
            token_file = root / "token"
            tui_benchmark.prepare_state(state)
            original = tui_benchmark.read_pty

            def fail_after_start(fd):
                if token_file.exists():
                    raise RuntimeError("primary PTY read failure")
                return original(fd)

            with mock.patch.object(tui_benchmark, "read_pty", side_effect=fail_after_start):
                with mock.patch.object(
                    tui_benchmark,
                    "stop_pty_child",
                    side_effect=PtyCleanupError("secondary cleanup failure"),
                ):
                    with self.assertRaisesRegex(RuntimeError, "primary PTY read failure"):
                        tui_benchmark.run_once(
                            [
                                sys.executable,
                                str(FAKE_TUI),
                                "exception-escaped-descendant",
                                "--pid-file",
                                str(root / "descendant.pid"),
                                "--token-file",
                                str(token_file),
                            ],
                            state,
                            root,
                            1,
                            "none",
                            b"Ask anything...",
                        )
            self.assertEqual(tui_benchmark._token_processes(token_file.read_text(encoding="ascii")), {})

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
