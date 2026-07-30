#!/usr/bin/env python3
"""Measure OC2 TUI startup through a controlled pseudo-terminal."""

import argparse
import ctypes
import errno
import hashlib
import json
import math
import os
import platform
import re
import secrets
import select
import signal
import shutil
import stat
import statistics
import struct
import subprocess
import sys
import tempfile
import termios
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType
from typing import Any, Callable, Mapping, Optional, Sequence, TextIO, Union

from terminal_screen import (
    PTY_HEIGHT,
    PTY_WIDTH,
    PtyCleanupError,
    PtyHandshakeError,
    TerminalFrame,
    TerminalScreen,
    close_pty_fd,
    read_pty,
    spawn_pty,
    stop_pty_child,
)


REPO_ROOT = Path(__file__).resolve().parents[2]
TTFD_PREFIX = b"Time to first draw:"
TTFD = re.compile(rb"Time to first draw:\s*((?:0|[1-9][0-9]*)(?:\.[0-9]+)?)ms(?![0-9A-Za-z.])")
DEFAULT_READY_TEXT = "Ask anything..."
PROMPT_ROW = 15
PROMPT_COLUMN = 16
HOME_PLACEHOLDERS = (
    'Ask anything... "Fix a TODO in the codebase"',
    'Ask anything... "What is the tech stack of this project?"',
    'Ask anything... "Fix broken tests"',
)
TRACE_VERSION = 2
MAX_SAFE_INTEGER = (1 << 53) - 1
TRACE_MAX_LINE_BYTES = 512
TRACE_MAX_RECORDS = 512
LEGACY_SCAN_LIMIT = 4 * 1024 * 1024
OSC_MAX_PAYLOAD_BYTES = 256
OSC_MAX_QUERY_COUNT = 64
PROBE_PREFIX = "oc2latency"
PROBE_NONCE_BYTES = 16
PROBE_GUARD = "z"
PROBE_PERSISTENCE_SECONDS = 0.1
ARTIFACT_SCHEMA = "oc2-tui-startup-artifact"
ARTIFACT_VERSION = 1
ARTIFACT_MANIFEST = "artifact.json"
ARTIFACT_SIDECAR = "artifact.sha256"
ARTIFACT_BINARY = "bin/oc2"
COMPARE_SCHEMA = "oc2-tui-startup-compare"
COMPARE_VERSION = 1
SCHEDULE_VERSION = 1
TRACE_EVIDENCE_VERSION = 2
MAX_ARTIFACT_NAME_BYTES = 128
MAX_BUILD_COMMAND_BYTES = 256
COMPARE_COMMAND_SAFE_FLAGS = frozenset(("--pure",))
TRACE_ENV_KEYS = (
    "OC2_TUI_STARTUP_PROFILE",
    "OC2_TUI_STARTUP_PROFILE_FD",
    "OC2_RUN_ID",
)
SUPERVISION_ENV = "OC2_TUI_BENCHMARK_SUPERVISION_TOKEN"
TRACE_PHASES = frozenset(
    (
        "cli.command.load",
        "worker.spawn",
        "tui.config",
        "transport.ready",
        "session.validate",
        "tui.import",
        "renderer.create",
        "theme.wait",
        "renderer.render",
        "plugin.load",
        "bootstrap.critical",
        "bootstrap.optional",
    )
)
TRACE_REQUESTS = frozenset(
    (
        "config.providers",
        "provider.list",
        "app.agents",
        "config.get",
        "project.path",
        "project.current",
        "core.bootstrap",
        "session.list",
        "worker.server",
        "other",
    )
)
TRACE_MARKERS = frozenset(
    (
        "prompt.mounted",
        "bootstrap.critical.ready",
        "input.accepted",
        "theme.settled",
        "theme.reconciled",
    )
)
_TTFD_LINE = re.compile(r"^Time to first draw:\s*(?:0|[1-9][0-9]*)(?:\.[0-9]+)?ms$")
_FATAL_PREFIXES = (
    "typeerror:",
    "referenceerror:",
    "syntaxerror:",
    "rangeerror:",
    "urierror:",
    "evalerror:",
    "aggregateerror:",
    "error:",
    "fatal:",
    "panic:",
    "traceback (most recent call last):",
    "failed to launch command:",
)
CONTROLLED_ENV = {
    "TERM": "xterm-256color",
    "COLORTERM": "truecolor",
    "OPENTUI_FORCE_UNICODE": "1",
    "OC2_PURE": "1",
    "OC2_SHOW_TTFD": "1",
    "OC2_DISABLE_MODELS_FETCH": "1",
    "OC2_DISABLE_AUTOUPDATE": "1",
    "OC2_DISABLE_MOUSE": "1",
    "OC2_DISABLE_TERMINAL_TITLE": "1",
    "OC2_DISABLE_PROJECT_CONFIG": "1",
}


class TraceFailure(ValueError):
    """A content-free, stable trace validation failure."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


class ProbeFailure(ValueError):
    """A content-free OSC, response, or interaction-probe failure."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


class ArtifactFailure(ValueError):
    """A bounded artifact preservation or validation failure."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


class CompareFailure(ValueError):
    """A bounded comparison configuration or lifecycle failure."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class StableFileIdentity:
    device: int
    inode: int
    mode: int
    links: int
    size: int
    modified_ns: int
    changed_ns: int


@dataclass(frozen=True)
class Artifact:
    root: Path
    binary_path: Path
    manifest: Mapping[str, object]
    artifact_id: str
    binary_identity: StableFileIdentity


@dataclass(frozen=True)
class ThemeFixture:
    kind: str
    delay_ms: int = 0


def parse_theme_response(value: str) -> ThemeFixture:
    if value in ("dark", "light", "none", "malformed"):
        return ThemeFixture(value)
    match = re.fullmatch(r"late:([1-9][0-9]*)", value)
    if match is None:
        raise argparse.ArgumentTypeError(
            "theme response must be dark, light, none, malformed, or late:<positive-ms>"
        )
    delay_ms = int(match.group(1))
    if delay_ms > MAX_SAFE_INTEGER:
        raise argparse.ArgumentTypeError("late theme response delay is too large")
    return ThemeFixture("late", delay_ms)


class OscQueryParser:
    """Extract exact OSC 10/11 queries from bounded, arbitrary byte fragments."""

    def __init__(self):
        self._state = "text"
        self._payload = bytearray()
        self.query_count = 0

    def _finish(self) -> Optional[int]:
        payload = bytes(self._payload)
        self._payload.clear()
        self._state = "text"
        if payload == b"10;?":
            selector = 10
        elif payload == b"11;?":
            selector = 11
        else:
            return None
        if self.query_count >= OSC_MAX_QUERY_COUNT:
            raise ProbeFailure("osc_query_limit")
        self.query_count += 1
        return selector

    def feed(self, data: bytes) -> tuple[int, ...]:
        if not isinstance(data, bytes):
            raise TypeError("OSC input must be bytes")
        queries: list[int] = []
        for value in data:
            if self._state == "text":
                if value == 0x1B:
                    self._state = "escape"
                continue
            if self._state == "escape":
                if value == ord("]"):
                    self._payload.clear()
                    self._state = "osc"
                elif value != 0x1B:
                    self._state = "text"
                continue
            if self._state == "osc":
                if value == 0x07:
                    selector = self._finish()
                    if selector is not None:
                        queries.append(selector)
                    continue
                if value == 0x1B:
                    self._state = "osc-escape"
                    continue
                if len(self._payload) < OSC_MAX_PAYLOAD_BYTES:
                    self._payload.append(value)
                else:
                    self._payload.clear()
                    self._state = "discard"
                continue
            if self._state == "osc-escape":
                if value == ord("\\"):
                    selector = self._finish()
                    if selector is not None:
                        queries.append(selector)
                else:
                    self._payload.clear()
                    self._state = "discard-escape" if value == 0x1B else "discard"
                continue
            if self._state == "discard":
                if value == 0x07:
                    self._state = "text"
                elif value == 0x1B:
                    self._state = "discard-escape"
                continue
            if self._state == "discard-escape":
                if value == ord("\\"):
                    self._state = "text"
                elif value != 0x1B:
                    self._state = "discard"
        return tuple(queries)


def _write_pty_input(fd: int, data: bytes) -> None:
    remaining = memoryview(data)
    while remaining:
        try:
            written = os.write(fd, remaining)
        except InterruptedError:
            continue
        if written <= 0:
            raise OSError(errno.EIO, "PTY input write made no progress")
        remaining = remaining[written:]


class ThemeResponder:
    """Apply one controlled theme fixture to every exact OSC 10/11 query."""

    def __init__(self, fd: int, fixture: ThemeFixture):
        self.fd = fd
        self.fixture = fixture
        self.foreground_queries = 0
        self.background_queries = 0
        self.foreground_responses = 0
        self.background_responses = 0
        self._pending: list[tuple[float, int, bool]] = []
        self._malformed_sent = False

    def _response(self, selector: int, malformed: bool) -> bytes:
        if malformed:
            return f"\x1b]{selector};rgb:not-a-color\x07".encode("ascii")
        dark = self.fixture.kind in ("dark", "late")
        if selector == 10:
            color = "ffff/ffff/ffff" if dark else "0000/0000/0000"
        else:
            color = "0000/0000/0000" if dark else "ffff/ffff/ffff"
        return f"\x1b]{selector};rgb:{color}\x07".encode("ascii")

    def observe(self, queries: Sequence[int], receipt_time: float) -> None:
        for selector in queries:
            if selector == 10:
                self.foreground_queries += 1
            elif selector == 11:
                self.background_queries += 1
            else:
                raise ValueError("unsupported theme selector")
            if self.fixture.kind == "none":
                continue
            if self.fixture.kind == "malformed":
                if self._malformed_sent:
                    continue
                self._malformed_sent = True
                self._pending.append((receipt_time, selector, True))
                continue
            delay = self.fixture.delay_ms / 1000 if self.fixture.kind == "late" else 0
            self._pending.append((receipt_time + delay, selector, False))

    def next_deadline(self) -> Optional[float]:
        if not self._pending:
            return None
        return min(item[0] for item in self._pending)

    def flush_due(self, now: float) -> None:
        due = [item for item in self._pending if item[0] <= now]
        if not due:
            return
        self._pending = [item for item in self._pending if item[0] > now]
        for _, selector, malformed in sorted(due, key=lambda item: item[0]):
            try:
                _write_pty_input(self.fd, self._response(selector, malformed))
            except OSError:
                raise ProbeFailure("theme_response_write_failed") from None
            if selector == 10:
                self.foreground_responses += 1
            else:
                self.background_responses += 1

    def activity_failure(self) -> Optional[str]:
        if self.foreground_queries == 0 or self.background_queries == 0:
            return "theme_query_missing"
        responses = self.foreground_responses + self.background_responses
        if self.fixture.kind == "none":
            return None if responses == 0 else "theme_response_activity_mismatch"
        if self.fixture.kind == "malformed":
            return None if responses == 1 else "theme_response_activity_mismatch"
        if (
            self.foreground_responses != self.foreground_queries
            or self.background_responses != self.background_queries
        ):
            return "theme_response_activity_mismatch"
        return None

    def marker_activity_failure(self, event: object, outcome: object = None) -> Optional[str]:
        if event not in ("theme.settled", "theme.reconciled"):
            return None
        if self.foreground_queries == 0 or self.background_queries == 0:
            return "theme_query_missing"
        if event == "theme.settled" and self.fixture.kind == "late" and outcome == "fallback-final":
            return None
        return self.activity_failure()

    @property
    def responses_pending(self) -> bool:
        return bool(self._pending)


class _JsonNumber:
    __slots__ = ("raw", "value", "integer")

    def __init__(self, raw: str, value: object, integer: bool):
        self.raw = raw
        self.value = value
        self.integer = integer


def _safe_integer(value: object) -> bool:
    return type(value) is int and 0 <= value <= MAX_SAFE_INTEGER


def _schema_safe_integer(value: object) -> bool:
    return (
        isinstance(value, _JsonNumber)
        and value.integer
        and re.fullmatch(r"(?:0|[1-9][0-9]*)", value.raw) is not None
        and _safe_integer(value.value)
    )


def _schema_exact_integer(value: object, expected: int) -> bool:
    return _schema_safe_integer(value) and value.value == expected


def _finite_nonnegative(value: object) -> bool:
    return (
        type(value) in (int, float)
        and 0 <= value <= MAX_SAFE_INTEGER
        and math.isfinite(value)
    )


def _ecmascript_number_string(number: object) -> Optional[str]:
    if type(number) is int:
        if number < 0:
            return None
        try:
            return _ecmascript_number_string(float(number))
        except (OverflowError, ValueError):
            return None
        return str(number)
    if type(number) is not float or not math.isfinite(number) or number < 0:
        return None
    if number == 0:
        return "0"
    rendered = repr(number).lower()
    if "e" not in rendered:
        return rendered[:-2] if rendered.endswith(".0") else rendered
    coefficient, exponent_text = rendered.split("e", 1)
    exponent = int(exponent_text)
    if 0.000001 <= number < 1e21:
        digits = coefficient.replace(".", "")
        decimal_at = coefficient.find(".")
        leading = decimal_at if decimal_at >= 0 else len(coefficient)
        decimal_at = leading + exponent
        if decimal_at <= 0:
            return "0." + "0" * (-decimal_at) + digits
        if decimal_at >= len(digits):
            return digits + "0" * (decimal_at - len(digits))
        return digits[:decimal_at] + "." + digits[decimal_at:]
    coefficient = coefficient[:-2] if coefficient.endswith(".0") else coefficient
    sign = "+" if exponent >= 0 else "-"
    return f"{coefficient}e{sign}{abs(exponent)}"


def _schema_nonnegative_number(value: object) -> bool:
    if not isinstance(value, _JsonNumber):
        return False
    number = value.value
    if type(number) not in (int, float) or number > MAX_SAFE_INTEGER:
        return False
    canonical = _ecmascript_number_string(number)
    return canonical is not None and value.raw == canonical


def _normalize_json_number(value: object) -> object:
    return value.value if isinstance(value, _JsonNumber) else value


def _exact_keys(record: dict[str, object], *event_keys: str) -> bool:
    common = {"version", "runID", "sequence", "elapsedMs"}
    return set(record) == common.union(event_keys)


def _valid_trace_record(record: object) -> bool:
    """Validate the exact accepted Slice 1 trace schema without retaining content."""

    if not isinstance(record, dict) or any(not isinstance(key, str) for key in record):
        return False
    if not _schema_exact_integer(record.get("version"), TRACE_VERSION):
        return False
    run_id = record.get("runID")
    if (
        not isinstance(run_id, str)
        or not run_id
        or len(run_id.encode("utf-8")) > 128
        or re.fullmatch(r"[0-9A-Za-z_-]+", run_id) is None
    ):
        return False
    if not _schema_safe_integer(record.get("sequence")) or not _schema_nonnegative_number(record.get("elapsedMs")):
        return False
    event = record.get("event")
    role = record.get("role")
    if event == "cli.entry":
        return role == "main" and _exact_keys(record, "event", "role")
    if event == "phase":
        return (
            role in ("main", "worker")
            and _exact_keys(record, "event", "role", "phase", "outcome", "durationMs")
            and isinstance(record.get("phase"), str)
            and record.get("phase") in TRACE_PHASES
            and record.get("outcome") in ("ok", "error")
            and _schema_nonnegative_number(record.get("durationMs"))
        )
    if event == "rpc.request":
        return (
            role == "main"
            and _exact_keys(record, "event", "role", "requestID", "request", "encodedBytes")
            and _schema_safe_integer(record.get("requestID"))
            and isinstance(record.get("request"), str)
            and record.get("request") in TRACE_REQUESTS
            and _schema_safe_integer(record.get("encodedBytes"))
        )
    if event == "rpc.response":
        return (
            role == "main"
            and _exact_keys(
                record,
                "event",
                "role",
                "requestID",
                "request",
                "encodedBytes",
                "removableDuplicateBytes",
            )
            and _schema_safe_integer(record.get("requestID"))
            and isinstance(record.get("request"), str)
            and record.get("request") in TRACE_REQUESTS
            and _schema_safe_integer(record.get("encodedBytes"))
            and _schema_exact_integer(record.get("removableDuplicateBytes"), 0)
        )
    if event == "rpc.dispatch":
        return (
            role == "worker"
            and _exact_keys(record, "event", "role", "requestID", "request", "durationMs")
            and _schema_safe_integer(record.get("requestID"))
            and isinstance(record.get("request"), str)
            and record.get("request") in TRACE_REQUESTS
            and _schema_nonnegative_number(record.get("durationMs"))
        )
    if event in ("prompt.mounted", "bootstrap.critical.ready", "input.accepted", "theme.reconciled"):
        return (
            role == "main"
            and _exact_keys(record, "event", "role", "workspaceGeneration", "attemptGeneration")
            and _schema_exact_integer(record.get("workspaceGeneration"), 0)
            and _schema_exact_integer(record.get("attemptGeneration"), 0)
        )
    if event == "theme.settled":
        return (
            role == "main"
            and _exact_keys(
                record,
                "event",
                "role",
                "workspaceGeneration",
                "attemptGeneration",
                "outcome",
            )
            and _schema_exact_integer(record.get("workspaceGeneration"), 0)
            and _schema_exact_integer(record.get("attemptGeneration"), 0)
            and record.get("outcome") in ("locked", "resolved", "fallback-final")
        )
    return False


