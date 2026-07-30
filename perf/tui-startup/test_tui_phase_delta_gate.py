import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import benchmark_gate
import tui_benchmark
from test_tui_benchmark_gate import (
    BASELINE,
    CANDIDATE_REQUIRED,
    read_records,
    relink_metadata,
    write_comparison,
    write_records,
)


BEFORE_CANDIDATE = dict(CANDIDATE_REQUIRED)
AFTER_CANDIDATE = dict(
    CANDIDATE_REQUIRED,
    artifact_id="a" * 64,
    binary_sha256="b" * 64,
    revision="c" * 40,
    tree="d" * 40,
    pr_base_revision=BEFORE_CANDIDATE["revision"],
)


def add_candidate_phase(path, phase, duration, receipt):
    records = read_records(path)
    for record in records[1:-1]:
        if record["record"] != "sample" or record["arm"] != "candidate":
            continue
        measurement = record["measurement"]
        receipt_ms = measurement["interactive_ms"] + receipt if receipt < 0 else receipt
        measurement["phases"] = [
            {
                "sequence": 1,
                "phase": phase,
                "role": "main",
                "outcome": "ok",
                "duration_ms": duration,
                "receipt_ms": receipt_ms,
            }
        ]
    write_records(path, records)


def make_full_policy(root, candidate, phase, duration, receipt, serial_offset):
    artifacts = {"baseline": dict(BASELINE), "candidate": dict(candidate)}
    inputs = {}
    for serial, spec in enumerate(benchmark_gate.POLICY_COHORTS["full-v1"]):
        path = root / f"{spec.key}.jsonl"
        write_comparison(path, spec, artifacts, serial + serial_offset)
        if spec.key == "dark":
            add_candidate_phase(path, phase, duration, receipt)
        inputs[spec.key] = path
    gate_path = root / "full-gate.json"
    report = benchmark_gate.evaluate_gate("full-v1", inputs)
    benchmark_gate.write_report(gate_path, report)
    return inputs["dark"], gate_path


def refresh_dark_hash(comparison, gate_path):
    report = json.loads(gate_path.read_text(encoding="utf-8"))
    report["inputs"]["dark"]["sha256"] = tui_benchmark._sha256_file(comparison)
    gate_path.unlink()
    benchmark_gate.write_report(gate_path, report)


