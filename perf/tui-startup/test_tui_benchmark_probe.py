import argparse
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import tui_benchmark
from terminal_screen import TerminalScreen


HERE = Path(__file__).resolve().parent
FAKE_TUI = HERE / "fake_tui.py"
GENERATION = {"role": "main", "workspaceGeneration": 0, "attemptGeneration": 0}


def committed_cells(*placements):
    screen = TerminalScreen(100, 30)
    body = bytearray(b"\x1b[?2026h\x1b[2J\x1b[H")
    for row, column, text in placements:
        body.extend(f"\x1b[{row + 1};{column + 1}H".encode("ascii"))
        body.extend(text.encode("ascii"))
    body.extend(b"\x1b[?2026l")
    return screen.feed(bytes(body))[-1]


class ThemeFixtureTest(unittest.TestCase):
    def test_parser_accepts_only_controlled_fixture_shapes(self):
        for kind in ("dark", "light", "none", "malformed"):
            self.assertEqual(tui_benchmark.parse_theme_response(kind), tui_benchmark.ThemeFixture(kind))
        self.assertEqual(
            tui_benchmark.parse_theme_response("late:1250"),
            tui_benchmark.ThemeFixture("late", 1250),
        )
        for invalid in ("", "late", "late:0", "late:-1", "late:1.5", "DARK", "other"):
            with self.subTest(invalid=invalid), self.assertRaises(argparse.ArgumentTypeError):
                tui_benchmark.parse_theme_response(invalid)

    def test_responder_uses_exact_colors_and_answers_duplicate_queries(self):
        expected = {
            "dark": (
                b"\x1b]10;rgb:ffff/ffff/ffff\x07",
                b"\x1b]11;rgb:0000/0000/0000\x07",
            ),
            "light": (
                b"\x1b]10;rgb:0000/0000/0000\x07",
                b"\x1b]11;rgb:ffff/ffff/ffff\x07",
            ),
        }
        for kind, responses in expected.items():
            with self.subTest(kind=kind):
                responder = tui_benchmark.ThemeResponder(9, tui_benchmark.ThemeFixture(kind))
                with mock.patch.object(tui_benchmark, "_write_pty_input") as write:
                    responder.observe((10, 11, 10), 5.0)
                    responder.flush_due(5.0)
                self.assertEqual(
                    [call.args[1] for call in write.call_args_list],
                    [responses[0], responses[1], responses[0]],
                )
                self.assertEqual((responder.foreground_queries, responder.background_queries), (2, 1))
                self.assertEqual((responder.foreground_responses, responder.background_responses), (2, 1))

    def test_none_malformed_and_late_are_bounded_and_due_without_new_output(self):
        with mock.patch.object(tui_benchmark, "_write_pty_input") as write:
            none = tui_benchmark.ThemeResponder(9, tui_benchmark.ThemeFixture("none"))
            none.observe((10, 11), 1.0)
            self.assertIsNone(none.next_deadline())
            write.assert_not_called()

            malformed = tui_benchmark.ThemeResponder(9, tui_benchmark.ThemeFixture("malformed"))
            malformed.observe((10, 11, 10), 2.0)
            malformed.flush_due(2.0)
            self.assertEqual(write.call_count, 1)
            self.assertEqual(write.call_args.args[1], b"\x1b]10;rgb:not-a-color\x07")

        late = tui_benchmark.ThemeResponder(9, tui_benchmark.ThemeFixture("late", 125))
        with mock.patch.object(tui_benchmark, "_write_pty_input") as write:
            late.observe((10,), 10.0)
            self.assertEqual(late.next_deadline(), 10.125)
            late.flush_due(10.124)
            write.assert_not_called()
            late.flush_due(10.125)
            write.assert_called_once_with(9, b"\x1b]10;rgb:ffff/ffff/ffff\x07")