def _unique_json_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise TraceFailure("trace_invalid_json")
        result[key] = value
    return result


class TraceJsonlParser:
    """Incrementally validate independent, arbitrarily fragmented trace JSONL."""

    def __init__(self, run_id: str):
        self.run_id = run_id
        self._pending = bytearray()
        self._sequence = 0
        self.records = 0

    def feed(self, data: bytes, receipt_ms: float) -> tuple[tuple[dict[str, object], float], ...]:
        if not isinstance(data, bytes):
            raise TypeError("trace input must be bytes")
        if not _finite_nonnegative(receipt_ms):
            raise ValueError("trace receipt clock must be finite and nonnegative")
        self._pending.extend(data)
        parsed: list[tuple[dict[str, object], float]] = []
        while True:
            newline = self._pending.find(b"\n")
            if newline < 0:
                if len(self._pending) >= TRACE_MAX_LINE_BYTES:
                    raise TraceFailure("trace_line_too_large")
                break
            line = bytes(self._pending[:newline])
            del self._pending[: newline + 1]
            if not line or line.endswith(b"\r") or len(line) + 1 > TRACE_MAX_LINE_BYTES:
                raise TraceFailure("trace_invalid_json")
            try:
                record = json.loads(
                    line.decode("utf-8", errors="strict"),
                    object_pairs_hook=_unique_json_object,
                    parse_int=lambda raw: _JsonNumber(raw, int(raw), True),
                    parse_float=lambda raw: _JsonNumber(raw, float(raw), False),
                    parse_constant=lambda _: (_ for _ in ()).throw(TraceFailure("trace_invalid_json")),
                )
            except TraceFailure:
                raise
            except (UnicodeDecodeError, json.JSONDecodeError, TypeError, ValueError):
                raise TraceFailure("trace_invalid_json") from None
            if not _valid_trace_record(record):
                raise TraceFailure("trace_invalid_schema")
            assert isinstance(record, dict)
            normalized = {key: _normalize_json_number(value) for key, value in record.items()}
            if normalized["runID"] != self.run_id:
                raise TraceFailure("trace_run_id_mismatch")
            if normalized["sequence"] != self._sequence:
                raise TraceFailure("trace_sequence_mismatch")
            if (self._sequence == 0) != (normalized["event"] == "cli.entry"):
                raise TraceFailure("trace_event_order")
            if self.records >= TRACE_MAX_RECORDS:
                raise TraceFailure("trace_record_limit")
            self._sequence += 1
            self.records += 1
            parsed.append((normalized, receipt_ms))
        return tuple(parsed)

    def finish(self) -> None:
        if self._pending:
            raise TraceFailure("trace_eof_truncated")


FrameMatcher = Callable[[TerminalFrame], bool]


def _frame_has_fatal(frame: TerminalFrame) -> bool:
    for line in frame.lines:
        visible = line.strip()
        if not visible or _TTFD_LINE.fullmatch(visible) is not None:
            continue
        folded = visible.casefold()
        if folded.startswith("uncaught "):
            folded = folded[len("uncaught ") :]
        if any(folded.startswith(prefix) for prefix in _FATAL_PREFIXES):
            return True
    return False


def _valid_first_frame(frame: TerminalFrame) -> bool:
    if (frame.width, frame.height) != (PTY_WIDTH, PTY_HEIGHT) or frame.is_blank or _frame_has_fatal(frame):
        return False
    visible = [line.strip() for line in frame.lines if line.strip()]
    return any(_TTFD_LINE.fullmatch(line) is None for line in visible)


def _prompt_matcher(frame: TerminalFrame) -> bool:
    """Match the pinned compiled pure-home 100x30 textarea cell span.

    A compiled local pure-mode capture at the accepted Slice 2B base committed
    screen sequence 4 with row 15 equal to
    ``"             ┃  Ask anything... ..."``. The border is column 13,
    textarea padding is columns 14-15, and the placeholder starts at column 16.
    Coordinates are zero-based; bytes at any other cells do not qualify.
    """

    if (frame.width, frame.height) != (PTY_WIDTH, PTY_HEIGHT):
        return False
    row = frame.cells[PROMPT_ROW]
    for placeholder in HOME_PLACEHOLDERS:
        expected = tuple(placeholder)
        end = PROMPT_COLUMN + len(expected)
        if row[PROMPT_COLUMN:end] == expected and (end == frame.width or row[end] == " "):
            return True
    return False


def _prompt_placeholder(frame: TerminalFrame) -> Optional[str]:
    if (frame.width, frame.height) != (PTY_WIDTH, PTY_HEIGHT):
        return None
    row = frame.cells[PROMPT_ROW]
    for placeholder in HOME_PLACEHOLDERS:
        expected = tuple(placeholder)
        end = PROMPT_COLUMN + len(expected)
        if row[PROMPT_COLUMN:end] == expected and (end == frame.width or row[end] == " "):
            return placeholder
    return None


def _textarea_has(frame: TerminalFrame, value: str, following: Sequence[str] = (" ",)) -> bool:
    if (frame.width, frame.height) != (PTY_WIDTH, PTY_HEIGHT):
        return False
    row = frame.cells[PROMPT_ROW]
    expected = tuple(value)
    end = PROMPT_COLUMN + len(expected)
    return (
        end <= frame.width
        and row[PROMPT_COLUMN:end] == expected
        and (end == frame.width or row[end] in following)
    )


class InteractionProbeOracle:
    """Drive and verify one privacy-safe textarea interaction lifecycle."""

    def __init__(self, fixture: ThemeFixture, body: str):
        if re.fullmatch(r"oc2latency[0-9a-f]{32}", body) is None:
            raise ValueError("probe body must use the fixed prefix and a 32-hex nonce")
        self.fixture = fixture
        self._body = body
        self._full_token = body + PROBE_GUARD
        self.failure: Optional[str] = None
        self.workspace_generation: Optional[int] = None
        self.attempt_generation: Optional[int] = None
        self.input_accepted_ms: Optional[float] = None
        self.theme_settled_outcome: Optional[str] = None
        self.interactive_ms: Optional[float] = None
        self.reconciliation_count = 0
        self.verified_reconciliation_count = 0
        self.body_visible = False
        self.guard_sent = False
        self.persistence_verified = False
        self.removal_verified = False
        self.backspace_count = 0
        self.noecho_verified = False
        self._prompt_marker_ms: Optional[float] = None
        self._critical_ready_ms: Optional[float] = None
        self._theme_settled_ms: Optional[float] = None
        self._final_theme_ms: Optional[float] = None
        self._body_send_ready = False
        self._body_sent = False
        self._removal_ready = False
        self._removal_sent = False
        self._original_placeholder: Optional[str] = None
        self._current_frame: Optional[TerminalFrame] = None
        self._current_frame_ms: Optional[float] = None
        self._frame_index = 0
        self._pending_theme_frame: Optional[tuple[int, float, bool]] = None
        self._persistence_deadline: Optional[float] = None
        self._removal_wrong_frame = False

    @property
    def complete(self) -> bool:
        return (
            self.failure is None
            and self.interactive_ms is not None
            and self.persistence_verified
            and self.removal_verified
        )

    @property
    def body_send_ready(self) -> bool:
        return self._body_send_ready and not self._body_sent

    @property
    def removal_ready(self) -> bool:
        return self._removal_ready and not self._removal_sent

    def _generation(self, workspace: object, attempt: object) -> bool:
        if not _safe_integer(workspace) or not _safe_integer(attempt):
            self.failure = "trace_generation_mismatch"
            return False
        assert isinstance(workspace, int) and isinstance(attempt, int)
        if self.workspace_generation is None:
            self.workspace_generation = workspace
            self.attempt_generation = attempt
            return True
        if (workspace, attempt) != (self.workspace_generation, self.attempt_generation):
            self.failure = "trace_generation_mismatch"
            return False
        return True

    def _expected_settle(self, outcome: object) -> bool:
        if self.fixture.kind in ("dark", "light"):
            return outcome == "resolved"
        if self.fixture.kind in ("none", "malformed"):
            return outcome == "fallback-final"
        return outcome in ("resolved", "fallback-final")

    def _require_theme_frame(self, receipt_ms: float, reconciliation: bool) -> None:
        if self._pending_theme_frame is not None:
            self.failure = "theme_reconciliation_overlap"
            return
        self._final_theme_ms = receipt_ms
        self._persistence_deadline = None
        self.persistence_verified = False
        self._removal_ready = False
        self._pending_theme_frame = (self._frame_index + 1, receipt_ms, reconciliation)

    def observe_trace(self, record: dict[str, object], receipt_ms: float) -> None:
        if self.failure is not None:
            return
        event = record["event"]
        if event not in TRACE_MARKERS:
            return
        if not self._generation(record["workspaceGeneration"], record["attemptGeneration"]):
            return
        if event == "prompt.mounted":
            self._prompt_marker_ms = receipt_ms
            placeholder = _prompt_placeholder(self._current_frame) if self._current_frame is not None else None
            if placeholder is not None:
                self._original_placeholder = placeholder
                self._body_send_ready = True
            return
        if event == "bootstrap.critical.ready":
            self._critical_ready_ms = receipt_ms
            return
        if event == "input.accepted":
            if not self._body_sent:
                self.failure = "probe_input_accepted_before_body"
            elif self.input_accepted_ms is not None:
                self.failure = "trace_duplicate_marker"
            else:
                self.input_accepted_ms = receipt_ms
            return
        if event == "theme.settled":
            outcome = record.get("outcome")
            if not self._expected_settle(outcome):
                self.failure = "theme_settled_outcome_mismatch"
                return
            self.theme_settled_outcome = str(outcome)
            self._theme_settled_ms = receipt_ms
            if self.fixture.kind != "late" or outcome == "resolved":
                self._require_theme_frame(receipt_ms, False)
            return
        if event == "theme.reconciled":
            if self._theme_settled_ms is None:
                self.failure = "theme_reconciled_before_settled"
                return
            if self._removal_sent:
                self.failure = "theme_reconciled_after_probe_removal"
                return
            self.reconciliation_count += 1
            self._require_theme_frame(receipt_ms, True)

    def mark_body_sent(self) -> bytes:
        if not self.body_send_ready:
            raise RuntimeError("probe body is not ready")
        if not self.noecho_verified:
            raise RuntimeError("probe terminal no-echo state is not verified")
        self._body_sent = True
        return self._body.encode("ascii")

    def confirm_noecho(self) -> None:
        if self._body_sent:
            raise RuntimeError("probe body was already sent")
        self.noecho_verified = True

    def guard_ready(self) -> bool:
        return (
            self.failure is None
            and self.body_visible
            and self.input_accepted_ms is not None
            and self._critical_ready_ms is not None
            and self._theme_settled_ms is not None
            and not self.guard_sent
        )

    def mark_guard_sent(self) -> bytes:
        if not self.guard_ready():
            raise RuntimeError("probe guard is not ready")
        self.guard_sent = True
        return PROBE_GUARD.encode("ascii")

    def _start_persistence(self, _receipt_ms: float) -> None:
        if (
            self.interactive_ms is None
            or self._final_theme_ms is None
            or self._pending_theme_frame is not None
            or self._persistence_deadline is not None
            or self.persistence_verified
        ):
            return
        self._persistence_deadline = time.monotonic() + PROBE_PERSISTENCE_SECONDS

    def observe_frame(self, frame: TerminalFrame, receipt_ms: float) -> None:
        if self.failure is not None:
            return
        self._frame_index += 1
        self._current_frame = frame
        self._current_frame_ms = receipt_ms
        placeholder = _prompt_placeholder(frame)
        if not self._body_sent and self._prompt_marker_ms is not None and placeholder is not None:
            self._original_placeholder = placeholder
            self._body_send_ready = True
        if not self._body_sent:
            return

        body_here = _textarea_has(frame, self._body, (" ", PROBE_GUARD))
        full_here = _textarea_has(frame, self._full_token)
        if self._removal_sent:
            if self._original_placeholder is not None and placeholder == self._original_placeholder:
                self.removal_verified = True
                self._removal_wrong_frame = False
            elif not body_here and not full_here:
                self._removal_wrong_frame = True
            return

        if body_here:
            self.body_visible = True
        elif self.body_visible:
            self.failure = (
                "probe_erased_during_persistence"
                if self._persistence_deadline is not None or self.interactive_ms is not None
                else "probe_erased_before_ready"
            )
            return

        if (
            self.guard_sent
            and full_here
            and self.input_accepted_ms is not None
            and self._critical_ready_ms is not None
            and self._theme_settled_ms is not None
            and self.interactive_ms is None
        ):
            self.interactive_ms = max(
                receipt_ms,
                self.input_accepted_ms,
                self._critical_ready_ms,
                self._theme_settled_ms,
            )

        if self._pending_theme_frame is not None and self.interactive_ms is not None:
            required_index, marker_ms, reconciliation = self._pending_theme_frame
            if self._frame_index >= required_index:
                if not full_here:
                    self.failure = "probe_erased_during_persistence"
                    return
                self._pending_theme_frame = None
                if reconciliation:
                    self.verified_reconciliation_count += 1
                self._start_persistence(max(marker_ms, receipt_ms))
        elif self.interactive_ms is not None and self._final_theme_ms is not None:
            self._start_persistence(receipt_ms)

    def next_deadline(self) -> Optional[float]:
        return self._persistence_deadline

    def advance(self, now: float) -> None:
        if self.failure is not None or self._persistence_deadline is None or now < self._persistence_deadline:
            return
        self._persistence_deadline = None
        if self._current_frame is None or not _textarea_has(self._current_frame, self._full_token):
            self.failure = "probe_erased_during_persistence"
            return
        self.persistence_verified = True
        self._removal_ready = True

    def mark_removal_sent(self) -> bytes:
        if not self.removal_ready:
            raise RuntimeError("probe removal is not ready")
        self._removal_sent = True
        self.backspace_count = len(self._full_token)
        return b"\x7f" * self.backspace_count

    def timeout_failure(self) -> str:
        if not self._body_sent or not self.body_visible:
            return "timeout_probe_body_frame"
        if self.input_accepted_ms is None:
            return "timeout_input_accepted"
        if self.fixture.kind == "late" and self.theme_settled_outcome == "fallback-final":
            if self.reconciliation_count == 0 or self.verified_reconciliation_count == 0:
                return "timeout_theme_reconciled"
        if self.interactive_ms is None:
            return "timeout_interactive_frame"
        if self._pending_theme_frame is not None:
            return "timeout_theme_reconciled"
        if not self._removal_sent or not self.removal_verified:
            return "probe_original_content_mismatch" if self._removal_wrong_frame else "timeout_probe_removal"
        return "startup_timeout"


