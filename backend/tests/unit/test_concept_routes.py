"""Unit tests for backend/api/routes/concepts.py.

Exercises the concept search and schema-tree endpoints through the full
FastAPI stack — middleware, dependency injection, route handler, response
serialisation — without any running Neo4j instance.

The ``ConceptService`` is stubbed by overriding the ``get_concept_service``
dependency so tests control the data returned without touching the graph.

Test structure
--------------
TestConceptSearch        — GET /api/v1/concepts/search
TestConceptSearchAuth    — 401/403 enforcement
TestConceptSearchCursor  — cursor pagination behaviour
TestConceptSchemas       — GET /api/v1/concepts/{id}/schemas
TestConceptSchemasAuth   — 401/403 enforcement on schema-tree endpoint
TestConceptServiceSchemaTree — service-layer helpers (_compute_type_refinement, _build_schema_item)
"""

from __future__ import annotations

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from typing import Any
from unittest.mock import AsyncMock

import pytest
import pytest_asyncio
from fastapi import FastAPI, HTTPException, status
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from httpx import ASGITransport, AsyncClient
from starlette.exceptions import HTTPException as StarletteHTTPException

# ---------------------------------------------------------------------------
# Shared test app builder
# ---------------------------------------------------------------------------


@asynccontextmanager
async def _noop_lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    yield


def _build_app() -> FastAPI:
    """Build a minimal FastAPI test app with the full exception-handler stack."""
    from api.middleware.auth import AuthMiddleware
    from api.middleware.errors import (
        doppia_error_handler,
        http_exception_handler,
        unhandled_exception_handler,
        validation_exception_handler,
    )
    from api.router import router as api_router
    from errors import DoppiaError

    app = FastAPI(lifespan=_noop_lifespan)
    app.add_exception_handler(DoppiaError, doppia_error_handler)
    app.add_exception_handler(StarletteHTTPException, http_exception_handler)
    app.add_exception_handler(RequestValidationError, validation_exception_handler)
    app.add_exception_handler(Exception, unhandled_exception_handler)
    app.add_middleware(AuthMiddleware)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:5173"],
        allow_credentials=True,
        allow_methods=["GET"],
        allow_headers=["Authorization", "Content-Type"],
    )
    app.include_router(api_router)
    return app


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest_asyncio.fixture
async def concept_client() -> AsyncGenerator[tuple[AsyncClient, Any], None]:
    """Authenticated async client with the ConceptService stubbed.

    Yields:
        ``(client, mock_service)`` where ``mock_service`` is an ``AsyncMock``
        whose ``search`` return value can be set per-test.
    """
    from api.dependencies import get_current_user
    from api.routes.concepts import get_concept_service
    from models.concepts import ConceptSearchResponse
    from services.concepts import ConceptService

    app = _build_app()
    mock_service = AsyncMock(spec=ConceptService)
    mock_service.search.return_value = ConceptSearchResponse(items=[], next_cursor=None)

    dev_user_obj = __import__("api.dependencies", fromlist=["AppUser"]).AppUser(
        id="test-user", role="editor", email="test@example.com"
    )

    app.dependency_overrides[get_concept_service] = lambda: mock_service
    app.dependency_overrides[get_current_user] = lambda: dev_user_obj

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        yield client, mock_service


@pytest_asyncio.fixture
async def anon_concept_client() -> AsyncGenerator[AsyncClient, None]:
    """Anonymous async client — every authenticated route returns 401."""
    from api.dependencies import get_current_user
    from api.routes.concepts import get_concept_service
    from services.concepts import ConceptService

    app = _build_app()
    mock_service = AsyncMock(spec=ConceptService)

    def _raise_401() -> None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    app.dependency_overrides[get_concept_service] = lambda: mock_service
    app.dependency_overrides[get_current_user] = _raise_401

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        yield client


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _pac_item(**overrides: Any) -> dict[str, Any]:
    """A PAC-shaped ConceptSearchItem dict."""
    return {
        "id": overrides.get("id", "PerfectAuthenticCadence"),
        "name": overrides.get("name", "Perfect Authentic Cadence"),
        "aliases": overrides.get("aliases", ["PAC"]),
        "hierarchy_path": overrides.get(
            "hierarchy_path",
            ["Cadence", "Authentic Cadence", "Perfect Authentic Cadence"],
        ),
        "definition": overrides.get(
            "definition", "A cadence ending on root-position tonic."
        ),
    }


