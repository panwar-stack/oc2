#!/usr/bin/env python3
"""Regenerate the Unicode tables used by OpenTUI 0.3.4.

By default the script downloads immutable GitHub sources. Local pinned
checkouts can be supplied for offline regeneration; their bytes are still
checked against the same SHA-256 values.
"""

from __future__ import annotations

import argparse
import hashlib
import re
import sys
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Mapping, Optional, Sequence, Tuple


UNICODE_VERSION = "16.0.0"
EMOJI_VERSION = "16.0"
UUCODE_VERSION = "0.1.0"
UUCODE_COMMIT = "84ceda8561a17ba4a9b96ac5c583f779660bbd4e"
OPENTUI_VERSION = "0.3.4"
OPENTUI_COMMIT = "9b216a58d974704ae638b3043aece2eb70b5ff19"
OPENTUI_PACKAGE_SHA256 = "bd4e3005d6e22c45a53f4b8231a105b6bb97ec3d23763a6ffaa4217bff74662e"
OPENTUI_NATIVE_DARWIN_ARM64_SHA256 = "ad66eb9a12f5137aa0468380f6fbfe6284cc3f80a175992b02316fd7973a5665"
UUCODE_ARCHIVE_SHA256 = "4a7f194ad1f583ffae00bf625986527df89ddd55309ff30314d2d17539a7b011"
MAX_CODE_POINT = 0x10FFFF

Range = Tuple[int, int]


@dataclass(frozen=True)
class Source:
    constant: str
    repository: str
    path: str
    sha256: str

    @property
    def url(self) -> str:
        commit = UUCODE_COMMIT if self.repository == "uucode" else OPENTUI_COMMIT
        owner = "jacobsandlund/uucode" if self.repository == "uucode" else "anomalyco/opentui"
        return f"https://raw.githubusercontent.com/{owner}/{commit}/{self.path}"


SOURCES = (
    Source(
        "GRAPHEME_BREAK_PROPERTY_SHA256",
        "uucode",
        "ucd/auxiliary/GraphemeBreakProperty.txt",
        "c29360bd6f7132811d701d29069541e827eb44bfc4c8fbde8c370d6982689dc1",
    ),
    Source(
        "EMOJI_DATA_SHA256",
        "uucode",
        "ucd/emoji/emoji-data.txt",
        "f1365a5173eee18e1f98b240cdc492e84a25f1ce7e0c9d1094eb29c41a22696a",
    ),
    Source(
        "DERIVED_CORE_PROPERTIES_SHA256",
        "uucode",
        "ucd/DerivedCoreProperties.txt",
        "39d35161f2954497f69e08bdb9e701493f476a3d30222de20028feda36c1dabd",
    ),
    Source(
        "UNICODE_DATA_SHA256",
        "uucode",
        "ucd/UnicodeData.txt",
        "ff58e5823bd095166564a006e47d111130813dcf8bf234ef79fa51a870edb48f",
    ),
    Source(
        "DERIVED_EAST_ASIAN_WIDTH_SHA256",
        "uucode",
        "ucd/extracted/DerivedEastAsianWidth.txt",
        "372e34de237e5a644ce8379a0d02b91a1f584f04d4fb240ea6ccc87c5767f926",
    ),
    Source(
        "OPENTUI_UTF8_ZIG_SHA256",
        "opentui",
        "packages/core/src/zig/utf8.zig",
        "58c69652acbbe55e05842c951c4ea5e5152f367be599dfabbe63fe6bcd6b99b1",
    ),
)

EXPECTED_COUNTS = {
    "GRAPHEME_EXTEND_RANGES": (376, 2198),
    "GCB_CONTROL_RANGES": (19, 3893),
    "GCB_PREPEND_RANGES": (16, 28),
    "GCB_SPACING_MARK_RANGES": (155, 378),
    "GCB_L_RANGES": (2, 125),
    "GCB_V_RANGES": (4, 100),
    "GCB_T_RANGES": (2, 137),
    "GCB_LV_RANGES": (399, 399),
    "GCB_LVT_RANGES": (399, 10773),
    "EXTENDED_PICTOGRAPHIC_RANGES": (78, 3537),
    "EMOJI_MODIFIER_BASE_RANGES": (40, 134),
    "INCB_LINKER_RANGES": (6, 6),
    "INCB_CONSONANT_RANGES": (26, 240),
    "ZERO_WIDTH_MARK_RANGES": (321, 2501),
    "NONSPACING_MARK_RANGES": (357, 2020),
    "OPENTUI_WIDE_RANGES": (134, 183615),
}

