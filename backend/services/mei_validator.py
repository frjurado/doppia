"""MEI file validation pipeline.

Applies five sequential checks to a raw MEI byte string and returns a
structured :class:`~models.validation.ValidationReport`.  Checks 1 and 2
short-circuit on failure (no further checks run).  Checks 3, 4, and 5 are
non-short-circuiting: they all run regardless.  Check 5 produces an error
(not a warning) if no notes or rests exist; the file is still considered
invalid.

Checks (in order):

1. **Well-formed XML** — ``lxml.etree.fromstring``.
2. **MEI RelaxNG schema** — validates against ``backend/resources/mei-CMN.rng``
   (MEI 5.0.0, CMN profile).
3. **Measure-number integrity** — duplicate / non-integer / large-gap ``@n``
   outside ``<ending>`` elements.
4. **Staff-count consistency** — ``<scoreDef>`` stave count vs. staves present
   in every ``<measure>``.
5. **Encoding sanity** — at least one ``<note>`` or ``<rest>`` exists.

The RelaxNG schema is loaded once and cached at module level.

Example usage::

    from services.mei_validator import validate_mei

    report = validate_mei(Path("movement-1.mei").read_bytes())
    if not report.is_valid:
        for err in report.errors:
            print(err.code, err.message)
"""

from __future__ import annotations

from pathlib import Path

import lxml.etree
from models.validation import ValidationIssue, ValidationReport

# ---------------------------------------------------------------------------
# MEI namespace and schema
# ---------------------------------------------------------------------------

_MEI_NS: str = "http://www.music-encoding.org/ns/mei"
_NSMAP: dict[str, str] = {"mei": _MEI_NS}

_SCHEMA_PATH: Path = Path(__file__).parent.parent / "resources" / "mei-CMN.rng"

# Module-level cache — schema is parsed once per process.
_relaxng: lxml.etree.RelaxNG | None = None


def _get_relaxng() -> lxml.etree.RelaxNG:
    """Return the cached MEI RelaxNG schema, loading it on first call.

    Returns:
        A :class:`lxml.etree.RelaxNG` instance ready for validation.

    Raises:
        FileNotFoundError: When ``backend/resources/mei-CMN.rng`` is absent.
        lxml.etree.RelaxNGParseError: When the schema file is malformed.
    """
    global _relaxng
    if _relaxng is None:
        if not _SCHEMA_PATH.exists():
            raise FileNotFoundError(
                f"MEI RelaxNG schema not found at {_SCHEMA_PATH}. "
                "Run: curl -L https://github.com/music-encoding/music-encoding"
                "/releases/download/v5.0/MEI_Schemata_v5.0.zip | unzip -p - "
                "mei-CMN.rng > backend/resources/mei-CMN.rng"
            )
        schema_doc = lxml.etree.parse(str(_SCHEMA_PATH))
        _relaxng = lxml.etree.RelaxNG(schema_doc)
    return _relaxng


# ---------------------------------------------------------------------------
# XPath helper
# ---------------------------------------------------------------------------


def _xpath(elem: lxml.etree._Element, expr: str) -> list[lxml.etree._Element]:
    """Evaluate *expr* against *elem* in the MEI namespace.

    Args:
        elem: The context element for the XPath expression.
        expr: An XPath expression; ``mei:`` prefix refers to the MEI namespace.

    Returns:
        The list of matching elements (may be empty).
    """
    return elem.xpath(expr, namespaces=_NSMAP)  # type: ignore[no-any-return]


def _element_xpath(elem: lxml.etree._Element) -> str:
    """Build a simple XPath string identifying *elem* in its document.

    Args:
        elem: The element to locate.

    Returns:
        A string like ``/mei/music/body/mdiv/score/section/measure[2]``.
    """
    tree = elem.getroottree()
    return tree.getpath(elem)


# ---------------------------------------------------------------------------
# Public interface
# ---------------------------------------------------------------------------


