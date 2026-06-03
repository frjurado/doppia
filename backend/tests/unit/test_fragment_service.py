"""Unit tests for the fragment service internal logic (Step 19 — Component 5).

Tests the service-layer methods that can be verified without a running database,
using MagicMock / AsyncMock stubs for the SQLAlchemy session and Neo4j driver.

The integration tests in tests/integration/ cover the public HTTP surface end-to-end.
These unit tests target the internal helpers and the approval-gate logic, which would
otherwise only be reachable through expensive multi-step integration scenarios.

Test structure
--------------
TestCheckEditPermission         — FragmentService._check_edit_permission (static)
TestCheckNotCreator             — _check_not_creator module-level function
TestValidateContainmentForUpdate — validate_containment_for_update
TestDeriveDatalicence           — FragmentService._derive_data_licence (DB mocked)
TestRunApprovalGate             — FragmentService._run_approval_gate (DB + Neo4j mocked)
"""

from __future__ import annotations

import uuid
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------


def _make_fragment(
    *,
    bar_start: int = 1,
    bar_end: int = 4,
    created_by: uuid.UUID | None = None,
    status: str = "submitted",
    movement_id: uuid.UUID | None = None,
    summary: dict | None = None,
    repeat_context: str | None = None,
) -> Any:
    """Construct a Fragment ORM object without a database session.

    SQLAlchemy declarative objects can be instantiated as plain Python
    objects; attributes named here are the only ones accessed during the
    tests that call this helper.
    """
    from models.fragment import Fragment

    fragment = Fragment()
    fragment.id = uuid.uuid4()
    fragment.movement_id = movement_id or uuid.uuid4()
    fragment.bar_start = bar_start
    fragment.bar_end = bar_end
    fragment.mc_start = 1
    fragment.mc_end = 4
    fragment.beat_start = None
    fragment.beat_end = None
    fragment.repeat_context = repeat_context
    fragment.summary = summary or {
        "version": 1,
        "key": "G major",
        "meter": "4/4",
        "concepts": ["PerfectAuthenticCadence"],
    }
    fragment.status = status
    fragment.created_by = created_by
    return fragment


def _make_service(db: Any = None, driver: Any = None) -> Any:
    """Construct a FragmentService with mock dependencies."""
    from services.fragments import FragmentService

    mock_db = db if db is not None else AsyncMock()
    mock_driver = driver if driver is not None else MagicMock()
    return FragmentService(db=mock_db, driver=mock_driver)


def _make_execute_result(
    *,
    scalars_list: list | None = None,
    scalar_one: Any = "__unset__",
) -> MagicMock:
    """Build a mock SQLAlchemy execute result for common access patterns."""
    result = MagicMock()
    if scalars_list is not None:
        result.scalars.return_value.all.return_value = scalars_list
    if scalar_one != "__unset__":
        result.scalar_one_or_none.return_value = scalar_one
    return result


def _min_summary(**overrides: Any) -> dict:
    """Minimal valid version-1 summary dict."""
    base: dict = {
        "version": 1,
        "key": "G major",
        "meter": "4/4",
        "concepts": ["PerfectAuthenticCadence"],
    }
    base.update(overrides)
    return base


def _make_fragment_update(
    *,
    bar_start: int = 1,
    bar_end: int = 8,
    sub_parts: list[dict] | None = None,
) -> Any:
    """Build a minimal valid FragmentUpdate for containment tests."""
    from models.fragment import FragmentUpdate

    return FragmentUpdate.model_validate(
        {
            "bar_start": bar_start,
            "bar_end": bar_end,
            "mc_start": 1,
            "mc_end": 8,
            "summary": _min_summary(),
            "concept_tags": [
                {"concept_id": "PerfectAuthenticCadence", "is_primary": True}
            ],
            "sub_parts": sub_parts or [],
        }
    )


def _sub_part(*, bar_start: int, bar_end: int) -> dict:
    """Minimal sub-part dict for containment tests."""
    return {
        "bar_start": bar_start,
        "bar_end": bar_end,
        "mc_start": bar_start,
        "mc_end": bar_end,
        "summary": _min_summary(),
        "concept_tags": [{"concept_id": "PerfectAuthenticCadence", "is_primary": True}],
    }


# ---------------------------------------------------------------------------
# TestCheckEditPermission
# ---------------------------------------------------------------------------