GCB_TABLES = {
    "Extend": "GRAPHEME_EXTEND_RANGES",
    "Control": "GCB_CONTROL_RANGES",
    "Prepend": "GCB_PREPEND_RANGES",
    "SpacingMark": "GCB_SPACING_MARK_RANGES",
    "L": "GCB_L_RANGES",
    "V": "GCB_V_RANGES",
    "T": "GCB_T_RANGES",
    "LV": "GCB_LV_RANGES",
    "LVT": "GCB_LVT_RANGES",
}

EMOJI_TABLES = {
    "Extended_Pictographic": "EXTENDED_PICTOGRAPHIC_RANGES",
    "Emoji_Modifier_Base": "EMOJI_MODIFIER_BASE_RANGES",
}

TABLE_ORDER = (
    "GRAPHEME_EXTEND_RANGES",
    "GCB_CONTROL_RANGES",
    "GCB_PREPEND_RANGES",
    "GCB_SPACING_MARK_RANGES",
    "GCB_L_RANGES",
    "GCB_V_RANGES",
    "GCB_T_RANGES",
    "GCB_LV_RANGES",
    "GCB_LVT_RANGES",
    "EXTENDED_PICTOGRAPHIC_RANGES",
    "EMOJI_MODIFIER_BASE_RANGES",
    "INCB_LINKER_RANGES",
    "INCB_CONSONANT_RANGES",
    "ZERO_WIDTH_MARK_RANGES",
    "NONSPACING_MARK_RANGES",
    "OPENTUI_WIDE_RANGES",
)


def parse_range(value: str) -> Range:
    fields = value.strip().split("..", 1)
    start = int(fields[0], 16)
    return start, int(fields[1], 16) if len(fields) == 2 else start


def merge_ranges(ranges: Iterable[Range]) -> Tuple[Range, ...]:
    merged: List[Range] = []
    for start, end in sorted(ranges):
        if merged and start <= merged[-1][1] + 1:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return tuple(merged)


def parse_semicolon_properties(text: str, wanted: Mapping[str, str]) -> Dict[str, Tuple[Range, ...]]:
    found: Dict[str, List[Range]] = {table: [] for table in wanted.values()}
    for line in text.splitlines():
        data = line.split("#", 1)[0].strip()
        if not data:
            continue
        fields = [field.strip() for field in data.split(";")]
        if len(fields) < 2 or fields[1] not in wanted:
            continue
        found[wanted[fields[1]]].append(parse_range(fields[0]))
    return {name: merge_ranges(ranges) for name, ranges in found.items()}


def parse_incb(text: str) -> Dict[str, Tuple[Range, ...]]:
    found: Dict[str, List[Range]] = {"INCB_LINKER_RANGES": [], "INCB_CONSONANT_RANGES": []}
    targets = {"Linker": "INCB_LINKER_RANGES", "Consonant": "INCB_CONSONANT_RANGES"}
    for line in text.splitlines():
        data = line.split("#", 1)[0].strip()
        if not data:
            continue
        fields = [field.strip() for field in data.split(";")]
        if len(fields) == 3 and fields[1] == "InCB" and fields[2] in targets:
            found[targets[fields[2]]].append(parse_range(fields[0]))
    return {name: merge_ranges(ranges) for name, ranges in found.items()}


def parse_unicode_marks(text: str) -> Tuple[bytearray, bytearray]:
    marks = bytearray(MAX_CODE_POINT + 1)
    nonspacing = bytearray(MAX_CODE_POINT + 1)
    pending: Optional[Tuple[int, str]] = None
    for line in text.splitlines():
        if not line:
            continue
        fields = line.split(";")
        code_point = int(fields[0], 16)
        name = fields[1]
        category = fields[2]
        if pending is not None:
            start, first_category = pending
            if not name.endswith("Last>") or category != first_category:
                raise ValueError("malformed UnicodeData First/Last range")
            if category in {"Mn", "Mc", "Me"}:
                marks[start : code_point + 1] = b"\1" * (code_point - start + 1)
            if category == "Mn":
                nonspacing[start : code_point + 1] = b"\1" * (code_point - start + 1)
            pending = None
        elif name.endswith("First>"):
            pending = (code_point, category)
        elif category in {"Mn", "Mc", "Me"}:
            marks[code_point] = 1
            if category == "Mn":
                nonspacing[code_point] = 1
    if pending is not None:
        raise ValueError("unterminated UnicodeData First/Last range")
    return marks, nonspacing


