# =============================================================================
# Kaata web — Vite + React SPA, served by Caddy.
# Build from the REPOSITORY ROOT so the canonical shared palette is available:
#   docker build -f apps/web/Dockerfile .
# Dokploy: Dockerfile = apps/web/Dockerfile; Docker context = .
# Dockerfile.dockerignore limits this root context to web inputs and the palette.
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1: build the static bundle
# -----------------------------------------------------------------------------
FROM oven/bun:1.3-alpine AS build
WORKDIR /app/apps/web

# Build-time env. Override per-environment in Dokploy via build args.
# Vite embeds these into the bundle at build time; changing them requires
# a rebuild.
ARG VITE_BACKEND_URL=https://api.kaata.af
ARG VITE_GOOGLE_WEB_CLIENT_ID
ARG VITE_WHATSAPP_CONTACT_URL=https://wa.me/93781696644
ENV VITE_BACKEND_URL=$VITE_BACKEND_URL
ENV VITE_GOOGLE_WEB_CLIENT_ID=$VITE_GOOGLE_WEB_CLIENT_ID
ENV VITE_WHATSAPP_CONTACT_URL=$VITE_WHATSAPP_CONTACT_URL

COPY apps/web/package.json apps/web/bun.lock ./
RUN bun install --frozen-lockfile

COPY apps/web/ ./
COPY apps/_shared/brand-palette.json /app/apps/_shared/brand-palette.json
RUN bun run build

# -----------------------------------------------------------------------------
# Stage 2: serve
# -----------------------------------------------------------------------------
FROM caddy:2-alpine

COPY apps/web/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/apps/web/dist /srv

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
	CMD wget -qO- http://localhost/ > /dev/null || exit 1
