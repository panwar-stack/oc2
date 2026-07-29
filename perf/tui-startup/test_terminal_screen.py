import errno
import fcntl
import os
import select
import sys
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import terminal_screen
import tui_benchmark
import tui_probe
from terminal_screen import (
    PTY_HEIGHT,
    PTY_WIDTH,
    PtyCleanupError,
    PtyHandshakeError,
    TerminalScreen,
    await_exec_handshake,
    create_exec_handshake,
    read_pty,
    spawn_pty,
    stop_pty_child,
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

    def test_wide_blank_uses_continuation_sentinel_for_overwrite_and_resize(self):
        lead = TerminalScreen(4, 1)
        initial = lead.feed(b"\x1b]66;w=2; \x1b\\X")[0]
        self.assertEqual(initial.cells[0], (" ", None, "X", " "))
        overwritten = lead.feed(b"\rY")[0]
        self.assertEqual(overwritten.cells[0], ("Y", " ", "X", " "))

        continuation = TerminalScreen(4, 1)
        continuation.feed(b"\x1b]66;w=2; \x1b\\X")
        overwritten = continuation.feed(b"\x1b[1;2HY")[0]
        self.assertEqual(overwritten.cells[0], (" ", "Y", "X", " "))

        resized = TerminalScreen(3, 1)
        resized.feed(b"\x1b]66;w=2; \x1b\\X")
        self.assertEqual(resized.resize(2, 1)[0].cells[0], (" ", None))
        self.assertEqual(resized.resize(1, 1)[0].cells[0], (" ",))

    def test_fragmented_scaled_text_owns_a_truthful_two_by_two_footprint(self):
        stream = b"\x1b[?2026h\x1b]66;s=2; \x1b\\X\x1b[?2026l"
        screen = TerminalScreen(5, 3)
        frames = []
        for value in stream:
            frames.extend(screen.feed(bytes((value,))))
        self.assertTrue(screen.valid, screen.invalid_reason)
        self.assertEqual(len(frames), 1)
        self.assertEqual(frames[0].cells[:2], ((" ", None, "X", " ", " "), (None, None, " ", " ", " ")))

        for row, column in ((0, 0), (0, 1)):
            with self.subTest(overwrite=(row, column)):
                overwritten = TerminalScreen(5, 3)
                overwritten.feed(b"\x1b]66;s=2; \x1b\\X")
                frame = overwritten.feed("\x1b[{};{}HY".format(row + 1, column + 1).encode("ascii"))[0]
                self.assertEqual(frame.cell(0, 0), " " if column else "Y")
                self.assertEqual(frame.cell(0, 1), "Y" if column else " ")
                self.assertEqual(frame.cells[1][:2], (" ", " "))

        for column in (0, 1):
            with self.subTest(lower_write=column):
                lower = TerminalScreen(5, 3)
                lower.feed(b"\x1b]66;s=2; \x1b\\X")
                frame = lower.feed("\x1b[2;{}HY".format(column + 1).encode("ascii"))[0]
                self.assertEqual(frame.cells[0][:3], (" ", None, "X"))
                self.assertEqual(frame.cells[1][:3], (None, None, "Y"))

    def test_scaled_text_erase_scroll_and_resize_keep_or_clear_whole_owners(self):
        for row, column in ((0, 0), (0, 1), (1, 0), (1, 1)):
            with self.subTest(erase=(row, column)):
                screen = TerminalScreen(4, 3)
                screen.feed(b"\x1b]66;s=2; \x1b\\X")
                frame = screen.feed("\x1b[{};{}H\x1b[X".format(row + 1, column + 1).encode("ascii"))[0]
                self.assertEqual(frame.cells[0][:2], (" ", " "))
                self.assertEqual(frame.cells[1][:2], (" ", " "))

        retained = TerminalScreen(4, 3)
        retained.feed(b"\x1b]66;s=2; \x1b\\X")
        self.assertEqual(retained.resize(2, 2)[0].cells, ((" ", None), (None, None)))
        for width, height in ((1, 2), (2, 1)):
            with self.subTest(clipped=(width, height)):
                clipped = TerminalScreen(4, 3)
                clipped.feed(b"\x1b]66;s=2; \x1b\\X")
                frame = clipped.resize(width, height)[0]
                self.assertTrue(all(cell == " " for row in frame.cells for cell in row))

        moved = TerminalScreen(4, 4)
        moved.feed(b"\x1b[2;1H\x1b]66;s=2; \x1b\\X\x1b[1S")
        self.assertEqual(moved.last_frame.cells[0][:3], (" ", None, "X"))
        self.assertEqual(moved.last_frame.cells[1][:2], (None, None))

        split = TerminalScreen(4, 4)
        split.feed(b"\x1b[2;1H\x1b]66;s=2; \x1b\\X\x1b[3;4r\x1b[1S")
        self.assertEqual(split.last_frame.cells[1][:2], (" ", " "))
        self.assertEqual(split.last_frame.cells[2][:2], (" ", " "))

        alternate = TerminalScreen(4, 3)
        alternate.feed(b"\x1b[?1049h\x1b]66;s=2; \x1b\\X")
        self.assertTrue(alternate.last_frame.alternate)
        self.assertEqual(alternate.last_frame.cells[1][:2], (None, None))

    def test_scaled_text_addressing_and_decaWM_disabled_positioning(self):
        for row, column in ((0, 0), (0, 1), (1, 0), (1, 1)):
            with self.subTest(combining_at=(row, column)):
                screen = TerminalScreen(4, 3)
                screen.feed(b"\x1b]66;s=2; \x1b\\")
                for value in ("\x1b[{};{}H".format(row + 1, column + 1) + "\u0301").encode("utf-8"):
                    screen.feed(bytes((value,)))
                self.assertTrue(screen.valid, screen.invalid_reason)
                self.assertEqual(screen.last_frame.cell(0, 0), " \u0301")
                self.assertEqual(screen.last_frame.cells[1][:2], (None, None))

        shifted = TerminalScreen(4, 3)
        shifted.feed(b"\x1b[7l\x1b[1;4H\x1b]66;s=2; \x1b\\")
        self.assertTrue(shifted.valid, shifted.invalid_reason)
        self.assertEqual(shifted.last_frame.cells[0], (" ", " ", " ", None))
        self.assertEqual(shifted.last_frame.cells[1][2:], (None, None))

        skipped = TerminalScreen(4, 3)
        skipped.feed(b"\x1b[7l\x1b[1;4H\x1b]66;s=2; \x1b\\\x1b[2;3HX")
        self.assertTrue(skipped.valid, skipped.invalid_reason)
        self.assertEqual(skipped.last_frame.cell(2, 0), "X")

    def test_fragmented_dynamic_widening_preserves_foreign_scaled_owner(self):
        clusters = ("❤️", "1\u20e3", "☝🏽", "🇺🇸", "©‍💻")
        setup = b"\x1b[?2026h\x1b[1;2H\x1b]66;s=2; \x1b\\\x1b[2;1H"
        for cluster in clusters:
            with self.subTest(cluster=cluster):
                natural = TerminalScreen(6, 3)
                natural_frames = []
                natural_stream = setup + (cluster + "X").encode("utf-8") + b"\x1b[?2026l"
                for value in natural_stream:
                    natural_frames.extend(natural.feed(bytes((value,))))

                explicit = TerminalScreen(6, 3)
                explicit_frames = []
                explicit_stream = (
                    setup
                    + b"\x1b]66;w=2;"
                    + cluster.encode("utf-8")
                    + b"\x1b\\X\x1b[?2026l"
                )
                for value in explicit_stream:
                    explicit_frames.extend(explicit.feed(bytes((value,))))

                self.assertTrue(natural.valid, natural.invalid_reason)
                self.assertTrue(explicit.valid, explicit.invalid_reason)
                self.assertEqual(len(natural_frames), 1)
                self.assertEqual(natural_frames[0].cells, explicit_frames[0].cells)
                frame = natural_frames[0]
                self.assertEqual(frame.cells[0][1:3], (" ", None))
                self.assertEqual(frame.cells[1], (" ", None, None, cluster, None, "X"))

                overwritten = natural.feed(b"\x1b[2;4HY")[0]
                self.assertEqual(overwritten.cells[0][1:3], (" ", None))
                self.assertEqual(overwritten.cells[1], (" ", None, None, "Y", " ", "X"))

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

    def test_resize_clears_truncated_original_emoji_cluster_width(self):
        clusters = ("❤️", "🇺🇸", "1\u20e3", "1️\u20e3", "👩‍💻", "👍🏽", "☝🏽")
        for cluster in clusters:
            with self.subTest(cluster=cluster):
                screen = TerminalScreen(4, 1)
                original = screen.feed((cluster + "X").encode("utf-8"))[0]
                self.assertEqual(original.cell(0, 0), cluster)
                self.assertIsNone(original.cell(0, 1))
                self.assertEqual(original.cell(0, 2), "X")

                retained = screen.resize(2, 1)[0]
                self.assertEqual(retained.cell(0, 0), cluster)
                self.assertIsNone(retained.cell(0, 1))
                shrunk = screen.resize(1, 1)[0]
                self.assertTrue(screen.valid, screen.invalid_reason)
                self.assertEqual(shrunk.cells[0], (" ",))

        explicit = TerminalScreen(3, 1)
        explicit.feed(b"\x1b]66;w=2;A\x1b\\X")
        self.assertEqual(explicit.resize(1, 1)[0].cells[0], (" ",))

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

    def test_fragmented_bounded_scroll_counts_preserve_every_outside_row(self):
        original = ("AAAA", "BBBB", "CCCC", "DDDD", "EEEE", "FFFF")
        region = original[1:5]
        for final in ("S", "T"):
            for count in range(1, len(region) + 1):
                with self.subTest(final=final, count=count):
                    screen = TerminalScreen(4, len(original))
                    setup = "".join(
                        "\x1b[{};1H{}".format(row, value) for row, value in enumerate(original, 1)
                    ).encode("ascii")
                    screen.feed(setup + b"\x1b[2;5r")
                    frames = []
                    for value in "\x1b[{}{}".format(count, final).encode("ascii"):
                        frames.extend(screen.feed(bytes((value,))))

                    if final == "S":
                        expected_region = region[count:] + ("    ",) * count
                    else:
                        expected_region = ("    ",) * count + region[: len(region) - count]
                    self.assertTrue(screen.valid, screen.invalid_reason)
                    self.assertEqual(len(frames), 1)
                    self.assertEqual(frames[0].lines, original[:1] + expected_region + original[5:])

    def test_fragmented_zero_width_marks_and_emoji_clusters_place_following_cells(self):
        screen = TerminalScreen(20, 1)
        text = "a\u034fb\u20ddc1\u20e3X1️\u20e3Y👩‍💻Z👍🏽Q🇺🇸R"
        stream = b"\x1b[?2026h" + text.encode("utf-8") + b"\x1b[?2026l"
        frames = []
        for value in stream:
            frames.extend(screen.feed(bytes((value,))))

        self.assertTrue(screen.valid, screen.invalid_reason)
        self.assertEqual(len(frames), 1)
        cells = frames[0].cells[0]
        self.assertEqual(cells[0], "a\u034f")
        self.assertEqual(cells[1], "b\u20dd")
        self.assertEqual(cells[2], "c")
        self.assertEqual(cells[3], "1\u20e3")
        self.assertIsNone(cells[4])
        self.assertEqual(cells[5], "X")
        self.assertEqual(cells[6], "1️\u20e3")
        self.assertIsNone(cells[7])
        self.assertEqual(cells[8], "Y")
        self.assertEqual(cells[9], "👩‍💻")
        self.assertIsNone(cells[10])
        self.assertEqual(cells[11], "Z")
        self.assertEqual(cells[12], "👍🏽")
        self.assertIsNone(cells[13])
        self.assertEqual(cells[14], "Q")
        self.assertEqual(cells[15], "🇺🇸")
        self.assertIsNone(cells[16])
        self.assertEqual(cells[17], "R")

    def test_fragmented_base_aware_variation_keycap_and_modifier_sequences(self):
        screen = TerminalScreen(12, 1)
        text = "☝🏽X☝️🏽Y👍🏽Z"
        stream = b"\x1b[?2026h" + text.encode("utf-8") + b"\x1b[?2026l"
        frames = []
        for value in stream:
            frames.extend(screen.feed(bytes((value,))))

        self.assertTrue(screen.valid, screen.invalid_reason)
        self.assertEqual(len(frames), 1)
        cells = frames[0].cells[0]
        self.assertEqual(cells[:9], ("☝🏽", None, "X", "☝️🏽", None, "Y", "👍🏽", None, "Z"))

        for cluster in ("💏🏽", "💑🏽"):
            with self.subTest(cluster=cluster):
                modified = TerminalScreen(4, 1)
                for value in (cluster + "X").encode("utf-8"):
                    modified.feed(bytes((value,)))
                self.assertTrue(modified.valid, modified.invalid_reason)
                self.assertEqual(modified.last_frame.cells[0], (cluster, None, "X", " "))

        unicode_17_cluster = "👨🏻‍\U0001faef‍👨🏼"
        unicode_17 = TerminalScreen(4, 1)
        for value in (unicode_17_cluster + "X").encode("utf-8"):
            unicode_17.feed(bytes((value,)))
        self.assertTrue(unicode_17.valid, unicode_17.invalid_reason)
        self.assertEqual(unicode_17.last_frame.cells[0], (unicode_17_cluster, None, "X", " "))

        for base in "#*0123456789":
            for variation in ("", "️"):
                cluster = base + variation + "\u20e3"
                with self.subTest(cluster=cluster):
                    keycap = TerminalScreen(4, 1)
                    frames = []
                    data = b"\x1b[?2026h" + (cluster + "X").encode("utf-8") + b"\x1b[?2026l"
                    for value in data:
                        frames.extend(keycap.feed(bytes((value,))))
                    self.assertTrue(keycap.valid, keycap.invalid_reason)
                    self.assertEqual(frames[0].cells[0], (cluster, None, "X", " "))

    def test_fragmented_invalid_cluster_bases_do_not_shift_or_fail_open(self):
        for mark in ("️", "\u20e3"):
            with self.subTest(mark=mark):
                screen = TerminalScreen(3, 1)
                for value in ("A" + mark + "B").encode("utf-8"):
                    screen.feed(bytes((value,)))
                self.assertTrue(screen.valid, screen.invalid_reason)
                self.assertEqual(screen.last_frame.cells[0], ("A" + mark, "B", " "))
                self.assertEqual(screen.resize(1, 1)[0].cells[0], ("A" + mark,))
                self.assertEqual(screen.feed(b"\rC")[0].cells[0], ("C",))

        for text in ("A🏽B", "A‍B", "🏽A", "🇺🇸‍💻X", "👩‍️💻X", "👩‍#X", "#️‍💻X"):
            with self.subTest(text=text):
                screen = TerminalScreen(4, 1)
                frames = []
                data = b"\x1b[?2026h" + text.encode("utf-8") + b"\x1b[?2026l"
                for value in data:
                    frames.extend(screen.feed(bytes((value,))))
                self.assertFalse(screen.valid)
                self.assertEqual(frames, [])

    def test_unicode_17_properties_and_gb11_do_not_depend_on_host_ucd(self):
        self.assertEqual(terminal_screen._cell_width("\U00011f00"), 0)
        self.assertEqual(terminal_screen._cell_width("\U0001faef"), 2)
        self.assertTrue(terminal_screen._is_extended_pictographic("\U0001faef"))
        self.assertFalse(terminal_screen._is_extended_pictographic("\U0001f200"))

        valid = ("👩\u0301\U00011f00‍💻", "©‍💻", "👨🏻‍\U0001faef‍👨🏼")
        for cluster in valid:
            with self.subTest(valid=cluster):
                screen = TerminalScreen(5, 2)
                frames = []
                stream = b"\x1b[?2026h" + (cluster + "X").encode("utf-8") + b"\x1b[?2026l"
                for value in stream:
                    frames.extend(screen.feed(bytes((value,))))
                self.assertTrue(screen.valid, screen.invalid_reason)
                self.assertEqual(frames[0].cells[0][:3], (cluster, None, "X"))

        for cluster in ("👩‍\U0001f200", "\U0001f200‍💻", "🇺🇸‍💻", "#️‍💻"):
            with self.subTest(invalid=cluster):
                screen = TerminalScreen(5, 2)
                for value in (b"\x1b[?2026h" + cluster.encode("utf-8") + b"\x1b[?2026l"):
                    screen.feed(bytes((value,)))
                self.assertFalse(screen.valid)
                self.assertIsNone(screen.last_frame)

    def test_variation_narrowing_and_right_margin_widening_wrap_truthfully(self):
        narrowed = TerminalScreen(4, 1)
        narrowed.feed("⌚︎X".encode("utf-8"))
        self.assertEqual(narrowed.last_frame.cells[0], ("⌚︎", "X", " ", " "))

        clusters = ("1\u20e3", "☝🏽", "🇺🇸", "❤️", "©‍💻")
        for cluster in clusters:
            with self.subTest(cluster=cluster):
                screen = TerminalScreen(4, 2)
                for value in ("abc" + cluster + "X").encode("utf-8"):
                    screen.feed(bytes((value,)))
                self.assertTrue(screen.valid, screen.invalid_reason)
                self.assertEqual(screen.last_frame.cells[0], ("a", "b", "c", " "))
                self.assertEqual(screen.last_frame.cells[1][:3], (cluster, None, "X"))

        disabled = TerminalScreen(4, 2)
        disabled.feed(b"\x1b[7labc")
        disabled.feed("1\u20e3".encode("utf-8"))
        self.assertTrue(disabled.valid, disabled.invalid_reason)
        self.assertEqual(disabled.last_frame.cells[0], ("a", "b", "1\u20e3", None))

        too_narrow = TerminalScreen(1, 2)
        too_narrow.feed("1\u20e3".encode("utf-8"))
        self.assertFalse(too_narrow.valid)

    def test_dangling_zwj_invalidates_at_eof(self):
        eof = TerminalScreen(4, 2)
        eof.feed("👩‍".encode("utf-8"))
        eof.finish()
        self.assertFalse(eof.valid)

    def test_resize_preserves_surviving_unicode_cluster_state_inside_and_outside_sync(self):
        cases = (
            ("a", "\U00011f00", "a\U00011f00", 1),
            ("🇺", "🇸", "🇺🇸", 2),
            ("❤", "️", "❤️", 2),
            ("1", "\u20e3", "1\u20e3", 2),
            ("☝", "🏽", "☝🏽", 2),
            ("©‍", "💻", "©‍💻", 2),
        )
        for synchronized in (False, True):
            for prefix, suffix, cluster, width in cases:
                with self.subTest(synchronized=synchronized, cluster=cluster):
                    screen = TerminalScreen(6, 2)
                    if synchronized:
                        screen.feed(b"\x1b[?2026h")
                    for value in prefix.encode("utf-8"):
                        screen.feed(bytes((value,)))
                    resize_frames = screen.resize(7, 3)
                    if synchronized:
                        self.assertEqual(resize_frames, ())
                    else:
                        self.assertEqual(len(resize_frames), 1)
                    for value in (suffix + "X").encode("utf-8"):
                        screen.feed(bytes((value,)))
                    if synchronized:
                        frames = screen.feed(b"\x1b[?2026l")
                        self.assertEqual(len(frames), 1)
                    self.assertTrue(screen.valid, screen.invalid_reason)
                    self.assertEqual(screen.last_frame.cell(0, 0), cluster)
                    if width == 2:
                        self.assertIsNone(screen.last_frame.cell(0, 1))
                    self.assertEqual(screen.last_frame.cell(0, width), "X")

        for synchronized in (False, True):
            with self.subTest(truncated_zwj=synchronized):
                screen = TerminalScreen(4, 2)
                if synchronized:
                    screen.feed(b"\x1b[?2026h")
                screen.feed(b"\x1b[1;3H" + "👩‍".encode("utf-8"))
                self.assertEqual(screen.resize(3, 2), ())
                self.assertFalse(screen.valid)
                if synchronized:
                    self.assertIsNone(screen.last_frame)

    def test_resize_dropped_lead_cannot_rebind_to_clamped_foreign_owner(self):
        for synchronized in (False, True):
            for suffix in ("\u0301", "️"):
                with self.subTest(synchronized=synchronized, suffix=suffix):
                    screen = TerminalScreen(6, 3)
                    if synchronized:
                        screen.feed(b"\x1b[?2026h")
                    screen.feed(b"\x1b[1;3H\x1b]66;s=2; \x1b\\\x1b[1;6Ha")
                    screen.resize(4, 3)
                    for value in suffix.encode("utf-8"):
                        screen.feed(bytes((value,)))
                    if suffix == "️":
                        self.assertFalse(screen.valid)
                        if synchronized:
                            self.assertIsNone(screen.last_frame)
                        else:
                            self.assertEqual(screen.last_frame.cell(0, 2), " ")
                    else:
                        if synchronized:
                            screen.feed(b"\x1b[?2026l")
                        self.assertTrue(screen.valid, screen.invalid_reason)
                        self.assertEqual(screen.last_frame.cell(0, 2), " ")
                        self.assertEqual(screen.last_frame.cells[1][2:4], (None, None))

    def test_owner_aware_widening_wraps_or_fails_closed_without_cycles(self):
        clusters = ("❤️", "1\u20e3", "☝🏽", "🇺🇸", "©‍💻")
        for cluster in clusters:
            with self.subTest(wrapped=cluster):
                screen = TerminalScreen(4, 3)
                screen.feed(b"\x1b[1;2H\x1b]66;s=2; \x1b\\\x1b[2;1H")
                screen.feed((cluster + "X").encode("utf-8"))
                self.assertTrue(screen.valid, screen.invalid_reason)
                self.assertEqual(screen.last_frame.cells[0][1:3], (" ", None))
                self.assertEqual(screen.last_frame.cells[1][1:3], (None, None))
                self.assertEqual(screen.last_frame.cells[2][:3], (cluster, None, "X"))

            with self.subTest(no_progress=cluster):
                blocked = TerminalScreen(4, 3)
                blocked.feed(b"\x1b[2;2H\x1b]66;s=2; \x1b\\\x1b[1;2r\x1b[3;1H")
                blocked.feed(cluster.encode("utf-8"))
                self.assertFalse(blocked.valid)
                self.assertIn("owner-safe", blocked.invalid_reason)

    def test_fragmented_osc66_rejects_controls_and_noncharacters(self):
        rejected = ("\x00", "\t", "\n", "\x7f", "\x80", "\u0378", "\ufdd0", "\ufffe", "\U0001ffff")
        for character in rejected:
            with self.subTest(character=repr(character)):
                screen = TerminalScreen(8, 2)
                stream = b"\x1b[?2026h\x1b]66;w=1;" + character.encode("utf-8") + b"\x1b\\\x1b[?2026l"
                for value in stream:
                    screen.feed(bytes((value,)))
                self.assertFalse(screen.valid)
                self.assertIsNone(screen.last_frame)

        malformed = TerminalScreen(8, 2)
        malformed.feed(b"\x1b[?2026h\x1b]66;w=1;\xff\x1b\\")
        self.assertFalse(malformed.valid)

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

    def test_fragmented_osc_allowlist_accepts_only_proven_payload_shapes(self):
        proven = (
            b"4;0;?",
            b"4;255;?",
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
        )
        for payload in proven:
            with self.subTest(proven=payload):
                screen = TerminalScreen(8, 1)
                for value in b"\x1b]" + payload + b"\x1b\\":
                    screen.feed(bytes((value,)))
                self.assertTrue(screen.valid, screen.invalid_reason)

        rejected = (
            b"0;mutating-title",
            b"2;mutating-title",
            b"4;0;#ffffff",
            b"4;00;?",
            b"4;256;?",
            b"10;rgb:ff/ff/ff",
            b"11;rgb:00/00/00",
            b"12;#00aAfF",
            b"12;default",
            b"12;not-a-color",
            b"22;pointer",
            b"22;",
            b"52;c;AAAA",
            b"8;;",
            b"8;id=17;https://example.invalid/path",
            b"66;s=1; ",
            b"66;s=2;X",
            b"66;w=01;A",
            b"99;i=opentui-1:p=body:e=1:d=1;AAAA",
            b"777;notify;title;body",
            b"112",
            b"112;extra",
            b"1337;Capabilities=No",
            b"1337;File=inline=1:AAAA",
            b"1337;File=name=dGVzdA==:AAAA",
        )
        for payload in rejected:
            with self.subTest(rejected=payload):
                screen = TerminalScreen(8, 1)
                for value in b"\x1b]" + payload + b"\x1b\\":
                    screen.feed(bytes((value,)))
                self.assertFalse(screen.valid)

    def test_fragmented_passthrough_cannot_bypass_osc_allowlist(self):
        def wrapped(prefix, inner):
            return b"\x1bP" + prefix + inner.replace(b"\x1b", b"\x1b\x1b") + b"\x1b\\"

        proven = (
            wrapped(b"tmux;", b"\x1b]4;0;?\x07"),
            wrapped(b"tmux;", b"\x1b[?1016$p\x1b[?2026$p"),
            wrapped(b"", b"\x1b]4;255;?\x07"),
            b"\x1bP\x1b]4;255;?\x07\x1b\\",
        )
        for stream in proven:
            with self.subTest(proven=stream):
                screen = TerminalScreen(8, 1)
                for value in stream:
                    screen.feed(bytes((value,)))
                self.assertTrue(screen.valid, screen.invalid_reason)
                self.assertIsNone(screen.last_frame)

        rejected = (
            b"\x1b]1337;File=inline=1:AAAA\x1b\\",
            b"\x1b]999;unknown\x1b\\",
        )
        for prefix in (b"tmux;", b""):
            for inner in rejected:
                stream = wrapped(prefix, inner)
                with self.subTest(prefix=prefix, rejected=inner):
                    screen = TerminalScreen(8, 1)
                    for value in stream:
                        screen.feed(bytes((value,)))
                    self.assertFalse(screen.valid)

    def test_fragmented_passthrough_applies_inner_mutations_to_same_state(self):
        def wrapped(prefix, inner):
            return b"\x1bP" + prefix + inner.replace(b"\x1b", b"\x1b\x1b") + b"\x1b\\"

        for prefix in (b"tmux;", b""):
            with self.subTest(prefix=prefix):
                cursor = TerminalScreen(5, 2)
                cursor.feed(b"AB")
                for value in wrapped(prefix, b"\x1b[1D"):
                    cursor.feed(bytes((value,)))
                cursor.feed(b"X")
                self.assertEqual(cursor.last_frame.line(0), "AX   ")

                paint = TerminalScreen(5, 2)
                for value in wrapped(prefix, b"\x1b[HOK"):
                    paint.feed(bytes((value,)))
                self.assertTrue(paint.valid, paint.invalid_reason)
                self.assertEqual(paint.last_frame.line(0), "OK   ")

                scaled = TerminalScreen(5, 3)
                for value in wrapped(prefix, b"\x1b]66;s=2; \x1b\\X"):
                    scaled.feed(bytes((value,)))
                self.assertEqual(scaled.last_frame.cells[1][:2], (None, None))
                self.assertEqual(scaled.last_frame.cell(0, 2), "X")

                synchronized = TerminalScreen(5, 2)
                synchronized.feed(b"\x1b[?2026h")
                frames = []
                for value in wrapped(prefix, b"\x1b[HOK\x1b[?2026l"):
                    frames.extend(synchronized.feed(bytes((value,))))
                self.assertEqual(len(frames), 1)
                self.assertEqual(frames[0].line(0), "OK   ")

        raw_screen = TerminalScreen(5, 2)
        raw_screen.feed(b"AB")
        for value in b"\x1bP\x1b[1D\x1b\\":
            raw_screen.feed(bytes((value,)))
        raw_screen.feed(b"X")
        self.assertTrue(raw_screen.valid, raw_screen.invalid_reason)
        self.assertEqual(raw_screen.last_frame.line(0), "AX   ")

    def test_passthrough_rejects_nested_malformed_and_unproven_wrappers(self):
        def wrapped(prefix, inner):
            return b"\x1bP" + prefix + inner.replace(b"\x1b", b"\x1b\x1b") + b"\x1b\\"

        inner = wrapped(b"tmux;", b"\x1b]4;0;?\x07")
        streams = (
            wrapped(b"tmux;", inner),
            wrapped(b"", inner),
            b"\x1bPtmux;\x07\x1b\\",
            b"\x1bPtmux;\x1b[H\x1b\\",
            b"\x1bP\x07\x1b\\",
            b"\x1bP\x1b]52;c;AAAA\x07\x1b\\",
            b"\x1bP\x1b]1337;File=inline=1:AAAA\x07\x1b\\",
            b"\x1bP\x1bP\x1b[H\x1b\\\x1b\\",
        )
        for stream in streams:
            with self.subTest(stream=stream):
                screen = TerminalScreen(5, 2)
                for value in stream:
                    screen.feed(bytes((value,)))
                self.assertFalse(screen.valid)

        for prefix in (b"tmux;", b""):
            rollback = TerminalScreen(8, 2)
            rollback.feed(b"\x1b[?2026hREADY")
            frames = rollback.feed(wrapped(prefix, b"\x1b[?2026l" + inner))
            self.assertFalse(rollback.valid)
            self.assertEqual(frames, ())
            self.assertIsNone(rollback.last_frame)

    def test_explicit_width_osc_and_emoji_clusters_occupy_truthful_cells(self):
        screen = TerminalScreen(12, 1)
        stream = (
            b"\x1b[?2026h\x1b]66;w=2;\xe2\x9d\xa4\x1b\\"
            + "🇺🇸❤️".encode("utf-8")
            + b"x\x1b[?2026l"
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

    def test_parent_cleanup_faults_still_attempt_every_descriptor_and_reap(self):
        def transient_closer(calls):
            attempts = {}

            def close(fd):
                calls.append(fd)
                attempts[fd] = attempts.get(fd, 0) + 1
                if attempts[fd] == 1:
                    raise KeyboardInterrupt()

            return close

        close_calls = []
        with mock.patch.object(terminal_screen.os, "pipe", return_value=(3, 4)):
            with mock.patch.object(terminal_screen.fcntl, "fcntl", side_effect=RuntimeError("flags")):
                with mock.patch.object(terminal_screen, "_close", side_effect=transient_closer(close_calls)):
                    with self.assertRaises(RuntimeError):
                        create_exec_handshake()
                    self.assertEqual(close_calls, [3, 3, 4, 4])

        close_calls = []
        with mock.patch.object(terminal_screen, "create_exec_handshake", return_value=(3, 4)):
            with mock.patch.object(terminal_screen.pty, "fork", side_effect=RuntimeError("fork")):
                with mock.patch.object(terminal_screen, "_close", side_effect=transient_closer(close_calls)):
                    with self.assertRaises(RuntimeError):
                        spawn_pty(["cmd"], Path.cwd(), {}, 1)
                    self.assertEqual(close_calls, [3, 3, 4, 4])

        close_calls = []

        def fail_parent_writer(fd):
            close_calls.append(fd)
            if fd == 4 and close_calls.count(4) == 1:
                raise KeyboardInterrupt()

        with mock.patch.object(terminal_screen, "create_exec_handshake", return_value=(3, 4)):
            with mock.patch.object(terminal_screen.pty, "fork", return_value=(42, 7)):
                with mock.patch.object(terminal_screen, "_close", side_effect=fail_parent_writer):
                    with mock.patch.object(terminal_screen, "_reap_after_failed_spawn") as reaped:
                        with self.assertRaises(KeyboardInterrupt):
                            spawn_pty(["cmd"], Path.cwd(), {}, 1)
                        self.assertEqual(close_calls, [4, 3, 4])
                        reaped.assert_called_once_with(42, 7)

        with mock.patch.object(terminal_screen, "_close", side_effect=KeyboardInterrupt):
            with mock.patch.object(terminal_screen, "stop_pty_child") as stopped:
                with self.assertRaises(KeyboardInterrupt):
                    terminal_screen._reap_after_failed_spawn(42, 7)
                stopped.assert_called_once_with(42, None)

    def test_child_exec_faults_always_report_and_exit_without_returning(self):
        fault_points = ("close", "configure", "chdir", "exec", "exec-return")
        for fault in fault_points:
            with self.subTest(fault=fault):
                patches = [
                    mock.patch.object(terminal_screen.os, "_exit", return_value=None),
                    mock.patch.object(terminal_screen.os, "write", return_value=1),
                    mock.patch.object(terminal_screen, "report_exec_failure"),
                    mock.patch.object(terminal_screen, "_close"),
                    mock.patch.object(terminal_screen, "configure_pty_slave"),
                    mock.patch.object(terminal_screen.os, "chdir"),
                    mock.patch.object(terminal_screen.os, "execvpe", return_value=None),
                ]
                entered = [patch.start() for patch in patches]
                try:
                    target = {
                        "close": entered[3],
                        "configure": entered[4],
                        "chdir": entered[5],
                        "exec": entered[6],
                    }.get(fault)
                    if target is not None:
                        target.side_effect = RuntimeError(fault)
                    with self.assertRaises(SystemExit):
                        terminal_screen._exec_pty_child(3, 4, ["cmd"], Path.cwd(), {}, 80, 24)
                    entered[2].assert_called_once_with(4)
                    entered[0].assert_called_once_with(127)
                finally:
                    for patch in reversed(patches):
                        patch.stop()

        with mock.patch.object(terminal_screen, "report_exec_failure", side_effect=KeyboardInterrupt):
            with mock.patch.object(terminal_screen, "_close"):
                with mock.patch.object(terminal_screen, "configure_pty_slave"):
                    with mock.patch.object(terminal_screen.os, "chdir"):
                        with mock.patch.object(terminal_screen.os, "execvpe", side_effect=OSError("exec")):
                            with mock.patch.object(terminal_screen.os, "write", side_effect=KeyboardInterrupt):
                                with mock.patch.object(terminal_screen.os, "_exit", return_value=None) as child_exit:
                                    with self.assertRaises(SystemExit):
                                        terminal_screen._exec_pty_child(3, 4, ["cmd"], Path.cwd(), {}, 80, 24)
                                    child_exit.assert_called_once_with(127)

    def test_pty_read_retries_interrupt_and_only_eio_is_eof(self):
        with mock.patch.object(terminal_screen.os, "read", side_effect=[InterruptedError(), b"data"]):
            self.assertEqual(read_pty(3), b"data")
        with mock.patch.object(terminal_screen.os, "read", side_effect=OSError(errno.EIO, "pty eof")):
            self.assertEqual(read_pty(3), b"")
        with mock.patch.object(terminal_screen.os, "read", side_effect=OSError(errno.EBADF, "bad fd")):
            with self.assertRaises(OSError) as caught:
                read_pty(3)
            self.assertEqual(caught.exception.errno, errno.EBADF)

        with mock.patch.object(terminal_screen.os, "close", side_effect=[InterruptedError(), None]) as closed:
            terminal_screen.close_pty_fd(3)
            self.assertEqual(closed.call_count, 2)
        with mock.patch.object(terminal_screen.os, "close", side_effect=InterruptedError()) as closed:
            with self.assertRaises(InterruptedError):
                terminal_screen.close_pty_fd(3)
            self.assertEqual(closed.call_count, 2)

    def test_stop_child_verifies_group_after_sigkill_and_fails_closed(self):
        with mock.patch.object(terminal_screen, "_child_process_group", return_value=42):
            with mock.patch.object(terminal_screen, "_wait_for_child", side_effect=[None, None, 9]):
                with mock.patch.object(terminal_screen, "_process_group_exists", return_value=True):
                    with mock.patch.object(terminal_screen, "_wait_for_process_group", side_effect=[False, True]):
                        with mock.patch.object(terminal_screen, "_signal_child") as signaled:
                            with mock.patch.object(terminal_screen.os, "write"):
                                self.assertEqual(stop_pty_child(42, 7), 9)
        self.assertEqual(
            [call.args[1] for call in signaled.call_args_list],
            [terminal_screen.signal.SIGTERM, terminal_screen.signal.SIGKILL],
        )

        with mock.patch.object(terminal_screen, "_child_process_group", return_value=42):
            with mock.patch.object(terminal_screen, "_wait_for_child", side_effect=[None, None, None]):
                with mock.patch.object(terminal_screen, "_process_group_exists", return_value=True):
                    with mock.patch.object(terminal_screen, "_wait_for_process_group", return_value=False):
                        with mock.patch.object(terminal_screen, "_signal_child"):
                            with self.assertRaises(PtyCleanupError):
                                stop_pty_child(42, None)

        with mock.patch.object(terminal_screen.os, "killpg", side_effect=PermissionError()):
            with self.assertRaises(PtyCleanupError):
                terminal_screen._process_group_exists(42)

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
    def test_benchmark_propagates_non_eio_and_closes_fd_when_stop_fails(self):
        child = terminal_screen.PtyProcess(42, 7, time.perf_counter_ns(), time.monotonic() + 1)
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            tui_benchmark.prepare_state(state)
            with mock.patch.object(tui_benchmark, "spawn_pty", return_value=child):
                with mock.patch.object(tui_benchmark.select, "select", return_value=([7], [], [])):
                    with mock.patch.object(tui_benchmark, "read_pty", side_effect=OSError(errno.EBADF, "bad fd")):
                        with mock.patch.object(tui_benchmark, "stop_pty_child"):
                            with mock.patch.object(tui_benchmark, "close_pty_fd") as closed:
                                with self.assertRaises(OSError) as caught:
                                    tui_benchmark.run_once(["cmd"], state, Path.cwd(), 1, "none", b"ready")
                                self.assertEqual(caught.exception.errno, errno.EBADF)
                                closed.assert_called_once_with(7)

            with mock.patch.object(tui_benchmark, "spawn_pty", return_value=child):
                with mock.patch.object(tui_benchmark.select, "select", side_effect=RuntimeError("read")):
                    with mock.patch.object(tui_benchmark, "stop_pty_child", side_effect=PtyCleanupError("stop")):
                        with mock.patch.object(tui_benchmark, "close_pty_fd") as closed:
                            with self.assertRaises(PtyCleanupError):
                                tui_benchmark.run_once(["cmd"], state, Path.cwd(), 1, "none", b"ready")
                            closed.assert_called_once_with(7)

    def test_probe_cleanup_closes_fd_and_removes_state_when_stop_fails(self):
        child = terminal_screen.PtyProcess(42, 7, time.perf_counter_ns(), time.monotonic() + 1)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            args = SimpleNamespace(
                command=["cmd"],
                timeout=1.0,
                cwd=Path.cwd(),
                raw=root / "output.raw",
                force=True,
                state_root=root,
                keep_state=False,
            )
            parser = mock.Mock()
            parser.parse_args.return_value = args
            with mock.patch.object(tui_probe, "build_parser", return_value=parser):
                with mock.patch.object(tui_probe, "spawn_pty", return_value=child):
                    with mock.patch.object(tui_probe.select, "select", side_effect=RuntimeError("read")):
                        with mock.patch.object(tui_probe, "stop_pty_child", side_effect=PtyCleanupError("stop")):
                            with mock.patch.object(tui_probe, "close_pty_fd") as closed:
                                with mock.patch.object(tui_probe.shutil, "rmtree") as removed:
                                    with self.assertRaises(PtyCleanupError):
                                        tui_probe.main()
                                    closed.assert_called_once_with(7)
                                    removed.assert_called_once()

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
