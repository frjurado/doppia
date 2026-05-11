"""Unit tests for backend/models/fragment.py.

Covers Fragment, FragmentConceptTag, FragmentReview ORM models and the
FragmentSummary Pydantic schema.  No running database is required — all tests
work from model definitions and in-memory Pydantic validation only.

Test structure
--------------
TestFragmentConstruction    — ORM defaults, nullable semantics, server_default
TestFragmentSummarySchema   — Pydantic: version invariant, required fields, extras
TestParentFragmentCascade   — parent_fragment_id FK carries ondelete=CASCADE
TestFragmentConceptTag      — cross-system contract: concept_id is TEXT, no cross-DB FK
TestFragmentReview          — UniqueConstraint and CheckConstraint in table_args
"""

from __future__ import annotations

import uuid

import pytest
from models.fragment import (
    ActualKey,
    Fragment,
    FragmentConceptTag,
    FragmentReview,
    FragmentSummary,
)
from pydantic import ValidationError
from sqlalchemy import UniqueConstraint

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _min_summary(**overrides: object) -> dict[str, object]:
    """Return a minimal valid version-1 summary dict."""
    base: dict[str, object] = {
        "version": 1,
        "key": "A major",
        "meter": "4/4",
        "music21_version": "9.1.0",
        "concepts": ["PerfectAuthenticCadence"],
    }
    base.update(overrides)
    return base


def _fragment(**overrides: object) -> Fragment:
    """Construct a Fragment ORM object with sensible defaults."""
    mov_id = uuid.uuid4()
    fields: dict[str, object] = {
        "movement_id": mov_id,
        "bar_start": 1,
        "bar_end": 4,
        "mc_start": 1,
        "mc_end": 4,
        "summary": _min_summary(),
        "status": "draft",
    }
    fields.update(overrides)
    return Fragment(**fields)


# ---------------------------------------------------------------------------
# TestFragmentConstruction
# ---------------------------------------------------------------------------


class TestFragmentConstruction:
    def test_status_server_default_is_draft(self) -> None:
        """Fragment.status has server_default='draft' in the column definition."""
        col = Fragment.__table__.c["status"]
        assert col.server_default is not None
        # SQLAlchemy wraps scalar server_defaults in a FetchedValue or
        # ColumnDefault; the compiled text is what we care about.
        assert "draft" in str(col.server_default.arg)

    def test_beat_positions_are_nullable(self) -> None:
        """beat_start and beat_end are optional (nullable=True)."""
        assert Fragment.__table__.c["beat_start"].nullable is True
        assert Fragment.__table__.c["beat_end"].nullable is True

    def test_required_columns_are_not_nullable(self) -> None:
        """Core position columns are NOT NULL."""
        for col_name in ("bar_start", "bar_end", "mc_start", "mc_end"):
            col = Fragment.__table__.c[col_name]
            assert col.nullable is False, f"{col_name} should be NOT NULL"

    def test_summary_column_is_not_nullable(self) -> None:
        """summary JSONB must be NOT NULL."""
        assert Fragment.__table__.c["summary"].nullable is False

    def test_status_check_constraint_exists(self) -> None:
        """Fragment has a CheckConstraint restricting status to valid values."""
        check_names = {
            c.name for c in Fragment.__table__.constraints if hasattr(c, "sqltext")
        }
        assert "fragment_status_check" in check_names

    def test_orm_object_accepts_valid_fields(self) -> None:
        """A Fragment ORM object can be constructed without error."""
        frag = _fragment()
        assert frag.bar_start == 1
        assert frag.bar_end == 4
        assert frag.status == "draft"


# ---------------------------------------------------------------------------
# TestFragmentSummarySchema
# ---------------------------------------------------------------------------


