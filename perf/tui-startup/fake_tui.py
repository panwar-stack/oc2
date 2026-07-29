#!/usr/bin/env python3
"""Content-free fake TUI used by the startup milestone harness tests."""

import argparse
import fcntl
import json
import os
import struct
import subprocess
import sys
import termios
import time
from pathlib import Path


WIDTH = 100
HEIGHT = 30
PROMPT = "Ask anything..."
PROMPT_ROW = 15
PROMPT_COLUMN = 16
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
            "version": 1,
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
            "misaligned-prompt",
        ),
    )
    parser.add_argument("--pid-file", type=Path)
    parser.add_argument("--token-file", type=Path)
    parser.add_argument("--exit-delay-ms", type=int, default=120)
    args = parser.parse_args()
    if args.token_file is not None:
        args.token_file.write_text(os.environ[SUPERVISION_ENV], encoding="ascii")
    fragmented = args.mode == "success-fragmented"
    trace = TraceWriter(fragmented=fragmented)
    trace.emit("cli.entry", role="main")

    if not _geometry_ok():
        return 64
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
