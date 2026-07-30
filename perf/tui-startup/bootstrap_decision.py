#!/usr/bin/env python3
"""Make, preserve, and verify fail-closed TUI core bootstrap decisions."""

import hashlib
import json
import math
import os
from pathlib import Path
from typing import Mapping, Sequence

import benchmark_gate
import tui_benchmark


DECISION_SCHEMA = "oc2-tui-bootstrap-decision"
DECISION_VERSION = 1
DECISION_POLICY = "core-bootstrap-v1"
ADOPTION_SCHEMA = "oc2-tui-bootstrap-adoption-gate"
ADOPTION_VERSION = 1
ADOPTION_POLICY = "core-bootstrap-adoption-v1"
PRIVACY_VERSION = 1
REMOVABLE_DISPATCH_THRESHOLD_MS = 50.0
REMOVABLE_DUPLICATE_TWICE_MEDIAN_THRESHOLD = 131_072
MAX_DECISION_BYTES = 2 * 1024 * 1024
MAX_SIDECAR_BYTES = 256
IMPLEMENT_DECISION_RELATIVE = Path(
    "spikes/tui-startup-performance/bootstrap-consolidation-implement-decision.json"
)
IMPLEMENT_SIDECAR_RELATIVE = Path(f"{IMPLEMENT_DECISION_RELATIVE}.sha256")
LEGACY_CORE_REQUESTS = (
    "config.providers",
    "app.agents",
    "config.get",
    "project.path",
    "project.current",
)
CORE_BOOTSTRAP_REQUEST = "core.bootstrap"
CORE_CONTRACT_REQUESTS = (*LEGACY_CORE_REQUESTS, CORE_BOOTSTRAP_REQUEST)
PRIVACY_ALLOWLIST = (
    "artifacts.candidate",
    "decision",
    "evidence.adoption_baseline_response_bytes_twice_median",
    "evidence.core_requests",
    "evidence.removable_dispatch_ms_median",
    "evidence.removable_dispatch_threshold_ms",
    "evidence.removable_dispatch_qualifies",
    "evidence.removable_duplicate_bytes_twice_median",
    "evidence.removable_duplicate_bytes_twice_median_threshold",
    "evidence.removable_duplicate_bytes_qualifies",
    "evidence.samples",
    "inputs.candidate_artifact_sha256",
    "inputs.comparison_id",
    "inputs.comparison_sha256",
    "inputs.full_gate_sha256",
    "policy",
    "privacy.fields",
    "privacy.version",
    "schema",
    "tooling.bootstrap_decision_sha256",
    "version",
)
ADOPTION_PRIVACY_ALLOWLIST = (
    "artifacts.after_candidate",
    "artifacts.before_candidate",
    "decisions.core_request_count_strictly_lower",
    "decisions.response_bytes_twice_median_strictly_lower",
    "evidence.after.core_request_count",
    "evidence.after.core_requests",
    "evidence.after.response_bytes_twice_median",
    "evidence.before.core_request_count",
    "evidence.before.core_requests",
    "evidence.before.response_bytes_twice_median",
    "evidence.samples_per_arm",
    "failures",
    "inputs.after.comparison_id",
    "inputs.after.comparison_sha256",
    "inputs.after.full_gate_sha256",
    "inputs.before.comparison_id",
    "inputs.before.comparison_sha256",
    "inputs.before.full_gate_sha256",
    "inputs.decision_sha256",
    "passed",
    "policy",
    "privacy.fields",
    "privacy.version",
    "schema",
    "tooling.bootstrap_decision_sha256",
    "version",
)


