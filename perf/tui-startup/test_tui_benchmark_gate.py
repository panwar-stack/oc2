import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import benchmark_gate
import tui_benchmark


BASELINE = {
    "artifact_id": "1" * 64,
    "binary_sha256": "2" * 64,
    "revision": "3" * 40,
    "tree": "4" * 40,
    "pr_base_revision": "5" * 40,
    "clean": True,
    "shell_capability": "unavailable",
}
CANDIDATE_UNAVAILABLE = {
    "artifact_id": "6" * 64,
    "binary_sha256": "7" * 64,
    "revision": "8" * 40,
    "tree": "9" * 40,
    "pr_base_revision": "5" * 40,
    "clean": True,
    "shell_capability": "unavailable",
}
CANDIDATE_REQUIRED = dict(CANDIDATE_UNAVAILABLE, shell_capability="required")
HOST = {
    "os": "test-os",
    "os_release": "1.0",
    "arch": "test-arch",
    "python_version": "3.11.0",
}


def metric_values(spec, arm, overrides=None):
    values = {
        "first_frame_ms": 500.0,
        "shell_ms": 800.0,
        "prompt_ms": 1000.0,
        "interactive_ms": 1200.0,
    }
    if arm == "baseline":
        values["prompt_ms"] += 100
        values["interactive_ms"] += 100
    if spec.key == "none":
        values["prompt_ms"] += 50
        values["interactive_ms"] += 50
    if overrides:
        values.update(overrides.get((spec.key, arm), {}))
    return values


def measurement(spec, arm, run_id, capability, overrides=None):
    metrics = metric_values(spec, arm, overrides)
    result = tui_benchmark._empty_result(None, True, run_id)
    result.update(
        {
            "first_byte_ms": 100.0,
            "ready_ms": metrics["prompt_ms"],
            "ttfd_ms": 900.0,
            "bytes_until_ready": 100,
            "timed_out": False,
            "first_frame_ms": metrics["first_frame_ms"],
            "shell_ms": metrics["shell_ms"] if capability == "required" else None,
            "prompt_ms": metrics["prompt_ms"],
            "critical_ready_ms": 900.0,
            "theme_settled_ms": 950.0,
            "theme_settled_outcome": (
                "fallback-final"
                if spec.theme_response in ("none", "malformed", "late:1250")
                else "resolved"
            ),
            "interactive_ms": metrics["interactive_ms"] if spec.interaction_probe else None,
            "input_accepted_ms": metrics["prompt_ms"] if spec.interaction_probe else None,
            "workspace_generation": 0,
            "attempt_generation": 0,
            "trace_records": 2,
            "foreground_query_count": 1,
            "background_query_count": 1,
            "foreground_response_count": 0 if spec.theme_response == "none" else 1,
            "background_response_count": (
                0 if spec.theme_response in ("none", "malformed") else 1
            ),
            "theme_reconciliation_count": 1 if spec.theme_response == "late:1250" else 0,
            "probe_body_visible": spec.interaction_probe,
            "probe_noecho_verified": spec.interaction_probe,
            "probe_guard_sent": spec.interaction_probe,
            "probe_persistence_verified": spec.interaction_probe,
            "probe_removal_verified": spec.interaction_probe,
            "probe_backspace_count": benchmark_gate.PROBE_BACKSPACE_COUNT if spec.interaction_probe else 0,
            "probe_verified_reconciliation_count": 1 if spec.theme_response == "late:1250" else 0,
            "theme_activity_verified": spec.interaction_probe,
            "phases": [],
            "rpc": [],
            "failure": None,
        }
    )
    return result


