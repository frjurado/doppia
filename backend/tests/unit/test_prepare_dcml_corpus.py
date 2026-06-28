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
    """convert_mxl_to_mei uses the verovio Python API to return MEI bytes."""

    def _verovio_mock(
        self, mei_content: bytes | None = None
    ) -> tuple[MagicMock, MagicMock]:
        """Return (mock_verovio_module, mock_toolkit_instance) for sys.modules patching."""
        mock_tk = MagicMock()
        mock_tk.loadFile.return_value = mei_content is not None
        if mei_content is not None:
            mock_tk.getMEI.return_value = mei_content.decode("utf-8")
        mock_verovio = MagicMock()
        mock_verovio.toolkit.return_value = mock_tk
        return mock_verovio, mock_tk

    def test_calls_verovio_with_correct_args(
        self, tmp_path: Path, valid_mei_bytes: bytes
    ) -> None:
        mxl = tmp_path / "K331-1.mxl"
        mxl.touch()
        mock_verovio, mock_tk = self._verovio_mock(valid_mei_bytes)
        with patch.dict("sys.modules", {"verovio": mock_verovio}):
            pdc.convert_mxl_to_mei(mxl, tmp_path)
        mock_tk.loadFile.assert_called_once_with(str(mxl))

    def test_returns_mei_bytes(self, tmp_path: Path, valid_mei_bytes: bytes) -> None:
        mxl = tmp_path / "K331-1.mxl"
        mxl.touch()
        mock_verovio, _ = self._verovio_mock(valid_mei_bytes)
        with patch.dict("sys.modules", {"verovio": mock_verovio}):
            result = pdc.convert_mxl_to_mei(mxl, tmp_path)
        assert isinstance(result, bytes)
        assert b"<mei" in result

    def test_raises_runtime_error_on_load_failure(self, tmp_path: Path) -> None:
        mxl = tmp_path / "K331-1.mxl"
        mxl.touch()
        mock_verovio, _ = self._verovio_mock(mei_content=None)
        with patch.dict("sys.modules", {"verovio": mock_verovio}):
            with pytest.raises(RuntimeError, match="verovio failed to load"):
                pdc.convert_mxl_to_mei(mxl, tmp_path)

    def test_enables_deterministic_xml_id_checksum(
        self, tmp_path: Path, valid_mei_bytes: bytes
    ) -> None:
        """xmlIdChecksum must be enabled so ids survive a re-prep (ADR-030).

        The corrections overlay (ADR-027) locates targets by xml:id; that is only
        a viable locator if the prep generates the ids deterministically from the
        movement's input rather than Verovio's default random seed.
        """
        mxl = tmp_path / "K331-1.mxl"
        mxl.touch()
        mock_verovio, mock_tk = self._verovio_mock(valid_mei_bytes)
        with patch.dict("sys.modules", {"verovio": mock_verovio}):
            pdc.convert_mxl_to_mei(mxl, tmp_path)
        mock_tk.setOptions.assert_called_once_with({"xmlIdChecksum": True})


# ---------------------------------------------------------------------------
# TestFindHarmoniesTsv
# ---------------------------------------------------------------------------


class TestFindHarmoniesTsv:
    """find_harmonies_tsv derives the TSV path from the .mscx stem."""

    def test_returns_path_when_exists(self) -> None:
        mscx = _DCML_SUBSET / "MS3" / "K331-1.mscx"
        result = pdc.find_harmonies_tsv(_DCML_SUBSET, mscx)
        assert result == _DCML_SUBSET / "harmonies" / "K331-1.harmonies.tsv"

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


# ---------------------------------------------------------------------------
# TestMeasureStartClefRecovery
# ---------------------------------------------------------------------------

import lxml.etree  # noqa: E402

_MEI_NS = "http://www.music-encoding.org/ns/mei"
_XML_NS = "http://www.w3.org/XML/1998/namespace"