class TestCheckEditPermission:
    """FragmentService._check_edit_permission — guards draft edits by caller identity."""

    def test_creator_may_edit_own_draft(self) -> None:
        """The fragment's creator may always edit their own draft."""
        from services.fragments import FragmentService

        creator_id = uuid.uuid4()
        fragment = _make_fragment(created_by=creator_id, status="draft")

        # Must not raise.
        FragmentService._check_edit_permission(fragment, str(creator_id), "editor")

    def test_admin_may_edit_any_draft(self) -> None:
        """An admin may edit any fragment regardless of who created it."""
        from services.fragments import FragmentService

        creator_id = uuid.uuid4()
        other_caller = str(uuid.uuid4())  # not the creator
        fragment = _make_fragment(created_by=creator_id, status="draft")

        # Must not raise.
        FragmentService._check_edit_permission(fragment, other_caller, "admin")

    def test_non_creator_editor_is_rejected(self) -> None:
        """A non-creator editor cannot update another annotator's draft."""
        from errors import FragmentValidationError
        from services.fragments import FragmentService

        creator_id = uuid.uuid4()
        other_caller = str(uuid.uuid4())
        fragment = _make_fragment(created_by=creator_id, status="draft")

        with pytest.raises(FragmentValidationError) as exc_info:
            FragmentService._check_edit_permission(fragment, other_caller, "editor")

        assert str(creator_id) in str(exc_info.value.detail)

    def test_fragment_with_no_creator_blocks_non_admin(self) -> None:
        """A fragment with created_by=None blocks non-admin callers."""
        from errors import FragmentValidationError
        from services.fragments import FragmentService

        fragment = _make_fragment(created_by=None, status="draft")
        caller = str(uuid.uuid4())

        with pytest.raises(FragmentValidationError):
            FragmentService._check_edit_permission(fragment, caller, "editor")

    def test_fragment_with_no_creator_allows_admin(self) -> None:
        """A fragment with created_by=None is still editable by an admin."""
        from services.fragments import FragmentService

        fragment = _make_fragment(created_by=None, status="draft")
        caller = str(uuid.uuid4())

        # Must not raise.
        FragmentService._check_edit_permission(fragment, caller, "admin")


# ---------------------------------------------------------------------------
# TestCheckNotCreator
# ---------------------------------------------------------------------------


class TestCheckNotCreator:
    """_check_not_creator — self-review guard for the approval state machine."""

    def test_different_reviewer_passes(self) -> None:
        """A reviewer who is not the creator proceeds without error."""
        from services.fragments import _check_not_creator

        creator_id = uuid.uuid4()
        reviewer_id = str(uuid.uuid4())  # different user
        fragment = _make_fragment(created_by=creator_id)

        # Must not raise.
        _check_not_creator(fragment, reviewer_id)

    def test_creator_as_reviewer_raises(self) -> None:
        """The creator may not review their own fragment."""
        from errors import SelfReviewForbiddenError
        from services.fragments import _check_not_creator

        creator_id = uuid.uuid4()
        fragment = _make_fragment(created_by=creator_id)

        with pytest.raises(SelfReviewForbiddenError) as exc_info:
            _check_not_creator(fragment, str(creator_id))

        assert str(creator_id) in str(exc_info.value.detail)
        assert str(fragment.id) in str(exc_info.value.detail)

    def test_no_creator_recorded_always_passes(self) -> None:
        """When created_by is None, any reviewer is accepted (no creator to protect)."""
        from services.fragments import _check_not_creator

        fragment = _make_fragment(created_by=None)
        # Must not raise regardless of who the reviewer is.
        _check_not_creator(fragment, str(uuid.uuid4()))


# ---------------------------------------------------------------------------
# TestValidateContainmentForUpdate
# ---------------------------------------------------------------------------


