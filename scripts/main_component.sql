-- Flags every vertex that belongs to the largest connected component of the
-- walking graph, so the nearest-vertex lookup can ignore islands.
--
-- Without this, a click near a disconnected fragment snaps to it and the
-- isochrone covers a few hundred metres of unreachable stub. In Berlin that is
-- 7292 components: 94% of vertices in the main one, 33704 stranded.
--
-- Computed on the full graph (every edge traversable), which is the `walk`
-- profile. Stroller/wheelchair exclusions can still strand an origin — that is
-- a real answer about that location, not a data artefact.
--
-- Idempotent: safe to re-run after an import or a cost change.
-- Usage: psql -d osm_db -v schema=berlin -f scripts/main_component.sql

\if :{?schema} \else \set schema berlin \endif
SET search_path = :schema, public;

ALTER TABLE ways_vertices_pgr
  ADD COLUMN IF NOT EXISTS main_component boolean NOT NULL DEFAULT false;

WITH comp AS (
  SELECT *
  FROM pgr_connectedComponents(
    'SELECT id, source, target, cost, reverse_cost FROM ways'
  )
),
biggest AS (
  SELECT component
  FROM comp
  GROUP BY component
  ORDER BY count(*) DESC
  LIMIT 1
)
UPDATE ways_vertices_pgr v
SET main_component = (c.component = (SELECT component FROM biggest))
FROM comp c
WHERE c.node = v.id
  AND v.main_component IS DISTINCT FROM (c.component = (SELECT component FROM biggest));

-- Partial index: the nearest-vertex query only ever searches this subset.
CREATE INDEX IF NOT EXISTS idx_vertices_main_component_geom
  ON ways_vertices_pgr USING GIST (geom)
  WHERE main_component;

ANALYZE ways_vertices_pgr;

SELECT count(*) FILTER (WHERE main_component) AS routable,
       count(*) FILTER (WHERE NOT main_component) AS stranded
FROM ways_vertices_pgr;
