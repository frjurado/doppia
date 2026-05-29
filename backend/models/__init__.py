# Import all ORM model classes so their tables are registered in Base.metadata
# before SQLAlchemy resolves cross-table FK references.
from models.analysis import MovementAnalysis, ProseChunk
from models.fragment import Fragment, FragmentConceptTag, FragmentReview
from models.music import Composer, Corpus, Movement, Work
from models.user import AppUser

__all__ = [
    "AppUser",
    "Composer",
    "Corpus",
    "Fragment",
    "FragmentConceptTag",
    "FragmentReview",
    "Movement",
    "MovementAnalysis",
    "ProseChunk",
    "Work",
]