# ---------------------------------------------------------------------------
# TestConceptSearch
# ---------------------------------------------------------------------------


class TestConceptSearch:
    """GET /api/v1/concepts/search — happy-path and filter behaviour."""

    @pytest.mark.asyncio
    async def test_returns_200_with_items(
        self, concept_client: tuple[AsyncClient, Any]
    ) -> None:
        """A well-formed search query returns HTTP 200 with an ``items`` list."""
        from models.concepts import ConceptSearchItem, ConceptSearchResponse

        client, mock_service = concept_client
        mock_service.search.return_value = ConceptSearchResponse(
            items=[ConceptSearchItem(**_pac_item())],
            next_cursor=None,
        )

        resp = await client.get("/api/v1/concepts/search?q=perfect+authentic")

        assert resp.status_code == 200
        body = resp.json()
        assert body["items"][0]["id"] == "PerfectAuthenticCadence"
        assert body["next_cursor"] is None

    @pytest.mark.asyncio
    async def test_pac_ranked_first(
        self, concept_client: tuple[AsyncClient, Any]
    ) -> None:
        """When multiple hits are returned, the highest-score item is first."""
        from models.concepts import ConceptSearchItem, ConceptSearchResponse

        client, mock_service = concept_client
        iac_item = _pac_item(
            id="ImperfectAuthenticCadence",
            name="Imperfect Authentic Cadence",
            aliases=["IAC"],
            hierarchy_path=[
                "Cadence",
                "Authentic Cadence",
                "Imperfect Authentic Cadence",
            ],
        )
        mock_service.search.return_value = ConceptSearchResponse(
            items=[
                ConceptSearchItem(**_pac_item()),
                ConceptSearchItem(**iac_item),
            ],
            next_cursor=None,
        )

        resp = await client.get("/api/v1/concepts/search?q=authentic")

        assert resp.status_code == 200
        items = resp.json()["items"]
        assert items[0]["id"] == "PerfectAuthenticCadence"

    @pytest.mark.asyncio
    async def test_service_called_with_correct_params(
        self, concept_client: tuple[AsyncClient, Any]
    ) -> None:
        """Route passes q, domain, and cursor through to the service unchanged."""
        client, mock_service = concept_client

        await client.get("/api/v1/concepts/search?q=PAC&domain=cadences&cursor=abc123")

        mock_service.search.assert_awaited_once_with(
            q="PAC", domain="cadences", cursor="abc123", language="en"
        )

    @pytest.mark.asyncio
    async def test_domain_filter_forwarded(
        self, concept_client: tuple[AsyncClient, Any]
    ) -> None:
        """``domain=cadences`` is forwarded to the service; no items means empty list."""
        client, mock_service = concept_client

        resp = await client.get("/api/v1/concepts/search?q=cadence&domain=cadences")

        assert resp.status_code == 200
        _, kwargs = mock_service.search.call_args
        assert kwargs["domain"] == "cadences"

    @pytest.mark.asyncio
    async def test_empty_result_returns_empty_items(
        self, concept_client: tuple[AsyncClient, Any]
    ) -> None:
        """A search with no matches returns ``items: []`` and ``next_cursor: null``."""
        from models.concepts import ConceptSearchResponse

        client, mock_service = concept_client
        mock_service.search.return_value = ConceptSearchResponse(
            items=[], next_cursor=None
        )

        resp = await client.get("/api/v1/concepts/search?q=xyzzyfoobarbaz")

        assert resp.status_code == 200
        body = resp.json()
        assert body["items"] == []
        assert body["next_cursor"] is None

    @pytest.mark.asyncio
    async def test_missing_q_returns_422(
        self, concept_client: tuple[AsyncClient, Any]
    ) -> None:
        """``q`` is required; omitting it returns 422."""
        client, _ = concept_client

        resp = await client.get("/api/v1/concepts/search")

        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_empty_q_returns_422(
        self, concept_client: tuple[AsyncClient, Any]
    ) -> None:
        """An empty ``q`` violates the ``min_length=1`` constraint → 422."""
        client, _ = concept_client

        resp = await client.get("/api/v1/concepts/search?q=")

        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_response_includes_hierarchy_path(
        self, concept_client: tuple[AsyncClient, Any]
    ) -> None:
        """The ``hierarchy_path`` field is present in each item."""
        from models.concepts import ConceptSearchItem, ConceptSearchResponse

        client, mock_service = concept_client
        mock_service.search.return_value = ConceptSearchResponse(
            items=[ConceptSearchItem(**_pac_item())],
            next_cursor=None,
        )

        resp = await client.get("/api/v1/concepts/search?q=PAC")

        item = resp.json()["items"][0]
        assert item["hierarchy_path"] == [
            "Cadence",
            "Authentic Cadence",
            "Perfect Authentic Cadence",
        ]
        assert item["aliases"] == ["PAC"]