class StartupMilestoneOracle:
    """Correlate receipt-clock markers with current committed terminal cells."""

    def __init__(self, prompt_matcher: FrameMatcher, shell_matcher: Optional[FrameMatcher] = None):
        self.prompt_matcher = prompt_matcher
        self.shell_matcher = shell_matcher
        self.first_frame_ms: Optional[float] = None
        self.shell_ms: Optional[float] = None
        self.prompt_ms: Optional[float] = None
        self.critical_ready_ms: Optional[float] = None
        self.theme_settled_ms: Optional[float] = None
        self.theme_settled_outcome: Optional[str] = None
        self.workspace_generation: Optional[int] = None
        self.attempt_generation: Optional[int] = None
        self.failure: Optional[str] = None
        self._current_frame: Optional[TerminalFrame] = None
        self._current_frame_ms: Optional[float] = None
        self._shell_marker_ms: Optional[float] = None
        self._prompt_marker_ms: Optional[float] = None

    @property
    def complete(self) -> bool:
        return (
            self.failure is None
            and self.first_frame_ms is not None
            and self.prompt_ms is not None
            and self.critical_ready_ms is not None
            and self.theme_settled_ms is not None
        )

    def _generation(self, workspace: object, attempt: object) -> bool:
        if not _safe_integer(workspace) or not _safe_integer(attempt):
            self.failure = "trace_generation_mismatch"
            return False
        assert isinstance(workspace, int) and isinstance(attempt, int)
        if self.workspace_generation is None:
            self.workspace_generation = workspace
            self.attempt_generation = attempt
            return True
        if (workspace, attempt) != (self.workspace_generation, self.attempt_generation):
            self.failure = "trace_generation_mismatch"
            return False
        return True

    def observe_frame(self, frame: TerminalFrame, receipt_ms: float) -> None:
        if self.failure is not None:
            return
        self._current_frame = frame
        self._current_frame_ms = receipt_ms
        if _frame_has_fatal(frame):
            self.failure = "terminal_fatal_diagnostic"
            return
        if self.first_frame_ms is None and _valid_first_frame(frame):
            self.first_frame_ms = receipt_ms
        if self.shell_ms is None and self._shell_marker_ms is not None and self.shell_matcher is not None:
            if self.shell_matcher(frame):
                self.shell_ms = max(self._shell_marker_ms, receipt_ms)
        if self.prompt_ms is None and self._prompt_marker_ms is not None and self.prompt_matcher(frame):
            self.prompt_ms = max(self._prompt_marker_ms, receipt_ms)

    def observe_shell_drawn(self, workspace: int, attempt: int, receipt_ms: float) -> None:
        """Pair the future shell marker without accepting it in the Slice 1 parser."""

        if self.failure is not None or not self._generation(workspace, attempt):
            return
        if self._shell_marker_ms is not None:
            self.failure = "trace_duplicate_marker"
            return
        self._shell_marker_ms = receipt_ms
        if (
            self.shell_matcher is not None
            and self._current_frame is not None
            and self._current_frame_ms is not None
            and self.shell_matcher(self._current_frame)
        ):
            self.shell_ms = max(receipt_ms, self._current_frame_ms)

    def observe_trace(self, record: dict[str, object], receipt_ms: float) -> None:
        if self.failure is not None:
            return
        event = record["event"]
        if event not in TRACE_MARKERS:
            return
        workspace = record["workspaceGeneration"]
        attempt = record["attemptGeneration"]
        if not self._generation(workspace, attempt):
            return
        if event == "prompt.mounted":
            if self._prompt_marker_ms is not None:
                self.failure = "trace_duplicate_marker"
                return
            self._prompt_marker_ms = receipt_ms
            if (
                self._current_frame is not None
                and self._current_frame_ms is not None
                and self.prompt_matcher(self._current_frame)
            ):
                self.prompt_ms = max(receipt_ms, self._current_frame_ms)
        elif event == "bootstrap.critical.ready":
            if self.critical_ready_ms is not None:
                self.failure = "trace_duplicate_marker"
                return
            self.critical_ready_ms = receipt_ms
        elif event == "theme.settled":
            if self.theme_settled_ms is not None:
                self.failure = "trace_duplicate_marker"
                return
            self.theme_settled_ms = receipt_ms
            self.theme_settled_outcome = str(record["outcome"])

    def timeout_failure(self, screen: TerminalScreen) -> str:
        if screen.synchronized:
            return "terminal_desynchronized"
        if self.first_frame_ms is None:
            return "timeout_first_frame"
        if self._prompt_marker_ms is None:
            return "timeout_prompt_marker"
        if self.prompt_ms is None:
            return "timeout_prompt_frame"
        if self.critical_ready_ms is None:
            return "timeout_critical_ready"
        if self.theme_settled_ms is None:
            return "timeout_theme_settled"
        return "startup_timeout"


TERMINAL_ENV_KEYS = frozenset(
    (
        "ALACRITTY_LOG", "ALACRITTY_SOCKET", "COLORTERM", "MOSH_CONNECTION",
        "OPENTUI_FORCE_EXPLICIT_WIDTH", "OPENTUI_FORCE_NOZWJ", "OPENTUI_FORCE_UNICODE",
        "OPENTUI_FORCE_WCWIDTH", "OPENTUI_GRAPHICS", "OPENTUI_NOTIFICATIONS",
        "OPENTUI_NOTIFICATION_PROTOCOL", "OTUI_DUMP_CAPTURES", "OTUI_NO_NATIVE_RENDER",
        "OTUI_DEBUG", "OTUI_OVERRIDE_STDOUT", "OTUI_SHOW_STATS", "OTUI_TREE_SITTER_WORKER_PATH",
        "OTUI_USE_ALTERNATE_SCREEN", "OTUI_USE_CONSOLE", "SHOW_CONSOLE", "SSH_CLIENT",
        "SSH_CONNECTION", "SSH_TTY",
        "STY", "TERM", "TERM_FEATURES", "TERM_PROGRAM", "TERM_PROGRAM_VERSION",
        "TERMUX_VERSION", "TMUX", "TMUX_PANE", "VHS_RECORD", "WSL_DISTRO_NAME",
        "WSL_INTEROP", "WT_SESSION",
    )
)


def percentile(values: Sequence[float], fraction: float) -> float:
    ordered = sorted(values)
    index = (len(ordered) - 1) * fraction
    low = int(index)
    high = min(low + 1, len(ordered) - 1)
    weight = index - low
    return ordered[low] * (1 - weight) + ordered[high] * weight


def _canonical_json_bytes(value: object, final_newline: bool = True) -> bytes:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return encoded + (b"\n" if final_newline else b"")


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _bounded_ascii(value: object, maximum: int) -> bool:
    return (
        isinstance(value, str)
        and 0 < len(value.encode("utf-8")) <= maximum
        and re.fullmatch(r"[ -~]+", value) is not None
    )


def _valid_artifact_name(value: object) -> bool:
    return (
        _bounded_ascii(value, MAX_ARTIFACT_NAME_BYTES)
        and isinstance(value, str)
        and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", value) is not None
    )


def _valid_object_id(value: object) -> bool:
    return isinstance(value, str) and re.fullmatch(r"(?:[0-9a-f]{40}|[0-9a-f]{64})", value) is not None


def _valid_sha256(value: object) -> bool:
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) is not None


def _stable_file_identity(value: os.stat_result) -> StableFileIdentity:
    return StableFileIdentity(
        device=value.st_dev,
        inode=value.st_ino,
        mode=value.st_mode,
        links=value.st_nlink,
        size=value.st_size,
        modified_ns=value.st_mtime_ns,
        changed_ns=value.st_ctime_ns,
    )


def _lstat_regular(path: Path, executable: bool = False) -> StableFileIdentity:
    try:
        value = path.lstat()
    except OSError:
        raise ArtifactFailure("artifact_file_unavailable") from None
    if stat.S_ISLNK(value.st_mode):
        raise ArtifactFailure("artifact_symlink")
    if not stat.S_ISREG(value.st_mode):
        raise ArtifactFailure("artifact_not_regular")
    if value.st_nlink != 1:
        raise ArtifactFailure("artifact_file_not_unique")
    if executable and (stat.S_IMODE(value.st_mode) & 0o111 == 0 or not os.access(path, os.X_OK)):
        raise ArtifactFailure("artifact_binary_not_executable")
    return _stable_file_identity(value)


def _read_stable_file(path: Path, executable: bool = False) -> tuple[bytes, StableFileIdentity]:
    before = _lstat_regular(path, executable)
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError:
        raise ArtifactFailure("artifact_file_unavailable") from None
    try:
        opened_before = _stable_file_identity(os.fstat(descriptor))
        if opened_before != before:
            raise ArtifactFailure("artifact_identity_changed")
        chunks = []
        while True:
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                break
            chunks.append(chunk)
        opened_after = _stable_file_identity(os.fstat(descriptor))
    finally:
        os.close(descriptor)
    after = _lstat_regular(path, executable)
    if opened_before != opened_after or opened_after != after:
        raise ArtifactFailure("artifact_identity_changed")
    return b"".join(chunks), after


def _unique_artifact_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ArtifactFailure("artifact_manifest_duplicate_key")
        result[key] = value
    return result


def _freeze_json(value: object) -> object:
    if isinstance(value, dict):
        return MappingProxyType({key: _freeze_json(item) for key, item in value.items()})
    if isinstance(value, list):
        return tuple(_freeze_json(item) for item in value)
    return value


def _exact_dict(value: object, keys: set[str]) -> bool:
    return isinstance(value, dict) and set(value) == keys and all(isinstance(key, str) for key in value)


def _valid_host_record(value: object, include_bun: bool) -> bool:
    keys = {"os", "os_release", "arch", "python_version"}
    if include_bun:
        keys.add("bun_version")
    return _exact_dict(value, keys) and all(
        _bounded_ascii(item, 128) for item in value.values()  # type: ignore[union-attr]
    )


def _validate_artifact_manifest(value: object) -> dict[str, object]:
    top_keys = {"schema", "version", "name", "source", "binary", "build", "capabilities", "build_host", "tooling"}
    if not _exact_dict(value, top_keys):
        raise ArtifactFailure("artifact_manifest_schema")
    assert isinstance(value, dict)
    if value["schema"] != ARTIFACT_SCHEMA or type(value["version"]) is not int or value["version"] != ARTIFACT_VERSION:
        raise ArtifactFailure("artifact_manifest_schema")
    if not _valid_artifact_name(value["name"]):
        raise ArtifactFailure("artifact_manifest_schema")

    source = value["source"]
    if not _exact_dict(source, {"revision", "tree", "pr_base_revision", "clean"}):
        raise ArtifactFailure("artifact_manifest_schema")
    assert isinstance(source, dict)
    if (
        not _valid_object_id(source["revision"])
        or not _valid_object_id(source["tree"])
        or not _valid_object_id(source["pr_base_revision"])
        or source["clean"] is not True
    ):
        raise ArtifactFailure("artifact_manifest_schema")

    binary = value["binary"]
    if not _exact_dict(binary, {"path", "sha256", "size_bytes", "mode"}):
        raise ArtifactFailure("artifact_manifest_schema")
    assert isinstance(binary, dict)
    if (
        binary["path"] != ARTIFACT_BINARY
        or not _valid_sha256(binary["sha256"])
        or type(binary["size_bytes"]) is not int
        or not 0 <= binary["size_bytes"] <= MAX_SAFE_INTEGER
        or type(binary["mode"]) is not int
        or not 0 <= binary["mode"] <= 0o777
        or binary["mode"] & 0o111 == 0
    ):
        raise ArtifactFailure("artifact_manifest_schema")

    build = value["build"]
    if not _exact_dict(build, {"command"}) or build["command"] != "bun run dev:build":  # type: ignore[index]
        raise ArtifactFailure("artifact_manifest_schema")
    capabilities = value["capabilities"]
    if not _exact_dict(capabilities, {"shell"}) or capabilities["shell"] not in ("unavailable", "required"):  # type: ignore[index]
        raise ArtifactFailure("artifact_manifest_schema")
    if not _valid_host_record(value["build_host"], True):
        raise ArtifactFailure("artifact_manifest_schema")
    tooling = value["tooling"]
    tool_keys = {"tui_benchmark_sha256", "tui_probe_sha256", "terminal_screen_sha256"}
    if not _exact_dict(tooling, tool_keys) or not all(_valid_sha256(item) for item in tooling.values()):  # type: ignore[union-attr]
        raise ArtifactFailure("artifact_manifest_schema")
    return value


def _require_plain_directory(path: Path, code: str) -> None:
    try:
        value = path.lstat()
    except OSError:
        raise ArtifactFailure(code) from None
    if stat.S_ISLNK(value.st_mode) or not stat.S_ISDIR(value.st_mode):
        raise ArtifactFailure(code)


def load_artifact(root: Path) -> Artifact:
    root = Path(root).absolute()
    _require_plain_directory(root, "artifact_root_invalid")
    try:
        if {item.name for item in root.iterdir()} != {ARTIFACT_MANIFEST, ARTIFACT_SIDECAR, "bin"}:
            raise ArtifactFailure("artifact_layout_invalid")
    except OSError:
        raise ArtifactFailure("artifact_layout_invalid") from None
    bin_directory = root / "bin"
    _require_plain_directory(bin_directory, "artifact_layout_invalid")
    try:
        if {item.name for item in bin_directory.iterdir()} != {"oc2"}:
            raise ArtifactFailure("artifact_layout_invalid")
    except OSError:
        raise ArtifactFailure("artifact_layout_invalid") from None

    manifest_bytes, _ = _read_stable_file(root / ARTIFACT_MANIFEST)
    sidecar_bytes, _ = _read_stable_file(root / ARTIFACT_SIDECAR)
    try:
        manifest = json.loads(
            manifest_bytes.decode("utf-8", errors="strict"),
            object_pairs_hook=_unique_artifact_object,
            parse_constant=lambda _: (_ for _ in ()).throw(ArtifactFailure("artifact_manifest_json")),
        )
    except ArtifactFailure:
        raise
    except (UnicodeDecodeError, json.JSONDecodeError, TypeError, ValueError):
        raise ArtifactFailure("artifact_manifest_json") from None
    manifest = _validate_artifact_manifest(manifest)
    if manifest_bytes != _canonical_json_bytes(manifest):
        raise ArtifactFailure("artifact_manifest_not_canonical")
    artifact_id = _sha256_bytes(manifest_bytes)
    expected_sidecar = f"{artifact_id}  {ARTIFACT_MANIFEST}\n".encode("ascii")
    if sidecar_bytes != expected_sidecar:
        raise ArtifactFailure("artifact_sidecar_mismatch")

    binary_path = root / ARTIFACT_BINARY
    binary_bytes, binary_identity = _read_stable_file(binary_path, executable=True)
    binary = manifest["binary"]
    assert isinstance(binary, dict)
    if (
        len(binary_bytes) != binary["size_bytes"]
        or _sha256_bytes(binary_bytes) != binary["sha256"]
        or stat.S_IMODE(binary_identity.mode) != binary["mode"]
    ):
        raise ArtifactFailure("artifact_binary_mismatch")
    return Artifact(
        root=root,
        binary_path=binary_path,
        manifest=_freeze_json(manifest),  # type: ignore[arg-type]
        artifact_id=artifact_id,
        binary_identity=binary_identity,
    )


