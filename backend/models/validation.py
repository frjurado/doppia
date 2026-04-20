"""Pydantic models for MEI validation and normalization reports.

``ValidationReport`` is the return type of ``services.mei_validator.validate_mei``
and the base type extended by ``services.mei_normalizer.normalize_mei``.

Keeping these models in ``models/`` rather than in the service modules means
that the normalizer (Step 4) can import them without circular dependencies.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, computed_field


class ValidationIssue(BaseModel):
    """A single validation finding — either a hard error or an advisory warning.

    Args:
        code: Short identifier matching an ``ErrorCode`` value or a normalizer-
            specific code (e.g. ``"PICKUP_BAR_RENUMBERED"``).
        message: Human-readable description of the issue.
        severity: ``"error"`` causes the file to be rejected; ``"warning"``
            is surfaced in the ingestion report but does not block storage.
        xpath: Optional XPath locating the offending element in the document.
    """

    code: str
    message: str
    severity: Literal["error", "warning"]
    xpath: str | None = None


class ValidationReport(BaseModel):
    """Structured result returned by ``validate_mei`` and ``normalize_mei``.

    ``is_valid`` is a computed property: ``True`` when ``errors`` is empty.
    Callers should check ``is_valid`` rather than inspecting ``errors``
    directly.

    Args:
        errors: Findings that cause the file to be rejected.
        warnings: Findings that are surfaced in the ingestion report but do
            not prevent the file from being stored.
    """

    errors: list[ValidationIssue] = []
    warnings: list[ValidationIssue] = []

    @computed_field  # type: ignore[prop-decorator]
    @property
    def is_valid(self) -> bool:
        """True when no hard errors were found.

        Returns:
            ``True`` if ``errors`` is empty, ``False`` otherwise.
        """
        return len(self.errors) == 0
