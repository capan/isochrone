-- Flags every vertex belonging to a connected component large enough to be a
-- real place, so the nearest-vertex lookup can ignore islands.
--
-- Without this, a click near a disconnected fragment snaps to it and the
-- isochrone covers a few hundred metres of unreachable stub. In Berlin that is
-- 7292 components: 94% of vertices in the main one, 33704 stranded.
--
-- Computed on the full graph (every edge traversable), which is the `walk`
-- profile. Stroller/wheelchair exclusions can still strand an origin — that is
-- a real answer about that location, not a data artefact.
--
-- NOT just the single largest component: Istanbul is cut in two by the
-- Bosphorus and no pedestrian crossing of it exists, so the walking graph is
-- genuinely two networks — Europe 71407 vertices, Asia 58897. Taking only the
-- biggest condemned the entire Asian side (all of Kadikoy and Uskudar) as
-- stranded and registered the city with a European-side-only bbox. Measured
-- 2026-08-22. Berlin is unaffected: its second component is 181 vertices
-- against 618345, so any threshold in this range leaves its flags identical.
--
-- Idempotent: safe to re-run after an import or a cost change.
-- Usage: psql -d osm_db -v schema=berlin -f scripts/main_component.sql
--        psql -d osm_db -v schema=istanbul -v min_component=1000 -f ...

\if :{?schema} \else \set schema berlin \endif
-- A component smaller than this is a stub, not a neighbourhood. 1000 sits far
-- above Berlin's confetti (181 max) and far below Istanbul's Asian side.
\if :{?min_component} \else \set min_component 1000 \endif
SET search_path = :schema, public;

ALTER TABLE ways_vertices_pgr
  ADD COLUMN IF NOT EXISTS main_component boolean NOT NULL DEFAULT false;

WITH comp AS (
  SELECT *
  FROM pgr_connectedComponents(
    'SELECT id, source, target, cost, reverse_cost FROM ways'
  )
),
keepers AS (
  SELECT component
  FROM comp
  GROUP BY component
  HAVING count(*) >= :min_component
)
UPDATE ways_vertices_pgr v
SET main_component = (c.component IN (SELECT component FROM keepers))
FROM comp c
WHERE c.node = v.id
  AND v.main_component IS DISTINCT FROM (c.component IN (SELECT component FROM keepers));

-- Partial index: the nearest-vertex query only ever searches this subset.
CREATE INDEX IF NOT EXISTS idx_vertices_main_component_geom
  ON ways_vertices_pgr USING GIST (geom)
  WHERE main_component;

ANALYZE ways_vertices_pgr;

SELECT count(*) FILTER (WHERE main_component) AS routable,
       count(*) FILTER (WHERE NOT main_component) AS stranded,
       round(100.0 * count(*) FILTER (WHERE main_component) / count(*), 1) AS pct
FROM ways_vertices_pgr;