class TestValidateContainmentForUpdate:
    """validate_containment_for_update — bar range containment on update payloads."""

    def test_no_sub_parts_passes(self) -> None:
        """A payload with no sub-parts passes without error."""
        from services.fragments import validate_containment_for_update

        payload = _make_fragment_update(bar_start=1, bar_end=8)
        validate_containment_for_update(payload)  # must not raise

    def test_child_fully_within_parent_passes(self) -> None:
        """A sub-part fully contained inside the parent range is accepted."""
        from services.fragments import validate_containment_for_update

        payload = _make_fragment_update(
            bar_start=1,
            bar_end=8,
            sub_parts=[_sub_part(bar_start=3, bar_end=5)],
        )
        validate_containment_for_update(payload)  # must not raise

    def test_child_equal_to_parent_range_passes(self) -> None:
        """A sub-part spanning the full parent range is accepted."""
        from services.fragments import validate_containment_for_update

        payload = _make_fragment_update(
            bar_start=2,
            bar_end=6,
            sub_parts=[_sub_part(bar_start=2, bar_end=6)],
        )
        validate_containment_for_update(payload)  # must not raise

    def test_child_starts_before_parent_raises(self) -> None:
        """A sub-part starting before bar_start raises FragmentValidationError."""
        from errors import FragmentValidationError
        from services.fragments import validate_containment_for_update

        payload = _make_fragment_update(
            bar_start=4,
            bar_end=8,
            sub_parts=[_sub_part(bar_start=2, bar_end=6)],  # starts before parent
        )
        with pytest.raises(FragmentValidationError) as exc_info:
            validate_containment_for_update(payload)

        detail = exc_info.value.detail
        assert detail["sub_part_index"] == 0
        assert detail["parent_bar_start"] == 4

    def test_child_ends_after_parent_raises(self) -> None:
        """A sub-part ending after bar_end raises FragmentValidationError."""
        from errors import FragmentValidationError
        from services.fragments import validate_containment_for_update

        payload = _make_fragment_update(
            bar_start=1,
            bar_end=4,
            sub_parts=[_sub_part(bar_start=2, bar_end=7)],  # ends after parent
        )
        with pytest.raises(FragmentValidationError) as exc_info:
            validate_containment_for_update(payload)

        detail = exc_info.value.detail
        assert detail["child_bar_end"] == 7
        assert detail["parent_bar_end"] == 4

    def test_second_sub_part_out_of_range_names_correct_index(self) -> None:
        """When the second sub-part violates containment, the error names index 1."""
        from errors import FragmentValidationError
        from services.fragments import validate_containment_for_update

        payload = _make_fragment_update(
            bar_start=1,
            bar_end=8,
            sub_parts=[
                _sub_part(bar_start=2, bar_end=4),  # valid
                _sub_part(bar_start=5, bar_end=12),  # exceeds parent
            ],
        )
        with pytest.raises(FragmentValidationError) as exc_info:
            validate_containment_for_update(payload)

        assert exc_info.value.detail["sub_part_index"] == 1


# ---------------------------------------------------------------------------
# TestDeriveDatalicence
# ---------------------------------------------------------------------------


class TestDeriveDatalicence:
    """FragmentService._derive_data_licence — DCML event classification (ADR-009)."""

    @pytest.mark.asyncio
    async def test_no_movement_analysis_row_returns_none(self) -> None:
        """When no movement_analysis row exists, data_licence is None."""
        mock_db = AsyncMock()
        mock_db.execute = AsyncMock(return_value=_make_execute_result(scalar_one=None))

        service = _make_service(db=mock_db)
        result = await service._derive_data_licence(uuid.uuid4(), 1, 4)
        assert result is None

    @pytest.mark.asyncio
    async def test_dcml_event_in_range_returns_cc_by_sa(self) -> None:
        """A DCML-sourced event within the bar range classifies as CC BY-SA 4.0."""
        mock_db = AsyncMock()
        mock_db.execute = AsyncMock(
            return_value=_make_execute_result(scalar_one=[{"mn": 2, "source": "DCML"}])
        )

        service = _make_service(db=mock_db)
        result = await service._derive_data_licence(uuid.uuid4(), 1, 4)
        assert result == "CC BY-SA 4.0"

    @pytest.mark.asyncio
    async def test_dcml_event_outside_bar_range_returns_none(self) -> None:
        """A DCML event whose mn falls outside the fragment's bar range is not counted."""
        mock_db = AsyncMock()
        mock_db.execute = AsyncMock(
            return_value=_make_execute_result(
                scalar_one=[{"mn": 10, "source": "DCML"}]  # mn=10 is outside bars 1–4
            )
        )

        service = _make_service(db=mock_db)
        result = await service._derive_data_licence(uuid.uuid4(), 1, 4)
        assert result is None

    @pytest.mark.asyncio
    async def test_non_dcml_event_in_range_returns_none(self) -> None:
        """A manual (non-DCML) event in range does not trigger the licence flag."""
        mock_db = AsyncMock()
        mock_db.execute = AsyncMock(
            return_value=_make_execute_result(
                scalar_one=[{"mn": 2, "source": "manual"}]
            )
        )

        service = _make_service(db=mock_db)
        result = await service._derive_data_licence(uuid.uuid4(), 1, 4)
        assert result is None

    @pytest.mark.asyncio
    async def test_single_dcml_among_manual_events_triggers_licence(self) -> None:
        """Even one DCML event in range triggers CC BY-SA 4.0 regardless of other sources."""
        mock_db = AsyncMock()
        mock_db.execute = AsyncMock(
            return_value=_make_execute_result(
                scalar_one=[
                    {"mn": 1, "source": "manual"},
                    {"mn": 2, "source": "DCML"},
                    {"mn": 3, "source": "manual"},
                ]
            )
        )

        service = _make_service(db=mock_db)
        result = await service._derive_data_licence(uuid.uuid4(), 1, 4)
        assert result == "CC BY-SA 4.0"

    @pytest.mark.asyncio
    async def test_event_at_bar_boundary_is_included(self) -> None:
        """Events at bar_start and bar_end are included in the range check (inclusive)."""
        mock_db = AsyncMock()
        mock_db.execute = AsyncMock(
            return_value=_make_execute_result(
                scalar_one=[
                    {"mn": 1, "source": "DCML"},  # exactly at bar_start=1
                    {"mn": 4, "source": "DCML"},  # exactly at bar_end=4
                ]
            )
        )

        service = _make_service(db=mock_db)
        result = await service._derive_data_licence(uuid.uuid4(), 1, 4)
        assert result == "CC BY-SA 4.0"