def _git_output(*arguments: str) -> str:
    try:
        result = subprocess.run(
            ["git", *arguments],
            cwd=REPO_ROOT,
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        raise ArtifactFailure("artifact_git_identity_failed") from None
    if result.stderr:
        raise ArtifactFailure("artifact_git_identity_failed")
    return result.stdout.strip()


def _git_source_identity() -> dict[str, object]:
    revision = _git_output("rev-parse", "--verify", "HEAD")
    tree = _git_output("rev-parse", "--verify", "HEAD^{tree}")
    pr_base = _git_output("merge-base", "HEAD", "origin/main")
    if not all(_valid_object_id(item) for item in (revision, tree, pr_base)):
        raise ArtifactFailure("artifact_git_identity_failed")
    status = _git_output("status", "--porcelain=v1", "--untracked-files=all")
    if status:
        raise ArtifactFailure("artifact_worktree_dirty")
    return {"revision": revision, "tree": tree, "pr_base_revision": pr_base, "clean": True}


def _host_record(include_bun: bool) -> dict[str, str]:
    record = {
        "os": sys.platform,
        "os_release": platform.release(),
        "arch": platform.machine(),
        "python_version": platform.python_version(),
    }
    if include_bun:
        try:
            result = subprocess.run(
                ["bun", "--version"],
                check=True,
                capture_output=True,
                text=True,
                timeout=10,
            )
        except (OSError, subprocess.SubprocessError):
            raise ArtifactFailure("artifact_runtime_identity_failed") from None
        if result.stderr:
            raise ArtifactFailure("artifact_runtime_identity_failed")
        record["bun_version"] = result.stdout.strip()
    if not _valid_host_record(record, include_bun):
        raise ArtifactFailure("artifact_runtime_identity_failed")
    return record


def _tooling_hashes() -> dict[str, str]:
    try:
        return {
            "tui_benchmark_sha256": _sha256_file(Path(__file__).resolve()),
            "tui_probe_sha256": _sha256_file(Path(__file__).with_name("tui_probe.py").resolve()),
            "terminal_screen_sha256": _sha256_file(Path(__file__).with_name("terminal_screen.py").resolve()),
        }
    except OSError:
        raise ArtifactFailure("artifact_tooling_identity_failed") from None


def _write_exclusive(path: Path, content: bytes, mode: int = 0o600) -> None:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0)
    descriptor = os.open(path, flags, mode)
    try:
        view = memoryview(content)
        while view:
            written = os.write(descriptor, view)
            if written <= 0:
                raise OSError(errno.EIO, "exclusive write made no progress")
            view = view[written:]
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_CLOEXEC", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _copy_preserved_binary(source: Path, destination: Path) -> tuple[str, int, int, StableFileIdentity]:
    source_before = _lstat_regular(source, executable=True)
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        source_fd = os.open(source, flags)
    except OSError:
        raise ArtifactFailure("artifact_binary_unavailable") from None
    destination_fd: Optional[int] = None
    digest = hashlib.sha256()
    size = 0
    mode = stat.S_IMODE(source_before.mode) & 0o777
    try:
        opened_before = _stable_file_identity(os.fstat(source_fd))
        if opened_before != source_before:
            raise ArtifactFailure("artifact_identity_changed")
        destination_fd = os.open(
            destination,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0),
            mode,
        )
        while True:
            chunk = os.read(source_fd, 1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
            size += len(chunk)
            view = memoryview(chunk)
            while view:
                written = os.write(destination_fd, view)
                if written <= 0:
                    raise OSError(errno.EIO, "binary copy made no progress")
                view = view[written:]
        os.fchmod(destination_fd, mode)
        os.fsync(destination_fd)
        opened_after = _stable_file_identity(os.fstat(source_fd))
    finally:
        os.close(source_fd)
        if destination_fd is not None:
            os.close(destination_fd)
    source_after = _lstat_regular(source, executable=True)
    if opened_before != opened_after or opened_after != source_after or size != source_after.size:
        raise ArtifactFailure("artifact_identity_changed")
    return digest.hexdigest(), size, mode, source_after


def _remove_partial_output(path: Path, expected: tuple[int, int]) -> None:
    try:
        value = path.lstat()
    except FileNotFoundError:
        return
    if (value.st_dev, value.st_ino) != expected:
        raise ArtifactFailure("artifact_partial_cleanup_failed")
    if stat.S_ISDIR(value.st_mode) and not stat.S_ISLNK(value.st_mode):
        shutil.rmtree(path)
    else:
        raise ArtifactFailure("artifact_partial_cleanup_failed")


def preserve_artifact(
    name: str,
    binary: Path,
    build_command: str,
    shell_capability: str,
    output: Path,
) -> Artifact:
    if not _valid_artifact_name(name) or build_command != "bun run dev:build":
        raise ArtifactFailure("artifact_argument_invalid")
    if shell_capability not in ("unavailable", "required"):
        raise ArtifactFailure("artifact_argument_invalid")
    output = Path(output)
    if output.exists() or output.is_symlink():
        raise ArtifactFailure("artifact_output_exists")
    _require_plain_directory(output.parent, "artifact_output_parent_invalid")
    source_before = _git_source_identity()
    tooling = _tooling_hashes()
    build_host = _host_record(True)
    created = False
    output_identity: Optional[tuple[int, int]] = None
    try:
        os.mkdir(output, 0o700)
        created = True
        output_stat = output.lstat()
        output_identity = (output_stat.st_dev, output_stat.st_ino)
        os.mkdir(output / "bin", 0o700)
        binary_hash, binary_size, binary_mode, _ = _copy_preserved_binary(Path(binary), output / ARTIFACT_BINARY)
        source_after = _git_source_identity()
        if source_before != source_after or tooling != _tooling_hashes():
            raise ArtifactFailure("artifact_identity_changed")
        manifest = {
            "schema": ARTIFACT_SCHEMA,
            "version": ARTIFACT_VERSION,
            "name": name,
            "source": source_before,
            "binary": {
                "path": ARTIFACT_BINARY,
                "sha256": binary_hash,
                "size_bytes": binary_size,
                "mode": binary_mode,
            },
            "build": {"command": build_command},
            "capabilities": {"shell": shell_capability},
            "build_host": build_host,
            "tooling": tooling,
        }
        manifest_bytes = _canonical_json_bytes(manifest)
        manifest_hash = _sha256_bytes(manifest_bytes)
        _write_exclusive(output / ARTIFACT_MANIFEST, manifest_bytes)
        _write_exclusive(
            output / ARTIFACT_SIDECAR,
            f"{manifest_hash}  {ARTIFACT_MANIFEST}\n".encode("ascii"),
        )
        _fsync_directory(output / "bin")
        _fsync_directory(output)
        artifact = load_artifact(output)
        if artifact.artifact_id != manifest_hash or source_before != _git_source_identity():
            raise ArtifactFailure("artifact_identity_changed")
        return artifact
    except BaseException as error:
        if created:
            try:
                assert output_identity is not None
                _remove_partial_output(output, output_identity)
            except BaseException:
                raise ArtifactFailure("artifact_partial_cleanup_failed") from error
        if isinstance(error, ArtifactFailure):
            raise
        if isinstance(error, FileExistsError):
            raise ArtifactFailure("artifact_output_exists") from None
        raise ArtifactFailure("artifact_preserve_failed") from None


def prepare_state(root: Path) -> None:
    for name in ("home", "data", "cache", "config", "tmp"):
        (root / name).mkdir(parents=True, exist_ok=True)


def child_environment(state: Path) -> dict[str, str]:
    env = os.environ.copy()
    for key in tuple(env):
        if (
            key in TERMINAL_ENV_KEYS
            or key in TRACE_ENV_KEYS
            or key in ("OC2_TUI_STARTUP_PROFILE_WORKER", SUPERVISION_ENV)
            or key.startswith("ZELLIJ")
        ):
            env.pop(key)
    env.update(CONTROLLED_ENV)
    env.update(
        {
            "HOME": str(state / "home"),
            "XDG_DATA_HOME": str(state / "data"),
            "XDG_CACHE_HOME": str(state / "cache"),
            "XDG_CONFIG_HOME": str(state / "config"),
            "TMPDIR": str(state / "tmp"),
            "TMP": str(state / "tmp"),
            "TEMP": str(state / "tmp"),
        }
    )
    return env


def _empty_result(failure: str, pty_handshake_ok: bool, run_id: str) -> dict[str, Any]:
    return {
        "first_byte_ms": None,
        "ready_ms": None,
        "ttfd_ms": None,
        "bytes_until_ready": 0,
        "timed_out": True,
        "pty_handshake_ok": pty_handshake_ok,
        "first_frame_ms": None,
        "shell_ms": None,
        "prompt_ms": None,
        "critical_ready_ms": None,
        "theme_settled_ms": None,
        "theme_settled_outcome": None,
        "interactive_ms": None,
        "input_accepted_ms": None,
        "run_id": run_id,
        "workspace_generation": None,
        "attempt_generation": None,
        "trace_records": 0,
        "foreground_query_count": 0,
        "background_query_count": 0,
        "foreground_response_count": 0,
        "background_response_count": 0,
        "theme_reconciliation_count": 0,
        "probe_body_visible": False,
        "probe_noecho_verified": False,
        "probe_guard_sent": False,
        "probe_persistence_verified": False,
        "probe_removal_verified": False,
        "probe_backspace_count": 0,
        "probe_verified_reconciliation_count": 0,
        "theme_activity_verified": False,
        "phases": [],
        "rpc": [],
        "failure": failure,
    }


def _open_trace_pipe(env: dict[str, str], run_id: str) -> tuple[int, int]:
    read_fd, write_fd = os.pipe()
    try:
        if read_fd < 3 or write_fd < 3 or read_fd == write_fd:
            raise OSError(errno.EBADF, "trace pipe descriptors are not isolated")
        os.set_inheritable(read_fd, False)
        os.set_inheritable(write_fd, True)
        if os.get_inheritable(read_fd) or not os.get_inheritable(write_fd):
            raise OSError(errno.EBADF, "trace pipe inheritance is invalid")
        env["OC2_TUI_STARTUP_PROFILE"] = "1"
        env["OC2_TUI_STARTUP_PROFILE_FD"] = str(write_fd)
        env["OC2_RUN_ID"] = run_id
        return read_fd, write_fd
    except BaseException:
        try:
            os.close(read_fd)
        finally:
            os.close(write_fd)
        raise


def _read_trace(fd: int) -> bytes:
    while True:
        try:
            return os.read(fd, 65536)
        except InterruptedError:
            continue


class ChildExitObserver:
    """Observe leader exit and Darwin descendants without reaping them."""

    def __init__(self, pid: int):
        self.pid = pid
        self._exited = False
        self._kqueue: Any = None
        self._tracked_pids: set[int] = set()
        self.tracking_failed = False
        self.available = hasattr(os, "waitid") and hasattr(os, "WNOWAIT")
        if not self.available and hasattr(select, "kqueue"):
            queue = None
            try:
                queue = select.kqueue()
                flags = select.KQ_EV_ADD | select.KQ_EV_ENABLE | select.KQ_EV_CLEAR
                exit_note = select.KQ_NOTE_EXIT
                tracking_notes = exit_note
                if hasattr(select, "KQ_NOTE_FORK") and hasattr(select, "KQ_NOTE_TRACK"):
                    tracking_notes |= select.KQ_NOTE_FORK | select.KQ_NOTE_TRACK
                try:
                    queue.control(
                        [select.kevent(pid, filter=select.KQ_FILTER_PROC, flags=flags, fflags=tracking_notes)],
                        0,
                        0,
                    )
                except OSError as error:
                    unsupported = (errno.EINVAL, getattr(errno, "ENOTSUP", errno.EINVAL))
                    if tracking_notes == exit_note or error.errno not in unsupported:
                        raise
                    self.tracking_failed = True
                    queue.control(
                        [select.kevent(pid, filter=select.KQ_FILTER_PROC, flags=flags, fflags=exit_note)],
                        0,
                        0,
                    )
                self._kqueue = queue
                self.available = True
            except OSError as error:
                if error.errno == errno.ESRCH:
                    self._exited = True
                    self.available = True
                else:
                    self.tracking_failed = True
                try:
                    if queue is not None:
                        queue.close()
                except OSError:
                    pass
            except ValueError:
                self.tracking_failed = True
                try:
                    if queue is not None:
                        queue.close()
                except OSError:
                    pass

    def _drain_kqueue(self) -> None:
        if self._kqueue is None:
            return
        try:
            while True:
                events = self._kqueue.control(None, 64, 0)
                if not events:
                    break
                for event in events:
                    if event.fflags & getattr(select, "KQ_NOTE_TRACKERR", 0):
                        self.tracking_failed = True
                    if event.fflags & getattr(select, "KQ_NOTE_CHILD", 0):
                        self._tracked_pids.add(event.ident)
                    if event.ident == self.pid and event.fflags & select.KQ_NOTE_EXIT:
                        self._exited = True
        except OSError:
            self.tracking_failed = True

    def tracked_pids(self) -> set[int]:
        self._drain_kqueue()
        return set(self._tracked_pids)

    def exited(self) -> bool:
        self._drain_kqueue()
        if self._exited:
            return True
        waitid = getattr(os, "waitid", None)
        wnowait = getattr(os, "WNOWAIT", None)
        if waitid is not None and wnowait is not None:
            try:
                self._exited = waitid(os.P_PID, self.pid, os.WEXITED | os.WNOHANG | wnowait) is not None
            except ChildProcessError:
                self._exited = True
            except (PermissionError, ProcessLookupError):
                pass
            return self._exited
        return self._exited

    def close(self) -> None:
        if self._kqueue is None:
            return
        try:
            self._kqueue.close()
        except OSError:
            pass
        self._kqueue = None


ProcessIdentity = tuple[int, int, str]


def _numeric_process_table() -> dict[int, tuple[int, int, int, int, str, str]]:
    result = subprocess.run(
        ["ps", "-axo", "pid=,ppid=,pgid=,sess=,uid=,state=,lstart="],
        check=False,
        capture_output=True,
        text=True,
        timeout=0.5,
    )
    if result.returncode != 0:
        raise OSError("numeric process snapshot failed")
    table: dict[int, tuple[int, int, int, int, str, str]] = {}
    for line in result.stdout.splitlines():
        parts = line.split()
        if len(parts) < 11:
            raise OSError("numeric process snapshot was malformed")
        try:
            pid, parent, group, session, uid = (int(part) for part in parts[:5])
        except ValueError:
            raise OSError("numeric process snapshot was malformed") from None
        if pid <= 0 or parent < 0 or group < 0 or session < 0:
            raise OSError("numeric process snapshot was malformed")
        table[pid] = (parent, group, session, uid, parts[5], " ".join(parts[6:]))
    return table


def _process_identity(pid: int) -> Optional[ProcessIdentity]:
    current = _numeric_process_table().get(pid)
    if current is None or current[4].startswith("Z") or current[3] != os.getuid():
        return None
    return current[1], current[2], current[5]


def _linux_process_environment(pid: int) -> tuple[bytes, ...]:
    path = Path("/proc") / str(pid) / "environ"
    try:
        if path.stat().st_uid != os.getuid():
            return ()
        return tuple(item for item in path.read_bytes().split(b"\0") if item)
    except FileNotFoundError:
        return ()
    except PermissionError as error:
        raise OSError("same-UID process environment was unreadable") from error


def _darwin_process_environment(pid: int) -> tuple[bytes, ...]:
    # KERN_PROCARGS2 is the stdlib-accessible equivalent when Darwin ps hides env.
    libc = ctypes.CDLL(None, use_errno=True)
    sysctl = libc.sysctl
    sysctl.argtypes = [
        ctypes.POINTER(ctypes.c_int),
        ctypes.c_uint,
        ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_size_t),
        ctypes.c_void_p,
        ctypes.c_size_t,
    ]
    mib = (ctypes.c_int * 3)(1, 49, pid)  # CTL_KERN, KERN_PROCARGS2, pid
    size = ctypes.c_size_t()
    if sysctl(mib, 3, None, ctypes.byref(size), None, 0) != 0:
        error = ctypes.get_errno()
        if error in (errno.ESRCH, errno.EINVAL):
            return ()
        raise OSError(error, "same-UID process environment size was unreadable")
    data = ctypes.create_string_buffer(size.value)
    if sysctl(mib, 3, data, ctypes.byref(size), None, 0) != 0:
        error = ctypes.get_errno()
        if error in (errno.ESRCH, errno.EINVAL):
            return ()
        raise OSError(error, "same-UID process environment was unreadable")
    raw = data.raw[: size.value]
    if len(raw) < struct.calcsize("i"):
        raise OSError("Darwin process arguments were truncated")
    argc = struct.unpack_from("i", raw)[0]
    if argc < 0:
        raise OSError("Darwin process argument count was invalid")
    offset = struct.calcsize("i")
    executable_end = raw.find(b"\0", offset)
    if executable_end < 0:
        raise OSError("Darwin process executable was unterminated")
    offset = executable_end + 1
    while offset < len(raw) and raw[offset] == 0:
        offset += 1
    for _ in range(argc):
        end = raw.find(b"\0", offset)
        if end < 0:
            raise OSError("Darwin process argument was unterminated")
        offset = end + 1
    environment: list[bytes] = []
    while offset < len(raw):
        end = raw.find(b"\0", offset)
        if end < 0:
            raise OSError("Darwin process environment was unterminated")
        if end == offset:
            break
        environment.append(raw[offset:end])
        offset = end + 1
    return tuple(environment)


def _token_processes(token: str) -> dict[int, ProcessIdentity]:
    expected = f"{SUPERVISION_ENV}={token}".encode("ascii")
    table = _numeric_process_table()
    matches: dict[int, ProcessIdentity] = {}
    supported = sys.platform == "darwin" or sys.platform.startswith("linux")
    if not supported:
        raise OSError("supervision-token process enumeration is unsupported")
    for pid, (_, group, session, uid, state, birth) in table.items():
        if uid != os.getuid() or pid == os.getpid() or state.startswith("Z"):
            continue
        environment = (
            _darwin_process_environment(pid)
            if sys.platform == "darwin"
            else _linux_process_environment(pid)
        )
        if expected in environment:
            matches[pid] = (group, session, birth)
    return matches


class DescendantSupervisor:
    """Track descendants even when they escape the PTY process group/session."""

    def __init__(self, root_pid: int, interval: float = 0.05):
        self.root_pid = root_pid
        self.interval = interval
        self._records: dict[int, ProcessIdentity] = {}
        self._failed = False
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="tui-descendants", daemon=True)

    def start(self) -> None:
        # Process-table work stays off the receipt-clock milestone loop.
        self._thread.start()

    def _scan(self) -> None:
        try:
            table = _numeric_process_table()
        except (OSError, subprocess.SubprocessError):
            with self._lock:
                self._failed = True
            return
        with self._lock:
            known = {self.root_pid, *self._records}
            changed = True
            while changed:
                changed = False
                for pid, (parent, group, session, _, state, birth) in table.items():
                    if state.startswith("Z"):
                        continue
                    if pid in known or parent not in known:
                        continue
                    known.add(pid)
                    self._records[pid] = (group, session, birth)
                    changed = True
            for pid in tuple(self._records):
                current = table.get(pid)
                if current is not None:
                    self._records[pid] = (current[1], current[2], current[5])

    def _run(self) -> None:
        while not self._stop.is_set():
            self._scan()
            self._stop.wait(self.interval)

    def request_stop(self) -> None:
        self._stop.set()

    def scan_now(self) -> None:
        self._scan()

    def finish(self) -> tuple[dict[int, ProcessIdentity], bool]:
        self.request_stop()
        self._thread.join(0.75)
        if self._thread.is_alive():
            with self._lock:
                self._failed = True
        self._scan()
        with self._lock:
            return dict(self._records), self._failed


def _pid_exists(pid: int) -> bool:
    try:
        waited, _ = os.waitpid(pid, os.WNOHANG)
        if waited == pid:
            return False
    except ChildProcessError:
        pass
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    try:
        if sys.platform.startswith("linux"):
            stat = (Path("/proc") / str(pid) / "stat").read_text(encoding="ascii")
            closing = stat.rfind(")")
            if closing < 0:
                return True
            return stat[closing + 2 : closing + 3] != "Z"
        if sys.platform == "darwin":
            result = subprocess.run(
                ["ps", "-p", str(pid), "-o", "state="],
                check=False,
                capture_output=True,
                text=True,
                timeout=0.2,
            )
            if result.returncode != 0 or not result.stdout.strip():
                return False
            return not result.stdout.strip().startswith("Z")
    except (OSError, subprocess.SubprocessError):
        return True
    return True