class TestFragmentSummarySchema:
    def test_valid_summary_passes(self) -> None:
        """A complete, correct summary dict validates without error."""
        summary = FragmentSummary.model_validate(_min_summary())
        assert summary.version == 1
        assert summary.key == "A major"
        assert summary.concepts == ["PerfectAuthenticCadence"]

    def test_version_field_is_required(self) -> None:
        """A summary without 'version' raises a ValidationError."""
        bad = _min_summary()
        del bad["version"]  # type: ignore[misc]
        with pytest.raises(ValidationError) as exc_info:
            FragmentSummary.model_validate(bad)
        errors = {e["loc"][0] for e in exc_info.value.errors()}
        assert "version" in errors

    def test_version_must_be_1(self) -> None:
        """version=2 is rejected — only version 1 is currently valid."""
        with pytest.raises(ValidationError):
            FragmentSummary.model_validate(_min_summary(version=2))

    def test_key_is_required(self) -> None:
        """'key' (notated key signature) is a required field."""
        bad = _min_summary()
        del bad["key"]  # type: ignore[misc]
        with pytest.raises(ValidationError) as exc_info:
            FragmentSummary.model_validate(bad)
        errors = {e["loc"][0] for e in exc_info.value.errors()}
        assert "key" in errors

    def test_concepts_must_be_present(self) -> None:
        """'concepts' list is required — it is the primary tag list."""
        bad = _min_summary()
        del bad["concepts"]  # type: ignore[misc]
        with pytest.raises(ValidationError) as exc_info:
            FragmentSummary.model_validate(bad)
        errors = {e["loc"][0] for e in exc_info.value.errors()}
        assert "concepts" in errors

    def test_extra_fields_are_forbidden(self) -> None:
        """Unknown top-level fields are rejected (extra='forbid')."""
        with pytest.raises(ValidationError):
            FragmentSummary.model_validate(_min_summary(unknown_field="should_fail"))

    def test_actual_key_defaults_to_none(self) -> None:
        """actual_key is optional and defaults to None."""
        summary = FragmentSummary.model_validate(_min_summary())
        assert summary.actual_key is None

    def test_actual_key_validates_when_present(self) -> None:
        """A valid actual_key object passes nested validation."""
        summary = FragmentSummary.model_validate(
            _min_summary(
                actual_key={
                    "value": "D minor",
                    "confidence": 0.87,
                    "auto": True,
                    "reviewed": False,
                }
            )
        )
        assert isinstance(summary.actual_key, ActualKey)
        assert summary.actual_key.value == "D minor"


# ---------------------------------------------------------------------------
# TestParentFragmentCascade
# ---------------------------------------------------------------------------


class TestParentFragmentCascade:
    def test_parent_fragment_id_fk_has_cascade_delete(self) -> None:
        """parent_fragment_id FK carries ondelete='CASCADE'.

        A sub-fragment must be deleted automatically when its parent is
        deleted; WITHOUT this the delete would be blocked by a FK violation or
        leave orphans.
        """
        fk = Fragment.__table__.c["parent_fragment_id"].foreign_keys
        assert len(fk) == 1
        (fk_obj,) = fk
        assert fk_obj.ondelete.upper() == "CASCADE"

    def test_movement_id_fk_has_restrict_delete(self) -> None:
        """movement_id FK carries ondelete='RESTRICT'.

        A movement with fragments must not be silently deleted; the FK
        protection forces an explicit cleanup decision.
        """
        fk = Fragment.__table__.c["movement_id"].foreign_keys
        assert len(fk) == 1
        (fk_obj,) = fk
        assert fk_obj.ondelete.upper() == "RESTRICT"


# ---------------------------------------------------------------------------
# TestFragmentConceptTag
# ---------------------------------------------------------------------------


class TestFragmentConceptTag:
    def test_concept_id_is_string_no_cross_db_fk(self) -> None:
        """concept_id is a plain TEXT column with no FK to Neo4j.

        There is intentionally no database-level foreign key across systems.
        Referential integrity is enforced by the Pydantic validation layer at
        write time (per fragment-schema.md cross-database join pattern).
        """
        col = FragmentConceptTag.__table__.c["concept_id"]
        # No FK referencing another table
        assert len(col.foreign_keys) == 0
        # Type is String/Text
        from sqlalchemy import String as SAString

        assert isinstance(col.type, SAString)

    def test_is_primary_has_true_server_default(self) -> None:
        """is_primary server_default is 'true' — new tags default to primary."""
        col = FragmentConceptTag.__table__.c["is_primary"]
        assert col.server_default is not None
        assert "true" in str(col.server_default.arg).lower()

    def test_composite_primary_key(self) -> None:
        """(fragment_id, concept_id) forms the composite PK."""
        pk_cols = {c.name for c in FragmentConceptTag.__table__.primary_key}
        assert pk_cols == {"fragment_id", "concept_id"}


# ---------------------------------------------------------------------------
# TestFragmentReview
# ---------------------------------------------------------------------------


class TestFragmentReview:
    def test_unique_constraint_fragment_reviewer(self) -> None:
        """UNIQUE (fragment_id, reviewer_id) prevents duplicate decisions.

        A reviewer changing their mind updates the existing row; inserting a
        second row must be blocked at the DB level.
        """
        unique_constraints = [
            c for c in FragmentReview.__table_args__ if isinstance(c, UniqueConstraint)
        ]
        assert len(unique_constraints) == 1
        uc_cols = {col for col in unique_constraints[0].columns.keys()}
        assert uc_cols == {"fragment_id", "reviewer_id"}

    def test_decision_check_constraint_exists(self) -> None:
        """CheckConstraint restricts decision to 'approved' or 'rejected'."""
        check_names = {
            c.name
            for c in FragmentReview.__table__.constraints
            if hasattr(c, "sqltext")
        }
        assert "fragment_review_decision_check" in check_names
