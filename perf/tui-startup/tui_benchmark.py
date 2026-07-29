#!/usr/bin/env python3
"""Measure OC2 TUI startup through a controlled pseudo-terminal."""

import argparse
import ctypes
import errno
import json
import math
import os
import re
import secrets
import select
import signal
import shutil
import statistics
import struct
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Callable, Optional, Sequence, TextIO

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
TTFD = re.compile(rb"Time to first draw:\s*([0-9.]+)ms")
DEFAULT_READY_TEXT = "Ask anything..."
PROMPT_ROW = 15
PROMPT_COLUMN = 16
HOME_PLACEHOLDERS = (
    'Ask anything... "Fix a TODO in the codebase"',
    'Ask anything... "What is the tech stack of this project?"',
    'Ask anything... "Fix broken tests"',
)
TRACE_VERSION = 1
TRACE_MAX_LINE_BYTES = 512
TRACE_MAX_RECORDS = 512
LEGACY_SCAN_LIMIT = 4 * 1024 * 1024
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
_TTFD_LINE = re.compile(r"^Time to first draw:\s*[0-9.]+ms$")
_FATAL_PREFIXES = (
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


def _safe_integer(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= (1 << 53) - 1


def _finite_nonnegative(value: object) -> bool:
    if not isinstance(value, (int, float)) or isinstance(value, bool) or value < 0:
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def _exact_keys(record: dict[str, object], *event_keys: str) -> bool:
    common = {"version", "runID", "sequence", "elapsedMs"}
    return set(record) == common.union(event_keys)


def _valid_trace_record(record: object) -> bool:
    """Validate the exact accepted Slice 1 trace schema without retaining content."""

    if not isinstance(record, dict) or any(not isinstance(key, str) for key in record):
        return False
    if record.get("version") != TRACE_VERSION:
        return False
    run_id = record.get("runID")
    if (
        not isinstance(run_id, str)
        or not run_id
        or len(run_id.encode("utf-8")) > 128
        or re.fullmatch(r"[0-9A-Za-z_-]+", run_id) is None
    ):
        return False
    if not _safe_integer(record.get("sequence")) or not _finite_nonnegative(record.get("elapsedMs")):
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
            and _finite_nonnegative(record.get("durationMs"))
        )
    if event == "rpc.request":
        return (
            role == "main"
            and _exact_keys(record, "event", "role", "requestID", "request", "encodedBytes")
            and _safe_integer(record.get("requestID"))
            and isinstance(record.get("request"), str)
            and record.get("request") in TRACE_REQUESTS
            and _safe_integer(record.get("encodedBytes"))
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
            and _safe_integer(record.get("requestID"))
            and isinstance(record.get("request"), str)
            and record.get("request") in TRACE_REQUESTS
            and _safe_integer(record.get("encodedBytes"))
            and record.get("removableDuplicateBytes") == 0
        )
    if event == "rpc.dispatch":
        return (
            role == "worker"
            and _exact_keys(record, "event", "role", "requestID", "request", "durationMs")
            and _safe_integer(record.get("requestID"))
            and isinstance(record.get("request"), str)
            and record.get("request") in TRACE_REQUESTS
            and _finite_nonnegative(record.get("durationMs"))
        )
    if event in ("prompt.mounted", "bootstrap.critical.ready", "input.accepted", "theme.reconciled"):
        return (
            role == "main"
            and _exact_keys(record, "event", "role", "workspaceGeneration", "attemptGeneration")
            and record.get("workspaceGeneration") == 0
            and record.get("attemptGeneration") == 0
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
            and record.get("workspaceGeneration") == 0
            and record.get("attemptGeneration") == 0
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
                    parse_constant=lambda _: (_ for _ in ()).throw(TraceFailure("trace_invalid_json")),
                )
            except TraceFailure:
                raise
            except (UnicodeDecodeError, json.JSONDecodeError, TypeError, ValueError):
                raise TraceFailure("trace_invalid_json") from None
            if not _valid_trace_record(record):
                raise TraceFailure("trace_invalid_schema")
            assert isinstance(record, dict)
            if record["runID"] != self.run_id:
                raise TraceFailure("trace_run_id_mismatch")
            if record["sequence"] != self._sequence:
                raise TraceFailure("trace_sequence_mismatch")
            if (self._sequence == 0) != (record["event"] == "cli.entry"):
                raise TraceFailure("trace_event_order")
            self._sequence += 1
            self.records += 1
            if self.records > TRACE_MAX_RECORDS:
                raise TraceFailure("trace_record_limit")
            parsed.append((record, receipt_ms))
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


def prepare_state(root: Path) -> None:
    for name in ("home", "data", "cache", "config"):
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
        "interactive_ms": None,
        "run_id": run_id,
        "workspace_generation": None,
        "attempt_generation": None,
        "trace_records": 0,
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
    """Observe leader exit without reaping it before process-group cleanup."""

    def __init__(self, pid: int):
        self.pid = pid
        self._exited = False
        self._kqueue: Any = None
        self.available = hasattr(os, "waitid") and hasattr(os, "WNOWAIT")
        if not self.available and hasattr(select, "kqueue"):
            queue = None
            try:
                queue = select.kqueue()
                event = select.kevent(
                    pid,
                    filter=select.KQ_FILTER_PROC,
                    flags=select.KQ_EV_ADD | select.KQ_EV_ENABLE | select.KQ_EV_CLEAR,
                    fflags=select.KQ_NOTE_EXIT,
                )
                queue.control([event], 0, 0)
                self._kqueue = queue
                self.available = True
            except OSError as error:
                if error.errno == errno.ESRCH:
                    self._exited = True
                    self.available = True
                try:
                    if queue is not None:
                        queue.close()
                except OSError:
                    pass
            except ValueError:
                try:
                    if queue is not None:
                        queue.close()
                except OSError:
                    pass

    def exited(self) -> bool:
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
        if self._kqueue is not None:
            try:
                self._exited = bool(self._kqueue.control(None, 1, 0))
            except OSError:
                pass
        return self._exited

    def close(self) -> None:
        if self._kqueue is None:
            return
        try:
            self._kqueue.close()
        except OSError:
            pass
        self._kqueue = None


ProcessIdentity = tuple[int, int]


def _numeric_process_table() -> dict[int, tuple[int, int, int, int]]:
    result = subprocess.run(
        ["ps", "-axo", "pid=,ppid=,pgid=,sess=,uid="],
        check=False,
        capture_output=True,
        text=True,
        timeout=0.5,
    )
    if result.returncode != 0:
        raise OSError("numeric process snapshot failed")
    table: dict[int, tuple[int, int, int, int]] = {}
    for line in result.stdout.splitlines():
        parts = line.split()
        if len(parts) != 5:
            raise OSError("numeric process snapshot was malformed")
        try:
            pid, parent, group, session, uid = (int(part) for part in parts)
        except ValueError:
            raise OSError("numeric process snapshot was malformed") from None
        if pid <= 0 or parent < 0 or group < 0 or session < 0:
            raise OSError("numeric process snapshot was malformed")
        table[pid] = (parent, group, session, uid)
    return table


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
    for pid, (_, group, session, uid) in table.items():
        if uid != os.getuid() or pid == os.getpid():
            continue
        environment = (
            _darwin_process_environment(pid)
            if sys.platform == "darwin"
            else _linux_process_environment(pid)
        )
        if expected in environment:
            matches[pid] = (group, session)
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
                for pid, (parent, group, session, _) in table.items():
                    if pid in known or parent not in known:
                        continue
                    known.add(pid)
                    self._records[pid] = (group, session)
                    changed = True
            for pid in tuple(self._records):
                current = table.get(pid)
                if current is not None:
                    self._records[pid] = (current[1], current[2])

    def _run(self) -> None:
        while not self._stop.is_set():
            self._scan()
            self._stop.wait(self.interval)

    def scan_now(self) -> None:
        self._scan()

    def finish(self) -> tuple[dict[int, ProcessIdentity], bool]:
        self._stop.set()
        self._thread.join(0.75)
        if self._thread.is_alive():
            with self._lock:
                self._failed = True
        self._scan()
        with self._lock:
            return dict(self._records), self._failed


def _pid_exists(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _group_exists(group: int) -> bool:
    try:
        os.killpg(group, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _signal_tracked(records: dict[int, ProcessIdentity], sig: signal.Signals) -> bool:
    ok = True
    own_group = os.getpgrp()
    groups = {group for group, _ in records.values() if group > 1 and group != own_group}
    for group in groups:
        try:
            os.killpg(group, sig)
        except ProcessLookupError:
            pass
        except PermissionError:
            ok = False
    for pid in records:
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


def _tracked_gone(records: dict[int, ProcessIdentity], reap_pid: Optional[int] = None) -> bool:
    _reap_direct_child(reap_pid)
    own_group = os.getpgrp()
    if any(_pid_exists(pid) for pid in records):
        return False
    groups = {group for group, _ in records.values() if group > 1 and group != own_group}
    return not any(_group_exists(group) for group in groups)


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


def _emergency_token_cleanup(
    token: str,
    root_pid: int,
    root_identity: ProcessIdentity,
    known_records: Optional[dict[int, ProcessIdentity]] = None,
) -> tuple[bool, bool]:
    records = dict(known_records or {})
    enumeration_ok = True
    try:
        records.update(_token_processes(token))
    except OSError:
        enumeration_ok = False
    if _pid_exists(root_pid):
        records[root_pid] = root_identity
    return enumeration_ok, _terminate_records(records, reap_pid=root_pid)


def _terminal_failure(screen: TerminalScreen, eof: bool = False) -> str:
    reason = screen.invalid_reason or ""
    if "synchronized" in reason:
        return "terminal_desynchronized"
    if eof and ("truncated" in reason or "EOF" in reason):
        return "terminal_eof_truncated"
    if reason.startswith("unsupported") or "unsupported" in reason:
        return "terminal_unknown_sequence"
    return "terminal_invalid_sequence"


def run_once(
    command: Sequence[str],
    state: Path,
    cwd: Path,
    timeout: float,
    theme_response: str,
    ready_text: bytes,
) -> dict[str, Any]:
    env = child_environment(state)
    run_id = "run_" + secrets.token_hex(16)
    supervision_token = "supervision_" + secrets.token_hex(24)
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
    root_identity: ProcessIdentity = (pid, pid)
    assert trace_read_fd is not None and trace_write_fd is not None
    exit_observer = ChildExitObserver(pid)
    descendants = DescendantSupervisor(pid)
    descendants.start()
    records: dict[int, ProcessIdentity] = {}
    try:
        os.close(trace_write_fd)
    except BaseException:
        try:
            stop_pty_child(pid, fd)
        finally:
            try:
                try:
                    records, _ = descendants.finish()
                    records.update(_token_processes(supervision_token))
                    _cleanup_tracked_descendants(records)
                finally:
                    _emergency_token_cleanup(supervision_token, pid, root_identity, records)
            finally:
                try:
                    close_pty_fd(fd)
                finally:
                    try:
                        os.close(trace_read_fd)
                    finally:
                        exit_observer.close()
        raise
    trace_write_fd = None

    screen = TerminalScreen(PTY_WIDTH, PTY_HEIGHT)
    trace = TraceJsonlParser(run_id)
    oracle = StartupMilestoneOracle(_prompt_matcher)
    legacy_output = bytearray()
    total_pty_bytes = 0
    bytes_until_ready: Optional[int] = None
    first_byte_ms: Optional[float] = None
    ready_ms: Optional[float] = None
    ttfd_ms: Optional[float] = None
    theme_scan = bytearray()
    foreground_sent = False
    background_sent = False
    deadline = child.deadline
    failure: Optional[str] = None if exit_observer.available else "child_exit_observer_failed"
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
    try:
        while failure is None and not oracle.complete:
            if pty_eof_deadline is not None and trace_eof_deadline is not None:
                failure = "child_exited_early"
                break
            now = time.monotonic()
            if pty_eof_deadline is not None and now >= pty_eof_deadline:
                failure = "pty_eof_before_milestones"
                break
            if trace_eof_deadline is not None and now >= trace_eof_deadline:
                failure = "trace_eof_before_milestones"
                break
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                failure = oracle.timeout_failure(screen)
                break
            watched = []
            if pty_open:
                watched.append(fd)
            if trace_open:
                watched.append(trace_read_fd)
            eof_remaining = [
                value - time.monotonic()
                for value in (pty_eof_deadline, trace_eof_deadline)
                if value is not None
            ]
            wait = min([0.05, remaining, *eof_remaining])
            readable, _, _ = select.select(watched, [], [], max(0.0, wait))
            if not readable:
                if exit_observer.exited():
                    failure = "child_exited_early"
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
                        records = trace.feed(data, now_ms)
                    except TraceFailure as error:
                        failure = error.code
                        break
                    for record, receipt_ms in records:
                        oracle.observe_trace(record, receipt_ms)
                        if oracle.failure is not None:
                            failure = oracle.failure
                            break
                    if failure is not None:
                        break
                    continue

                data = read_pty(fd)
                now_ms = (time.perf_counter_ns() - start_ns) / 1_000_000
                if not data:
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
                theme_scan.extend(data)
                if ready_ms is None:
                    legacy_output.extend(data)
                    if len(legacy_output) > LEGACY_SCAN_LIMIT:
                        failure = "pty_output_limit"
                        break
                    match = TTFD.search(legacy_output)
                    if match is not None and ttfd_ms is None:
                        ttfd_ms = float(match.group(1))
                    if match is not None and ready_text in legacy_output:
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
                if failure is not None:
                    break
                if theme_response != "none" and not foreground_sent and b"\x1b]10;?\x07" in theme_scan:
                    foreground = b"ffff/ffff/ffff" if theme_response == "dark" else b"0000/0000/0000"
                    os.write(fd, b"\x1b]10;rgb:" + foreground + b"\x07")
                    foreground_sent = True
                if theme_response != "none" and not background_sent and b"\x1b]11;?\x07" in theme_scan:
                    background = b"0000/0000/0000" if theme_response == "dark" else b"ffff/ffff/ffff"
                    os.write(fd, b"\x1b]11;rgb:" + background + b"\x07")
                    background_sent = True
                if len(theme_scan) > 64:
                    del theme_scan[:-64]
            if failure is None and exit_observer.exited():
                failure = "child_exited_early"
        if failure is None and oracle.failure is not None:
            failure = oracle.failure
    except BaseException as error:
        body_error = error
    finally:
        try:
            exit_observer.close()
        finally:
            try:
                descendants.scan_now()
                try:
                    stop_pty_child(pid, fd)
                except BaseException as error:
                    cleanup_error = error
            finally:
                try:
                    records, descendant_tracking_failed = descendants.finish()
                    records.update(_token_processes(supervision_token))
                    if cleanup_error is None:
                        descendant_cleanup_ok = _cleanup_tracked_descendants(records)
                    else:
                        descendant_cleanup_ok = False
                except BaseException:
                    descendant_tracking_failed = True
                    descendant_cleanup_ok = False
                finally:
                    try:
                        emergency_enumeration_ok, emergency_cleanup_ok = _emergency_token_cleanup(
                            supervision_token,
                            pid,
                            root_identity,
                            records,
                        )
                    except BaseException:
                        emergency_enumeration_ok = False
                        emergency_cleanup_ok = False
                    finally:
                        try:
                            close_pty_fd(fd)
                        except BaseException as error:
                            close_error = error
                        try:
                            os.close(trace_read_fd)
                        except OSError as error:
                            if error.errno != errno.EBADF and close_error is None:
                                close_error = error

    if body_error is not None:
        if cleanup_error is not None:
            raise cleanup_error
        if (
            descendant_tracking_failed
            or not descendant_cleanup_ok
            or not emergency_enumeration_ok
            or not emergency_cleanup_ok
        ):
            raise PtyCleanupError("tracked TUI descendant cleanup failed")
        if close_error is not None:
            raise close_error
        raise body_error
    if cleanup_error is not None:
        if isinstance(cleanup_error, PtyCleanupError):
            failure = "descendant_cleanup_failed"
        else:
            raise cleanup_error
    if descendant_tracking_failed:
        failure = "descendant_tracking_failed"
    if not descendant_cleanup_ok:
        failure = "descendant_cleanup_failed"
    if not emergency_enumeration_ok:
        failure = "descendant_tracking_failed"
    if not emergency_cleanup_ok:
        failure = "descendant_cleanup_failed"
    if close_error is not None:
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
        "first_frame_ms": oracle.first_frame_ms,
        "shell_ms": oracle.shell_ms,
        "prompt_ms": oracle.prompt_ms,
        "critical_ready_ms": oracle.critical_ready_ms,
        "theme_settled_ms": oracle.theme_settled_ms,
        "interactive_ms": None,
        "run_id": run_id,
        "workspace_generation": oracle.workspace_generation,
        "attempt_generation": oracle.attempt_generation,
        "trace_records": trace.records,
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
    parser.add_argument("--theme-response", choices=("dark", "light", "none"), default="dark")
    parser.add_argument("--ready-text", default=DEFAULT_READY_TEXT)
    parser.add_argument("command", nargs=argparse.REMAINDER, help="command, optionally preceded by --")
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
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
            seed = run_once(command, state, cwd, args.timeout, args.theme_response, args.ready_text.encode())
            write_record(stream, {"label": args.label, "mode": args.mode, "seed": seed})

        for index in range(args.samples):
            if args.mode == "cold-like":
                state = run_root / f"sample-{index:03d}"
                prepare_state(state)
            result = run_once(command, state, cwd, args.timeout, args.theme_response, args.ready_text.encode())
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


if __name__ == "__main__":
    raise SystemExit(main())
