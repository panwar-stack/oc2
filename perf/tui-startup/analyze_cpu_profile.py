#!/usr/bin/env python3
"""Summarize a Bun/V8 CPU profile using sample counts rather than self-time."""

import argparse
import collections
import json
import re
from pathlib import Path
from typing import Any, Iterable, Optional


def frame_name(node: dict[str, Any]) -> str:
    frame = node.get("callFrame", {})
    function = frame.get("functionName") or "(anonymous)"
    url = frame.get("url") or "[native]"
    line = frame.get("lineNumber", -1)
    location = f"{url}:{line + 1}" if isinstance(line, int) and line >= 0 else url
    return f"{function} ({location})"


def leaf_bucket(node: dict[str, Any]) -> str:
    url = node.get("callFrame", {}).get("url") or "[native]"
    bun_marker = "/node_modules/.bun/"
    if bun_marker in url:
        return "dependency:" + url.split(bun_marker, 1)[1].split("/node_modules/", 1)[0]
    package_match = re.search(r"/packages/([^/]+)", url)
    if package_match:
        return "product:" + package_match.group(1)
    return url


def ranked(counter: collections.Counter[str], top: int) -> Iterable[tuple[str, int]]:
    return counter.most_common(None if top == 0 else top)


def print_ranking(title: str, counter: collections.Counter[str], total: int, top: int) -> None:
    print(f"\n{title}")
    if not counter:
        print("  (none)")
        return
    for name, count in ranked(counter, top):
        percent = count / total * 100 if total else 0
        print(f"  {count:7d} {percent:6.2f}%  {name}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("profile", type=Path, help="Bun/V8 .cpuprofile JSON file")
    parser.add_argument("--top", type=int, default=20, help="rows per ranking; 0 prints all")
    parser.add_argument(
        "--max-delta-ms",
        type=float,
        help="exclude samples whose timeDelta exceeds this value; counts are unfiltered by default",
    )
    parser.add_argument(
        "--match",
        action="append",
        default=[],
        metavar="REGEX",
        help="print matching nodes and their ancestor paths (repeatable)",
    )
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    if args.top < 0:
        parser.error("--top cannot be negative")
    if args.max_delta_ms is not None and args.max_delta_ms <= 0:
        parser.error("--max-delta-ms must be positive")

    with args.profile.open(encoding="utf-8") as handle:
        profile = json.load(handle)
    nodes = {node["id"]: node for node in profile.get("nodes", [])}
    samples = profile.get("samples", [])
    deltas = profile.get("timeDeltas", [])
    if not nodes or not isinstance(samples, list):
        parser.error("profile has no nodes or samples")
    if args.max_delta_ms is not None and len(deltas) != len(samples):
        parser.error("cannot filter deltas: timeDeltas and samples have different lengths")

    selected: list[int] = []
    omitted = 0
    max_delta_us = args.max_delta_ms * 1000 if args.max_delta_ms is not None else None
    for index, sample_id in enumerate(samples):
        if max_delta_us is not None and deltas[index] > max_delta_us:
            omitted += 1
            continue
        if sample_id in nodes:
            selected.append(sample_id)

    parent: dict[int, int] = {}
    for node in nodes.values():
        for child in node.get("children", []):
            parent[child] = node["id"]

    leaf_functions: collections.Counter[str] = collections.Counter()
    leaf_buckets: collections.Counter[str] = collections.Counter()
    inclusive_product: collections.Counter[str] = collections.Counter()
    for sample_id in selected:
        leaf = nodes[sample_id]
        leaf_functions[frame_name(leaf)] += 1
        leaf_buckets[leaf_bucket(leaf)] += 1
        seen: set[int] = set()
        current: Optional[int] = sample_id
        while current is not None and current not in seen:
            seen.add(current)
            node = nodes[current]
            if leaf_bucket(node).startswith("product:"):
                inclusive_product[frame_name(node)] += 1
            current = parent.get(current)

    print(f"profile: {args.profile}")
    print(f"samples: {len(selected)} selected, {omitted} omitted, {len(samples)} total")
    print("metric: sample/hit count (not Bun Markdown self-time)")
    print_ranking("Leaf samples by dependency/product bucket", leaf_buckets, len(selected), args.top)
    print_ranking("Leaf functions", leaf_functions, len(selected), args.top)
    print_ranking("Inclusive product frames", inclusive_product, len(selected), args.top)

    for expression in args.match:
        try:
            pattern = re.compile(expression)
        except re.error as error:
            parser.error(f"invalid --match regex {expression!r}: {error}")
        print(f"\nAncestor paths matching {expression!r}")
        matches = 0
        for node_id, node in nodes.items():
            if not pattern.search(frame_name(node)):
                continue
            matches += 1
            path: list[str] = []
            seen = set()
            current: Optional[int] = node_id
            while current is not None and current not in seen:
                seen.add(current)
                path.append(frame_name(nodes[current]))
                current = parent.get(current)
            print("  " + " <- ".join(path))
        if matches == 0:
            print("  (none)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
