#!/usr/bin/env bash
# Clips the Turkey OSM extract down to the Istanbul urban core and shapes it
# into what import_city.sh expects, so that script can be reused unchanged.
#
# Geofabrik publishes Turkey only as a whole country (613 MB) — there is no
# istanbul-latest.osm.pbf, unlike Berlin. import_city.sh builds its URL as
# europe/<country>/<city>-latest.osm.pbf and would 404, so we pre-place the
# files it looks for; it then skips both download and XML conversion.
set -euo pipefail

# Urban core only, both sides of the Bosphorus: Fatih/Beyoğlu/Beşiktaş/Şişli on
# the European side, Kadıköy/Üsküdar on the Asian. ~926 km², deliberately close
# to Berlin's 891 km² so the two are comparable. Istanbul province is 5,343 km²
# and mostly forest and hinterland — a routing graph out there buys nothing.
BBOX="${BBOX:-28.80,40.93,29.25,41.15}"   # minlon,minlat,maxlon,maxlat

DIR="$(dirname "$0")/../overpass/osm-imports/osm_db/istanbul"
SRC="${SRC:-$DIR/../turkey-latest.osm.pbf}"
[ -f "$SRC" ] || { echo "missing $SRC — download it first" >&2; exit 1; }

command -v osmium >/dev/null || { echo "osmium not found — brew install osmium-tool" >&2; exit 1; }

echo "clipping to $BBOX"
osmium extract --bbox "$BBOX" "$SRC" -o "$DIR/core.osm.pbf" --overwrite

# osm2pgrouting only consumes highways, but a bbox clip keeps every building in
# the core too — and Istanbul has ~740k building ways, which would balloon the
# XML for nothing. tags-filter keeps matched ways plus the nodes they reference.
echo "filtering to highways"
osmium tags-filter "$DIR/core.osm.pbf" w/highway -o "$DIR/highways.osm.pbf" --overwrite

# import_city.sh feeds osm2pgrouting XML, not PBF, and looks for these names.
echo "converting to XML"
osmium cat "$DIR/highways.osm.pbf" -o "$DIR/istanbul.osm" --overwrite
cp "$DIR/highways.osm.pbf" "$DIR/istanbul.osm.pbf"

echo
ls -lh "$DIR"/*.pbf "$DIR"/*.osm | awk '{print $5"\t"$9}'
osmium fileinfo -e "$DIR/highways.osm.pbf" 2>/dev/null | grep -iE 'Number of.*ways|Number of.*nodes' || true
