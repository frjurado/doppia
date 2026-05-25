"""Backfill MEI normalization for all stored corpus movements.

Re-normalizes every movement under ``originals/mozart/`` from its original
source, then overwrites the corresponding normalized key.  Safe to re-run:
the normalizer is idempotent.

Usage (local)::

    python scripts/backfill_mei_normalization.py

Usage (staging — set env vars first)::

    R2_ENDPOINT_URL=https://... \\
    R2_ACCESS_KEY_ID=... \\
    R2_SECRET_ACCESS_KEY=... \\
    R2_BUCKET_NAME=... \\
    python scripts/backfill_mei_normalization.py

Environment variables (all optional; fall back to local MinIO defaults):

    R2_ENDPOINT_URL       S3-compatible endpoint (default: http://localhost:9000)
    R2_ACCESS_KEY_ID      Access key (default: minioadmin)
    R2_SECRET_ACCESS_KEY  Secret key (default: minioadmin)
    R2_BUCKET_NAME        Bucket name (default: doppia-local)
    CORPUS_PREFIX         Originals prefix to scan (default: originals/mozart/)
    DRY_RUN               Set to "1" to report without uploading
"""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

import boto3

# Ensure backend package is importable when run from project root.
sys.path.insert(0, str(Path(__file__).parent.parent))

from services.mei_normalizer import normalize_mei

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

ENDPOINT = os.getenv("R2_ENDPOINT_URL", "http://localhost:9000")
KEY_ID = os.getenv("R2_ACCESS_KEY_ID", "minioadmin")
SECRET = os.getenv("R2_SECRET_ACCESS_KEY", "minioadmin")
BUCKET = os.getenv("R2_BUCKET_NAME", "doppia-local")
CORPUS_PREFIX = os.getenv("CORPUS_PREFIX", "originals/mozart/")
DRY_RUN = os.getenv("DRY_RUN", "0") == "1"


def _normalized_key(original_key: str) -> str:
    """Strip the leading ``originals/`` prefix to get the normalized key.

    Args:
        original_key: Object key under the ``originals/`` prefix.

    Returns:
        Corresponding normalized key (no ``originals/`` prefix).
    """
    return original_key.removeprefix("originals/")


def main() -> None:
    """Run the backfill."""
    s3 = boto3.client(
        "s3",
        endpoint_url=ENDPOINT,
        aws_access_key_id=KEY_ID,
        aws_secret_access_key=SECRET,
    )

    # Collect all original keys under the corpus prefix.
    paginator = s3.get_paginator("list_objects_v2")
    original_keys: list[str] = []
    for page in paginator.paginate(Bucket=BUCKET, Prefix=CORPUS_PREFIX):
        for obj in page.get("Contents", []):
            key = obj["Key"]
            if key.endswith(".mei"):
                original_keys.append(key)

    if not original_keys:
        print(f"No .mei files found under s3://{BUCKET}/{CORPUS_PREFIX}")
        sys.exit(0)

    print(f"Found {len(original_keys)} movement(s) under {CORPUS_PREFIX}")
    if DRY_RUN:
        print("DRY_RUN=1 — no uploads will be performed\n")

    total_stripped = 0
    total_warnings = 0

    with tempfile.TemporaryDirectory() as tmp:
        for original_key in sorted(original_keys):
            norm_key = _normalized_key(original_key)
            print(f"\n--- {original_key}")

            src = Path(tmp) / "src.mei"
            dst = Path(tmp) / "dst.mei"

            # Download original.
            obj = s3.get_object(Bucket=BUCKET, Key=original_key)
            src.write_bytes(obj["Body"].read())

            # Normalize.
            report = normalize_mei(str(src), str(dst))

            stripped = [c for c in report.changes_applied if "spurious" in c.lower()]
            total_stripped += len(stripped)
            total_warnings += len(report.warnings)

            print(f"    spurious accidentals stripped : {len(stripped)}")
            print(
                f"    other changes applied         : {len(report.changes_applied) - len(stripped)}"
            )
            if report.warnings:
                print(f"    warnings                      : {len(report.warnings)}")
                for w in report.warnings:
                    print(f"      ! {w}")

            if DRY_RUN:
                print(f"    [DRY RUN] would upload to {norm_key}")
            else:
                norm_bytes = dst.read_bytes()
                s3.put_object(Bucket=BUCKET, Key=norm_key, Body=norm_bytes)
                print(f"    uploaded -> {norm_key} ({len(norm_bytes):,} bytes)")

    print(f"\n{'=' * 60}")
    print(f"Movements processed : {len(original_keys)}")
    print(f"Spurious accidentals stripped (total) : {total_stripped}")
    if total_warnings:
        print(f"Warnings (total)    : {total_warnings}")
    if DRY_RUN:
        print("No files uploaded (DRY_RUN=1).")
    else:
        print("All normalized MEIs re-uploaded.")


if __name__ == "__main__":
    main()
