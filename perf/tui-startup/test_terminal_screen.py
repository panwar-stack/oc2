import errno
import fcntl
import os
import select
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

import terminal_screen
import tui_benchmark
from terminal_screen import (
    PTY_HEIGHT,
    PTY_WIDTH,
    PtyHandshakeError,
    TerminalScreen,
    await_exec_handshake,
    create_exec_handshake,
    spawn_pty,
)


class TerminalScreenTest(unittest.TestCase):
    def test_fragmented_synchronized_unicode_frame_uses_cells(self):
        screen = TerminalScreen(8, 2)
        payload = "A界e\u0301👍🏽".encode("utf-8")
        stream = b"\x1b[?2026h" + payload + b"\x1b[?2026l"
        frames = []
        for value in stream:
            frames.extend(screen.feed(bytes((value,))))

        self.assertTrue(screen.valid)
        self.assertEqual(len(frames), 1)
        frame = frames[0]
        self.assertEqual((frame.width, frame.height), (8, 2))
        self.assertEqual(frame.cell(0, 0), "A")
        self.assertEqual(frame.cell(0, 1), "界")
        self.assertIsNone(frame.cell(0, 2))
        self.assertEqual(frame.cell(0, 3), "e\u0301")
        self.assertEqual(frame.cell(0, 4), "👍🏽")
        self.assertIsNone(frame.cell(0, 5))
        self.assertEqual(frame.line(0, trim=True), "A界e\u0301👍🏽")

    def test_sync_does_not_expose_uncommitted_or_erased_paint(self):
        screen = TerminalScreen(12, 2)
        self.assertEqual(screen.feed(b"\x1b[?2026hsecret"), ())
        self.assertIsNone(screen.last_frame)
        self.assertEqual(screen.feed(b"\rvisible\x1b[K"), ())
        frames = screen.feed(b"\x1b[?2026l")

        self.assertEqual(len(frames), 1)
        self.assertTrue(frames[0].contains("visible"))
        self.assertFalse(frames[0].contains("secret"))

    def test_outside_sync_commits_only_terminal_cells_not_raw_history(self):
        screen = TerminalScreen(8, 1)
        first = screen.feed(b"password")[0]
        second = screen.feed(b"\rprompt\x1b[K")[0]

        self.assertTrue(first.contains("password"))
        self.assertTrue(second.contains("prompt"))
        self.assertFalse(second.contains("password"))
        self.assertEqual(screen.commit_count, 2)

    def test_concealed_sgr_text_never_counts_as_visible_cells(self):
        screen = TerminalScreen(16, 1)
        frame = screen.feed(b"\x1b[8mraw-lookalike\x1b[28mOK")[0]

        self.assertFalse(frame.contains("raw-lookalike"))
        self.assertTrue(frame.contains("OK"))
        self.assertEqual(frame.line(0, trim=True), "             OK")

    def test_fragmented_cursor_erase_and_overwrite(self):
        screen = TerminalScreen(10, 3)
        stream = b"abcdefghij\x1b[2;1H0123456789\x1b[1;4HXY\x1b[K\x1b[2;6H\x1b[1K"
        for split in (1, 2, 3, 5, 8, 13):
            clone = TerminalScreen(10, 3)
            for start in range(0, len(stream), split):
                clone.feed(stream[start : start + split])
            self.assertTrue(clone.valid)
            frame = clone.last_frame
            self.assertIsNotNone(frame)
            assert frame is not None
            self.assertEqual(frame.line(0), "abcXY     ")
            self.assertEqual(frame.line(1), "      6789")
        self.assertTrue(screen.valid)

    def test_alternate_screen_preserves_main_cells_and_cursor(self):
        screen = TerminalScreen(8, 2)
        main = screen.feed(b"main")[0]
        alt = screen.feed(b"\x1b[?1049halt")[0]
        restored = screen.feed(b"\x1b[?1049l")[0]

        self.assertFalse(main.alternate)
        self.assertTrue(alt.alternate)
        self.assertTrue(alt.contains("alt"))
        self.assertFalse(alt.contains("main"))
        self.assertFalse(restored.alternate)
        self.assertTrue(restored.contains("main"))
        screen.feed(b"!")
        self.assertEqual(screen.last_frame.line(0, trim=True), "main!")

    def test_alternate_screen_transition_inside_sync_has_one_frame(self):
        screen = TerminalScreen(8, 2)
        frames = screen.feed(b"\x1b[?2026h\x1b[?1049hhello\x1b[?2026l")
        self.assertEqual(len(frames), 1)
        self.assertTrue(frames[0].alternate)
        self.assertTrue(frames[0].contains("hello"))

    def test_wide_cell_overwrite_clears_both_halves(self):
        screen = TerminalScreen(6, 1)
        screen.feed("a界z".encode("utf-8"))
        frame = screen.feed(b"\x1b[1;3HX")[0]

        self.assertEqual(frame.cell(0, 1), " ")
        self.assertEqual(frame.cell(0, 2), "X")
        self.assertEqual(frame.line(0, trim=True), "a Xz")

    def test_resize_preserves_cells_and_removes_truncated_wide_glyph(self):
        screen = TerminalScreen(4, 2)
        screen.feed("ab界".encode("utf-8"))
        shrunk = screen.resize(3, 3)[0]

        self.assertEqual((shrunk.width, shrunk.height), (3, 3))
        self.assertEqual(shrunk.line(0), "ab ")
        self.assertEqual(shrunk.line(2), "   ")
        grown = screen.resize(6, 4)[0]
        self.assertEqual((grown.width, grown.height), (6, 4))
        self.assertEqual(grown.line(0), "ab    ")

    def test_resize_waits_for_synchronized_commit(self):
        screen = TerminalScreen(4, 2)
        screen.feed(b"\x1b[?2026hab")
        self.assertEqual(screen.resize(6, 3), ())
        frames = screen.feed(b"\x1b[?2026l")
        self.assertEqual(len(frames), 1)
        self.assertEqual((frames[0].width, frames[0].height), (6, 3))

    def test_scroll_region_line_feed_and_renderer_scroll_sequences(self):
        screen = TerminalScreen(4, 3)
        screen.feed(b"1111\x1b[2;1H2222\x1b[3;1H3333")
        up = screen.feed(b"\x1b[1S")[0]
        self.assertEqual(up.lines, ("2222", "3333", "    "))
        down = screen.feed(b"\x1b[1T")[0]
        self.assertEqual(down.lines, ("    ", "2222", "3333"))

        region = TerminalScreen(4, 4)
        region.feed(b"aaaa\x1b[2;1Hbbbb\x1b[3;1Hcccc\x1b[4;1Hdddd")
        region.feed(b"\x1b[2;3r\x1b[3;1H\n")
        self.assertEqual(region.last_frame.lines, ("aaaa", "cccc", "    ", "dddd"))

    def test_known_renderer_styles_modes_and_queries_are_non_mutating(self):
        screen = TerminalScreen(8, 2)
        known = (
            b"\x1b[0;1;38;2;1;2;3;48:2::4:5:6m"
            b"\x1b[?25l\x1b[?1004h\x1b[?1006h\x1b[?2004h"
            b"\x1b[?2026$p\x1b[>q\x1b[6n\x1b[14t"
            b"\x1b]10;?\x07\x1b]11;?\x1b\\"
            b"\x1bP+q544e\x1b\\"
        )
        for value in known:
            screen.feed(bytes((value,)))
        self.assertTrue(screen.valid, screen.invalid_reason)
        self.assertIsNone(screen.last_frame)
        frame = screen.feed(b"ok")[0]
        self.assertEqual(frame.line(0, trim=True), "ok")

    def test_opentui_startup_capability_surface_is_supported(self):
        screen = TerminalScreen(12, 2)
        startup = (
            b"\x1b[?2031h\x1b]10;?\x07\x1b]11;?\x07"
            b"\x1b[>0q\x1b[?25l\x1b[s\x1b[6n"
            b"\x1b[?1016$p\x1b[?2027$p\x1b[?2031$p"
            b"\x1b[?1004$p\x1b[?2004$p\x1b[?2026$p\x1b[?u"
            b"\x1b]99;i=opentui-notifications:p=?;\x1b\\"
            b"\x1b]1337;Capabilities\x1b\\"
            b"\x1b[H\x1b]66;w=1; \x1b\\\x1b[6n"
            b"\x1b[H\x1b]66;s=2; \x1b\\\x1b[6n\x1b[u"
            b"\x1b[>4;1m\x1b[?2027h\x1b[?2004h"
            b"\x1b_Gi=31337,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\\x1b[c"
        )
        for value in startup:
            screen.feed(bytes((value,)))
        self.assertTrue(screen.valid, screen.invalid_reason)
        self.assertIsNotNone(screen.last_frame)
        self.assertTrue(screen.last_frame.is_blank)

    def test_explicit_width_osc_and_emoji_clusters_occupy_truthful_cells(self):
        screen = TerminalScreen(12, 1)
        stream = (
            b"\x1b[?2026h\x1b]66;w=2;\xe2\x9d\xa4\x1b\\"
            + "🇺🇸❤️".encode("utf-8")
            + b"\x1b]8;id=1;https://example.invalid\x1b\\x\x1b]8;;\x1b\\\x1b[?2026l"
        )
        frames = screen.feed(stream)

        self.assertTrue(screen.valid, screen.invalid_reason)
        self.assertEqual(len(frames), 1)
        frame = frames[0]
        self.assertEqual(frame.cell(0, 0), "❤")
        self.assertIsNone(frame.cell(0, 1))
        self.assertEqual(frame.cell(0, 2), "🇺🇸")
        self.assertIsNone(frame.cell(0, 3))
        self.assertEqual(frame.cell(0, 4), "❤️")
        self.assertIsNone(frame.cell(0, 5))
        self.assertEqual(frame.cell(0, 6), "x")

    def test_unknown_mutations_invalidate_without_later_frames(self):
        streams = (
            b"\x1b[?9999h",
            b"\x1b[@",
            b"\x1b[31m",
            b"\x1b]999;value\x07",
            b"\x1bPunknown\x1b\\",
            b"\x1b_Gi=1,a=T;payload\x1b\\",
            b"\x1b(0",
            b"\x01",
        )
        for stream in streams:
            with self.subTest(stream=stream):
                screen = TerminalScreen(8, 2)
                self.assertEqual(screen.feed(stream), ())
                self.assertFalse(screen.valid)
                self.assertIsNotNone(screen.invalid_reason)
                self.assertEqual(screen.feed(b"lookalike"), ())
                self.assertIsNone(screen.last_frame)

    def test_sync_and_alternate_desynchronization_invalidates(self):
        streams = (
            b"\x1b[?2026l",
            b"\x1b[?2026h\x1b[?2026h",
            b"\x1b[?1049l",
            b"\x1b[?1049h\x1b[?1049h",
        )
        for stream in streams:
            with self.subTest(stream=stream):
                screen = TerminalScreen(8, 2)
                screen.feed(stream)
                self.assertFalse(screen.valid)

    def test_finish_rejects_every_incomplete_parser_state(self):
        streams = (b"\x1b", b"\x1b[12;", b"\x1b]10;?", b"\xe7\x95", b"\x1b[?2026htext")
        for stream in streams:
            with self.subTest(stream=stream):
                screen = TerminalScreen(8, 2)
                screen.feed(stream)
                screen.finish()
                self.assertFalse(screen.valid)
                self.assertIsNotNone(screen.invalid_reason)

    def test_invalid_utf8_fails_closed(self):
        for stream in (b"\x80", b"\xc0\xaf", b"\xe2(\xa1"):
            with self.subTest(stream=stream):
                screen = TerminalScreen(8, 2)
                screen.feed(stream)
                self.assertFalse(screen.valid)

    def test_committed_frames_are_immutable_snapshots(self):
        screen = TerminalScreen(4, 1)
        first = screen.feed(b"one")[0]
        second = screen.feed(b"\rtwo")[0]
        self.assertEqual(first.line(0), "one ")
        self.assertEqual(second.line(0), "two ")
        self.assertEqual(first.sequence, 1)
        self.assertEqual(second.sequence, 2)


