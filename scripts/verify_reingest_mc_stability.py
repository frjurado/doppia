"""Verify machine-coordinate (mc) stability across a corpus re-ingestion.

Component 9, Step 9 (``docs/roadmap/component-9-corpus-population-and-hardening.md``)
re-ingests the existing movements through the updated normalizer.  Fragment
``mc_start``/``mc_end`` are document-order measure indices (ADR-015): if a
re-ingestion silently adds, removes, or reorders ``<measure>`` elements, every
fragment after the change point points at the wrong music.  This script makes
that risk observable instead of silent.

It works in two phases against the **normalized** MEI in object storage — the
artefact fragments are tagged against:

1. ``snapshot`` (run **before** re-ingestion) fingerprints every movement's
   measure sequence and writes the result to a JSON file.
2. ``verify`` (run **after** re-ingestion) re-fingerprints and diffs against the
   snapshot, reporting each movement as ``STABLE`` or ``DRIFTED`` and exiting
   non-zero if anything drifted.

The per-measure fingerprint hashes only pitch and duration (``pname``/``oct``/
``dur``/``dots``/``grace`` of notes, ``dur``/``dots`` of rests, ``mRest``), keyed
by staff.  It is therefore **invariant** under exactly the normalizer changes
Steps 6–8 introduce — measure-start clef recovery (Step 6), cross-barline tie
completion (Step 7), and accidental normalization (ADR-021/022) — and sensitive
only to a measure being added, removed, or reordered.  A ``DRIFTED`` result thus
means real mc movement and real fragment exposure, never a benign re-render.

Usage (local; MinIO defaults)::

    python scripts/verify_reingest_mc_stability.py snapshot
    # ... re-ingest the corpus ...
    python scripts/verify_reingest_mc_stability.py verify

Usage (staging — set the R2_* env vars first, as for
``scripts/backfill_mei_normalization.py``).

Environment variables (all optional; fall back to local MinIO defaults):

    R2_ENDPOINT_URL       S3-compatible endpoint (default: http://localhost:9000)
    R2_ACCESS_KEY_ID      Access key (default: minioadmin)
    R2_SECRET_ACCESS_KEY  Secret key (default: minioadmin)
    R2_BUCKET_NAME        Bucket name (default: doppia-local)
    NORM_PREFIX           Normalized-key prefix to scan (default: mozart/)
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path

import boto3
import lxml.etree

_MEI_NS = "http://www.music-encoding.org/ns/mei"

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

ENDPOINT = os.getenv("R2_ENDPOINT_URL", "http://localhost:9000")
KEY_ID = os.getenv("R2_ACCESS_KEY_ID", "minioadmin")
SECRET = os.getenv("R2_SECRET_ACCESS_KEY", "minioadmin")
BUCKET = os.getenv("R2_BUCKET_NAME", "doppia-local")
NORM_PREFIX = os.getenv("NORM_PREFIX", "mozart/")

_DEFAULT_SNAPSHOT = (
    Path(__file__).parent.parent
    / "docs"
    / "reports"
    / "component-9-reports"
    / "mc-stability-snapshot.json"
)


# ---------------------------------------------------------------------------
# Pure fingerprinting (unit-tested in tests/unit/test_verify_mc_stability.py)
# ---------------------------------------------------------------------------


def measure_content_fingerprints(mei_bytes: bytes) -> list[str]:
    """Return one content hash per ``<measure>`` in document (mc) order.

    The hash captures pitch and duration only, keyed by staff, so it is stable
    under the Step 6–8 normalizer changes (clef recovery, tie completion,
    accidental normalization) and changes only when a measure's musical content,
    count, or order changes.  Index ``i`` of the returned list is the fingerprint
    of the measure at machine coordinate ``mc = i + 1``.

    Args:
        mei_bytes: Raw bytes of a normalized MEI document.

    Returns:
        Ordered list of hex SHA-1 digests, one per ``<measure>`` element.
    """
    root = lxml.etree.fromstring(mei_bytes)
    fingerprints: list[str] = []
    for measure in root.iter(f"{{{_MEI_NS}}}measure"):
        tokens: list[str] = []
        for el in measure.iter():
            tag = el.tag
            if not isinstance(tag, str):
                continue
            local = tag.rsplit("}", 1)[-1]
            if local == "staff":
                tokens.append(f"s{el.get('n', '')}")
            elif local == "note":
                tokens.append(
                    "n:"
                    f"{el.get('pname', '')}{el.get('oct', '')}:"
                    f"{el.get('dur', '')}:{el.get('dots', '0')}:"
                    f"{el.get('grace', '')}"
                )
            elif local == "rest":
                tokens.append(f"r:{el.get('dur', '')}:{el.get('dots', '0')}")
            elif local == "mRest":
                tokens.append("R")
        digest = hashlib.sha1("|".join(tokens).encode("utf-8")).hexdigest()
        fingerprints.append(digest)
    return fingerprints


# ---------------------------------------------------------------------------
# Storage access
# ---------------------------------------------------------------------------


def _s3_client():  # noqa: ANN202 - boto3 client has no public type
    """Return a boto3 S3 client configured from the R2_* environment."""
    return boto3.client(
        "s3",
        endpoint_url=ENDPOINT,
        aws_access_key_id=KEY_ID,
        aws_secret_access_key=SECRET,
    )


def _list_normalized_keys(s3) -> list[str]:  # noqa: ANN001
    """List normalized MEI keys under ``NORM_PREFIX`` (excluding ``originals/``).

    Args:
        s3: An S3 client.

    Returns:
        Sorted list of object keys ending in ``.mei``.
    """
    paginator = s3.get_paginator("list_objects_v2")
    keys: list[str] = []
    for page in paginator.paginate(Bucket=BUCKET, Prefix=NORM_PREFIX):
        for obj in page.get("Contents", []):
            key = obj["Key"]
            # NORM_PREFIX="mozart/" never matches "originals/mozart/", but guard
            # anyway in case a caller widens the prefix.
            if key.endswith(".mei") and not key.startswith("originals/"):
                keys.append(key)
    return sorted(keys)


def _fingerprint_corpus(s3) -> dict[str, list[str]]:  # noqa: ANN001
    """Fingerprint every normalized movement in storage.

    Args:
        s3: An S3 client.

    Returns:
        Mapping of object key → ordered per-measure fingerprint list.
    """
    result: dict[str, list[str]] = {}
    for key in _list_normalized_keys(s3):
        body = s3.get_object(Bucket=BUCKET, Key=key)["Body"].read()
        result[key] = measure_content_fingerprints(body)
    return result


# ---------------------------------------------------------------------------
# Subcommands
# ---------------------------------------------------------------------------


def cmd_snapshot(args: argparse.Namespace) -> int:
    """Fingerprint the corpus as it stands now and write a snapshot JSON.

    Args:
        args: Parsed CLI namespace with ``output``.

    Returns:
        Process exit code (0 on success).
    """
    s3 = _s3_client()
    fingerprints = _fingerprint_corpus(s3)
    if not fingerprints:
        print(f"No normalized MEI found under s3://{BUCKET}/{NORM_PREFIX}")
        return 1

    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "bucket": BUCKET,
        "prefix": NORM_PREFIX,
        "movements": {
            k: {"measures": len(v), "fingerprints": v} for k, v in fingerprints.items()
        },
    }
    out.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"Snapshot of {len(fingerprints)} movement(s) written to {out}")
    for key, fps in fingerprints.items():
        print(f"  {key}: {len(fps)} measures")
    return 0


def cmd_verify(args: argparse.Namespace) -> int:
    """Re-fingerprint the corpus and diff against the snapshot.

    Args:
        args: Parsed CLI namespace with ``snapshot``.

    Returns:
        Process exit code: 0 if every movement is stable, 1 otherwise.
    """
    snap_path = Path(args.snapshot)
    if not snap_path.exists():
        print(f"Snapshot not found: {snap_path} — run `snapshot` before re-ingesting.")
        return 1
    snapshot = json.loads(snap_path.read_text(encoding="utf-8"))["movements"]

    s3 = _s3_client()
    current = _fingerprint_corpus(s3)

    drifted = False
    print(f"Verifying {len(current)} movement(s) against {snap_path.name}\n")
    for key in sorted(set(snapshot) | set(current)):
        before = snapshot.get(key, {}).get("fingerprints")
        after = current.get(key)
        if before is None:
            print(f"  ADDED    {key} (not in snapshot)")
            drifted = True
            continue
        if after is None:
            print(f"  MISSING  {key} (in snapshot, absent now)")
            drifted = True
            continue
        if before == after:
            print(f"  STABLE   {key} ({len(after)} measures)")
            continue

        drifted = True
        if len(before) != len(after):
            print(
                f"  DRIFTED  {key}: measure count {len(before)} -> {len(after)} "
                "(every fragment in this movement must be re-validated)"
            )
        else:
            diverged = [i + 1 for i, (b, a) in enumerate(zip(before, after)) if b != a]
            preview = ", ".join(str(mc) for mc in diverged[:10])
            more = "" if len(diverged) <= 10 else f" (+{len(diverged) - 10} more)"
            print(
                f"  DRIFTED  {key}: content changed at mc {preview}{more} "
                "(fragments overlapping these measures must be re-validated)"
            )

    print()
    if drifted:
        print(
            "RESULT: DRIFT DETECTED. Do not start the tagging campaign. "
            "Identify exposed fragments per movement, e.g.:\n"
            "  SELECT f.id, f.mc_start, f.mc_end, f.status\n"
            "  FROM fragment f JOIN movement m ON m.id = f.movement_id\n"
            "  JOIN work w ON w.id = m.work_id\n"
            "  WHERE w.slug = '<work>' AND m.slug = '<movement>';\n"
            "Migrate or flag each per Step 9, and document the incident."
        )
        return 1
    print("RESULT: all movements mc-stable. Fragment coordinates are unaffected.")
    return 0


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def main() -> None:
    """CLI entry point."""
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)

    p_snap = sub.add_parser(
        "snapshot", help="Fingerprint the corpus before re-ingestion."
    )
    p_snap.add_argument(
        "--output", default=str(_DEFAULT_SNAPSHOT), help="Snapshot JSON path."
    )
    p_snap.set_defaults(func=cmd_snapshot)

    p_ver = sub.add_parser(
        "verify", help="Diff the corpus against the snapshot after re-ingestion."
    )
    p_ver.add_argument(
        "--snapshot", default=str(_DEFAULT_SNAPSHOT), help="Snapshot JSON path."
    )
    p_ver.set_defaults(func=cmd_verify)

    args = parser.parse_args()
    sys.exit(args.func(args))


if __name__ == "__main__":
    main()