def _group_exists(group: int) -> bool:
    try:
        os.killpg(group, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    try:
        return any(
            process_group == group and not state.startswith("Z")
            for _, process_group, _, _, state, _ in _numeric_process_table().values()
        )
    except (OSError, subprocess.SubprocessError):
        return True


def _signal_tracked(records: dict[int, ProcessIdentity], sig: signal.Signals) -> bool:
    ok = True
    own_group = os.getpgrp()
    try:
        table = _numeric_process_table()
    except (OSError, subprocess.SubprocessError):
        return False
    valid: dict[int, ProcessIdentity] = {}
    for pid, identity in records.items():
        current = table.get(pid)
        if current is None:
            continue
        _, group, session, _, state, birth = current
        if state.startswith("Z"):
            continue
        if identity != (group, session, birth):
            ok = False
            continue
        valid[pid] = identity
    groups = {identity[0] for identity in valid.values() if identity[0] > 1 and identity[0] != own_group}
    for group in groups:
        try:
            os.killpg(group, sig)
        except ProcessLookupError:
            pass
        except PermissionError:
            ok = False
    for pid in valid:
        if pid <= 1 or pid == os.getpid():
            ok = False
            continue
        try:
            os.kill(pid, sig)
        except ProcessLookupError:
            pass
        except PermissionError:
            ok = False
    return ok


def _reap_direct_child(pid: Optional[int]) -> None:
    if pid is None:
        return
    try:
        os.waitpid(pid, os.WNOHANG)
    except ChildProcessError:
        pass


def _matching_live_records(records: dict[int, ProcessIdentity]) -> tuple[dict[int, ProcessIdentity], bool]:
    try:
        table = _numeric_process_table()
    except (OSError, subprocess.SubprocessError):
        return {}, False
    live: dict[int, ProcessIdentity] = {}
    proof_ok = True
    for pid, identity in records.items():
        current = table.get(pid)
        if current is None or current[4].startswith("Z"):
            continue
        current_identity = (current[1], current[2], current[5])
        if current_identity != identity:
            proof_ok = False
            continue
        live[pid] = identity
    return live, proof_ok


def _tracked_gone(records: dict[int, ProcessIdentity], reap_pid: Optional[int] = None) -> bool:
    _reap_direct_child(reap_pid)
    live, proof_ok = _matching_live_records(records)
    return proof_ok and not live


def _terminate_records(records: dict[int, ProcessIdentity], reap_pid: Optional[int] = None) -> bool:
    if not records:
        return True
    ok = _signal_tracked(records, signal.SIGTERM)
    deadline = time.monotonic() + 0.35
    while time.monotonic() < deadline:
        if _tracked_gone(records, reap_pid):
            return ok
        time.sleep(0.01)
    ok = _signal_tracked(records, signal.SIGKILL) and ok
    deadline = time.monotonic() + 1.0
    while time.monotonic() < deadline:
        if _tracked_gone(records, reap_pid):
            return ok
        time.sleep(0.01)
    return False


def _cleanup_tracked_descendants(records: dict[int, ProcessIdentity]) -> bool:
    return _terminate_records(records)


def _sanitize_process_identities(value: object) -> dict[int, ProcessIdentity]:
    sanitized: dict[int, ProcessIdentity] = {}
    if not isinstance(value, dict):
        return sanitized
    for pid, identity in value.items():
        if (
            not isinstance(pid, int)
            or isinstance(pid, bool)
            or pid <= 1
            or pid == os.getpid()
            or not isinstance(identity, (tuple, list))
            or len(identity) != 3
        ):
            continue
        group, session, birth = identity
        if (
            not isinstance(group, int)
            or isinstance(group, bool)
            or group <= 1
            or not isinstance(session, int)
            or isinstance(session, bool)
            or session < 0
            or not isinstance(birth, str)
            or not birth
        ):
            continue
        sanitized[pid] = (group, session, birth)
    return sanitized


def _records_live(records: dict[int, ProcessIdentity], reap_pid: Optional[int]) -> bool:
    _reap_direct_child(reap_pid)
    live, proof_ok = _matching_live_records(records)
    return not proof_ok or bool(live)


def _terminate_wave(
    records: dict[int, ProcessIdentity],
    reap_pid: int,
    deadline: float,
) -> bool:
    if not records:
        return True
    ok = _signal_tracked(records, signal.SIGTERM)
    term_deadline = min(deadline, time.monotonic() + 0.08)
    while time.monotonic() < term_deadline:
        if not _records_live(records, reap_pid):
            return ok
        time.sleep(0.005)
    ok = _signal_tracked(records, signal.SIGKILL) and ok
    kill_deadline = min(deadline, time.monotonic() + 0.25)
    while time.monotonic() < kill_deadline:
        if not _records_live(records, reap_pid):
            return ok
        time.sleep(0.005)
    return not _records_live(records, reap_pid) and ok


def _emergency_token_cleanup(
    token: str,
    root_pid: int,
    root_identity: Optional[ProcessIdentity],
    known_records: object = None,
) -> tuple[bool, bool]:
    records = _sanitize_process_identities(known_records)
    root_identity = _sanitize_process_identities({root_pid: root_identity}).get(root_pid)
    enumeration_ok = True
    cleanup_ok = True
    stable_zero = 0
    deadline = time.monotonic() + 3.0
    while time.monotonic() < deadline:
        enumerated = False
        try:
            observed = _sanitize_process_identities(_token_processes(token))
            enumerated = True
        except (OSError, subprocess.SubprocessError):
            observed = {}
            enumeration_ok = False
        records.update(observed)
        if root_identity is not None and (root_pid in observed or (not enumerated and _pid_exists(root_pid))):
            records[root_pid] = root_identity
        if _records_live(records, root_pid):
            stable_zero = 0
            cleanup_ok = _terminate_wave(records, root_pid, deadline) and cleanup_ok
            records, proof_ok = _matching_live_records(records)
            cleanup_ok = proof_ok and cleanup_ok
            continue
        records.clear()
        if enumerated and not observed:
            stable_zero += 1
            if stable_zero >= 2:
                return enumeration_ok, cleanup_ok
        else:
            stable_zero = 0
        time.sleep(0.02)
    return enumeration_ok, cleanup_ok and not _records_live(records, root_pid)


def _terminal_failure(screen: TerminalScreen, eof: bool = False) -> str:
    reason = screen.invalid_reason or ""
    if "synchronized" in reason:
        return "terminal_desynchronized"
    if eof and ("truncated" in reason or "EOF" in reason):
        return "terminal_eof_truncated"
    if reason.startswith("unsupported") or "unsupported" in reason:
        return "terminal_unknown_sequence"
    return "terminal_invalid_sequence"


def _legacy_ttfd_value(output: bytearray, eof: bool = False) -> tuple[Optional[float], bool]:
    match = TTFD.search(output)
    if match is not None:
        try:
            value = float(match.group(1))
        except (OverflowError, ValueError):
            return None, True
        if not math.isfinite(value) or value < 0:
            return None, True
        return value, False
    start = output.find(TTFD_PREFIX)
    if start < 0:
        return None, False
    tail = output[start + len(TTFD_PREFIX) :]
    terminated = eof or len(tail) > 96 or any(marker in tail for marker in (b"\r", b"\n", b"\x1b"))
    return None, terminated


def _probe_terminal_mode_failure(fd: int) -> Optional[str]:
    try:
        attributes = termios.tcgetattr(fd)
    except (OSError, termios.error):
        return "probe_terminal_mode_failed"
    return "probe_terminal_echo_enabled" if attributes[3] & termios.ECHO else None


def _write_probe_actions(fd: int, probe: InteractionProbeOracle) -> Optional[str]:
    if probe.body_send_ready:
        mode_failure = _probe_terminal_mode_failure(fd)
        if mode_failure is not None:
            return mode_failure
        probe.confirm_noecho()
        try:
            _write_pty_input(fd, probe.mark_body_sent())
        except OSError:
            return "probe_input_write_failed"
    if probe.guard_ready():
        mode_failure = _probe_terminal_mode_failure(fd)
        if mode_failure is not None:
            return mode_failure
        try:
            _write_pty_input(fd, probe.mark_guard_sent())
        except OSError:
            return "probe_input_write_failed"
    if probe.removal_ready:
        mode_failure = _probe_terminal_mode_failure(fd)
        if mode_failure is not None:
            return mode_failure
        try:
            _write_pty_input(fd, probe.mark_removal_sent())
        except OSError:
            return "probe_removal_write_failed"
    return None


class TraceEvidence:
    """Retain only ordered, schema-proven phase and RPC timing evidence."""

    def __init__(self):
        self.phases: list[dict[str, object]] = []
        self._rpc: dict[int, dict[str, object]] = {}
        self._rpc_first_sequence: dict[int, int] = {}

    def _rpc_record(self, record: dict[str, object]) -> dict[str, object]:
        request_id = record["requestID"]
        assert isinstance(request_id, int)
        name = record["request"]
        assert isinstance(name, str)
        existing = self._rpc.get(request_id)
        if existing is None:
            existing = {
                "request_id": request_id,
                "name": name,
                "request_sequence": None,
                "request_receipt_ms": None,
                "request_encoded_bytes": None,
                "dispatch_sequence": None,
                "dispatch_receipt_ms": None,
                "dispatch_duration_ms": None,
                "response_sequence": None,
                "response_receipt_ms": None,
                "response_encoded_bytes": None,
                "removable_duplicate_bytes": None,
            }
            self._rpc[request_id] = existing
            sequence = record["sequence"]
            assert isinstance(sequence, int)
            self._rpc_first_sequence[request_id] = sequence
        elif existing["name"] != name:
            raise TraceFailure("trace_rpc_name_mismatch")
        return existing

    def observe(self, record: dict[str, object], receipt_ms: float) -> None:
        event = record["event"]
        if event == "phase":
            self.phases.append(
                {
                    "sequence": record["sequence"],
                    "phase": record["phase"],
                    "role": record["role"],
                    "outcome": record["outcome"],
                    "duration_ms": record["durationMs"],
                    "receipt_ms": receipt_ms,
                }
            )
            return
        if event not in ("rpc.request", "rpc.dispatch", "rpc.response"):
            return
        joined = self._rpc_record(record)
        prefix = event.removeprefix("rpc.")
        sequence_key = f"{prefix}_sequence"
        if joined[sequence_key] is not None:
            raise TraceFailure(f"trace_rpc_duplicate_{prefix}")
        joined[sequence_key] = record["sequence"]
        joined[f"{prefix}_receipt_ms"] = receipt_ms
        if event == "rpc.request":
            joined["request_encoded_bytes"] = record["encodedBytes"]
        elif event == "rpc.dispatch":
            joined["dispatch_duration_ms"] = record["durationMs"]
        else:
            joined["response_encoded_bytes"] = record["encodedBytes"]
            joined["removable_duplicate_bytes"] = record["removableDuplicateBytes"]

    def rpc_records(self) -> list[dict[str, object]]:
        return [
            dict(self._rpc[request_id])
            for request_id in sorted(self._rpc, key=lambda item: self._rpc_first_sequence[item])
        ]


def _optional_nonnegative_number(value: object) -> bool:
    return value is None or _finite_nonnegative(value)


def _optional_safe_integer(value: object) -> bool:
    return value is None or _safe_integer(value)


def _valid_phase_evidence(value: object) -> bool:
    return (
        isinstance(value, dict)
        and set(value) == {"sequence", "phase", "role", "outcome", "duration_ms", "receipt_ms"}
        and _safe_integer(value["sequence"])
        and value["phase"] in TRACE_PHASES
        and value["role"] in ("main", "worker")
        and value["outcome"] in ("ok", "error")
        and _finite_nonnegative(value["duration_ms"])
        and _finite_nonnegative(value["receipt_ms"])
    )


def _valid_rpc_evidence(value: object) -> bool:
    keys = {
        "request_id",
        "name",
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
    }
    if not isinstance(value, dict) or set(value) != keys:
        return False
    if not (
        _safe_integer(value["request_id"])
        and value["name"] in TRACE_REQUESTS
        and all(
            _optional_safe_integer(value[key])
            for key in (
                "request_sequence",
                "request_encoded_bytes",
                "dispatch_sequence",
                "response_sequence",
                "response_encoded_bytes",
                "removable_duplicate_bytes",
            )
        )
        and all(
            _optional_nonnegative_number(value[key])
            for key in (
                "request_receipt_ms",
                "dispatch_receipt_ms",
                "dispatch_duration_ms",
                "response_receipt_ms",
            )
        )
    ):
        return False
    request_present = value["request_sequence"] is not None
    dispatch_present = value["dispatch_sequence"] is not None
    response_present = value["response_sequence"] is not None
    if not (request_present or dispatch_present or response_present):
        return False
    if request_present != (value["request_receipt_ms"] is not None and value["request_encoded_bytes"] is not None):
        return False
    if dispatch_present != (value["dispatch_receipt_ms"] is not None and value["dispatch_duration_ms"] is not None):
        return False
    if response_present != (
        value["response_receipt_ms"] is not None
        and value["response_encoded_bytes"] is not None
        and value["removable_duplicate_bytes"] is not None
    ):
        return False
    ordered = [
        value[key]
        for key in ("request_sequence", "dispatch_sequence", "response_sequence")
        if value[key] is not None
    ]
    return ordered == sorted(ordered) and len(ordered) == len(set(ordered))


def _valid_measurement(value: object, interaction_probe: bool = False) -> bool:
    expected = {
        "first_byte_ms", "ready_ms", "ttfd_ms", "bytes_until_ready", "timed_out",
        "pty_handshake_ok", "first_frame_ms", "shell_ms", "prompt_ms", "critical_ready_ms",
        "theme_settled_ms", "theme_settled_outcome", "interactive_ms", "input_accepted_ms",
        "run_id", "workspace_generation", "attempt_generation", "trace_records",
        "foreground_query_count", "background_query_count", "foreground_response_count",
        "background_response_count", "theme_reconciliation_count", "probe_body_visible",
        "probe_noecho_verified", "probe_guard_sent", "probe_persistence_verified",
        "probe_removal_verified", "probe_backspace_count", "probe_verified_reconciliation_count",
        "theme_activity_verified", "phases", "rpc", "failure",
    }
    if not isinstance(value, dict) or set(value) != expected:
        return False
    number_fields = (
        "first_byte_ms", "ready_ms", "ttfd_ms", "first_frame_ms", "shell_ms", "prompt_ms",
        "critical_ready_ms", "theme_settled_ms", "interactive_ms", "input_accepted_ms",
    )
    integer_fields = (
        "bytes_until_ready", "trace_records", "foreground_query_count", "background_query_count",
        "foreground_response_count", "background_response_count", "theme_reconciliation_count",
        "probe_backspace_count", "probe_verified_reconciliation_count",
    )
    boolean_fields = (
        "timed_out", "pty_handshake_ok", "probe_body_visible", "probe_noecho_verified",
        "probe_guard_sent", "probe_persistence_verified", "probe_removal_verified",
        "theme_activity_verified",
    )
    failure = value["failure"]
    if not (
        all(_optional_nonnegative_number(value[field]) for field in number_fields)
        and all(_safe_integer(value[field]) for field in integer_fields)
        and all(type(value[field]) is bool for field in boolean_fields)
        and _optional_safe_integer(value["workspace_generation"])
        and _optional_safe_integer(value["attempt_generation"])
        and value["theme_settled_outcome"] in (None, "locked", "resolved", "fallback-final")
        and isinstance(value["run_id"], str)
        and re.fullmatch(r"[0-9A-Za-z_-]{1,128}", value["run_id"]) is not None
        and (failure is None or (isinstance(failure, str) and re.fullmatch(r"[a-z0-9_]{1,96}", failure) is not None))
        and isinstance(value["phases"], list)
        and all(_valid_phase_evidence(item) for item in value["phases"])
        and isinstance(value["rpc"], list)
        and all(_valid_rpc_evidence(item) for item in value["rpc"])
    ):
        return False
    phases = value["phases"]
    rpc = value["rpc"]
    assert isinstance(phases, list) and isinstance(rpc, list)
    phase_sequences = [item["sequence"] for item in phases]
    if phase_sequences != sorted(phase_sequences) or len(phase_sequences) != len(set(phase_sequences)):
        return False
    request_ids = [item["request_id"] for item in rpc]
    if len(request_ids) != len(set(request_ids)):
        return False
    rpc_first_sequences = [
        min(
            item[key]
            for key in ("request_sequence", "dispatch_sequence", "response_sequence")
            if item[key] is not None
        )
        for item in rpc
    ]
    if rpc_first_sequences != sorted(rpc_first_sequences):
        return False
    all_sequences = [*phase_sequences]
    observations = [(item["sequence"], item["receipt_ms"]) for item in phases]
    for item in rpc:
        all_sequences.extend(
            item[key]
            for key in ("request_sequence", "dispatch_sequence", "response_sequence")
            if item[key] is not None
        )
        for prefix in ("request", "dispatch", "response"):
            sequence = item[f"{prefix}_sequence"]
            if sequence is not None:
                observations.append((sequence, item[f"{prefix}_receipt_ms"]))
    if len(all_sequences) != len(set(all_sequences)):
        return False
    receipts = [receipt for _, receipt in sorted(observations)]
    if receipts != sorted(receipts):
        return False
    if value["failure"] is None:
        if (
            value["timed_out"] is not False
            or value["pty_handshake_ok"] is not True
            or value["trace_records"] < 1
            or any(
                value[field] is None
                for field in (
                    "first_frame_ms",
                    "prompt_ms",
                    "critical_ready_ms",
                    "theme_settled_ms",
                    "workspace_generation",
                    "attempt_generation",
                )
            )
        ):
            return False
        if interaction_probe and (
            value["interactive_ms"] is None
            or value["input_accepted_ms"] is None
            or value["probe_body_visible"] is not True
            or value["probe_noecho_verified"] is not True
            or value["probe_guard_sent"] is not True
            or value["probe_persistence_verified"] is not True
            or value["probe_removal_verified"] is not True
            or value["theme_activity_verified"] is not True
            or value["probe_backspace_count"] < 1
        ):
            return False
    return True


def run_once(
    command: Sequence[str],
    state: Path,
    cwd: Path,
    timeout: float,
    theme_response: Union[str, ThemeFixture],
    ready_text: bytes,
    interaction_probe: bool = False,
) -> dict[str, Any]:
    fixture = theme_response if isinstance(theme_response, ThemeFixture) else parse_theme_response(theme_response)
    assert isinstance(fixture, ThemeFixture)
    env = child_environment(state)
    run_id = "run_" + secrets.token_hex(16)
    supervision_token = "supervision_" + secrets.token_hex(24)
    probe_body = PROBE_PREFIX + secrets.token_hex(PROBE_NONCE_BYTES) if interaction_probe else None
    probe = InteractionProbeOracle(fixture, probe_body) if probe_body is not None else None
    env[SUPERVISION_ENV] = supervision_token
    trace_read_fd: Optional[int] = None
    trace_write_fd: Optional[int] = None
    try:
        trace_read_fd, trace_write_fd = _open_trace_pipe(env, run_id)
    except OSError:
        return _empty_result("trace_pipe_failed", False, run_id)
    try:
        child = spawn_pty(command, cwd, env, timeout)
    except PtyHandshakeError:
        assert trace_read_fd is not None and trace_write_fd is not None
        try:
            os.close(trace_read_fd)
        finally:
            os.close(trace_write_fd)
        return _empty_result("pty_handshake_failed", False, run_id)
    except BaseException:
        assert trace_read_fd is not None and trace_write_fd is not None
        try:
            os.close(trace_read_fd)
        finally:
            os.close(trace_write_fd)
        raise
    pid = child.pid
    fd = child.master_fd
    start_ns = child.start_ns
    root_identity: Optional[ProcessIdentity] = None
    assert trace_read_fd is not None and trace_write_fd is not None
    exit_observer: Optional[ChildExitObserver] = None
    descendants: Optional[DescendantSupervisor] = None
    screen: Optional[TerminalScreen] = None
    trace: Optional[TraceJsonlParser] = None
    oracle: Optional[StartupMilestoneOracle] = None
    known_descendants: dict[int, ProcessIdentity] = {}
    legacy_output = bytearray()
    total_pty_bytes = 0
    bytes_until_ready: Optional[int] = None
    first_byte_ms: Optional[float] = None
    ready_ms: Optional[float] = None
    ttfd_ms: Optional[float] = None
    deadline = child.deadline
    failure: Optional[str] = None
    setup_complete = False
    body_error: Optional[BaseException] = None
    cleanup_error: Optional[BaseException] = None
    close_error: Optional[BaseException] = None
    descendant_tracking_failed = False
    descendant_cleanup_ok = True
    emergency_enumeration_ok = True
    emergency_cleanup_ok = True
    pty_open = True
    trace_open = True
    pty_eof_deadline: Optional[float] = None
    trace_eof_deadline: Optional[float] = None
    osc = OscQueryParser()
    responder = ThemeResponder(fd, fixture)
    evidence = TraceEvidence()
    try:
        screen = TerminalScreen(PTY_WIDTH, PTY_HEIGHT)
        trace = TraceJsonlParser(run_id)
        oracle = StartupMilestoneOracle(_prompt_matcher)
        exit_observer = ChildExitObserver(pid)
        root_identity = _process_identity(pid)
        if root_identity is None:
            raise RuntimeError("root process identity was unavailable")
        descendants = DescendantSupervisor(pid)
        descendants.start()
        os.close(trace_write_fd)
        trace_write_fd = None
        setup_complete = True
        if not exit_observer.available:
            failure = "child_exit_observer_failed"
        assert screen is not None and trace is not None and oracle is not None
        while failure is None:
            now = time.monotonic()
            # Send probe input only after a trace-clean loop boundary.
            trace_ready_before_actions = trace_open and bool(select.select([trace_read_fd], [], [], 0)[0])
            if not trace_ready_before_actions:
                try:
                    responder.flush_due(now)
                except ProbeFailure as error:
                    failure = error.code
                    break
            if probe is not None:
                if probe.failure is not None:
                    failure = probe.failure
                    break
                if not trace_ready_before_actions:
                    failure = _write_probe_actions(fd, probe)
                    if failure is not None:
                        break
            milestones_complete = oracle.complete and (probe is None or probe.complete)
            if pty_eof_deadline is not None and trace_eof_deadline is not None:
                failure = "child_exited_early"
                break
            if pty_eof_deadline is not None and now >= pty_eof_deadline:
                failure = "pty_eof_before_milestones"
                break
            if trace_eof_deadline is not None and now >= trace_eof_deadline:
                failure = "trace_eof_before_milestones"
                break
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                if not oracle.complete:
                    failure = oracle.timeout_failure(screen)
                else:
                    failure = probe.timeout_failure() if probe is not None else "startup_timeout"
                break
            watched = []
            if trace_open:
                watched.append(trace_read_fd)
            if pty_open:
                watched.append(fd)
            if milestones_complete and not select.select(watched, [], [], 0)[0]:
                if probe is None:
                    break
                activity_failure = responder.activity_failure()
                if activity_failure is None:
                    break
                if not responder.responses_pending:
                    failure = activity_failure
                    break
            eof_remaining = [
                value - time.monotonic()
                for value in (pty_eof_deadline, trace_eof_deadline)
                if value is not None
            ]
            action_remaining = [
                value - time.monotonic()
                for value in (responder.next_deadline(), probe.next_deadline() if probe is not None else None)
                if value is not None
            ]
            wait = min([0.05, remaining, *eof_remaining, *action_remaining])
            readable, _, _ = select.select(watched, [], [], max(0.0, wait))
            if not readable:
                if exit_observer.exited():
                    failure = "child_exited_early"
                elif probe is not None:
                    probe.advance(time.monotonic())
                    failure = probe.failure
                continue
            for readable_fd in readable:
                if readable_fd == trace_read_fd:
                    try:
                        data = _read_trace(trace_read_fd)
                    except OSError:
                        failure = "trace_read_failed"
                        break
                    now_ms = (time.perf_counter_ns() - start_ns) / 1_000_000
                    if not data:
                        try:
                            trace.finish()
                        except TraceFailure as error:
                            failure = error.code
                        else:
                            trace_open = False
                            trace_eof_deadline = time.monotonic() + 0.03
                        if failure is not None:
                            break
                        continue
                    try:
                        trace_batch = trace.feed(data, now_ms)
                    except TraceFailure as error:
                        failure = error.code
                        break
                    for record, receipt_ms in trace_batch:
                        try:
                            evidence.observe(record, receipt_ms)
                        except TraceFailure as error:
                            failure = error.code
                            break
                        oracle.observe_trace(record, receipt_ms)
                        if oracle.failure is not None:
                            failure = oracle.failure
                            break
                        if probe is not None:
                            probe.observe_trace(record, receipt_ms)
                            if probe.failure is not None:
                                failure = probe.failure
                                break
                            activity_failure = responder.marker_activity_failure(
                                record["event"],
                                record.get("outcome"),
                            )
                            if activity_failure is not None:
                                failure = activity_failure
                                break
                    if failure is not None:
                        break
                    continue

                data = read_pty(fd)
                now_ms = (time.perf_counter_ns() - start_ns) / 1_000_000
                if not data:
                    _, malformed_ttfd = _legacy_ttfd_value(legacy_output, eof=True)
                    if malformed_ttfd:
                        failure = "invalid_ttfd_diagnostic"
                        break
                    screen.finish()
                    if not screen.valid:
                        failure = _terminal_failure(screen, eof=True)
                    else:
                        pty_open = False
                        pty_eof_deadline = time.monotonic() + 0.03
                    if failure is not None:
                        break
                    continue
                if first_byte_ms is None:
                    first_byte_ms = now_ms
                total_pty_bytes += len(data)
                if ready_ms is None:
                    legacy_output.extend(data)
                    if len(legacy_output) > LEGACY_SCAN_LIMIT:
                        failure = "pty_output_limit"
                        break
                    ttfd_value, malformed_ttfd = _legacy_ttfd_value(legacy_output)
                    if malformed_ttfd:
                        failure = "invalid_ttfd_diagnostic"
                        break
                    if ttfd_value is not None and ttfd_ms is None:
                        ttfd_ms = ttfd_value
                    if ttfd_value is not None and ready_text in legacy_output:
                        ready_ms = now_ms
                        bytes_until_ready = total_pty_bytes
                        legacy_output.clear()
                frames = screen.feed(data)
                if not screen.valid:
                    failure = _terminal_failure(screen)
                    break
                for frame in frames:
                    oracle.observe_frame(frame, now_ms)
                    if oracle.failure is not None:
                        failure = oracle.failure
                        break
                    if probe is not None:
                        probe.observe_frame(frame, now_ms)
                        if probe.failure is not None:
                            failure = probe.failure
                            break
                if failure is not None:
                    break
                try:
                    responder.observe(osc.feed(data), time.monotonic())
                except ProbeFailure as error:
                    failure = error.code
                    break
            if failure is None and probe is not None:
                probe.advance(time.monotonic())
                failure = probe.failure
            if failure is None and exit_observer.exited():
                failure = "child_exited_early"
        if failure is None and oracle.failure is not None:
            failure = oracle.failure
    except BaseException as error:
        if setup_complete:
            body_error = error
        else:
            failure = "supervision_setup_failed"
    finally:
        if exit_observer is not None:
            try:
                exit_observer.close()
            except BaseException as error:
                close_error = error
        if descendants is not None:
            try:
                descendants.scan_now()
            except BaseException:
                descendant_tracking_failed = True
            try:
                descendants.request_stop()
            except BaseException:
                descendant_tracking_failed = True
        try:
            stop_pty_child(pid, fd)
        except BaseException as error:
            cleanup_error = error
        if descendants is not None:
            try:
                known_descendants, finish_failed = descendants.finish()
                descendant_tracking_failed = descendant_tracking_failed or finish_failed
            except BaseException:
                descendant_tracking_failed = True
        if cleanup_error is None and known_descendants:
            try:
                descendant_cleanup_ok = _cleanup_tracked_descendants(known_descendants)
            except BaseException:
                descendant_cleanup_ok = False
        elif cleanup_error is not None:
            descendant_cleanup_ok = False
        try:
            emergency_enumeration_ok, emergency_cleanup_ok = _emergency_token_cleanup(
                supervision_token,
                pid,
                root_identity,
                known_descendants,
            )
        except BaseException:
            emergency_enumeration_ok = False
            emergency_cleanup_ok = False
        try:
            close_pty_fd(fd)
        except BaseException as error:
            if close_error is None:
                close_error = error
        for pipe_fd in (trace_read_fd, trace_write_fd):
            if pipe_fd is None:
                continue
            try:
                os.close(pipe_fd)
            except OSError as error:
                if error.errno != errno.EBADF and close_error is None:
                    close_error = error

    if body_error is not None:
        raise body_error
    cleanup_failed = not descendant_cleanup_ok or not emergency_cleanup_ok
    tracking_failed = descendant_tracking_failed or not emergency_enumeration_ok
    if failure is None:
        if cleanup_error is not None or cleanup_failed:
            failure = "descendant_cleanup_failed"
        elif tracking_failed:
            failure = "descendant_tracking_failed"
        elif close_error is not None:
            failure = "pty_cleanup_failed"
    if bytes_until_ready is None:
        bytes_until_ready = total_pty_bytes
    return {
        "first_byte_ms": first_byte_ms,
        "ready_ms": ready_ms,
        "ttfd_ms": ttfd_ms,
        "bytes_until_ready": bytes_until_ready,
        "timed_out": ready_ms is None,
        "pty_handshake_ok": True,
        "first_frame_ms": oracle.first_frame_ms if oracle is not None else None,
        "shell_ms": oracle.shell_ms if oracle is not None else None,
        "prompt_ms": oracle.prompt_ms if oracle is not None else None,
        "critical_ready_ms": oracle.critical_ready_ms if oracle is not None else None,
        "theme_settled_ms": oracle.theme_settled_ms if oracle is not None else None,
        "theme_settled_outcome": oracle.theme_settled_outcome if oracle is not None else None,
        "interactive_ms": probe.interactive_ms if probe is not None else None,
        "input_accepted_ms": probe.input_accepted_ms if probe is not None else None,
        "run_id": run_id,
        "workspace_generation": oracle.workspace_generation if oracle is not None else None,
        "attempt_generation": oracle.attempt_generation if oracle is not None else None,
        "trace_records": trace.records if trace is not None else 0,
        "foreground_query_count": responder.foreground_queries,
        "background_query_count": responder.background_queries,
        "foreground_response_count": responder.foreground_responses,
        "background_response_count": responder.background_responses,
        "theme_reconciliation_count": probe.reconciliation_count if probe is not None else 0,
        "probe_body_visible": probe.body_visible if probe is not None else False,
        "probe_noecho_verified": probe.noecho_verified if probe is not None else False,
        "probe_guard_sent": probe.guard_sent if probe is not None else False,
        "probe_persistence_verified": probe.persistence_verified if probe is not None else False,
        "probe_removal_verified": probe.removal_verified if probe is not None else False,
        "probe_backspace_count": probe.backspace_count if probe is not None else 0,
        "probe_verified_reconciliation_count": probe.verified_reconciliation_count if probe is not None else 0,
        "theme_activity_verified": probe is not None and responder.activity_failure() is None,
        "phases": evidence.phases,
        "rpc": evidence.rpc_records(),
        "failure": failure,
    }


def write_record(stream: TextIO, record: dict[str, Any]) -> None:
    print(json.dumps(record, separators=(",", ":")), file=stream, flush=True)


def open_output(path: Optional[Path], force: bool) -> tuple[TextIO, bool]:
    if path is None:
        return sys.stdout, False
    path.parent.mkdir(parents=True, exist_ok=True)
    mode = "w" if force else "x"
    return path.open(mode, encoding="utf-8"), True


def _safe_integer_argument(value: str) -> int:
    if re.fullmatch(r"(?:0|[1-9][0-9]*)", value) is None:
        raise argparse.ArgumentTypeError("must be a canonical nonnegative integer")
    parsed = int(value)
    if parsed > MAX_SAFE_INTEGER:
        raise argparse.ArgumentTypeError("must be a safe integer")
    return parsed


def _theme_fixture_name(fixture: ThemeFixture) -> str:
    return f"late:{fixture.delay_ms}" if fixture.kind == "late" else fixture.kind


def build_balanced_schedule(samples_per_arm: int, mode: str, seed: int) -> list[dict[str, object]]:
    if type(samples_per_arm) is not int or samples_per_arm < 1:
        raise CompareFailure("compare_sample_count_invalid")
    if mode not in ("warm", "cold-like") or not _safe_integer(seed):
        raise CompareFailure("compare_schedule_invalid")
    orientation = hashlib.sha256(f"oc2-tui-startup-schedule-v1:{seed}".encode("ascii")).digest()[0] & 1
    schedule: list[dict[str, object]] = []

    def append_pair(kind: str, pair: int, arm_sample: int) -> None:
        first = "candidate" if (orientation + pair) % 2 else "baseline"
        second = "baseline" if first == "candidate" else "candidate"
        for arm in (first, second):
            schedule.append(
                {
                    "schedule_index": len(schedule),
                    "kind": kind,
                    "pair": pair,
                    "arm": arm,
                    "arm_sample": arm_sample,
                }
            )

    pair_offset = 0
    if mode == "warm":
        append_pair("seed", 0, 0)
        pair_offset = 1
    for sample in range(1, samples_per_arm + 1):
        append_pair("sample", pair_offset + sample - 1, sample)
    return schedule


def _schedule_hash(entries: Sequence[dict[str, object]]) -> str:
    return _sha256_bytes(_canonical_json_bytes(list(entries), final_newline=False))


def _artifact_projection(artifact: Artifact) -> dict[str, object]:
    source = artifact.manifest["source"]
    binary = artifact.manifest["binary"]
    capabilities = artifact.manifest["capabilities"]
    assert isinstance(source, Mapping) and isinstance(binary, Mapping) and isinstance(capabilities, Mapping)
    return {
        "artifact_id": artifact.artifact_id,
        "binary_sha256": binary["sha256"],
        "revision": source["revision"],
        "tree": source["tree"],
        "pr_base_revision": source["pr_base_revision"],
        "clean": source["clean"],
        "shell_capability": capabilities["shell"],
    }


def _revalidate_artifact(expected: Artifact) -> bool:
    try:
        current = load_artifact(expected.root)
    except ArtifactFailure:
        return False
    return (
        current.artifact_id == expected.artifact_id
        and current.binary_identity == expected.binary_identity
        and current.binary_path == expected.binary_path
    )


def _revalidate_artifacts(expected: Sequence[Artifact]) -> bool:
    results = [_revalidate_artifact(artifact) for artifact in expected]
    return all(results)


def _cwd_placeholder(cwd: Path) -> str:
    try:
        relative = cwd.relative_to(REPO_ROOT.resolve())
    except ValueError:
        return "$CWD"
    return "$REPO" if relative == Path(".") else f"$REPO/{relative.as_posix()}"


def _sanitize_command(arguments: Sequence[str], cwd: Path, artifacts: Sequence[Artifact]) -> dict[str, object]:
    cwd = cwd.resolve()
    cwd_placeholder = _cwd_placeholder(cwd)
    artifact_paths = {str(item.binary_path.resolve()) for item in artifacts}

    def sanitize_path(value: str) -> str:
        path = Path(value).resolve(strict=False)
        try:
            relative = path.relative_to(cwd)
        except ValueError:
            try:
                relative = path.relative_to(REPO_ROOT.resolve())
            except ValueError:
                raise CompareFailure("compare_command_private_path") from None
            return "$REPO" if relative == Path(".") else f"$REPO/{relative.as_posix()}"
        return cwd_placeholder if relative == Path(".") else f"{cwd_placeholder}/{relative.as_posix()}"

    def sanitize_value(value: str) -> str:
        if "://" in value:
            return "$REDACTED"
        if os.path.isabs(value):
            return sanitize_path(value)
        if "/" in value or value in (".", ".."):
            if ".." in Path(value).parts:
                raise CompareFailure("compare_command_private_path")
            return cwd_placeholder if value == "." else f"{cwd_placeholder}/{Path(value).as_posix()}"
        return "$REDACTED"

    sanitized = ["$ARTIFACT_BINARY"]
    redact_next = False
    opaque_mode = False
    for argument in arguments:
        if not _bounded_ascii(argument, 2048):
            raise CompareFailure("compare_command_invalid")
        if opaque_mode:
            sanitized.append(sanitize_value(argument))
            continue
        if redact_next:
            sanitized.append(sanitize_value(argument))
            redact_next = False
            continue
        if str(Path(argument).resolve(strict=False)) in artifact_paths:
            sanitized.append("$ARTIFACT_BINARY")
            continue
        if os.path.isabs(argument):
            sanitized.append(sanitize_path(argument))
            continue
        if "://" in argument:
            sanitized.append("$REDACTED")
            continue
        if "=" in argument:
            key, value = argument.split("=", 1)
            if not key:
                raise CompareFailure("compare_command_invalid")
            sanitized_value = sanitize_path(value) if os.path.isabs(value) else "$REDACTED"
            sanitized.append(
                f"{key}={sanitized_value}"
                if not key.startswith("-") or key in COMPARE_COMMAND_SAFE_FLAGS
                else "$REDACTED_OPTION"
            )
            continue
        if argument == "--":
            sanitized.append("--")
            opaque_mode = True
            continue
        if argument.startswith("-"):
            if argument in COMPARE_COMMAND_SAFE_FLAGS:
                sanitized.append(argument)
                continue
            sanitized.append("$REDACTED_OPTION")
            redact_next = True
            continue
        if "/" in argument or argument in (".", ".."):
            if Path(argument).is_absolute() or ".." in Path(argument).parts:
                raise CompareFailure("compare_command_private_path")
            sanitized.append(cwd_placeholder if argument == "." else f"{cwd_placeholder}/{Path(argument).as_posix()}")
            continue
        sanitized.append("$REDACTED")
    return {"argv": sanitized, "cwd": cwd_placeholder}


def _comparison_metadata(
    args: argparse.Namespace,
    baseline: Artifact,
    candidate: Artifact,
    schedule: list[dict[str, object]],
    command_suffix: Sequence[str],
    cwd: Path,
) -> dict[str, object]:
    timeout_ms_value = args.timeout * 1000
    if (
        not math.isfinite(timeout_ms_value)
        or timeout_ms_value <= 0
        or timeout_ms_value > MAX_SAFE_INTEGER
        or not timeout_ms_value.is_integer()
    ):
        raise CompareFailure("compare_timeout_invalid")
    state_policy = (
        "isolated-warm-per-arm-v1" if args.mode == "warm" else "isolated-cold-like-per-sample-v1"
    )
    metadata: dict[str, object] = {
        "schema": COMPARE_SCHEMA,
        "version": COMPARE_VERSION,
        "record": "metadata",
        "label": args.label,
        "scenario": {
            "mode": args.mode,
            "theme_response": _theme_fixture_name(args.theme_response),
            "metric_set": args.metric_set,
            "interaction_probe": args.interaction_probe,
            "timeout_ms": int(timeout_ms_value),
            "pty": {"width": PTY_WIDTH, "height": PTY_HEIGHT},
        },
        "command": _sanitize_command(command_suffix, cwd, (baseline, candidate)),
        "controlled_environment": {
            **CONTROLLED_ENV,
            "HOME": "$STATE/home",
            "XDG_DATA_HOME": "$STATE/data",
            "XDG_CACHE_HOME": "$STATE/cache",
            "XDG_CONFIG_HOME": "$STATE/config",
            "TMPDIR": "$STATE/tmp",
            "TMP": "$STATE/tmp",
            "TEMP": "$STATE/tmp",
        },
        "state_policy": {
            "version": 1,
            "name": state_policy,
            "warm_seeds_per_arm": 1 if args.mode == "warm" else 0,
            "writable_state_shared_between_arms": False,
        },
        "artifacts": {
            "baseline": _artifact_projection(baseline),
            "candidate": _artifact_projection(candidate),
        },
        "run_host": _host_record(False),
        "tooling": _tooling_hashes(),
        "trace_allowlist": {
            "version": TRACE_EVIDENCE_VERSION,
            "phases": sorted(TRACE_PHASES),
            "rpc_requests": sorted(TRACE_REQUESTS),
        },
        "schedule": {
            "version": SCHEDULE_VERSION,
            "seed": args.schedule_seed,
            "sha256": _schedule_hash(schedule),
            "entries": schedule,
        },
    }
    comparison_id = _sha256_bytes(_canonical_json_bytes(metadata, final_newline=False))
    metadata["comparison_id"] = comparison_id
    return metadata


def _write_canonical_record(stream: TextIO, record: dict[str, object]) -> bytes:
    encoded = _canonical_json_bytes(record)
    stream.write(encoded.decode("utf-8"))
    stream.flush()
    return encoded


def _flush_fsync(stream: TextIO) -> None:
    stream.flush()
    os.fsync(stream.fileno())


def _output_identity_matches(path: Path, expected: StableFileIdentity) -> bool:
    try:
        current = path.lstat()
    except OSError:
        return False
    return (
        stat.S_ISREG(current.st_mode)
        and not stat.S_ISLNK(current.st_mode)
        and current.st_nlink == 1
        and (current.st_dev, current.st_ino) == (expected.device, expected.inode)
    )


def _output_content_matches(
    path: Path,
    expected_identity: StableFileIdentity,
    expected_digest: "hashlib._Hash",
    expected_size: int,
) -> bool:
    if not _output_identity_matches(path, expected_identity):
        return False
    try:
        content, identity = _read_stable_file(path)
    except ArtifactFailure:
        return False
    return (
        (identity.device, identity.inode) == (expected_identity.device, expected_identity.inode)
        and len(content) == expected_size
        and _sha256_bytes(content) == expected_digest.hexdigest()
    )


def _state_for_schedule_entry(run_root: Path, entry: Mapping[str, object], mode: str) -> tuple[Path, str]:
    arm = entry["arm"]
    assert isinstance(arm, str)
    if mode == "warm":
        state_id = f"warm/{arm}"
    else:
        sample = entry["arm_sample"]
        assert isinstance(sample, int)
        state_id = f"cold-like/{arm}/{sample:04d}"
    return run_root / state_id, state_id


def _capture_state_identity(root: Path) -> dict[str, tuple[int, int]]:
    identities: dict[str, tuple[int, int]] = {}
    for name in (".", "home", "data", "cache", "config", "tmp"):
        path = root if name == "." else root / name
        try:
            value = path.lstat()
        except OSError:
            raise CompareFailure("state_identity_invalid") from None
        if stat.S_ISLNK(value.st_mode) or not stat.S_ISDIR(value.st_mode):
            raise CompareFailure("state_identity_invalid")
        identities[name] = (value.st_dev, value.st_ino)
    return identities


def _state_identity_matches(root: Path, expected: Mapping[str, tuple[int, int]]) -> bool:
    try:
        return _capture_state_identity(root) == dict(expected)
    except CompareFailure:
        return False


def _descriptive_statistics(results: Sequence[dict[str, Any]]) -> dict[str, object]:
    metrics: dict[str, object] = {}
    for field in (
        "ready_ms",
        "ttfd_ms",
        "first_byte_ms",
        "first_frame_ms",
        "shell_ms",
        "prompt_ms",
        "critical_ready_ms",
        "theme_settled_ms",
        "interactive_ms",
    ):
        values = [item.get(field) for item in results if item.get("failure") is None and item.get(field) is not None]
        if not values:
            metrics[field] = None
            continue
        metrics[field] = {
            "min": min(values),
            "median": statistics.median(values),
            "mean": statistics.mean(values),
            "p90": percentile(values, 0.90),
            "p95": percentile(values, 0.95),
            "max": max(values),
            "stdev": statistics.stdev(values) if len(values) > 1 else 0,
        }
    return metrics


def _comparison_summary(
    args: argparse.Namespace,
    comparison_id: str,
    schedule: Sequence[dict[str, object]],
    observed: Sequence[tuple[dict[str, object], dict[str, Any]]],
    comparison_failure: Optional[str],
) -> dict[str, object]:
    arms: dict[str, object] = {}
    for arm in ("baseline", "candidate"):
        seeds = [measurement for entry, measurement in observed if entry["arm"] == arm and entry["kind"] == "seed"]
        samples = [measurement for entry, measurement in observed if entry["arm"] == arm and entry["kind"] == "sample"]
        arms[arm] = {
            "seed_records": len(seeds),
            "valid_seeds": sum(item.get("failure") is None for item in seeds),
            "samples": len(samples),
            "valid": sum(item.get("failure") is None for item in samples),
            "metrics": _descriptive_statistics(samples),
        }
    expected_seeds = 2 if args.mode == "warm" else 0
    observed_seeds = sum(entry["kind"] == "seed" for entry, _ in observed)
    return {
        "schema": COMPARE_SCHEMA,
        "version": COMPARE_VERSION,
        "record": "summary",
        "comparison_id": comparison_id,
        "label": args.label,
        "samples_per_arm": args.samples_per_arm,
        "expected_seed_records": expected_seeds,
        "observed_seed_records": observed_seeds,
        "expected_schedule_records": len(schedule),
        "observed_schedule_records": len(observed),
        "arms": arms,
        "comparison_failure": comparison_failure,
    }


def _measurement_wrapper(
    metadata: Mapping[str, object],
    entry: dict[str, object],
    artifact: Artifact,
    state_id: str,
    state_policy: str,
    measurement: dict[str, Any],
) -> dict[str, object]:
    return {
        "schema": COMPARE_SCHEMA,
        "version": COMPARE_VERSION,
        "record": entry["kind"],
        "comparison_id": metadata["comparison_id"],
        "label": metadata["label"],
        "schedule_index": entry["schedule_index"],
        "pair": entry["pair"],
        "arm": entry["arm"],
        "arm_sample": entry["arm_sample"],
        "artifact_id": artifact.artifact_id,
        "state_id": state_id,
        "state_policy": state_policy,
        "measurement": measurement,
    }


def run_comparison(args: argparse.Namespace) -> int:
    if not _valid_artifact_name(args.label):
        raise CompareFailure("compare_label_invalid")
    if type(args.samples_per_arm) is not int or args.samples_per_arm < 1:
        raise CompareFailure("compare_sample_count_invalid")
    cwd = Path(args.cwd).resolve()
    if not cwd.is_dir():
        raise CompareFailure("compare_cwd_invalid")
    command_suffix = args.command[1:] if args.command[:1] == ["--"] else args.command
    baseline = load_artifact(args.baseline_artifact)
    candidate = load_artifact(args.candidate_artifact)
    if baseline.artifact_id == candidate.artifact_id:
        raise CompareFailure("compare_artifacts_not_distinct")
    candidate_capabilities = candidate.manifest["capabilities"]
    assert isinstance(candidate_capabilities, Mapping)
    if args.metric_set in ("shell", "full") and candidate_capabilities["shell"] != "required":
        raise CompareFailure("compare_candidate_capability_mismatch")

    schedule = build_balanced_schedule(args.samples_per_arm, args.mode, args.schedule_seed)
    metadata = _comparison_metadata(args, baseline, candidate, schedule, command_suffix, cwd)
    state_policy = metadata["state_policy"]
    assert isinstance(state_policy, dict)
    state_policy_name = state_policy["name"]
    assert isinstance(state_policy_name, str)

    output = Path(args.output).absolute()
    _require_plain_directory(output.parent, "compare_output_parent_invalid")
    try:
        stream = output.open("x", encoding="utf-8")
    except FileExistsError:
        raise CompareFailure("compare_output_exists") from None
    except OSError:
        raise CompareFailure("compare_output_open_failed") from None
    output_identity = _stable_file_identity(os.fstat(stream.fileno()))
    if output_identity.links != 1 or not _output_identity_matches(output, output_identity):
        stream.close()
        raise CompareFailure("compare_output_identity_failed")

    run_root: Optional[Path] = None
    run_root_identity: Optional[tuple[int, int]] = None
    state_identities: dict[Path, dict[str, tuple[int, int]]] = {}
    observed: list[tuple[dict[str, object], dict[str, Any]]] = []
    comparison_failure: Optional[str] = None
    output_digest = hashlib.sha256()
    output_size = 0
    output_mutated = False
    try:
        state_parent = Path(args.state_root).resolve()
        state_parent.mkdir(parents=True, exist_ok=True)
        run_root = Path(tempfile.mkdtemp(prefix="compare-", dir=state_parent))
        run_root_stat = run_root.lstat()
        run_root_identity = (run_root_stat.st_dev, run_root_stat.st_ino)
        if args.mode == "warm":
            for arm in ("baseline", "candidate"):
                state = run_root / "warm" / arm
                prepare_state(state)
                state_identities[state] = _capture_state_identity(state)
        metadata_bytes = _write_canonical_record(stream, metadata)
        output_digest.update(metadata_bytes)
        output_size += len(metadata_bytes)
        _flush_fsync(stream)

        invalid_seed = False
        for entry in schedule:
            if invalid_seed and entry["kind"] == "sample":
                break
            if not _output_content_matches(output, output_identity, output_digest, output_size):
                comparison_failure = "output_identity_changed"
                output_mutated = True
                break
            if not all(_state_identity_matches(path, identity) for path, identity in state_identities.items()):
                comparison_failure = "state_identity_changed"
                break
            if not _revalidate_artifacts((baseline, candidate)):
                comparison_failure = "artifact_mutated"
                break
            arm = entry["arm"]
            artifact = baseline if arm == "baseline" else candidate
            assert run_root is not None
            state, state_id = _state_for_schedule_entry(run_root, entry, args.mode)
            if args.mode == "cold-like":
                prepare_state(state)
                try:
                    state_identities[state] = _capture_state_identity(state)
                except CompareFailure:
                    comparison_failure = "state_identity_changed"
                    break
            try:
                measurement = run_once(
                    [str(artifact.binary_path), *command_suffix],
                    state,
                    cwd,
                    args.timeout,
                    args.theme_response,
                    DEFAULT_READY_TEXT.encode(),
                    args.interaction_probe,
                )
            except BaseException:
                measurement = _empty_result("comparison_run_failed", False, "run_unavailable")
                comparison_failure = "comparison_run_failed"
            if not _valid_measurement(measurement, args.interaction_probe):
                measurement = _empty_result("invalid_measurement_schema", False, "run_unavailable")
                comparison_failure = comparison_failure or (
                    "warm_seed_invalid" if entry["kind"] == "seed" else "invalid_sample"
                )
            if not _output_content_matches(output, output_identity, output_digest, output_size):
                comparison_failure = "output_identity_changed"
                output_mutated = True
                break
            wrapper = _measurement_wrapper(metadata, entry, artifact, state_id, state_policy_name, measurement)
            wrapper_bytes = _write_canonical_record(stream, wrapper)
            output_digest.update(wrapper_bytes)
            output_size += len(wrapper_bytes)
            observed.append((entry, measurement))
            if not all(_state_identity_matches(path, identity) for path, identity in state_identities.items()):
                comparison_failure = "state_identity_changed"
                break
            if not _revalidate_artifacts((baseline, candidate)):
                comparison_failure = "artifact_mutated"
                break
            if measurement.get("failure") is not None:
                if entry["kind"] == "seed":
                    invalid_seed = True
                    comparison_failure = comparison_failure or "warm_seed_invalid"
                else:
                    comparison_failure = comparison_failure or "invalid_sample"
            if comparison_failure == "comparison_run_failed":
                break
    finally:
        if run_root is not None:
            try:
                if not all(_state_identity_matches(path, identity) for path, identity in state_identities.items()):
                    raise OSError("compare state identity changed")
                run_root_stat = run_root.lstat()
                if (
                    run_root_identity is None
                    or stat.S_ISLNK(run_root_stat.st_mode)
                    or not stat.S_ISDIR(run_root_stat.st_mode)
                    or (run_root_stat.st_dev, run_root_stat.st_ino) != run_root_identity
                ):
                    raise OSError("compare state identity changed")
                shutil.rmtree(run_root)
            except BaseException:
                comparison_failure = "state_cleanup_failed"
        if not _revalidate_artifacts((baseline, candidate)):
            comparison_failure = "artifact_mutated"
        if len(observed) != len(schedule) and comparison_failure is None:
            comparison_failure = "schedule_incomplete"
        if not _output_content_matches(output, output_identity, output_digest, output_size):
            comparison_failure = "output_identity_changed"
            output_mutated = True
        try:
            if not output_mutated:
                summary = _comparison_summary(
                    args,
                    str(metadata["comparison_id"]),
                    schedule,
                    observed,
                    comparison_failure,
                )
                summary_bytes = _write_canonical_record(stream, summary)
                output_digest.update(summary_bytes)
                output_size += len(summary_bytes)
                _flush_fsync(stream)
                if not _revalidate_artifacts((baseline, candidate)):
                    comparison_failure = "artifact_mutated"
                if not _output_content_matches(output, output_identity, output_digest, output_size):
                    comparison_failure = "output_identity_changed"
                    output_mutated = True
        finally:
            stream.close()
    return 0 if comparison_failure is None and len(observed) == len(schedule) else 1


def build_preserve_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="tui_benchmark.py preserve", description="Preserve one immutable TUI binary")
    parser.add_argument("--name", required=True)
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--build-command", required=True)
    parser.add_argument("--shell-capability", choices=("unavailable", "required"), required=True)
    parser.add_argument("--output", type=Path, required=True)
    return parser