def metadata(spec, artifacts):
    entries = tui_benchmark.build_balanced_schedule(
        spec.samples_per_arm,
        spec.mode,
        benchmark_gate.SCHEDULE_SEED,
    )
    state_policy = (
        "isolated-warm-per-arm-v1"
        if spec.mode == "warm"
        else "isolated-cold-like-per-sample-v1"
    )
    value = {
        "schema": tui_benchmark.COMPARE_SCHEMA,
        "version": tui_benchmark.COMPARE_VERSION,
        "record": "metadata",
        "label": spec.label,
        "scenario": {
            "mode": spec.mode,
            "theme_response": spec.theme_response,
            "metric_set": spec.metric_set,
            "interaction_probe": spec.interaction_probe,
            "timeout_ms": 12000,
            "pty": {"width": tui_benchmark.PTY_WIDTH, "height": tui_benchmark.PTY_HEIGHT},
        },
        "command": {"argv": ["$ARTIFACT_BINARY", "--pure", "$REPO"], "cwd": "$REPO"},
        "controlled_environment": benchmark_gate._expected_environment(),
        "state_policy": {
            "version": 1,
            "name": state_policy,
            "warm_seeds_per_arm": 1 if spec.mode == "warm" else 0,
            "writable_state_shared_between_arms": False,
        },
        "artifacts": artifacts,
        "run_host": dict(HOST),
        "tooling": tui_benchmark._tooling_hashes(),
        "trace_allowlist": {
            "version": tui_benchmark.TRACE_EVIDENCE_VERSION,
            "phases": sorted(tui_benchmark.TRACE_PHASES),
            "rpc_requests": sorted(tui_benchmark.TRACE_REQUESTS),
        },
        "schedule": {
            "version": tui_benchmark.SCHEDULE_VERSION,
            "seed": benchmark_gate.SCHEDULE_SEED,
            "sha256": tui_benchmark._schedule_hash(entries),
            "entries": entries,
        },
    }
    value["comparison_id"] = tui_benchmark._sha256_bytes(
        tui_benchmark._canonical_json_bytes(value, final_newline=False)
    )
    return value


def write_comparison(path, spec, artifacts, serial, overrides=None):
    meta = metadata(spec, artifacts)
    entries = meta["schedule"]["entries"]
    observed = []
    records = [meta]
    for entry in entries:
        arm = entry["arm"]
        capability = artifacts[arm]["shell_capability"]
        item = measurement(
            spec,
            arm,
            f"run_{serial}_{entry['schedule_index']}",
            capability,
            overrides,
        )
        state_id = (
            f"warm/{arm}"
            if spec.mode == "warm"
            else f"cold-like/{arm}/{entry['arm_sample']:04d}"
        )
        records.append(
            {
                "schema": tui_benchmark.COMPARE_SCHEMA,
                "version": tui_benchmark.COMPARE_VERSION,
                "record": entry["kind"],
                "comparison_id": meta["comparison_id"],
                "label": spec.label,
                "schedule_index": entry["schedule_index"],
                "pair": entry["pair"],
                "arm": arm,
                "arm_sample": entry["arm_sample"],
                "artifact_id": artifacts[arm]["artifact_id"],
                "state_id": state_id,
                "state_policy": meta["state_policy"]["name"],
                "measurement": item,
            }
        )
        observed.append((entry, item))
    records.append(benchmark_gate._expected_summary(meta, spec, observed))
    path.write_bytes(b"".join(tui_benchmark._canonical_json_bytes(item) for item in records))


def make_policy(root, policy, overrides=None):
    artifacts = {
        "baseline": dict(BASELINE),
        "candidate": dict(
            CANDIDATE_UNAVAILABLE if policy == "pre-shell-v1" else CANDIDATE_REQUIRED
        ),
    }
    inputs = {}
    for serial, spec in enumerate(benchmark_gate.POLICY_COHORTS[policy]):
        path = root / f"{spec.key}.jsonl"
        write_comparison(path, spec, artifacts, serial, overrides)
        inputs[spec.key] = path
    return inputs


def read_records(path):
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


def write_records(path, records):
    path.write_bytes(b"".join(tui_benchmark._canonical_json_bytes(item) for item in records))


def relink_metadata(records):
    metadata_record = records[0]
    without_id = {key: value for key, value in metadata_record.items() if key != "comparison_id"}
    comparison_id = tui_benchmark._sha256_bytes(
        tui_benchmark._canonical_json_bytes(without_id, final_newline=False)
    )
    metadata_record["comparison_id"] = comparison_id
    for record in records[1:]:
        record["comparison_id"] = comparison_id


