#!/usr/bin/env python3
"""Fail-closed PTY startup handshake and terminal cell oracle.

The screen model intentionally implements the control surface emitted by the
OpenTUI renderer. It is not a general-purpose terminal emulator. Unsupported
state-changing sequences, malformed UTF-8, truncated input, and synchronized
output desynchronization invalidate the model instead of guessing.
"""

import errno
import fcntl
import os
import pty
import select
import signal
import struct
import termios
import time
from dataclasses import dataclass
from pathlib import Path
from typing import List, Mapping, NoReturn, Optional, Sequence, Tuple

from unicode_tables_17_0_0 import (
    EMOJI_MODIFIER_BASE_RANGES as _U17_EMOJI_MODIFIER_BASE_RANGES,
    EMOJI_VARIATION_BASE_RANGES as _U17_EMOJI_VARIATION_BASE_RANGES,
    EXTENDED_PICTOGRAPHIC_RANGES,
    GCB_CONTROL_RANGES,
    GRAPHEME_EXTEND_RANGES,
    UNASSIGNED_RANGES,
    WIDE_OR_FULLWIDTH_RANGES,
)


PTY_WIDTH = 100
PTY_HEIGHT = 30
_HANDSHAKE_READY = b"R"
_HANDSHAKE_ERROR = b"E"
_CONTINUATION = None
_KEYCAP_BASES = frozenset("#*0123456789")


class PtyHandshakeError(RuntimeError):
    """Raised when the slave geometry or exec-boundary handshake is untrusted."""

    def __init__(self, message: str, pid: Optional[int] = None, master_fd: Optional[int] = None):
        super().__init__(message)
        self.pid = pid
        self.master_fd = master_fd


class PtyCleanupError(RuntimeError):
    """Raised when a PTY child or its process group cannot be proven gone."""


@dataclass(frozen=True)
class PtyProcess:
    pid: int
    master_fd: int
    start_ns: int
    deadline: float


def read_pty(fd: int, size: int = 65536) -> bytes:
    """Read a PTY, treating only EIO and a zero-byte read as EOF."""

    while True:
        try:
            return os.read(fd, size)
        except InterruptedError:
            continue
        except OSError as error:
            if error.errno == errno.EIO:
                return b""
            raise


def _wait_for_child(pid: int, timeout: float) -> Optional[int]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            waited, status = os.waitpid(pid, os.WNOHANG)
        except InterruptedError:
            continue
        except ChildProcessError:
            return 0
        if waited:
            return status
        time.sleep(0.01)
    while True:
        try:
            waited, status = os.waitpid(pid, os.WNOHANG)
        except InterruptedError:
            continue
        except ChildProcessError:
            return 0
        if waited:
            return status
        break
    return None


def _child_process_group(pid: int) -> Optional[int]:
    try:
        pgid = os.getpgid(pid)
    except ProcessLookupError:
        return None
    except PermissionError as error:
        raise PtyCleanupError("permission denied while identifying PTY process group") from error
    return pgid if pgid == pid else None


def _process_group_exists(pgid: int) -> bool:
    try:
        os.killpg(pgid, 0)
    except ProcessLookupError:
        return False
    except PermissionError as error:
        raise PtyCleanupError("permission denied while probing PTY process group") from error
    return True


def _wait_for_process_group(pgid: int, timeout: float) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not _process_group_exists(pgid):
            return True
        time.sleep(0.01)
    return not _process_group_exists(pgid)


def _signal_child(pid: int, sig: signal.Signals, pgid: Optional[int]) -> None:
    try:
        if pgid is not None:
            os.killpg(pgid, sig)
        else:
            os.kill(pid, sig)
    except ProcessLookupError:
        return
    except PermissionError as error:
        raise PtyCleanupError("permission denied while signaling PTY child") from error


def stop_pty_child(pid: int, fd: Optional[int]) -> int:
    """Stop and reap a PTY child, proving its process group disappeared."""

    pgid = _child_process_group(pid)
    if fd is not None:
        try:
            os.write(fd, b"\x03")
        except OSError:
            pass
    status = _wait_for_child(pid, 1.0)
    group_gone = pgid is None or not _process_group_exists(pgid)
    if status is not None and group_gone:
        return status

    _signal_child(pid, signal.SIGTERM, pgid)
    if status is None:
        status = _wait_for_child(pid, 1.0)
    group_gone = pgid is None or _wait_for_process_group(pgid, 0.5)
    if status is not None and group_gone:
        return status

    _signal_child(pid, signal.SIGKILL, pgid)
    if status is None:
        status = _wait_for_child(pid, 1.0)
    group_gone = pgid is None or _wait_for_process_group(pgid, 1.0)
    if status is None or not group_gone:
        raise PtyCleanupError("PTY child or process group survived SIGKILL")
    return status


def _close(fd: Optional[int]) -> None:
    if fd is None:
        return
    try:
        os.close(fd)
    except InterruptedError:
        raise
    except OSError:
        pass


def _close_descriptors(*fds: Optional[int]) -> None:
    first_error: Optional[BaseException] = None
    for fd in fds:
        closed = False
        error: Optional[BaseException] = None
        for _ in range(2):
            try:
                _close(fd)
                closed = True
                break
            except BaseException as caught:
                error = caught
        if not closed and first_error is None:
            first_error = error
    if first_error is not None:
        raise first_error


def close_pty_fd(fd: int) -> None:
    """Close a PTY descriptor with bounded outer fault retries."""

    _close_descriptors(fd)


def _write_all(fd: int, value: bytes) -> None:
    view = memoryview(value)
    while view:
        try:
            written = os.write(fd, view)
        except InterruptedError:
            continue
        if written <= 0:
            raise OSError(errno.EIO, "handshake pipe write made no progress")
        view = view[written:]


def create_exec_handshake() -> Tuple[int, int]:
    """Create a pipe whose writer is guaranteed to close during successful exec."""

    read_fd, write_fd = os.pipe()
    try:
        flags = fcntl.fcntl(write_fd, fcntl.F_GETFD)
        fcntl.fcntl(write_fd, fcntl.F_SETFD, flags | fcntl.FD_CLOEXEC)
        if os.get_inheritable(write_fd):
            raise PtyHandshakeError("exec handshake writer is inheritable")
        return read_fd, write_fd
    except BaseException:
        _close_descriptors(read_fd, write_fd)
        raise


def configure_pty_slave(write_fd: int, width: int = PTY_WIDTH, height: int = PTY_HEIGHT) -> None:
    """Set and verify slave geometry, then announce that exec may proceed."""

    if width <= 0 or height <= 0 or width > 65535 or height > 65535:
        raise PtyHandshakeError("PTY geometry must fit positive unsigned shorts")
    packed = struct.pack("HHHH", height, width, 0, 0)
    fcntl.ioctl(0, termios.TIOCSWINSZ, packed)
    actual = fcntl.ioctl(0, termios.TIOCGWINSZ, struct.pack("HHHH", 0, 0, 0, 0))
    rows, columns, _, _ = struct.unpack("HHHH", actual)
    if (columns, rows) != (width, height):
        raise PtyHandshakeError(
            "PTY slave geometry mismatch before exec: expected {}x{}, got {}x{}".format(
                width, height, columns, rows
            )
        )
    _write_all(write_fd, _HANDSHAKE_READY)


