"""Smoke tests for scripts/prepare_dcml_corpus.py.

All external process calls (mscore, verovio, git) are mocked so that no
binaries need to be installed in CI.  The tests exercise:

- ABC deny-list enforcement.
- Subprocess argument correctness for mscore and verovio.
- ZIP assembly structure (metadata.yaml, MEI paths, harmonies paths).
- Pydantic round-trip on the generated metadata.yaml.
- MEI validation abort on hard errors.
- Full pipeline smoke run against backend/tests/fixtures/dcml-subset/.
"""

from __future__ import annotations

import tomllib
import zipfile
from pathlib import Path
from subprocess import CalledProcessError
from unittest.mock import MagicMock, patch

# prepare_dcml_corpus is importable because pyproject.toml adds "scripts/" to
# pytest's pythonpath.  The module-level sys.path.insert in the script adds
# backend/ automatically, so all backend imports resolve correctly.
import prepare_dcml_corpus as pdc
import pytest
import yaml
from models.ingestion import IngestMetadata

# ---------------------------------------------------------------------------
# Shared fixtures
# ---------------------------------------------------------------------------

_SCRIPTS_DIR = Path(__file__).parent.parent.parent.parent / "scripts"
_FIXTURES = Path(__file__).parent.parent / "fixtures"
_DCML_SUBSET = _FIXTURES / "dcml-subset"
_ALREADY_CLEAN_MEI = _FIXTURES / "mei" / "normalizer" / "already_clean.mei"
_TEST_CONFIG = _SCRIPTS_DIR / "dcml_corpora" / "dcml-subset-test.toml"


def _load_test_config() -> dict:
    with open(_TEST_CONFIG, "rb") as fh:
        return tomllib.load(fh)


@pytest.fixture()
def valid_mei_bytes() -> bytes:
    """Return the already_clean.mei bytes — a known-good MEI file."""
    return _ALREADY_CLEAN_MEI.read_bytes()


@pytest.fixture()
def test_config() -> dict:
    """Return the parsed dcml-subset-test.toml config."""
    return _load_test_config()


@pytest.fixture()
def discovered_entries(test_config: dict) -> list[pdc.MovementEntry]:
    """Return entries discovered from the dcml-subset fixture directory."""
    return pdc.discover_movements(_DCML_SUBSET, test_config)


# ---------------------------------------------------------------------------
# TestAbcDenyList
# ---------------------------------------------------------------------------


class TestAbcDenyList:
    """check_abc_deny_list refuses corpora on the deny-list."""

    def _config(self, source_repo: str) -> dict:
        return {"corpus": {"source_repository": source_repo}}

    def test_abc_repo_raises(self) -> None:
        with pytest.raises(SystemExit) as exc:
            pdc.check_abc_deny_list(self._config("DCMLab/ABC"))
        assert exc.value.code == 1

    def test_abc_url_raises(self) -> None:
        with pytest.raises(SystemExit) as exc:
            pdc.check_abc_deny_list(self._config("abc/beethoven-quartets"))
        assert exc.value.code == 1

    def test_beethoven_quartets_raises(self) -> None:
        with pytest.raises(SystemExit) as exc:
            pdc.check_abc_deny_list(self._config("abc/beethoven_quartets"))
        assert exc.value.code == 1

    def test_case_insensitive(self) -> None:
        with pytest.raises(SystemExit):
            pdc.check_abc_deny_list(self._config("DCMLAB/abc"))

    def test_mozart_passes(self) -> None:
        # Must not raise
        pdc.check_abc_deny_list(self._config("DCMLab/mozart_piano_sonatas"))

    def test_none_source_repo_passes(self) -> None:
        pdc.check_abc_deny_list({"corpus": {"source_repository": None}})

    def test_missing_corpus_key_passes(self) -> None:
        pdc.check_abc_deny_list({})


# ---------------------------------------------------------------------------
# TestConvertMscxToMxl
# ---------------------------------------------------------------------------


