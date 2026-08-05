#!/bin/bash

set -e

## Logging redirection removed as requested
# psql/createdb read these directly — no need to repeat them as flags below.
export PGHOST="${PGHOST:-127.0.0.1}"
export PGPORT="${PGPORT:-5454}"
export PGUSER="${PGUSER:-postgres}"
export PGPASSWORD="${PGPASSWORD:-password}"

if [ -z "$1" ]; then
  read -p "Enter the country path (e.g., united-kingdom/england): " COUNTRY
else
  COUNTRY=$1
fi

if [ -z "$2" ]; then
  read -p "Enter the city name (e.g., greater-london): " CITY
else
  CITY=$2
fi

CITY_SCHEMA=$(echo "$CITY" | sed 's/-/_/g')

OVERWRITE=false
if [[ "$3" == "--overwrite" ]]; then
  OVERWRITE=true
fi

DB_NAME="osm_db"
CITY_DIR="osm_db/$CITY"
OSM_PBF="${CITY}.osm.pbf"
OSM_XML="${CITY}.osm"

# Define bounding box if needed (or use .pbf URLs)
if [ -z "$COUNTRY" ]; then
  read -p "Enter the country name (e.g., germany): " COUNTRY
fi

URL="https://download.geofabrik.de/europe/${COUNTRY}/${CITY}-latest.osm.pbf"

if [ -f "$CITY_DIR/${CITY}_data.zip" ] && [ "$OVERWRITE" = false ]; then
  echo "📦 Archive ${CITY}_data.zip found, extracting instead of downloading..."
  mkdir -p "$CITY_DIR"
  unzip -o "$CITY_DIR/${CITY}_data.zip" -d "$CITY_DIR"
fi

if [ ! -f "$CITY_DIR/$OSM_PBF" ]; then
  echo "📦 Downloading data for $CITY..."
  mkdir -p "$CITY_DIR"
  HTTP_STATUS=$(curl -s -o "$CITY_DIR/$OSM_PBF" -w "%{http_code}" -L "$URL")
  if [ "$HTTP_STATUS" -ne 200 ]; then
    echo "❌ Failed to download data for $CITY. URL returned status code $HTTP_STATUS."
    rm -f "$CITY_DIR/$OSM_PBF"
    exit 1
  fi
else
  echo "📂 File $OSM_PBF already exists, skipping download."
fi

if [ -f "$CITY_DIR/$OSM_XML" ] && [ "$OVERWRITE" = false ]; then
  echo "📂 File $OSM_XML already exists, using existing data. Use --overwrite to regenerate."
else
  echo "🔄 Converting PBF to OSM XML..."
  osmium cat "$CITY_DIR/$OSM_PBF" -o "$CITY_DIR/$OSM_XML" --overwrite
fi

 # psql -U postgres -c "DROP DATABASE IF EXISTS $DB_NAME;"
 # psql -U postgres -c "CREATE DATABASE $DB_NAME;"
echo "🧪 Checking if database $DB_NAME exists..."
DB_EXISTS=$(psql -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'")
if [ "$DB_EXISTS" != "1" ]; then
  echo "🛠️ Creating database $DB_NAME..."
  createdb "$DB_NAME"
else
  echo "✅ Database $DB_NAME already exists."
fi
psql -d "$DB_NAME" -c "CREATE EXTENSION IF NOT EXISTS postgis;"
psql -d "$DB_NAME" -c "CREATE EXTENSION IF NOT EXISTS pgrouting;"
psql -d "$DB_NAME" -c "CREATE EXTENSION IF NOT EXISTS hstore;"

echo "🏗️ Creating schema $CITY_SCHEMA in $DB_NAME..."
psql -d "$DB_NAME" -c "DROP SCHEMA IF EXISTS $CITY_SCHEMA CASCADE;"
psql -d "$DB_NAME" -c "CREATE SCHEMA $CITY_SCHEMA;"
echo "✅ Schema $CITY_SCHEMA created."
sleep 2

# Removed SET search_path because osm2pgrouting uses the --schema flag

echo "♻️ Re-importing data into schema $CITY_SCHEMA..."

echo "🗺️ Importing OSM data into $DB_NAME..."
osm2pgrouting -f "$CITY_DIR/$OSM_XML" \
  -d "$DB_NAME" -U "$PGUSER" -W "$PGPASSWORD" \
  -h "$PGHOST" -p "$PGPORT" \
  -c mapconfig.xml \
  --schema $CITY_SCHEMA \
  --clean

echo "🏁 Done! $CITY has been imported into $DB_NAME."

echo "🔍 Running data health checks and index creation..."

# Index creation for performance
echo "🛠️ Creating indexes..."
psql -d "$DB_NAME" -c "CREATE INDEX IF NOT EXISTS idx_${CITY_SCHEMA}_source ON $CITY_SCHEMA.ways(source);"
psql -d "$DB_NAME" -c "CREATE INDEX IF NOT EXISTS idx_${CITY_SCHEMA}_target ON $CITY_SCHEMA.ways(target);"
psql -d "$DB_NAME" -c "CREATE INDEX IF NOT EXISTS idx_${CITY_SCHEMA}_geom ON $CITY_SCHEMA.ways USING GIST(geom);"

echo "📐 Normalizing cost and reverse_cost to walking seconds (1.4 m/s, stairs at half) ..."
# Must stay identical to the `walk` profile in isochrone-backend/index.ts —
# the precompute warmers route on this column.
psql -d "$DB_NAME" -c \
  "UPDATE $CITY_SCHEMA.ways SET
     cost         = ROUND((length_m / CASE WHEN tag_id = 104 THEN 0.7 ELSE 1.4 END)::numeric, 2),
     reverse_cost = ROUND((length_m / CASE WHEN tag_id = 104 THEN 0.7 ELSE 1.4 END)::numeric, 2);"

echo "🧭 Flagging the largest connected component (skips graph islands) ..."
# Must run after cost normalization — connectivity is computed from cost.
psql -d "$DB_NAME" -v schema="$CITY_SCHEMA" -f "$(dirname "$0")/../../scripts/main_component.sql"

echo "📊 Running data integrity checks..."

REPORT_FILE="$CITY_DIR/${CITY}_report.txt"
{
  echo "📄 Data Integrity Report for $CITY_SCHEMA"
  echo "-----------------------------------------"
  echo "Ways count:"
  psql -d "$DB_NAME" -c "SELECT COUNT(*) FROM $CITY_SCHEMA.ways;"
  echo ""
  echo "Vertices count:"
  psql -d "$DB_NAME" -c "SELECT COUNT(*) FROM $CITY_SCHEMA.ways_vertices_pgr;"
  echo ""
  echo "Ways with NULL geometry:"
  psql -d "$DB_NAME" -c "SELECT COUNT(*) FROM $CITY_SCHEMA.ways WHERE geom IS NULL;"
} > "$REPORT_FILE"
echo "✅ Integrity report saved to $REPORT_FILE"

echo "📦 Zipping folder $CITY_DIR..."
zip -j "$CITY_DIR/${CITY}_data.zip" "$CITY_DIR"/*
if [ -f "$CITY_DIR/${CITY}_data.zip" ]; then
  echo "🗑️ Cleaning up raw files..."
  rm -f "$CITY_DIR/$OSM_XML"
  rm -f "$CITY_DIR/$OSM_PBF"
fi
echo "✅ Finished processing $CITY."