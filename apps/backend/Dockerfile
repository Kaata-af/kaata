# =============================================================================
# Kaata backend — Go API, single binary, served on :8080.
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1: build
# -----------------------------------------------------------------------------
FROM golang:1.25-alpine AS build
WORKDIR /src

RUN apk add --no-cache git

COPY go.mod go.sum ./
RUN go mod download

COPY . .

# Version / commit can be injected at build time via Dokploy build args. Both
# are optional; they end up in the binary via ldflags so /v1/health-style
# endpoints could surface them later.
ARG VERSION=dev
ARG COMMIT=unknown

RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
	go build -trimpath -ldflags="-s -w -X main.Version=${VERSION} -X main.Commit=${COMMIT}" \
	-o /out/kaata-server ./cmd/server

# -----------------------------------------------------------------------------
# Stage 2: runtime
# -----------------------------------------------------------------------------
FROM alpine:3.20

RUN apk add --no-cache ca-certificates tini wget \
	&& addgroup -S kaata \
	&& adduser -S -G kaata -H -s /sbin/nologin kaata

WORKDIR /app
COPY --from=build --chown=kaata:kaata /out/kaata-server ./kaata-server

USER kaata

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
	CMD wget -qO- http://localhost:8080/v1/health > /dev/null || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["./kaata-server"]