# ---------------------------------------------------------------------------
# TestConceptSearchAuth
# ---------------------------------------------------------------------------


class TestConceptSearchAuth:
    """Authentication and authorisation enforcement."""

    @pytest.mark.asyncio
    async def test_anonymous_returns_401(
        self, anon_concept_client: AsyncClient
    ) -> None:
        """An unauthenticated request returns HTTP 401."""
        resp = await anon_concept_client.get("/api/v1/concepts/search?q=cadence")

        assert resp.status_code == 401

    @pytest.mark.asyncio
    async def test_editor_role_is_accepted(
        self, concept_client: tuple[AsyncClient, Any]
    ) -> None:
        """A user with the ``editor`` role can access the endpoint."""
        client, _ = concept_client

        resp = await client.get("/api/v1/concepts/search?q=cadence")

        assert resp.status_code == 200


# ---------------------------------------------------------------------------
# TestConceptSearchCursor
# ---------------------------------------------------------------------------


class TestConceptSearchCursor:
    """Cursor pagination: ``next_cursor`` presence and forwarding."""

    @pytest.mark.asyncio
    async def test_next_cursor_present_when_more_results(
        self, concept_client: tuple[AsyncClient, Any]
    ) -> None:
        """When the service returns a ``next_cursor`` the route includes it."""
        from models.concepts import ConceptSearchItem, ConceptSearchResponse

        client, mock_service = concept_client
        mock_service.search.return_value = ConceptSearchResponse(
            items=[ConceptSearchItem(**_pac_item())],
            next_cursor="eyJza2lwIjogMjB9",
        )

        resp = await client.get("/api/v1/concepts/search?q=cadence")

        assert resp.json()["next_cursor"] == "eyJza2lwIjogMjB9"

    @pytest.mark.asyncio
    async def test_cursor_forwarded_to_service(
        self, concept_client: tuple[AsyncClient, Any]
    ) -> None:
        """The ``cursor`` query param is forwarded to the service as-is."""
        client, mock_service = concept_client

        await client.get("/api/v1/concepts/search?q=cadence&cursor=eyJza2lwIjogMjB9")

        _, kwargs = mock_service.search.call_args
        assert kwargs["cursor"] == "eyJza2lwIjogMjB9"


# ---------------------------------------------------------------------------
# TestConceptServiceCursor (service-layer unit tests, no HTTP)
# ---------------------------------------------------------------------------


class TestConceptServiceCursor:
    """Cursor encode/decode round-trips (pure unit, no HTTP stack needed)."""

    def test_encode_decode_round_trip(self) -> None:
        """Encoding an offset and decoding it returns the original offset."""
        from services.concepts import _decode_cursor, _encode_cursor

        for skip in (0, 20, 100, 999):
            assert _decode_cursor(_encode_cursor(skip)) == skip

    def test_decode_none_returns_zero(self) -> None:
        """Passing ``None`` as a cursor returns skip=0 (first page)."""
        from services.concepts import _decode_cursor

        assert _decode_cursor(None) == 0

    def test_decode_malformed_cursor_returns_zero(self) -> None:
        """A malformed cursor token silently falls back to skip=0."""
        from services.concepts import _decode_cursor

        assert _decode_cursor("not-valid-base64!!!") == 0
        assert _decode_cursor("e30=") == 0  # valid base64 but missing "skip" key

    def test_negative_skip_clamped_to_zero(self) -> None:
        """A cursor encoding a negative skip is clamped to 0."""
        import base64
        import json

        from services.concepts import _decode_cursor

        bad_cursor = base64.urlsafe_b64encode(
            json.dumps({"skip": -5}).encode()
        ).decode()
        assert _decode_cursor(bad_cursor) == 0