class MatrixAndStatisticsTest(unittest.TestCase):
    def test_exact_policy_matrices(self):
        self.assertEqual(
            [(item.key, item.samples_per_arm, item.mode, item.theme_response) for item in benchmark_gate.POLICY_COHORTS["pre-shell-v1"]],
            [
                ("dark", 20, "warm", "dark"),
                ("light", 20, "warm", "light"),
                ("none", 20, "warm", "none"),
                ("malformed", 3, "cold-like", "malformed"),
                ("late", 3, "cold-like", "late:1250"),
            ],
        )
        self.assertEqual(
            [item.key for item in benchmark_gate.POLICY_COHORTS["shell-v1"]],
            ["dark", "light", "none"],
        )
        self.assertEqual(
            [(item.key, item.samples_per_arm) for item in benchmark_gate.POLICY_COHORTS["full-v1"]],
            [("dark", 20), ("light", 20), ("none", 20), ("cold", 15), ("malformed", 3), ("late", 3)],
        )

    def test_exact_median_and_linear_p95(self):
        self.assertEqual(benchmark_gate.median([4.0, 1.0, 3.0, 2.0]), 2.5)
        self.assertEqual(benchmark_gate.linear_p95([0.0, 100.0]), 95.0)
        with self.assertRaisesRegex(benchmark_gate.GateFailure, "gate_metric_invalid"):
            benchmark_gate.linear_p95([])


