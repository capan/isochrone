#!/bin/bash

# Base bounding box
MIN_LAT=52.47
MAX_LAT=52.57
MIN_LON=13.35
MAX_LON=13.50

# Tile config
ROWS=5
COLS=5

# Precompute params
DURATIONS="${1:-5,10,15}"
STEP="0.0001"

MAX_PARALLEL=4
count=0

# Derived step
LAT_STEP=$(echo "scale=6; ($MAX_LAT - $MIN_LAT) / $ROWS" | bc)
LON_STEP=$(echo "scale=6; ($MAX_LON - $MIN_LON) / $COLS" | bc)

echo "🗺️ Tiling area into $ROWS x $COLS grid..."
echo "📍 Using durations: $DURATIONS"

for row in $(seq 0 $(($ROWS - 1))); do
  for col in $(seq 0 $(($COLS - 1))); do
    TILE_MIN_LAT=$(echo "$MIN_LAT + $row * $LAT_STEP" | bc)
    TILE_MAX_LAT=$(echo "$TILE_MIN_LAT + $LAT_STEP" | bc)
    TILE_MIN_LON=$(echo "$MIN_LON + $col * $LON_STEP" | bc)
    TILE_MAX_LON=$(echo "$TILE_MIN_LON + $LON_STEP" | bc)

    echo "🚀 Launching tile [$row,$col]: $TILE_MIN_LAT → $TILE_MAX_LAT / $TILE_MIN_LON → $TILE_MAX_LON"

    (
      export DURATIONS="$DURATIONS"
      export STEP=$STEP
      export MINLAT=$TILE_MIN_LAT
      export MAXLAT=$TILE_MAX_LAT
      export MINLON=$TILE_MIN_LON
      export MAXLON=$TILE_MAX_LON
      node --loader ts-node/esm ../scripts/precompute.ts
    ) &

    ((count++))
    if [[ $count -ge $MAX_PARALLEL ]]; then
      wait
      count=0
    fi
  done
done

wait
echo "✅ All tiles completed."