#!/usr/bin/env python3
"""Cross-reference linter for documentation files.

Walks every Markdown file under ``docs/`` and ``README.md``, extracts every
string that looks like a repo-root-relative file path, and verifies that the
referenced path exists.

A "repo-root-relative file path" is any path-shaped token that begins with one
of the known top-level directories (``docs/``, ``backend/``, ``frontend/``,
``scripts/``, ``tests/``) and ends with a recognised extension.  Template paths
containing ``{`` are skipped (they are S3 key patterns, not file references).

Exit code is 0 if all references resolve, 1 if any are broken.

Usage::

    python scripts/lint_doc_crossrefs.py

Run from the repository root.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

REPO_ROOT = Path(__file__).parent.parent

# Markdown files to scan
SCAN_DIRS = ["docs"]
SCAN_EXTRA_FILES = ["README.md", "CLAUDE.md", "CONTRIBUTING.md"]

# Subdirectories of SCAN_DIRS to skip.  ``docs/reports`` contains external
# review documents that deliberately reference non-existent or planned files
# (they describe problems to fix); scanning them produces only false positives.
SCAN_EXCLUDE_PREFIXES = ("docs/reports", "docs\\reports")

# Only flag paths that start with one of these top-level directories.
# This prevents false positives from S3 key patterns, short paths relative to
# a subdirectory, or example paths that are not repo-rooted.
ROOTED_PREFIXES = ("docs/", "backend/", "frontend/", "scripts/", "tests/")

# File extensions worth checking.
CHECKABLE_EXTENSIONS = {
    ".md", ".py", ".ts", ".tsx", ".js", ".yml", ".yaml",
    ".json", ".toml", ".txt", ".sql",
}

# Regex: extract the *content* of backtick spans and Markdown link targets.
# We look inside these delimiters because bare paths are too noisy to extract
# reliably from prose.
_CANDIDATE_RE = re.compile(
    r"""
    `([^`\n]+)`          # backtick-quoted token
  | \]\(([^)]+)\)        # Markdown link target  ]( ... )
    """,
    re.VERBOSE,
)


def _candidates_in(text: str) -> list[str]:
    """Return every raw candidate string extracted from *text*."""
    results = []
    for m in _CANDIDATE_RE.finditer(text):
        raw = (m.group(1) or m.group(2) or "").strip()
        if not raw:
            continue
        # Strip anchor suffix: "docs/foo.md#section" → "docs/foo.md"
        raw = raw.split("#")[0].rstrip("/")
        # Skip URLs and pure anchors.
        if raw.startswith(("http://", "https://", "ftp://", "#")):
            continue
        results.append(raw)
    return results


def _checkable(path_str: str) -> str | None:
    """Return *path_str* if it is a checkable repo-root-relative path, else None."""
    # Must start with a known top-level directory.
    if not any(path_str.startswith(p) for p in ROOTED_PREFIXES):
        return None
    # Template paths (S3 key patterns, example paths with placeholders).
    if "{" in path_str:
        return None
    # Must have a recognised extension.
    if Path(path_str).suffix not in CHECKABLE_EXTENSIONS:
        return None
    return path_str


def main() -> int:
    errors: list[str] = []

    files_to_scan: list[Path] = []
    for d in SCAN_DIRS:
        dir_path = REPO_ROOT / d
        if dir_path.is_dir():
            for md in dir_path.rglob("*.md"):
                rel = str(md.relative_to(REPO_ROOT))
                if not any(rel.startswith(ex) for ex in SCAN_EXCLUDE_PREFIXES):
                    files_to_scan.append(md)
    for f in SCAN_EXTRA_FILES:
        p = REPO_ROOT / f
        if p.exists():
            files_to_scan.append(p)

    for doc_file in sorted(files_to_scan):
        text = doc_file.read_text(encoding="utf-8")
        seen: set[str] = set()
        for raw in _candidates_in(text):
            path_str = _checkable(raw)
            if path_str is None or path_str in seen:
                continue
            seen.add(path_str)
            target = REPO_ROOT / path_str
            if not target.exists():
                rel_doc = doc_file.relative_to(REPO_ROOT)
                errors.append(f"  {rel_doc}: broken reference -> {path_str}")

    if errors:
        print(f"lint_doc_crossrefs: {len(errors)} broken reference(s) found:\n")
        for e in errors:
            print(e)
        return 1

    scanned = len(files_to_scan)
    print(f"lint_doc_crossrefs: OK ({scanned} files scanned, no broken references)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