def report_exec_failure(write_fd: int) -> None:
    """Best-effort child-side notification that no exec boundary was crossed."""

    try:
        _write_all(write_fd, _HANDSHAKE_ERROR)
    except BaseException:
        pass


def _exec_pty_child(
    read_fd: int,
    write_fd: int,
    command: Sequence[str],
    cwd: Path,
    env: Mapping[str, str],
    width: int,
    height: int,
) -> NoReturn:
    error: BaseException
    try:
        _close(read_fd)
        configure_pty_slave(write_fd, width, height)
        os.chdir(cwd)
        os.execvpe(command[0], list(command), dict(env))
        error = RuntimeError("execvpe returned without replacing the PTY child")
    except BaseException as caught:
        error = caught
    try:
        report_exec_failure(write_fd)
    except BaseException:
        pass
    try:
        message = "failed to launch command: {}\n".format(error).encode("utf-8", errors="replace")
        os.write(2, message[:1024])
    except BaseException:
        pass
    try:
        os._exit(127)
    except BaseException:
        raise SystemExit(127)
    raise SystemExit(127)


def await_exec_handshake(read_fd: int, timeout: float) -> None:
    """Require ready followed by CLOEXEC EOF, closing ``read_fd`` on every path."""

    if timeout <= 0:
        _close_descriptors(read_fd)
        raise PtyHandshakeError("timed out before PTY exec handshake")
    deadline = time.monotonic() + timeout
    ready = False
    try:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise PtyHandshakeError("timed out waiting for PTY exec handshake EOF")
            try:
                readable, _, _ = select.select([read_fd], [], [], remaining)
            except InterruptedError:
                continue
            if not readable:
                raise PtyHandshakeError("timed out waiting for PTY exec handshake EOF")
            try:
                data = os.read(read_fd, 16)
            except InterruptedError:
                continue
            if not data:
                if not ready:
                    raise PtyHandshakeError("PTY child closed handshake before ready")
                return
            for value in data:
                byte = bytes((value,))
                if byte == _HANDSHAKE_READY and not ready:
                    ready = True
                    continue
                if byte == _HANDSHAKE_ERROR:
                    raise PtyHandshakeError("PTY child failed before exec")
                raise PtyHandshakeError("invalid PTY exec handshake protocol")
    finally:
        _close_descriptors(read_fd)


def _reap_after_failed_spawn(pid: int, master_fd: int) -> None:
    try:
        _close_descriptors(master_fd)
    finally:
        stop_pty_child(pid, None)


def spawn_pty(
    command: Sequence[str],
    cwd: Path,
    env: Mapping[str, str],
    timeout: float,
    width: int = PTY_WIDTH,
    height: int = PTY_HEIGHT,
) -> PtyProcess:
    """Fork a PTY whose slave is truthfully sized before the executable starts."""

    if not command:
        raise ValueError("command required")
    if timeout <= 0:
        raise ValueError("timeout must be positive")
    if width <= 0 or height <= 0 or width > 65535 or height > 65535:
        raise ValueError("PTY geometry must fit positive unsigned shorts")

    read_fd, write_fd = create_exec_handshake()
    start_monotonic = time.monotonic()
    start_ns = time.perf_counter_ns()
    try:
        pid, master_fd = pty.fork()
    except BaseException:
        _close_descriptors(read_fd, write_fd)
        raise

    if pid == 0:
        _exec_pty_child(read_fd, write_fd, command, cwd, env, width, height)

    deadline = start_monotonic + timeout
    try:
        _close(write_fd)
        await_exec_handshake(read_fd, max(0.0, deadline - time.monotonic()))
    except BaseException as error:
        try:
            _close_descriptors(read_fd, write_fd)
        finally:
            _reap_after_failed_spawn(pid, master_fd)
        if isinstance(error, PtyHandshakeError):
            raise PtyHandshakeError(str(error), pid=pid, master_fd=master_fd) from error
        raise
    return PtyProcess(pid=pid, master_fd=master_fd, start_ns=start_ns, deadline=deadline)


Cell = Optional[str]


@dataclass(frozen=True)
class TerminalFrame:
    """An immutable, terminal-cell-derived committed frame."""

    width: int
    height: int
    cells: Tuple[Tuple[Cell, ...], ...]
    alternate: bool
    sequence: int

    def cell(self, row: int, column: int) -> Cell:
        return self.cells[row][column]

    def line(self, row: int, trim: bool = False) -> str:
        value = "".join(cell for cell in self.cells[row] if cell is not _CONTINUATION)
        return value.rstrip(" ") if trim else value

    @property
    def lines(self) -> Tuple[str, ...]:
        return tuple(self.line(row) for row in range(self.height))

    @property
    def text(self) -> str:
        return "\n".join(self.lines)

    @property
    def is_blank(self) -> bool:
        return all(cell in (" ", _CONTINUATION) for row in self.cells for cell in row)

    def contains(self, value: str) -> bool:
        return any(value in self.line(row) for row in range(self.height))


@dataclass(frozen=True)
class _CellPart:
    width: int
    height: int
    row_offset: int
    column_offset: int


@dataclass
class _Surface:
    width: int
    height: int
    rows: List[List[Cell]]
    visible: List[List[bool]]
    parts: List[List[Optional[_CellPart]]]
    cursor_row: int = 0
    cursor_column: int = 0
    saved_cursor: Optional[Tuple[int, int]] = None
    scroll_top: int = 0
    scroll_bottom: int = 0
    wrap_pending: bool = False
    last_lead: Optional[Tuple[int, int]] = None

    @classmethod
    def blank(cls, width: int, height: int) -> "_Surface":
        return cls(
            width=width,
            height=height,
            rows=[[" " for _ in range(width)] for _ in range(height)],
            visible=[[True for _ in range(width)] for _ in range(height)],
            parts=[[None for _ in range(width)] for _ in range(height)],
            scroll_bottom=height - 1,
        )


