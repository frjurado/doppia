"""Domain visualisation script (pyvis).

Exports a pyvis interactive HTML file for a given knowledge graph domain.
Run after every seed to spot structural problems without opening Neo4j Bloom.

Usage::

    python scripts/visualize_domain.py --domain cadences
    python scripts/visualize_domain.py --domain cadences --output /tmp/cadences.html

Environment variables (defaults match ``.env.example``)::

    NEO4J_URI       bolt://localhost:7687
    NEO4J_USER      neo4j
    NEO4J_PASSWORD  localpassword

Exits 0 on success, 1 if Neo4j is unreachable or the domain has no nodes.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from neo4j import GraphDatabase  # noqa: E402
from pyvis.network import Network  # noqa: E402

# One colour per distinct domain encountered; index 0 reserved for the target domain.
_DOMAIN_COLORS = [
    "#3f5f77",  # Henle Blue — target domain
    "#c0704a",  # terracotta
    "#5a8a5e",  # muted green
    "#7a5a8a",  # muted purple
    "#8a7a3a",  # gold
    "#3a7a8a",  # teal
]
_SCHEMA_COLOR = "#e8b86d"
_VALUE_COLOR = "#c8d8c8"

_DOMAIN_CONCEPTS = (
    "MATCH (c:Concept {domain:$d}) RETURN c.id AS id,c.name AS name,c.stub AS stub"
)
_OUTGOING_EDGES = (
    "MATCH (s:Concept {domain:$d})-[r]->(t) "
    "RETURN s.id AS src,type(r) AS rel,t AS dst,labels(t) AS lbls,"
    "r.order AS ord,r.required AS req"
)
_PV_EDGES = (
    "MATCH (ps:PropertySchema)-[:HAS_VALUE]->(pv:PropertyValue) WHERE ps.id IN $ids "
    "RETURN ps.id AS schema_id,pv.id AS pv_id,pv.name AS pv_name"
)
_VALREFS = (
    "MATCH (:Concept {domain:$d})-[:HAS_PROPERTY_SCHEMA]->(:PropertySchema)"
    "-[:HAS_VALUE]->(pv:PropertyValue)-[:VALUE_REFERENCES]->(ref:Concept) "
    "RETURN pv.id AS pv_id,ref.id AS ref_id,ref.name AS ref_name,"
    "ref.stub AS ref_stub,ref.domain AS ref_domain"
)


def _build(session, domain: str) -> Network:  # type: ignore[type-arg]
    net = Network(height="90vh", width="100%", directed=True, bgcolor="#fafaf8")
    net.set_options(
        '{"physics":{"solver":"forceAtlas2Based","forceAtlas2Based":{"gravitationalConstant":-60}}}'
    )

    domain_map: dict[str, str] = {domain: _DOMAIN_COLORS[0]}
    seen: set[str] = set()

    def _color(d: str | None) -> str:
        k = d or "unknown"
        if k not in domain_map:
            domain_map[k] = _DOMAIN_COLORS[len(domain_map) % len(_DOMAIN_COLORS)]
        return domain_map[k]

    def _concept(nid: str, name: str, stub: bool, dom: str | None) -> None:
        if nid in seen:
            return
        seen.add(nid)
        c = _color(dom)
        label = f"{name} [stub]" if stub else name
        net.add_node(
            nid,
            label=label,
            title=f"id: {nid}\ndomain: {dom}\nstub: {stub}",
            shape="ellipse",
            color={"background": c, "border": "#aaaaaa" if stub else c},
            borderWidth=3 if stub else 1,
            font={"color": "#ffffff" if not stub else "#555555"},
            size=28,
        )

    # Domain concept nodes
    for row in session.run(_DOMAIN_CONCEPTS, d=domain).data():
        _concept(row["id"], row["name"], row["stub"] or False, domain)

    if not seen:
        return net

    # Outgoing edges from domain concepts
    for row in session.run(_OUTGOING_EDGES, d=domain).data():
        dst, lbls, rel = row["dst"], row["lbls"] or [], row["rel"]
        if "Concept" in lbls:
            _concept(
                dst["id"],
                dst.get("name") or dst["id"],
                dst.get("stub") or False,
                dst.get("domain"),
            )
            tip = (
                f"CONTAINS (order:{row['ord']}, required:{row['req']})"
                if rel == "CONTAINS"
                else rel
            )
            net.add_edge(row["src"], dst["id"], label=rel, title=tip, arrows="to")
        elif "PropertySchema" in lbls:
            ps_id = dst["id"]
            if ps_id not in seen:
                seen.add(ps_id)
                net.add_node(
                    ps_id,
                    label=dst.get("name") or ps_id,
                    title=f"PropertySchema\n{ps_id}",
                    shape="square",
                    color={"background": _SCHEMA_COLOR, "border": "#b08030"},
                    size=22,
                    font={"color": "#333333"},
                )
            net.add_edge(
                row["src"],
                ps_id,
                label="HAS_PROPERTY_SCHEMA",
                title="HAS_PROPERTY_SCHEMA",
                arrows="to",
                dashes=True,
            )

    # PropertyValue nodes and HAS_VALUE edges
    for row in session.run(_PV_EDGES, ids=list(seen)).data():
        pv_id = row["pv_id"]
        if pv_id not in seen:
            seen.add(pv_id)
            net.add_node(
                pv_id,
                label=row["pv_name"] or pv_id,
                title=f"PropertyValue\n{pv_id}",
                shape="dot",
                color={"background": _VALUE_COLOR, "border": "#80a880"},
                size=14,
                font={"color": "#333333"},
            )
        net.add_edge(
            row["schema_id"],
            pv_id,
            label="HAS_VALUE",
            title="HAS_VALUE",
            arrows="to",
            dashes=True,
        )

    # VALUE_REFERENCES edges
    for row in session.run(_VALREFS, d=domain).data():
        _concept(
            row["ref_id"],
            row["ref_name"] or row["ref_id"],
            row["ref_stub"] or False,
            row["ref_domain"],
        )
        net.add_edge(
            row["pv_id"],
            row["ref_id"],
            label="VALUE_REFERENCES",
            title="VALUE_REFERENCES",
            arrows="to",
            dashes=True,
        )

    return net


def main() -> None:
    """Entry point for the domain visualisation script."""
    parser = argparse.ArgumentParser(
        description="Export a pyvis HTML visualisation for a knowledge graph domain."
    )
    parser.add_argument(
        "--domain", required=True, help="Domain name (e.g. 'cadences')."
    )
    parser.add_argument(
        "--output", default=None, help="Output HTML path (default: <domain>.html)."
    )
    args = parser.parse_args()

    out_path = Path(args.output) if args.output else Path(f"{args.domain}.html")

    uri = os.environ.get("NEO4J_URI", "bolt://localhost:7687")
    user = os.environ.get("NEO4J_USER", "neo4j")
    password = os.environ.get("NEO4J_PASSWORD", "localpassword")

    print(f"Connecting to {uri} …")
    driver = GraphDatabase.driver(uri, auth=(user, password))
    try:
        driver.verify_connectivity()
    except Exception as exc:  # noqa: BLE001
        print(f"[ERROR] Cannot connect to Neo4j: {exc}", file=sys.stderr)
        sys.exit(1)

    try:
        with driver.session() as session:
            net = _build(session, args.domain)
    finally:
        driver.close()

    if not net.nodes:
        print(
            f"[ERROR] No nodes for domain '{args.domain}'. Has it been seeded?",
            file=sys.stderr,
        )
        sys.exit(1)

    net.write_html(str(out_path))
    print(f"[OK] {len(net.nodes)} nodes, {len(net.edges)} edges → {out_path.resolve()}")


if __name__ == "__main__":
    main()