# ---------------------------------------------------------------------------
# Helpers for schema-tree tests
# ---------------------------------------------------------------------------


def _pac_schema_tree(**overrides: Any) -> dict[str, Any]:
    """A minimal PAC schema-tree response fixture."""
    return {
        "concept_id": overrides.get("concept_id", "PerfectAuthenticCadence"),
        "schemas": overrides.get(
            "schemas",
            [
                {
                    "id": "CadenceFunction",
                    "name": "Cadence Function",
                    "description": "The functional weight of the cadence.",
                    "cardinality": "ONE_OF",
                    "required": True,
                    "values": [
                        {
                            "id": "Independent",
                            "name": "Independent",
                            "referenced_concept": None,
                        }
                    ],
                },
                {
                    "id": "ECP",
                    "name": "Expanded Cadential Progression",
                    "description": "True when the cadence features an ECP.",
                    "cardinality": "BOOL",
                    "required": False,
                    "values": [],
                },
            ],
        ),
        "stages": overrides.get(
            "stages",
            [
                {
                    "target_id": "CadentialInitialTonic",
                    "target_name": "Cadential Initial Tonic",
                    "order": 1,
                    "required": False,
                    "display_mode": "stage",
                    "containment_mode": "contiguous",
                    "default_weight": 1.0,
                },
                {
                    "target_id": "CadentialPreDominant",
                    "target_name": "Cadential Pre-Dominant",
                    "order": 2,
                    "required": False,
                    "display_mode": "stage",
                    "containment_mode": "contiguous",
                    "default_weight": 1.0,
                },
                {
                    "target_id": "CadentialDominant",
                    "target_name": "Cadential Dominant",
                    "order": 3,
                    "required": False,
                    "display_mode": "stage",
                    "containment_mode": "contiguous",
                    "default_weight": 1.0,
                },
                {
                    "target_id": "CadentialFinalTonic",
                    "target_name": "Cadential Final Tonic",
                    "order": 4,
                    "required": False,
                    "display_mode": "stage",
                    "containment_mode": "contiguous",
                    "default_weight": 1.0,
                },
            ],
        ),
        "type_refinement": overrides.get(
            "type_refinement", {"show": False, "children": []}
        ),
    }


# ---------------------------------------------------------------------------
# TestConceptSchemas
# ---------------------------------------------------------------------------