class OscQueryParserTest(unittest.TestCase):
    def test_every_two_fragment_split_accepts_bel_and_st_queries(self):
        for terminator in (b"\x07", b"\x1b\\"):
            query = b"before\x1b]10;?" + terminator + b"after"
            for split in range(len(query) + 1):
                with self.subTest(terminator=terminator, split=split):
                    parser = tui_benchmark.OscQueryParser()
                    observed = parser.feed(query[:split]) + parser.feed(query[split:])
                    self.assertEqual(observed, (10,))

    def test_single_byte_fragments_and_duplicate_queries_remain_independent(self):
        stream = b"\x1b]10;?\x07\x1b]11;?\x1b\\\x1b]10;?\x07"
        parser = tui_benchmark.OscQueryParser()
        observed = []
        for value in stream:
            observed.extend(parser.feed(bytes((value,))))
        self.assertEqual(observed, [10, 11, 10])
        self.assertEqual(parser.query_count, 3)

    def test_unrelated_malformed_oversize_and_truncated_osc_are_ignored(self):
        parser = tui_benchmark.OscQueryParser()
        self.assertEqual(parser.feed(b"\x1b]12;?\x07"), ())
        self.assertEqual(parser.feed(b"\x1b]10;?\x1bXignored\x07"), ())
        self.assertEqual(parser.feed(b"\x1b]" + b"x" * 300 + b"\x07"), ())
        self.assertEqual(parser.feed(b"\x1b]10;?"), ())

        recovered = tui_benchmark.OscQueryParser()
        stream = b"\x1b]" + b"x" * 300 + b"\x07\x1b]11;?\x07"
        self.assertEqual(recovered.feed(stream), (11,))

    def test_query_limit_fails_before_the_sixty_fifth_query(self):
        parser = tui_benchmark.OscQueryParser()
        for _ in range(tui_benchmark.OSC_MAX_QUERY_COUNT):
            self.assertEqual(parser.feed(b"\x1b]10;?\x07"), (10,))
        with self.assertRaises(tui_benchmark.ProbeFailure) as caught:
            parser.feed(b"\x1b]10;?\x07")
        self.assertEqual(caught.exception.code, "osc_query_limit")