class DecisionFailure(ValueError):
    """A content-free bootstrap decision validation failure."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def _exact_dict(value: object, keys: set[str]) -> bool:
    return (
        isinstance(value, dict)
        and set(value) == keys
        and all(isinstance(key, str) for key in value)
    )


def _valid_sha256(value: object) -> bool:
    return benchmark_gate._valid_sha256(value)


def _safe_integer(value: object) -> bool:
    return type(value) is int and 0 <= value <= tui_benchmark.MAX_SAFE_INTEGER


def _canonical_json_bytes(value: object) -> bytes:
    return tui_benchmark._canonical_json_bytes(value)


def _unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise DecisionFailure("decision_duplicate_key")
        result[key] = value
    return result


def _twice_median(values: Sequence[int]) -> int:
    if not values or any(not _safe_integer(value) for value in values):
        raise DecisionFailure("decision_integer_evidence_invalid")
    ordered = sorted(values)
    middle = len(ordered) // 2
    if len(ordered) % 2:
        result = 2 * ordered[middle]
    else:
        result = ordered[middle - 1] + ordered[middle]
    if not _safe_integer(result):
        raise DecisionFailure("decision_integer_evidence_invalid")
    return result


def _sum_safe_integers(values: Sequence[object]) -> int:
    if not values or any(not _safe_integer(value) for value in values):
        raise DecisionFailure("decision_integer_evidence_invalid")
    result = sum(values)  # type: ignore[arg-type]
    if not _safe_integer(result):
        raise DecisionFailure("decision_integer_evidence_invalid")
    return result


def _sample_evidence(measurement: Mapping[str, object]) -> tuple[float, int, int]:
    rpc = measurement["rpc"]
    if not isinstance(rpc, tuple):
        # Comparison samples retain the parsed list. This branch also supports
        # direct fixtures without weakening the exact row checks below.
        if not isinstance(rpc, list):
            raise DecisionFailure("decision_rpc_evidence_invalid")
    if any(item["name"] == CORE_BOOTSTRAP_REQUEST for item in rpc):  # type: ignore[union-attr]
        raise DecisionFailure("decision_core_request_matrix_invalid")
    rows = [item for item in rpc if item["name"] in LEGACY_CORE_REQUESTS]  # type: ignore[union-attr]
    if len(rows) != len(LEGACY_CORE_REQUESTS):
        raise DecisionFailure("decision_core_request_matrix_invalid")
    names = [item["name"] for item in rows]
    if len(set(names)) != len(names) or set(names) != set(LEGACY_CORE_REQUESTS):
        raise DecisionFailure("decision_core_request_matrix_invalid")

    durations: list[float] = []
    duplicate_bytes: list[object] = []
    response_bytes: list[object] = []
    for row in rows:
        if any(
            row[key] is None
            for key in (
                "request_sequence",
                "request_receipt_ms",
                "request_encoded_bytes",
                "dispatch_sequence",
                "dispatch_receipt_ms",
                "dispatch_duration_ms",
                "response_sequence",
                "response_receipt_ms",
                "response_encoded_bytes",
                "removable_duplicate_bytes",
            )
        ):
            raise DecisionFailure("decision_rpc_evidence_incomplete")
        duration = row["dispatch_duration_ms"]
        if (
            type(duration) not in (int, float)
            or not math.isfinite(duration)
            or not 0 <= duration <= tui_benchmark.MAX_SAFE_INTEGER
        ):
            raise DecisionFailure("decision_dispatch_evidence_invalid")
        if not all(
            _safe_integer(row[key])
            for key in (
                "request_sequence",
                "request_encoded_bytes",
                "dispatch_sequence",
                "response_sequence",
                "response_encoded_bytes",
                "removable_duplicate_bytes",
            )
        ):
            raise DecisionFailure("decision_integer_evidence_invalid")
        durations.append(float(duration))
        duplicate_bytes.append(row["removable_duplicate_bytes"])
        response_bytes.append(row["response_encoded_bytes"])

    dispatch_total = sum(durations)
    removable_dispatch = dispatch_total - max(durations)
    if (
        not math.isfinite(removable_dispatch)
        or not 0 <= removable_dispatch <= tui_benchmark.MAX_SAFE_INTEGER
    ):
        raise DecisionFailure("decision_dispatch_evidence_invalid")
    return (
        removable_dispatch,
        _sum_safe_integers(duplicate_bytes),
        _sum_safe_integers(response_bytes),
    )


def _load_inputs(
    candidate_artifact: Path,
    gate_report: Path,
    comparison_input: Path,
) -> tuple[tui_benchmark.Artifact, benchmark_gate.Comparison, benchmark_gate.FullGate]:
    try:
        artifact = tui_benchmark.load_artifact(candidate_artifact)
    except tui_benchmark.ArtifactFailure:
        raise DecisionFailure("decision_candidate_artifact_invalid") from None
    spec = benchmark_gate.POLICY_COHORTS["full-v1"][0]
    try:
        comparison = benchmark_gate.load_comparison(comparison_input, spec)
        full_gate = benchmark_gate.load_full_gate(gate_report)
        benchmark_gate._bind_full_gate(comparison, full_gate)
    except benchmark_gate.GateFailure as error:
        raise DecisionFailure(f"decision_{error.code}") from None

    candidate = comparison.metadata["artifacts"]["candidate"]  # type: ignore[index]
    if candidate != tui_benchmark._artifact_projection(artifact):
        raise DecisionFailure("decision_candidate_artifact_drift")
    if full_gate.report["artifacts"] != comparison.metadata["artifacts"]:
        raise DecisionFailure("decision_full_gate_artifact_drift")
    return artifact, comparison, full_gate


def evaluate_decision(
    policy: str,
    candidate_artifact: Path,
    gate_report: Path,
    comparison_input: Path,
) -> dict[str, object]:
    if policy != DECISION_POLICY:
        raise DecisionFailure("decision_policy_invalid")
    artifact, comparison, full_gate = _load_inputs(
        candidate_artifact,
        gate_report,
        comparison_input,
    )

    per_sample = [
        _sample_evidence(measurement)
        for measurement in comparison.samples["candidate"]
    ]
    expected_samples = benchmark_gate.POLICY_COHORTS["full-v1"][0].samples_per_arm
    if len(per_sample) != expected_samples:
        raise DecisionFailure("decision_sample_count_invalid")
    dispatch_values = [item[0] for item in per_sample]
    duplicate_values = [item[1] for item in per_sample]
    response_values = [item[2] for item in per_sample]
    try:
        dispatch_median = benchmark_gate.median(dispatch_values)
    except benchmark_gate.GateFailure:
        raise DecisionFailure("decision_dispatch_evidence_invalid") from None
    duplicate_twice_median = _twice_median(duplicate_values)
    response_twice_median = _twice_median(response_values)
    dispatch_qualifies = dispatch_median >= REMOVABLE_DISPATCH_THRESHOLD_MS
    duplicate_qualifies = (
        duplicate_twice_median >= REMOVABLE_DUPLICATE_TWICE_MEDIAN_THRESHOLD
    )
    decision = "implement" if dispatch_qualifies or duplicate_qualifies else "skip"

    try:
        tooling_hash = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    except OSError:
        raise DecisionFailure("decision_tooling_unavailable") from None
    candidate = comparison.metadata["artifacts"]["candidate"]  # type: ignore[index]
    return {
        "schema": DECISION_SCHEMA,
        "version": DECISION_VERSION,
        "policy": DECISION_POLICY,
        "decision": decision,
        "privacy": {
            "version": PRIVACY_VERSION,
            "fields": list(PRIVACY_ALLOWLIST),
        },
        "artifacts": {"candidate": candidate},
        "inputs": {
            "candidate_artifact_sha256": artifact.artifact_id,
            "comparison_sha256": comparison.sha256,
            "comparison_id": comparison.metadata["comparison_id"],
            "full_gate_sha256": full_gate.sha256,
        },
        "evidence": {
            "samples": expected_samples,
            "core_requests": list(LEGACY_CORE_REQUESTS),
            "removable_dispatch_ms_median": dispatch_median,
            "removable_dispatch_threshold_ms": REMOVABLE_DISPATCH_THRESHOLD_MS,
            "removable_dispatch_qualifies": dispatch_qualifies,
            "removable_duplicate_bytes_twice_median": duplicate_twice_median,
            "removable_duplicate_bytes_twice_median_threshold": REMOVABLE_DUPLICATE_TWICE_MEDIAN_THRESHOLD,
            "removable_duplicate_bytes_qualifies": duplicate_qualifies,
            "adoption_baseline_response_bytes_twice_median": response_twice_median,
        },
        "tooling": {"bootstrap_decision_sha256": tooling_hash},
    }


def write_decision(output: Path, report: Mapping[str, object]) -> None:
    try:
        benchmark_gate.write_report(output, report)
    except benchmark_gate.GateFailure as error:
        raise DecisionFailure(f"decision_{error.code}") from None


def run_decision(
    policy: str,
    candidate_artifact: Path,
    gate_report: Path,
    comparison_input: Path,
    output: Path,
) -> int:
    write_decision(
        output,
        evaluate_decision(policy, candidate_artifact, gate_report, comparison_input),
    )
    return 0


def _validate_decision_report(value: object) -> dict[str, object]:
    if not _exact_dict(
        value,
        {
            "schema",
            "version",
            "policy",
            "decision",
            "privacy",
            "artifacts",
            "inputs",
            "evidence",
            "tooling",
        },
    ):
        raise DecisionFailure("decision_schema_invalid")
    assert isinstance(value, dict)
    if (
        value["schema"] != DECISION_SCHEMA
        or type(value["version"]) is not int
        or value["version"] != DECISION_VERSION
        or value["policy"] != DECISION_POLICY
        or value["decision"] not in ("implement", "skip")
    ):
        raise DecisionFailure("decision_schema_invalid")

    privacy = value["privacy"]
    if privacy != {"version": PRIVACY_VERSION, "fields": list(PRIVACY_ALLOWLIST)}:
        raise DecisionFailure("decision_privacy_allowlist_mismatch")
    artifacts = value["artifacts"]
    if not _exact_dict(artifacts, {"candidate"}) or not benchmark_gate._valid_artifact(artifacts["candidate"]):  # type: ignore[index]
        raise DecisionFailure("decision_artifact_schema_invalid")
    inputs = value["inputs"]
    if not _exact_dict(
        inputs,
        {
            "candidate_artifact_sha256",
            "comparison_sha256",
            "comparison_id",
            "full_gate_sha256",
        },
    ) or not all(_valid_sha256(item) for item in inputs.values()):  # type: ignore[union-attr]
        raise DecisionFailure("decision_input_schema_invalid")
    assert isinstance(inputs, dict) and isinstance(artifacts, dict)
    candidate = artifacts["candidate"]
    assert isinstance(candidate, dict)
    if inputs["candidate_artifact_sha256"] != candidate["artifact_id"]:
        raise DecisionFailure("decision_input_schema_invalid")
    evidence = value["evidence"]
    if not _exact_dict(
        evidence,
        {
            "samples",
            "core_requests",
            "removable_dispatch_ms_median",
            "removable_dispatch_threshold_ms",
            "removable_dispatch_qualifies",
            "removable_duplicate_bytes_twice_median",
            "removable_duplicate_bytes_twice_median_threshold",
            "removable_duplicate_bytes_qualifies",
            "adoption_baseline_response_bytes_twice_median",
        },
    ):
        raise DecisionFailure("decision_evidence_schema_invalid")
    assert isinstance(evidence, dict)
    if (
        evidence["samples"] != benchmark_gate.POLICY_COHORTS["full-v1"][0].samples_per_arm
        or evidence["core_requests"] != list(LEGACY_CORE_REQUESTS)
        or type(evidence["removable_dispatch_ms_median"]) not in (int, float)
        or not math.isfinite(evidence["removable_dispatch_ms_median"])
        or evidence["removable_dispatch_ms_median"] < 0
        or evidence["removable_dispatch_threshold_ms"] != REMOVABLE_DISPATCH_THRESHOLD_MS
        or type(evidence["removable_dispatch_qualifies"]) is not bool
        or not _safe_integer(evidence["removable_duplicate_bytes_twice_median"])
        or evidence["removable_duplicate_bytes_twice_median_threshold"]
        != REMOVABLE_DUPLICATE_TWICE_MEDIAN_THRESHOLD
        or type(evidence["removable_duplicate_bytes_qualifies"]) is not bool
        or not _safe_integer(evidence["adoption_baseline_response_bytes_twice_median"])
    ):
        raise DecisionFailure("decision_evidence_schema_invalid")
    expected_dispatch = (
        evidence["removable_dispatch_ms_median"]
        >= REMOVABLE_DISPATCH_THRESHOLD_MS
    )
    expected_duplicate = (
        evidence["removable_duplicate_bytes_twice_median"]
        >= REMOVABLE_DUPLICATE_TWICE_MEDIAN_THRESHOLD
    )
    expected_decision = (
        "implement" if expected_dispatch or expected_duplicate else "skip"
    )
    if (
        evidence["removable_dispatch_qualifies"] is not expected_dispatch
        or evidence["removable_duplicate_bytes_qualifies"] is not expected_duplicate
        or value["decision"] != expected_decision
    ):
        raise DecisionFailure("decision_evidence_schema_invalid")
    tooling = value["tooling"]
    if not _exact_dict(tooling, {"bootstrap_decision_sha256"}) or not _valid_sha256(tooling["bootstrap_decision_sha256"]):  # type: ignore[index]
        raise DecisionFailure("decision_tooling_schema_invalid")
    return value


def load_decision(path: Path) -> tuple[dict[str, object], bytes]:
    try:
        before = tui_benchmark._lstat_regular(path)
        if before.size > MAX_DECISION_BYTES:
            raise DecisionFailure("decision_file_too_large")
        content, identity = tui_benchmark._read_stable_file(path)
    except DecisionFailure:
        raise
    except tui_benchmark.ArtifactFailure:
        raise DecisionFailure("decision_file_unavailable") from None
    if before != identity:
        raise DecisionFailure("decision_identity_changed")
    if not content or not content.endswith(b"\n") or b"\r" in content:
        raise DecisionFailure("decision_not_canonical")
    try:
        value = json.loads(
            content.decode("utf-8", errors="strict"),
            object_pairs_hook=_unique_object,
            parse_constant=lambda _: (_ for _ in ()).throw(
                DecisionFailure("decision_invalid_json")
            ),
        )
    except DecisionFailure:
        raise
    except (UnicodeDecodeError, json.JSONDecodeError, TypeError, ValueError, OverflowError):
        raise DecisionFailure("decision_invalid_json") from None
    report = _validate_decision_report(value)
    if content != _canonical_json_bytes(report):
        raise DecisionFailure("decision_not_canonical")
    return report, content


def _fixed_output(path: Path, relative: Path) -> bool:
    try:
        return Path(os.path.abspath(path)) == Path(
            os.path.abspath(tui_benchmark.REPO_ROOT / relative)
        )
    except OSError:
        return False


def _path_exists(path: Path) -> bool:
    try:
        path.lstat()
    except FileNotFoundError:
        return False
    except OSError:
        raise DecisionFailure("decision_preservation_path_invalid") from None
    return True


def _require_plain_parent_chain(parent: Path) -> None:
    root = Path(os.path.abspath(tui_benchmark.REPO_ROOT))
    current = root
    try:
        relative = Path(os.path.abspath(parent)).relative_to(root)
    except ValueError:
        raise DecisionFailure("decision_preservation_path_invalid") from None
    for part in relative.parts:
        current = current / part
        try:
            if current.is_symlink() or not current.is_dir():
                raise DecisionFailure("decision_preservation_path_invalid")
        except OSError:
            raise DecisionFailure("decision_preservation_path_invalid") from None


def _remove_created(path: Path, identity: tui_benchmark.StableFileIdentity) -> None:
    try:
        if tui_benchmark._lstat_regular(path) == identity:
            path.unlink()
    except (OSError, tui_benchmark.ArtifactFailure):
        return


def preserve_implement_decision(
    policy: str,
    expect: str,
    privacy_review_approved: bool,
    source: Path,
    candidate_artifact: Path,
    gate_report: Path,
    comparison_input: Path,
    output: Path,
    sha256_output: Path,
) -> None:
    if policy != DECISION_POLICY or expect != "implement":
        raise DecisionFailure("decision_preservation_policy_invalid")
    if privacy_review_approved is not True:
        raise DecisionFailure("decision_privacy_review_required")
    if not _fixed_output(output, IMPLEMENT_DECISION_RELATIVE) or not _fixed_output(
        sha256_output, IMPLEMENT_SIDECAR_RELATIVE
    ):
        raise DecisionFailure("decision_preservation_path_invalid")
    _require_plain_parent_chain(output.parent)
    if _path_exists(output) or _path_exists(sha256_output):
        raise DecisionFailure("decision_preservation_collision")

    source_report, source_bytes = load_decision(source)
    if source_report["decision"] != "implement":
        raise DecisionFailure("decision_preservation_skip_rejected")
    recomputed = evaluate_decision(
        policy,
        candidate_artifact,
        gate_report,
        comparison_input,
    )
    if source_report != recomputed or source_bytes != _canonical_json_bytes(recomputed):
        raise DecisionFailure("decision_preservation_provenance_mismatch")

    digest = hashlib.sha256(source_bytes).hexdigest()
    sidecar = f"{digest}  {IMPLEMENT_DECISION_RELATIVE.as_posix()}\n".encode("ascii")
    parent = output.parent
    created: list[tuple[Path, tui_benchmark.StableFileIdentity]] = []
    try:
        parent_identity = parent.lstat()
        if not parent.is_dir() or parent.is_symlink():
            raise OSError("invalid parent")
        tui_benchmark._write_exclusive(output, source_bytes)
        created.append((output, tui_benchmark._lstat_regular(output)))
        tui_benchmark._write_exclusive(sha256_output, sidecar)
        created.append((sha256_output, tui_benchmark._lstat_regular(sha256_output)))
        persisted, _ = tui_benchmark._read_stable_file(output)
        persisted_sidecar, _ = tui_benchmark._read_stable_file(sha256_output)
        if persisted != source_bytes or persisted_sidecar != sidecar:
            raise DecisionFailure("decision_preservation_identity_changed")
        parent_after = parent.lstat()
        if (
            parent_after.st_dev != parent_identity.st_dev
            or parent_after.st_ino != parent_identity.st_ino
            or parent.is_symlink()
            or not parent.is_dir()
        ):
            raise DecisionFailure("decision_preservation_identity_changed")
        tui_benchmark._fsync_directory(parent)
    except (DecisionFailure, FileExistsError, OSError, tui_benchmark.ArtifactFailure) as error:
        for path, identity in reversed(created):
            _remove_created(path, identity)
        try:
            tui_benchmark._fsync_directory(parent)
        except OSError:
            pass
        if isinstance(error, DecisionFailure):
            raise
        if isinstance(error, FileExistsError):
            raise DecisionFailure("decision_preservation_collision") from None
        raise DecisionFailure("decision_preservation_failed") from None


def _load_preserved_implement_decision(
    decision_artifact: Path,
) -> tuple[dict[str, object], str, str]:
    if not _fixed_output(
        decision_artifact, IMPLEMENT_DECISION_RELATIVE
    ) or not _fixed_output(
        Path(f"{decision_artifact}.sha256"), IMPLEMENT_SIDECAR_RELATIVE
    ):
        raise DecisionFailure("adoption_decision_path_invalid")
    _require_plain_parent_chain(decision_artifact.parent)

    report, content = load_decision(decision_artifact)
    if report["decision"] != "implement":
        raise DecisionFailure("adoption_implement_decision_required")
    evidence = report["evidence"]
    tooling = report["tooling"]
    assert isinstance(evidence, dict) and isinstance(tooling, dict)
    if (
        evidence["samples"] <= 0
        or len(evidence["core_requests"]) <= 1  # type: ignore[arg-type]
        or report["artifacts"]["candidate"]["shell_capability"] != "required"  # type: ignore[index]
    ):
        raise DecisionFailure("adoption_decision_provenance_mismatch")
    try:
        current_tooling_hash = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    except OSError:
        raise DecisionFailure("adoption_tooling_unavailable") from None
    if tooling["bootstrap_decision_sha256"] != current_tooling_hash:
        raise DecisionFailure("adoption_decision_provenance_mismatch")

    digest = hashlib.sha256(content).hexdigest()
    sidecar_path = Path(f"{decision_artifact}.sha256")
    try:
        before = tui_benchmark._lstat_regular(sidecar_path)
        if before.size > MAX_SIDECAR_BYTES:
            raise DecisionFailure("adoption_decision_sidecar_invalid")
        sidecar, identity = tui_benchmark._read_stable_file(sidecar_path)
    except DecisionFailure:
        raise
    except tui_benchmark.ArtifactFailure:
        raise DecisionFailure("adoption_decision_sidecar_invalid") from None
    if before != identity:
        raise DecisionFailure("adoption_decision_sidecar_invalid")
    expected = (
        f"{digest}  {IMPLEMENT_DECISION_RELATIVE.as_posix()}\n".encode("ascii")
    )
    if sidecar != expected:
        raise DecisionFailure("adoption_decision_sidecar_invalid")
    return report, digest, current_tooling_hash


def _adopted_sample_response_bytes(measurement: Mapping[str, object]) -> int:
    rpc = measurement["rpc"]
    if not isinstance(rpc, (list, tuple)):
        raise DecisionFailure("adoption_rpc_evidence_invalid")
    legacy = [row for row in rpc if row["name"] in LEGACY_CORE_REQUESTS]
    if legacy:
        raise DecisionFailure("adoption_legacy_core_request_present")
    bootstrap = [row for row in rpc if row["name"] == CORE_BOOTSTRAP_REQUEST]
    if len(bootstrap) != 1:
        raise DecisionFailure("adoption_core_request_count_invalid")
    core = [row for row in rpc if row["name"] in CORE_CONTRACT_REQUESTS]
    if len(core) != 1:
        raise DecisionFailure("adoption_core_request_count_invalid")
    row = bootstrap[0]
    if any(
        row[key] is None
        for key in (
            "request_sequence",
            "request_receipt_ms",
            "request_encoded_bytes",
            "dispatch_sequence",
            "dispatch_receipt_ms",
            "dispatch_duration_ms",
            "response_sequence",
            "response_receipt_ms",
            "response_encoded_bytes",
            "removable_duplicate_bytes",
        )
    ):
        raise DecisionFailure("adoption_core_request_incomplete")
    response_bytes = row["response_encoded_bytes"]
    if not _safe_integer(response_bytes):
        raise DecisionFailure("adoption_response_bytes_invalid")
    return response_bytes


def _load_after_inputs(
    after_comparison: Path,
    after_full_gate: Path,
) -> tuple[benchmark_gate.Comparison, benchmark_gate.FullGate]:
    spec = benchmark_gate.POLICY_COHORTS["full-v1"][0]
    try:
        comparison = benchmark_gate.load_comparison(after_comparison, spec)
        full_gate = benchmark_gate.load_full_gate(after_full_gate)
        benchmark_gate._bind_full_gate(comparison, full_gate)
    except benchmark_gate.GateFailure as error:
        raise DecisionFailure(f"adoption_{error.code}") from None
    try:
        current_gate_hash = hashlib.sha256(
            Path(benchmark_gate.__file__).read_bytes()
        ).hexdigest()
    except OSError:
        raise DecisionFailure("adoption_tooling_unavailable") from None
    if full_gate.report["tooling"]["benchmark_gate_sha256"] != current_gate_hash:  # type: ignore[index]
        raise DecisionFailure("adoption_full_gate_provenance_mismatch")
    return comparison, full_gate


def evaluate_adoption(
    policy: str,
    decision_artifact: Path,
    after_comparison: Path,
    after_full_gate: Path,
) -> dict[str, object]:
    if policy != ADOPTION_POLICY:
        raise DecisionFailure("adoption_policy_invalid")
    (
        decision,
        decision_sha256,
        current_tooling_hash,
    ) = _load_preserved_implement_decision(decision_artifact)
    comparison, full_gate = _load_after_inputs(
        after_comparison,
        after_full_gate,
    )

    evidence = decision["evidence"]
    decision_inputs = decision["inputs"]
    decision_artifacts = decision["artifacts"]
    after_artifacts = comparison.metadata["artifacts"]
    assert all(
        isinstance(value, dict)
        for value in (
            evidence,
            decision_inputs,
            decision_artifacts,
            after_artifacts,
        )
    )
    before_candidate = decision_artifacts["candidate"]  # type: ignore[index]
    after_candidate = after_artifacts["candidate"]  # type: ignore[index]
    assert isinstance(before_candidate, dict) and isinstance(after_candidate, dict)
    if before_candidate["artifact_id"] == after_candidate["artifact_id"]:
        raise DecisionFailure("adoption_candidate_not_distinct")

    before_samples = evidence["samples"]  # type: ignore[index]
    after_samples = len(comparison.samples["candidate"])
    if (
        not _safe_integer(before_samples)
        or before_samples <= 0
        or after_samples <= 0
        or before_samples != after_samples
    ):
        raise DecisionFailure("adoption_sample_count_invalid")
    before_requests = evidence["core_requests"]  # type: ignore[index]
    if before_requests != list(LEGACY_CORE_REQUESTS) or len(before_requests) <= 1:
        raise DecisionFailure("adoption_before_core_request_count_invalid")

    after_response_totals = [
        _adopted_sample_response_bytes(measurement)
        for measurement in comparison.samples["candidate"]
    ]
    after_twice_median = _twice_median(after_response_totals)
    before_twice_median = evidence[  # type: ignore[index]
        "adoption_baseline_response_bytes_twice_median"
    ]
    if not _safe_integer(before_twice_median):
        raise DecisionFailure("adoption_response_bytes_invalid")
    request_count_lower = 1 < len(before_requests)
    response_bytes_lower = after_twice_median < before_twice_median
    failures = (
        []
        if response_bytes_lower
        else ["response_bytes_twice_median_not_strictly_lower"]
    )
    return {
        "schema": ADOPTION_SCHEMA,
        "version": ADOPTION_VERSION,
        "policy": ADOPTION_POLICY,
        "passed": not failures,
        "privacy": {
            "version": PRIVACY_VERSION,
            "fields": list(ADOPTION_PRIVACY_ALLOWLIST),
        },
        "artifacts": {
            "before_candidate": before_candidate,
            "after_candidate": after_candidate,
        },
        "inputs": {
            "decision_sha256": decision_sha256,
            "before": {
                "comparison_sha256": decision_inputs["comparison_sha256"],  # type: ignore[index]
                "comparison_id": decision_inputs["comparison_id"],  # type: ignore[index]
                "full_gate_sha256": decision_inputs["full_gate_sha256"],  # type: ignore[index]
            },
            "after": {
                "comparison_sha256": comparison.sha256,
                "comparison_id": comparison.metadata["comparison_id"],
                "full_gate_sha256": full_gate.sha256,
            },
        },
        "evidence": {
            "samples_per_arm": after_samples,
            "before": {
                "core_requests": list(LEGACY_CORE_REQUESTS),
                "core_request_count": len(before_requests),
                "response_bytes_twice_median": before_twice_median,
            },
            "after": {
                "core_requests": [CORE_BOOTSTRAP_REQUEST],
                "core_request_count": 1,
                "response_bytes_twice_median": after_twice_median,
            },
        },
        "decisions": {
            "core_request_count_strictly_lower": request_count_lower,
            "response_bytes_twice_median_strictly_lower": response_bytes_lower,
        },
        "failures": failures,
        "tooling": {"bootstrap_decision_sha256": current_tooling_hash},
    }


def run_adoption(
    policy: str,
    decision_artifact: Path,
    after_comparison: Path,
    after_full_gate: Path,
    output: Path,
) -> int:
    report = evaluate_adoption(
        policy,
        decision_artifact,
        after_comparison,
        after_full_gate,
    )
    try:
        benchmark_gate.write_report(output, report)
    except benchmark_gate.GateFailure as error:
        raise DecisionFailure(f"adoption_{error.code}") from None
    return 0 if report["passed"] is True else 1
