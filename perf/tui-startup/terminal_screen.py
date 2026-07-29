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
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import List, Mapping, Optional, Sequence, Tuple


PTY_WIDTH = 100
PTY_HEIGHT = 30
_HANDSHAKE_READY = b"R"
_HANDSHAKE_ERROR = b"E"
_CONTINUATION = None
_KEYCAP_BASES = frozenset("#*0123456789")
_EMOJI_VARIATION_BASE_RANGES = (
    (0x0023, 0x0023),
    (0x002A, 0x002A),
    (0x0030, 0x0039),
    (0x00A9, 0x00A9),
    (0x00AE, 0x00AE),
    (0x203C, 0x203C),
    (0x2049, 0x2049),
    (0x2122, 0x2122),
    (0x2139, 0x2139),
    (0x2194, 0x2199),
    (0x21A9, 0x21AA),
    (0x231A, 0x231B),
    (0x2328, 0x2328),
    (0x23CF, 0x23CF),
    (0x23E9, 0x23F3),
    (0x23F8, 0x23FA),
    (0x24C2, 0x24C2),
    (0x25AA, 0x25AB),
    (0x25B6, 0x25B6),
    (0x25C0, 0x25C0),
    (0x25FB, 0x25FE),
    (0x2600, 0x2604),
    (0x260E, 0x260E),
    (0x2611, 0x2611),
    (0x2614, 0x2615),
    (0x2618, 0x2618),
    (0x261D, 0x261D),
    (0x2620, 0x2620),
    (0x2622, 0x2623),
    (0x2626, 0x2626),
    (0x262A, 0x262A),
    (0x262E, 0x262F),
    (0x2638, 0x263A),
    (0x2640, 0x2640),
    (0x2642, 0x2642),
    (0x2648, 0x2653),
    (0x265F, 0x2660),
    (0x2663, 0x2663),
    (0x2665, 0x2666),
    (0x2668, 0x2668),
    (0x267B, 0x267B),
    (0x267E, 0x267F),
    (0x2692, 0x2697),
    (0x2699, 0x2699),
    (0x269B, 0x269C),
    (0x26A0, 0x26A1),
    (0x26A7, 0x26A7),
    (0x26AA, 0x26AB),
    (0x26B0, 0x26B1),
    (0x26BD, 0x26BE),
    (0x26C4, 0x26C5),
    (0x26C8, 0x26C8),
    (0x26CE, 0x26CF),
    (0x26D1, 0x26D1),
    (0x26D3, 0x26D4),
    (0x26E9, 0x26EA),
    (0x26F0, 0x26F5),
    (0x26F7, 0x26FA),
    (0x26FD, 0x26FD),
    (0x2702, 0x2702),
    (0x2705, 0x2705),
    (0x2708, 0x270D),
    (0x270F, 0x270F),
    (0x2712, 0x2712),
    (0x2714, 0x2714),
    (0x2716, 0x2716),
    (0x271D, 0x271D),
    (0x2721, 0x2721),
    (0x2728, 0x2728),
    (0x2733, 0x2734),
    (0x2744, 0x2744),
    (0x2747, 0x2747),
    (0x274C, 0x274C),
    (0x274E, 0x274E),
    (0x2753, 0x2755),
    (0x2757, 0x2757),
    (0x2763, 0x2764),
    (0x2795, 0x2797),
    (0x27A1, 0x27A1),
    (0x27B0, 0x27B0),
    (0x27BF, 0x27BF),
    (0x2934, 0x2935),
    (0x2B05, 0x2B07),
    (0x2B1B, 0x2B1C),
    (0x2B50, 0x2B50),
    (0x2B55, 0x2B55),
    (0x3030, 0x3030),
    (0x303D, 0x303D),
    (0x3297, 0x3297),
    (0x3299, 0x3299),
    (0x1F004, 0x1F004),
    (0x1F170, 0x1F171),
    (0x1F17E, 0x1F17F),
    (0x1F202, 0x1F202),
    (0x1F21A, 0x1F21A),
    (0x1F22F, 0x1F22F),
    (0x1F237, 0x1F237),
    (0x1F30D, 0x1F30F),
    (0x1F315, 0x1F315),
    (0x1F31C, 0x1F31C),
    (0x1F321, 0x1F321),
    (0x1F324, 0x1F32C),
    (0x1F336, 0x1F336),
    (0x1F378, 0x1F378),
    (0x1F37D, 0x1F37D),
    (0x1F393, 0x1F393),
    (0x1F396, 0x1F397),
    (0x1F399, 0x1F39B),
    (0x1F39E, 0x1F39F),
    (0x1F3A7, 0x1F3A7),
    (0x1F3AC, 0x1F3AE),
    (0x1F3C2, 0x1F3C2),
    (0x1F3C4, 0x1F3C4),
    (0x1F3C6, 0x1F3C6),
    (0x1F3CA, 0x1F3CE),
    (0x1F3D4, 0x1F3E0),
    (0x1F3ED, 0x1F3ED),
    (0x1F3F3, 0x1F3F3),
    (0x1F3F5, 0x1F3F5),
    (0x1F3F7, 0x1F3F7),
    (0x1F408, 0x1F408),
    (0x1F415, 0x1F415),
    (0x1F41F, 0x1F41F),
    (0x1F426, 0x1F426),
    (0x1F43F, 0x1F43F),
    (0x1F441, 0x1F442),
    (0x1F446, 0x1F449),
    (0x1F44D, 0x1F44E),
    (0x1F453, 0x1F453),
    (0x1F46A, 0x1F46A),
    (0x1F47D, 0x1F47D),
    (0x1F4A3, 0x1F4A3),
    (0x1F4B0, 0x1F4B0),
    (0x1F4B3, 0x1F4B3),
    (0x1F4BB, 0x1F4BB),
    (0x1F4BF, 0x1F4BF),
    (0x1F4CB, 0x1F4CB),
    (0x1F4DA, 0x1F4DA),
    (0x1F4DF, 0x1F4DF),
    (0x1F4E4, 0x1F4E6),
    (0x1F4EA, 0x1F4ED),
    (0x1F4F7, 0x1F4F7),
    (0x1F4F9, 0x1F4FB),
    (0x1F4FD, 0x1F4FD),
    (0x1F508, 0x1F508),
    (0x1F50D, 0x1F50D),
    (0x1F512, 0x1F513),
    (0x1F549, 0x1F54A),
    (0x1F550, 0x1F567),
    (0x1F56F, 0x1F570),
    (0x1F573, 0x1F579),
    (0x1F587, 0x1F587),
    (0x1F58A, 0x1F58D),
    (0x1F590, 0x1F590),
    (0x1F5A5, 0x1F5A5),
    (0x1F5A8, 0x1F5A8),
    (0x1F5B1, 0x1F5B2),
    (0x1F5BC, 0x1F5BC),
    (0x1F5C2, 0x1F5C4),
    (0x1F5D1, 0x1F5D3),
    (0x1F5DC, 0x1F5DE),
    (0x1F5E1, 0x1F5E1),
    (0x1F5E3, 0x1F5E3),
    (0x1F5E8, 0x1F5E8),
    (0x1F5EF, 0x1F5EF),
    (0x1F5F3, 0x1F5F3),
    (0x1F5FA, 0x1F5FA),
    (0x1F610, 0x1F610),
    (0x1F687, 0x1F687),
    (0x1F68D, 0x1F68D),
    (0x1F691, 0x1F691),
    (0x1F694, 0x1F694),
    (0x1F698, 0x1F698),
    (0x1F6AD, 0x1F6AD),
    (0x1F6B2, 0x1F6B2),
    (0x1F6B9, 0x1F6BA),
    (0x1F6BC, 0x1F6BC),
    (0x1F6CB, 0x1F6CB),
    (0x1F6CD, 0x1F6CF),
    (0x1F6E0, 0x1F6E5),
    (0x1F6E9, 0x1F6E9),
    (0x1F6F0, 0x1F6F0),
    (0x1F6F3, 0x1F6F3),
)
_EMOJI_MODIFIER_BASE_RANGES = (
    (0x261D, 0x261D),
    (0x26F9, 0x26F9),
    (0x270A, 0x270D),
    (0x1F385, 0x1F385),
    (0x1F3C2, 0x1F3C4),
    (0x1F3C7, 0x1F3C7),
    (0x1F3CA, 0x1F3CC),
    (0x1F442, 0x1F443),
    (0x1F446, 0x1F450),
    (0x1F466, 0x1F478),
    (0x1F47C, 0x1F47C),
    (0x1F481, 0x1F483),
    (0x1F485, 0x1F487),
    (0x1F48F, 0x1F48F),
    (0x1F491, 0x1F491),
    (0x1F4AA, 0x1F4AA),
    (0x1F574, 0x1F575),
    (0x1F57A, 0x1F57A),
    (0x1F590, 0x1F590),
    (0x1F595, 0x1F596),
    (0x1F645, 0x1F647),
    (0x1F64B, 0x1F64F),
    (0x1F6A3, 0x1F6A3),
    (0x1F6B4, 0x1F6B6),
    (0x1F6C0, 0x1F6C0),
    (0x1F6CC, 0x1F6CC),
    (0x1F90C, 0x1F90C),
    (0x1F90F, 0x1F90F),
    (0x1F918, 0x1F91F),
    (0x1F926, 0x1F926),
    (0x1F930, 0x1F939),
    (0x1F93C, 0x1F93E),
    (0x1F977, 0x1F977),
    (0x1F9B5, 0x1F9B6),
    (0x1F9B8, 0x1F9B9),
    (0x1F9BB, 0x1F9BB),
    (0x1F9CD, 0x1F9CF),
    (0x1F9D1, 0x1F9DD),
    (0x1FAC3, 0x1FAC5),
    (0x1FAF0, 0x1FAF8),
)