def build_compare_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="tui_benchmark.py compare", description="Run a balanced artifact comparison")
    parser.add_argument("--label", required=True)
    parser.add_argument("--samples-per-arm", type=int, required=True)
    parser.add_argument("--mode", choices=("warm", "cold-like"), required=True)
    parser.add_argument("--theme-response", type=parse_theme_response, required=True)
    parser.add_argument("--metric-set", choices=("pre-shell", "shell", "full"), required=True)
    parser.add_argument("--schedule-seed", type=_safe_integer_argument, required=True)
    parser.add_argument("--baseline-artifact", type=Path, required=True)
    parser.add_argument("--candidate-artifact", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--timeout", type=float, default=12.0)
    parser.add_argument("--cwd", type=Path, default=REPO_ROOT)
    parser.add_argument("--state-root", type=Path, default=REPO_ROOT / "tmp" / "tui-startup-state")
    parser.add_argument("--interaction-probe", action="store_true")
    parser.add_argument("command", nargs=argparse.REMAINDER, help="common artifact argv suffix, optionally preceded by --")
    return parser


class _RejectDuplicateAction(argparse.Action):
    def __call__(
        self,
        parser: argparse.ArgumentParser,
        namespace: argparse.Namespace,
        values: object,
        option_string: Optional[str] = None,
    ) -> None:
        if getattr(namespace, self.dest, None) is not None:
            raise argparse.ArgumentError(self, f"{option_string} may not be repeated")
        setattr(namespace, self.dest, values)


class _RejectDuplicateFlagAction(argparse.Action):
    def __init__(self, option_strings: Sequence[str], dest: str, **kwargs: object):
        super().__init__(option_strings, dest, nargs=0, **kwargs)

    def __call__(
        self,
        parser: argparse.ArgumentParser,
        namespace: argparse.Namespace,
        values: object,
        option_string: Optional[str] = None,
    ) -> None:
        if getattr(namespace, self.dest, None) is not None:
            raise argparse.ArgumentError(self, f"{option_string} may not be repeated")
        setattr(namespace, self.dest, True)


def build_gate_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="tui_benchmark.py gate", description="Evaluate an aggregate benchmark gate")
    parser.add_argument(
        "--policy",
        choices=("pre-shell-v1", "shell-v1", "full-v1"),
        required=True,
        action=_RejectDuplicateAction,
    )
    for key in ("dark", "light", "none", "cold", "malformed", "late"):
        parser.add_argument(f"--{key}", type=Path, action=_RejectDuplicateAction)
    parser.add_argument("--output", type=Path, required=True, action=_RejectDuplicateAction)
    return parser


