import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import tui_benchmark


SOURCE = {
    "revision": "a" * 40,
    "tree": "b" * 40,
    "pr_base_revision": "c" * 40,
    "clean": True,
}
TOOLING = {
    "tui_benchmark_sha256": "1" * 64,
    "tui_probe_sha256": "2" * 64,
    "terminal_screen_sha256": "3" * 64,
}
HOST = {
    "os": "test-os",
    "os_release": "1.0",
    "arch": "test-arch",
    "python_version": "3.11.0",
    "bun_version": "1.3.14",
}


def measurement(failure=None):
    result = tui_benchmark._empty_result(failure, True, "run_test")
    result.update(
        {
            "first_byte_ms": 1.0,
            "ready_ms": 2.0,
            "ttfd_ms": 1.5,
            "timed_out": False,
            "first_frame_ms": 1.25,
            "prompt_ms": 2.25,
            "critical_ready_ms": 2.5,
            "theme_settled_ms": 2.75,
            "theme_settled_outcome": "resolved",
            "interactive_ms": 3.0,
            "input_accepted_ms": 2.0,
            "workspace_generation": 0,
            "attempt_generation": 0,
            "trace_records": 4,
            "probe_body_visible": True,
            "probe_noecho_verified": True,
            "probe_guard_sent": True,
            "probe_persistence_verified": True,
            "probe_removal_verified": True,
            "probe_backspace_count": 43,
            "theme_activity_verified": True,
            "phases": [
                {
                    "sequence": 1,
                    "phase": "renderer.create",
                    "role": "main",
                    "outcome": "ok",
                    "duration_ms": 0.5,
                    "receipt_ms": 1.0,
                }
            ],
            "rpc": [],
            "failure": failure,
        }
    )
    return result


class ComparisonTestCase(unittest.TestCase):
    def preserve(self, root, name, content, capability):
        source = root / f"{name}.bin"
        source.write_bytes(content)
        source.chmod(0o755)
        output = root / name
        with mock.patch.object(tui_benchmark, "_git_source_identity", return_value=dict(SOURCE)):
            with mock.patch.object(tui_benchmark, "_tooling_hashes", return_value=dict(TOOLING)):
                with mock.patch.object(tui_benchmark, "_host_record", return_value=dict(HOST)):
                    tui_benchmark.preserve_artifact(
                        name,
                        source,
                        "bun run dev:build",
                        capability,
                        output,
                    )
        return output

    def setup_artifacts(self, root, candidate_capability="required"):
        baseline = self.preserve(root, "baseline", b"#!/bin/sh\nexit 0\n", "unavailable")
        candidate = self.preserve(root, "candidate", b"#!/bin/sh\nexit 1\n", candidate_capability)
        return baseline, candidate

    def args(self, root, baseline, candidate, mode="warm", samples=2, metric_set="full", output=None):
        output = output or root / "result.jsonl"
        return tui_benchmark.build_compare_parser().parse_args(
            [
                "--label",
                "comparison",
                "--samples-per-arm",
                str(samples),
                "--mode",
                mode,
                "--theme-response",
                "dark",
                "--metric-set",
                metric_set,
                "--schedule-seed",
                "20260728",
                "--baseline-artifact",
                str(baseline),
                "--candidate-artifact",
                str(candidate),
                "--output",
                str(output),
                "--cwd",
                str(root),
                "--state-root",
                str(root / "state"),
                "--interaction-probe",
                "--",
                "--pure",
                str(root),
            ]
        )

    def records(self, output):
        return [json.loads(line) for line in output.read_text(encoding="utf-8").splitlines()]


