FROM node:22-slim AS ui
WORKDIR /ui
COPY isochrone-ui/package*.json ./
RUN npm ci
COPY isochrone-ui/ ./
RUN npm run build

FROM node:22-slim
WORKDIR /app
# ts-node runs the backend directly, so devDependencies are needed at runtime
COPY isochrone-backend/package*.json ./
RUN npm ci
COPY isochrone-backend/ ./
COPY --from=ui /ui/dist /ui-dist
ENV UI_DIST=/ui-dist
EXPOSE 3001
CMD ["npx", "ts-node", "index.ts"]
