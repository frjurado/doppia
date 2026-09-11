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

import re
import unicodedata

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


def fold(text: str) -> str:
    """Case- and accent-insensitive form of a display string.

    One folding rule shared by the two places that need one: ordering a
    translated list (``services.concepts._sort_key``) and matching a search term
    against translated text (``TranslationOverlay.search_concept_ids``,
    ADR-040 § 2). They must agree — a name that sorts under "e" and matches
    under "é" would put a result somewhere the reader cannot predict.

    Accents are folded rather than compared: Python's default ordering puts
    every accented character after ``z``, which would file "Época" after
    "Zarzuela". Not full locale collation — that needs ICU — but right for the
    Latin-script names this corpus uses.

    Args:
        text: A display string.

    Returns:
        The string with combining marks stripped and case folded.
    """
    decomposed = unicodedata.normalize("NFD", text)
    return "".join(c for c in decomposed if not unicodedata.combining(c)).casefold()


def tokenize(text: str) -> set[str]:
    """Split a display string into folded word tokens for whole-token matching.

    Mirrors what the Neo4j full-text index does to English text, which is the
    behaviour a merged search has to match: whole tokens, case-insensitive,
    OR across the query's terms — "cadence" finds Perfect Authentic Cadence,
    "caden" finds nothing (measured against the live index, 2026-09-11). A
    substring match here instead would make Spanish quietly more permissive
    than English and give the same typing two different behaviours.

    Accent folding is the one deliberate asymmetry: it makes "autentica" find
    "Auténtica". English names carry no diacritics, so this changes nothing
    there, and requiring a Spanish tagger to type accents to find their own
    vocabulary would be a worse rule than the one it enforces.

    Args:
        text: A name, alias, or query string.

    Returns:
        The set of folded alphanumeric tokens it contains.
    """
    return {t for t in re.split(r"[^0-9a-z]+", fold(text)) if t}