def parse_east_asian_wide(text: str) -> bytearray:
    wide = bytearray(MAX_CODE_POINT + 1)
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("# @missing:"):
            data = stripped[len("# @missing:") :]
            range_text, value = (field.strip() for field in data.split(";", 1))
            start, end = parse_range(range_text)
            wide[start : end + 1] = bytes([value == "Wide"]) * (end - start + 1)
            continue
        data = stripped.split("#", 1)[0].strip()
        if not data:
            continue
        range_text, value = (field.strip() for field in data.split(";", 1))
        start, end = parse_range(range_text)
        wide[start : end + 1] = bytes([value in {"W", "F"}]) * (end - start + 1)
    return wide


def zig_cp_conditions(line: str) -> List[Range]:
    ranges: List[Range] = []
    without_ranges = line
    pattern = re.compile(r"cp\s*>=\s*0x([0-9A-Fa-f]+)\s+and\s+cp\s*<=\s*0x([0-9A-Fa-f]+)")
    for match in pattern.finditer(line):
        ranges.append((int(match.group(1), 16), int(match.group(2), 16)))
    without_ranges = pattern.sub("", without_ranges)
    for value in re.findall(r"cp\s*==\s*0x([0-9A-Fa-f]+)", without_ranges):
        code_point = int(value, 16)
        ranges.append((code_point, code_point))
    return ranges


def parse_opentui_width_rules(text: str) -> Tuple[Tuple[Range, ...], Tuple[Range, ...]]:
    function_start = text.index("inline fn eawToWidth(")
    function_end = text.index("\n    return 1;", function_start)
    body = text[function_start:function_end]
    eaw_marker = "if (eaw == .fullwidth or eaw == .wide) return 2;"
    marker_offset = body.index(eaw_marker)
    zero_width: List[Range] = []
    tailored_wide: List[Range] = []
    for line in body.splitlines():
        if "return 0;" in line:
            zero_width.extend(zig_cp_conditions(line))
    tailoring = body[marker_offset + len(eaw_marker) :]
    for line in tailoring.splitlines():
        if "return 2;" in line:
            conditions = zig_cp_conditions(line)
            if not conditions:
                raise ValueError(f"unsupported OpenTUI width condition: {line.strip()}")
            tailored_wide.extend(conditions)
    # U+0000 is decimal in the source and is never wide; the nine hexadecimal
    # exclusions are the ones that can override Unicode width data.
    if len(zero_width) != 9 or not tailored_wide:
        raise ValueError("unexpected OpenTUI eawToWidth structure")
    return merge_ranges(zero_width), merge_ranges(tailored_wide)


def ranges_from_bitmap(bitmap: bytearray) -> Tuple[Range, ...]:
    ranges: List[Range] = []
    start: Optional[int] = None
    for code_point, included in enumerate(bitmap):
        if included and start is None:
            start = code_point
        elif not included and start is not None:
            ranges.append((start, code_point - 1))
            start = None
    if start is not None:
        ranges.append((start, MAX_CODE_POINT))
    return tuple(ranges)


def build_tables(source_text: Mapping[str, str]) -> Dict[str, Tuple[Range, ...]]:
    tables = parse_semicolon_properties(source_text["GRAPHEME_BREAK_PROPERTY_SHA256"], GCB_TABLES)
    tables.update(parse_semicolon_properties(source_text["EMOJI_DATA_SHA256"], EMOJI_TABLES))
    tables.update(parse_incb(source_text["DERIVED_CORE_PROPERTIES_SHA256"]))

    marks, nonspacing = parse_unicode_marks(source_text["UNICODE_DATA_SHA256"])
    tables["ZERO_WIDTH_MARK_RANGES"] = ranges_from_bitmap(marks)
    tables["NONSPACING_MARK_RANGES"] = ranges_from_bitmap(nonspacing)

    eaw_wide = parse_east_asian_wide(source_text["DERIVED_EAST_ASIAN_WIDTH_SHA256"])
    zero_width, tailored_wide = parse_opentui_width_rules(source_text["OPENTUI_UTF8_ZIG_SHA256"])
    for start, end in tailored_wide:
        eaw_wide[start : end + 1] = b"\1" * (end - start + 1)
    for start, end in zero_width:
        eaw_wide[start : end + 1] = b"\0" * (end - start + 1)
    # Keep the positive wide predicate separate from the general-category mark
    # predicate, matching eawToWidth's ordered checks. The sets intentionally
    # overlap for 11 Unicode 16 code points; callers apply marks first.
    tables["OPENTUI_WIDE_RANGES"] = ranges_from_bitmap(eaw_wide)

    for name, expected in EXPECTED_COUNTS.items():
        ranges = tables[name]
        actual = (len(ranges), sum(end - start + 1 for start, end in ranges))
        if actual != expected:
            raise ValueError(f"{name}: expected {expected}, got {actual}")
    return tables