class InteractionProbeOracleTest(unittest.TestCase):
    body = "oc2latency" + "a" * 32
    placeholder = tui_benchmark.HOME_PLACEHOLDERS[0]

    def prompt_frame(self):
        return committed_cells(
            (0, 0, "OC2"),
            (tui_benchmark.PROMPT_ROW, tui_benchmark.PROMPT_COLUMN, self.placeholder),
        )

    def token_frame(self, value):
        return committed_cells(
            (0, 0, "OC2"),
            (tui_benchmark.PROMPT_ROW, tui_benchmark.PROMPT_COLUMN, value),
        )

    def test_guard_waits_for_current_acceptance_critical_and_theme_then_removes_exactly(self):
        oracle = tui_benchmark.InteractionProbeOracle(tui_benchmark.ThemeFixture("dark"), self.body)
        oracle.observe_frame(self.prompt_frame(), 1)
        oracle.observe_trace({"event": "prompt.mounted", **GENERATION}, 2)
        oracle.confirm_noecho()
        self.assertEqual(oracle.mark_body_sent(), self.body.encode("ascii"))
        oracle.observe_trace({"event": "input.accepted", **GENERATION}, 3)
        oracle.observe_frame(self.token_frame(self.body), 4)
        self.assertFalse(oracle.guard_ready())
        oracle.observe_trace({"event": "bootstrap.critical.ready", **GENERATION}, 5)
        self.assertFalse(oracle.guard_ready())
        oracle.observe_trace({"event": "theme.settled", **GENERATION, "outcome": "resolved"}, 6)
        self.assertTrue(oracle.guard_ready())
        self.assertEqual(oracle.mark_guard_sent(), b"z")
        with mock.patch.object(tui_benchmark.time, "monotonic", return_value=20.0):
            oracle.observe_frame(self.token_frame(self.body + "z"), 7)
        self.assertEqual(oracle.interactive_ms, 7)
        oracle.advance(20.099)
        self.assertFalse(oracle.persistence_verified)
        oracle.advance(20.1)
        self.assertTrue(oracle.persistence_verified)
        removal = oracle.mark_removal_sent()
        self.assertEqual(removal, b"\x7f" * len(self.body + "z"))
        self.assertEqual(oracle.backspace_count, len(self.body + "z"))
        oracle.observe_frame(self.prompt_frame(), 8)
        self.assertTrue(oracle.complete)

    def test_reconciliation_requires_a_new_committed_token_frame(self):
        oracle = tui_benchmark.InteractionProbeOracle(tui_benchmark.ThemeFixture("dark"), self.body)
        oracle.observe_frame(self.prompt_frame(), 1)
        oracle.observe_trace({"event": "prompt.mounted", **GENERATION}, 2)
        oracle.confirm_noecho()
        oracle.mark_body_sent()
        oracle.observe_trace({"event": "input.accepted", **GENERATION}, 3)
        oracle.observe_frame(self.token_frame(self.body), 4)
        oracle.observe_trace({"event": "bootstrap.critical.ready", **GENERATION}, 5)
        oracle.observe_trace({"event": "theme.settled", **GENERATION, "outcome": "resolved"}, 6)
        oracle.mark_guard_sent()
        with mock.patch.object(tui_benchmark.time, "monotonic", return_value=20.0):
            oracle.observe_frame(self.token_frame(self.body + "z"), 7)
        self.assertIsNotNone(oracle.next_deadline())

        oracle.observe_trace({"event": "theme.reconciled", **GENERATION}, 8)
        self.assertEqual(oracle.reconciliation_count, 1)
        self.assertEqual(oracle.verified_reconciliation_count, 0)
        self.assertIsNone(oracle.next_deadline())
        oracle.advance(999)
        self.assertFalse(oracle.persistence_verified)
        self.assertEqual(oracle.timeout_failure(), "timeout_theme_reconciled")

        with mock.patch.object(tui_benchmark.time, "monotonic", return_value=30.0):
            oracle.observe_frame(self.token_frame(self.body + "z"), 9)
        self.assertEqual(oracle.verified_reconciliation_count, 1)
        self.assertEqual(oracle.next_deadline(), 30.1)

    def test_reconciliation_after_persistence_restarts_proof_before_removal(self):
        oracle = tui_benchmark.InteractionProbeOracle(tui_benchmark.ThemeFixture("dark"), self.body)
        oracle.observe_frame(self.prompt_frame(), 1)
        oracle.observe_trace({"event": "prompt.mounted", **GENERATION}, 2)
        oracle.confirm_noecho()
        oracle.mark_body_sent()
        oracle.observe_trace({"event": "input.accepted", **GENERATION}, 3)
        oracle.observe_frame(self.token_frame(self.body), 4)
        oracle.observe_trace({"event": "bootstrap.critical.ready", **GENERATION}, 5)
        oracle.observe_trace({"event": "theme.settled", **GENERATION, "outcome": "resolved"}, 6)
        oracle.mark_guard_sent()
        with mock.patch.object(tui_benchmark.time, "monotonic", return_value=20.0):
            oracle.observe_frame(self.token_frame(self.body + "z"), 7)
        oracle.advance(20.1)
        self.assertTrue(oracle.persistence_verified)
        self.assertTrue(oracle.removal_ready)

        oracle.observe_trace({"event": "theme.reconciled", **GENERATION}, 8)
        self.assertFalse(oracle.persistence_verified)
        self.assertFalse(oracle.removal_ready)
        with mock.patch.object(tui_benchmark.time, "monotonic", return_value=30.0):
            oracle.observe_frame(self.token_frame(self.body + "z"), 9)
        oracle.advance(30.1)
        self.assertTrue(oracle.persistence_verified)
        self.assertTrue(oracle.removal_ready)

        oracle.mark_removal_sent()
        oracle.observe_trace({"event": "theme.reconciled", **GENERATION}, 10)
        self.assertEqual(oracle.failure, "theme_reconciled_after_probe_removal")

    def test_overlapping_reconciliations_fail_before_one_frame_can_verify_both(self):
        oracle = tui_benchmark.InteractionProbeOracle(tui_benchmark.ThemeFixture("late", 125), self.body)
        oracle.observe_trace(
            {"event": "theme.settled", **GENERATION, "outcome": "fallback-final"},
            1,
        )
        oracle.observe_trace({"event": "theme.reconciled", **GENERATION}, 2)
        oracle.observe_trace({"event": "theme.reconciled", **GENERATION}, 3)
        self.assertEqual(oracle.failure, "theme_reconciliation_overlap")
        self.assertEqual(oracle.verified_reconciliation_count, 0)

    def test_mixed_generations_fail_closed_before_guard(self):
        oracle = tui_benchmark.InteractionProbeOracle(tui_benchmark.ThemeFixture("none"), self.body)
        oracle.observe_trace({"event": "prompt.mounted", **GENERATION}, 1)
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
        self.assertFalse(oracle.guard_ready())


