"""Language negotiation primitives for the translation overlay (ADR-006).

Phase 1 declares two valid languages, ``{'en', 'es'}``, even though only
English content exists in the translation tables. The overlay and the
``translation_missing`` fallback run for every locale, so introducing Spanish
later (Step 26) is a data change, not a code change.

These functions are pure (``def``, no I/O) and never raise: an unsupported or
malformed language request degrades to :data:`DEFAULT_LANGUAGE` rather than
returning an error, per ADR-006 §6.
"""

from __future__ import annotations

# BCP 47 primary subtags considered valid in Phase 1. English is canonical;
# Spanish is declared now so the API contract is stable before es data lands.
SUPPORTED_LANGUAGES: frozenset[str] = frozenset({"en", "es"})

# The canonical language of record. Returned whenever negotiation finds no
# supported match.
DEFAULT_LANGUAGE: str = "en"


def normalize_language(candidate: str | None) -> str:
    """Return ``candidate`` if it is a supported language, else the default.

    The comparison is case-insensitive and matches on the BCP 47 primary
    subtag only (``es-ES`` → ``es``). Never raises.

    Args:
        candidate: A raw language tag (e.g. from a ``?language=`` query
            parameter), or ``None``.

    Returns:
        A language tag guaranteed to be in :data:`SUPPORTED_LANGUAGES`.
    """
    if not candidate:
        return DEFAULT_LANGUAGE
    primary = candidate.strip().lower().split("-", 1)[0]
    return primary if primary in SUPPORTED_LANGUAGES else DEFAULT_LANGUAGE


def parse_accept_language(header: str | None) -> str:
    """Resolve an ``Accept-Language`` header to a supported language.

    Implements the subset of RFC 7231 §5.3.5 the overlay needs: split on
    commas, read each entry's optional ``;q=`` weight (default ``1.0``),
    match primary subtags against :data:`SUPPORTED_LANGUAGES`, and return the
    highest-weighted supported match. A full quality-value parser is out of
    scope. Never raises.

    Args:
        header: The raw ``Accept-Language`` header value, or ``None``.

    Returns:
        The best supported language, or :data:`DEFAULT_LANGUAGE` if none of
        the requested languages are supported.
    """
    if not header:
        return DEFAULT_LANGUAGE

    best_lang = DEFAULT_LANGUAGE
    best_q = -1.0
    for part in header.split(","):
        token = part.strip()
        if not token:
            continue
        tag, _, params = token.partition(";")
        primary = tag.strip().lower().split("-", 1)[0]
        if primary not in SUPPORTED_LANGUAGES:
            continue
        q = 1.0
        params = params.strip()
        if params.lower().startswith("q="):
            try:
                q = float(params[2:])
            except ValueError:
                q = 0.0
        if q > best_q:
            best_q = q
            best_lang = primary

    return best_lang
