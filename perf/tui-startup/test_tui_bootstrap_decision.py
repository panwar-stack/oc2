import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import benchmark_gate
import bootstrap_decision
import tui_benchmark
from test_tui_benchmark_gate import BASELINE, write_comparison


HOST = {
    "os": "test-os",
    "os_release": "1.0",
    "arch": "test-arch",
    "python_version": "3.11.0",
    "bun_version": "1.3.14",
}
SOURCE = {
    "revision": "8" * 40,
    "tree": "9" * 40,
    "pr_base_revision": "5" * 40,
    "clean": True,
}
SCRIPT = Path(__file__).with_name("tui_benchmark.py")


def read_records(path):
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


def write_records(path, records):
    path.write_bytes(
        b"".join(tui_benchmark._canonical_json_bytes(item) for item in records)
    )


def add_core_evidence(
    path,
    dispatch_ms,
    duplicate_bytes,
    response_bytes,
    mutate=None,
):
    records = read_records(path)
    for record in records[1:-1]:
        if record["record"] != "sample" or record["arm"] != "candidate":
            continue
        rows = []
        for index, name in enumerate(bootstrap_decision.LEGACY_CORE_REQUESTS):
            sequence = index * 3 + 1
            rows.append(
                {
                    "request_id": index + 1,
                    "name": name,
                    "request_sequence": sequence,
                    "request_receipt_ms": float(sequence),
                    "request_encoded_bytes": 50,
                    "dispatch_sequence": sequence + 1,
                    "dispatch_receipt_ms": float(sequence + 1),
                    "dispatch_duration_ms": dispatch_ms,
                    "response_sequence": sequence + 2,
                    "response_receipt_ms": float(sequence + 2),
                    "response_encoded_bytes": response_bytes,
                    "removable_duplicate_bytes": duplicate_bytes if index == 0 else 0,
                }
            )
        if mutate is not None:
            mutate(rows)
        record["measurement"]["rpc"] = rows
    write_records(path, records)


def add_provider_list_evidence(
    rows,
    dispatch_ms,
    duplicate_bytes,
    response_bytes,
):
    sequence = len(rows) * 3 + 1
    rows.append(
        {
            "request_id": len(rows) + 1,
            "name": "provider.list",
            "request_sequence": sequence,
            "request_receipt_ms": float(sequence),
            "request_encoded_bytes": 50,
            "dispatch_sequence": sequence + 1,
            "dispatch_receipt_ms": float(sequence + 1),
            "dispatch_duration_ms": dispatch_ms,
            "response_sequence": sequence + 2,
            "response_receipt_ms": float(sequence + 2),
            "response_encoded_bytes": response_bytes,
            "removable_duplicate_bytes": duplicate_bytes,
        }
    )


