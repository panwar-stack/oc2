import hashlib
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import benchmark_gate
import bootstrap_decision
import tui_benchmark
from test_tui_benchmark_gate import BASELINE, read_records, write_comparison, write_records
from test_tui_bootstrap_decision import BootstrapDecisionFixture


SCRIPT = Path(__file__).with_name("tui_benchmark.py")


def rpc_row(request_id, name, sequence, response_bytes):
    return {
        "request_id": request_id,
        "name": name,
        "request_sequence": sequence,
        "request_receipt_ms": float(sequence),
        "request_encoded_bytes": 50,
        "dispatch_sequence": sequence + 1,
        "dispatch_receipt_ms": float(sequence + 1),
        "dispatch_duration_ms": 5.0,
        "response_sequence": sequence + 2,
        "response_receipt_ms": float(sequence + 2),
        "response_encoded_bytes": response_bytes,
        "removable_duplicate_bytes": 0,
    }


def add_after_core_evidence(path, response_bytes, bootstrap_count=1, legacy=False):
    records = read_records(path)
    sample_index = 0
    for record in records[1:-1]:
        if record["record"] != "sample" or record["arm"] != "candidate":
            continue
        value = response_bytes[sample_index] if isinstance(response_bytes, list) else response_bytes
        rows = [
            rpc_row(index + 1, bootstrap_decision.CORE_BOOTSTRAP_REQUEST, index * 3 + 1, value)
            for index in range(bootstrap_count)
        ]
        if legacy:
            rows.append(
                rpc_row(
                    len(rows) + 1,
                    bootstrap_decision.LEGACY_CORE_REQUESTS[0],
                    len(rows) * 3 + 1,
                    value,
                )
            )
        record["measurement"]["rpc"] = rows
        sample_index += 1
    write_records(path, records)


class BootstrapAdoptionFixture(BootstrapDecisionFixture):
    def install_decision(self, repo, report):
        decision = repo / bootstrap_decision.IMPLEMENT_DECISION_RELATIVE
        sidecar = repo / bootstrap_decision.IMPLEMENT_SIDECAR_RELATIVE
        content = tui_benchmark._canonical_json_bytes(report)
        decision.unlink(missing_ok=True)
        sidecar.unlink(missing_ok=True)
        decision.write_bytes(content)
        digest = hashlib.sha256(content).hexdigest()
        sidecar.write_text(
            f"{digest}  {bootstrap_decision.IMPLEMENT_DECISION_RELATIVE.as_posix()}\n",
            encoding="ascii",
        )
        return decision

    def make_after(
        self,
        root,
        before_candidate,
        response_bytes=100,
        bootstrap_count=1,
        legacy=False,
        reuse_candidate=False,
    ):
        root.mkdir()
        after_candidate = (
            dict(before_candidate)
            if reuse_candidate
            else dict(
                before_candidate,
                artifact_id="a" * 64,
                binary_sha256="b" * 64,
                revision="c" * 40,
                tree="d" * 40,
                pr_base_revision=before_candidate["revision"],
            )
        )
        artifacts = {
            "baseline": dict(BASELINE),
            "candidate": after_candidate,
        }
        inputs = {}
        for serial, spec in enumerate(benchmark_gate.POLICY_COHORTS["full-v1"]):
            path = root / f"{spec.key}.jsonl"
            write_comparison(path, spec, artifacts, serial + 100)
            if spec.key == "dark":
                add_after_core_evidence(
                    path,
                    response_bytes,
                    bootstrap_count=bootstrap_count,
                    legacy=legacy,
                )
            inputs[spec.key] = path
        gate = root / "full-gate.json"
        benchmark_gate.write_report(
            gate,
            benchmark_gate.evaluate_gate("full-v1", inputs),
        )
        return inputs["dark"], gate

    def adoption_inputs(
        self,
        before_response_bytes=200,
        after_response_bytes=100,
        bootstrap_count=1,
        legacy=False,
        reuse_candidate=False,
    ):
        before = self.inputs(
            dispatch_ms=12.5,
            response_bytes=before_response_bytes,
        )
        source = before[2].parent / "decision-source.json"
        bootstrap_decision.run_decision(
            bootstrap_decision.DECISION_POLICY,
            *before,
            source,
        )
        report = json.loads(source.read_text(encoding="utf-8"))
        repo = before[2].parent / "repo"
        (repo / bootstrap_decision.IMPLEMENT_DECISION_RELATIVE.parent).mkdir(
            parents=True
        )
        decision = repo / bootstrap_decision.IMPLEMENT_DECISION_RELATIVE
        sidecar = repo / bootstrap_decision.IMPLEMENT_SIDECAR_RELATIVE
        with mock.patch.object(tui_benchmark, "REPO_ROOT", repo):
            bootstrap_decision.preserve_implement_decision(
                bootstrap_decision.DECISION_POLICY,
                "implement",
                True,
                source,
                *before,
                decision,
                sidecar,
            )
        after, gate = self.make_after(
            before[2].parent / "after",
            report["artifacts"]["candidate"],
            response_bytes=after_response_bytes,
            bootstrap_count=bootstrap_count,
            legacy=legacy,
            reuse_candidate=reuse_candidate,
        )
        return repo, decision, after, gate

    def evaluate(self, paths):
        repo, decision, after, gate = paths
        with mock.patch.object(tui_benchmark, "REPO_ROOT", repo):
            return bootstrap_decision.evaluate_adoption(
                bootstrap_decision.ADOPTION_POLICY,
                decision,
                after,
                gate,
            )

    def refresh_gate_hash(self, comparison, gate):
        report = json.loads(gate.read_text(encoding="utf-8"))
        report["inputs"]["dark"]["sha256"] = tui_benchmark._sha256_file(
            comparison
        )
        gate.unlink()
        benchmark_gate.write_report(gate, report)