# ---------------------------------------------------------------------------
# TestRunApprovalGate
# ---------------------------------------------------------------------------


class TestRunApprovalGate:
    """FragmentService._run_approval_gate — all gate condition branches.

    Gate 1: ``actual_key`` with ``auto=True`` and ``reviewed=False`` blocks approval.
    Gate 2: For harmony-capturing concepts, every event in the fragment's bar range
            must have ``reviewed=True``. Events are filtered by volta when the
            fragment has a ``repeat_context``.
    """

    def _build_service(
        self,
        *,
        concept_ids: list[str],
        has_harmony_gate: bool,
        events: list[dict] | None,
    ) -> Any:
        """
        Build a FragmentService whose DB is mocked for the two execute() calls
        that _run_approval_gate makes:

        1. SELECT concept_ids from fragment_concept_tag → scalars().all() → concept_ids
        2. SELECT events from movement_analysis → scalar_one_or_none() → events list
           (only reached when has_gate is True)

        The Neo4j driver is mocked so its session context manager is valid, but the
        check_concepts_have_harmony_gate function is patched at the module level in
        each test — the mock driver is only needed to satisfy the ``async with`` open.
        """
        concept_result = _make_execute_result(scalars_list=concept_ids)
        events_result = _make_execute_result(scalar_one=events)

        mock_db = AsyncMock()
        mock_db.execute = AsyncMock(side_effect=[concept_result, events_result])

        mock_neo_session = AsyncMock()
        mock_driver = MagicMock()
        mock_driver.session.return_value.__aenter__ = AsyncMock(
            return_value=mock_neo_session
        )
        mock_driver.session.return_value.__aexit__ = AsyncMock(return_value=False)

        return _make_service(db=mock_db, driver=mock_driver)

    # -- Gate 1: actual_key review --

    @pytest.mark.asyncio
    async def test_no_actual_key_passes_gate1(self) -> None:
        """summary without actual_key does not trigger gate 1."""
        service = self._build_service(
            concept_ids=["PerfectAuthenticCadence"],
            has_harmony_gate=False,
            events=None,
        )
        fragment = _make_fragment()  # summary has no actual_key

        with patch(
            "services.fragments.check_concepts_have_harmony_gate",
            new=AsyncMock(return_value=False),
        ):
            failures = await service._run_approval_gate(fragment)

        assert "unreviewed_actual_key" not in failures

    @pytest.mark.asyncio
    async def test_actual_key_auto_true_reviewed_false_fails_gate1(self) -> None:
        """actual_key with auto=True and reviewed=False blocks the approval."""
        service = self._build_service(
            concept_ids=["PerfectAuthenticCadence"],
            has_harmony_gate=False,
            events=None,
        )
        fragment = _make_fragment(
            summary=_min_summary(
                actual_key={"value": "G major", "auto": True, "reviewed": False}
            )
        )

        with patch(
            "services.fragments.check_concepts_have_harmony_gate",
            new=AsyncMock(return_value=False),
        ):
            failures = await service._run_approval_gate(fragment)

        assert "unreviewed_actual_key" in failures
        assert failures["unreviewed_actual_key"]["auto"] is True
        assert failures["unreviewed_actual_key"]["reviewed"] is False

    @pytest.mark.asyncio
    async def test_actual_key_auto_false_does_not_trigger_gate1(self) -> None:
        """actual_key with auto=False does not trigger gate 1 even if reviewed=False.

        The gate only fires when the key was machine-generated (auto=True).
        DCML-seeded keys have auto=False by design (option b).
        """
        service = self._build_service(
            concept_ids=["PerfectAuthenticCadence"],
            has_harmony_gate=False,
            events=None,
        )
        fragment = _make_fragment(
            summary=_min_summary(
                actual_key={"value": "G major", "auto": False, "reviewed": False}
            )
        )

        with patch(
            "services.fragments.check_concepts_have_harmony_gate",
            new=AsyncMock(return_value=False),
        ):
            failures = await service._run_approval_gate(fragment)

        assert "unreviewed_actual_key" not in failures

    @pytest.mark.asyncio
    async def test_actual_key_auto_true_reviewed_true_passes_gate1(self) -> None:
        """actual_key with auto=True and reviewed=True passes gate 1."""
        service = self._build_service(
            concept_ids=["PerfectAuthenticCadence"],
            has_harmony_gate=False,
            events=None,
        )
        fragment = _make_fragment(
            summary=_min_summary(
                actual_key={"value": "G major", "auto": True, "reviewed": True}
            )
        )

        with patch(
            "services.fragments.check_concepts_have_harmony_gate",
            new=AsyncMock(return_value=False),
        ):
            failures = await service._run_approval_gate(fragment)

        assert "unreviewed_actual_key" not in failures

    # -- Gate 2: harmony event review --

    @pytest.mark.asyncio
    async def test_no_harmony_gate_skips_event_check(self) -> None:
        """Concepts without a harmony_gate declaration skip gate 2 entirely.

        Even an unreviewed event in range must not block approval for
        non-harmony concepts (e.g. a Hemiola that declares no harmony_gate).
        """
        service = self._build_service(
            concept_ids=["Hemiola"],
            has_harmony_gate=False,
            events=[{"mn": 2, "volta": None, "reviewed": False}],
        )
        fragment = _make_fragment(bar_start=1, bar_end=4)

        with patch(
            "services.fragments.check_concepts_have_harmony_gate",
            new=AsyncMock(return_value=False),
        ):
            failures = await service._run_approval_gate(fragment)

        assert "unreviewed_harmony_events" not in failures

    @pytest.mark.asyncio
    async def test_harmony_gate_all_events_reviewed_passes(self) -> None:
        """All events reviewed in range → gate 2 passes."""
        service = self._build_service(
            concept_ids=["PerfectAuthenticCadence"],
            has_harmony_gate=True,
            events=[
                {"mn": 2, "volta": None, "reviewed": True},
                {"mn": 3, "volta": None, "reviewed": True},
            ],
        )
        fragment = _make_fragment(bar_start=1, bar_end=4)

        with patch(
            "services.fragments.check_concepts_have_harmony_gate",
            new=AsyncMock(return_value=True),
        ):
            failures = await service._run_approval_gate(fragment)

        assert "unreviewed_harmony_events" not in failures

    @pytest.mark.asyncio
    async def test_harmony_gate_unreviewed_event_in_range_fails(self) -> None:
        """An unreviewed harmony event within the bar range blocks approval."""
        service = self._build_service(
            concept_ids=["PerfectAuthenticCadence"],
            has_harmony_gate=True,
            events=[{"mn": 2, "volta": None, "reviewed": False}],
        )
        fragment = _make_fragment(bar_start=1, bar_end=4)

        with patch(
            "services.fragments.check_concepts_have_harmony_gate",
            new=AsyncMock(return_value=True),
        ):
            failures = await service._run_approval_gate(fragment)

        assert "unreviewed_harmony_events" in failures
        assert len(failures["unreviewed_harmony_events"]) == 1

    @pytest.mark.asyncio
    async def test_harmony_gate_unreviewed_event_outside_range_is_ignored(self) -> None:
        """An unreviewed event outside the fragment's bar range does not block approval."""
        service = self._build_service(
            concept_ids=["PerfectAuthenticCadence"],
            has_harmony_gate=True,
            events=[{"mn": 10, "volta": None, "reviewed": False}],  # mn=10 > bar_end=4
        )
        fragment = _make_fragment(bar_start=1, bar_end=4)

        with patch(
            "services.fragments.check_concepts_have_harmony_gate",
            new=AsyncMock(return_value=True),
        ):
            failures = await service._run_approval_gate(fragment)

        assert "unreviewed_harmony_events" not in failures

    # -- Gate 2: volta filtering --

    @pytest.mark.asyncio
    async def test_volta_filtering_excludes_wrong_ending(self) -> None:
        """Events with a non-matching volta are excluded when repeat_context is set.

        A fragment in the first ending (volta=1) should not be blocked by an
        unreviewed event in the second ending (volta=2) of the same bar.
        """
        service = self._build_service(
            concept_ids=["PerfectAuthenticCadence"],
            has_harmony_gate=True,
            events=[
                {"mn": 2, "volta": 2, "reviewed": False},  # second ending — excluded
            ],
        )
        fragment = _make_fragment(
            bar_start=1,
            bar_end=4,
            repeat_context="first_ending",  # _REPEAT_CONTEXT_TO_VOLTA maps this to 1
        )

        with patch(
            "services.fragments.check_concepts_have_harmony_gate",
            new=AsyncMock(return_value=True),
        ):
            failures = await service._run_approval_gate(fragment)

        assert "unreviewed_harmony_events" not in failures

    @pytest.mark.asyncio
    async def test_volta_filtering_includes_matching_ending(self) -> None:
        """An event with the matching volta IS included in the gate check."""
        service = self._build_service(
            concept_ids=["PerfectAuthenticCadence"],
            has_harmony_gate=True,
            events=[
                {"mn": 2, "volta": 1, "reviewed": False},  # first ending — included
            ],
        )
        fragment = _make_fragment(
            bar_start=1,
            bar_end=4,
            repeat_context="first_ending",
        )

        with patch(
            "services.fragments.check_concepts_have_harmony_gate",
            new=AsyncMock(return_value=True),
        ):
            failures = await service._run_approval_gate(fragment)

        assert "unreviewed_harmony_events" in failures
        assert len(failures["unreviewed_harmony_events"]) == 1

    @pytest.mark.asyncio
    async def test_no_repeat_context_includes_all_volta_values(self) -> None:
        """When the fragment has no repeat_context, volta filtering is disabled
        and all events in range are checked regardless of their volta value."""
        service = self._build_service(
            concept_ids=["PerfectAuthenticCadence"],
            has_harmony_gate=True,
            events=[
                {"mn": 2, "volta": 1, "reviewed": False},
                {"mn": 2, "volta": 2, "reviewed": False},
            ],
        )
        fragment = _make_fragment(
            bar_start=1,
            bar_end=4,
            repeat_context=None,  # no ending context → include all
        )

        with patch(
            "services.fragments.check_concepts_have_harmony_gate",
            new=AsyncMock(return_value=True),
        ):
            failures = await service._run_approval_gate(fragment)

        assert "unreviewed_harmony_events" in failures
        assert len(failures["unreviewed_harmony_events"]) == 2

    # -- Both gates simultaneously --

    @pytest.mark.asyncio
    async def test_both_gates_fail_simultaneously(self) -> None:
        """Gate 1 and gate 2 failures are both reported in the same run."""
        service = self._build_service(
            concept_ids=["PerfectAuthenticCadence"],
            has_harmony_gate=True,
            events=[{"mn": 2, "volta": None, "reviewed": False}],
        )
        fragment = _make_fragment(
            bar_start=1,
            bar_end=4,
            summary=_min_summary(
                actual_key={"value": "G major", "auto": True, "reviewed": False}
            ),
        )

        with patch(
            "services.fragments.check_concepts_have_harmony_gate",
            new=AsyncMock(return_value=True),
        ):
            failures = await service._run_approval_gate(fragment)

        assert "unreviewed_actual_key" in failures
        assert "unreviewed_harmony_events" in failures

    @pytest.mark.asyncio
    async def test_empty_failures_dict_when_all_gates_pass(self) -> None:
        """An empty dict is returned when every gate check passes."""
        service = self._build_service(
            concept_ids=["PerfectAuthenticCadence"],
            has_harmony_gate=True,
            events=[{"mn": 2, "volta": None, "reviewed": True}],
        )
        fragment = _make_fragment(
            bar_start=1,
            bar_end=4,
            summary=_min_summary(
                actual_key={"value": "G major", "auto": True, "reviewed": True}
            ),
        )

        with patch(
            "services.fragments.check_concepts_have_harmony_gate",
            new=AsyncMock(return_value=True),
        ):
            failures = await service._run_approval_gate(fragment)

        assert failures == {}