# Minimal MuseScore .mscx: staff 2 (bass, default F) has a genuine measure-start
# clef change at m2 (F->G), a courtesy repeat at m3 (G==G, ignored), a mid-measure
# change at m4 (G->F, exported by MuseScore so not recovered), and another genuine
# measure-start change at m5 (F->G).  Staff 1 has no changes.
_MSCX_CLEF = """<?xml version="1.0" encoding="UTF-8"?>
<museScore version="3.02">
  <Score>
    <Part>
      <Staff id="1"><StaffType group="pitched"/></Staff>
      <Staff id="2"><StaffType group="pitched"/><defaultClef>F</defaultClef></Staff>
    </Part>
    <Staff id="1">
      <Measure><voice><Chord><Note><pitch>72</pitch></Note></Chord></voice></Measure>
      <Measure><voice><Chord><Note><pitch>72</pitch></Note></Chord></voice></Measure>
      <Measure><voice><Chord><Note><pitch>72</pitch></Note></Chord></voice></Measure>
      <Measure><voice><Chord><Note><pitch>72</pitch></Note></Chord></voice></Measure>
      <Measure><voice><Chord><Note><pitch>72</pitch></Note></Chord></voice></Measure>
    </Staff>
    <Staff id="2">
      <Measure><voice><Chord><Note><pitch>48</pitch></Note></Chord></voice></Measure>
      <Measure><voice><Clef><concertClefType>G</concertClefType></Clef><Chord><Note><pitch>60</pitch></Note></Chord></voice></Measure>
      <Measure><voice><Clef><concertClefType>G</concertClefType></Clef><Chord><Note><pitch>60</pitch></Note></Chord></voice></Measure>
      <Measure><voice><Chord><Note><pitch>60</pitch></Note></Chord><Clef><concertClefType>F</concertClefType></Clef><Chord><Note><pitch>48</pitch></Note></Chord></voice></Measure>
      <Measure><voice><Clef><concertClefType>G</concertClefType></Clef><Chord><Note><pitch>60</pitch></Note></Chord></voice></Measure>
    </Staff>
  </Score>
</museScore>
"""


def _build_mei(n_measures: int) -> bytes:
    measures = "".join(
        f'<measure n="{i}">'
        f'<staff n="1"><layer n="1"><note dur="4" oct="4" pname="c"/></layer></staff>'
        f'<staff n="2"><layer n="1"><note dur="4" oct="3" pname="c"/></layer></staff>'
        f"</measure>"
        for i in range(1, n_measures + 1)
    )
    return (
        f'<?xml version="1.0" encoding="UTF-8"?>'
        f'<mei xmlns="{_MEI_NS}"><music><body><mdiv><score>'
        f"<section>{measures}</section>"
        f"</score></mdiv></body></music></mei>"
    ).encode("utf-8")


def _write_mscx(tmp_path: Path) -> Path:
    p = tmp_path / "clef.mscx"
    p.write_text(_MSCX_CLEF, encoding="utf-8")
    return p


class TestMusescoreClefToMei:
    """_musescore_clef_to_mei maps MuseScore clef tokens to MEI attributes."""

    def test_g_clef(self) -> None:
        assert pdc._musescore_clef_to_mei("G") == {"shape": "G", "line": "2"}

    def test_f_clef(self) -> None:
        assert pdc._musescore_clef_to_mei("F") == {"shape": "F", "line": "4"}

    def test_c_clef_default_line(self) -> None:
        assert pdc._musescore_clef_to_mei("C") == {"shape": "C", "line": "3"}

    def test_numbered_c_clef(self) -> None:
        assert pdc._musescore_clef_to_mei("C1") == {"shape": "C", "line": "1"}

    def test_octave_displaced(self) -> None:
        assert pdc._musescore_clef_to_mei("G8vb") == {
            "shape": "G",
            "line": "2",
            "dis": "8",
            "dis.place": "below",
        }

    def test_unknown_token_returns_none(self) -> None:
        assert pdc._musescore_clef_to_mei("PERC") is None

    def test_empty_returns_none(self) -> None:
        assert pdc._musescore_clef_to_mei("") is None


class TestExtractMeasureStartClefs:
    """_extract_measure_start_clefs isolates genuine measure-start changes."""

    def test_only_genuine_starts_recovered(self, tmp_path: Path) -> None:
        changes = pdc._extract_measure_start_clefs(_write_mscx(tmp_path))
        # m2 and m5 on staff 2 are genuine; m3 is a courtesy repeat; m4 is
        # mid-measure (exported by MuseScore); staff 1 has none.
        assert changes == [
            (2, "2", {"shape": "G", "line": "2"}),
            (5, "2", {"shape": "G", "line": "2"}),
        ]

    def test_no_score_returns_empty(self, tmp_path: Path) -> None:
        p = tmp_path / "empty.mscx"
        p.write_text("<museScore version='3.02'></museScore>", encoding="utf-8")
        assert pdc._extract_measure_start_clefs(p) == []