class CliAndScheduleTest(ComparisonTestCase):
    def test_new_cli_shape_and_legacy_parser_remain_compatible(self):
        legacy = tui_benchmark.build_parser().parse_args(
            ["--label", "legacy", "--samples", "1", "--mode", "warm", "--", "command"]
        )
        self.assertEqual(legacy.command, ["--", "command"])
        self.assertTrue(hasattr(legacy, "force"))

        compare = tui_benchmark.build_compare_parser().parse_args(
            [
                "--label", "ab", "--samples-per-arm", "2", "--mode", "warm",
                "--theme-response", "late:1250", "--metric-set", "full",
                "--schedule-seed", "20260728", "--baseline-artifact", "base",
                "--candidate-artifact", "candidate", "--output", "result", "--", "--pure", ".",
            ]
        )
        self.assertEqual(compare.theme_response, tui_benchmark.ThemeFixture("late", 1250))
        self.assertEqual(compare.command, ["--", "--pure", "."])
        with self.assertRaises(SystemExit):
            tui_benchmark.build_compare_parser().parse_args(
                ["--force", "--label", "x"]
            )
        with self.assertRaises(SystemExit):
            tui_benchmark.build_preserve_parser().parse_args(["--policy", "full-v1"])

    def test_schedule_is_deterministic_balanced_and_fully_precomputed(self):
        for mode in ("warm", "cold-like"):
            first = tui_benchmark.build_balanced_schedule(5, mode, 20260728)
            second = tui_benchmark.build_balanced_schedule(5, mode, 20260728)
            self.assertEqual(first, second)
            self.assertEqual([item["schedule_index"] for item in first], list(range(len(first))))
            measured = [item for item in first if item["kind"] == "sample"]
            self.assertEqual(len(measured), 10)
            for offset in range(0, len(measured), 2):
                self.assertEqual({measured[offset]["arm"], measured[offset + 1]["arm"]}, {"baseline", "candidate"})
                self.assertEqual(measured[offset]["pair"], measured[offset + 1]["pair"])
            first_positions = [measured[index]["arm"] for index in range(0, len(measured), 2)]
            self.assertLessEqual(abs(first_positions.count("baseline") - first_positions.count("candidate")), 1)
            seeds = [item for item in first if item["kind"] == "seed"]
            self.assertEqual(len(seeds), 2 if mode == "warm" else 0)


