#!/usr/bin/env python3
"""Content-free fake TUI used by the startup milestone harness tests."""

import argparse
import fcntl
import json
import os
import re
import select
import struct
import subprocess
import sys
import termios
import time
from pathlib import Path
from typing import Optional


WIDTH = 100
HEIGHT = 30
PROMPT = "Ask anything..."
PROMPT_ROW = 15
PROMPT_COLUMN = 16
PROBE_PREFIX = "oc2latency"
PROBE_BODY_LENGTH = len(PROBE_PREFIX) + 32
SUPERVISION_ENV = "OC2_TUI_BENCHMARK_SUPERVISION_TOKEN"


class TraceWriter:
    def __init__(self, fragmented: bool):
        self.fd = int(os.environ["OC2_TUI_STARTUP_PROFILE_FD"])
        self.run_id = os.environ["OC2_RUN_ID"]
        self.fragmented = fragmented
        self.sequence = 0
        self.origin = time.monotonic()

    def close(self) -> None:
        if self.fd >= 0:
            os.close(self.fd)
            self.fd = -1

    def emit(self, event: str, **fields: object) -> None:
        record = {
            "version": 2,
            "runID": self.run_id,
            "sequence": self.sequence,
            "elapsedMs": (time.monotonic() - self.origin) * 1000,
            "event": event,
            **fields,
        }
        self.sequence += 1
        data = (json.dumps(record, separators=(",", ":")) + "\n").encode("utf-8")
        if not self.fragmented:
            _write_all(self.fd, data)
            return
        first = max(1, len(data) // 3)
        second = max(first + 1, (2 * len(data)) // 3)
        for chunk in (data[:first], data[first:second], data[second:]):
            _write_all(self.fd, chunk)
            time.sleep(0.002)


def _write_all(fd: int, data: bytes) -> None:
    view = memoryview(data)
    while view:
        try:
            written = os.write(fd, view)
        except InterruptedError:
            continue
        if written <= 0:
            raise OSError("write made no progress")
        view = view[written:]


def _write_pty(data: bytes, fragmented: bool = False) -> None:
    if not fragmented:
        _write_all(1, data)
        return
    cuts = (1, 3, 8, 13, 21, 34, 55)
    offset = 0
    for size in cuts:
        if offset >= len(data):
            break
        _write_all(1, data[offset : offset + size])
        offset += size
        time.sleep(0.002)
    if offset < len(data):
        _write_all(1, data[offset:])


def _position(row: int, column: int) -> bytes:
    return f"\x1b[{row + 1};{column + 1}H".encode("ascii")


def _frame(prompt: bool = True, prompt_column: int = PROMPT_COLUMN) -> bytes:
    body = bytearray(b"\x1b[?1049h\x1b[?2026h\x1b[2J\x1b[H")
    body.extend(b"Time to first draw: 12.5ms")
    body.extend(b"\x1b[10;47HOC2")
    if prompt:
        body.extend(_position(PROMPT_ROW, prompt_column) + PROMPT.encode("ascii") + b' "Fix a TODO in the codebase"')
    body.extend(b"\x1b[?2026l")
    return bytes(body)


def _redraw_prompt(value: str) -> bytes:
    visible = value if value else PROMPT + ' "Fix a TODO in the codebase"'
    return (
        b"\x1b[?2026h"
        + _position(PROMPT_ROW, PROMPT_COLUMN)
        + b"\x1b[K"
        + visible.encode("ascii")
        + b"\x1b[?2026l"
    )


class InputParser:
    def __init__(self):
        self.pending = bytearray()

    def feed(self, data: bytes) -> tuple[bytes, tuple[bytes, ...]]:
        self.pending.extend(data)
        ordinary = bytearray()
        payloads: list[bytes] = []
        while self.pending:
            start = self.pending.find(b"\x1b]")
            if start < 0:
                keep = 1 if self.pending[-1:] == b"\x1b" else 0
                if len(self.pending) > keep:
                    if keep:
                        ordinary.extend(self.pending[:-keep])
                        del self.pending[:-keep]
                    else:
                        ordinary.extend(self.pending)
                        self.pending.clear()
                break
            if start > 0:
                ordinary.extend(self.pending[:start])
                del self.pending[:start]
            end = None
            terminator = 0
            for index in range(2, len(self.pending)):
                if self.pending[index] == 0x07:
                    end = index
                    terminator = 1
                    break
                if self.pending[index] == 0x1B and index + 1 < len(self.pending):
                    if self.pending[index + 1] == ord("\\"):
                        end = index
                        terminator = 2
                        break
            if end is None:
                if len(self.pending) > 512:
                    self.pending.clear()
                break
            payloads.append(bytes(self.pending[2:end]))
            del self.pending[: end + terminator]
        return bytes(ordinary), tuple(payloads)


def _set_noecho_input() -> None:
    attributes = termios.tcgetattr(0)
    attributes[0] &= ~(termios.ICRNL | termios.IXON)
    attributes[3] &= ~(termios.ECHO | termios.ICANON | termios.IEXTEN)
    attributes[6][termios.VMIN] = 0
    attributes[6][termios.VTIME] = 0
    termios.tcsetattr(0, termios.TCSANOW, attributes)


def _set_adversarial_echo_input() -> None:
    attributes = termios.tcgetattr(0)
    attributes[0] &= ~(termios.ICRNL | termios.IXON)
    attributes[3] &= ~(termios.ICANON | termios.IEXTEN)
    attributes[3] |= termios.ECHO
    attributes[6][termios.VMIN] = 0
    attributes[6][termios.VTIME] = 0
    termios.tcsetattr(0, termios.TCSANOW, attributes)


def _theme_pair(responses: dict[int, bytes]) -> Optional[str]:
    foreground = responses.get(10)
    background = responses.get(11)
    if (foreground, background) == (b"ffff/ffff/ffff", b"0000/0000/0000"):
        return "dark"
    if (foreground, background) == (b"0000/0000/0000", b"ffff/ffff/ffff"):
        return "light"
    return None


def _probe_queries(terminator: str) -> tuple[bytes, bytes]:
    ending = b"\x07" if terminator == "bel" else b"\x1b\\"
    return b"\x1b]10;?" + ending, b"\x1b]11;?" + ending


def _run_probe(trace: TraceWriter, args: argparse.Namespace) -> int:
    if args.leave_echo_enabled:
        _set_adversarial_echo_input()
    else:
        _set_noecho_input()
    capture = {
        "body_shape_valid": False,
        "body_byte_count": 0,
        "guard_count": 0,
        "backspace_count": 0,
        "enter_count": 0,
        "other_control_count": 0,
        "theme_pair": None,
        "input_mode": "noncanonical-echo" if args.leave_echo_enabled else "noncanonical-noecho",
        "renderer_token_redraw_count": 0,
        "echo_disabled_before_removal": False,
    }
    parser = InputParser()
    responses: dict[int, bytes] = {}
    text = ""
    received_printable = bytearray()
    accepted = False
    critical_emitted = False
    settled_outcome: Optional[str] = "resolved" if args.force_marker_before_response else None
    reconciled = False
    boundary_reconcile_at: Optional[float] = None
    erase_at: Optional[float] = None
    try:
        if not args.suppress_theme_queries:
            for query in _probe_queries(args.query_terminator):
                if args.query_fragmented:
                    for value in query:
                        _write_pty(bytes((value,)))
                        time.sleep(0.001)
                else:
                    _write_pty(query)
        if args.force_marker_before_response:
            trace.emit(
                "theme.settled",
                role="main",
                workspaceGeneration=0,
                attemptGeneration=0,
                outcome="resolved",
            )
        if args.leave_echo_enabled:
            trace.emit("prompt.mounted", role="main", workspaceGeneration=0, attemptGeneration=0)
            time.sleep(0.01)
            _write_pty(
                _frame()
                + b"\x1b[?2026h"
                + _position(PROMPT_ROW, PROMPT_COLUMN)
                + b"\x1b[K\x1b[?2026l"
                + _position(PROMPT_ROW, PROMPT_COLUMN)
            )
        elif args.prompt_order == "marker-first":
            trace.emit("prompt.mounted", role="main", workspaceGeneration=0, attemptGeneration=0)
            time.sleep(0.01)
            _write_pty(_frame())
        else:
            _write_pty(_frame())
            time.sleep(0.01)
            trace.emit("prompt.mounted", role="main", workspaceGeneration=0, attemptGeneration=0)

        origin = time.monotonic()
        critical_at = origin + args.critical_delay_ms / 1000
        settle_at = origin + args.theme_timeout_ms / 1000
        while True:
            now = time.monotonic()
            if not critical_emitted and now >= critical_at:
                trace.emit("bootstrap.critical.ready", role="main", workspaceGeneration=0, attemptGeneration=0)
                critical_emitted = True
            pair = _theme_pair(responses)
            if settled_outcome is None and pair is not None:
                trace.emit(
                    "theme.settled",
                    role="main",
                    workspaceGeneration=0,
                    attemptGeneration=0,
                    outcome="resolved",
                )
                settled_outcome = "resolved"
                capture["theme_pair"] = pair
            elif settled_outcome is None and now >= settle_at:
                outcome = "resolved" if args.force_early_resolved else "fallback-final"
                trace.emit(
                    "theme.settled",
                    role="main",
                    workspaceGeneration=0,
                    attemptGeneration=0,
                    outcome=outcome,
                )
                settled_outcome = outcome
            elif settled_outcome == "fallback-final" and pair is not None and not reconciled:
                trace.emit("theme.reconciled", role="main", workspaceGeneration=0, attemptGeneration=0)
                capture["theme_pair"] = pair
                reconciled = True
                if args.input_behavior == "reconcile-erase":
                    text = ""
                if not args.suppress_reconcile_redraw:
                    time.sleep(0.01)
                    _write_pty(_redraw_prompt(text))
                    if args.reconcile_near_persistence_boundary:
                        boundary_reconcile_at = time.monotonic() + 0.095
            if boundary_reconcile_at is not None and now >= boundary_reconcile_at:
                trace.emit("theme.reconciled", role="main", workspaceGeneration=0, attemptGeneration=0)
                boundary_reconcile_at = None
                time.sleep(0.01)
                _write_pty(_redraw_prompt(text))
            if erase_at is not None and now >= erase_at:
                text = ""
                _write_pty(_redraw_prompt(text))
                erase_at = None

            readable, _, _ = select.select([0], [], [], 0.005)
            if not readable:
                continue
            data = os.read(0, 4096)
            if not data:
                continue
            ordinary, payloads = parser.feed(data)
            for payload in payloads:
                match = re.fullmatch(rb"(10|11);rgb:([0-9a-f]{4}/[0-9a-f]{4}/[0-9a-f]{4})", payload)
                if match is not None:
                    responses[int(match.group(1))] = match.group(2)

            redraw = False
            for value in ordinary:
                if value == 0x7F:
                    capture["backspace_count"] += 1
                    if text:
                        text = text[:-1]
                        redraw = True
                    continue
                if value in (0x0A, 0x0D):
                    capture["enter_count"] += 1
                    continue
                if value < 0x20:
                    capture["other_control_count"] += 1
                    continue
                received_printable.append(value)
                if len(received_printable) <= PROBE_BODY_LENGTH:
                    capture["body_byte_count"] += 1
                if args.input_behavior == "reject":
                    continue
                character = chr(value)
                text += character
                if not accepted and len(text) == PROBE_BODY_LENGTH:
                    body_valid = re.fullmatch(r"oc2latency[0-9a-f]{32}", text) is not None
                    capture["body_shape_valid"] = body_valid
                    if body_valid:
                        generation = 1 if args.input_behavior == "stale" else 0
                        trace.emit(
                            "input.accepted",
                            role="main",
                            workspaceGeneration=0,
                            attemptGeneration=generation,
                        )
                        accepted = True
                        if args.input_behavior == "echo-lookalike":
                            _write_pty(
                                b"\x1b[?2026h"
                                + _position(1, 1)
                                + text.encode("ascii")
                                + b"\x1b[?2026l"
                            )
                        elif not args.leave_echo_enabled:
                            redraw = True
                            if args.enable_echo_before_guard:
                                _set_adversarial_echo_input()
                            if args.input_behavior == "erase":
                                erase_at = time.monotonic() + 0.03
                elif accepted and len(text) == PROBE_BODY_LENGTH + 1:
                    if character == "z":
                        capture["guard_count"] += 1
                        if args.leave_echo_enabled:
                            _set_noecho_input()
                            capture["echo_disabled_before_removal"] = True
                        elif args.enable_echo_before_removal:
                            _set_adversarial_echo_input()
                    if not args.leave_echo_enabled:
                        redraw = True
            if redraw and args.input_behavior not in ("echo-lookalike", "reject"):
                visible = "changed" if args.input_behavior == "bad-restore" and not text else text
                if visible.startswith(PROBE_PREFIX):
                    capture["renderer_token_redraw_count"] += 1
                _write_pty(_redraw_prompt(visible))
    except KeyboardInterrupt:
        return 0
    finally:
        if args.capture_file is not None:
            args.capture_file.write_text(json.dumps(capture, separators=(",", ":")), encoding="utf-8")


def _erased_before_commit() -> bytes:
    return (
        b"\x1b[?1049h\x1b[?2026h\x1b[2J\x1b[H"
        b"Time to first draw: 12.5ms"
        + _position(PROMPT_ROW, PROMPT_COLUMN)
        + PROMPT.encode("ascii")
        + b"\x1b[2J\x1b[HOC2 loading\x1b[?2026l"
    )


def _fatal_frame() -> bytes:
    return b"\x1b[?1049h\x1b[?2026h\x1b[2J\x1b[HError: private fixture detail\x1b[?2026l"


def _malformed_ttfd_frame() -> bytes:
    return (
        b"\x1b[?1049h\x1b[?2026h\x1b[2J\x1b[HTime to first draw: 1..2ms"
        + _position(PROMPT_ROW, PROMPT_COLUMN)
        + PROMPT.encode("ascii")
        + b' "Fix a TODO in the codebase"\x1b[?2026l'
    )


def _markers(trace: TraceWriter) -> None:
    generation = {"role": "main", "workspaceGeneration": 0, "attemptGeneration": 0}
    trace.emit("prompt.mounted", **generation)
    trace.emit("bootstrap.critical.ready", **generation)
    trace.emit("theme.settled", **generation, outcome="resolved")


def _geometry_ok() -> bool:
    value = fcntl.ioctl(0, termios.TIOCGWINSZ, struct.pack("HHHH", 0, 0, 0, 0))
    rows, columns, _, _ = struct.unpack("HHHH", value)
    return (columns, rows) == (WIDTH, HEIGHT)


def _spawn_descendant(pid_file: Path, escaped: bool = False) -> None:
    program = (
        "import signal,time;"
        "signal.signal(signal.SIGINT,signal.SIG_IGN);"
        "signal.signal(signal.SIGTERM,signal.SIG_IGN);"
        "time.sleep(60)"
    )
    child = subprocess.Popen(
        [sys.executable, "-c", program],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=escaped,
    )
    pid_file.write_text(
        f"{child.pid} {os.getpgid(child.pid)} {os.getsid(child.pid)}",
        encoding="ascii",
    )


def _spawn_signal_spawner(pid_file: Path, spawned_pid_file: Path) -> None:
    leaf = (
        "import signal,time;"
        "signal.signal(signal.SIGINT,signal.SIG_IGN);"
        "signal.signal(signal.SIGTERM,signal.SIG_IGN);"
        "time.sleep(60)"
    )
    program = "\n".join(
        (
            "import os,signal,subprocess,sys,time",
            f"path={str(spawned_pid_file)!r}",
            f"leaf={leaf!r}",
            "def term(*_):",
            " child=subprocess.Popen([sys.executable,'-c',leaf],stdin=subprocess.DEVNULL,"
            "stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)",
            " open(path,'w',encoding='ascii').write(f'{child.pid} {os.getpgid(child.pid)} {os.getsid(child.pid)}')",
            " raise SystemExit(0)",
            "signal.signal(signal.SIGTERM,term)",
            "time.sleep(60)",
        )
    )
    child = subprocess.Popen(
        [sys.executable, "-c", program],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    pid_file.write_text(f"{child.pid} {os.getpgid(child.pid)} {os.getsid(child.pid)}", encoding="ascii")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "mode",
        choices=(
            "success-fragmented",
            "success-marker-first",
            "success-frame-first",
            "success-descendant",
            "success-escaped-descendant",
            "success-signal-spawn-descendant",
            "early-exit-descendant",
            "early-exit-escaped-descendant",
            "timeout-escaped-descendant",
            "exception-escaped-descendant",
            "paint-erase",
            "raw-only",
            "early-exit",
            "timeout",
            "pty-eof",
            "trace-eof",
            "unknown-sequence",
            "desynchronized",
            "fatal-frame",
            "malformed-ttfd",
            "misaligned-prompt",
            "probe",
        ),
    )
    parser.add_argument("--pid-file", type=Path)
    parser.add_argument("--token-file", type=Path)
    parser.add_argument("--spawned-pid-file", type=Path)
    parser.add_argument("--exit-delay-ms", type=int, default=120)
    parser.add_argument("--capture-file", type=Path)
    parser.add_argument("--query-terminator", choices=("bel", "st"), default="bel")
    parser.add_argument("--query-fragmented", action="store_true")
    parser.add_argument("--suppress-theme-queries", action="store_true")
    parser.add_argument("--suppress-reconcile-redraw", action="store_true")
    parser.add_argument("--reconcile-near-persistence-boundary", action="store_true")
    parser.add_argument("--leave-echo-enabled", action="store_true")
    parser.add_argument("--enable-echo-before-guard", action="store_true")
    parser.add_argument("--enable-echo-before-removal", action="store_true")
    parser.add_argument("--force-early-resolved", action="store_true")
    parser.add_argument("--force-marker-before-response", action="store_true")
    parser.add_argument("--prompt-order", choices=("marker-first", "frame-first"), default="frame-first")
    parser.add_argument(
        "--input-behavior",
        choices=(
            "normal",
            "reject",
            "echo-lookalike",
            "erase",
            "stale",
            "reconcile-erase",
            "bad-restore",
        ),
        default="normal",
    )
    parser.add_argument("--critical-delay-ms", type=int, default=100)
    parser.add_argument("--theme-timeout-ms", type=int, default=60)
    args = parser.parse_args()
    if args.token_file is not None:
        args.token_file.write_text(os.environ[SUPERVISION_ENV], encoding="ascii")
    fragmented = args.mode == "success-fragmented"
    trace = TraceWriter(fragmented=fragmented)
    trace.emit("cli.entry", role="main")

    if not _geometry_ok():
        return 64
    if args.mode == "probe":
        return _run_probe(trace, args)
    if args.mode == "early-exit-descendant":
        if args.pid_file is None:
            return 65
        program = (
            "import signal,time;"
            "signal.signal(signal.SIGINT,signal.SIG_IGN);"
            "signal.signal(signal.SIGTERM,signal.SIG_IGN);"
            "time.sleep(60)"
        )
        child = subprocess.Popen([sys.executable, "-c", program], close_fds=False)
        args.pid_file.write_text(str(child.pid), encoding="ascii")
        return 7
    if args.mode == "early-exit-escaped-descendant":
        if args.pid_file is None:
            return 65
        _spawn_descendant(args.pid_file, escaped=True)
        time.sleep(args.exit_delay_ms / 1000)
        return 7
    if args.mode == "early-exit":
        return 7
    if args.mode == "timeout":
        time.sleep(60)
        return 0
    if args.mode == "timeout-escaped-descendant":
        if args.pid_file is None:
            return 65
        _spawn_descendant(args.pid_file, escaped=True)
        time.sleep(60)
        return 0
    if args.mode == "pty-eof":
        os.close(0)
        os.close(1)
        os.close(2)
        time.sleep(60)
        return 0
    if args.mode == "trace-eof":
        trace.close()
        _write_pty(_frame(prompt=False))
        time.sleep(60)
        return 0
    if args.mode == "unknown-sequence":
        _write_pty(b"\x1b[?9999h")
        time.sleep(60)
        return 0
    if args.mode == "desynchronized":
        _markers(trace)
        _write_pty(b"\x1b[?2026h" + PROMPT.encode("ascii"))
        time.sleep(60)
        return 0
    if args.mode == "fatal-frame":
        _markers(trace)
        _write_pty(_fatal_frame())
        time.sleep(60)
        return 0
    if args.mode == "malformed-ttfd":
        _markers(trace)
        _write_pty(_malformed_ttfd_frame())
        time.sleep(60)
        return 0
    if args.mode == "misaligned-prompt":
        _markers(trace)
        _write_pty(_frame(prompt_column=PROMPT_COLUMN + 1))
        time.sleep(60)
        return 0
    if args.mode == "paint-erase":
        _write_pty(_frame())
        _write_pty(b"\x1b[?2026h\x1b[2J\x1b[HOC2 loading\x1b[?2026l")
        time.sleep(0.025)
        _markers(trace)
        time.sleep(60)
        return 0
    if args.mode == "raw-only":
        _write_pty(_erased_before_commit())
        _markers(trace)
        time.sleep(60)
        return 0

    if args.mode == "success-descendant":
        if args.pid_file is None:
            return 65
        _spawn_descendant(args.pid_file)
    if args.mode in ("success-escaped-descendant", "exception-escaped-descendant"):
        if args.pid_file is None:
            return 65
        _spawn_descendant(args.pid_file, escaped=True)
    if args.mode == "success-signal-spawn-descendant":
        if args.pid_file is None or args.spawned_pid_file is None:
            return 65
        _spawn_signal_spawner(args.pid_file, args.spawned_pid_file)
    if args.mode == "exception-escaped-descendant":
        _write_pty(_frame(prompt=False))
        time.sleep(60)
        return 0
    if args.mode in ("success-marker-first", "success-fragmented"):
        _markers(trace)
        time.sleep(0.025)
        _write_pty(_frame(), fragmented=fragmented)
    else:
        _write_pty(_frame())
        time.sleep(0.025)
        _markers(trace)
    time.sleep(60)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