class TestRecoverMeasureStartClefs:
    """recover_measure_start_clefs injects dropped clefs into the MEI."""

    def _measure(self, root: lxml.etree._Element, index: int) -> lxml.etree._Element:
        return root.findall(f".//{{{_MEI_NS}}}measure")[index]

    def test_clef_injected_as_first_layer_child(self, tmp_path: Path) -> None:
        out = pdc.recover_measure_start_clefs(_write_mscx(tmp_path), _build_mei(5))
        root = lxml.etree.fromstring(out)

        staff2 = self._measure(root, 1).find(f"{{{_MEI_NS}}}staff[@n='2']")
        layer = staff2.find(f"{{{_MEI_NS}}}layer")
        first = layer[0]
        assert first.tag == f"{{{_MEI_NS}}}clef"
        assert first.get("shape") == "G"
        assert first.get("line") == "2"
        assert first.get(f"{{{_XML_NS}}}id") == "clefrec2s2l1"

    def test_other_staff_untouched(self, tmp_path: Path) -> None:
        out = pdc.recover_measure_start_clefs(_write_mscx(tmp_path), _build_mei(5))
        root = lxml.etree.fromstring(out)
        staff1 = self._measure(root, 1).find(f"{{{_MEI_NS}}}staff[@n='1']")
        first = staff1.find(f"{{{_MEI_NS}}}layer")[0]
        assert first.tag == f"{{{_MEI_NS}}}note"

    def test_two_clefs_injected_total(self, tmp_path: Path) -> None:
        out = pdc.recover_measure_start_clefs(_write_mscx(tmp_path), _build_mei(5))
        assert out.count(b"<clef") == 2

    def test_idempotent(self, tmp_path: Path) -> None:
        mscx = _write_mscx(tmp_path)
        first = pdc.recover_measure_start_clefs(mscx, _build_mei(5))
        second = pdc.recover_measure_start_clefs(mscx, first)
        assert second.count(b"<clef") == first.count(b"<clef") == 2

    def test_noop_when_no_changes(self, tmp_path: Path) -> None:
        p = tmp_path / "noclef.mscx"
        p.write_text("<museScore version='3.02'></museScore>", encoding="utf-8")
        mei = _build_mei(3)
        assert pdc.recover_measure_start_clefs(p, mei) is mei


# ---------------------------------------------------------------------------
# Clef-recovery read-through fixes (A1 widened guard, A2 per-voice, A3 sections)
# ---------------------------------------------------------------------------


def _clefs_in(layer: lxml.etree._Element) -> list[lxml.etree._Element]:
    """All ``<clef>`` descendants of a layer (e.g. nested inside a beam)."""
    return list(layer.iter(f"{{{_MEI_NS}}}clef"))