class PtyHandshakeTest(unittest.TestCase):
    def assert_closed(self, fd):
        with self.assertRaises(OSError) as caught:
            os.fstat(fd)
        self.assertEqual(caught.exception.errno, errno.EBADF)

    def test_handshake_writer_is_close_on_exec(self):
        read_fd, write_fd = create_exec_handshake()
        try:
            self.assertFalse(os.get_inheritable(write_fd))
            flags = fcntl.fcntl(write_fd, fcntl.F_GETFD)
            self.assertTrue(flags & fcntl.FD_CLOEXEC)
        finally:
            os.close(read_fd)
            os.close(write_fd)

    def test_ready_then_eof_is_the_only_success_and_reader_closes(self):
        read_fd, write_fd = create_exec_handshake()
        os.write(write_fd, b"R")
        os.close(write_fd)
        await_exec_handshake(read_fd, 1.0)
        self.assert_closed(read_fd)

    def test_handshake_rejects_early_eof_error_and_unknown_protocol(self):
        for payload in (b"", b"E", b"RE", b"RX", b"RR"):
            with self.subTest(payload=payload):
                read_fd, write_fd = create_exec_handshake()
                os.write(write_fd, payload)
                os.close(write_fd)
                with self.assertRaises(PtyHandshakeError):
                    await_exec_handshake(read_fd, 1.0)
                self.assert_closed(read_fd)

    def test_ready_without_cloexec_eof_times_out_and_reader_closes(self):
        read_fd, write_fd = create_exec_handshake()
        try:
            os.write(write_fd, b"R")
            with self.assertRaisesRegex(PtyHandshakeError, "EOF"):
                await_exec_handshake(read_fd, 0.02)
            self.assert_closed(read_fd)
        finally:
            os.close(write_fd)

    def test_fork_failure_closes_both_handshake_descriptors(self):
        read_fd, write_fd = os.pipe()
        with mock.patch.object(terminal_screen, "create_exec_handshake", return_value=(read_fd, write_fd)):
            with mock.patch.object(terminal_screen.pty, "fork", side_effect=OSError("fork failed")):
                with self.assertRaisesRegex(OSError, "fork failed"):
                    spawn_pty([sys.executable, "-c", "pass"], Path.cwd(), os.environ.copy(), 1.0)
        self.assert_closed(read_fd)
        self.assert_closed(write_fd)

    def test_entry_fixture_observes_exact_pre_exec_geometry(self):
        fixture = (
            "import fcntl,struct,termios;"
            "value=fcntl.ioctl(0,termios.TIOCGWINSZ,struct.pack('HHHH',0,0,0,0));"
            "rows,cols,_,_=struct.unpack('HHHH',value);"
            "print(f'{cols}x{rows}',flush=True)"
        )
        child = spawn_pty([sys.executable, "-c", fixture], Path.cwd(), os.environ.copy(), 2.0)
        output, status = self.read_and_reap(child.pid, child.master_fd, child.deadline)

        self.assertEqual(os.waitstatus_to_exitcode(status), 0)
        self.assertEqual(output, "{}x{}\r\n".format(PTY_WIDTH, PTY_HEIGHT).encode("ascii"))

    def test_custom_geometry_is_visible_at_executable_entry(self):
        fixture = (
            "import fcntl,struct,termios;"
            "value=fcntl.ioctl(0,termios.TIOCGWINSZ,struct.pack('HHHH',0,0,0,0));"
            "print('%dx%d'%tuple(reversed(struct.unpack('HHHH',value)[:2])),flush=True)"
        )
        child = spawn_pty(
            [sys.executable, "-c", fixture], Path.cwd(), os.environ.copy(), 2.0, width=73, height=19
        )
        output, status = self.read_and_reap(child.pid, child.master_fd, child.deadline)

        self.assertEqual(os.waitstatus_to_exitcode(status), 0)
        self.assertEqual(output, b"73x19\r\n")

    def test_exec_failure_closes_master_and_reaps_child(self):
        missing = "/definitely/not/a/real/oc2-command"
        with self.assertRaises(PtyHandshakeError) as caught:
            spawn_pty([missing], Path.cwd(), os.environ.copy(), 1.0)
        error = caught.exception
        self.assertIsNotNone(error.pid)
        self.assertIsNotNone(error.master_fd)
        assert error.pid is not None
        assert error.master_fd is not None
        self.assert_closed(error.master_fd)
        with self.assertRaises(ChildProcessError):
            os.waitpid(error.pid, os.WNOHANG)

    def test_child_setup_failure_closes_master_and_reaps_child(self):
        original = terminal_screen.configure_pty_slave

        def fail_setup(write_fd, width=PTY_WIDTH, height=PTY_HEIGHT):
            raise OSError("injected TIOCSWINSZ failure")

        terminal_screen.configure_pty_slave = fail_setup
        try:
            with self.assertRaises(PtyHandshakeError) as caught:
                spawn_pty([sys.executable, "-c", "pass"], Path.cwd(), os.environ.copy(), 1.0)
        finally:
            terminal_screen.configure_pty_slave = original
        error = caught.exception
        assert error.pid is not None
        assert error.master_fd is not None
        self.assert_closed(error.master_fd)
        with self.assertRaises(ChildProcessError):
            os.waitpid(error.pid, os.WNOHANG)

    def test_ready_without_exec_times_out_then_closes_and_reaps(self):
        original = terminal_screen.configure_pty_slave

        def block_after_ready(write_fd, width=PTY_WIDTH, height=PTY_HEIGHT):
            original(write_fd, width, height)
            time.sleep(1.0)

        terminal_screen.configure_pty_slave = block_after_ready
        try:
            with self.assertRaisesRegex(PtyHandshakeError, "EOF") as caught:
                spawn_pty([sys.executable, "-c", "pass"], Path.cwd(), os.environ.copy(), 0.05)
        finally:
            terminal_screen.configure_pty_slave = original
        error = caught.exception
        assert error.pid is not None
        assert error.master_fd is not None
        self.assert_closed(error.master_fd)
        with self.assertRaises(ChildProcessError):
            os.waitpid(error.pid, os.WNOHANG)

    def read_and_reap(self, pid, master_fd, deadline):
        output = bytearray()
        try:
            while time.monotonic() < deadline:
                readable, _, _ = select.select([master_fd], [], [], max(0.0, deadline - time.monotonic()))
                if not readable:
                    break
                try:
                    chunk = os.read(master_fd, 65536)
                except OSError as error:
                    if error.errno == errno.EIO:
                        break
                    raise
                if not chunk:
                    break
                output.extend(chunk)
        finally:
            os.close(master_fd)
        _, status = os.waitpid(pid, 0)
        return bytes(output), status