class BootstrapDecisionFixture(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.case_index = 0

    def tearDown(self):
        self.directory.cleanup()

    def make_artifact(self, root):
        binary = root / "candidate"
        binary.write_bytes(b"#!/bin/sh\nexit 0\n")
        binary.chmod(0o755)
        output = root / "candidate-artifact"
        with mock.patch.object(
            tui_benchmark, "_git_source_identity", return_value=dict(SOURCE)
        ):
            with mock.patch.object(
                tui_benchmark, "_host_record", return_value=dict(HOST)
            ):
                artifact = tui_benchmark.preserve_artifact(
                    "candidate",
                    binary,
                    "bun run dev:build",
                    "required",
                    output,
                )
        return artifact

    def inputs(
        self,
        dispatch_ms=9.0,
        duplicate_bytes=0,
        response_bytes=100,
        mutate=None,
    ):
        root = self.root / f"case-{self.case_index}"
        self.case_index += 1
        root.mkdir()
        artifact = self.make_artifact(root)
        artifacts = {
            "baseline": dict(BASELINE),
            "candidate": tui_benchmark._artifact_projection(artifact),
        }
        inputs = {}
        for serial, spec in enumerate(benchmark_gate.POLICY_COHORTS["full-v1"]):
            path = root / f"{spec.key}.jsonl"
            write_comparison(path, spec, artifacts, serial)
            if spec.key == "dark":
                add_core_evidence(
                    path,
                    dispatch_ms,
                    duplicate_bytes,
                    response_bytes,
                )
            inputs[spec.key] = path
        gate = root / "full-gate.json"
        gate_report = benchmark_gate.evaluate_gate("full-v1", inputs)
        benchmark_gate.write_report(gate, gate_report)
        if mutate is not None:
            add_core_evidence(
                inputs["dark"],
                dispatch_ms,
                duplicate_bytes,
                response_bytes,
                mutate,
            )
            gate_report["inputs"]["dark"]["sha256"] = tui_benchmark._sha256_file(
                inputs["dark"]
            )
            gate.unlink()
            benchmark_gate.write_report(gate, gate_report)
        return artifact.root, gate, inputs["dark"]

    def evaluate(self, paths):
        return bootstrap_decision.evaluate_decision(
            "core-bootstrap-v1", *paths
        )


class BootstrapDecisionCliTest(unittest.TestCase):
    def test_decide_dispatches_documented_options(self):
        arguments = [
            "decide-bootstrap",
            "--policy",
            "core-bootstrap-v1",
            "--candidate-artifact",
            "candidate-artifact",
            "--gate-report",
            "gate.json",
            "--input",
            "dark.jsonl",
            "--output",
            "decision.json",
        ]
        with mock.patch.object(bootstrap_decision, "run_decision", return_value=0) as run:
            self.assertEqual(tui_benchmark.main(arguments), 0)
        run.assert_called_once_with(
            "core-bootstrap-v1",
            Path("candidate-artifact"),
            Path("gate.json"),
            Path("dark.jsonl"),
            Path("decision.json"),
        )

    def test_preserve_dispatches_documented_options(self):
        arguments = [
            "preserve-bootstrap-decision",
            "--policy",
            "core-bootstrap-v1",
            "--expect",
            "implement",
            "--privacy-review-approved",
            "--source",
            "source.json",
            "--candidate-artifact",
            "candidate-artifact",
            "--gate-report",
            "gate.json",
            "--input",
            "dark.jsonl",
            "--output",
            str(bootstrap_decision.IMPLEMENT_DECISION_RELATIVE),
            "--sha256-output",
            str(bootstrap_decision.IMPLEMENT_SIDECAR_RELATIVE),
        ]
        with mock.patch.object(bootstrap_decision, "preserve_implement_decision") as preserve:
            self.assertEqual(tui_benchmark.main(arguments), 0)
        preserve.assert_called_once_with(
            "core-bootstrap-v1",
            "implement",
            True,
            Path("source.json"),
            Path("candidate-artifact"),
            Path("gate.json"),
            Path("dark.jsonl"),
            bootstrap_decision.IMPLEMENT_DECISION_RELATIVE,
            bootstrap_decision.IMPLEMENT_SIDECAR_RELATIVE,
        )

    def test_repeated_decide_and_preserve_options_fail_before_dispatch(self):
        commands = (
            (
                [
                    "decide-bootstrap", "--policy", "core-bootstrap-v1",
                    "--candidate-artifact", "candidate", "--gate-report", "gate.json",
                    "--input", "dark.jsonl", "--output", "decision.json",
                ],
                {
                    "--policy": "core-bootstrap-v1", "--candidate-artifact": "other-candidate",
                    "--gate-report": "other-gate.json", "--input": "other.jsonl",
                    "--output": "other-decision.json",
                },
            ),
            (
                [
                    "preserve-bootstrap-decision", "--policy", "core-bootstrap-v1",
                    "--expect", "implement", "--privacy-review-approved", "--source", "source.json",
                    "--candidate-artifact", "candidate", "--gate-report", "gate.json",
                    "--input", "dark.jsonl", "--output", str(bootstrap_decision.IMPLEMENT_DECISION_RELATIVE),
                    "--sha256-output", str(bootstrap_decision.IMPLEMENT_SIDECAR_RELATIVE),
                ],
                {
                    "--policy": "core-bootstrap-v1", "--expect": "implement",
                    "--privacy-review-approved": None, "--source": "other-source.json",
                    "--candidate-artifact": "other-candidate", "--gate-report": "other-gate.json",
                    "--input": "other.jsonl", "--output": "other.json",
                    "--sha256-output": "other.sha256",
                },
            ),
        )
        with mock.patch.object(bootstrap_decision, "run_decision") as decide:
            with mock.patch.object(bootstrap_decision, "preserve_implement_decision") as preserve:
                for base, repeated in commands:
                    for option, value in repeated.items():
                        arguments = [*base, option] if value is None else [*base, option, value]
                        with self.subTest(command=base[0], option=option), self.assertRaises(SystemExit) as raised:
                            tui_benchmark.main(arguments)
                        self.assertEqual(raised.exception.code, 2)
        decide.assert_not_called()
        preserve.assert_not_called()

    def test_collision_failures_return_nonzero_without_changing_existing_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            decision = root / "decision.json"
            decision.write_bytes(b"existing decision\n")
            with mock.patch.object(
                bootstrap_decision,
                "run_decision",
                side_effect=bootstrap_decision.DecisionFailure("decision_gate_output_exists"),
            ):
                result = tui_benchmark.main(
                    [
                        "decide-bootstrap", "--policy", "core-bootstrap-v1",
                        "--candidate-artifact", "candidate", "--gate-report", "gate.json",
                        "--input", "dark.jsonl", "--output", str(decision),
                    ]
                )
            self.assertEqual(result, 1)
            self.assertEqual(decision.read_bytes(), b"existing decision\n")

    def test_help_smoke(self):
        for command in ("decide-bootstrap", "preserve-bootstrap-decision"):
            with self.subTest(command=command):
                completed = subprocess.run(
                    ["python3", str(SCRIPT), command, "--help"],
                    check=False,
                    capture_output=True,
                    text=True,
                )
                self.assertEqual(completed.returncode, 0, completed.stderr)
                self.assertIn(f"tui_benchmark.py {command}", completed.stdout)


class BootstrapDecisionBoundaryTest(BootstrapDecisionFixture):
    def test_dispatch_boundary_is_inclusive_and_sum_minus_max_per_sample(self):
        report = self.evaluate(self.inputs(dispatch_ms=12.5))
        self.assertEqual(report["decision"], "implement")
        self.assertEqual(report["evidence"]["removable_dispatch_ms_median"], 50.0)
        self.assertTrue(report["evidence"]["removable_dispatch_qualifies"])

        with tempfile.TemporaryDirectory() as directory:
            original = self.root
            self.root = Path(directory)
            try:
                report = self.evaluate(self.inputs(dispatch_ms=12.499))
            finally:
                self.root = original
        self.assertEqual(report["decision"], "skip")
        self.assertLess(report["evidence"]["removable_dispatch_ms_median"], 50.0)

    def test_duplicate_twice_median_boundary_is_exact_and_inclusive(self):
        report = self.evaluate(self.inputs(duplicate_bytes=65_536))
        self.assertEqual(report["decision"], "implement")
        self.assertEqual(
            report["evidence"]["removable_duplicate_bytes_twice_median"],
            131_072,
        )
        self.assertTrue(report["evidence"]["removable_duplicate_bytes_qualifies"])

        with tempfile.TemporaryDirectory() as directory:
            original = self.root
            self.root = Path(directory)
            try:
                report = self.evaluate(self.inputs(duplicate_bytes=65_535))
            finally:
                self.root = original
        self.assertEqual(report["decision"], "skip")
        self.assertEqual(
            report["evidence"]["removable_duplicate_bytes_twice_median"],
            131_070,
        )

    def test_response_byte_baseline_is_reported_but_never_selects_implement(self):
        report = self.evaluate(self.inputs(response_bytes=1_000_000))
        self.assertEqual(report["decision"], "skip")
        self.assertEqual(
            report["evidence"]["adoption_baseline_response_bytes_twice_median"],
            10_000_000,
        )

    def test_provider_list_cannot_change_decision_or_adoption_baseline(self):
        def add_provider_list(rows):
            add_provider_list_evidence(
                rows,
                dispatch_ms=1_000_000.0,
                duplicate_bytes=1_000_000,
                response_bytes=1_000_000,
            )

        skip_report = self.evaluate(
            self.inputs(
                dispatch_ms=9.0,
                duplicate_bytes=0,
                response_bytes=100,
                mutate=add_provider_list,
            )
        )

        self.assertEqual(
            skip_report["evidence"]["core_requests"],
            [
                "config.providers",
                "app.agents",
                "config.get",
                "project.path",
                "project.current",
            ],
        )
        self.assertEqual(skip_report["decision"], "skip")
        self.assertEqual(
            skip_report["evidence"]["removable_dispatch_ms_median"], 36.0
        )
        self.assertEqual(
            skip_report["evidence"]["removable_duplicate_bytes_twice_median"],
            0,
        )
        self.assertEqual(
            skip_report["evidence"][
                "adoption_baseline_response_bytes_twice_median"
            ],
            1_000,
        )

        implement_report = self.evaluate(
            self.inputs(
                dispatch_ms=12.5,
                duplicate_bytes=0,
                response_bytes=100,
                mutate=add_provider_list,
            )
        )
        self.assertEqual(implement_report["decision"], "implement")
        self.assertEqual(
            implement_report["evidence"]["removable_dispatch_ms_median"], 50.0
        )
        self.assertEqual(
            implement_report["evidence"][
                "adoption_baseline_response_bytes_twice_median"
            ],
            1_000,
        )

    def test_report_is_canonical_path_free_closed_and_exclusive(self):
        paths = self.inputs(dispatch_ms=10.0)
        output = self.root / "decision.json"
        self.assertEqual(
            bootstrap_decision.run_decision(
                "core-bootstrap-v1", *paths, output
            ),
            0,
        )
        content = output.read_bytes()
        report = json.loads(content)
        self.assertEqual(content, tui_benchmark._canonical_json_bytes(report))
        self.assertNotIn(str(self.root), content.decode("utf-8"))
        self.assertEqual(
            report["privacy"]["fields"], list(bootstrap_decision.PRIVACY_ALLOWLIST)
        )
        with self.assertRaisesRegex(
            bootstrap_decision.DecisionFailure, "decision_gate_output_exists"
        ):
            bootstrap_decision.run_decision(
                "core-bootstrap-v1", *paths, output
            )


class BootstrapDecisionValidationTest(BootstrapDecisionFixture):
    def test_stale_full_gate_tooling_hash_fails_closed(self):
        paths = self.inputs()
        gate = json.loads(paths[1].read_text(encoding="utf-8"))
        gate["tooling"]["benchmark_gate_sha256"] = "0" * 64
        paths[1].unlink()
        benchmark_gate.write_report(paths[1], gate)

        with self.assertRaisesRegex(
            bootstrap_decision.DecisionFailure,
            "decision_phase_full_gate_tooling_drift",
        ):
            self.evaluate(paths)

    def test_missing_duplicate_incomplete_and_noninteger_core_rows_fail_closed(self):
        def duplicate(rows):
            row = dict(rows[0])
            row.update(
                {
                    "request_id": 99,
                    "request_sequence": 19,
                    "request_receipt_ms": 19.0,
                    "dispatch_sequence": 20,
                    "dispatch_receipt_ms": 20.0,
                    "response_sequence": 21,
                    "response_receipt_ms": 21.0,
                }
            )
            rows.append(row)

        cases = (
            (lambda rows: rows.pop(), "decision_core_request_matrix_invalid"),
            (duplicate, "decision_core_request_matrix_invalid"),
            (
                lambda rows: rows[0].update({"dispatch_sequence": None}),
                "decision_comparison_measurement_schema",
            ),
            (
                lambda rows: rows[0].update({"removable_duplicate_bytes": True}),
                "decision_comparison_measurement_schema",
            ),
        )
        for index, (mutate, code) in enumerate(cases):
            with self.subTest(index=index), tempfile.TemporaryDirectory() as directory:
                original = self.root
                self.root = Path(directory)
                try:
                    paths = self.inputs(mutate=mutate)
                    with self.assertRaisesRegex(
                        bootstrap_decision.DecisionFailure, code
                    ):
                        self.evaluate(paths)
                finally:
                    self.root = original

    def test_wrong_cohort_failed_gate_candidate_and_hash_drift_fail_closed(self):
        paths = self.inputs()
        comparison_records = read_records(paths[2])
        comparison_records[0]["scenario"]["theme_response"] = "light"
        comparison_records[0]["comparison_id"] = "0" * 64
        write_records(paths[2], comparison_records)
        with self.assertRaises(bootstrap_decision.DecisionFailure):
            self.evaluate(paths)

        with tempfile.TemporaryDirectory() as directory:
            original = self.root
            self.root = Path(directory)
            try:
                paths = self.inputs()
                gate = json.loads(paths[1].read_text(encoding="utf-8"))
                gate["passed"] = False
                gate["failures"] = ["test_failure"]
                paths[1].unlink()
                benchmark_gate.write_report(paths[1], gate)
                with self.assertRaisesRegex(
                    bootstrap_decision.DecisionFailure,
                    "decision_phase_full_gate_not_passed",
                ):
                    self.evaluate(paths)
            finally:
                self.root = original

        with tempfile.TemporaryDirectory() as directory:
            original = self.root
            self.root = Path(directory)
            try:
                paths = self.inputs()
                binary = paths[0] / "bin" / "oc2"
                binary.write_bytes(b"tampered")
                with self.assertRaisesRegex(
                    bootstrap_decision.DecisionFailure,
                    "decision_candidate_artifact_invalid",
                ):
                    self.evaluate(paths)
            finally:
                self.root = original


class ImplementDecisionPreservationTest(BootstrapDecisionFixture):
    def prepare(self, dispatch_ms=12.5):
        paths = self.inputs(dispatch_ms=dispatch_ms)
        root = paths[2].parent
        source = root / "source.json"
        bootstrap_decision.run_decision(
            "core-bootstrap-v1", *paths, source
        )
        repo = root / "repo"
        parent = repo / "spikes" / "tui-startup-performance"
        parent.mkdir(parents=True)
        output = repo / bootstrap_decision.IMPLEMENT_DECISION_RELATIVE
        sidecar = repo / bootstrap_decision.IMPLEMENT_SIDECAR_RELATIVE
        return paths, source, repo, output, sidecar

    def preserve(self, paths, source, repo, output, sidecar, approved=True):
        with mock.patch.object(tui_benchmark, "REPO_ROOT", repo):
            return bootstrap_decision.preserve_implement_decision(
                "core-bootstrap-v1",
                "implement",
                approved,
                source,
                *paths,
                output,
                sidecar,
            )

    def test_preserves_exact_bytes_with_repository_relative_shasum_sidecar(self):
        paths, source, repo, output, sidecar = self.prepare()
        self.preserve(paths, source, repo, output, sidecar)
        self.assertEqual(output.read_bytes(), source.read_bytes())
        digest = tui_benchmark._sha256_file(output)
        self.assertEqual(
            sidecar.read_text(encoding="ascii"),
            f"{digest}  {bootstrap_decision.IMPLEMENT_DECISION_RELATIVE.as_posix()}\n",
        )
        checked = subprocess.run(
            ["shasum", "-a", "256", "-c", str(sidecar)],
            cwd=repo,
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(checked.returncode, 0, checked.stderr)

    def test_requires_approval_fixed_paths_and_rejects_skip(self):
        paths, source, repo, output, sidecar = self.prepare()
        with self.assertRaisesRegex(
            bootstrap_decision.DecisionFailure, "decision_privacy_review_required"
        ):
            self.preserve(paths, source, repo, output, sidecar, approved=False)

        with mock.patch.object(tui_benchmark, "REPO_ROOT", repo):
            with self.assertRaisesRegex(
                bootstrap_decision.DecisionFailure,
                "decision_preservation_path_invalid",
            ):
                bootstrap_decision.preserve_implement_decision(
                    "core-bootstrap-v1",
                    "implement",
                    True,
                    source,
                    *paths,
                    repo / "wrong.json",
                    repo / "wrong.json.sha256",
                )

        with tempfile.TemporaryDirectory() as directory:
            original = self.root
            self.root = Path(directory)
            try:
                paths, source, repo, output, sidecar = self.prepare(dispatch_ms=9.0)
                with self.assertRaisesRegex(
                    bootstrap_decision.DecisionFailure,
                    "decision_preservation_skip_rejected",
                ):
                    self.preserve(paths, source, repo, output, sidecar)
            finally:
                self.root = original

    def test_privacy_provenance_and_artifact_tamper_fail_closed(self):
        paths, source, repo, output, sidecar = self.prepare()
        report = json.loads(source.read_text(encoding="utf-8"))
        report["privacy"]["fields"].append("private.path")
        source.write_bytes(tui_benchmark._canonical_json_bytes(report))
        with self.assertRaisesRegex(
            bootstrap_decision.DecisionFailure,
            "decision_privacy_allowlist_mismatch",
        ):
            self.preserve(paths, source, repo, output, sidecar)

        paths, source, repo, output, sidecar = self.prepare()
        report = json.loads(source.read_text(encoding="utf-8"))
        report["inputs"]["comparison_sha256"] = "0" * 64
        source.write_bytes(tui_benchmark._canonical_json_bytes(report))
        with self.assertRaisesRegex(
            bootstrap_decision.DecisionFailure,
            "decision_preservation_provenance_mismatch",
        ):
            self.preserve(paths, source, repo, output, sidecar)

        paths, source, repo, output, sidecar = self.prepare()
        (paths[0] / "bin" / "oc2").write_bytes(b"tampered")
        with self.assertRaisesRegex(
            bootstrap_decision.DecisionFailure,
            "decision_candidate_artifact_invalid",
        ):
            self.preserve(paths, source, repo, output, sidecar)

    def test_output_or_sidecar_collision_preserves_existing_files(self):
        for collision in ("output", "sidecar"):
            with self.subTest(collision=collision), tempfile.TemporaryDirectory() as directory:
                original = self.root
                self.root = Path(directory)
                try:
                    paths, source, repo, output, sidecar = self.prepare()
                    target = output if collision == "output" else sidecar
                    target.write_bytes(b"existing\n")
                    with self.assertRaisesRegex(
                        bootstrap_decision.DecisionFailure,
                        "decision_preservation_collision",
                    ):
                        self.preserve(paths, source, repo, output, sidecar)
                    self.assertEqual(target.read_bytes(), b"existing\n")
                    other = sidecar if collision == "output" else output
                    self.assertFalse(other.exists())
                finally:
                    self.root = original

    def test_sidecar_race_removes_only_the_partial_output(self):
        paths, source, repo, output, sidecar = self.prepare()
        write_exclusive = tui_benchmark._write_exclusive

        def collide(path, content):
            if path == sidecar:
                path.write_bytes(b"raced\n")
            write_exclusive(path, content)

        with mock.patch.object(tui_benchmark, "REPO_ROOT", repo):
            with mock.patch.object(
                tui_benchmark, "_write_exclusive", side_effect=collide
            ):
                with self.assertRaisesRegex(
                    bootstrap_decision.DecisionFailure,
                    "decision_preservation_collision",
                ):
                    bootstrap_decision.preserve_implement_decision(
                        "core-bootstrap-v1",
                        "implement",
                        True,
                        source,
                        *paths,
                        output,
                        sidecar,
                    )
        self.assertFalse(output.exists())
        self.assertEqual(sidecar.read_bytes(), b"raced\n")


if __name__ == "__main__":
    unittest.main()