class TestConceptSchemas:
    """GET /api/v1/concepts/{concept_id}/schemas — happy-path and shape."""

    @pytest.mark.asyncio
    async def test_returns_200_with_full_tree(
        self, concept_client: tuple[AsyncClient, Any]
    ) -> None:
        """A valid concept id returns HTTP 200 with schemas, stages, type_refinement."""
        from models.concepts import ConceptSchemaTreeResponse

        client, mock_service = concept_client
        mock_service.get_schema_tree.return_value = ConceptSchemaTreeResponse(
            **_pac_schema_tree()
        )

        resp = await client.get("/api/v1/concepts/PerfectAuthenticCadence/schemas")

        assert resp.status_code == 200
        body = resp.json()
        assert body["concept_id"] == "PerfectAuthenticCadence"
        assert len(body["schemas"]) == 2
        assert len(body["stages"]) == 4
        assert body["type_refinement"]["show"] is False

    @pytest.mark.asyncio
    async def test_bool_schema_has_empty_values_list(
        self, concept_client: tuple[AsyncClient, Any]
    ) -> None:
        """BOOL schemas carry an empty values list in the response."""
        from models.concepts import ConceptSchemaTreeResponse

        client, mock_service = concept_client
        mock_service.get_schema_tree.return_value = ConceptSchemaTreeResponse(
            **_pac_schema_tree()
        )

        resp = await client.get("/api/v1/concepts/PerfectAuthenticCadence/schemas")

        schemas = resp.json()["schemas"]
        ecp = next(s for s in schemas if s["id"] == "ECP")
        assert ecp["cardinality"] == "BOOL"
        assert ecp["values"] == []

    @pytest.mark.asyncio
    async def test_stages_ordered_by_order_field(
        self, concept_client: tuple[AsyncClient, Any]
    ) -> None:
        """Stages are returned in order ascending."""
        from models.concepts import ConceptSchemaTreeResponse

        client, mock_service = concept_client
        mock_service.get_schema_tree.return_value = ConceptSchemaTreeResponse(
            **_pac_schema_tree()
        )

        resp = await client.get("/api/v1/concepts/PerfectAuthenticCadence/schemas")

        orders = [s["order"] for s in resp.json()["stages"]]
        assert orders == sorted(orders)

    @pytest.mark.asyncio
    async def test_stage_contains_edge_properties(
        self, concept_client: tuple[AsyncClient, Any]
    ) -> None:
        """Each stage carries display_mode, containment_mode, and default_weight."""
        from models.concepts import ConceptSchemaTreeResponse

        client, mock_service = concept_client
        mock_service.get_schema_tree.return_value = ConceptSchemaTreeResponse(
            **_pac_schema_tree()
        )

        resp = await client.get("/api/v1/concepts/PerfectAuthenticCadence/schemas")

        stage = resp.json()["stages"][0]
        assert stage["display_mode"] == "stage"
        assert stage["containment_mode"] == "contiguous"
        assert stage["default_weight"] == 1.0

    @pytest.mark.asyncio
    async def test_value_with_referenced_concept(
        self, concept_client: tuple[AsyncClient, Any]
    ) -> None:
        """A value carrying a VALUE_REFERENCES edge includes the referenced concept."""
        from models.concepts import (
            ConceptSchemaTreeResponse,
            PropertySchemaItem,
            PropertyValueItem,
            ReferencedConcept,
            TypeRefinement,
        )

        client, mock_service = concept_client
        mock_service.get_schema_tree.return_value = ConceptSchemaTreeResponse(
            concept_id="PerfectAuthenticCadence",
            schemas=[
                PropertySchemaItem(
                    id="PhraseClosure",
                    name="Phrase Closure",
                    cardinality="MANY_OF",
                    required=False,
                    values=[
                        PropertyValueItem(
                            id="ClosesSentence",
                            name="Closes a Sentence",
                            referenced_concept=ReferencedConcept(
                                id="Sentence",
                                name="Sentence",
                                definition="A phrase type with a continuation phrase.",
                            ),
                        )
                    ],
                )
            ],
            stages=[],
            type_refinement=TypeRefinement(show=False),
        )

        resp = await client.get("/api/v1/concepts/PerfectAuthenticCadence/schemas")

        value = resp.json()["schemas"][0]["values"][0]
        assert value["id"] == "ClosesSentence"
        assert value["referenced_concept"]["id"] == "Sentence"
        assert value["referenced_concept"]["name"] == "Sentence"

    @pytest.mark.asyncio
    async def test_type_refinement_show_true_includes_children(
        self, concept_client: tuple[AsyncClient, Any]
    ) -> None:
        """When type_refinement.show is True, children are populated."""
        from models.concepts import (
            ConceptSchemaTreeResponse,
            TypeRefinement,
            TypeRefinementChild,
        )

        client, mock_service = concept_client
        mock_service.get_schema_tree.return_value = ConceptSchemaTreeResponse(
            **_pac_schema_tree(
                type_refinement=TypeRefinement(
                    show=True,
                    children=[
                        TypeRefinementChild(
                            id="PerfectAuthenticCadence",
                            name="Perfect Authentic Cadence",
                        ),
                        TypeRefinementChild(
                            id="ImperfectAuthenticCadence",
                            name="Imperfect Authentic Cadence",
                        ),
                    ],
                )
            )
        )

        resp = await client.get("/api/v1/concepts/AuthenticCadenceRealised/schemas")

        tr = resp.json()["type_refinement"]
        assert tr["show"] is True
        assert len(tr["children"]) == 2
        ids = {c["id"] for c in tr["children"]}
        assert "PerfectAuthenticCadence" in ids
        assert "ImperfectAuthenticCadence" in ids

    @pytest.mark.asyncio
    async def test_stageless_concept_returns_empty_stages(
        self, concept_client: tuple[AsyncClient, Any]
    ) -> None:
        """A concept with no CONTAINS edges returns stages=[]."""
        from models.concepts import ConceptSchemaTreeResponse, TypeRefinement

        client, mock_service = concept_client
        mock_service.get_schema_tree.return_value = ConceptSchemaTreeResponse(
            concept_id="HalfCadenceRealised",
            schemas=[],
            stages=[],
            type_refinement=TypeRefinement(show=False),
        )

        resp = await client.get("/api/v1/concepts/HalfCadenceRealised/schemas")

        assert resp.status_code == 200
        assert resp.json()["stages"] == []

    @pytest.mark.asyncio
    async def test_unknown_concept_returns_404(
        self, concept_client: tuple[AsyncClient, Any]
    ) -> None:
        """A concept id not found in the graph raises 404."""
        from errors import ConceptNotFoundError

        client, mock_service = concept_client
        mock_service.get_schema_tree.side_effect = ConceptNotFoundError(
            "Concept 'NoSuchConcept' not found.",
            detail={"concept_id": "NoSuchConcept"},
        )

        resp = await client.get("/api/v1/concepts/NoSuchConcept/schemas")

        assert resp.status_code == 404
        body = resp.json()
        assert body["error"]["code"] == "CONCEPT_NOT_FOUND"

    @pytest.mark.asyncio
    async def test_service_called_with_concept_id(
        self, concept_client: tuple[AsyncClient, Any]
    ) -> None:
        """The route passes concept_id to get_schema_tree unchanged."""
        from models.concepts import ConceptSchemaTreeResponse, TypeRefinement

        client, mock_service = concept_client
        mock_service.get_schema_tree.return_value = ConceptSchemaTreeResponse(
            concept_id="PerfectAuthenticCadence",
            schemas=[],
            stages=[],
            type_refinement=TypeRefinement(show=False),
        )

        await client.get("/api/v1/concepts/PerfectAuthenticCadence/schemas")

        mock_service.get_schema_tree.assert_awaited_once_with(
            "PerfectAuthenticCadence", language="en"
        )


