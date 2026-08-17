#!/usr/bin/env bash
# Imports the Berlin Mietspiegel Wohnlagen (residential-location class per
# address: einfach/mittel/gut) into public.berlin_wohnlagen.
#
# Runs from the HOST, not a container — neither db nor app has gdal, and
# compose binds postgres to 127.0.0.1:5454 for exactly this kind of job.
# Licence dl-de-zero-2.0: no attribution owed.
#
# Usage: scripts/import-wohnlagen.sh [year]   (default 2026)
set -euo pipefail

# ogr2ogr must be on the host: it needs outbound network to gdi.berlin.de, and
# neither the db nor the app image ships gdal. psql is NOT assumed present on
# the host (it usually is not — libpq is a separate brew formula), so the
# verification queries go through the db container instead.
for t in ogr2ogr curl docker; do
  command -v "$t" >/dev/null || { echo "$t not found (ogr2ogr: brew install gdal)" >&2; exit 1; }
done
psql_db() { docker compose exec -T db psql -U postgres -d osm_db "$@"; }

YEAR="${1:-2026}"
SERVICE="wohnlagenadr${YEAR}"
WFS="https://gdi.berlin.de/services/wfs/${SERVICE}"
PG="host=127.0.0.1 port=5454 dbname=osm_db user=postgres password=${PGPASSWORD:-password}"

# The geoportal answers maintenance windows with an HTML page and HTTP 200.
# ogr2ogr then fails deep inside the WFS driver with an opaque parse error, or
# worse, silently imports nothing — measured 2026-08-17, cost an import that
# looked like it had succeeded. Fail here instead, where the reason is legible.
caps=$(curl -sS --max-time 60 "${WFS}?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetCapabilities")
case "$caps" in
  *"<!DOCTYPE html"*|*"Wartungsarbeiten"*)
    echo "gdi.berlin.de is down for maintenance — try again later." >&2; exit 1 ;;
  *WFS_Capabilities*) ;;
  *) echo "Unexpected GetCapabilities response from ${WFS}" >&2; exit 1 ;;
esac

# Layer names are <service>:<layer> but the suffix is not guessable and has
# changed between editions, so read it back rather than hardcoding it.
LAYER=$(printf '%s' "$caps" | grep -o '<Name>[^<]*</Name>' | sed 's/<[^>]*>//g' \
        | grep -m1 "^${SERVICE}:") || { echo "No layer found in ${SERVICE}" >&2; exit 1; }
echo "Importing layer ${LAYER}"

ogr2ogr -f PostgreSQL "PG:${PG}" "WFS:${WFS}?VERSION=2.0.0" "${LAYER}" \
  -nln berlin_wohnlagen -t_srs EPSG:4326 \
  -lco GEOMETRY_NAME=geom -lco SPATIAL_INDEX=GIST -overwrite \
  --config OGR_WFS_PAGING_ALLOWED YES --config OGR_WFS_PAGE_SIZE 5000

# Berlin has ~400k addresses. WFS paging that stops early still exits 0 and
# leaves a table that looks fine until a lookup silently misses half the city,
# so assert rather than print. 100k is a floor, not a target.
rows=$(psql_db -tAc "SELECT count(*) FROM public.berlin_wohnlagen;" | tr -d '[:space:]')
echo "imported ${rows} rows"
[ "$rows" -ge 100000 ] || { echo "expected ~400k, got ${rows} — paging stopped early" >&2; exit 1; }
psql_db -c "\d public.berlin_wohnlagen"
