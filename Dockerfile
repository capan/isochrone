FROM node:22-slim AS ui
WORKDIR /ui
COPY isochrone-ui/package*.json ./
RUN npm ci
COPY isochrone-ui/ ./
RUN npm run build

FROM node:22-slim
WORKDIR /app
# osm2pgrouting imports areas requested through POST /api/areas; psql runs the
# canonical main_component.sql rather than a second copy of its logic.
RUN apt-get update \
 && apt-get install -y --no-install-recommends osm2pgrouting postgresql-client \
 && rm -rf /var/lib/apt/lists/*
# ts-node runs the backend directly, so devDependencies are needed at runtime
COPY isochrone-backend/package*.json ./
RUN npm ci
COPY isochrone-backend/ ./
# paths resolve relative to /app, matching the layout ts-node sees in dev
COPY overpass/osm-imports/mapconfig.xml /overpass/osm-imports/mapconfig.xml
COPY scripts/main_component.sql /scripts/main_component.sql
COPY --from=ui /ui/dist /ui-dist
ENV UI_DIST=/ui-dist
EXPOSE 3001
CMD ["npx", "ts-node", "index.ts"]