def build_gate_phase_delta_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="tui_benchmark.py gate-phase-delta",
        description="Evaluate one phase delta benchmark gate",
    )
    parser.add_argument(
        "--policy",
        choices=("single-deferral-v1",),
        required=True,
        action=_RejectDuplicateAction,
    )
    parser.add_argument("--phase", required=True, action=_RejectDuplicateAction)
    parser.add_argument("--before", type=Path, required=True, action=_RejectDuplicateAction)
    parser.add_argument("--before-full-gate", type=Path, required=True, action=_RejectDuplicateAction)
    parser.add_argument("--after", type=Path, required=True, action=_RejectDuplicateAction)
    parser.add_argument("--full-gate", type=Path, required=True, action=_RejectDuplicateAction)
    parser.add_argument("--output", type=Path, required=True, action=_RejectDuplicateAction)
    return parser


def build_decide_bootstrap_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="tui_benchmark.py decide-bootstrap",
        description="Make one core bootstrap consolidation decision",
    )
    parser.add_argument(
        "--policy",
        choices=("core-bootstrap-v1",),
        required=True,
        action=_RejectDuplicateAction,
    )
    parser.add_argument("--candidate-artifact", type=Path, required=True, action=_RejectDuplicateAction)
    parser.add_argument("--gate-report", type=Path, required=True, action=_RejectDuplicateAction)
    parser.add_argument("--input", type=Path, required=True, action=_RejectDuplicateAction)
    parser.add_argument("--output", type=Path, required=True, action=_RejectDuplicateAction)
    return parser