class TerminalScreen:
    """Incremental renderer-focused terminal emulator with fail-closed commits."""

    _IGNORED_PRIVATE_MODES = frozenset(
        (1, 12, 25, 1000, 1002, 1003, 1004, 1005, 1006, 1015, 1016, 2004, 2027, 2031)
    )

    def __init__(self, width: int = PTY_WIDTH, height: int = PTY_HEIGHT):
        if width <= 0 or height <= 0:
            raise ValueError("terminal geometry must be positive")
        self.width = width
        self.height = height
        self._main = _Surface.blank(width, height)
        self._alternate = _Surface.blank(width, height)
        self._alternate_active = False
        self._pending = bytearray()
        self._synchronized = False
        self._dirty = False
        self._valid = True
        self._invalid_reason: Optional[str] = None
        self._commit_sequence = 0
        self._last_frame: Optional[TerminalFrame] = None
        self._autowrap = True
        self._join_next = False
        self._concealed = False

    @property
    def valid(self) -> bool:
        return self._valid

    @property
    def invalid_reason(self) -> Optional[str]:
        return self._invalid_reason

    @property
    def synchronized(self) -> bool:
        return self._synchronized

    @property
    def alternate_active(self) -> bool:
        return self._alternate_active

    @property
    def commit_count(self) -> int:
        return self._commit_sequence

    @property
    def last_frame(self) -> Optional[TerminalFrame]:
        return self._last_frame

    @property
    def _surface(self) -> _Surface:
        return self._alternate if self._alternate_active else self._main

    def _invalidate(self, reason: str) -> None:
        if self._valid:
            self._valid = False
            self._invalid_reason = reason
        self._pending.clear()

    def _snapshot(self) -> TerminalFrame:
        surface = self._surface
        return TerminalFrame(
            width=self.width,
            height=self.height,
            cells=tuple(
                tuple(
                    cell if cell is _CONTINUATION or surface.visible[row_index][column_index] else " "
                    for column_index, cell in enumerate(row)
                )
                for row_index, row in enumerate(surface.rows)
            ),
            alternate=self._alternate_active,
            sequence=self._commit_sequence,
        )

    def _commit(self, frames: List[TerminalFrame], force: bool = False) -> None:
        if not self._valid or (not self._dirty and not force):
            return
        self._commit_sequence += 1
        frame = self._snapshot()
        self._last_frame = frame
        frames.append(frame)
        self._dirty = False

    def feed(self, data: bytes) -> Tuple[TerminalFrame, ...]:
        """Apply arbitrarily fragmented bytes and return frames committed by this call."""

        if not isinstance(data, bytes):
            raise TypeError("terminal input must be bytes")
        if not self._valid or not data:
            return ()
        starting_sequence = self._commit_sequence
        starting_frame = self._last_frame
        self._pending.extend(data)
        frames: List[TerminalFrame] = []
        self._drain(frames, allow_passthrough=True)
        if not self._valid:
            self._commit_sequence = starting_sequence
            self._last_frame = starting_frame
            return ()
        if self._valid and self._dirty and not self._synchronized:
            self._commit(frames)
        return tuple(frames)

    def _drain(self, frames: List[TerminalFrame], allow_passthrough: bool) -> None:
        while self._valid and self._pending:
            first = self._pending[0]
            if self._join_next and (first == 0x1B or first < 0x20 or first == 0x7F):
                self._invalidate("Unicode ZWJ was not followed by an extended pictographic")
                break
            if first == 0x1B:
                consumed = self._consume_escape(frames, allow_passthrough)
                if consumed == 0:
                    break
                if consumed < 0:
                    break
                del self._pending[:consumed]
                continue
            if first < 0x20 or first == 0x7F:
                del self._pending[0]
                self._control(first)
                continue
            consumed, character = self._decode_character()
            if consumed == 0:
                break
            if consumed < 0 or character is None:
                break
            del self._pending[:consumed]
            self._write_character(character)

    def finish(self) -> Tuple[TerminalFrame, ...]:
        """Declare EOF; incomplete input or an open sync transaction invalidates."""

        if not self._valid:
            return ()
        if self._pending:
            self._invalidate("truncated terminal sequence or UTF-8 at EOF")
            return ()
        if self._join_next:
            self._invalidate("dangling Unicode ZWJ at EOF")
            return ()
        if self._synchronized:
            self._invalidate("synchronized output was not committed before EOF")
            return ()
        return ()

    def resize(self, width: int, height: int) -> Tuple[TerminalFrame, ...]:
        """Resize both main and alternate surfaces, preserving top-left cells."""

        if width <= 0 or height <= 0:
            raise ValueError("terminal geometry must be positive")
        if not self._valid or (width, height) == (self.width, self.height):
            return ()
        if self._join_next:
            self._invalidate("resize during dangling Unicode ZWJ")
            return ()
        for surface in (self._main, self._alternate):
            old_width = surface.width
            old_height = surface.height
            old_rows = surface.rows
            old_visible = surface.visible
            old_parts = surface.parts
            resized = [[" " for _ in range(width)] for _ in range(height)]
            resized_visible = [[True for _ in range(width)] for _ in range(height)]
            resized_parts: List[List[Optional[_CellPart]]] = [
                [None for _ in range(width)] for _ in range(height)
            ]
            for row in range(min(height, old_height)):
                for column in range(min(width, old_width)):
                    resized[row][column] = old_rows[row][column]
                    resized_visible[row][column] = old_visible[row][column]
                    resized_parts[row][column] = old_parts[row][column]
            surface.width = width
            surface.height = height
            surface.rows = resized
            surface.visible = resized_visible
            surface.parts = resized_parts
            surface.cursor_row = min(surface.cursor_row, height - 1)
            surface.cursor_column = min(surface.cursor_column, width - 1)
            surface.scroll_top = 0
            surface.scroll_bottom = height - 1
            surface.wrap_pending = False
            surface.last_lead = None
            self._repair_multicells(surface)
        self.width = width
        self.height = height
        self._dirty = True
        frames: List[TerminalFrame] = []
        if not self._synchronized:
            self._commit(frames)
        return tuple(frames)

    def _repair_multicells(self, surface: _Surface) -> None:
        owners: dict[Tuple[int, int, int, int], List[Tuple[int, int]]] = {}
        for row in range(surface.height):
            for column in range(surface.width):
                part = surface.parts[row][column]
                if part is not None:
                    key = (
                        row - part.row_offset,
                        column - part.column_offset,
                        part.width,
                        part.height,
                    )
                    owners.setdefault(key, []).append((row, column))
                elif surface.rows[row][column] is _CONTINUATION:
                    surface.rows[row][column] = " "
                    surface.visible[row][column] = True
        for (lead_row, lead_column, width, height), actual in owners.items():
            expected = {
                (lead_row + row_offset, lead_column + column_offset)
                for row_offset in range(height)
                for column_offset in range(width)
            }
            valid = (
                lead_row >= 0
                and lead_column >= 0
                and lead_row + height <= surface.height
                and lead_column + width <= surface.width
                and set(actual) == expected
            )
            if valid:
                for row, column in expected:
                    part = surface.parts[row][column]
                    if part is None or (
                        row - part.row_offset,
                        column - part.column_offset,
                        part.width,
                        part.height,
                    ) != (lead_row, lead_column, width, height):
                        valid = False
                        break
            if valid:
                continue
            for row, column in actual:
                surface.rows[row][column] = " "
                surface.visible[row][column] = True
                surface.parts[row][column] = None

    def _decode_character(self) -> Tuple[int, Optional[str]]:
        first = self._pending[0]
        if first < 0x80:
            return 1, chr(first)
        if 0xC2 <= first <= 0xDF:
            length = 2
        elif 0xE0 <= first <= 0xEF:
            length = 3
        elif 0xF0 <= first <= 0xF4:
            length = 4
        else:
            self._invalidate("invalid UTF-8 leading byte")
            return -1, None
        if len(self._pending) < length:
            return 0, None
        value = bytes(self._pending[:length])
        try:
            return length, value.decode("utf-8", errors="strict")
        except UnicodeDecodeError:
            self._invalidate("invalid UTF-8 sequence")
            return -1, None

    def _consume_escape(self, frames: List[TerminalFrame], allow_passthrough: bool) -> int:
        if len(self._pending) < 2:
            return 0
        kind = self._pending[1]
        if kind == ord("["):
            for index in range(2, len(self._pending)):
                value = self._pending[index]
                if 0x40 <= value <= 0x7E:
                    body = bytes(self._pending[2:index]).decode("ascii")
                    final = chr(value)
                    self._csi(body, final, frames)
                    return index + 1
                if not 0x20 <= value <= 0x3F:
                    self._invalidate("malformed CSI sequence")
                    return -1
            return 0
        if kind in (ord("]"), ord("P"), ord("_")):
            allow_bel = kind == ord("]")
            index = 2
            while index < len(self._pending):
                value = self._pending[index]
                if allow_bel and value == 0x07:
                    payload = bytes(self._pending[2:index])
                    self._string_escape(kind, payload, frames, allow_passthrough)
                    return index + 1
                if value == 0x1B:
                    if index + 1 >= len(self._pending):
                        return 0
                    if kind == ord("P") and self._pending[index + 1] == 0x1B:
                        index += 2
                        continue
                    if (
                        kind == ord("P")
                        and self._pending[index + 1] != ord("\\")
                        and not bytes(self._pending[2:index]).startswith(b"tmux;")
                    ):
                        index += 1
                        continue
                    if self._pending[index + 1] != ord("\\"):
                        self._invalidate("malformed terminal string escape")
                        return -1
                    payload = bytes(self._pending[2:index])
                    self._string_escape(kind, payload, frames, allow_passthrough)
                    return index + 2
                index += 1
            return 0
        single = chr(kind)
        if single in ("7", "8", "c", "D", "E", "M", "=", ">"):
            self._escape_single(single)
            return 2
        if single in ("(", ")", "*", "+", "#"):
            if len(self._pending) < 3:
                return 0
            self._invalidate("unsupported terminal character-set or alignment mutation")
            return -1
        self._invalidate("unsupported ESC sequence")
        return -1

    def _string_escape(
        self,
        kind: int,
        payload: bytes,
        frames: List[TerminalFrame],
        allow_passthrough: bool,
    ) -> None:
        if kind == ord("]"):
            self._osc(payload)
            return
        if kind == ord("P"):
            if payload.startswith((b"+q", b"$q", b">q")):
                return
            if payload.startswith(b"tmux;"):
                self._passthrough(payload[5:], frames, allow_passthrough, require_doubled=True)
                return
            if payload.startswith(b"\x1b"):
                self._passthrough(payload, frames, allow_passthrough, require_doubled=False)
                return
        if kind == ord("_") and payload == b"Gi=31337,s=1,v=1,a=q,t=d,f=24;AAAA":
            return
        self._invalidate("unsupported terminal string command")

    def _passthrough(
        self,
        payload: bytes,
        frames: List[TerminalFrame],
        allowed: bool,
        require_doubled: bool,
    ) -> None:
        if not allowed:
            self._invalidate("nested terminal passthrough")
            return
        doubled = require_doubled or payload.startswith(b"\x1b\x1b")
        inner = bytearray()
        if doubled:
            index = 0
            while index < len(payload):
                value = payload[index]
                if value == 0x1B:
                    if index + 1 >= len(payload) or payload[index + 1] != 0x1B:
                        self._invalidate("malformed terminal passthrough escaping")
                        return
                    inner.append(value)
                    index += 2
                    continue
                inner.append(value)
                index += 1
        else:
            inner.extend(payload)
        if not inner or inner[0] != 0x1B:
            self._invalidate("unproven terminal passthrough payload")
            return
        outer_pending = self._pending
        self._pending = inner
        try:
            self._drain(frames, allow_passthrough=False)
            if self._valid and self._pending:
                self._invalidate("truncated terminal passthrough payload")
        finally:
            if not self._valid:
                outer_pending.clear()
            self._pending = outer_pending

    def _osc(self, payload: bytes) -> None:
        if payload.startswith(b"66;"):
            self._explicit_width_osc(payload)
            return
        if payload in (
            b"10;?",
            b"11;?",
            b"12;?",
            b"13;?",
            b"14;?",
            b"15;?",
            b"16;?",
            b"17;?",
            b"19;?",
            b"99;i=opentui-notifications:p=?;",
            b"1337;Capabilities",
        ):
            return
        if payload.startswith(b"4;"):
            parts = payload.split(b";")
            canonical_index = parts[1] == b"0" or (
                parts[1][:1] in b"123456789" and parts[1].isdigit()
            )
            if len(parts) == 3 and canonical_index and parts[2] == b"?":
                index = int(parts[1])
                if 0 <= index <= 255:
                    return
        self._invalidate("unsupported or mutating OSC payload")

    def _explicit_width_osc(self, payload: bytes) -> None:
        parts = payload.split(b";", 2)
        if len(parts) != 3 or parts[0] != b"66":
            self._invalidate("malformed explicit-width OSC")
            return
        option = parts[1]
        if option == b"s=2":
            if parts[2] != b" ":
                self._invalidate("unsupported scaled-text OSC payload")
                return
            self._write_glyph(" ", 2, 2)
            return
        if option not in (b"w=1", b"w=2"):
            self._invalidate("unsupported explicit-width OSC option")
            return
        try:
            width = int(option[2:])
            text = parts[2].decode("utf-8", errors="strict")
        except (UnicodeDecodeError, ValueError):
            self._invalidate("malformed explicit-width OSC payload")
            return
        if not text or not all(_is_safe_osc66_scalar(character) for character in text):
            self._invalidate("unsupported explicit-width OSC geometry")
            return
        self._write_glyph(text, width)

    def _escape_single(self, value: str) -> None:
        surface = self._surface
        if value == "7":
            surface.saved_cursor = (surface.cursor_row, surface.cursor_column)
            return
        if value == "8":
            self._restore_cursor(surface)
            return
        if value == "c":
            self._main = _Surface.blank(self.width, self.height)
            self._alternate = _Surface.blank(self.width, self.height)
            self._alternate_active = False
            self._autowrap = True
            self._join_next = False
            self._concealed = False
            self._dirty = True
            return
        if value == "D":
            self._line_feed(surface)
            return
        if value == "E":
            self._line_feed(surface)
            surface.cursor_column = 0
            return
        if value == "M":
            self._reverse_index(surface)
            return
        # Application/keypad modes do not mutate terminal cells.

    def _csi(self, body: str, final: str, frames: List[TerminalFrame]) -> None:
        private = ""
        if body[:1] in ("<", "=", ">", "?"):
            private, body = body[0], body[1:]
        split = len(body)
        while split > 0 and " " <= body[split - 1] <= "/":
            split -= 1
        params_text = body[:split]
        intermediate = body[split:]
        if any(not ("0" <= value <= "?") for value in params_text):
            self._invalidate("malformed CSI parameters")
            return

        if final == "m" and not private and not intermediate:
            self._sgr(params_text)
            return
        if final == "m" and private == ">" and not intermediate:
            params = self._params(params_text)
            if params in ([4, 0], [4, 1]):
                return
            self._invalidate("unsupported modifyOtherKeys mutation")
            return

        if final in ("h", "l") and not intermediate:
            self._set_modes(private, params_text, final == "h", frames)
            return

        if private or intermediate:
            if final == "q" and private == ">" and not intermediate:
                params = self._params(params_text)
                if params in ([], [0]):
                    return
            if final == "q" and not private and intermediate == " ":
                params = self._params(params_text)
                if params is not None and len(params) <= 1:
                    return
            if final == "p" and private == "?" and intermediate == "$":
                params = self._params(params_text)
                if params is not None and len(params) == 1 and params[0] in (1004, 1016, 2004, 2026, 2027, 2031):
                    return
            if final == "u" and private in (">", "<", "?") and not intermediate:
                params = self._params(params_text)
                if params is not None and len(params) <= 1:
                    return
            if final == "c" and private in ("=", ">", "?") and not intermediate:
                params = self._params(params_text)
                if params is not None:
                    return
            if final == "n" and private == "?" and not intermediate:
                params = self._params(params_text)
                if params is not None and len(params) == 1 and params[0] in (6, 996, 997):
                    return
            if final == "S" and private == "?" and not intermediate:
                params = self._params(params_text)
                if params == [2, 1, 0]:
                    return
            self._invalidate("unsupported private or intermediate CSI sequence")
            return

        params = self._params(params_text)
        if params is None:
            self._invalidate("malformed numeric CSI parameters")
            return
        surface = self._surface
        if final in ("H", "f"):
            if len(params) > 2:
                self._invalidate("too many cursor-position parameters")
                return
            row = self._parameter(params, 0, 1, zero_is_default=True)
            column = self._parameter(params, 1, 1, zero_is_default=True)
            self._move_to(surface, row - 1, column - 1)
        elif final in ("A", "B", "C", "D", "E", "F", "G", "`", "d", "a", "e"):
            if len(params) > 1:
                self._invalidate("too many cursor-movement parameters")
                return
            self._cursor_csi(surface, final, params)
        elif final == "J":
            if len(params) > 1:
                self._invalidate("too many erase-display parameters")
                return
            self._erase_display(surface, self._parameter(params, 0, 0))
        elif final == "K":
            if len(params) > 1:
                self._invalidate("too many erase-line parameters")
                return
            self._erase_line(surface, self._parameter(params, 0, 0))
        elif final == "X":
            if len(params) > 1:
                self._invalidate("too many erase-character parameters")
                return
            count = self._parameter(params, 0, 1, zero_is_default=True)
            self._erase_range(surface, surface.cursor_row, surface.cursor_column, surface.cursor_column + count - 1)
        elif final == "r":
            if len(params) > 2:
                self._invalidate("too many scroll-region parameters")
                return
            top = self._parameter(params, 0, 1, zero_is_default=True)
            bottom = self._parameter(params, 1, self.height, zero_is_default=True)
            if top < 1 or bottom > self.height or top >= bottom:
                self._invalidate("invalid scroll region")
                return
            surface.scroll_top = top - 1
            surface.scroll_bottom = bottom - 1
            self._move_to(surface, 0, 0)
        elif final in ("S", "T"):
            if len(params) > 1:
                self._invalidate("too many scroll parameters")
                return
            count = self._parameter(params, 0, 1, zero_is_default=True)
            if final == "S":
                self._scroll_up(surface, count)
            else:
                self._scroll_down(surface, count)
        elif final == "s":
            if params:
                self._invalidate("unsupported save-cursor parameters")
                return
            surface.saved_cursor = (surface.cursor_row, surface.cursor_column)
        elif final == "u":
            if params:
                self._invalidate("unsupported restore-cursor parameters")
                return
            self._restore_cursor(surface)
        elif final == "n" and len(params) == 1 and params[0] in (5, 6):
            return
        elif final == "c" and params in ([], [0]):
            return
        elif final == "t" and len(params) == 1 and params[0] in (14, 16, 18, 19):
            return
        else:
            self._invalidate("unsupported CSI sequence")

    def _params(self, value: str) -> Optional[List[Optional[int]]]:
        if value == "":
            return []
        result: List[Optional[int]] = []
        for item in value.split(";"):
            if item == "":
                result.append(None)
            elif item.isdigit():
                result.append(int(item))
            else:
                return None
        return result

    def _sgr(self, value: str) -> None:
        items = ["0"] if value == "" else value.split(";")
        index = 0
        while index < len(items):
            item = items[index]
            if ":" in item:
                parts = item.split(":")
                if not parts[0].isdigit():
                    self._invalidate("malformed colon SGR sequence")
                    return
                code = int(parts[0])
                if code not in (38, 48):
                    self._invalidate("unsupported colon SGR mutation")
                    return
                if len(parts) == 3 and parts[1] == "5" and self._color_component(parts[2]):
                    index += 1
                    continue
                if (
                    len(parts) == 6
                    and parts[1] == "2"
                    and parts[2] in ("", "0")
                    and all(self._color_component(component) for component in parts[3:])
                ):
                    index += 1
                    continue
                self._invalidate("unsupported colon SGR color")
                return
            if item == "":
                code = 0
            elif item.isdigit():
                code = int(item)
            else:
                self._invalidate("malformed SGR sequence")
                return
            if code in (38, 48):
                if index + 1 >= len(items) or not items[index + 1].isdigit():
                    self._invalidate("incomplete SGR color")
                    return
                mode = int(items[index + 1])
                if mode == 5:
                    if index + 2 >= len(items) or not self._color_component(items[index + 2]):
                        self._invalidate("invalid indexed SGR color")
                        return
                    index += 3
                    continue
                if mode == 2:
                    if index + 4 >= len(items) or not all(
                        self._color_component(component) for component in items[index + 2 : index + 5]
                    ):
                        self._invalidate("invalid RGB SGR color")
                        return
                    index += 5
                    continue
                self._invalidate("unsupported SGR color mode")
                return
            if code not in (0, 1, 2, 3, 4, 5, 7, 8, 9, 22, 23, 24, 25, 27, 28, 29, 39, 49):
                self._invalidate("unsupported SGR mutation")
                return
            if code in (0, 28):
                self._concealed = False
            elif code == 8:
                self._concealed = True
            index += 1

    def _color_component(self, value: str) -> bool:
        return value.isdigit() and 0 <= int(value) <= 255

    def _parameter(
        self,
        params: List[Optional[int]],
        index: int,
        default: int,
        zero_is_default: bool = False,
    ) -> int:
        if index >= len(params) or params[index] is None:
            return default
        value = params[index]
        assert value is not None
        if zero_is_default and value == 0:
            return default
        return value

    def _set_modes(self, private: str, value: str, enabled: bool, frames: List[TerminalFrame]) -> None:
        params = self._params(value)
        if params is None or not params or any(item is None for item in params):
            self._invalidate("malformed terminal mode sequence")
            return
        modes = [item for item in params if item is not None]
        if private == "":
            if modes != [7]:
                self._invalidate("unsupported ANSI mode mutation")
                return
            self._autowrap = enabled
            self._surface.wrap_pending = False
            return
        if private != "?":
            self._invalidate("unsupported terminal mode namespace")
            return
        for mode in modes:
            if mode == 1049:
                self._switch_alternate(enabled)
            elif mode == 2026:
                if enabled:
                    if self._synchronized:
                        self._invalidate("nested synchronized output begin")
                        return
                    if self._dirty:
                        self._commit(frames)
                    self._synchronized = True
                else:
                    if not self._synchronized:
                        self._invalidate("synchronized output end without begin")
                        return
                    self._synchronized = False
                    self._commit(frames, force=True)
            elif mode not in self._IGNORED_PRIVATE_MODES:
                self._invalidate("unsupported DEC private mode mutation")
                return

    def _switch_alternate(self, enabled: bool) -> None:
        if enabled:
            if self._alternate_active:
                self._invalidate("alternate screen entered twice")
                return
            self._alternate = _Surface.blank(self.width, self.height)
            self._alternate_active = True
        else:
            if not self._alternate_active:
                self._invalidate("alternate screen left while inactive")
                return
            self._alternate_active = False
        self._join_next = False
        self._dirty = True

    def _cursor_csi(self, surface: _Surface, final: str, params: List[Optional[int]]) -> None:
        amount = self._parameter(params, 0, 1, zero_is_default=True)
        if final == "A":
            self._move_to(surface, surface.cursor_row - amount, surface.cursor_column)
        elif final in ("B", "e"):
            self._move_to(surface, surface.cursor_row + amount, surface.cursor_column)
        elif final in ("C", "a"):
            self._move_to(surface, surface.cursor_row, surface.cursor_column + amount)
        elif final == "D":
            self._move_to(surface, surface.cursor_row, surface.cursor_column - amount)
        elif final == "E":
            self._move_to(surface, surface.cursor_row + amount, 0)
        elif final == "F":
            self._move_to(surface, surface.cursor_row - amount, 0)
        elif final in ("G", "`"):
            self._move_to(surface, surface.cursor_row, amount - 1)
        elif final == "d":
            self._move_to(surface, amount - 1, surface.cursor_column)

    def _move_to(self, surface: _Surface, row: int, column: int) -> None:
        surface.cursor_row = min(max(row, 0), surface.height - 1)
        surface.cursor_column = min(max(column, 0), surface.width - 1)
        surface.wrap_pending = False
        surface.last_lead = None
        self._join_next = False

    def _restore_cursor(self, surface: _Surface) -> None:
        if surface.saved_cursor is None:
            self._invalidate("cursor restore without saved cursor")
            return
        self._move_to(surface, *surface.saved_cursor)

    def _control(self, value: int) -> None:
        surface = self._surface
        if value in (0x00, 0x07, 0x7F):
            return
        if value == 0x08:
            self._move_to(surface, surface.cursor_row, surface.cursor_column - 1)
            return
        if value == 0x09:
            next_tab = min(((surface.cursor_column // 8) + 1) * 8, surface.width - 1)
            self._move_to(surface, surface.cursor_row, next_tab)
            return
        if value in (0x0A, 0x0B, 0x0C):
            self._line_feed(surface)
            return
        if value == 0x0D:
            self._move_to(surface, surface.cursor_row, 0)
            return
        self._invalidate("unsupported C0 control")

    def _line_feed(self, surface: _Surface) -> None:
        surface.wrap_pending = False
        surface.last_lead = None
        self._join_next = False
        if surface.cursor_row == surface.scroll_bottom:
            self._scroll_up(surface, 1)
        else:
            surface.cursor_row = min(surface.cursor_row + 1, surface.height - 1)

    def _reverse_index(self, surface: _Surface) -> None:
        surface.wrap_pending = False
        surface.last_lead = None
        self._join_next = False
        if surface.cursor_row == surface.scroll_top:
            self._scroll_down(surface, 1)
        else:
            surface.cursor_row = max(surface.cursor_row - 1, 0)

    def _scroll_up(self, surface: _Surface, count: int) -> None:
        region_height = surface.scroll_bottom - surface.scroll_top + 1
        count = min(max(count, 0), region_height)
        if count == 0:
            return
        retained_rows = surface.rows[surface.scroll_top + count : surface.scroll_bottom + 1]
        retained_visible = surface.visible[surface.scroll_top + count : surface.scroll_bottom + 1]
        retained_parts = surface.parts[surface.scroll_top + count : surface.scroll_bottom + 1]
        surface.rows[surface.scroll_top : surface.scroll_bottom + 1] = retained_rows + [
            [" " for _ in range(surface.width)] for _ in range(count)
        ]
        surface.visible[surface.scroll_top : surface.scroll_bottom + 1] = retained_visible + [
            [True for _ in range(surface.width)] for _ in range(count)
        ]
        surface.parts[surface.scroll_top : surface.scroll_bottom + 1] = retained_parts + [
            [None for _ in range(surface.width)] for _ in range(count)
        ]
        self._repair_multicells(surface)
        surface.last_lead = None
        self._join_next = False
        self._dirty = True

    def _scroll_down(self, surface: _Surface, count: int) -> None:
        region_height = surface.scroll_bottom - surface.scroll_top + 1
        count = min(max(count, 0), region_height)
        if count == 0:
            return
        retained_rows = surface.rows[surface.scroll_top : surface.scroll_bottom - count + 1]
        retained_visible = surface.visible[surface.scroll_top : surface.scroll_bottom - count + 1]
        retained_parts = surface.parts[surface.scroll_top : surface.scroll_bottom - count + 1]
        surface.rows[surface.scroll_top : surface.scroll_bottom + 1] = [
            [" " for _ in range(surface.width)] for _ in range(count)
        ] + retained_rows
        surface.visible[surface.scroll_top : surface.scroll_bottom + 1] = [
            [True for _ in range(surface.width)] for _ in range(count)
        ] + retained_visible
        surface.parts[surface.scroll_top : surface.scroll_bottom + 1] = [
            [None for _ in range(surface.width)] for _ in range(count)
        ] + retained_parts
        self._repair_multicells(surface)
        surface.last_lead = None
        self._join_next = False
        self._dirty = True

    def _erase_display(self, surface: _Surface, mode: int) -> None:
        if mode == 0:
            self._erase_range(surface, surface.cursor_row, surface.cursor_column, surface.width - 1)
            for row in range(surface.cursor_row + 1, surface.height):
                self._erase_range(surface, row, 0, surface.width - 1)
        elif mode == 1:
            for row in range(surface.cursor_row):
                self._erase_range(surface, row, 0, surface.width - 1)
            self._erase_range(surface, surface.cursor_row, 0, surface.cursor_column)
        elif mode == 2:
            for row in range(surface.height):
                self._erase_range(surface, row, 0, surface.width - 1)
        elif mode == 3:
            return
        else:
            self._invalidate("unsupported erase-display mode")

    def _erase_line(self, surface: _Surface, mode: int) -> None:
        if mode == 0:
            self._erase_range(surface, surface.cursor_row, surface.cursor_column, surface.width - 1)
        elif mode == 1:
            self._erase_range(surface, surface.cursor_row, 0, surface.cursor_column)
        elif mode == 2:
            self._erase_range(surface, surface.cursor_row, 0, surface.width - 1)
        else:
            self._invalidate("unsupported erase-line mode")

    def _erase_range(self, surface: _Surface, row: int, start: int, end: int) -> None:
        start = max(0, start)
        end = min(surface.width - 1, end)
        if start > end:
            return
        for column in range(start, end + 1):
            self._clear_glyph(surface, row, column)
        surface.last_lead = None
        self._join_next = False
        self._dirty = True

    def _clear_glyph(self, surface: _Surface, row: int, column: int) -> None:
        part = surface.parts[row][column]
        if part is not None:
            lead_row = row - part.row_offset
            lead_column = column - part.column_offset
            for row_offset in range(part.height):
                for column_offset in range(part.width):
                    target_row = lead_row + row_offset
                    target_column = lead_column + column_offset
                    if 0 <= target_row < surface.height and 0 <= target_column < surface.width:
                        surface.rows[target_row][target_column] = " "
                        surface.visible[target_row][target_column] = True
                        surface.parts[target_row][target_column] = None
            return
        surface.rows[row][column] = " "
        surface.visible[row][column] = True
        surface.parts[row][column] = None

    def _write_character(self, character: str) -> None:
        surface = self._surface
        try:
            width = _cell_width(character)
        except ValueError:
            self._invalidate("non-printable Unicode character")
            return
        if width == 0:
            if self._join_next:
                self._invalidate("unsupported zero-width ZWJ target")
                return
            self._extend_cluster(surface, character)
            return
        if self._join_next and surface.last_lead is not None:
            if not _is_extended_pictographic(character):
                self._invalidate("unsupported non-emoji ZWJ target")
                return
            row, column = surface.last_lead
            cell = surface.rows[row][column]
            if cell not in (" ", _CONTINUATION):
                surface.rows[row][column] = cell + character
                self._join_next = False
                self._widen_last_glyph(surface, row, column)
                self._dirty = True
                return
        self._join_next = False
        if _is_regional_indicator(character) and surface.last_lead is not None:
            row, column = surface.last_lead
            cell = surface.rows[row][column]
            if cell is not None and len(cell) == 1 and _is_regional_indicator(cell):
                surface.rows[row][column] = cell + character
                self._widen_last_glyph(surface, row, column)
                self._dirty = True
                return
        self._write_glyph(character, width)

    def _extend_cluster(self, surface: _Surface, character: str) -> None:
        if surface.last_lead is None:
            part = surface.parts[surface.cursor_row][surface.cursor_column]
            if part is not None:
                surface.last_lead = (
                    surface.cursor_row - part.row_offset,
                    surface.cursor_column - part.column_offset,
                )
            elif _is_variation_selector(character) or character in ("\u200d", "\u20e3") or _is_emoji_modifier(character):
                self._invalidate("cluster extension without a lead cell")
                return
            else:
                return
        row, column = surface.last_lead
        cell = surface.rows[row][column]
        if cell is _CONTINUATION:
            self._invalidate("cluster extension without a glyph")
            return
        assert cell is not None

        if _is_emoji_modifier(character):
            base = _cluster_modifier_base(cell)
            if base is None or not _is_emoji_modifier_base(base):
                self._invalidate("emoji modifier without a valid modifier base")
                return
            surface.rows[row][column] = cell + character
            self._widen_last_glyph(surface, row, column)
            self._dirty = True
            return

        if character == "\u200d":
            if not _is_emoji_cluster_tail(cell):
                self._invalidate("ZWJ without a modeled emoji source")
                return
            surface.rows[row][column] = cell + character
            self._join_next = True
            self._dirty = True
            return

        surface.rows[row][column] = cell + character
        if character == "\ufe0f" and _is_emoji_variation_base(cell[-1]):
            self._widen_last_glyph(surface, row, column)
        elif character == "\ufe0e" and _is_emoji_variation_base(cell[-1]):
            self._narrow_last_glyph(surface, row, column)
        elif character == "\u20e3" and _is_keycap_prefix(cell):
            self._widen_last_glyph(surface, row, column)
        self._dirty = True

    def _lead_is_wide(self, surface: _Surface, row: int, column: int) -> bool:
        part = surface.parts[row][column]
        return part is not None and part.row_offset == 0 and part.column_offset == 0 and part.width == 2

    def _widen_last_glyph(self, surface: _Surface, row: int, column: int) -> None:
        if self._lead_is_wide(surface, row, column):
            return
        glyph = surface.rows[row][column]
        if glyph is _CONTINUATION:
            self._invalidate("Unicode grapheme widened without a lead")
            return
        if surface.width < 2 or (column + 1 >= surface.width and not self._autowrap):
            self._invalidate("Unicode grapheme cannot widen at right margin")
            return
        if column + 1 >= surface.width:
            surface.rows[row][column] = " "
            surface.visible[row][column] = True
            surface.parts[row][column] = None
            surface.wrap_pending = False
            self._line_feed(surface)
            surface.cursor_column = 0
            self._write_glyph(glyph, 2)
            return
        self._clear_glyph(surface, row, column + 1)
        surface.rows[row][column + 1] = _CONTINUATION
        surface.visible[row][column + 1] = surface.visible[row][column]
        surface.parts[row][column] = _CellPart(2, 1, 0, 0)
        surface.parts[row][column + 1] = _CellPart(2, 1, 0, 1)
        surface.last_lead = (row, column)
        if column + 1 == surface.width - 1:
            surface.cursor_column = column + 1
            surface.wrap_pending = self._autowrap
        else:
            surface.cursor_column = column + 2
            surface.wrap_pending = False

    def _narrow_last_glyph(self, surface: _Surface, row: int, column: int) -> None:
        if not self._lead_is_wide(surface, row, column):
            return
        glyph = surface.rows[row][column]
        visible = surface.visible[row][column]
        assert glyph is not None
        self._clear_glyph(surface, row, column + 1)
        surface.rows[row][column] = glyph
        surface.visible[row][column] = visible
        surface.parts[row][column] = None
        surface.last_lead = (row, column)
        surface.cursor_column = column
        surface.wrap_pending = False
        if column == surface.width - 1:
            surface.wrap_pending = self._autowrap
        else:
            surface.cursor_column = column + 1

    def _write_glyph(self, glyph: str, width: int, height: int = 1) -> None:
        surface = self._surface
        while self._valid:
            if surface.wrap_pending:
                self._line_feed(surface)
                surface.cursor_column = 0
            if width > surface.width:
                self._invalidate("multicell glyph cannot fit terminal width")
                return
            if surface.cursor_column + width > surface.width:
                if not self._autowrap:
                    surface.cursor_column = surface.width - width
                else:
                    self._line_feed(surface)
                    surface.cursor_column = 0
                    continue
            if surface.cursor_row + height > surface.height:
                self._invalidate("multicell glyph cannot fit terminal height")
                return
            skipped_to: Optional[int] = None
            for target_row in range(surface.cursor_row, surface.cursor_row + height):
                for target_column in range(surface.cursor_column, surface.cursor_column + width):
                    part = surface.parts[target_row][target_column]
                    if part is not None and part.row_offset > 0:
                        skipped_to = max(
                            skipped_to or 0,
                            target_column - part.column_offset + part.width,
                        )
            if skipped_to is None:
                break
            if skipped_to >= surface.width:
                self._line_feed(surface)
                surface.cursor_column = 0
            else:
                surface.cursor_column = skipped_to
        row = surface.cursor_row
        column = surface.cursor_column
        for target_row in range(row, row + height):
            for target_column in range(column, column + width):
                self._clear_glyph(surface, target_row, target_column)
        surface.rows[row][column] = glyph
        surface.visible[row][column] = not self._concealed
        for row_offset in range(height):
            for column_offset in range(width):
                target_row = row + row_offset
                target_column = column + column_offset
                surface.parts[target_row][target_column] = _CellPart(
                    width,
                    height,
                    row_offset,
                    column_offset,
                )
                if row_offset != 0 or column_offset != 0:
                    surface.rows[target_row][target_column] = _CONTINUATION
                    surface.visible[target_row][target_column] = not self._concealed
        surface.last_lead = (row, column)
        self._dirty = True
        final_column = column + width - 1
        if final_column == surface.width - 1:
            surface.cursor_column = final_column
            surface.wrap_pending = self._autowrap
        else:
            surface.cursor_column = final_column + 1
            surface.wrap_pending = False


def _cell_width(character: str) -> int:
    codepoint = ord(character)
    if _is_invalid_scalar(codepoint):
        raise ValueError("control, surrogate, or noncharacter is not printable")
    if (
        character == "\u200d"
        or _is_variation_selector(character)
        or _is_emoji_modifier(character)
        or _in_codepoint_ranges(codepoint, GRAPHEME_EXTEND_RANGES)
        or _in_codepoint_ranges(codepoint, GCB_CONTROL_RANGES)
    ):
        return 0
    return 2 if _in_codepoint_ranges(codepoint, WIDE_OR_FULLWIDTH_RANGES) else 1


def _is_regional_indicator(character: str) -> bool:
    return len(character) == 1 and 0x1F1E6 <= ord(character) <= 0x1F1FF


def _in_codepoint_ranges(codepoint: int, ranges: Sequence[Tuple[int, int]]) -> bool:
    low = 0
    high = len(ranges)
    while low < high:
        middle = (low + high) // 2
        start, end = ranges[middle]
        if codepoint < start:
            high = middle
        elif codepoint > end:
            low = middle + 1
        else:
            return True
    return False


def _is_noncharacter(codepoint: int) -> bool:
    return 0xFDD0 <= codepoint <= 0xFDEF or codepoint & 0xFFFE == 0xFFFE


def _is_invalid_scalar(codepoint: int) -> bool:
    return (
        codepoint < 0x20
        or 0x7F <= codepoint <= 0x9F
        or 0xD800 <= codepoint <= 0xDFFF
        or codepoint > 0x10FFFF
        or _is_noncharacter(codepoint)
        or _in_codepoint_ranges(codepoint, UNASSIGNED_RANGES)
    )


def _is_safe_osc66_scalar(character: str) -> bool:
    codepoint = ord(character)
    return not _is_invalid_scalar(codepoint) and not _in_codepoint_ranges(codepoint, GCB_CONTROL_RANGES)


def _is_variation_selector(character: str) -> bool:
    codepoint = ord(character)
    return 0xFE00 <= codepoint <= 0xFE0F or 0xE0100 <= codepoint <= 0xE01EF


def _is_grapheme_extend(character: str) -> bool:
    return _in_codepoint_ranges(ord(character), GRAPHEME_EXTEND_RANGES)


def _is_emoji_variation_base(character: str) -> bool:
    return len(character) == 1 and _in_codepoint_ranges(ord(character), _U17_EMOJI_VARIATION_BASE_RANGES)


def _is_emoji_modifier(character: str) -> bool:
    return len(character) == 1 and 0x1F3FB <= ord(character) <= 0x1F3FF


def _is_emoji_modifier_base(character: str) -> bool:
    return len(character) == 1 and _in_codepoint_ranges(ord(character), _U17_EMOJI_MODIFIER_BASE_RANGES)


def _is_extended_pictographic(character: str) -> bool:
    return len(character) == 1 and _in_codepoint_ranges(ord(character), EXTENDED_PICTOGRAPHIC_RANGES)


def _cluster_modifier_base(cluster: str) -> Optional[str]:
    if not cluster:
        return None
    index = len(cluster) - 1
    if cluster[index] == "\ufe0f":
        index -= 1
    return cluster[index] if index >= 0 else None


def _is_emoji_cluster_tail(cluster: str) -> bool:
    if not cluster:
        return False
    index = len(cluster) - 1
    while index >= 0 and _is_grapheme_extend(cluster[index]):
        index -= 1
    return index >= 0 and _is_extended_pictographic(cluster[index])


def _is_keycap_prefix(cluster: str) -> bool:
    return (len(cluster) == 1 and cluster in _KEYCAP_BASES) or (
        len(cluster) == 2 and cluster[0] in _KEYCAP_BASES and cluster[1] == "\ufe0f"
    )