class PtyHandshakeError(RuntimeError):
    """Raised when the slave geometry or exec-boundary handshake is untrusted."""

    def __init__(self, message: str, pid: Optional[int] = None, master_fd: Optional[int] = None):
        super().__init__(message)
        self.pid = pid
        self.master_fd = master_fd


@dataclass(frozen=True)
class PtyProcess:
    pid: int
    master_fd: int
    start_ns: int
    deadline: float


def _close(fd: Optional[int]) -> None:
    if fd is None:
        return
    try:
        os.close(fd)
    except OSError:
        pass


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
        _close(read_fd)
        _close(write_fd)
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
    except OSError:
        pass


def await_exec_handshake(read_fd: int, timeout: float) -> None:
    """Require ready followed by CLOEXEC EOF, closing ``read_fd`` on every path."""

    if timeout <= 0:
        _close(read_fd)
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
        _close(read_fd)


def _reap_after_failed_spawn(pid: int, master_fd: int) -> None:
    _close(master_fd)
    try:
        pgid = os.getpgid(pid)
    except ProcessLookupError:
        pgid = None
    try:
        if pgid == pid:
            os.killpg(pgid, signal.SIGKILL)
        else:
            os.kill(pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass
    while True:
        try:
            os.waitpid(pid, 0)
            return
        except InterruptedError:
            continue
        except ChildProcessError:
            return


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
        _close(read_fd)
        _close(write_fd)
        raise

    if pid == 0:
        _close(read_fd)
        try:
            configure_pty_slave(write_fd, width, height)
            os.chdir(cwd)
            os.execvpe(command[0], list(command), dict(env))
        except BaseException as error:
            report_exec_failure(write_fd)
            try:
                message = "failed to launch command: {}\n".format(error).encode("utf-8", errors="replace")
                os.write(2, message[:1024])
            except BaseException:
                pass
            os._exit(127)

    _close(write_fd)
    deadline = start_monotonic + timeout
    try:
        await_exec_handshake(read_fd, max(0.0, deadline - time.monotonic()))
    except PtyHandshakeError as error:
        _reap_after_failed_spawn(pid, master_fd)
        raise PtyHandshakeError(str(error), pid=pid, master_fd=master_fd) from error
    except BaseException:
        _reap_after_failed_spawn(pid, master_fd)
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


@dataclass
class _Surface:
    width: int
    height: int
    rows: List[List[Cell]]
    visible: List[List[bool]]
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
        self._pending.extend(data)
        frames: List[TerminalFrame] = []
        while self._valid and self._pending:
            first = self._pending[0]
            if first == 0x1B:
                consumed = self._consume_escape(frames)
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
        if self._valid and self._dirty and not self._synchronized:
            self._commit(frames)
        return tuple(frames)

    def finish(self) -> Tuple[TerminalFrame, ...]:
        """Declare EOF; incomplete input or an open sync transaction invalidates."""

        if not self._valid:
            return ()
        if self._pending:
            self._invalidate("truncated terminal sequence or UTF-8 at EOF")
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
        for surface in (self._main, self._alternate):
            old_width = surface.width
            old_height = surface.height
            old_rows = surface.rows
            old_visible = surface.visible
            resized = [[" " for _ in range(width)] for _ in range(height)]
            resized_visible = [[True for _ in range(width)] for _ in range(height)]
            truncated_wide_leads: List[Tuple[int, int]] = []
            for row in range(min(height, old_height)):
                for column in range(min(width, old_width)):
                    resized[row][column] = old_rows[row][column]
                    resized_visible[row][column] = old_visible[row][column]
                    if (
                        old_rows[row][column] is not _CONTINUATION
                        and column + 1 < old_width
                        and old_rows[row][column + 1] is _CONTINUATION
                        and column + 1 >= width
                    ):
                        truncated_wide_leads.append((row, column))
            surface.width = width
            surface.height = height
            surface.rows = resized
            surface.visible = resized_visible
            surface.cursor_row = min(surface.cursor_row, height - 1)
            surface.cursor_column = min(surface.cursor_column, width - 1)
            surface.scroll_top = 0
            surface.scroll_bottom = height - 1
            surface.wrap_pending = False
            surface.last_lead = None
            self._repair_wide_cells(surface, truncated_wide_leads)
        self.width = width
        self.height = height
        self._join_next = False
        self._dirty = True
        frames: List[TerminalFrame] = []
        if not self._synchronized:
            self._commit(frames)
        return tuple(frames)

    def _repair_wide_cells(self, surface: _Surface, truncated_wide_leads: Sequence[Tuple[int, int]]) -> None:
        for row, column in truncated_wide_leads:
            surface.rows[row][column] = " "
            surface.visible[row][column] = True
        for row in range(surface.height):
            for column in range(surface.width):
                cell = surface.rows[row][column]
                if cell is _CONTINUATION:
                    if column == 0 or surface.rows[row][column - 1] is _CONTINUATION:
                        surface.rows[row][column] = " "
                        surface.visible[row][column] = True

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

    def _consume_escape(self, frames: List[TerminalFrame]) -> int:
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
                    self._string_escape(kind, payload)
                    return index + 1
                if value == 0x1B:
                    if index + 1 >= len(self._pending):
                        return 0
                    if kind == ord("P") and self._pending[index + 1] == 0x1B:
                        index += 2
                        continue
                    if self._pending[index + 1] != ord("\\"):
                        self._invalidate("malformed terminal string escape")
                        return -1
                    payload = bytes(self._pending[2:index])
                    self._string_escape(kind, payload)
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

    def _string_escape(self, kind: int, payload: bytes) -> None:
        if kind == ord("]"):
            self._osc(payload)
            return
        if kind == ord("P"):
            if payload.startswith((b"+q", b"$q", b">q")):
                return
            if payload.startswith(b"tmux;"):
                self._passthrough(payload[5:])
                return
            if payload.startswith(b"\x1b"):
                self._passthrough(payload)
                return
        if kind == ord("_") and payload == b"Gi=31337,s=1,v=1,a=q,t=d,f=24;AAAA":
            return
        self._invalidate("unsupported terminal string command")

    def _passthrough(self, payload: bytes) -> None:
        inner = bytearray()
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
        if not inner:
            self._invalidate("empty terminal passthrough")
            return
        probe = TerminalScreen(self.width, self.height)
        frames = probe.feed(bytes(inner))
        probe.finish()
        if frames or not probe.valid or probe.last_frame is not None:
            self._invalidate("unsupported or mutating terminal passthrough")

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
            self._write_glyph(" ", 2)
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
        if not text:
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
        surface.rows[surface.scroll_top : surface.scroll_bottom + 1] = retained_rows + [
            [" " for _ in range(surface.width)] for _ in range(count)
        ]
        surface.visible[surface.scroll_top : surface.scroll_bottom + 1] = retained_visible + [
            [True for _ in range(surface.width)] for _ in range(count)
        ]
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
        surface.rows[surface.scroll_top : surface.scroll_bottom + 1] = [
            [" " for _ in range(surface.width)] for _ in range(count)
        ] + retained_rows
        surface.visible[surface.scroll_top : surface.scroll_bottom + 1] = [
            [True for _ in range(surface.width)] for _ in range(count)
        ] + retained_visible
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
        cell = surface.rows[row][column]
        if cell is _CONTINUATION:
            lead = column - 1
            while lead >= 0 and surface.rows[row][lead] is _CONTINUATION:
                lead -= 1
            if lead >= 0:
                surface.rows[row][lead] = " "
                surface.visible[row][lead] = True
            surface.rows[row][column] = " "
            surface.visible[row][column] = True
            return
        if column + 1 < surface.width and surface.rows[row][column + 1] is _CONTINUATION:
            surface.rows[row][column + 1] = " "
            surface.visible[row][column + 1] = True
        surface.rows[row][column] = " "
        surface.visible[row][column] = True

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
            if not _is_emoji_codepoint(character):
                self._invalidate("unsupported non-emoji ZWJ target")
                return
            row, column = surface.last_lead
            cell = surface.rows[row][column]
            if cell not in (" ", _CONTINUATION):
                surface.rows[row][column] = cell + character
                self._join_next = False
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
            if character in ("\ufe0f", "\u200d", "\u20e3") or _is_emoji_modifier(character):
                self._invalidate("cluster extension without a lead cell")
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
            if not self._lead_is_wide(surface, row, column) or not _is_emoji_cluster_tail(cell):
                self._invalidate("ZWJ without a modeled emoji source")
                return
            surface.rows[row][column] = cell + character
            self._join_next = True
            self._dirty = True
            return

        surface.rows[row][column] = cell + character
        if character == "\ufe0f" and _is_emoji_variation_base(cell[-1]):
            self._widen_last_glyph(surface, row, column)
        elif character == "\u20e3" and _is_keycap_prefix(cell):
            self._widen_last_glyph(surface, row, column)
        self._dirty = True

    def _lead_is_wide(self, surface: _Surface, row: int, column: int) -> bool:
        return column + 1 < surface.width and surface.rows[row][column + 1] is _CONTINUATION

    def _widen_last_glyph(self, surface: _Surface, row: int, column: int) -> None:
        if column + 1 >= surface.width:
            self._invalidate("Unicode grapheme widened past right margin")
            return
        if surface.rows[row][column + 1] is _CONTINUATION:
            return
        self._clear_glyph(surface, row, column + 1)
        surface.rows[row][column + 1] = _CONTINUATION
        surface.visible[row][column + 1] = surface.visible[row][column]
        surface.last_lead = (row, column)
        if column + 1 == surface.width - 1:
            surface.cursor_column = column + 1
            surface.wrap_pending = self._autowrap
        else:
            surface.cursor_column = column + 2
            surface.wrap_pending = False

    def _write_glyph(self, glyph: str, width: int) -> None:
        surface = self._surface
        if surface.wrap_pending:
            self._line_feed(surface)
            surface.cursor_column = 0
        if width == 2 and surface.width == 1:
            self._invalidate("wide character cannot fit terminal width")
            return
        if width == 2 and surface.cursor_column == surface.width - 1:
            if not self._autowrap:
                self._invalidate("wide character clipped with autowrap disabled")
                return
            self._line_feed(surface)
            surface.cursor_column = 0
        row = surface.cursor_row
        column = surface.cursor_column
        self._clear_glyph(surface, row, column)
        if width == 2:
            self._clear_glyph(surface, row, column + 1)
        surface.rows[row][column] = glyph
        surface.visible[row][column] = not self._concealed
        if width == 2:
            surface.rows[row][column + 1] = _CONTINUATION
            surface.visible[row][column + 1] = not self._concealed
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
    category = unicodedata.category(character)
    if character == "\u200d" or category in ("Mn", "Me"):
        return 0
    if 0xFE00 <= codepoint <= 0xFE0F or 0xE0100 <= codepoint <= 0xE01EF:
        return 0
    if 0x1F3FB <= codepoint <= 0x1F3FF:
        return 0
    if category in ("Cc", "Cs"):
        raise ValueError("control or surrogate is not printable")
    if category == "Cf":
        return 0
    return 2 if unicodedata.east_asian_width(character) in ("W", "F") else 1


def _is_regional_indicator(character: str) -> bool:
    return len(character) == 1 and 0x1F1E6 <= ord(character) <= 0x1F1FF


def _in_codepoint_ranges(character: str, ranges: Sequence[Tuple[int, int]]) -> bool:
    codepoint = ord(character)
    return any(start <= codepoint <= end for start, end in ranges)


def _is_emoji_variation_base(character: str) -> bool:
    return len(character) == 1 and _in_codepoint_ranges(character, _EMOJI_VARIATION_BASE_RANGES)


def _is_emoji_modifier(character: str) -> bool:
    return len(character) == 1 and 0x1F3FB <= ord(character) <= 0x1F3FF


def _is_emoji_modifier_base(character: str) -> bool:
    return len(character) == 1 and _in_codepoint_ranges(character, _EMOJI_MODIFIER_BASE_RANGES)


def _is_emoji_codepoint(character: str) -> bool:
    if len(character) != 1:
        return False
    if character in _KEYCAP_BASES:
        return False
    codepoint = ord(character)
    return (
        codepoint == 0x1FAEF
        or _is_emoji_variation_base(character)
        or _is_emoji_modifier_base(character)
        or (
            0x1F000 <= codepoint <= 0x1FAFF
            and not _is_regional_indicator(character)
            and unicodedata.category(character) == "So"
            and unicodedata.east_asian_width(character) in ("W", "F")
        )
    )


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
    if _is_regional_indicator(cluster[-1]):
        return False
    if _is_emoji_modifier(cluster[-1]):
        base = _cluster_modifier_base(cluster[:-1])
        return base is not None and _is_emoji_modifier_base(base)
    if cluster[-1] == "\ufe0f":
        return (
            len(cluster) >= 2
            and cluster[-2] not in _KEYCAP_BASES
            and _is_emoji_variation_base(cluster[-2])
        )
    return _is_emoji_codepoint(cluster[-1])


def _is_keycap_prefix(cluster: str) -> bool:
    return (len(cluster) == 1 and cluster in _KEYCAP_BASES) or (
        len(cluster) == 2 and cluster[0] in _KEYCAP_BASES and cluster[1] == "\ufe0f"
    )