def build_preserve_bootstrap_decision_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="tui_benchmark.py preserve-bootstrap-decision",
        description="Preserve one reviewed core bootstrap implement decision",
    )
    parser.add_argument(
        "--policy",
        choices=("core-bootstrap-v1",),
        required=True,
        action=_RejectDuplicateAction,
    )
    parser.add_argument(
        "--expect",
        choices=("implement",),
        required=True,
        action=_RejectDuplicateAction,
    )
    parser.add_argument(
        "--privacy-review-approved",
        required=True,
        default=None,
        action=_RejectDuplicateFlagAction,
    )
    parser.add_argument("--source", type=Path, required=True, action=_RejectDuplicateAction)
    parser.add_argument("--candidate-artifact", type=Path, required=True, action=_RejectDuplicateAction)
    parser.add_argument("--gate-report", type=Path, required=True, action=_RejectDuplicateAction)
    parser.add_argument("--input", type=Path, required=True, action=_RejectDuplicateAction)
    parser.add_argument("--output", type=Path, required=True, action=_RejectDuplicateAction)
    parser.add_argument("--sha256-output", type=Path, required=True, action=_RejectDuplicateAction)
    return parser


def build_gate_bootstrap_adoption_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="tui_benchmark.py gate-bootstrap-adoption",
        description="Evaluate the core bootstrap adoption gate",
    )
    parser.add_argument(
        "--policy",
        choices=("core-bootstrap-adoption-v1",),
        required=True,
        action=_RejectDuplicateAction,
    )
    parser.add_argument("--decision-artifact", type=Path, required=True, action=_RejectDuplicateAction)
    parser.add_argument("--after", type=Path, required=True, action=_RejectDuplicateAction)
    parser.add_argument("--full-gate", type=Path, required=True, action=_RejectDuplicateAction)
    parser.add_argument("--output", type=Path, required=True, action=_RejectDuplicateAction)
    return parser


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--label", required=True, help="scenario label written to every JSONL record")
    parser.add_argument(
        "--state-root",
        type=Path,
        default=REPO_ROOT / "tmp" / "tui-startup-state",
        help="parent for isolated run state (default: %(default)s)",
    )
    parser.add_argument("--keep-state", action="store_true", help="preserve this run's isolated state directory")
    parser.add_argument("--output", type=Path, help="JSONL output path (default: stdout)")
    parser.add_argument("--force", action="store_true", help="replace an existing --output file")
    parser.add_argument("--cwd", type=Path, default=REPO_ROOT, help="child working directory (default: repo root)")
    parser.add_argument("--samples", type=int, required=True)
    parser.add_argument("--mode", choices=("warm", "cold-like"), required=True)
    parser.add_argument("--timeout", type=float, default=12.0, help="per-launch timeout in seconds")
    parser.add_argument("--theme-response", type=parse_theme_response, default=ThemeFixture("dark"))
    parser.add_argument(
        "--interaction-probe",
        action="store_true",
        help="verify accepted textarea input, persistence, and exact removal",
    )
    parser.add_argument("--ready-text", default=DEFAULT_READY_TEXT)
    parser.add_argument("command", nargs=argparse.REMAINDER, help="command, optionally preceded by --")
    return parser


def legacy_main(argv: Optional[Sequence[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        parser.error("command required")
    if args.samples < 1:
        parser.error("--samples must be at least 1")
    if args.timeout <= 0:
        parser.error("--timeout must be positive")
    cwd = args.cwd.resolve()
    if not cwd.is_dir():
        parser.error(f"--cwd is not a directory: {cwd}")

    state_parent = args.state_root.resolve()
    state_parent.mkdir(parents=True, exist_ok=True)
    safe_label = re.sub(r"[^A-Za-z0-9_.-]+", "-", args.label).strip("-") or "run"
    run_root = Path(tempfile.mkdtemp(prefix=f"{safe_label}-", dir=state_parent))
    stream: Optional[TextIO] = None
    close_stream = False
    results: list[dict[str, Any]] = []
    try:
        stream, close_stream = open_output(args.output, args.force)
        if args.mode == "warm":
            state = run_root / "shared"
            prepare_state(state)
            seed = run_once(
                command,
                state,
                cwd,
                args.timeout,
                args.theme_response,
                args.ready_text.encode(),
                getattr(args, "interaction_probe", False),
            )
            write_record(stream, {"label": args.label, "mode": args.mode, "seed": seed})

        for index in range(args.samples):
            if args.mode == "cold-like":
                state = run_root / f"sample-{index:03d}"
                prepare_state(state)
            result = run_once(
                command,
                state,
                cwd,
                args.timeout,
                args.theme_response,
                args.ready_text.encode(),
                getattr(args, "interaction_probe", False),
            )
            result["sample"] = index + 1
            results.append(result)
            write_record(stream, {"label": args.label, "mode": args.mode, **result})

        valid = [item for item in results if item["failure"] is None]
        summary: dict[str, Any] = {
            "label": args.label,
            "mode": args.mode,
            "samples": len(results),
            "valid": len(valid),
        }
        for field in (
            "ready_ms",
            "ttfd_ms",
            "first_byte_ms",
            "first_frame_ms",
            "shell_ms",
            "prompt_ms",
            "critical_ready_ms",
            "theme_settled_ms",
            "interactive_ms",
        ):
            values = [item[field] for item in valid if item[field] is not None]
            if not values:
                summary[field] = None
                continue
            summary[field] = {
                "min": min(values),
                "median": statistics.median(values),
                "mean": statistics.mean(values),
                "p90": percentile(values, 0.90),
                "p95": percentile(values, 0.95),
                "max": max(values),
                "stdev": statistics.stdev(values) if len(values) > 1 else 0,
            }
        write_record(stream, {"summary": summary})
        return 0 if len(valid) == len(results) else 1
    finally:
        try:
            if close_stream and stream is not None:
                stream.close()
        finally:
            if args.keep_state:
                print(f"preserved state: {run_root}", file=sys.stderr)
            else:
                shutil.rmtree(run_root, ignore_errors=True)


def preserve_main(argv: Sequence[str]) -> int:
    args = build_preserve_parser().parse_args(argv)
    try:
        preserve_artifact(
            args.name,
            args.binary,
            args.build_command,
            args.shell_capability,
            args.output,
        )
    except ArtifactFailure as error:
        print(f"preserve failed: {error.code}", file=sys.stderr)
        return 1
    return 0


def compare_main(argv: Sequence[str]) -> int:
    args = build_compare_parser().parse_args(argv)
    try:
        return run_comparison(args)
    except (ArtifactFailure, CompareFailure) as error:
        print(f"compare failed: {error.code}", file=sys.stderr)
        return 1


def gate_main(argv: Sequence[str]) -> int:
    import benchmark_gate

    args = build_gate_parser().parse_args(argv)
    inputs = {
        key: value
        for key in ("dark", "light", "none", "cold", "malformed", "late")
        if (value := getattr(args, key)) is not None
    }
    try:
        return benchmark_gate.run_gate(args.policy, inputs, args.output)
    except benchmark_gate.GateFailure as error:
        print(f"gate failed: {error.code}", file=sys.stderr)
        return 1


def gate_phase_delta_main(argv: Sequence[str]) -> int:
    import benchmark_gate

    args = build_gate_phase_delta_parser().parse_args(argv)
    try:
        return benchmark_gate.run_phase_delta(
            args.phase,
            args.before,
            args.after,
            args.before_full_gate,
            args.full_gate,
            args.output,
        )
    except benchmark_gate.GateFailure as error:
        print(f"gate failed: {error.code}", file=sys.stderr)
        return 1


def decide_bootstrap_main(argv: Sequence[str]) -> int:
    import bootstrap_decision

    args = build_decide_bootstrap_parser().parse_args(argv)
    try:
        return bootstrap_decision.run_decision(
            args.policy,
            args.candidate_artifact,
            args.gate_report,
            args.input,
            args.output,
        )
    except bootstrap_decision.DecisionFailure as error:
        print(f"bootstrap decision failed: {error.code}", file=sys.stderr)
        return 1


def preserve_bootstrap_decision_main(argv: Sequence[str]) -> int:
    import bootstrap_decision

    args = build_preserve_bootstrap_decision_parser().parse_args(argv)
    try:
        bootstrap_decision.preserve_implement_decision(
            args.policy,
            args.expect,
            args.privacy_review_approved,
            args.source,
            args.candidate_artifact,
            args.gate_report,
            args.input,
            args.output,
            args.sha256_output,
        )
    except bootstrap_decision.DecisionFailure as error:
        print(f"bootstrap decision preservation failed: {error.code}", file=sys.stderr)
        return 1
    return 0


def gate_bootstrap_adoption_main(argv: Sequence[str]) -> int:
    import bootstrap_decision

    args = build_gate_bootstrap_adoption_parser().parse_args(argv)
    try:
        return bootstrap_decision.run_adoption(
            args.policy,
            args.decision_artifact,
            args.after,
            args.full_gate,
            args.output,
        )
    except bootstrap_decision.DecisionFailure as error:
        print(f"bootstrap adoption gate failed: {error.code}", file=sys.stderr)
        return 1


def main(argv: Optional[Sequence[str]] = None) -> int:
    arguments = list(sys.argv[1:] if argv is None else argv)
    if arguments[:1] == ["preserve"]:
        return preserve_main(arguments[1:])
    if arguments[:1] == ["compare"]:
        return compare_main(arguments[1:])
    if arguments[:1] == ["gate"]:
        return gate_main(arguments[1:])
    if arguments[:1] == ["gate-phase-delta"]:
        return gate_phase_delta_main(arguments[1:])
    if arguments[:1] == ["decide-bootstrap"]:
        return decide_bootstrap_main(arguments[1:])
    if arguments[:1] == ["preserve-bootstrap-decision"]:
        return preserve_bootstrap_decision_main(arguments[1:])
    if arguments[:1] == ["gate-bootstrap-adoption"]:
        return gate_bootstrap_adoption_main(arguments[1:])
    return legacy_main(arguments)


if __name__ == "__main__":
    raise SystemExit(main())
