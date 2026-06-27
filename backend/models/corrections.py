"""Pydantic models for the MEI source-corrections overlay (ADR-027).

A *corrections overlay* is a versioned, attributed list of known errors in the
source data (DCML/MuseScore export), applied by ``mei_normalizer`` Pass 0 before
the structural normalization passes run.  These models describe one overlay
entry; loading and per-movement filtering live in
``services.corrections_overlay``, and the application logic lives in
``services.mei_normalizer._apply_corrections_overlay``.

The overlay is *data*: growing the list of corrections never touches normalizer
logic.  Each entry carries its pre-state (``expected``) so the normalizer applies
the correction only when it still sees the wrong value — making the pass
idempotent and safe when an upstream fix is later merged (ADR-027 §3).
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class CorrectionTarget(BaseModel):
    """A stable locator for the MEI element a correction applies to.

    Args:
        xml_id: The ``xml:id`` of the affected element (a ``<note>`` or
            ``<measure>``).  This is the authoritative locator the normalizer
            resolves against; it is stable per movement and unaffected by
            measure renumbering or ADR-015 ``mc`` coordinates.
        fallback: A human-readable ``(mc, staff, layer, beat, pname, oct)``
            description, advisory only — used by a reviewer when an ``xml_id``
            drifts after an upstream re-encode.  Never resolved mechanically.
    """

    model_config = ConfigDict(extra="forbid")

    xml_id: str = Field(min_length=1)
    fallback: str | None = None


class Correction(BaseModel):
    """One entry in a corrections overlay (ADR-027 §2).

    A correction names a target element, the ``field`` being corrected, the
    current wrong value (``expected``), and the value to write (``corrected``).
    The normalizer applies it only when the element still holds ``expected``;
    if it already holds ``corrected`` the correction is superseded (a no-op),
    and if it holds neither the correction is skipped and flagged for review.

    Args:
        movement: ``{work_slug}/{movement_slug}`` — the scope key the loader
            filters on.
        target: The :class:`CorrectionTarget` locating the affected element.
        field: What is being corrected (e.g. ``"accid"``, ``"accid.ges"``,
            ``"repeat-start"``, ``"repeat-end"``).
        expected: The current wrong value in the source (the pre-state).
            ``None`` means the attribute is currently absent.
        corrected: The value to write.  ``None`` means remove the attribute.
        rationale: Why this is an error, citing the reference edition.
        correction_class: ``"errata"`` (objective error vs. a reference edition,
            PR-worthy upstream) or ``"editorial"`` (a defensible variant we
            prefer, kept local).  Serialised under the YAML key ``class``.
        upstream: Upstream-PR status: ``"none"`` / ``"submitted"`` / ``"merged"``
            / ``"superseded"``.
        source_sha: The DCML source git SHA this entry was authored against.
        added: Date + author, e.g. ``"2026-06-28 Francisco"``.
    """

    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    movement: str = Field(min_length=1)
    target: CorrectionTarget
    field: str = Field(min_length=1)
    expected: str | None = None
    corrected: str | None = None
    rationale: str = Field(min_length=1)
    correction_class: Literal["errata", "editorial"] = Field(alias="class")
    upstream: str = "none"
    source_sha: str = Field(min_length=1)
    added: str = Field(min_length=1)

    @model_validator(mode="after")
    def _expected_differs_from_corrected(self) -> Correction:
        """Reject a no-op correction (``expected`` equal to ``corrected``).

        Returns:
            The validated model.

        Raises:
            ValueError: If ``expected`` and ``corrected`` are equal — such an
                entry would change nothing and is almost certainly a mistake.
        """
        if self.expected == self.corrected:
            raise ValueError(
                "Correction is a no-op: 'expected' equals 'corrected' "
                f"({self.expected!r}). A correction must change something."
            )
        return self