class BootstrapAdoptionToolingTest(BootstrapAdoptionFixture):
    def test_reuses_verified_bootstrap_tooling_hash_without_rereading(self):
        paths = self.adoption_inputs()
        original = bootstrap_decision._load_preserved_implement_decision

        def load_then_remove_tooling(*args):
            result = original(*args)
            bootstrap_decision.__file__ = str(self.root / "removed-tooling.py")
            return result

        with mock.patch.object(
            bootstrap_decision,
            "_load_preserved_implement_decision",
            side_effect=load_then_remove_tooling,
        ) as load_decision:
            with mock.patch.object(
                bootstrap_decision,
                "__file__",
                bootstrap_decision.__file__,
            ):
                report = self.evaluate(paths)

        load_decision.assert_called_once_with(paths[1])
        preserved = json.loads(paths[1].read_text(encoding="utf-8"))
        self.assertEqual(report["tooling"], preserved["tooling"])


class BootstrapAdoptionCliTest(unittest.TestCase):
    def test_dispatches_documented_options(self):
        with mock.patch.object(bootstrap_decision, "run_adoption", return_value=0) as run:
            self.assertEqual(
                tui_benchmark.main(
                    [
                        "gate-bootstrap-adoption",
                        "--policy", "core-bootstrap-adoption-v1",
                        "--decision-artifact", "decision.json",
                        "--after", "after.jsonl",
                        "--full-gate", "gate.json",
                        "--output", "adoption.json",
                    ]
                ),
                0,
            )
        run.assert_called_once_with(
            "core-bootstrap-adoption-v1",
            Path("decision.json"),
            Path("after.jsonl"),
            Path("gate.json"),
            Path("adoption.json"),
        )

    def test_repeated_options_fail_before_dispatch(self):
        base = [
            "gate-bootstrap-adoption", "--policy", "core-bootstrap-adoption-v1",
            "--decision-artifact", "decision.json", "--after", "after.jsonl",
            "--full-gate", "gate.json", "--output", "adoption.json",
        ]
        repeated = {
            "--policy": "core-bootstrap-adoption-v1",
            "--decision-artifact": "other-decision.json",
            "--after": "other-after.jsonl",
            "--full-gate": "other-gate.json",
            "--output": "other-adoption.json",
        }
        with mock.patch.object(bootstrap_decision, "run_adoption") as run:
            for option, value in repeated.items():
                with self.subTest(option=option), self.assertRaises(SystemExit) as raised:
                    tui_benchmark.main([*base, option, value])
                self.assertEqual(raised.exception.code, 2)
        run.assert_not_called()

    def test_collision_failure_returns_nonzero_without_changing_existing_output(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "adoption.json"
            output.write_bytes(b"existing adoption\n")
            with mock.patch.object(
                bootstrap_decision,
                "run_adoption",
                side_effect=bootstrap_decision.DecisionFailure("adoption_gate_output_exists"),
            ):
                result = tui_benchmark.main(
                    [
                        "gate-bootstrap-adoption", "--policy", "core-bootstrap-adoption-v1",
                        "--decision-artifact", "decision.json", "--after", "after.jsonl",
                        "--full-gate", "gate.json", "--output", str(output),
                    ]
                )
            self.assertEqual(result, 1)
            self.assertEqual(output.read_bytes(), b"existing adoption\n")

    def test_help_smoke(self):
        completed = subprocess.run(
            ["python3", str(SCRIPT), "gate-bootstrap-adoption", "--help"],
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertIn("tui_benchmark.py gate-bootstrap-adoption", completed.stdout)


class BootstrapAdoptionGateTest(BootstrapAdoptionFixture):
    def test_decision_rejects_a_mixed_legacy_and_new_core_matrix(self):
        def add_bootstrap(rows):
            rows.append(
                rpc_row(
                    len(rows) + 1,
                    bootstrap_decision.CORE_BOOTSTRAP_REQUEST,
                    len(rows) * 3 + 1,
                    100,
                )
            )

        paths = self.inputs(dispatch_ms=12.5, mutate=add_bootstrap)
        with self.assertRaisesRegex(
            bootstrap_decision.DecisionFailure,
            "decision_core_request_matrix_invalid",
        ):
            bootstrap_decision.evaluate_decision(
                bootstrap_decision.DECISION_POLICY,
                *paths,
            )

    def test_passes_exact_count_and_twice_median_and_writes_canonical_report(self):
        values = list(range(10, 30))
        paths = self.adoption_inputs(after_response_bytes=values)
        report = self.evaluate(paths)
        self.assertTrue(report["passed"])
        self.assertEqual(report["evidence"]["before"]["core_request_count"], 5)
        self.assertEqual(report["evidence"]["after"]["core_request_count"], 1)
        self.assertEqual(
            report["evidence"]["before"]["response_bytes_twice_median"],
            2000,
        )
        self.assertEqual(
            report["evidence"]["after"]["response_bytes_twice_median"],
            39,
        )

        output = self.root / "adoption.json"
        repo, decision, after, gate = paths
        with mock.patch.object(tui_benchmark, "REPO_ROOT", repo):
            self.assertEqual(
                bootstrap_decision.run_adoption(
                    bootstrap_decision.ADOPTION_POLICY,
                    decision,
                    after,
                    gate,
                    output,
                ),
                0,
            )
            with self.assertRaisesRegex(
                bootstrap_decision.DecisionFailure,
                "adoption_gate_output_exists",
            ):
                bootstrap_decision.run_adoption(
                    bootstrap_decision.ADOPTION_POLICY,
                    decision,
                    after,
                    gate,
                    output,
                )
        content = output.read_bytes()
        self.assertEqual(content, tui_benchmark._canonical_json_bytes(json.loads(content)))
        self.assertNotIn(str(self.root), content.decode("utf-8"))
        self.assertEqual(
            json.loads(content)["privacy"]["fields"],
            list(bootstrap_decision.ADOPTION_PRIVACY_ALLOWLIST),
        )

    def test_equal_response_twice_median_is_a_rejected_gate_result(self):
        paths = self.adoption_inputs(after_response_bytes=1000)
        report = self.evaluate(paths)
        self.assertFalse(report["passed"])
        self.assertEqual(
            report["failures"],
            ["response_bytes_twice_median_not_strictly_lower"],
        )

    def test_residual_legacy_and_wrong_final_counts_fail_closed(self):
        cases = (
            ({"legacy": True}, "adoption_legacy_core_request_present"),
            ({"bootstrap_count": 0}, "adoption_core_request_count_invalid"),
            ({"bootstrap_count": 2}, "adoption_core_request_count_invalid"),
        )
        for index, (options, code) in enumerate(cases):
            with self.subTest(index=index), tempfile.TemporaryDirectory() as directory:
                original = self.root
                self.root = Path(directory)
                try:
                    with self.assertRaisesRegex(
                        bootstrap_decision.DecisionFailure,
                        code,
                    ):
                        self.evaluate(self.adoption_inputs(**options))
                finally:
                    self.root = original

    def test_incomplete_and_invalid_numeric_response_evidence_fail_closed(self):
        paths = self.adoption_inputs()
        records = read_records(paths[2])
        for record in records[1:-1]:
            if record["record"] == "sample" and record["arm"] == "candidate":
                row = record["measurement"]["rpc"][0]
                row["dispatch_sequence"] = None
                row["dispatch_receipt_ms"] = None
                row["dispatch_duration_ms"] = None
        write_records(paths[2], records)
        self.refresh_gate_hash(paths[2], paths[3])
        with self.assertRaisesRegex(
            bootstrap_decision.DecisionFailure,
            "adoption_core_request_incomplete",
        ):
            self.evaluate(paths)

        with tempfile.TemporaryDirectory() as directory:
            original = self.root
            self.root = Path(directory)
            try:
                paths = self.adoption_inputs()
                records = read_records(paths[2])
                for record in records[1:-1]:
                    if record["record"] == "sample" and record["arm"] == "candidate":
                        record["measurement"]["rpc"][0]["response_encoded_bytes"] = -1
                write_records(paths[2], records)
                self.refresh_gate_hash(paths[2], paths[3])
                with self.assertRaisesRegex(
                    bootstrap_decision.DecisionFailure,
                    "adoption_comparison_measurement_schema",
                ):
                    self.evaluate(paths)
            finally:
                self.root = original

    def test_decision_tamper_skip_and_relative_sidecar_mismatch_fail_closed(self):
        paths = self.adoption_inputs()
        report = json.loads(paths[1].read_text(encoding="utf-8"))
        report["inputs"]["comparison_sha256"] = "0" * 64
        paths[1].write_bytes(tui_benchmark._canonical_json_bytes(report))
        with self.assertRaisesRegex(
            bootstrap_decision.DecisionFailure,
            "adoption_decision_sidecar_invalid",
        ):
            self.evaluate(paths)

        with tempfile.TemporaryDirectory() as directory:
            original = self.root
            self.root = Path(directory)
            try:
                paths = self.adoption_inputs()
                report = json.loads(paths[1].read_text(encoding="utf-8"))
                report["decision"] = "skip"
                report["evidence"]["removable_dispatch_ms_median"] = 0.0
                report["evidence"]["removable_dispatch_qualifies"] = False
                self.install_decision(paths[0], report)
                with self.assertRaisesRegex(
                    bootstrap_decision.DecisionFailure,
                    "adoption_implement_decision_required",
                ):
                    self.evaluate(paths)
            finally:
                self.root = original

        with tempfile.TemporaryDirectory() as directory:
            original = self.root
            self.root = Path(directory)
            try:
                paths = self.adoption_inputs()
                digest = tui_benchmark._sha256_file(paths[1])
                sidecar = paths[0] / bootstrap_decision.IMPLEMENT_SIDECAR_RELATIVE
                sidecar.write_text(f"{digest}  {paths[1]}\n", encoding="ascii")
                with self.assertRaisesRegex(
                    bootstrap_decision.DecisionFailure,
                    "adoption_decision_sidecar_invalid",
                ):
                    self.evaluate(paths)
            finally:
                self.root = original

    def test_gate_hash_tooling_and_candidate_provenance_drift_fail_closed(self):
        paths = self.adoption_inputs()
        report = json.loads(paths[3].read_text(encoding="utf-8"))
        report["inputs"]["dark"]["sha256"] = "0" * 64
        paths[3].unlink()
        benchmark_gate.write_report(paths[3], report)
        with self.assertRaisesRegex(
            bootstrap_decision.DecisionFailure,
            "adoption_phase_full_gate_hash_drift",
        ):
            self.evaluate(paths)

        with tempfile.TemporaryDirectory() as directory:
            original = self.root
            self.root = Path(directory)
            try:
                paths = self.adoption_inputs()
                report = json.loads(paths[3].read_text(encoding="utf-8"))
                report["tooling"]["benchmark_gate_sha256"] = "0" * 64
                paths[3].unlink()
                benchmark_gate.write_report(paths[3], report)
                with self.assertRaisesRegex(
                    bootstrap_decision.DecisionFailure,
                    "adoption_phase_full_gate_tooling_drift",
                ):
                    self.evaluate(paths)
            finally:
                self.root = original

        with tempfile.TemporaryDirectory() as directory:
            original = self.root
            self.root = Path(directory)
            try:
                with self.assertRaisesRegex(
                    bootstrap_decision.DecisionFailure,
                    "adoption_candidate_not_distinct",
                ):
                    self.evaluate(self.adoption_inputs(reuse_candidate=True))
            finally:
                self.root = original

    def test_wrong_policy_and_nonfixed_decision_path_fail_closed(self):
        paths = self.adoption_inputs()
        with self.assertRaisesRegex(
            bootstrap_decision.DecisionFailure,
            "adoption_policy_invalid",
        ):
            repo, decision, after, gate = paths
            with mock.patch.object(tui_benchmark, "REPO_ROOT", repo):
                bootstrap_decision.evaluate_adoption(
                    "other",
                    decision,
                    after,
                    gate,
                )
        wrong = self.root / "copied-decision.json"
        wrong.write_bytes(paths[1].read_bytes())
        with self.assertRaisesRegex(
            bootstrap_decision.DecisionFailure,
            "adoption_decision_path_invalid",
        ):
            repo, _, after, gate = paths
            with mock.patch.object(tui_benchmark, "REPO_ROOT", repo):
                bootstrap_decision.evaluate_adoption(
                    bootstrap_decision.ADOPTION_POLICY,
                    wrong,
                    after,
                    gate,
                )


if __name__ == "__main__":
    unittest.main()
