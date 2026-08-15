#!/usr/bin/env bash
# Regenerate the GoAccess report for a site's Caddy access log.
#
#   scripts/caddy-report.sh                    # huseyincapan → /tmp/huseyincapan-report.html
#   scripts/caddy-report.sh eudr               # whichever site block logs
#   OUT=~/Desktop/report.html scripts/caddy-report.sh
#
# The report is a STATIC file. It shows the log as it stood when generated and
# nothing updates it afterwards, so "refresh the report" always means running
# this again. (GoAccess can hold a websocket open with --real-time-html, but
# that needs the port reachable from the browser — not worth it for occasional
# reading.)
#
# goaccess runs locally and is deliberately not installed on the server: the
# log streams over ssh instead, so the box keeps only what it needs to serve.
set -euo pipefail

SITE="${1:-huseyincapan}"
# The address lives in ~/.ssh/config, never in this repo — same reason the
# deploy in HANDOFF is the only place that knows it.
HOST="${CADDY_HOST:-hetzner}"
# Matches CADDY_LOGS_DIR in docker-compose.yml, which is what puts these on the
# host in the first place; before that mount they died with the container.
LOGS="${CADDY_LOGS_DIR:-/opt/caddy-logs}"
OUT="${OUT:-/tmp/${SITE}-report.html}"

command -v goaccess >/dev/null || {
  echo "goaccess is not installed locally — brew install goaccess" >&2
  exit 1
}

# Fail loudly on a wrong site name. Without this the pipeline below succeeds
# with no input and writes a valid, empty, entirely misleading report.
ssh "$HOST" "test -e ${LOGS}/${SITE}.log" || {
  echo "no ${LOGS}/${SITE}.log on ${HOST} — sites currently logging:" >&2
  ssh "$HOST" "ls -1 ${LOGS}/ 2>/dev/null | sed 's/\.log.*//' | sort -u" >&2
  exit 1
}

# zcat -f reads Caddy's rotated .gz siblings AND passes the plain live file
# through unchanged, so one glob covers the whole retained history. Without the
# glob the report silently covers only since the last rotation.
ssh "$HOST" "zcat -f ${LOGS}/${SITE}.log* 2>/dev/null" \
  | goaccess --log-format=CADDY --no-progress -o "$OUT" -

echo "$OUT"
