#!/usr/bin/env python3
"""Measure OC2 TUI startup through a controlled pseudo-terminal."""

import argparse
import json
import os
import re
import select
import shutil
import signal
import statistics
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Optional, Sequence, TextIO

from terminal_screen import PtyHandshakeError, spawn_pty


REPO_ROOT = Path(__file__).resolve().parents[2]
TTFD = re.compile(rb"Time to first draw:\s*([0-9.]+)ms")
DEFAULT_READY_TEXT = "Ask anything..."
CONTROLLED_ENV = {
    "TERM": "xterm-256color",
    "COLORTERM": "truecolor",
    "OC2_PURE": "1",
    "OC2_SHOW_TTFD": "1",
    "OC2_DISABLE_MODELS_FETCH": "1",
    "OC2_DISABLE_AUTOUPDATE": "1",
    "OC2_DISABLE_MOUSE": "1",
    "OC2_DISABLE_TERMINAL_TITLE": "1",
    "OC2_DISABLE_PROJECT_CONFIG": "1",
}


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


def wait_for_child(pid: int, timeout: float) -> Optional[int]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            waited, status = os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            return 0
        if waited:
            return status
        time.sleep(0.01)
    return None


def child_process_group(pid: int) -> Optional[int]:
    try:
        pgid = os.getpgid(pid)
    except ProcessLookupError:
        return None
    return pgid if pgid == pid else None


def process_group_exists(pgid: int) -> bool:
    try:
        os.killpg(pgid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return False
    return True


def wait_for_process_group(pgid: int, timeout: float) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not process_group_exists(pgid):
            return True
        time.sleep(0.01)
    return not process_group_exists(pgid)


def signal_child(pid: int, sig: signal.Signals, pgid: Optional[int]) -> None:
    try:
        if pgid is not None:
            os.killpg(pgid, sig)
        else:
            os.kill(pid, sig)
    except (ProcessLookupError, PermissionError):
        pass


def stop_child(pid: int, fd: int) -> None:
    pgid = child_process_group(pid)
    try:
        os.write(fd, b"\x03")
    except OSError:
        pass
    status = wait_for_child(pid, 0.5)
    if status is not None and (pgid is None or not process_group_exists(pgid)):
        return
    signal_child(pid, signal.SIGTERM, pgid)
    if status is None:
        status = wait_for_child(pid, 0.5)
    if pgid is not None:
        wait_for_process_group(pgid, 0.5)
    if status is not None and (pgid is None or not process_group_exists(pgid)):
        return
    signal_child(pid, signal.SIGKILL, pgid)
    if status is None:
        wait_for_child(pid, 1.0)


def run_once(
    command: Sequence[str],
    state: Path,
    cwd: Path,
    timeout: float,
    theme_response: str,
    ready_text: bytes,
) -> dict[str, Any]:
    env = child_environment(state)
    try:
        child = spawn_pty(command, cwd, env, timeout)
    except PtyHandshakeError:
        return {
            "first_byte_ms": None,
            "ready_ms": None,
            "ttfd_ms": None,
            "bytes_until_ready": 0,
            "timed_out": True,
            "pty_handshake_ok": False,
        }
    pid = child.pid
    fd = child.master_fd
    start_ns = child.start_ns

    output = bytearray()
    first_byte_ms: Optional[float] = None
    ready_ms: Optional[float] = None
    foreground_sent = False
    background_sent = False
    deadline = child.deadline
    try:
        while time.monotonic() < deadline:
            remaining = max(0.0, deadline - time.monotonic())
            readable, _, _ = select.select([fd], [], [], min(0.05, remaining))
            if not readable:
                continue
            try:
                data = os.read(fd, 65536)
            except OSError:
                break
            if not data:
                break
            now_ms = (time.perf_counter_ns() - start_ns) / 1_000_000
            if first_byte_ms is None:
                first_byte_ms = now_ms
            output.extend(data)
            if theme_response != "none" and not foreground_sent and b"\x1b]10;?\x07" in output:
                foreground = b"ffff/ffff/ffff" if theme_response == "dark" else b"0000/0000/0000"
                os.write(fd, b"\x1b]10;rgb:" + foreground + b"\x07")
                foreground_sent = True
            if theme_response != "none" and not background_sent and b"\x1b]11;?\x07" in output:
                background = b"0000/0000/0000" if theme_response == "dark" else b"ffff/ffff/ffff"
                os.write(fd, b"\x1b]11;rgb:" + background + b"\x07")
                background_sent = True
            if TTFD.search(output) and ready_text in output:
                ready_ms = now_ms
                break
    finally:
        stop_child(pid, fd)
        os.close(fd)

    match = TTFD.search(output)
    return {
        "first_byte_ms": first_byte_ms,
        "ready_ms": ready_ms,
        "ttfd_ms": float(match.group(1)) if match else None,
        "bytes_until_ready": len(output),
        "timed_out": ready_ms is None,
        "pty_handshake_ok": True,
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

        valid = [item for item in results if not item["timed_out"]]
        summary: dict[str, Any] = {
            "label": args.label,
            "mode": args.mode,
            "samples": len(results),
            "valid": len(valid),
        }
        for field in ("ready_ms", "ttfd_ms", "first_byte_ms"):
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
        if close_stream and stream is not None:
            stream.close()
        if args.keep_state:
            print(f"preserved state: {run_root}", file=sys.stderr)
        else:
            shutil.rmtree(run_root, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
