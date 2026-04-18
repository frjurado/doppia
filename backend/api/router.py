"""Central API router: mounts all sub-routers under the /api/v1 prefix.

All feature routers are registered here. ``main.py`` imports only this
``router`` object — adding a new feature never requires touching ``main.py``.
"""

from __future__ import annotations

from fastapi import APIRouter

from api.routes.health import router as health_router

# Single public router imported by main.py.
router = APIRouter(prefix="/api/v1")

router.include_router(health_router)
# Future sub-routers:
# from api.routes.scores import router as scores_router
# router.include_router(scores_router)
