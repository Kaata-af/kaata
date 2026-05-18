# =============================================================================
# Kaata web — Vite + React SPA, served by Caddy.
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1: build the static bundle
# -----------------------------------------------------------------------------
FROM oven/bun:1.3-alpine AS build
WORKDIR /app

# Build-time env. Override per-environment in Dokploy via build args.
# Vite embeds these into the bundle at build time; changing them requires
# a rebuild.
ARG VITE_BACKEND_URL=https://api.kaata.af
ARG VITE_WHATSAPP_CONTACT_URL=https://wa.me/93781696644
ARG VITE_APK_VERSION=0.1.0
ARG VITE_APK_DOWNLOAD_URL=
ENV VITE_BACKEND_URL=$VITE_BACKEND_URL
ENV VITE_WHATSAPP_CONTACT_URL=$VITE_WHATSAPP_CONTACT_URL
ENV VITE_APK_VERSION=$VITE_APK_VERSION
ENV VITE_APK_DOWNLOAD_URL=$VITE_APK_DOWNLOAD_URL

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build

# -----------------------------------------------------------------------------
# Stage 2: serve
# -----------------------------------------------------------------------------
FROM caddy:2-alpine

COPY Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/dist /srv

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
	CMD wget -qO- http://localhost/ > /dev/null || exit 1
