# syntax=docker/dockerfile:1

# --- build stage -----------------------------------------------------------
FROM node:24-alpine AS build
WORKDIR /app

# Install all dependencies (dev included) without running scripts, so the build
# works before the sources are copied into the image.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY netbox-openapi.yaml ./
RUN npm run build

# --- runtime stage ---------------------------------------------------------
FROM node:24-alpine
ENV NODE_ENV=production \
    MCP_HTTP_HOST=0.0.0.0 \
    MCP_HTTP_PORT=3000
WORKDIR /app

# Production dependencies only; --ignore-scripts avoids the `prepare` hook
# trying to run tsc (not installed here). The compiled output is copied below.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# Compiled server plus the bundled OpenAPI spec (build/spec/netbox-openapi.yaml).
COPY --from=build /app/build ./build

EXPOSE 3000
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "build/index.js"]