class BenchmarkProbeIntegrationTest(unittest.TestCase):
    def run_probe(self, theme="dark", timeout=1.5, enabled=True, extra=()):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state = root / "state"
            capture = root / "capture.json"
            tui_benchmark.prepare_state(state)
            result = tui_benchmark.run_once(
                [sys.executable, str(FAKE_TUI), "probe", "--capture-file", str(capture), *extra],
                state,
                root,
                timeout,
                theme,
                b"Ask anything...",
                enabled,
            )
            evidence = json.loads(capture.read_text(encoding="utf-8"))
            return result, evidence

    def assert_success(self, result, outcome):
        self.assertIsNone(result["failure"])
        self.assertEqual(result["theme_settled_outcome"], outcome)
        self.assertIsNotNone(result["interactive_ms"])
        self.assertIsNotNone(result["input_accepted_ms"])
        self.assertTrue(result["probe_body_visible"])
        self.assertTrue(result["probe_noecho_verified"])
        self.assertTrue(result["probe_guard_sent"])
        self.assertTrue(result["probe_persistence_verified"])
        self.assertTrue(result["probe_removal_verified"])
        self.assertEqual(result["probe_backspace_count"], len("oc2latency" + "a" * 32 + "z"))
        self.assertTrue(result["theme_activity_verified"])

    def test_immediate_dark_and_light_fixtures_complete(self):
        for theme in ("dark", "light"):
            with self.subTest(theme=theme):
                result, evidence = self.run_probe(theme)
                self.assert_success(result, "resolved")
                self.assertEqual(evidence["theme_pair"], theme)
                self.assertEqual((result["foreground_response_count"], result["background_response_count"]), (1, 1))

    def test_none_fragmented_st_and_malformed_fixtures_complete(self):
        none, _ = self.run_probe("none", extra=("--query-terminator", "st", "--query-fragmented"))
        self.assert_success(none, "fallback-final")
        self.assertEqual((none["foreground_query_count"], none["background_query_count"]), (1, 1))
        self.assertEqual((none["foreground_response_count"], none["background_response_count"]), (0, 0))

        malformed, _ = self.run_probe("malformed")
        self.assert_success(malformed, "fallback-final")
        self.assertEqual(
            malformed["foreground_response_count"] + malformed["background_response_count"],
            1,
        )

    def test_marker_first_and_frame_first_send_body_only_after_both(self):
        for order in ("marker-first", "frame-first"):
            with self.subTest(order=order):
                result, evidence = self.run_probe("dark", extra=("--prompt-order", order))
                self.assert_success(result, "resolved")
                self.assertTrue(evidence["body_shape_valid"])
                self.assertEqual(evidence["body_byte_count"], 42)

    def test_late_reconciliation_resets_window_and_exact_removal_is_content_free(self):
        result, evidence = self.run_probe("late:125")
        self.assert_success(result, "fallback-final")
        self.assertEqual(result["theme_reconciliation_count"], 1)
        self.assertEqual(result["probe_verified_reconciliation_count"], 1)
        self.assertEqual(evidence["backspace_count"], 43)
        self.assertEqual(evidence["guard_count"], 1)
        self.assertEqual(evidence["enter_count"], 0)
        self.assertEqual(evidence["other_control_count"], 0)
        serialized = json.dumps({"result": result, "evidence": evidence})
        self.assertNotIn("oc2latency", serialized)
        self.assertNotRegex(serialized, r"[0-9a-f]{32}z")

    def test_reconciliation_at_persistence_boundary_is_drained_before_removal(self):
        result, evidence = self.run_probe(
            "late:125",
            extra=("--reconcile-near-persistence-boundary",),
        )
        self.assert_success(result, "fallback-final")
        self.assertEqual(result["theme_reconciliation_count"], 2)
        self.assertEqual(result["probe_verified_reconciliation_count"], 2)
        self.assertEqual(result["probe_backspace_count"], 43)
        self.assertEqual(evidence["backspace_count"], 43)

    def test_probe_disabled_preserves_null_metric_and_sends_no_input(self):
        result, evidence = self.run_probe("dark", enabled=False)
        self.assertIsNone(result["failure"])
        self.assertIsNone(result["interactive_ms"])
        self.assertFalse(result["probe_guard_sent"])
        self.assertEqual(evidence["body_byte_count"], 0)
        self.assertEqual(evidence["guard_count"], 0)
        self.assertEqual(evidence["backspace_count"], 0)

    def test_wrong_cell_rejected_and_erased_input_never_count(self):
        cases = (
            ("echo-lookalike", "timeout_probe_body_frame"),
            ("reject", "timeout_probe_body_frame"),
            ("erase", "probe_erased_before_ready"),
        )
        for behavior, failure in cases:
            with self.subTest(behavior=behavior):
                result, _ = self.run_probe("dark", timeout=0.45, extra=("--input-behavior", behavior))
                self.assertEqual(result["failure"], failure)
                self.assertIsNone(result["interactive_ms"])
                self.assertFalse(result["probe_removal_verified"])

    def test_missing_or_erasing_reconciliation_and_bad_restoration_fail_closed(self):
        missing, _ = self.run_probe("late:1000", timeout=0.45)
        self.assertEqual(missing["failure"], "timeout_theme_reconciled")

        erased, _ = self.run_probe(
            "late:125",
            timeout=0.6,
            extra=("--input-behavior", "reconcile-erase"),
        )
        self.assertEqual(erased["failure"], "probe_erased_during_persistence")

        mismatch, evidence = self.run_probe(
            "dark",
            timeout=0.6,
            extra=("--input-behavior", "bad-restore"),
        )
        self.assertEqual(mismatch["failure"], "probe_original_content_mismatch")
        self.assertEqual(evidence["backspace_count"], 43)
        self.assertFalse(mismatch["probe_removal_verified"])

    def test_reconciliation_marker_without_a_later_commit_fails_closed(self):
        result, _ = self.run_probe(
            "late:125",
            timeout=0.6,
            extra=("--suppress-reconcile-redraw",),
        )
        self.assertEqual(result["failure"], "timeout_theme_reconciled")
        self.assertEqual(result["theme_reconciliation_count"], 1)
        self.assertEqual(result["probe_verified_reconciliation_count"], 0)
        self.assertFalse(result["probe_persistence_verified"])

    def test_true_pty_echo_mode_at_textarea_is_rejected_before_nonce_injection(self):
        result, evidence = self.run_probe(
            "none",
            timeout=0.45,
            extra=("--leave-echo-enabled",),
        )
        self.assertEqual(result["failure"], "probe_terminal_echo_enabled")
        self.assertFalse(result["probe_noecho_verified"])
        self.assertFalse(result["probe_body_visible"])
        self.assertEqual(evidence["body_byte_count"], 0)
        self.assertEqual(evidence["guard_count"], 0)
        self.assertEqual(evidence["input_mode"], "noncanonical-echo")
        self.assertEqual(evidence["renderer_token_redraw_count"], 0)

    def test_adversarial_echo_fixture_uses_only_kernel_echo_for_token_cells(self):
        attributes = [0, 0, 0, 0, 0, 0, []]
        with mock.patch.object(tui_benchmark.termios, "tcgetattr", return_value=attributes):
            result, evidence = self.run_probe(
                "none",
                timeout=1.0,
                extra=("--leave-echo-enabled",),
            )
        self.assert_success(result, "fallback-final")
        self.assertEqual(evidence["input_mode"], "noncanonical-echo")
        self.assertEqual(evidence["renderer_token_redraw_count"], 0)
        self.assertTrue(evidence["echo_disabled_before_removal"])

    def test_echo_reenabled_before_guard_or_removal_fails_closed(self):
        before_guard, _ = self.run_probe(
            "dark",
            timeout=0.6,
            extra=("--enable-echo-before-guard",),
        )
        self.assertEqual(before_guard["failure"], "probe_terminal_echo_enabled")
        self.assertTrue(before_guard["probe_body_visible"])
        self.assertFalse(before_guard["probe_guard_sent"])

        before_removal, evidence = self.run_probe(
            "dark",
            timeout=0.6,
            extra=("--enable-echo-before-removal",),
        )
        self.assertEqual(before_removal["failure"], "probe_terminal_echo_enabled")
        self.assertTrue(before_removal["probe_guard_sent"])
        self.assertIsNotNone(before_removal["interactive_ms"])
        self.assertTrue(before_removal["probe_persistence_verified"])
        self.assertEqual(before_removal["probe_backspace_count"], 0)
        self.assertEqual(evidence["backspace_count"], 0)

    def test_queryless_marker_only_fixture_cannot_validate_theme_activity(self):
        result, evidence = self.run_probe(
            "none",
            timeout=0.6,
            extra=("--suppress-theme-queries",),
        )
        self.assertEqual(result["failure"], "theme_query_missing")
        self.assertEqual((result["foreground_query_count"], result["background_query_count"]), (0, 0))
        self.assertFalse(result["theme_activity_verified"])
        self.assertIsNone(result["interactive_ms"])
        self.assertEqual(evidence["backspace_count"], 0)

    def test_late_resolved_marker_before_due_responses_fails_activity_check(self):
        result, _ = self.run_probe(
            "late:125",
            timeout=0.6,
            extra=("--force-early-resolved",),
        )
        self.assertEqual(result["failure"], "theme_response_activity_mismatch")
        self.assertEqual(result["theme_settled_outcome"], "resolved")
        self.assertEqual((result["foreground_response_count"], result["background_response_count"]), (0, 0))
        self.assertFalse(result["theme_activity_verified"])

    def test_back_to_back_query_and_false_marker_cannot_be_repaired_before_receipt(self):
        result, _ = self.run_probe(
            "dark",
            timeout=0.6,
            extra=("--force-marker-before-response",),
        )
        self.assertIn(result["failure"], ("theme_query_missing", "theme_response_activity_mismatch"))
        self.assertEqual((result["foreground_response_count"], result["background_response_count"]), (0, 0))
        self.assertFalse(result["theme_activity_verified"])

    def test_cli_keeps_legacy_shape_and_adds_only_explicit_probe_controls(self):
        args = tui_benchmark.build_parser().parse_args(
            [
                "--label",
                "probe",
                "--samples",
                "1",
                "--mode",
                "warm",
                "--theme-response",
                "late:1250",
                "--interaction-probe",
                "--",
                "command",
            ]
        )
        self.assertEqual(args.command, ["--", "command"])
        self.assertEqual(args.theme_response, tui_benchmark.ThemeFixture("late", 1250))
        self.assertTrue(args.interaction_probe)


if __name__ == "__main__":
    unittest.main()
