"""Pydantic model for the MEI normalizer report.

``NormalizationReport`` is the return type of
``services.mei_normalizer.normalize_mei``.  Kept in ``models/`` so the
service layer and the upload endpoint can both import it without circular
dependencies.
"""

from __future__ import annotations

from pydantic import BaseModel, computed_field


class NormalizationReport(BaseModel):
    """Structured result returned by ``normalize_mei``.

    ``is_clean`` is a computed property: ``True`` when no warnings were
    raised.  Auto-corrections recorded in ``changes_applied`` do *not*
    affect ``is_clean`` — they represent normal, expected transformations.

    Args:
        changes_applied: Human-readable descriptions of each auto-correction
            the normalizer applied to the source file.
        warnings: Issues that were flagged but not auto-corrected because the
            correct repair is editorially ambiguous.
        duration_bars: Maximum integer ``@n`` value found across all
            ``<measure>`` elements in the document (inside and outside
            ``<ending>`` elements).  Stored as ``movement.duration_bars``.
    """

    changes_applied: list[str] = []
    warnings: list[str] = []
    duration_bars: int = 0

    @computed_field  # type: ignore[prop-decorator]
    @property
    def is_clean(self) -> bool:
        """True when no warnings were raised.

        Returns:
            ``True`` if ``warnings`` is empty, ``False`` otherwise.
        """
        return len(self.warnings) == 0