class PhaseDeltaFixture(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.pair_serial = 0

    def tearDown(self):
        self.directory.cleanup()

    def pair(
        self,
        phase="tui.import",
        before_duration=20.0,
        after_duration=10.0,
        before_receipt=1000.0,
        after_receipt=1000.0,
        before_candidate=BEFORE_CANDIDATE,
        after_candidate=AFTER_CANDIDATE,
    ):
        pair_serial = self.pair_serial
        self.pair_serial += 1
        before_root = self.root / f"before-{pair_serial}"
        after_root = self.root / f"after-{pair_serial}"
        before_root.mkdir()
        after_root.mkdir()
        before, before_gate = make_full_policy(
            before_root,
            before_candidate,
            phase,
            before_duration,
            before_receipt,
            pair_serial * 1000,
        )
        after, after_gate = make_full_policy(
            after_root,
            after_candidate,
            phase,
            after_duration,
            after_receipt,
            pair_serial * 1000 + 100,
        )
        return before, after, before_gate, after_gate

    def evaluate(self, phase, paths):
        return benchmark_gate.evaluate_phase_delta(phase, *paths)


class PhaseDeltaCliTest(unittest.TestCase):
    def test_dispatches_documented_options_in_runner_order(self):
        output = Path("phase-gate.json")
        with mock.patch.object(benchmark_gate, "run_phase_delta", return_value=0) as run:
            self.assertEqual(
                tui_benchmark.main(
                    [
                        "gate-phase-delta",
                        "--policy",
                        "single-deferral-v1",
                        "--phase",
                        "tui.import",
                        "--before",
                        "before.jsonl",
                        "--before-full-gate",
                        "before-gate.json",
                        "--after",
                        "after.jsonl",
                        "--full-gate",
                        "after-gate.json",
                        "--output",
                        str(output),
                    ]
                ),
                0,
            )
        run.assert_called_once_with(
            "tui.import",
            Path("before.jsonl"),
            Path("after.jsonl"),
            Path("before-gate.json"),
            Path("after-gate.json"),
            output,
        )

    def test_repeated_phase_gate_options_fail_before_dispatch(self):
        arguments = [
            "gate-phase-delta",
            "--policy",
            "single-deferral-v1",
            "--phase",
            "tui.import",
            "--before",
            "before.jsonl",
            "--before-full-gate",
            "before-gate.json",
            "--after",
            "after.jsonl",
            "--full-gate",
            "after-gate.json",
            "--output",
            "phase-gate.json",
        ]
        repeated = {
            "--policy": "single-deferral-v1",
            "--phase": "tui.plugins",
            "--before": "other-before.jsonl",
            "--before-full-gate": "other-before-gate.json",
            "--after": "other-after.jsonl",
            "--full-gate": "other-after-gate.json",
            "--output": "other-phase-gate.json",
        }
        with mock.patch.object(benchmark_gate, "run_phase_delta") as run:
            for option, value in repeated.items():
                with self.subTest(option=option), self.assertRaises(SystemExit) as raised:
                    tui_benchmark.main([*arguments, option, value])
                self.assertEqual(raised.exception.code, 2)
        run.assert_not_called()

    def test_gate_failure_returns_nonzero_and_preserves_existing_output(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "phase-gate.json"
            output.write_bytes(b"existing\n")
            with mock.patch.object(
                benchmark_gate,
                "run_phase_delta",
                side_effect=benchmark_gate.GateFailure("gate_output_exists"),
            ):
                self.assertEqual(
                    tui_benchmark.main(
                        [
                            "gate-phase-delta",
                            "--policy",
                            "single-deferral-v1",
                            "--phase",
                            "tui.import",
                            "--before",
                            "before.jsonl",
                            "--before-full-gate",
                            "before-gate.json",
                            "--after",
                            "after.jsonl",
                            "--full-gate",
                            "after-gate.json",
                            "--output",
                            str(output),
                        ]
                    ),
                    1,
                )
            self.assertEqual(output.read_bytes(), b"existing\n")


class PhaseDecisionTest(PhaseDeltaFixture):
    def test_strict_duration_decrease_passes_and_report_is_canonical_path_free_and_exclusive(self):
        paths = self.pair()
        output = self.root / "phase-gate.json"
        self.assertEqual(
            benchmark_gate.run_phase_delta("tui.import", *paths, output),
            0,
        )
        with self.assertRaisesRegex(benchmark_gate.GateFailure, "gate_output_exists"):
            benchmark_gate.run_phase_delta("tui.import", *paths, output)
        content = output.read_bytes()
        report = json.loads(content)
        self.assertEqual(content, tui_benchmark._canonical_json_bytes(report))
        self.assertTrue(report["passed"])
        self.assertTrue(report["decisions"]["strict_median_duration_decrease"])
        self.assertNotIn(str(self.root), content.decode("utf-8"))

    def test_receipt_clock_deferral_passes_with_before_equality_and_after_strictness(self):
        paths = self.pair(
            before_duration=10.0,
            after_duration=11.0,
            before_receipt=1200.0,
            after_receipt=1200.01,
        )
        report = self.evaluate("tui.import", paths)
        self.assertTrue(report["passed"])
        self.assertFalse(report["decisions"]["strict_median_duration_decrease"])
        self.assertTrue(report["decisions"]["all_receipts_deferred_after_interactive"])
        self.assertEqual(report["evidence"]["before"]["receipts_at_or_before_interactive"], 20)
        self.assertEqual(report["evidence"]["after"]["receipts_after_interactive"], 20)

    def test_equal_duration_and_equal_after_receipt_fail(self):
        paths = self.pair(
            before_duration=10.0,
            after_duration=10.0,
            before_receipt=1200.0,
            after_receipt=1200.0,
        )
        report = self.evaluate("tui.import", paths)
        self.assertFalse(report["passed"])
        self.assertEqual(report["failures"], ["phase_not_improved_or_deferred"])
        self.assertFalse(report["decisions"]["strict_median_duration_decrease"])
        self.assertFalse(report["decisions"]["all_receipts_deferred_after_interactive"])

    def test_only_approved_phase_names_are_accepted(self):
        for phase in sorted(benchmark_gate.PHASE_DELTA_PHASES):
            with self.subTest(phase=phase), tempfile.TemporaryDirectory() as directory:
                original_root = self.root
                self.root = Path(directory)
                try:
                    report = self.evaluate(phase, self.pair(phase=phase))
                finally:
                    self.root = original_root
                self.assertTrue(report["passed"])
        with self.assertRaisesRegex(benchmark_gate.GateFailure, "phase_name_invalid"):
            benchmark_gate.evaluate_phase_delta(
                "renderer.create",
                Path("unused"),
                Path("unused"),
                Path("unused"),
                Path("unused"),
            )


class PhaseEvidenceValidationTest(PhaseDeltaFixture):
    def test_dark_warm_contract_and_invalid_samples_fail_closed(self):
        cases = (
            (
                "scenario",
                lambda records: records[0]["scenario"].update({"theme_response": "light"}),
                "comparison_scenario_mismatch",
                True,
            ),
            (
                "state",
                lambda records: records[0]["state_policy"].update({"name": "other"}),
                "comparison_state_policy_mismatch",
                True,
            ),
            (
                "schedule",
                lambda records: records[0]["schedule"].update({"seed": 1}),
                "comparison_schedule_mismatch",
                True,
            ),
            (
                "allowlist",
                lambda records: records[0]["trace_allowlist"].update({"phases": []}),
                "comparison_trace_allowlist_mismatch",
                True,
            ),
            (
                "sample",
                lambda records: records[1]["measurement"].update({"failure": "fixture_invalid"}),
                "comparison_invalid_sample",
                False,
            ),
        )
        for name, mutate, code, relink in cases:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                original_root = self.root
                self.root = Path(directory)
                try:
                    paths = self.pair()
                    records = read_records(paths[0])
                    mutate(records)
                    if relink:
                        relink_metadata(records)
                    write_records(paths[0], records)
                    with self.assertRaisesRegex(benchmark_gate.GateFailure, code):
                        self.evaluate("tui.import", paths)
                finally:
                    self.root = original_root

    def test_missing_duplicate_and_error_phase_evidence_fail(self):
        cases = ("missing", "duplicate", "error")
        for case in cases:
            with self.subTest(case=case), tempfile.TemporaryDirectory() as directory:
                original_root = self.root
                self.root = Path(directory)
                try:
                    paths = self.pair()
                    records = read_records(paths[1])
                    candidate = next(
                        record
                        for record in records[1:-1]
                        if record["record"] == "sample" and record["arm"] == "candidate"
                    )
                    phases = candidate["measurement"]["phases"]
                    if case == "missing":
                        phases.clear()
                        code = "phase_candidate_sample_count_invalid"
                    elif case == "duplicate":
                        phases.append(dict(phases[0], sequence=2, receipt_ms=1001.0))
                        code = "phase_candidate_sample_count_invalid"
                    else:
                        phases[0]["outcome"] = "error"
                        code = "phase_candidate_sample_outcome_invalid"
                    write_records(paths[1], records)
                    refresh_dark_hash(paths[1], paths[3])
                    with self.assertRaisesRegex(benchmark_gate.GateFailure, code):
                        self.evaluate("tui.import", paths)
                finally:
                    self.root = original_root

    def test_cross_comparison_duplicate_run_id_fails(self):
        paths = self.pair()
        before_records = read_records(paths[0])
        after_records = read_records(paths[1])
        before_run = next(
            record["measurement"]["run_id"]
            for record in before_records[1:-1]
            if record["record"] == "sample" and record["arm"] == "candidate"
        )
        next(
            record
            for record in after_records[1:-1]
            if record["record"] == "sample" and record["arm"] == "candidate"
        )["measurement"]["run_id"] = before_run
        write_records(paths[1], after_records)
        refresh_dark_hash(paths[1], paths[3])
        with self.assertRaisesRegex(benchmark_gate.GateFailure, "phase_run_id_reused"):
            self.evaluate("tui.import", paths)


class PhaseProvenanceValidationTest(PhaseDeltaFixture):
    def test_equal_stale_full_gate_tooling_hashes_fail_closed(self):
        paths = self.pair()
        for gate_path in paths[2:]:
            gate = json.loads(gate_path.read_text(encoding="utf-8"))
            gate["tooling"]["benchmark_gate_sha256"] = "0" * 64
            gate_path.unlink()
            benchmark_gate.write_report(gate_path, gate)

        with self.assertRaisesRegex(
            benchmark_gate.GateFailure, "phase_full_gate_tooling_drift"
        ):
            self.evaluate("tui.import", paths)

    def test_full_gate_tooling_read_error_fails_closed(self):
        paths = self.pair()
        with mock.patch.object(
            benchmark_gate.Path,
            "read_bytes",
            side_effect=OSError("unavailable"),
        ):
            with self.assertRaisesRegex(
                benchmark_gate.GateFailure,
                "phase_full_gate_tooling_unavailable",
            ):
                benchmark_gate.load_full_gate(paths[2])

    def test_full_gate_hash_drift_and_not_passed_fail(self):
        paths = self.pair()
        gate = json.loads(paths[3].read_text(encoding="utf-8"))
        gate["inputs"]["dark"]["sha256"] = "0" * 64
        paths[3].unlink()
        benchmark_gate.write_report(paths[3], gate)
        with self.assertRaisesRegex(benchmark_gate.GateFailure, "phase_full_gate_hash_drift"):
            self.evaluate("tui.import", paths)

        paths = self.pair()
        gate = json.loads(paths[3].read_text(encoding="utf-8"))
        gate["passed"] = False
        gate["failures"] = ["dark_candidate_prompt_ms_median_absolute"]
        paths[3].unlink()
        benchmark_gate.write_report(paths[3], gate)
        with self.assertRaisesRegex(benchmark_gate.GateFailure, "phase_full_gate_not_passed"):
            self.evaluate("tui.import", paths)

    def test_baseline_drift_fails(self):
        drifted_baseline = dict(
            BASELINE,
            artifact_id="e" * 64,
            binary_sha256="f" * 64,
            revision="1" * 40,
            tree="2" * 40,
        )
        after_candidate = dict(AFTER_CANDIDATE)
        before_root = self.root / "baseline-before"
        after_root = self.root / "baseline-after"
        before_root.mkdir()
        after_root.mkdir()
        before, before_gate = make_full_policy(
            before_root, BEFORE_CANDIDATE, "tui.import", 20.0, 1000.0, 0
        )
        artifacts = {"baseline": drifted_baseline, "candidate": after_candidate}
        inputs = {}
        for serial, spec in enumerate(benchmark_gate.POLICY_COHORTS["full-v1"]):
            path = after_root / f"{spec.key}.jsonl"
            write_comparison(path, spec, artifacts, serial + 100)
            if spec.key == "dark":
                add_candidate_phase(path, "tui.import", 10.0, 1000.0)
            inputs[spec.key] = path
        after = inputs["dark"]
        after_gate = after_root / "full-gate.json"
        benchmark_gate.write_report(
            after_gate, benchmark_gate.evaluate_gate("full-v1", inputs)
        )
        with self.assertRaisesRegex(benchmark_gate.GateFailure, "phase_baseline_drift"):
            self.evaluate("tui.import", (before, after, before_gate, after_gate))

    def test_intended_candidate_chain_passes(self):
        paths = self.pair()
        report = self.evaluate("tui.import", paths)
        self.assertTrue(report["passed"])
        self.assertEqual(
            report["artifacts"]["before_candidate"]["revision"],
            report["artifacts"]["after_candidate"]["pr_base_revision"],
        )

    def test_wrong_after_pr_base_fails(self):
        wrong_base = dict(AFTER_CANDIDATE, pr_base_revision="0" * 40)
        paths = self.pair(after_candidate=wrong_base)
        with self.assertRaisesRegex(benchmark_gate.GateFailure, "phase_candidate_not_predecessor"):
            self.evaluate("tui.import", paths)


if __name__ == "__main__":
    unittest.main()