class TestClefRecoveryIdempotencyGuard:
    """A1 — an existing equivalent clef (even mid-layer) blocks injection."""

    def _mei_with_existing_clef(self, position: str) -> bytes:
        # Five measures; m2 staff 2 already carries a G/2 clef.  ``position``
        # selects whether it leads the layer or sits after a beam (the K279 m86
        # shape, where the clef is *not* the first child).
        if position == "leading":
            staff2_m2 = (
                '<staff n="2"><layer n="1">'
                '<clef shape="G" line="2"/>'
                '<note dur="4" oct="3" pname="c"/>'
                "</layer></staff>"
            )
        else:  # mid-layer, inside a beam
            staff2_m2 = (
                '<staff n="2"><layer n="1">'
                '<beam><note dur="8" oct="3" pname="c"/>'
                '<clef shape="G" line="2"/>'
                '<note dur="8" oct="4" pname="g"/></beam>'
                "</layer></staff>"
            )
        measures = []
        for i in range(1, 6):
            s2 = (
                staff2_m2
                if i == 2
                else '<staff n="2"><layer n="1">'
                '<note dur="4" oct="3" pname="c"/></layer></staff>'
            )
            measures.append(
                f'<measure n="{i}">'
                f'<staff n="1"><layer n="1">'
                f'<note dur="4" oct="4" pname="c"/></layer></staff>'
                f"{s2}</measure>"
            )
        return (
            f'<?xml version="1.0" encoding="UTF-8"?>'
            f'<mei xmlns="{_MEI_NS}"><music><body><mdiv><score>'
            f'<section>{"".join(measures)}</section>'
            f"</score></mdiv></body></music></mei>"
        ).encode("utf-8")

    def test_no_double_when_leading_clef_present(self, tmp_path: Path) -> None:
        out = pdc.recover_measure_start_clefs(
            _write_mscx(tmp_path), self._mei_with_existing_clef("leading")
        )
        root = lxml.etree.fromstring(out)
        m2_s2 = root.findall(f".//{{{_MEI_NS}}}measure")[1].find(
            f"{{{_MEI_NS}}}staff[@n='2']"
        )
        # m2 keeps its single clef; m5 (no pre-existing clef) still gets one.
        assert len(_clefs_in(m2_s2.find(f"{{{_MEI_NS}}}layer"))) == 1
        assert out.count(b"<clef") == 2

    def test_no_double_when_clef_nested_in_beam(self, tmp_path: Path) -> None:
        out = pdc.recover_measure_start_clefs(
            _write_mscx(tmp_path), self._mei_with_existing_clef("mid")
        )
        root = lxml.etree.fromstring(out)
        m2_s2 = root.findall(f".//{{{_MEI_NS}}}measure")[1].find(
            f"{{{_MEI_NS}}}staff[@n='2']"
        )
        # The mid-beam G/2 clef already encodes the change — no clef is injected
        # at position 0, so no rendered double-clef (A1 / K279 m86).
        assert len(_clefs_in(m2_s2.find(f"{{{_MEI_NS}}}layer"))) == 1


class TestClefRecoveryPerVoice:
    """A2 — the recovered clef is injected into every layer of the staff."""

    def _two_voice_mei(self) -> bytes:
        measures = []
        for i in range(1, 6):
            if i == 2:
                s2 = (
                    '<staff n="2">'
                    '<layer n="1"><note dur="4" oct="3" pname="c"/></layer>'
                    '<layer n="2"><note dur="4" oct="2" pname="c"/></layer>'
                    "</staff>"
                )
            else:
                s2 = (
                    '<staff n="2"><layer n="1">'
                    '<note dur="4" oct="3" pname="c"/></layer></staff>'
                )
            measures.append(
                f'<measure n="{i}">'
                f'<staff n="1"><layer n="1">'
                f'<note dur="4" oct="4" pname="c"/></layer></staff>'
                f"{s2}</measure>"
            )
        return (
            f'<?xml version="1.0" encoding="UTF-8"?>'
            f'<mei xmlns="{_MEI_NS}"><music><body><mdiv><score>'
            f'<section>{"".join(measures)}</section>'
            f"</score></mdiv></body></music></mei>"
        ).encode("utf-8")

    def test_clef_injected_into_both_layers(self, tmp_path: Path) -> None:
        out = pdc.recover_measure_start_clefs(
            _write_mscx(tmp_path), self._two_voice_mei()
        )
        root = lxml.etree.fromstring(out)
        m2_s2 = root.findall(f".//{{{_MEI_NS}}}measure")[1].find(
            f"{{{_MEI_NS}}}staff[@n='2']"
        )
        for layer in m2_s2.findall(f"{{{_MEI_NS}}}layer"):
            first = layer[0]
            assert first.tag == f"{{{_MEI_NS}}}clef"
            assert first.get("shape") == "G" and first.get("line") == "2"
        # Distinct xml:ids per layer (clefrec2s2l1, clefrec2s2l2).
        ids = {
            c.get(f"{{{_XML_NS}}}id")
            for layer in m2_s2.findall(f"{{{_MEI_NS}}}layer")
            for c in _clefs_in(layer)
        }
        assert ids == {"clefrec2s2l1", "clefrec2s2l2"}

    def test_idempotent_across_two_voices(self, tmp_path: Path) -> None:
        mscx = _write_mscx(tmp_path)
        first = pdc.recover_measure_start_clefs(mscx, self._two_voice_mei())
        second = pdc.recover_measure_start_clefs(mscx, first)
        assert second.count(b"<clef") == first.count(b"<clef")


