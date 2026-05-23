"""Pytest fixtures for graph integration tests.

All fixtures in this module require a running Neo4j instance.  Tests that use
them are marked ``@pytest.mark.integration`` and are skipped unless
``DOPPIA_RUN_INTEGRATION=1`` is set.
"""

from __future__ import annotations

import os

import pytest
from neo4j import Driver, GraphDatabase


@pytest.fixture
def neo4j_driver() -> Driver:
    """Synchronous Neo4j driver connected to the local Docker Neo4j instance.

    Reads ``NEO4J_URI``, ``NEO4J_USER``, and ``NEO4J_PASSWORD`` from the
    environment (defaults match ``.env.example``).

    Yields:
        A verified synchronous ``Driver`` instance.
    """
    uri = os.environ.get("NEO4J_URI", "bolt://localhost:7687")
    user = os.environ.get("NEO4J_USER", "neo4j")
    password = os.environ.get("NEO4J_PASSWORD", "localpassword")

    driver: Driver = GraphDatabase.driver(uri, auth=(user, password))
    driver.verify_connectivity()

    yield driver

    driver.close()