class AggregateCliTest(unittest.TestCase):
    def test_dispatches_each_policy_with_exact_cohort_mapping(self):
        for policy, specs in benchmark_gate.POLICY_COHORTS.items():
            with self.subTest(policy=policy):
                output = Path("gate.json")
                inputs = {spec.key: Path(f"{spec.key}.jsonl") for spec in specs}
                arguments = ["gate", "--policy", policy]
                for key, path in inputs.items():
                    arguments.extend((f"--{key}", str(path)))
                arguments.extend(("--output", str(output)))
                with mock.patch.object(benchmark_gate, "run_gate", return_value=0) as run_gate:
                    self.assertEqual(tui_benchmark.main(arguments), 0)
        run_gate.assert_called_once_with(policy, inputs, output)

    def test_repeated_gate_options_fail_before_dispatch(self):
        arguments = [
            "gate",
            "--policy",
            "full-v1",
            "--dark",
            "dark.jsonl",
            "--light",
            "light.jsonl",
            "--none",
            "none.jsonl",
            "--cold",
            "cold.jsonl",
            "--malformed",
            "malformed.jsonl",
            "--late",
            "late.jsonl",
            "--output",
            "gate.json",
        ]
        repeated = {
            "--policy": "full-v1",
            "--dark": "other-dark.jsonl",
            "--light": "other-light.jsonl",
            "--none": "other-none.jsonl",
            "--cold": "other-cold.jsonl",
            "--malformed": "other-malformed.jsonl",
            "--late": "other-late.jsonl",
            "--output": "other-gate.json",
        }
        with mock.patch.object(benchmark_gate, "run_gate") as run_gate:
            for option, value in repeated.items():
                with self.subTest(option=option), self.assertRaises(SystemExit) as raised:
                    tui_benchmark.main([*arguments, option, value])
                self.assertEqual(raised.exception.code, 2)
        run_gate.assert_not_called()

    def test_gate_failure_returns_nonzero_and_preserves_existing_output(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "gate.json"
            output.write_bytes(b"existing\n")
            with mock.patch.object(
                benchmark_gate,
                "run_gate",
                side_effect=benchmark_gate.GateFailure("gate_output_exists"),
            ):
                self.assertEqual(
                    tui_benchmark.main(
                        [
                            "gate",
                            "--policy",
                            "shell-v1",
                            "--dark",
                            "dark.jsonl",
                            "--light",
                            "light.jsonl",
                            "--none",
                            "none.jsonl",
                            "--output",
                            str(output),
                        ]
                    ),
                    1,
                )
            self.assertEqual(output.read_bytes(), b"existing\n")


class AggregatePolicyTest(unittest.TestCase):
    def test_all_policies_pass_and_reports_are_canonical_path_free_and_exclusive(self):
        for policy in benchmark_gate.POLICY_COHORTS:
            with self.subTest(policy=policy), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                inputs = make_policy(root, policy)
                output = root / "gate.json"
                self.assertEqual(benchmark_gate.run_gate(policy, inputs, output), 0)
                content = output.read_bytes()
                report = json.loads(content)
                self.assertEqual(content, tui_benchmark._canonical_json_bytes(report))
                self.assertTrue(report["passed"])
                self.assertEqual(set(report["inputs"]), set(inputs))
                self.assertNotIn(str(root), content.decode("utf-8"))
                with self.assertRaisesRegex(benchmark_gate.GateFailure, "gate_output_exists"):
                    benchmark_gate.run_gate(policy, inputs, output)

    def test_absolute_p95_relative_p95_and_no_response_boundaries(self):
        cases = (
            (
                {
                    ("dark", "baseline"): {"prompt_ms": 1600.0, "interactive_ms": 1700.0},
                    ("dark", "candidate"): {"prompt_ms": 1600.0, "interactive_ms": 1700.0},
                },
                True,
                None,
            ),
            (
                {
                    ("dark", "baseline"): {"prompt_ms": 1600.01, "interactive_ms": 1700.0},
                    ("dark", "candidate"): {"prompt_ms": 1600.01, "interactive_ms": 1700.0},
                },
                False,
                "dark_candidate_prompt_ms_median_absolute",
            ),
            (
                {
                    ("cold", "baseline"): {"prompt_ms": 1000.0},
                    ("cold", "candidate"): {"prompt_ms": 1050.0},
                },
                True,
                None,
            ),
            (
                {
                    ("cold", "baseline"): {"prompt_ms": 1000.0},
                    ("cold", "candidate"): {"prompt_ms": 1050.01},
                },
                False,
                "cold_candidate_prompt_ms_p95_baseline",
            ),
            ({("none", "candidate"): {"prompt_ms": 1100.0}}, True, None),
            (
                {("none", "candidate"): {"prompt_ms": 1100.01}},
                False,
                "none_candidate_prompt_ms_median_dark_gap",
            ),
        )
        for index, (overrides, passed, failure) in enumerate(cases):
            with self.subTest(index=index), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                inputs = make_policy(root, "full-v1", overrides)
                report = benchmark_gate.evaluate_gate("full-v1", inputs)
                self.assertIs(report["passed"], passed)
                if failure is not None:
                    self.assertIn(failure, report["failures"])

    def test_shell_absolute_thresholds(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            inputs = make_policy(
                root,
                "shell-v1",
                {("dark", "candidate"): {"shell_ms": 1500.01}},
            )
            report = benchmark_gate.evaluate_gate("shell-v1", inputs)
            self.assertFalse(report["passed"])
            self.assertIn("dark_candidate_shell_ms_median_absolute", report["failures"])
            self.assertIn("dark_candidate_shell_ms_p95_absolute", report["failures"])


class FailClosedValidationTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.inputs = make_policy(self.root, "pre-shell-v1")

    def tearDown(self):
        self.directory.cleanup()

    def test_missing_and_extra_cohorts_fail(self):
        missing = dict(self.inputs)
        missing.pop("late")
        with self.assertRaisesRegex(benchmark_gate.GateFailure, "gate_cohort_matrix_mismatch"):
            benchmark_gate.evaluate_gate("pre-shell-v1", missing)
        extra = dict(self.inputs, cold=self.inputs["dark"])
        with self.assertRaisesRegex(benchmark_gate.GateFailure, "gate_cohort_matrix_mismatch"):
            benchmark_gate.evaluate_gate("pre-shell-v1", extra)

    def test_schema_canonical_count_schedule_and_summary_fail_closed(self):
        mutations = (
            ("schema", lambda records: records[0].update({"extra": True}), "comparison_metadata_schema"),
            ("schedule", lambda records: records[1].update({"schedule_index": 99}), "comparison_wrapper_mismatch"),
            ("summary", lambda records: records[-1].update({"observed_schedule_records": 0}), "comparison_summary_mismatch"),
        )
        for name, mutate, code in mutations:
            with self.subTest(name=name):
                path = self.root / f"mutated-{name}.jsonl"
                records = read_records(self.inputs["dark"])
                mutate(records)
                write_records(path, records)
                with self.assertRaisesRegex(benchmark_gate.GateFailure, code):
                    benchmark_gate.load_comparison(path, benchmark_gate.POLICY_COHORTS["pre-shell-v1"][0])

        truncated = self.root / "truncated.jsonl"
        records = read_records(self.inputs["dark"])
        write_records(truncated, records[:-1])
        with self.assertRaisesRegex(benchmark_gate.GateFailure, "comparison_record_count_mismatch"):
            benchmark_gate.load_comparison(truncated, benchmark_gate.POLICY_COHORTS["pre-shell-v1"][0])

        noncanonical = self.root / "noncanonical.jsonl"
        records = read_records(self.inputs["dark"])
        noncanonical.write_text("\n".join(json.dumps(item, sort_keys=True) for item in records) + "\n", encoding="utf-8")
        with self.assertRaisesRegex(benchmark_gate.GateFailure, "comparison_not_canonical"):
            benchmark_gate.load_comparison(noncanonical, benchmark_gate.POLICY_COHORTS["pre-shell-v1"][0])

    def test_lifecycle_theme_and_probe_evidence_fail_closed(self):
        cases = (
            ("milestone", lambda item: item.update({"first_frame_ms": 1101.0}), "comparison_milestone_lifecycle_invalid"),
            ("theme", lambda item: item.update({"theme_settled_outcome": "fallback-final"}), "comparison_theme_lifecycle_invalid"),
            ("activity", lambda item: item.update({"foreground_response_count": 0}), "comparison_theme_activity_invalid"),
            ("probe", lambda item: item.update({"probe_removal_verified": False}), "comparison_measurement_schema"),
            ("failure", lambda item: item.update({"failure": "fixture_invalid"}), "comparison_invalid_sample"),
        )
        for name, mutate, code in cases:
            with self.subTest(name=name):
                path = self.root / f"lifecycle-{name}.jsonl"
                records = read_records(self.inputs["dark"])
                mutate(records[1]["measurement"])
                write_records(path, records)
                with self.assertRaisesRegex(benchmark_gate.GateFailure, code):
                    benchmark_gate.load_comparison(path, benchmark_gate.POLICY_COHORTS["pre-shell-v1"][0])

    def test_capability_state_command_and_cross_cohort_provenance_fail_closed(self):
        path = self.root / "private-command.jsonl"
        records = read_records(self.inputs["dark"])
        records[0]["command"]["cwd"] = "/private/workspace"
        relink_metadata(records)
        write_records(path, records)
        with self.assertRaisesRegex(benchmark_gate.GateFailure, "comparison_execution_provenance"):
            benchmark_gate.load_comparison(path, benchmark_gate.POLICY_COHORTS["pre-shell-v1"][0])

        path = self.root / "state.jsonl"
        records = read_records(self.inputs["dark"])
        records[0]["state_policy"]["writable_state_shared_between_arms"] = True
        relink_metadata(records)
        write_records(path, records)
        with self.assertRaisesRegex(benchmark_gate.GateFailure, "comparison_state_policy_mismatch"):
            benchmark_gate.load_comparison(path, benchmark_gate.POLICY_COHORTS["pre-shell-v1"][0])

        records = read_records(self.inputs["light"])
        records[0]["artifacts"]["candidate"]["revision"] = "a" * 40
        relink_metadata(records)
        write_records(self.inputs["light"], records)
        with self.assertRaisesRegex(benchmark_gate.GateFailure, "gate_cohort_provenance_mismatch"):
            benchmark_gate.evaluate_gate("pre-shell-v1", self.inputs)

    def test_duplicate_run_ids_and_duplicate_json_keys_fail_closed(self):
        path = self.root / "duplicate-run.jsonl"
        records = read_records(self.inputs["dark"])
        records[2]["measurement"]["run_id"] = records[1]["measurement"]["run_id"]
        write_records(path, records)
        with self.assertRaisesRegex(benchmark_gate.GateFailure, "comparison_run_id_reused"):
            benchmark_gate.load_comparison(path, benchmark_gate.POLICY_COHORTS["pre-shell-v1"][0])

        duplicate = self.root / "duplicate-key.jsonl"
        content = self.inputs["dark"].read_bytes()
        duplicate.write_bytes(content.replace(b'{"artifacts"', b'{"schema":"duplicate","artifacts"', 1))
        with self.assertRaisesRegex(benchmark_gate.GateFailure, "comparison_duplicate_key"):
            benchmark_gate.load_comparison(duplicate, benchmark_gate.POLICY_COHORTS["pre-shell-v1"][0])


if __name__ == "__main__":
    unittest.main()