# ---------------------------------------------------------------------------
# TestConceptSchemasAuth
# ---------------------------------------------------------------------------


class TestConceptSchemasAuth:
    """Authentication enforcement on the schema-tree endpoint."""

    @pytest.mark.asyncio
    async def test_anonymous_returns_401(
        self, anon_concept_client: AsyncClient
    ) -> None:
        """An unauthenticated request returns HTTP 401."""
        resp = await anon_concept_client.get(
            "/api/v1/concepts/PerfectAuthenticCadence/schemas"
        )

        assert resp.status_code == 401

    @pytest.mark.asyncio
    async def test_editor_role_is_accepted(
        self, concept_client: tuple[AsyncClient, Any]
    ) -> None:
        """A user with the ``editor`` role can access the endpoint."""
        from models.concepts import ConceptSchemaTreeResponse, TypeRefinement

        client, mock_service = concept_client
        mock_service.get_schema_tree.return_value = ConceptSchemaTreeResponse(
            concept_id="PerfectAuthenticCadence",
            schemas=[],
            stages=[],
            type_refinement=TypeRefinement(show=False),
        )

        resp = await client.get("/api/v1/concepts/PerfectAuthenticCadence/schemas")

        assert resp.status_code == 200


# ---------------------------------------------------------------------------
# TestConceptServiceSchemaTree (service-layer unit tests, no HTTP)
# ---------------------------------------------------------------------------


