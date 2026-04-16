"""Pytest configuration and shared fixtures.

Unit test fixtures go here. Integration test fixtures that require live databases
should be added in tests/integration/conftest.py (to be created when those tests
are written).

All fixtures follow the pattern: set up test data, yield, tear down. Do not assume
a clean database between tests; do not leave test data behind.
"""

from __future__ import annotations

# TODO: add fixtures as components are built.
# Planned fixtures:
#   - neo4j_session: async Neo4j session against a test database
#   - db_session: async SQLAlchemy session against a test PostgreSQL database
#   - test_client: FastAPI TestClient with dev auth bypass active
#   - sample_mei_file: bytes of a minimal valid MEI file for upload tests