def load_sources(uucode_root: Optional[Path], opentui_root: Optional[Path]) -> Dict[str, str]:
    loaded: Dict[str, str] = {}
    roots = {"uucode": uucode_root, "opentui": opentui_root}
    for source in SOURCES:
        root = roots[source.repository]
        if root is None:
            request = urllib.request.Request(source.url, headers={"User-Agent": "oc2-unicode-table-generator"})
            with urllib.request.urlopen(request, timeout=30) as response:
                data = response.read()
        else:
            data = (root / source.path).read_bytes()
        digest = hashlib.sha256(data).hexdigest()
        if digest != source.sha256:
            raise ValueError(f"{source.path}: expected SHA-256 {source.sha256}, got {digest}")
        loaded[source.constant] = data.decode("utf-8")
    return loaded


def format_ranges(name: str, ranges: Sequence[Range]) -> str:
    values = [f"(0x{start:X}, 0x{end:X})" for start, end in ranges]
    lines = [f"{name} = ("]
    for offset in range(0, len(values), 3):
        lines.append("    " + ", ".join(values[offset : offset + 3]) + ",")
    lines.append(")")
    return "\n".join(lines)


def render_module(tables: Mapping[str, Sequence[Range]]) -> str:
    provenance_names = (
        "UNICODE_VERSION",
        "EMOJI_VERSION",
        "UUCODE_VERSION",
        "UUCODE_COMMIT",
        "OPENTUI_VERSION",
        "OPENTUI_COMMIT",
        "OPENTUI_PACKAGE_SHA256",
        "OPENTUI_NATIVE_DARWIN_ARM64_SHA256",
        "UUCODE_ARCHIVE_SHA256",
        *(source.constant for source in SOURCES),
    )
    lines = [
        '"""Generated Unicode 16/OpenTUI 0.3.4 terminal range tables."""',
        "",
        "# Generated by generate_opentui_unicode_tables.py; do not edit by hand.",
        f"# uucode: https://github.com/jacobsandlund/uucode/tree/{UUCODE_COMMIT}",
        f"# OpenTUI: https://github.com/anomalyco/opentui/tree/{OPENTUI_COMMIT}",
        "# Unicode license: https://www.unicode.org/license.txt",
        "",
        "__all__ = (",
    ]
    lines.extend(f'    "{name}",' for name in (*provenance_names, *TABLE_ORDER))
    lines.extend(
        (
            ")",
            "",
            f'UNICODE_VERSION = "{UNICODE_VERSION}"',
            f'EMOJI_VERSION = "{EMOJI_VERSION}"',
            f'UUCODE_VERSION = "{UUCODE_VERSION}"',
            f'UUCODE_COMMIT = "{UUCODE_COMMIT}"',
            f'OPENTUI_VERSION = "{OPENTUI_VERSION}"',
            f'OPENTUI_COMMIT = "{OPENTUI_COMMIT}"',
            f'OPENTUI_PACKAGE_SHA256 = "{OPENTUI_PACKAGE_SHA256}"',
            f'OPENTUI_NATIVE_DARWIN_ARM64_SHA256 = "{OPENTUI_NATIVE_DARWIN_ARM64_SHA256}"',
            f'UUCODE_ARCHIVE_SHA256 = "{UUCODE_ARCHIVE_SHA256}"',
        )
    )
    for source in SOURCES:
        lines.append(f'{source.constant} = "{source.sha256}"')
    for name in TABLE_ORDER:
        lines.extend(("", format_ranges(name, tables[name])))
    return "\n".join(lines) + "\n"


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    default_output = Path(__file__).with_name("unicode_tables_opentui_0_3_4.py")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--uucode-root", type=Path, help="local checkout at the pinned uucode commit")
    parser.add_argument("--opentui-root", type=Path, help="local checkout at the pinned OpenTUI commit")
    parser.add_argument("--output", type=Path, default=default_output)
    parser.add_argument("--check", action="store_true", help="verify output is current without writing it")
    return parser.parse_args(argv)


def main(argv: Sequence[str]) -> int:
    args = parse_args(argv)
    rendered = render_module(build_tables(load_sources(args.uucode_root, args.opentui_root)))
    if args.check:
        if not args.output.exists() or args.output.read_text(encoding="utf-8") != rendered:
            print(f"out of date: {args.output}", file=sys.stderr)
            return 1
        print(f"verified: {args.output}")
        return 0
    args.output.write_text(rendered, encoding="utf-8")
    print(f"generated: {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