class BenchmarkHandshakeIntegrationTest(unittest.TestCase):
    def test_run_once_preserves_legacy_diagnostics_after_truthful_handshake(self):
        fixture = (
            "import time;"
            "print('Time to first draw: 12.5ms',flush=True);"
            "print('Ask anything...',flush=True);"
            "time.sleep(5)"
        )
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            tui_benchmark.prepare_state(state)
            result = tui_benchmark.run_once(
                [sys.executable, "-c", fixture],
                state,
                Path.cwd(),
                2.0,
                "none",
                b"Ask anything...",
            )

        self.assertTrue(result["pty_handshake_ok"])
        self.assertFalse(result["timed_out"])
        self.assertEqual(result["ttfd_ms"], 12.5)
        self.assertIsNotNone(result["first_byte_ms"])
        self.assertIsNotNone(result["ready_ms"])
        self.assertGreater(result["bytes_until_ready"], 0)

    def test_run_once_invalidates_pre_exec_failure_without_legacy_false_positive(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            tui_benchmark.prepare_state(state)
            result = tui_benchmark.run_once(
                ["/definitely/not/a/real/oc2-command"],
                state,
                Path.cwd(),
                1.0,
                "none",
                b"Ask anything...",
            )

        self.assertFalse(result["pty_handshake_ok"])
        self.assertTrue(result["timed_out"])
        self.assertIsNone(result["first_byte_ms"])
        self.assertIsNone(result["ready_ms"])
        self.assertIsNone(result["ttfd_ms"])
        self.assertEqual(result["bytes_until_ready"], 0)


if __name__ == "__main__":
    unittest.main()