class TestConceptServiceSchemaTree:
    """Pure-unit tests for _compute_type_refinement and _build_schema_item."""

    def test_no_children_returns_show_false(self) -> None:
        """Empty children list → show=False, no children."""
        from services.concepts import _compute_type_refinement

        result = _compute_type_refinement([], "en", {})
        assert result.show is False
        assert result.children == []

    def test_single_child_returns_show_false(self) -> None:
        """One child → show=False (no choice to make)."""
        from services.concepts import _compute_type_refinement

        rows = [
            {
                "child_id": "PAC",
                "child_name": "Perfect Authentic Cadence",
                "child_definition": None,
                "fingerprint": ["CadentialDominant|3"],
            }
        ]
        result = _compute_type_refinement(rows, "en", {})
        assert result.show is False

    def test_identical_fingerprints_returns_show_false(self) -> None:
        """Two children with the same CONTAINS fingerprint → show=False."""
        from services.concepts import _compute_type_refinement

        fingerprint = ["Stage1|1", "Stage2|2"]
        rows = [
            {
                "child_id": "ChildA",
                "child_name": "Child A",
                "child_definition": None,
                "fingerprint": fingerprint,
            },
            {
                "child_id": "ChildB",
                "child_name": "Child B",
                "child_definition": None,
                "fingerprint": fingerprint,
            },
        ]
        result = _compute_type_refinement(rows, "en", {})
        assert result.show is False

    def test_differing_fingerprints_returns_show_true_with_children(self) -> None:
        """Two children with different CONTAINS fingerprints → show=True + both children."""
        from services.concepts import _compute_type_refinement

        rows = [
            {
                "child_id": "ChildA",
                "child_name": "Child A",
                "child_definition": "Definition A",
                "fingerprint": ["StageX|1", "StageY|2"],
            },
            {
                "child_id": "ChildB",
                "child_name": "Child B",
                "child_definition": "Definition B",
                "fingerprint": ["StageX|1", "StageZ|2"],
            },
        ]
        result = _compute_type_refinement(rows, "en", {})
        assert result.show is True
        assert len(result.children) == 2
        assert {c.id for c in result.children} == {"ChildA", "ChildB"}

    def test_fingerprint_comparison_is_order_independent(self) -> None:
        """Fingerprint sets with same elements in different order are treated as equal."""
        from services.concepts import _compute_type_refinement

        rows = [
            {
                "child_id": "ChildA",
                "child_name": "Child A",
                "child_definition": None,
                "fingerprint": ["Stage1|1", "Stage2|2"],
            },
            {
                "child_id": "ChildB",
                "child_name": "Child B",
                "child_definition": None,
                "fingerprint": ["Stage2|2", "Stage1|1"],
            },
        ]
        result = _compute_type_refinement(rows, "en", {})
        assert result.show is False

    def test_build_schema_item_bool_has_empty_values(self) -> None:
        """A BOOL schema row produces a PropertySchemaItem with values=[]."""
        from services.concepts import _build_schema_item

        row = {
            "schema_id": "ECP",
            "schema_name": "Expanded Cadential Progression",
            "schema_description": "True when an ECP is present.",
            "cardinality": "BOOL",
            "required": False,
            "values": [],
        }
        item = _build_schema_item(row, "en", {}, {}, {})
        assert item.id == "ECP"
        assert item.cardinality == "BOOL"
        assert item.values == []

    def test_build_schema_item_with_referenced_concept(self) -> None:
        """A value row with a VALUE_REFERENCES entry builds a ReferencedConcept."""
        from services.concepts import _build_schema_item

        row = {
            "schema_id": "PhraseClosure",
            "schema_name": "Phrase Closure",
            "schema_description": None,
            "cardinality": "MANY_OF",
            "required": False,
            "values": [
                {
                    "id": "ClosesSentence",
                    "name": "Closes a Sentence",
                    "referenced_concept_id": "Sentence",
                    "referenced_concept_name": "Sentence",
                    "referenced_concept_definition": "A phrase type.",
                }
            ],
        }
        item = _build_schema_item(row, "en", {}, {}, {})
        assert len(item.values) == 1
        value = item.values[0]
        assert value.id == "ClosesSentence"
        assert value.referenced_concept is not None
        assert value.referenced_concept.id == "Sentence"
        assert value.referenced_concept.definition == "A phrase type."

    def test_build_schema_item_value_without_reference(self) -> None:
        """A value row with no VALUE_REFERENCES edge produces referenced_concept=None."""
        from services.concepts import _build_schema_item

        row = {
            "schema_id": "CadenceFunction",
            "schema_name": "Cadence Function",
            "schema_description": "Functional weight.",
            "cardinality": "ONE_OF",
            "required": True,
            "values": [
                {
                    "id": "Independent",
                    "name": "Independent",
                    "referenced_concept_id": None,
                    "referenced_concept_name": None,
                    "referenced_concept_definition": None,
                }
            ],
        }
        item = _build_schema_item(row, "en", {}, {}, {})
        assert item.values[0].referenced_concept is None