class TestConvertMscxToMxl:
    """convert_mscx_to_mxl calls mscore with the correct arguments."""

    def test_calls_mscore_with_correct_args(self, tmp_path: Path) -> None:
        mscx = tmp_path / "K331-1.mscx"
        mscx.touch()
        with patch("prepare_dcml_corpus.subprocess.run") as mock_run:
            pdc.convert_mscx_to_mxl(mscx, tmp_path)
        mock_run.assert_called_once()
        call_args = mock_run.call_args[0][0]
        assert call_args[0] == "mscore"
        assert call_args[1] == "--export-to"
        assert call_args[2].endswith("K331-1.mxl")
        assert call_args[3] == str(mscx)

    def test_returns_mxl_path(self, tmp_path: Path) -> None:
        mscx = tmp_path / "K331-1.mscx"
        mscx.touch()
        with patch("prepare_dcml_corpus.subprocess.run"):
            result = pdc.convert_mscx_to_mxl(mscx, tmp_path)
        assert result == tmp_path / "K331-1.mxl"

    def test_propagates_called_process_error(self, tmp_path: Path) -> None:
        mscx = tmp_path / "K331-1.mscx"
        mscx.touch()
        with patch(
            "prepare_dcml_corpus.subprocess.run",
            side_effect=CalledProcessError(1, "mscore"),
        ):
            with pytest.raises(CalledProcessError):
                pdc.convert_mscx_to_mxl(mscx, tmp_path)


# ---------------------------------------------------------------------------
# TestConvertMxlToMei
# ---------------------------------------------------------------------------


class TestConvertMxlToMei:
    """convert_mxl_to_mei calls verovio and returns the emitted MEI bytes."""

    def _make_mei_side_effect(
        self,
        mxl_path: Path,
        tmpdir: Path,
        mei_content: bytes,
    ):
        """Return a side_effect that writes mei_content to the expected output path."""

        def _side_effect(cmd: list, **kwargs):
            out_mei = tmpdir / (mxl_path.stem + ".mei")
            out_mei.write_bytes(mei_content)

        return _side_effect

    def test_calls_verovio_with_correct_args(
        self, tmp_path: Path, valid_mei_bytes: bytes
    ) -> None:
        mxl = tmp_path / "K331-1.mxl"
        mxl.touch()
        side_effect = self._make_mei_side_effect(mxl, tmp_path, valid_mei_bytes)
        with patch(
            "prepare_dcml_corpus.subprocess.run", side_effect=side_effect
        ) as mock_run:
            pdc.convert_mxl_to_mei(mxl, tmp_path)
        call_args = mock_run.call_args[0][0]
        assert call_args[0] == "verovio"
        assert call_args[1] == "--to"
        assert call_args[2] == "mei"
        assert call_args[3] == str(mxl)
        assert call_args[4] == "-o"
        assert call_args[5].endswith("K331-1.mei")

    def test_returns_mei_bytes(self, tmp_path: Path, valid_mei_bytes: bytes) -> None:
        mxl = tmp_path / "K331-1.mxl"
        mxl.touch()
        side_effect = self._make_mei_side_effect(mxl, tmp_path, valid_mei_bytes)
        with patch("prepare_dcml_corpus.subprocess.run", side_effect=side_effect):
            result = pdc.convert_mxl_to_mei(mxl, tmp_path)
        assert result == valid_mei_bytes

    def test_propagates_called_process_error(self, tmp_path: Path) -> None:
        mxl = tmp_path / "K331-1.mxl"
        mxl.touch()
        with patch(
            "prepare_dcml_corpus.subprocess.run",
            side_effect=CalledProcessError(1, "verovio"),
        ):
            with pytest.raises(CalledProcessError):
                pdc.convert_mxl_to_mei(mxl, tmp_path)


# ---------------------------------------------------------------------------
# TestFindHarmoniesTsv
# ---------------------------------------------------------------------------


class TestFindHarmoniesTsv:
    """find_harmonies_tsv derives the TSV path from the .mscx stem."""

    def test_returns_path_when_exists(self) -> None:
        mscx = _DCML_SUBSET / "MS3" / "K331-1.mscx"
        result = pdc.find_harmonies_tsv(_DCML_SUBSET, mscx)
        assert result == _DCML_SUBSET / "harmonies" / "K331-1.tsv"

    def test_returns_none_when_missing(self, tmp_path: Path) -> None:
        mscx = tmp_path / "MS3" / "NoHarmonies.mscx"
        result = pdc.find_harmonies_tsv(tmp_path, mscx)
        assert result is None


# ---------------------------------------------------------------------------
# TestBuildIngestMetadata
# ---------------------------------------------------------------------------


