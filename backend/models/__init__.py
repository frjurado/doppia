# Import all ORM model classes so their tables are registered in Base.metadata
# before SQLAlchemy resolves cross-table FK references.
from models.analysis import MovementAnalysis, ProseChunk
from models.fragment import Fragment, FragmentConceptTag, FragmentReview
from models.moderation import ModerationReport
from models.music import Composer, Corpus, Movement, Work
from models.user import AppUser, UserRole
from models.user_state import (
    ExerciseResult,
    ExerciseSession,
    ExerciseType,
    ReadingHistory,
)

__all__ = [
    "AppUser",
    "Composer",
    "Corpus",
    "ExerciseResult",
    "ExerciseSession",
    "ExerciseType",
    "Fragment",
    "FragmentConceptTag",
    "FragmentReview",
    "ModerationReport",
    "Movement",
    "MovementAnalysis",
    "ProseChunk",
    "ReadingHistory",
    "UserRole",
    "Work",
]
