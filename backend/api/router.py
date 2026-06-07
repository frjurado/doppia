"""Central API router: mounts all sub-routers under the /api/v1 prefix.

All feature routers are registered here. ``main.py`` imports only this
``router`` object — adding a new feature never requires touching ``main.py``.
"""

from __future__ import annotations

from api.routes.admin import router as admin_router
from api.routes.browse import router as browse_router
from api.routes.concepts import router as concepts_router
from api.routes.corpora import router as corpora_router
from api.routes.fragments import router as fragments_router
from api.routes.health import router as health_router
from api.routes.movements import router as movements_router
from api.routes.reviews import router as reviews_router
from fastapi import APIRouter

# Single public router imported by main.py.
router = APIRouter(prefix="/api/v1")

router.include_router(health_router)
router.include_router(corpora_router)
router.include_router(browse_router)
router.include_router(admin_router)
router.include_router(concepts_router)
router.include_router(fragments_router)
router.include_router(movements_router)
router.include_router(reviews_router)