class TestBuildIngestMetadata:
    """build_ingest_metadata assembles a valid IngestMetadata from config + accepted."""

    def _make_accepted(
        self,
        entries: list[pdc.MovementEntry],
        mei_bytes: bytes,
        repo_path: Path,
    ) -> list[pdc.AcceptedMovement]:
        return [
            pdc.AcceptedMovement(
                entry=e,
                mei_bytes=mei_bytes,
                harmonies_path=pdc.find_harmonies_tsv(repo_path, e.mscx_path),
            )
            for e in entries
        ]

    def test_returns_valid_ingest_metadata(
        self,
        test_config: dict,
        discovered_entries: list[pdc.MovementEntry],
        valid_mei_bytes: bytes,
    ) -> None:
        accepted = self._make_accepted(
            discovered_entries, valid_mei_bytes, _DCML_SUBSET
        )
        metadata = pdc.build_ingest_metadata(test_config, "abc1234", accepted)
        assert isinstance(metadata, IngestMetadata)

    def test_source_commit_is_set(
        self,
        test_config: dict,
        discovered_entries: list[pdc.MovementEntry],
        valid_mei_bytes: bytes,
    ) -> None:
        accepted = self._make_accepted(
            discovered_entries, valid_mei_bytes, _DCML_SUBSET
        )
        metadata = pdc.build_ingest_metadata(test_config, "deadbeef", accepted)
        assert metadata.corpus.source_commit == "deadbeef"

    def test_composer_fields(
        self,
        test_config: dict,
        discovered_entries: list[pdc.MovementEntry],
        valid_mei_bytes: bytes,
    ) -> None:
        accepted = self._make_accepted(
            discovered_entries, valid_mei_bytes, _DCML_SUBSET
        )
        metadata = pdc.build_ingest_metadata(test_config, "abc1234", accepted)
        assert metadata.composer.slug == "mozart"
        assert metadata.composer.birth_year == 1756

    def test_movement_mei_filename_follows_convention(
        self,
        test_config: dict,
        discovered_entries: list[pdc.MovementEntry],
        valid_mei_bytes: bytes,
    ) -> None:
        accepted = self._make_accepted(
            discovered_entries, valid_mei_bytes, _DCML_SUBSET
        )
        metadata = pdc.build_ingest_metadata(test_config, "abc1234", accepted)
        flat = metadata.flat_movements()
        assert flat[0][1].mei_filename == "mei/k331/movement-1.mei"
        assert flat[1][1].mei_filename == "mei/k331/movement-2.mei"

    def test_movement_harmonies_filename_follows_convention(
        self,
        test_config: dict,
        discovered_entries: list[pdc.MovementEntry],
        valid_mei_bytes: bytes,
    ) -> None:
        accepted = self._make_accepted(
            discovered_entries, valid_mei_bytes, _DCML_SUBSET
        )
        metadata = pdc.build_ingest_metadata(test_config, "abc1234", accepted)
        flat = metadata.flat_movements()
        assert flat[0][1].harmonies_filename == "harmonies/k331/movement-1.tsv"
        assert flat[1][1].harmonies_filename == "harmonies/k331/movement-2.tsv"


# ---------------------------------------------------------------------------
# TestAssembleZip
# ---------------------------------------------------------------------------


