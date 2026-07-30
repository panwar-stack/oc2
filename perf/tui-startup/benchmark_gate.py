#!/usr/bin/env python3
"""Apply fail-closed policies to Slice 2D TUI comparisons."""

import argparse
import hashlib
import json
import math
import re
import statistics
import sys
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType
from typing import Mapping, Optional, Sequence

import tui_benchmark


GATE_SCHEMA = "oc2-tui-startup-gate"
GATE_VERSION = 1
SCHEDULE_SEED = 20260728
MAX_COMPARISON_BYTES = 64 * 1024 * 1024
MAX_RECORD_BYTES = 2 * 1024 * 1024
MAX_COMPARISON_RECORDS = 128
PROBE_BACKSPACE_COUNT = len(tui_benchmark.PROBE_PREFIX) + 32 + len(tui_benchmark.PROBE_GUARD)
PHASE_DELTA_POLICY = "single-deferral-v1"
PHASE_DELTA_PHASES = frozenset(("tui.import", "plugin.load", "bootstrap.optional"))


class GateFailure(ValueError):
    """A content-free aggregate gate validation failure."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class CohortSpec:
    key: str
    label: str
    samples_per_arm: int
    mode: str
    theme_response: str
    metric_set: str
    interaction_probe: bool


@dataclass(frozen=True)
class Comparison:
    sha256: str
    metadata: Mapping[str, object]
    samples: Mapping[str, tuple[Mapping[str, object], ...]]
    run_ids: tuple[str, ...]


@dataclass(frozen=True)
class FullGate:
    sha256: str
    report: Mapping[str, object]


def _spec(
    key: str,
    label: str,
    samples: int,
    mode: str,
    theme: str,
    metric_set: str,
    probe: bool,
) -> CohortSpec:
    return CohortSpec(key, label, samples, mode, theme, metric_set, probe)


POLICY_COHORTS = MappingProxyType(
    {
        "pre-shell-v1": (
            _spec("dark", "pre-shell-dark", 20, "warm", "dark", "pre-shell", True),
            _spec("light", "pre-shell-light", 20, "warm", "light", "pre-shell", True),
            _spec("none", "pre-shell-none", 20, "warm", "none", "pre-shell", True),
            _spec("malformed", "pre-shell-malformed", 3, "cold-like", "malformed", "pre-shell", True),
            _spec("late", "pre-shell-late", 3, "cold-like", "late:1250", "pre-shell", True),
        ),
        "shell-v1": (
            _spec("dark", "shell-dark", 20, "warm", "dark", "shell", False),
            _spec("light", "shell-light", 20, "warm", "light", "shell", False),
            _spec("none", "shell-none", 20, "warm", "none", "shell", False),
        ),
        "full-v1": (
            _spec("dark", "compiled-dark-warm", 20, "warm", "dark", "full", True),
            _spec("light", "compiled-light-warm", 20, "warm", "light", "full", True),
            _spec("none", "compiled-no-theme-warm", 20, "warm", "none", "full", True),
            _spec("cold", "compiled-dark-cold-like", 15, "cold-like", "dark", "full", True),
            _spec("malformed", "compiled-malformed-correctness", 3, "cold-like", "malformed", "full", True),
            _spec("late", "compiled-late-valid-correctness", 3, "cold-like", "late:1250", "full", True),
        ),
    }
)


_ARTIFACT_KEYS = {
    "artifact_id",
    "binary_sha256",
    "revision",
    "tree",
    "pr_base_revision",
    "clean",
    "shell_capability",
}
_WRAPPER_KEYS = {
    "schema",
    "version",
    "record",
    "comparison_id",
    "label",
    "schedule_index",
    "pair",
    "arm",
    "arm_sample",
    "artifact_id",
    "state_id",
    "state_policy",
    "measurement",
}


def _exact_dict(value: object, keys: set[str]) -> bool:
    return isinstance(value, dict) and set(value) == keys and all(isinstance(key, str) for key in value)


def _unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise GateFailure("comparison_duplicate_key")
        result[key] = value
    return result


def _canonical_json_bytes(value: object, final_newline: bool = True) -> bytes:
    return tui_benchmark._canonical_json_bytes(value, final_newline=final_newline)


def _valid_sha256(value: object) -> bool:
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) is not None


def _valid_artifact(value: object) -> bool:
    if not _exact_dict(value, _ARTIFACT_KEYS):
        return False
    assert isinstance(value, dict)
    return (
        _valid_sha256(value["artifact_id"])
        and _valid_sha256(value["binary_sha256"])
        and tui_benchmark._valid_object_id(value["revision"])
        and tui_benchmark._valid_object_id(value["tree"])
        and tui_benchmark._valid_object_id(value["pr_base_revision"])
        and value["clean"] is True
        and value["shell_capability"] in ("unavailable", "required")
    )


def _expected_environment() -> dict[str, str]:
    return {
        **tui_benchmark.CONTROLLED_ENV,
        "HOME": "$STATE/home",
        "XDG_DATA_HOME": "$STATE/data",
        "XDG_CACHE_HOME": "$STATE/cache",
        "XDG_CONFIG_HOME": "$STATE/config",
        "TMPDIR": "$STATE/tmp",
        "TMP": "$STATE/tmp",
        "TEMP": "$STATE/tmp",
    }


def _metadata_without_id(metadata: Mapping[str, object]) -> dict[str, object]:
    return {key: value for key, value in metadata.items() if key != "comparison_id"}


def _validate_metadata(value: object, spec: CohortSpec) -> dict[str, object]:
    keys = {
        "schema",
        "version",
        "record",
        "label",
        "scenario",
        "command",
        "controlled_environment",
        "state_policy",
        "artifacts",
        "run_host",
        "tooling",
        "trace_allowlist",
        "schedule",
        "comparison_id",
    }
    if not _exact_dict(value, keys):
        raise GateFailure("comparison_metadata_schema")
    assert isinstance(value, dict)
    if (
        value["schema"] != tui_benchmark.COMPARE_SCHEMA
        or type(value["version"]) is not int
        or value["version"] != tui_benchmark.COMPARE_VERSION
        or value["record"] != "metadata"
        or value["label"] != spec.label
    ):
        raise GateFailure("comparison_metadata_schema")

    scenario = value["scenario"]
    if not _exact_dict(
        scenario,
        {"mode", "theme_response", "metric_set", "interaction_probe", "timeout_ms", "pty"},
    ):
        raise GateFailure("comparison_scenario_mismatch")
    assert isinstance(scenario, dict)
    if (
        scenario["mode"] != spec.mode
        or scenario["theme_response"] != spec.theme_response
        or scenario["metric_set"] != spec.metric_set
        or scenario["interaction_probe"] is not spec.interaction_probe
        or type(scenario["timeout_ms"]) is not int
        or scenario["timeout_ms"] != 12000
        or scenario["pty"] != {"width": tui_benchmark.PTY_WIDTH, "height": tui_benchmark.PTY_HEIGHT}
    ):
        raise GateFailure("comparison_scenario_mismatch")

    expected_command = {"argv": ["$ARTIFACT_BINARY", "--pure", "$REPO"], "cwd": "$REPO"}
    if value["command"] != expected_command or value["controlled_environment"] != _expected_environment():
        raise GateFailure("comparison_execution_provenance")

    expected_policy = {
        "version": 1,
        "name": (
            "isolated-warm-per-arm-v1"
            if spec.mode == "warm"
            else "isolated-cold-like-per-sample-v1"
        ),
        "warm_seeds_per_arm": 1 if spec.mode == "warm" else 0,
        "writable_state_shared_between_arms": False,
    }
    if value["state_policy"] != expected_policy:
        raise GateFailure("comparison_state_policy_mismatch")

    artifacts = value["artifacts"]
    if not _exact_dict(artifacts, {"baseline", "candidate"}):
        raise GateFailure("comparison_artifact_schema")
    assert isinstance(artifacts, dict)
    if not _valid_artifact(artifacts["baseline"]) or not _valid_artifact(artifacts["candidate"]):
        raise GateFailure("comparison_artifact_schema")
    baseline = artifacts["baseline"]
    candidate = artifacts["candidate"]
    assert isinstance(baseline, dict) and isinstance(candidate, dict)
    if baseline["artifact_id"] == candidate["artifact_id"]:
        raise GateFailure("comparison_artifacts_not_distinct")

    if not tui_benchmark._valid_host_record(value["run_host"], False):
        raise GateFailure("comparison_host_schema")
    tooling = value["tooling"]
    if not _exact_dict(
        tooling,
        {"tui_benchmark_sha256", "tui_probe_sha256", "terminal_screen_sha256"},
    ) or not all(_valid_sha256(item) for item in tooling.values()):  # type: ignore[union-attr]
        raise GateFailure("comparison_tooling_schema")
    try:
        current_tooling = tui_benchmark._tooling_hashes()
    except tui_benchmark.ArtifactFailure:
        raise GateFailure("comparison_tooling_unavailable") from None
    if tooling != current_tooling:
        raise GateFailure("comparison_tooling_mismatch")

    expected_allowlist = {
        "version": tui_benchmark.TRACE_EVIDENCE_VERSION,
        "phases": sorted(tui_benchmark.TRACE_PHASES),
        "rpc_requests": sorted(tui_benchmark.TRACE_REQUESTS),
    }
    if value["trace_allowlist"] != expected_allowlist:
        raise GateFailure("comparison_trace_allowlist_mismatch")

    expected_entries = tui_benchmark.build_balanced_schedule(
        spec.samples_per_arm,
        spec.mode,
        SCHEDULE_SEED,
    )
    schedule = value["schedule"]
    expected_schedule = {
        "version": tui_benchmark.SCHEDULE_VERSION,
        "seed": SCHEDULE_SEED,
        "sha256": tui_benchmark._schedule_hash(expected_entries),
        "entries": expected_entries,
    }
    if schedule != expected_schedule:
        raise GateFailure("comparison_schedule_mismatch")

    comparison_id = value["comparison_id"]
    expected_id = hashlib.sha256(
        _canonical_json_bytes(_metadata_without_id(value), final_newline=False)
    ).hexdigest()
    if comparison_id != expected_id:
        raise GateFailure("comparison_id_mismatch")
    return value


def _expected_state_id(spec: CohortSpec, entry: Mapping[str, object]) -> str:
    arm = entry["arm"]
    if spec.mode == "warm":
        return f"warm/{arm}"
    return f"cold-like/{arm}/{entry['arm_sample']:04d}"


def _validate_probe(measurement: Mapping[str, object], theme: str) -> None:
    required_true = (
        "probe_body_visible",
        "probe_noecho_verified",
        "probe_guard_sent",
        "probe_persistence_verified",
        "probe_removal_verified",
        "theme_activity_verified",
    )
    if (
        any(measurement[key] is not True for key in required_true)
        or measurement["probe_backspace_count"] != PROBE_BACKSPACE_COUNT
        or measurement["interactive_ms"] is None
        or measurement["input_accepted_ms"] is None
    ):
        raise GateFailure("comparison_probe_lifecycle_invalid")
    interactive = measurement["interactive_ms"]
    assert isinstance(interactive, (int, float))
    prerequisites = (
        measurement["prompt_ms"],
        measurement["critical_ready_ms"],
        measurement["theme_settled_ms"],
        measurement["input_accepted_ms"],
    )
    if any(value is None or interactive < value for value in prerequisites):
        raise GateFailure("comparison_probe_lifecycle_invalid")
    if measurement["input_accepted_ms"] < measurement["prompt_ms"]:
        raise GateFailure("comparison_probe_lifecycle_invalid")

    foreground_queries = measurement["foreground_query_count"]
    background_queries = measurement["background_query_count"]
    foreground_responses = measurement["foreground_response_count"]
    background_responses = measurement["background_response_count"]
    if foreground_queries < 1 or background_queries < 1:
        raise GateFailure("comparison_theme_activity_invalid")
    if theme == "none":
        if foreground_responses != 0 or background_responses != 0:
            raise GateFailure("comparison_theme_activity_invalid")
    elif theme == "malformed":
        if foreground_responses + background_responses != 1:
            raise GateFailure("comparison_theme_activity_invalid")
    elif (
        foreground_responses != foreground_queries
        or background_responses != background_queries
    ):
        raise GateFailure("comparison_theme_activity_invalid")

    outcome = measurement["theme_settled_outcome"]
    reconciliations = measurement["theme_reconciliation_count"]
    verified = measurement["probe_verified_reconciliation_count"]
    if theme in ("dark", "light"):
        valid_theme = outcome == "resolved" and reconciliations == 0 and verified == 0
    elif theme in ("none", "malformed"):
        valid_theme = outcome == "fallback-final" and reconciliations == 0 and verified == 0
    else:
        valid_theme = outcome == "fallback-final" and reconciliations == 1 and verified == 1
    if not valid_theme:
        raise GateFailure("comparison_theme_lifecycle_invalid")


def _validate_no_probe(measurement: Mapping[str, object]) -> None:
    if (
        measurement["interactive_ms"] is not None
        or measurement["input_accepted_ms"] is not None
        or any(
            measurement[key] is not False
            for key in (
                "probe_body_visible",
                "probe_noecho_verified",
                "probe_guard_sent",
                "probe_persistence_verified",
                "probe_removal_verified",
                "theme_activity_verified",
            )
        )
        or measurement["probe_backspace_count"] != 0
        or measurement["theme_reconciliation_count"] != 0
        or measurement["probe_verified_reconciliation_count"] != 0
    ):
        raise GateFailure("comparison_unexpected_probe_evidence")


def _validate_measurement(measurement: object, spec: CohortSpec, shell_capability: str) -> dict[str, object]:
    if not tui_benchmark._valid_measurement(measurement, spec.interaction_probe):
        raise GateFailure("comparison_measurement_schema")
    assert isinstance(measurement, dict)
    if measurement["failure"] is not None:
        raise GateFailure("comparison_invalid_sample")
    if (
        measurement["timed_out"] is not False
        or measurement["pty_handshake_ok"] is not True
        or measurement["first_frame_ms"] is None
        or measurement["prompt_ms"] is None
        or measurement["first_frame_ms"] > measurement["prompt_ms"]
    ):
        raise GateFailure("comparison_milestone_lifecycle_invalid")
    shell = measurement["shell_ms"]
    if shell_capability == "unavailable":
        if shell is not None:
            raise GateFailure("comparison_shell_capability_mismatch")
    elif shell is None or shell < measurement["first_frame_ms"]:
        raise GateFailure("comparison_shell_capability_mismatch")
    if spec.interaction_probe:
        _validate_probe(measurement, spec.theme_response)
    else:
        _validate_no_probe(measurement)
    return measurement


def _expected_summary(
    metadata: Mapping[str, object],
    spec: CohortSpec,
    records: Sequence[tuple[Mapping[str, object], Mapping[str, object]]],
) -> dict[str, object]:
    arms: dict[str, object] = {}
    for arm in ("baseline", "candidate"):
        seeds = [measurement for entry, measurement in records if entry["arm"] == arm and entry["kind"] == "seed"]
        samples = [measurement for entry, measurement in records if entry["arm"] == arm and entry["kind"] == "sample"]
        arms[arm] = {
            "seed_records": len(seeds),
            "valid_seeds": len(seeds),
            "samples": len(samples),
            "valid": len(samples),
            "metrics": tui_benchmark._descriptive_statistics(samples),
        }
    schedule = metadata["schedule"]
    assert isinstance(schedule, dict)
    entries = schedule["entries"]
    assert isinstance(entries, list)
    seeds = 2 if spec.mode == "warm" else 0
    return {
        "schema": tui_benchmark.COMPARE_SCHEMA,
        "version": tui_benchmark.COMPARE_VERSION,
        "record": "summary",
        "comparison_id": metadata["comparison_id"],
        "label": spec.label,
        "samples_per_arm": spec.samples_per_arm,
        "expected_seed_records": seeds,
        "observed_seed_records": seeds,
        "expected_schedule_records": len(entries),
        "observed_schedule_records": len(entries),
        "arms": arms,
        "comparison_failure": None,
    }


def load_comparison(path: Path, spec: CohortSpec) -> Comparison:
    path = Path(path)
    try:
        before = tui_benchmark._lstat_regular(path)
        if before.size > MAX_COMPARISON_BYTES:
            raise GateFailure("comparison_file_too_large")
        content, identity = tui_benchmark._read_stable_file(path)
    except GateFailure:
        raise
    except tui_benchmark.ArtifactFailure:
        raise GateFailure("comparison_file_unavailable") from None
    if before != identity:
        raise GateFailure("comparison_identity_changed")
    if not content or not content.endswith(b"\n") or b"\r" in content:
        raise GateFailure("comparison_not_canonical")
    lines = content.splitlines(keepends=True)
    if len(lines) > MAX_COMPARISON_RECORDS:
        raise GateFailure("comparison_record_limit")
    records: list[dict[str, object]] = []
    for line in lines:
        if len(line) > MAX_RECORD_BYTES or line == b"\n":
            raise GateFailure("comparison_record_limit")
        try:
            record = json.loads(
                line.decode("utf-8", errors="strict"),
                object_pairs_hook=_unique_object,
                parse_constant=lambda _: (_ for _ in ()).throw(GateFailure("comparison_invalid_json")),
            )
        except GateFailure:
            raise
        except (UnicodeDecodeError, json.JSONDecodeError, TypeError, ValueError, OverflowError):
            raise GateFailure("comparison_invalid_json") from None
        if not isinstance(record, dict) or line != _canonical_json_bytes(record):
            raise GateFailure("comparison_not_canonical")
        records.append(record)

    expected_entries = tui_benchmark.build_balanced_schedule(spec.samples_per_arm, spec.mode, SCHEDULE_SEED)
    if len(records) != len(expected_entries) + 2:
        raise GateFailure("comparison_record_count_mismatch")
    metadata = _validate_metadata(records[0], spec)
    artifacts = metadata["artifacts"]
    state_policy = metadata["state_policy"]
    assert isinstance(artifacts, dict) and isinstance(state_policy, dict)
    observed: list[tuple[Mapping[str, object], Mapping[str, object]]] = []
    sample_arms: dict[str, list[Mapping[str, object]]] = {"baseline": [], "candidate": []}
    run_ids: set[str] = set()

    for entry, wrapper in zip(expected_entries, records[1:-1]):
        if not _exact_dict(wrapper, _WRAPPER_KEYS):
            raise GateFailure("comparison_wrapper_schema")
        assert isinstance(wrapper, dict)
        arm = entry["arm"]
        artifact = artifacts[arm]
        assert isinstance(artifact, dict)
        expected_wrapper = {
            "schema": tui_benchmark.COMPARE_SCHEMA,
            "version": tui_benchmark.COMPARE_VERSION,
            "record": entry["kind"],
            "comparison_id": metadata["comparison_id"],
            "label": spec.label,
            "schedule_index": entry["schedule_index"],
            "pair": entry["pair"],
            "arm": arm,
            "arm_sample": entry["arm_sample"],
            "artifact_id": artifact["artifact_id"],
            "state_id": _expected_state_id(spec, entry),
            "state_policy": state_policy["name"],
        }
        if any(wrapper[key] != expected for key, expected in expected_wrapper.items()):
            raise GateFailure("comparison_wrapper_mismatch")
        measurement = _validate_measurement(
            wrapper["measurement"],
            spec,
            str(artifact["shell_capability"]),
        )
        run_id = measurement["run_id"]
        assert isinstance(run_id, str)
        if run_id in run_ids:
            raise GateFailure("comparison_run_id_reused")
        run_ids.add(run_id)
        observed.append((entry, measurement))
        if entry["kind"] == "sample":
            sample_arms[str(arm)].append(measurement)

    if records[-1] != _expected_summary(metadata, spec, observed):
        raise GateFailure("comparison_summary_mismatch")
    if any(len(values) != spec.samples_per_arm for values in sample_arms.values()):
        raise GateFailure("comparison_sample_count_mismatch")
    return Comparison(
        hashlib.sha256(content).hexdigest(),
        MappingProxyType(metadata),
        MappingProxyType({arm: tuple(values) for arm, values in sample_arms.items()}),
        tuple(run_ids),
    )


def _valid_report_statistic(value: object) -> bool:
    if value is None:
        return True
    if not _exact_dict(value, {"median", "p95"}):
        return False
    assert isinstance(value, dict)
    median_value = value["median"]
    p95_value = value["p95"]
    return (
        isinstance(median_value, (int, float))
        and not isinstance(median_value, bool)
        and math.isfinite(median_value)
        and median_value >= 0
        and isinstance(p95_value, (int, float))
        and not isinstance(p95_value, bool)
        and math.isfinite(p95_value)
        and p95_value >= median_value
    )


def _valid_cohort_report(value: object, spec: CohortSpec) -> bool:
    if not _exact_dict(
        value,
        {"label", "mode", "theme_response", "metric_set", "samples_per_arm", "arms"},
    ):
        return False
    assert isinstance(value, dict)
    if any(
        value[key] != expected
        for key, expected in (
            ("label", spec.label),
            ("mode", spec.mode),
            ("theme_response", spec.theme_response),
            ("metric_set", spec.metric_set),
            ("samples_per_arm", spec.samples_per_arm),
        )
    ):
        return False
    arms = value["arms"]
    if not _exact_dict(arms, {"baseline", "candidate"}):
        return False
    assert isinstance(arms, dict)
    metrics = {"first_frame_ms", "shell_ms", "prompt_ms", "interactive_ms"}
    for arm in ("baseline", "candidate"):
        if not _exact_dict(arms[arm], metrics):
            return False
        if not all(_valid_report_statistic(item) for item in arms[arm].values()):
            return False
        for metric in ("first_frame_ms", "prompt_ms", "interactive_ms"):
            if arms[arm][metric] is None:
                return False
    if arms["baseline"]["shell_ms"] is not None or arms["candidate"]["shell_ms"] is None:
        return False
    return True


def load_full_gate(path: Path) -> FullGate:
    path = Path(path)
    try:
        before = tui_benchmark._lstat_regular(path)
        if before.size > MAX_RECORD_BYTES:
            raise GateFailure("phase_full_gate_file_too_large")
        content, identity = tui_benchmark._read_stable_file(path)
    except GateFailure:
        raise
    except tui_benchmark.ArtifactFailure:
        raise GateFailure("phase_full_gate_unavailable") from None
    if before != identity:
        raise GateFailure("phase_full_gate_identity_changed")
    if not content or not content.endswith(b"\n") or b"\r" in content:
        raise GateFailure("phase_full_gate_not_canonical")
    try:
        report = json.loads(
            content.decode("utf-8", errors="strict"),
            object_pairs_hook=_unique_object,
            parse_constant=lambda _: (_ for _ in ()).throw(
                GateFailure("phase_full_gate_invalid_json")
            ),
        )
    except GateFailure:
        raise
    except (UnicodeDecodeError, json.JSONDecodeError, TypeError, ValueError, OverflowError):
        raise GateFailure("phase_full_gate_invalid_json") from None
    if not isinstance(report, dict) or content != _canonical_json_bytes(report):
        raise GateFailure("phase_full_gate_not_canonical")

    keys = {
        "schema",
        "version",
        "policy",
        "passed",
        "artifacts",
        "inputs",
        "cohorts",
        "failures",
        "tooling",
    }
    if not _exact_dict(report, keys):
        raise GateFailure("phase_full_gate_schema")
    if (
        report["schema"] != GATE_SCHEMA
        or type(report["version"]) is not int
        or report["version"] != GATE_VERSION
        or report["policy"] != "full-v1"
        or report["passed"] is not True
        or report["failures"] != []
    ):
        raise GateFailure("phase_full_gate_not_passed")

    artifacts = report["artifacts"]
    if not _exact_dict(artifacts, {"baseline", "candidate"}):
        raise GateFailure("phase_full_gate_schema")
    assert isinstance(artifacts, dict)
    if not all(_valid_artifact(artifacts[arm]) for arm in ("baseline", "candidate")):
        raise GateFailure("phase_full_gate_schema")
    _validate_capabilities("full-v1", artifacts)

    specs = POLICY_COHORTS["full-v1"]
    inputs = report["inputs"]
    cohorts = report["cohorts"]
    expected_keys = {spec.key for spec in specs}
    if not _exact_dict(inputs, expected_keys) or not _exact_dict(cohorts, expected_keys):
        raise GateFailure("phase_full_gate_schema")
    assert isinstance(inputs, dict) and isinstance(cohorts, dict)
    for spec in specs:
        input_record = inputs[spec.key]
        if (
            not _exact_dict(input_record, {"sha256", "comparison_id"})
            or not _valid_sha256(input_record["sha256"])  # type: ignore[index]
            or not _valid_sha256(input_record["comparison_id"])  # type: ignore[index]
            or not _valid_cohort_report(cohorts[spec.key], spec)
        ):
            raise GateFailure("phase_full_gate_schema")
    if _threshold_failures("full-v1", cohorts):
        raise GateFailure("phase_full_gate_not_passed")
    tooling = report["tooling"]
    if (
        not _exact_dict(tooling, {"benchmark_gate_sha256"})
        or not _valid_sha256(tooling["benchmark_gate_sha256"])  # type: ignore[index]
    ):
        raise GateFailure("phase_full_gate_schema")
    try:
        current_tooling_hash = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    except OSError:
        raise GateFailure("phase_full_gate_tooling_unavailable") from None
    if tooling["benchmark_gate_sha256"] != current_tooling_hash:  # type: ignore[index]
        raise GateFailure("phase_full_gate_tooling_drift")
    return FullGate(hashlib.sha256(content).hexdigest(), MappingProxyType(report))


def median(values: Sequence[float]) -> float:
    if not values or any(not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value) for value in values):
        raise GateFailure("gate_metric_invalid")
    return float(statistics.median(values))


def linear_p95(values: Sequence[float]) -> float:
    if not values or any(not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value) for value in values):
        raise GateFailure("gate_metric_invalid")
    return float(tui_benchmark.percentile(values, 0.95))


def _statistics(values: Sequence[Mapping[str, object]], metric: str) -> Optional[dict[str, float]]:
    selected = [item[metric] for item in values if item[metric] is not None]
    if not selected:
        return None
    return {"median": median(selected), "p95": linear_p95(selected)}  # type: ignore[arg-type]


def _cohort_report(spec: CohortSpec, comparison: Comparison) -> dict[str, object]:
    metrics = ("first_frame_ms", "shell_ms", "prompt_ms", "interactive_ms")
    return {
        "label": spec.label,
        "mode": spec.mode,
        "theme_response": spec.theme_response,
        "metric_set": spec.metric_set,
        "samples_per_arm": spec.samples_per_arm,
        "arms": {
            arm: {
                metric: _statistics(comparison.samples[arm], metric)
                for metric in metrics
            }
            for arm in ("baseline", "candidate")
        },
    }


def _metric(cohort: Mapping[str, object], arm: str, metric: str, statistic: str) -> float:
    arms = cohort["arms"]
    assert isinstance(arms, dict)
    arm_record = arms[arm]
    assert isinstance(arm_record, dict)
    metric_record = arm_record[metric]
    if not isinstance(metric_record, dict):
        raise GateFailure("gate_metric_missing")
    value = metric_record[statistic]
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
        raise GateFailure("gate_metric_invalid")
    return float(value)


def _threshold_failures(policy: str, cohorts: Mapping[str, Mapping[str, object]]) -> list[str]:
    failures: list[str] = []
    if policy in ("shell-v1", "full-v1"):
        for key in ("dark", "light", "none"):
            if _metric(cohorts[key], "candidate", "shell_ms", "median") > 1000:
                failures.append(f"{key}_candidate_shell_ms_median_absolute")
            if _metric(cohorts[key], "candidate", "shell_ms", "p95") > 1500:
                failures.append(f"{key}_candidate_shell_ms_p95_absolute")
    if policy in ("pre-shell-v1", "full-v1"):
        absolute = {
            "dark": {"prompt_ms": (1600, 2200), "interactive_ms": (1800, 2500)},
            "light": {"prompt_ms": (1600, 2200), "interactive_ms": (1800, 2500)},
            "none": {"prompt_ms": (1700, 2300), "interactive_ms": (1900, 2600)},
        }
        for key, metrics in absolute.items():
            for metric, (median_limit, p95_limit) in metrics.items():
                if _metric(cohorts[key], "candidate", metric, "median") > median_limit:
                    failures.append(f"{key}_candidate_{metric}_median_absolute")
                if _metric(cohorts[key], "candidate", metric, "p95") > p95_limit:
                    failures.append(f"{key}_candidate_{metric}_p95_absolute")
        for key in cohorts:
            for metric in ("prompt_ms", "interactive_ms"):
                baseline_p95 = _metric(cohorts[key], "baseline", metric, "p95")
                candidate_p95 = _metric(cohorts[key], "candidate", metric, "p95")
                if candidate_p95 > baseline_p95 * 1.05:
                    failures.append(f"{key}_candidate_{metric}_p95_baseline")
        for metric in ("prompt_ms", "interactive_ms"):
            if (
                _metric(cohorts["none"], "candidate", metric, "median")
                > _metric(cohorts["dark"], "candidate", metric, "median") + 100
            ):
                failures.append(f"none_candidate_{metric}_median_dark_gap")
    return sorted(failures)


def _validate_capabilities(policy: str, artifacts: Mapping[str, object]) -> None:
    baseline = artifacts["baseline"]
    candidate = artifacts["candidate"]
    assert isinstance(baseline, dict) and isinstance(candidate, dict)
    expected = (
        ("unavailable", "unavailable")
        if policy == "pre-shell-v1"
        else ("unavailable", "required")
    )
    if (baseline["shell_capability"], candidate["shell_capability"]) != expected:
        raise GateFailure("gate_capability_mismatch")


def evaluate_gate(policy: str, inputs: Mapping[str, Path]) -> dict[str, object]:
    specs = POLICY_COHORTS.get(policy)
    if specs is None:
        raise GateFailure("gate_policy_invalid")
    expected_keys = {spec.key for spec in specs}
    if set(inputs) != expected_keys:
        raise GateFailure("gate_cohort_matrix_mismatch")

    comparisons: dict[str, Comparison] = {}
    all_run_ids: set[str] = set()
    common: Optional[dict[str, object]] = None
    for spec in specs:
        comparison = load_comparison(inputs[spec.key], spec)
        metadata = comparison.metadata
        provenance = {
            "artifacts": metadata["artifacts"],
            "command": metadata["command"],
            "controlled_environment": metadata["controlled_environment"],
            "run_host": metadata["run_host"],
            "tooling": metadata["tooling"],
            "trace_allowlist": metadata["trace_allowlist"],
        }
        if common is None:
            common = provenance
        elif provenance != common:
            raise GateFailure("gate_cohort_provenance_mismatch")
        for run_id in comparison.run_ids:
            if run_id in all_run_ids:
                raise GateFailure("gate_run_id_reused")
            all_run_ids.add(run_id)
        comparisons[spec.key] = comparison

    assert common is not None
    artifacts = common["artifacts"]
    assert isinstance(artifacts, dict)
    _validate_capabilities(policy, artifacts)
    cohort_reports = {
        spec.key: _cohort_report(spec, comparisons[spec.key])
        for spec in specs
    }
    failures = _threshold_failures(policy, cohort_reports)
    try:
        gate_hash = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    except OSError:
        raise GateFailure("gate_tooling_unavailable") from None
    return {
        "schema": GATE_SCHEMA,
        "version": GATE_VERSION,
        "policy": policy,
        "passed": not failures,
        "artifacts": artifacts,
        "inputs": {
            spec.key: {
                "sha256": comparisons[spec.key].sha256,
                "comparison_id": comparisons[spec.key].metadata["comparison_id"],
            }
            for spec in specs
        },
        "cohorts": cohort_reports,
        "failures": failures,
        "tooling": {"benchmark_gate_sha256": gate_hash},
    }


def _phase_evidence(
    comparison: Comparison,
    phase: str,
) -> tuple[list[float], list[float], list[float]]:
    durations: list[float] = []
    receipts: list[float] = []
    interactive: list[float] = []
    for measurement in comparison.samples["candidate"]:
        phases = measurement["phases"]
        assert isinstance(phases, list)
        matches = [item for item in phases if item["phase"] == phase]
        if len(matches) != 1:
            raise GateFailure("phase_candidate_sample_count_invalid")
        evidence = matches[0]
        if evidence["outcome"] != "ok":
            raise GateFailure("phase_candidate_sample_outcome_invalid")
        interactive_ms = measurement["interactive_ms"]
        if not isinstance(interactive_ms, (int, float)) or isinstance(interactive_ms, bool):
            raise GateFailure("phase_candidate_sample_clock_invalid")
        durations.append(float(evidence["duration_ms"]))
        receipts.append(float(evidence["receipt_ms"]))
        interactive.append(float(interactive_ms))
    return durations, receipts, interactive


def _bind_full_gate(comparison: Comparison, full_gate: FullGate) -> None:
    report = full_gate.report
    if report["artifacts"] != comparison.metadata["artifacts"]:
        raise GateFailure("phase_full_gate_artifact_drift")
    inputs = report["inputs"]
    cohorts = report["cohorts"]
    assert isinstance(inputs, dict) and isinstance(cohorts, dict)
    dark = inputs["dark"]
    assert isinstance(dark, dict)
    if (
        dark["sha256"] != comparison.sha256
        or dark["comparison_id"] != comparison.metadata["comparison_id"]
    ):
        raise GateFailure("phase_full_gate_hash_drift")
    spec = POLICY_COHORTS["full-v1"][0]
    if cohorts["dark"] != _cohort_report(spec, comparison):
        raise GateFailure("phase_full_gate_cohort_drift")


def evaluate_phase_delta(
    phase: str,
    before_comparison: Path,
    after_comparison: Path,
    before_full_gate: Path,
    after_full_gate: Path,
) -> dict[str, object]:
    if phase not in PHASE_DELTA_PHASES:
        raise GateFailure("phase_name_invalid")
    spec = POLICY_COHORTS["full-v1"][0]
    before = load_comparison(before_comparison, spec)
    after = load_comparison(after_comparison, spec)
    before_gate = load_full_gate(before_full_gate)
    after_gate = load_full_gate(after_full_gate)
    _bind_full_gate(before, before_gate)
    _bind_full_gate(after, after_gate)
    if before_gate.report["tooling"] != after_gate.report["tooling"]:
        raise GateFailure("phase_full_gate_tooling_drift")
    provenance_keys = (
        "scenario",
        "command",
        "controlled_environment",
        "state_policy",
        "run_host",
        "tooling",
        "trace_allowlist",
        "schedule",
    )
    if any(
        before.metadata[key] != after.metadata[key]
        for key in provenance_keys
    ):
        raise GateFailure("phase_comparison_provenance_drift")

    before_artifacts = before.metadata["artifacts"]
    after_artifacts = after.metadata["artifacts"]
    assert isinstance(before_artifacts, dict) and isinstance(after_artifacts, dict)
    before_baseline = before_artifacts["baseline"]
    after_baseline = after_artifacts["baseline"]
    before_candidate = before_artifacts["candidate"]
    after_candidate = after_artifacts["candidate"]
    assert all(
        isinstance(item, dict)
        for item in (before_baseline, after_baseline, before_candidate, after_candidate)
    )
    if before_baseline != after_baseline:
        raise GateFailure("phase_baseline_drift")
    if (
        before_baseline["shell_capability"] != "unavailable"
        or before_candidate["shell_capability"] != "required"
        or after_candidate["shell_capability"] != "required"
    ):
        raise GateFailure("phase_capability_mismatch")
    if before_candidate["artifact_id"] == after_candidate["artifact_id"]:
        raise GateFailure("phase_candidate_not_distinct")
    if before_candidate["revision"] != after_candidate["pr_base_revision"]:
        raise GateFailure("phase_candidate_not_predecessor")
    if before.sha256 == after.sha256:
        raise GateFailure("phase_comparison_hash_reused")
    if before_gate.sha256 == after_gate.sha256:
        raise GateFailure("phase_full_gate_hash_reused")
    if set(before.run_ids) & set(after.run_ids):
        raise GateFailure("phase_run_id_reused")

    before_durations, before_receipts, before_interactive = _phase_evidence(before, phase)
    after_durations, after_receipts, after_interactive = _phase_evidence(after, phase)
    before_median = median(before_durations)
    after_median = median(after_durations)
    duration_decreased = after_median < before_median
    deferred = all(
        receipt <= interactive
        for receipt, interactive in zip(before_receipts, before_interactive)
    ) and all(
        receipt > interactive
        for receipt, interactive in zip(after_receipts, after_interactive)
    )
    passed = duration_decreased or deferred
    try:
        gate_hash = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    except OSError:
        raise GateFailure("gate_tooling_unavailable") from None
    return {
        "schema": GATE_SCHEMA,
        "version": GATE_VERSION,
        "policy": PHASE_DELTA_POLICY,
        "phase": phase,
        "passed": passed,
        "artifacts": {
            "baseline": before_baseline,
            "before_candidate": before_candidate,
            "after_candidate": after_candidate,
        },
        "inputs": {
            "before": {
                "sha256": before.sha256,
                "comparison_id": before.metadata["comparison_id"],
                "full_gate_sha256": before_gate.sha256,
            },
            "after": {
                "sha256": after.sha256,
                "comparison_id": after.metadata["comparison_id"],
                "full_gate_sha256": after_gate.sha256,
            },
        },
        "evidence": {
            "samples_per_arm": spec.samples_per_arm,
            "before": {
                "duration_ms_median": before_median,
                "receipts_at_or_before_interactive": sum(
                    receipt <= interactive
                    for receipt, interactive in zip(before_receipts, before_interactive)
                ),
                "receipts_after_interactive": sum(
                    receipt > interactive
                    for receipt, interactive in zip(before_receipts, before_interactive)
                ),
            },
            "after": {
                "duration_ms_median": after_median,
                "receipts_at_or_before_interactive": sum(
                    receipt <= interactive
                    for receipt, interactive in zip(after_receipts, after_interactive)
                ),
                "receipts_after_interactive": sum(
                    receipt > interactive
                    for receipt, interactive in zip(after_receipts, after_interactive)
                ),
            },
        },
        "decisions": {
            "strict_median_duration_decrease": duration_decreased,
            "all_receipts_deferred_after_interactive": deferred,
        },
        "failures": [] if passed else ["phase_not_improved_or_deferred"],
        "tooling": {"benchmark_gate_sha256": gate_hash},
    }


def run_phase_delta(
    phase: str,
    before_comparison: Path,
    after_comparison: Path,
    before_full_gate: Path,
    after_full_gate: Path,
    output: Path,
) -> int:
    report = evaluate_phase_delta(
        phase,
        before_comparison,
        after_comparison,
        before_full_gate,
        after_full_gate,
    )
    write_report(output, report)
    return 0 if report["passed"] is True else 1


def write_report(output: Path, report: Mapping[str, object]) -> None:
    output = Path(output)
    try:
        parent = output.parent
        value = parent.lstat()
        if not value or not parent.is_dir() or parent.is_symlink():
            raise OSError("invalid parent")
        content = _canonical_json_bytes(dict(report))
        tui_benchmark._write_exclusive(output, content)
        persisted, _ = tui_benchmark._read_stable_file(output)
        if persisted != content:
            raise GateFailure("gate_output_identity_changed")
        tui_benchmark._fsync_directory(parent)
    except GateFailure:
        raise
    except FileExistsError:
        raise GateFailure("gate_output_exists") from None
    except (OSError, tui_benchmark.ArtifactFailure):
        raise GateFailure("gate_output_failed") from None


def run_gate(policy: str, inputs: Mapping[str, Path], output: Path) -> int:
    report = evaluate_gate(policy, inputs)
    write_report(output, report)
    return 0 if report["passed"] is True else 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--policy",
        choices=(*POLICY_COHORTS, PHASE_DELTA_POLICY),
        required=True,
    )
    for key in ("dark", "light", "none", "cold", "malformed", "late"):
        parser.add_argument(f"--{key}", type=Path)
    parser.add_argument("--phase")
    parser.add_argument("--before-comparison", type=Path)
    parser.add_argument("--after-comparison", type=Path)
    parser.add_argument("--before-full-gate", type=Path)
    parser.add_argument("--after-full-gate", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    inputs = {
        key: value
        for key in ("dark", "light", "none", "cold", "malformed", "late")
        if (value := getattr(args, key)) is not None
    }
    try:
        phase_values = (
            args.phase,
            args.before_comparison,
            args.after_comparison,
            args.before_full_gate,
            args.after_full_gate,
        )
        if args.policy == PHASE_DELTA_POLICY:
            if inputs or any(value is None for value in phase_values):
                raise GateFailure("phase_arguments_invalid")
            return run_phase_delta(
                args.phase,
                args.before_comparison,
                args.after_comparison,
                args.before_full_gate,
                args.after_full_gate,
                args.output,
            )
        if any(value is not None for value in phase_values):
            raise GateFailure("gate_arguments_invalid")
        return run_gate(args.policy, inputs, args.output)
    except GateFailure as error:
        print(f"gate failed: {error.code}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
