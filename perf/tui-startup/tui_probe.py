#!/usr/bin/env python3
"""Capture timestamped raw startup output from a command running in a PTY."""

import argparse
import json
import os
import re
import select
import shutil
import sys
import tempfile
import time
from pathlib import Path
from typing import Optional, Sequence, Union

from terminal_screen import PtyHandshakeError, close_pty_fd, read_pty, spawn_pty, stop_pty_child


REPO_ROOT = Path(__file__).resolve().parents[2]
ANSI = re.compile(rb"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|[PX^_].*?\x1b\\|.)", re.DOTALL)
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


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--timeout", type=float, default=4.0)
    parser.add_argument("--raw", type=Path, required=True, help="raw PTY output path")
    parser.add_argument("--force", action="store_true", help="replace an existing --raw file")
    parser.add_argument("--cwd", type=Path, default=REPO_ROOT, help="child working directory (default: repo root)")
    parser.add_argument(
        "--state-root",
        type=Path,
        default=REPO_ROOT / "tmp" / "tui-startup-state",
        help="parent for isolated run state (default: %(default)s)",
    )
    parser.add_argument("--keep-state", action="store_true")
    parser.add_argument("command", nargs=argparse.REMAINDER, help="command, optionally preceded by --")
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    command: Sequence[str] = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        parser.error("command required")
    if args.timeout <= 0:
        parser.error("--timeout must be positive")
    cwd = args.cwd.resolve()
    if not cwd.is_dir():
        parser.error(f"--cwd is not a directory: {cwd}")
    raw = args.raw.resolve()
    if raw.exists() and not args.force:
        parser.error(f"--raw already exists (pass --force to replace): {raw}")
    raw.parent.mkdir(parents=True, exist_ok=True)

    state_parent = args.state_root.resolve()
    state_parent.mkdir(parents=True, exist_ok=True)
    state = Path(tempfile.mkdtemp(prefix="probe-", dir=state_parent))
    chunks: list[dict[str, Union[float, int]]] = []
    output = bytearray()
    status = 0
    pid: Optional[int] = None
    fd: Optional[int] = None
    try:
        for name in ("home", "data", "cache", "config"):
            (state / name).mkdir()

        try:
            child = spawn_pty(command, cwd, child_environment(state), args.timeout)
        except PtyHandshakeError as error:
            print(f"PTY startup invalid: {error}", file=sys.stderr)
            return 1
        pid = child.pid
        fd = child.master_fd
        start_ns = child.start_ns
        deadline = child.deadline
        while time.monotonic() < deadline:
            remaining = max(0.0, deadline - time.monotonic())
            readable, _, _ = select.select([fd], [], [], min(0.05, remaining))
            if not readable:
                continue
            data = read_pty(fd)
            if not data:
                break
            chunks.append({"ms": (time.perf_counter_ns() - start_ns) / 1_000_000, "bytes": len(data)})
            output.extend(data)
    finally:
        try:
            if pid is not None and pid > 0 and fd is not None:
                try:
                    status = stop_pty_child(pid, fd)
                finally:
                    close_pty_fd(fd)
        finally:
            if args.keep_state:
                print(f"preserved state: {state}", file=sys.stderr)
            else:
                shutil.rmtree(state, ignore_errors=True)

    try:
        with raw.open("wb" if args.force else "xb") as handle:
            handle.write(output)
    except FileExistsError:
        parser.error(f"--raw already exists (pass --force to replace): {raw}")
    cleaned = ANSI.sub(b"", bytes(output)).replace(b"\x00", b"")
    print(json.dumps({"status": os.waitstatus_to_exitcode(status), "bytes": len(output), "chunks": chunks}))
    print(cleaned.decode("utf-8", errors="replace"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