def validate_mei(xml_bytes: bytes) -> ValidationReport:
    """Apply all MEI validation rules and return a structured report.

    Checks run in order and short-circuit on the first hard error (checks 1
    and 2).  Advisory checks (3 and 4) collect all findings before returning.
    Check 5 appends to the error list without short-circuiting so that check
    4 still runs.

    Args:
        xml_bytes: Raw bytes of an MEI file (UTF-8 or declared encoding).

    Returns:
        A :class:`~models.validation.ValidationReport` with ``is_valid``
        reflecting whether any hard errors were found.
    """
    errors: list[ValidationIssue] = []
    warnings: list[ValidationIssue] = []

    # ------------------------------------------------------------------
    # Check 1 — well-formed XML
    # ------------------------------------------------------------------
    try:
        root = lxml.etree.fromstring(xml_bytes)
    except lxml.etree.XMLSyntaxError as exc:
        return ValidationReport(
            errors=[
                ValidationIssue(
                    code="INVALID_XML",
                    message=f"Not well-formed XML: {exc}",
                    severity="error",
                )
            ]
        )

    # ------------------------------------------------------------------
    # Check 2 — MEI RelaxNG schema
    # ------------------------------------------------------------------
    relaxng = _get_relaxng()
    if not relaxng.validate(root):
        first = relaxng.error_log[0]
        return ValidationReport(
            errors=[
                ValidationIssue(
                    code="SCHEMA_VIOLATION",
                    message=first.message,
                    severity="error",
                    xpath=first.path or None,
                )
            ]
        )

    # ------------------------------------------------------------------
    # Check 3 — measure-number integrity (outside <ending> elements)
    # ------------------------------------------------------------------
    bare_measures: list[lxml.etree._Element] = _xpath(
        root, "//mei:measure[not(ancestor::mei:ending)]"
    )

    valid_ns: list[int] = []
    seen_ns: dict[int, bool] = {}  # n -> already_warned_duplicate

    for measure in bare_measures:
        n_str: str | None = measure.get("n")
        xp = _element_xpath(measure)

        if n_str is None:
            warnings.append(
                ValidationIssue(
                    code="MEASURE_NUMBER_ERROR",
                    message="<measure> outside <ending> is missing @n.",
                    severity="warning",
                    xpath=xp,
                )
            )
            continue

        try:
            n_int = int(n_str)
        except ValueError:
            warnings.append(
                ValidationIssue(
                    code="MEASURE_NUMBER_ERROR",
                    message=(
                        f"<measure> outside <ending> has non-integer @n={n_str!r}."
                    ),
                    severity="warning",
                    xpath=xp,
                )
            )
            continue

        if n_int in seen_ns and not seen_ns[n_int]:
            warnings.append(
                ValidationIssue(
                    code="MEASURE_NUMBER_ERROR",
                    message=f"Duplicate @n={n_int} on <measure> outside <ending>.",
                    severity="warning",
                    xpath=xp,
                )
            )
            seen_ns[n_int] = True  # only warn once per duplicate value
        elif n_int not in seen_ns:
            seen_ns[n_int] = False
            valid_ns.append(n_int)

    # Check for gaps > 10 in the sorted sequence of valid @n values.
    if len(valid_ns) >= 2:
        sorted_ns = sorted(valid_ns)
        for prev, curr in zip(sorted_ns, sorted_ns[1:]):
            gap = curr - prev
            if gap > 10:
                warnings.append(
                    ValidationIssue(
                        code="MEASURE_NUMBER_ERROR",
                        message=(
                            f"Gap of {gap} in measure @n sequence "
                            f"(from {prev} to {curr})."
                        ),
                        severity="warning",
                    )
                )

    # ------------------------------------------------------------------
    # Check 4 — staff-count consistency
    # ------------------------------------------------------------------
    score_defs: list[lxml.etree._Element] = _xpath(root, "//mei:scoreDef")
    if score_defs:
        expected_staves = len(_xpath(score_defs[0], ".//mei:staffDef"))
        if expected_staves > 0:
            all_measures: list[lxml.etree._Element] = _xpath(root, "//mei:measure")
            for measure in all_measures:
                actual = len(_xpath(measure, "mei:staff"))
                if actual != expected_staves:
                    warnings.append(
                        ValidationIssue(
                            code="STAFF_COUNT_MISMATCH",
                            message=(
                                f"<measure> has {actual} <staff> child(ren) "
                                f"but <scoreDef> declares {expected_staves}."
                            ),
                            severity="warning",
                            xpath=_element_xpath(measure),
                        )
                    )

    # ------------------------------------------------------------------
    # Check 5 — encoding sanity (at least one note or rest)
    # ------------------------------------------------------------------
    notes_and_rests = _xpath(root, "//mei:note | //mei:rest")
    if not notes_and_rests:
        errors.append(
            ValidationIssue(
                code="ENCODING_EMPTY",
                message="No <note> or <rest> elements found in the document.",
                severity="error",
            )
        )

    return ValidationReport(errors=errors, warnings=warnings)
