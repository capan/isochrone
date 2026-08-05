
-- OSM Data Integrity Check SQL
-- Replace 'berlin' with your schema if needed

-- 1. Invalid costs (NULL or non-positive)
SELECT COUNT(*) AS invalid_cost_count
FROM berlin.ways
WHERE cost IS NULL OR cost <= 0;

-- 2. High cost values
SELECT COUNT(*) AS high_cost_count
FROM berlin.ways
WHERE cost > 1000;

-- 3. Asymmetric edge costs
SELECT COUNT(*) AS asymmetric_edges
FROM berlin.ways
WHERE ABS(cost - reverse_cost) > 0.01;

-- 4. Cost statistics
SELECT 
  MIN(cost) AS min_cost,
  MAX(cost) AS max_cost,
  AVG(cost) AS avg_cost,
  PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY cost) AS median_cost
FROM berlin.ways;

-- 5. Cost histogram
SELECT 
  ROUND(cost)::int AS cost_bucket,
  COUNT(*) AS count
FROM berlin.ways
GROUP BY cost_bucket
ORDER BY cost_bucket;

-- 6. Orphan vertices
SELECT COUNT(*) AS orphan_nodes
FROM berlin.ways_vertices_pgr v
LEFT JOIN (
  SELECT source AS node FROM berlin.ways
  UNION
  SELECT target AS node FROM berlin.ways
) AS connected ON v.id = connected.node
WHERE connected.node IS NULL;

-- 7. Duplicate edges
SELECT source, target, COUNT(*) AS edge_count
FROM berlin.ways
GROUP BY source, target
HAVING COUNT(*) > 1
ORDER BY edge_count DESC
LIMIT 10;

-- 8. Invalid geometries
SELECT COUNT(*) AS invalid_geometries
FROM berlin.ways 
WHERE NOT ST_IsValid(the_geom);