class TestAssembleZip:
    """assemble_zip writes a ZIP with the correct internal structure."""

    def _make_metadata_and_accepted(
        self,
        test_config: dict,
        discovered_entries: list[pdc.MovementEntry],
        valid_mei_bytes: bytes,
    ) -> tuple[IngestMetadata, list[pdc.AcceptedMovement]]:
        accepted = [
            pdc.AcceptedMovement(
                entry=e,
                mei_bytes=valid_mei_bytes,
                harmonies_path=pdc.find_harmonies_tsv(_DCML_SUBSET, e.mscx_path),
            )
            for e in discovered_entries
        ]
        metadata = pdc.build_ingest_metadata(test_config, "abc1234", accepted)
        return metadata, accepted

    def test_zip_contains_metadata_yaml(
        self,
        tmp_path: Path,
        test_config: dict,
        discovered_entries: list[pdc.MovementEntry],
        valid_mei_bytes: bytes,
    ) -> None:
        metadata, accepted = self._make_metadata_and_accepted(
            test_config, discovered_entries, valid_mei_bytes
        )
        out = tmp_path / "corpus.zip"
        pdc.assemble_zip(accepted, metadata, out)
        with zipfile.ZipFile(out) as zf:
            assert "metadata.yaml" in zf.namelist()

    def test_metadata_yaml_roundtrips_via_pydantic(
        self,
        tmp_path: Path,
        test_config: dict,
        discovered_entries: list[pdc.MovementEntry],
        valid_mei_bytes: bytes,
    ) -> None:
        metadata, accepted = self._make_metadata_and_accepted(
            test_config, discovered_entries, valid_mei_bytes
        )
        out = tmp_path / "corpus.zip"
        pdc.assemble_zip(accepted, metadata, out)
        with zipfile.ZipFile(out) as zf:
            raw = yaml.safe_load(zf.read("metadata.yaml"))
        reloaded = IngestMetadata.model_validate(raw)
        assert reloaded.composer.slug == "mozart"
        assert reloaded.corpus.slug == "piano-sonatas"

    def test_zip_mei_paths_follow_convention(
        self,
        tmp_path: Path,
        test_config: dict,
        discovered_entries: list[pdc.MovementEntry],
        valid_mei_bytes: bytes,
    ) -> None:
        metadata, accepted = self._make_metadata_and_accepted(
            test_config, discovered_entries, valid_mei_bytes
        )
        out = tmp_path / "corpus.zip"
        pdc.assemble_zip(accepted, metadata, out)
        with zipfile.ZipFile(out) as zf:
            names = zf.namelist()
        assert "mei/k331/movement-1.mei" in names
        assert "mei/k331/movement-2.mei" in names

    def test_zip_harmonies_included_when_present(
        self,
        tmp_path: Path,
        test_config: dict,
        discovered_entries: list[pdc.MovementEntry],
        valid_mei_bytes: bytes,
    ) -> None:
        metadata, accepted = self._make_metadata_and_accepted(
            test_config, discovered_entries, valid_mei_bytes
        )
        out = tmp_path / "corpus.zip"
        pdc.assemble_zip(accepted, metadata, out)
        with zipfile.ZipFile(out) as zf:
            names = zf.namelist()
        assert "harmonies/k331/movement-1.tsv" in names
        assert "harmonies/k331/movement-2.tsv" in names

    def test_zip_harmonies_omitted_when_missing(
        self,
        tmp_path: Path,
        test_config: dict,
        discovered_entries: list[pdc.MovementEntry],
        valid_mei_bytes: bytes,
    ) -> None:
        # Force harmonies_path to None on all entries.
        accepted = [
            pdc.AcceptedMovement(
                entry=e,
                mei_bytes=valid_mei_bytes,
                harmonies_path=None,
            )
            for e in discovered_entries
        ]
        # Build metadata without harmonies — but this would fail DCML validation
        # (DCML requires harmonies_filename). Use analysis_source="none" via a
        # patched config to avoid the Pydantic constraint.
        none_config = {
            **test_config,
            "corpus": {
                **test_config["corpus"],
                "analysis_source": "none",
                "licence": "CC0-1.0",
            },
        }
        metadata = pdc.build_ingest_metadata(none_config, "abc1234", accepted)
        out = tmp_path / "corpus.zip"
        pdc.assemble_zip(accepted, metadata, out)
        with zipfile.ZipFile(out) as zf:
            names = zf.namelist()
        assert not any(n.startswith("harmonies/") for n in names)


# ---------------------------------------------------------------------------
# TestValidationAbort
# ---------------------------------------------------------------------------


class TestValidationAbort:
    """When validate_mei returns is_valid=False the pipeline exits with code 1."""

    def test_invalid_mei_causes_sys_exit(
        self,
        test_config: dict,
        discovered_entries: list[pdc.MovementEntry],
    ) -> None:
        bad_mei = b"this is not xml"

        with (
            patch.object(pdc, "convert_mscx_to_mxl", return_value=Path("/tmp/x.mxl")),
            patch.object(pdc, "convert_mxl_to_mei", return_value=bad_mei),
        ):
            # validate_mei runs for real: bad_mei is not valid XML → is_valid=False
            with pytest.raises(SystemExit) as exc:
                for entry in discovered_entries:
                    import tempfile

                    with tempfile.TemporaryDirectory() as td:
                        tmpdir = Path(td)
                        mxl_path = pdc.convert_mscx_to_mxl(entry.mscx_path, tmpdir)
                        mei_bytes = pdc.convert_mxl_to_mei(mxl_path, tmpdir)
                        from services.mei_validator import validate_mei

                        report = validate_mei(mei_bytes)
                        if not report.is_valid:
                            import sys

                            sys.exit(1)
        assert exc.value.code == 1