class ComparisonExecutionTest(ComparisonTestCase):
    def test_warm_metadata_is_durable_first_and_records_exact_order_and_states(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            baseline, candidate = self.setup_artifacts(root)
            output = root / "warm.jsonl"
            args = self.args(root, baseline, candidate, output=output)
            metadata_durable = False
            calls = []
            original_fsync = tui_benchmark._flush_fsync

            def durable(stream):
                nonlocal metadata_durable
                original_fsync(stream)
                metadata_durable = True

            def run(command, state, cwd, timeout, theme, ready, probe):
                self.assertTrue(metadata_durable)
                calls.append((command, state, cwd, probe))
                return measurement()

            with mock.patch.object(tui_benchmark, "_flush_fsync", side_effect=durable):
                with mock.patch.object(tui_benchmark, "run_once", side_effect=run):
                    self.assertEqual(tui_benchmark.run_comparison(args), 0)

            records = self.records(output)
            self.assertEqual([item["record"] for item in records], ["metadata", "seed", "seed", "sample", "sample", "sample", "sample", "summary"])
            metadata = records[0]
            self.assertEqual(metadata["schedule"]["entries"], tui_benchmark.build_balanced_schedule(2, "warm", 20260728))
            self.assertEqual(metadata["schedule"]["sha256"], tui_benchmark._schedule_hash(metadata["schedule"]["entries"]))
            self.assertEqual(metadata["command"], {"argv": ["$ARTIFACT_BINARY", "--pure", "$CWD"], "cwd": "$CWD"})
            self.assertEqual(metadata["state_policy"]["name"], "isolated-warm-per-arm-v1")
            self.assertFalse(metadata["state_policy"]["writable_state_shared_between_arms"])
            self.assertEqual(metadata["artifacts"]["candidate"]["pr_base_revision"], SOURCE["pr_base_revision"])

            wrapped = records[1:-1]
            self.assertEqual([item["schedule_index"] for item in wrapped], list(range(6)))
            self.assertEqual({item["state_id"] for item in wrapped}, {"warm/baseline", "warm/candidate"})
            self.assertTrue(all(item["measurement"]["phases"] for item in wrapped))
            self.assertEqual(len({str(call[1]) for call in calls if "baseline" in str(call[1])}), 1)
            self.assertEqual(len({str(call[1]) for call in calls if "candidate" in str(call[1])}), 1)
            for call, wrapper in zip(calls, wrapped):
                expected_root = baseline if wrapper["arm"] == "baseline" else candidate
                self.assertEqual(Path(call[0][0]), expected_root / "bin" / "oc2")
                self.assertEqual(call[0][1:], ["--pure", str(root)])
                self.assertEqual(call[2], root.resolve())
                self.assertTrue(call[3])
            summary = records[-1]
            self.assertIsNone(summary["comparison_failure"])
            self.assertNotIn("policy", summary)
            self.assertNotIn("passed", summary)
            self.assertNotIn("decision", summary)

    def test_cold_like_uses_unique_per_sample_states_and_has_no_seeds(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            baseline, candidate = self.setup_artifacts(root)
            output = root / "cold.jsonl"
            args = self.args(root, baseline, candidate, mode="cold-like", samples=3, output=output)
            states = []
            with mock.patch.object(
                tui_benchmark,
                "run_once",
                side_effect=lambda command, state, *rest: states.append(state) or measurement(),
            ):
                self.assertEqual(tui_benchmark.run_comparison(args), 0)
            records = self.records(output)
            self.assertEqual([item["record"] for item in records], ["metadata"] + ["sample"] * 6 + ["summary"])
            self.assertEqual(len(states), len(set(states)))
            self.assertEqual(len({item["state_id"] for item in records[1:-1]}), 6)
            self.assertEqual(records[0]["state_policy"]["name"], "isolated-cold-like-per-sample-v1")

    def test_invalid_sample_continues_but_invalid_seed_stops_measured_schedule(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            baseline, candidate = self.setup_artifacts(root)
            cold_output = root / "cold.jsonl"
            cold = self.args(root, baseline, candidate, mode="cold-like", samples=2, output=cold_output)
            values = [measurement("fixture_invalid"), measurement(), measurement(), measurement()]
            with mock.patch.object(tui_benchmark, "run_once", side_effect=values):
                self.assertEqual(tui_benchmark.run_comparison(cold), 1)
            cold_records = self.records(cold_output)
            self.assertEqual([item["record"] for item in cold_records].count("sample"), 4)
            self.assertEqual(cold_records[-1]["comparison_failure"], "invalid_sample")

            malformed_output = root / "malformed.jsonl"
            malformed = self.args(root, baseline, candidate, mode="cold-like", samples=1, output=malformed_output)
            with mock.patch.object(tui_benchmark, "run_once", side_effect=({}, measurement())):
                self.assertEqual(tui_benchmark.run_comparison(malformed), 1)
            malformed_records = self.records(malformed_output)
            self.assertEqual(len([item for item in malformed_records if item["record"] == "sample"]), 2)
            self.assertEqual(
                malformed_records[1]["measurement"]["failure"],
                "invalid_measurement_schema",
            )
            self.assertEqual(malformed_records[-1]["comparison_failure"], "invalid_sample")

            malformed_rpc_output = root / "malformed-rpc.jsonl"
            malformed_rpc_args = self.args(
                root,
                baseline,
                candidate,
                mode="cold-like",
                samples=1,
                output=malformed_rpc_output,
            )
            malformed_rpc = measurement()
            rpc_record = {
                "request_id": 1,
                "name": "config.get",
                "request_sequence": 8,
                "request_receipt_ms": 1.0,
                "request_encoded_bytes": 10,
                "dispatch_sequence": None,
                "dispatch_receipt_ms": None,
                "dispatch_duration_ms": None,
                "response_sequence": None,
                "response_receipt_ms": None,
                "response_encoded_bytes": None,
                "removable_duplicate_bytes": None,
            }
            malformed_rpc["rpc"] = [rpc_record, dict(rpc_record, name="project.path", request_sequence=9)]
            with mock.patch.object(tui_benchmark, "run_once", side_effect=(malformed_rpc, measurement())):
                self.assertEqual(tui_benchmark.run_comparison(malformed_rpc_args), 1)
            self.assertEqual(
                self.records(malformed_rpc_output)[1]["measurement"]["failure"],
                "invalid_measurement_schema",
            )

            warm_output = root / "warm.jsonl"
            warm = self.args(root, baseline, candidate, mode="warm", samples=2, output=warm_output)
            with mock.patch.object(tui_benchmark, "run_once", side_effect=(measurement("seed_invalid"), measurement())):
                self.assertEqual(tui_benchmark.run_comparison(warm), 1)
            warm_records = self.records(warm_output)
            self.assertEqual([item["record"] for item in warm_records], ["metadata", "seed", "seed", "summary"])
            self.assertEqual(warm_records[-1]["comparison_failure"], "warm_seed_invalid")

    def test_artifact_mutation_existing_output_capability_and_cleanup_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            baseline, candidate = self.setup_artifacts(root)
            output = root / "mutated.jsonl"
            args = self.args(root, baseline, candidate, output=output)
            with mock.patch.object(tui_benchmark, "_revalidate_artifact", return_value=False):
                self.assertEqual(tui_benchmark.run_comparison(args), 1)
            self.assertEqual(self.records(output)[-1]["comparison_failure"], "artifact_mutated")

            with self.assertRaisesRegex(tui_benchmark.CompareFailure, "compare_output_exists"):
                tui_benchmark.run_comparison(args)

            unavailable = self.preserve(root, "candidate-unavailable", b"#!/bin/sh\nexit 2\n", "unavailable")
            capability_args = self.args(
                root, baseline, unavailable, samples=1, output=root / "capability.jsonl"
            )
            with self.assertRaisesRegex(tui_benchmark.CompareFailure, "compare_candidate_capability_mismatch"):
                tui_benchmark.run_comparison(capability_args)

            cleanup_output = root / "cleanup.jsonl"
            cleanup_args = self.args(root, baseline, candidate, samples=1, output=cleanup_output)
            with mock.patch.object(tui_benchmark, "run_once", return_value=measurement()):
                with mock.patch.object(tui_benchmark.shutil, "rmtree", side_effect=OSError("fixture")):
                    self.assertEqual(tui_benchmark.run_comparison(cleanup_args), 1)
            self.assertEqual(self.records(cleanup_output)[-1]["comparison_failure"], "state_cleanup_failed")

    def test_metadata_and_results_do_not_leak_paths_or_inherited_secrets(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            baseline, candidate = self.setup_artifacts(root)
            output = root / "private.jsonl"
            args = self.args(root, baseline, candidate, samples=1, output=output)
            with mock.patch.dict(os.environ, {"PRIVATE_TOKEN": "secret-value", "OC2_RUN_ID": "private-run"}):
                with mock.patch.object(tui_benchmark, "run_once", return_value=measurement()):
                    self.assertEqual(tui_benchmark.run_comparison(args), 0)
            serialized = output.read_text(encoding="utf-8")
            self.assertNotIn(str(root), serialized)
            self.assertNotIn("secret-value", serialized)
            self.assertNotIn("private-run", serialized)
            metadata = self.records(output)[0]
            self.assertEqual(
                set(metadata["controlled_environment"]),
                set(tui_benchmark.CONTROLLED_ENV)
                | {"HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "TMPDIR", "TMP", "TEMP"},
            )

            private_output = root / "rejected-private.jsonl"
            private_args = self.args(root, baseline, candidate, samples=1, output=private_output)
            private_args.command = ["--", "--config=/outside/private.json", "TOKEN=secret-value"]
            with self.assertRaisesRegex(tui_benchmark.CompareFailure, "compare_command_private_path"):
                tui_benchmark.run_comparison(private_args)
            self.assertFalse(private_output.exists())

            baseline_artifact = tui_benchmark.load_artifact(baseline)
            candidate_artifact = tui_benchmark.load_artifact(candidate)
            sanitized = tui_benchmark._sanitize_command(
                [
                    "--endpoint",
                    "https://private-user:private-password@example.invalid/path?token=value",
                    "--",
                    "https://private-user:private-password@example.invalid/again",
                    "--private-token-value",
                    "sk-live-private",
                ],
                root,
                (baseline_artifact, candidate_artifact),
            )
            serialized_command = json.dumps(sanitized)
            for secret in ("private-user", "private-password", "private-token-value", "sk-live-private"):
                self.assertNotIn(secret, serialized_command)

            attached_credential = "-ughp_AbCd123:xyZ987"
            sanitized = tui_benchmark._sanitize_command(
                ["--pure", attached_credential],
                root,
                (baseline_artifact, candidate_artifact),
            )
            self.assertEqual(
                sanitized["argv"],
                ["$ARTIFACT_BINARY", "--pure", "$REDACTED_OPTION"],
            )
            self.assertNotIn(attached_credential, json.dumps(sanitized))

    def test_output_entry_replacement_is_detected_and_never_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            baseline, candidate = self.setup_artifacts(root)
            output = root / "identity.jsonl"
            displaced = root / "displaced.jsonl"
            args = self.args(root, baseline, candidate, samples=1, mode="cold-like", output=output)
            replaced = False

            def replace_output(*unused):
                nonlocal replaced
                if not replaced:
                    output.rename(displaced)
                    output.write_text("replacement\n", encoding="ascii")
                    replaced = True
                return measurement()

            with mock.patch.object(tui_benchmark, "run_once", side_effect=replace_output):
                self.assertEqual(tui_benchmark.run_comparison(args), 1)
            self.assertEqual(output.read_text(encoding="ascii"), "replacement\n")
            self.assertTrue(displaced.read_text(encoding="utf-8").startswith('{"artifacts"'))
            self.assertNotIn(b'"record":"summary"', displaced.read_bytes())

            append_output = root / "append.jsonl"
            append_args = self.args(
                root,
                baseline,
                candidate,
                samples=1,
                mode="cold-like",
                output=append_output,
            )

            marker = b"FOREIGN_UNIQUE_BYTES"

            def append_output_bytes(*unused):
                with append_output.open("ab") as handle:
                    handle.write(marker)
                    handle.flush()
                    os.fsync(handle.fileno())
                return measurement()

            with mock.patch.object(tui_benchmark, "run_once", side_effect=append_output_bytes):
                self.assertEqual(tui_benchmark.run_comparison(append_args), 1)
            self.assertTrue(append_output.read_bytes().endswith(marker))

    def test_artifacts_are_revalidated_after_final_summary_sync(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            baseline, candidate = self.setup_artifacts(root)
            expected = tui_benchmark.load_artifact(candidate)
            output = root / "final-sync.jsonl"
            args = self.args(root, baseline, candidate, samples=1, mode="cold-like", output=output)
            original_fsync = tui_benchmark._flush_fsync
            calls = 0

            def mutate_after_sync(stream):
                nonlocal calls
                calls += 1
                original_fsync(stream)
                if calls == 2:
                    (candidate / "bin" / "oc2").write_bytes(b"mutated-during-final-sync")

            with mock.patch.object(tui_benchmark, "run_once", return_value=measurement()):
                with mock.patch.object(tui_benchmark, "_flush_fsync", side_effect=mutate_after_sync):
                    self.assertEqual(tui_benchmark.run_comparison(args), 1)
            self.assertFalse(tui_benchmark._revalidate_artifact(expected))


class TraceEvidenceTest(unittest.TestCase):
    def test_phases_and_rpc_are_ordered_joined_and_content_free(self):
        evidence = tui_benchmark.TraceEvidence()
        evidence.observe(
            {"event": "phase", "sequence": 1, "phase": "renderer.create", "role": "main", "outcome": "ok", "durationMs": 1.5},
            10.0,
        )
        evidence.observe(
            {"event": "rpc.request", "sequence": 2, "requestID": 7, "request": "config.get", "encodedBytes": 20},
            11.0,
        )
        evidence.observe(
            {"event": "rpc.dispatch", "sequence": 3, "requestID": 7, "request": "config.get", "durationMs": 2.5},
            12.0,
        )
        evidence.observe(
            {"event": "rpc.response", "sequence": 4, "requestID": 7, "request": "config.get", "encodedBytes": 30, "removableDuplicateBytes": 0},
            13.0,
        )
        self.assertEqual(evidence.phases[0]["receipt_ms"], 10.0)
        joined = evidence.rpc_records()[0]
        self.assertEqual(joined["request_sequence"], 2)
        self.assertEqual(joined["dispatch_duration_ms"], 2.5)
        self.assertEqual(joined["response_encoded_bytes"], 30)
        self.assertEqual(joined["removable_duplicate_bytes"], 0)
        self.assertNotIn("payload", json.dumps({"phases": evidence.phases, "rpc": evidence.rpc_records()}))

    def test_rpc_duplicates_and_name_conflicts_fail_closed(self):
        evidence = tui_benchmark.TraceEvidence()
        request = {"event": "rpc.request", "sequence": 1, "requestID": 1, "request": "config.get", "encodedBytes": 10}
        evidence.observe(request, 1.0)
        with self.assertRaisesRegex(tui_benchmark.TraceFailure, "trace_rpc_duplicate_request"):
            evidence.observe(dict(request, sequence=2), 2.0)
        conflict = tui_benchmark.TraceEvidence()
        conflict.observe(request, 1.0)
        with self.assertRaisesRegex(tui_benchmark.TraceFailure, "trace_rpc_name_mismatch"):
            conflict.observe(
                {"event": "rpc.response", "sequence": 2, "requestID": 1, "request": "project.path", "encodedBytes": 1, "removableDuplicateBytes": 0},
                2.0,
            )

    def test_measurement_schema_rejects_empty_success_and_reversed_receipts(self):
        empty = tui_benchmark._empty_result(None, True, "run_test")
        self.assertFalse(tui_benchmark._valid_measurement(empty))

        reversed_receipts = measurement()
        reversed_receipts["rpc"] = [
            {
                "request_id": 1,
                "name": "config.get",
                "request_sequence": 8,
                "request_receipt_ms": 30.0,
                "request_encoded_bytes": 10,
                "dispatch_sequence": 9,
                "dispatch_receipt_ms": 20.0,
                "dispatch_duration_ms": 1.0,
                "response_sequence": 10,
                "response_receipt_ms": 10.0,
                "response_encoded_bytes": 20,
                "removable_duplicate_bytes": 0,
            }
        ]
        self.assertFalse(tui_benchmark._valid_measurement(reversed_receipts, True))


if __name__ == "__main__":
    unittest.main()