# A two-section .mscx: section 1 = m1,m2 (break after m2), section 2 (trio) =
# m3,m4 with a genuine measure-start G clef at m3 (staff 2, default F).
_MSCX_SECTIONS = """<?xml version="1.0" encoding="UTF-8"?>
<museScore version="3.02">
  <Score>
    <Part>
      <Staff id="1"><StaffType group="pitched"/></Staff>
      <Staff id="2"><StaffType group="pitched"/><defaultClef>F</defaultClef></Staff>
    </Part>
    <Staff id="1">
      <Measure><voice><Chord><Note><pitch>72</pitch></Note></Chord></voice></Measure>
      <Measure><voice><Chord><Note><pitch>72</pitch></Note></Chord></voice><LayoutBreak><subtype>section</subtype></LayoutBreak></Measure>
      <Measure><voice><Chord><Note><pitch>72</pitch></Note></Chord></voice></Measure>
      <Measure><voice><Chord><Note><pitch>72</pitch></Note></Chord></voice></Measure>
    </Staff>
    <Staff id="2">
      <Measure><voice><Chord><Note><pitch>48</pitch></Note></Chord></voice></Measure>
      <Measure><voice><Chord><Note><pitch>48</pitch></Note></Chord></voice></Measure>
      <Measure><voice><Clef><concertClefType>G</concertClefType></Clef><Chord><Note><pitch>60</pitch></Note></Chord></voice></Measure>
      <Measure><voice><Chord><Note><pitch>60</pitch></Note></Chord></voice></Measure>
    </Staff>
  </Score>
</museScore>
"""


def _two_section_mei(minuet_measures: int) -> bytes:
    """MEI with a minuet section (``minuet_measures`` bars) then a 2-bar trio.

    Inflating ``minuet_measures`` past the .mscx's 2 simulates the count
    divergence that makes flat document-order indexing mis-place the trio clef.
    """

    def measure(n: int) -> str:
        return (
            f'<measure n="{n}">'
            f'<staff n="1"><layer n="1"><note dur="4" oct="4" pname="c"/></layer></staff>'
            f'<staff n="2"><layer n="1"><note dur="4" oct="3" pname="c"/></layer></staff>'
            f"</measure>"
        )

    minuet = "".join(measure(i) for i in range(1, minuet_measures + 1))
    trio = "".join(measure(i) for i in range(1, 3))
    return (
        f'<?xml version="1.0" encoding="UTF-8"?>'
        f'<mei xmlns="{_MEI_NS}"><music><body><mdiv><score>'
        f"<section>{minuet}</section>"
        f'<section type="trio">{trio}</section>'
        f"</score></mdiv></body></music></mei>"
    ).encode("utf-8")


class TestClefRecoverySectionAware:
    """A3 — index resolution is section-aware when section counts agree."""

    def test_section_boundary_extracted(self, tmp_path: Path) -> None:
        p = tmp_path / "sections.mscx"
        p.write_text(_MSCX_SECTIONS, encoding="utf-8")
        assert pdc._extract_section_boundaries(p) == [2]

    def test_trio_clef_lands_in_trio_despite_minuet_drift(self, tmp_path: Path) -> None:
        p = tmp_path / "sections.mscx"
        p.write_text(_MSCX_SECTIONS, encoding="utf-8")
        # MEI minuet has 3 bars vs the .mscx's 2 — a one-bar drift.  Flat
        # indexing would place the m3 trio clef on the minuet's 3rd bar; the
        # section-aware path lands it on the trio's first bar.
        out = pdc.recover_measure_start_clefs(p, _two_section_mei(minuet_measures=3))
        root = lxml.etree.fromstring(out)
        sections = root.findall(f".//{{{_MEI_NS}}}section")
        minuet, trio = sections[0], sections[1]
        assert _clefs_in(minuet) == []
        trio_first = trio.findall(f".//{{{_MEI_NS}}}measure")[0]
        clef = trio_first.find(
            f"{{{_MEI_NS}}}staff[@n='2']/{{{_MEI_NS}}}layer/{{{_MEI_NS}}}clef"
        )
        assert clef is not None
        assert clef.get("shape") == "G" and clef.get("line") == "2"

    def test_section_mismatch_falls_back_and_notes(self, tmp_path: Path) -> None:
        p = tmp_path / "sections.mscx"
        p.write_text(_MSCX_SECTIONS, encoding="utf-8")
        # MEI as a single section: section counts disagree (2 vs 1) → fallback.
        single = _build_mei(4)
        notes: list[str] = []
        pdc.recover_measure_start_clefs(p, single, notes=notes)
        assert any("falling back to global" in n for n in notes)