# ---------------------------------------------------------------------------
# TestDiscoverMovements
# ---------------------------------------------------------------------------


class TestDiscoverMovements:
    """discover_movements reads entries from the TOML config and verifies .mscx existence."""

    def test_returns_entries_for_all_movements(
        self, test_config: dict, discovered_entries: list[pdc.MovementEntry]
    ) -> None:
        assert len(discovered_entries) == 2

    def test_entry_slugs(self, discovered_entries: list[pdc.MovementEntry]) -> None:
        assert discovered_entries[0].work_slug == "k331"
        assert discovered_entries[0].movement_slug == "movement-1"
        assert discovered_entries[1].movement_slug == "movement-2"

    def test_mscx_paths_exist(
        self, discovered_entries: list[pdc.MovementEntry]
    ) -> None:
        for entry in discovered_entries:
            assert entry.mscx_path.exists()

    def test_missing_mscx_causes_sys_exit(self, test_config: dict) -> None:
        bad_config = {
            **test_config,
            "works": [
                {
                    "slug": "k999",
                    "title": "Non-existent",
                    "movements": [
                        {
                            "slug": "movement-1",
                            "movement_number": 1,
                            "mscx_filename": "K999-1.mscx",
                        }
                    ],
                }
            ],
        }
        with pytest.raises(SystemExit) as exc:
            pdc.discover_movements(_DCML_SUBSET, bad_config)
        assert exc.value.code == 1


# ---------------------------------------------------------------------------
# TestFullSmokePipeline
# ---------------------------------------------------------------------------


class TestFullSmokePipeline:
    """End-to-end smoke run: patches subprocess calls, produces a real ZIP."""

    def test_smoke_pipeline_produces_valid_zip(
        self,
        tmp_path: Path,
        test_config: dict,
        discovered_entries: list[pdc.MovementEntry],
        valid_mei_bytes: bytes,
    ) -> None:
        """Full pipeline run with mocked convert functions and real ZIP assembly.

        Assertions:
        - Output ZIP exists.
        - metadata.yaml is present and validates via IngestMetadata.
        - MEI entries exist under mei/{work}/{movement}.mei.
        - Harmonies entries exist under harmonies/{work}/{movement}.tsv.
        """
        out = tmp_path / "piano-sonatas.zip"

        with (
            patch.object(
                pdc, "convert_mscx_to_mxl", return_value=tmp_path / "dummy.mxl"
            ),
            patch.object(pdc, "convert_mxl_to_mei", return_value=valid_mei_bytes),
            patch.object(pdc, "validate_mei") as mock_validate,
        ):
            # validate_mei mock returns is_valid=True
            mock_report = MagicMock()
            mock_report.is_valid = True
            mock_validate.return_value = mock_report

            accepted: list[pdc.AcceptedMovement] = []
            for entry in discovered_entries:
                mei_bytes = pdc.convert_mxl_to_mei(tmp_path / "dummy.mxl", tmp_path)
                harmonies_path = pdc.find_harmonies_tsv(_DCML_SUBSET, entry.mscx_path)
                accepted.append(
                    pdc.AcceptedMovement(
                        entry=entry,
                        mei_bytes=mei_bytes,
                        harmonies_path=harmonies_path,
                    )
                )

        metadata = pdc.build_ingest_metadata(test_config, "cafebabe", accepted)
        pdc.assemble_zip(accepted, metadata, out)

        assert out.exists()

        with zipfile.ZipFile(out) as zf:
            names = zf.namelist()
            assert "metadata.yaml" in names
            assert "mei/k331/movement-1.mei" in names
            assert "mei/k331/movement-2.mei" in names
            assert "harmonies/k331/movement-1.tsv" in names
            assert "harmonies/k331/movement-2.tsv" in names

            raw = yaml.safe_load(zf.read("metadata.yaml"))

        reloaded = IngestMetadata.model_validate(raw)
        assert reloaded.corpus.source_commit == "cafebabe"
        assert len(reloaded.flat_movements()) == 2
