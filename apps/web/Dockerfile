# =============================================================================
# Kaata web — Vite + React SPA, served by Caddy.
# Build from the REPOSITORY ROOT for the shared palette and pure domain logic:
#   docker build -f apps/web/Dockerfile .
# Dokploy: Dockerfile = apps/web/Dockerfile; Docker context = .
# Dockerfile.dockerignore limits this root context to explicit public build inputs.
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
ARG VITE_WHATSAPP_CONTACT_URL=https://wa.me/93781696644
ENV VITE_BACKEND_URL=$VITE_BACKEND_URL
ENV VITE_WHATSAPP_CONTACT_URL=$VITE_WHATSAPP_CONTACT_URL

COPY apps/web/package.json apps/web/bun.lock ./
RUN bun install --frozen-lockfile

COPY apps/web/ ./
COPY apps/_shared/brand-palette.json /app/apps/_shared/brand-palette.json
# Portable domain logic also used by the released mobile app; no native code.
COPY apps/mobile/lib/currency-catalog.ts apps/mobile/lib/calculator.ts apps/mobile/lib/calculator-input.ts apps/mobile/lib/money.ts apps/mobile/lib/digits.ts /app/apps/mobile/lib/
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
