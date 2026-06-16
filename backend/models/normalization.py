"""Pydantic model for the MEI normalizer report.

``NormalizationReport`` is the return type of
``services.mei_normalizer.normalize_mei``.  Kept in ``models/`` so the
service layer and the upload endpoint can both import it without circular
dependencies.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, computed_field


class NormalizationIssue(BaseModel):
    """A single normalizer finding, carrying a severity so it can be triaged.

    Mirrors ``models.validation.ValidationIssue`` but with no ``"error"``
    severity — the normalizer never rejects a file, it only flags.  The
    severity distinction drives the Component 9 Step 8 warning triage:

    * ``"warning"`` — a genuine, actionable issue (missing ``@n``, an
      unresolvable split-measure complement, a broken ``@join`` reference).
      Surfaced in the ingestion report and persisted to
      ``movement.normalization_warnings``; makes ``is_clean`` ``False``.
    * ``"info"`` — a recognised, accepted encoding pattern that is harmless
      under the dual coordinate system (ADR-015), e.g. DCML ``X``-prefixed
      ``@n`` values or duplicate ``@n`` from a written-out repeat.  Recorded
      for context but does not make ``is_clean`` ``False`` and does not, on
      its own, raise the per-movement attention indicator.

    Args:
        code: Short SCREAMING_SNAKE identifier for the finding family.
        message: Human-readable description of the issue.
        severity: ``"warning"`` (actionable) or ``"info"`` (accepted pattern).
        xpath: Optional XPath locating the offending element in the document.
    """

    code: str
    message: str
    severity: Literal["warning", "info"] = "warning"
    xpath: str | None = None


class NormalizationReport(BaseModel):
    """Structured result returned by ``normalize_mei``.

    ``is_clean`` is a computed property: ``True`` when no ``"warning"``-severity
    issues were raised.  ``"info"``-severity issues (accepted encoding patterns)
    do not affect ``is_clean``, and neither do auto-corrections recorded in
    ``changes_applied`` — both represent normal, expected outcomes.

    Args:
        changes_applied: Human-readable descriptions of each auto-correction
            the normalizer applied to the source file.
        warnings: Findings flagged but not auto-corrected, each with a
            severity (see :class:`NormalizationIssue`).  The field name is
            retained for backwards compatibility with the ingestion report.
        duration_bars: Maximum integer ``@n`` value found across all
            ``<measure>`` elements in the document (inside and outside
            ``<ending>`` elements).  Stored as ``movement.duration_bars``.
    """

    changes_applied: list[str] = []
    warnings: list[NormalizationIssue] = []
    duration_bars: int = 0

    @computed_field  # type: ignore[prop-decorator]
    @property
    def is_clean(self) -> bool:
        """True when no ``"warning"``-severity issues were raised.

        ``"info"``-severity issues are accepted patterns and do not count
        against cleanliness.

        Returns:
            ``True`` if no warning-severity issue is present, ``False`` otherwise.
        """
        return not any(w.severity == "warning" for w in self.warnings)
