package main

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/google/uuid"

	"github.com/matee/kaata-backend/internal/admin"
	"github.com/matee/kaata-backend/internal/auth"
	"github.com/matee/kaata-backend/internal/checkin"
	"github.com/matee/kaata-backend/internal/config"
	"github.com/matee/kaata-backend/internal/crashreport"
	"github.com/matee/kaata-backend/internal/db"
	"github.com/matee/kaata-backend/internal/httpx"
	"github.com/matee/kaata-backend/internal/mesh"
	"github.com/matee/kaata-backend/internal/shared"
	syncapi "github.com/matee/kaata-backend/internal/sync"
	"github.com/matee/kaata-backend/internal/vaults"
	"github.com/matee/kaata-backend/internal/visit"
	"github.com/matee/kaata-backend/internal/waitlist"
)

// minJWTSecretLen is the floor below which we refuse to boot. HS256 with a
// short key is brute-forceable; 32 bytes ≈ 256 bits keeps the search space
// large enough that off-the-shelf JWT crackers are useless.
const minJWTSecretLen = 32

// Version / Commit are injected at build time via the Dockerfile's
// -ldflags "-X main.Version=... -X main.Commit=..." (build args VERSION / COMMIT).
// They default to dev/unknown for local runs and are surfaced on /v1/health so the
// EXACT deployed build is verifiable from outside with a single curl — turning an
// invisible "did my redeploy actually ship the new code?" into an observable fact.
// Set COMMIT=$(git rev-parse --short HEAD) as a Dokploy build arg to see the SHA.
var (
	Version = "dev"
	Commit  = "unknown"
)

func main() {
	cfg := config.Load()

	// Fail loudly on a missing or weak session secret. The previous behavior
	// was "boot, then 500/401 on every sign-in" — operationally indistinguishable
	// from a backend that's reachable but somehow broken, which delays incident
	// detection. This is a deliberate change away from fail-open dev defaults.
	if cfg.SessionJWTSecret == "" {
		log.Fatal("JWT_SECRET (or SESSION_JWT_SECRET) must be set — refusing to boot without a session signing key")
	}
	if len(cfg.SessionJWTSecret) < minJWTSecretLen {
		log.Fatalf("JWT_SECRET must be at least %d bytes (got %d) — generate one with `openssl rand -base64 32`",
			minJWTSecretLen, len(cfg.SessionJWTSecret))
	}

	// Google sign-in is the ONLY way to create an account + turn on cloud backup.
	// Every POST /v1/auth/google validates the ID token's audience against
	// GOOGLE_WEB_CLIENT_ID. If it's unset, the service returns "google web client
	// id not configured" which the handler maps to a generic 401 — so EVERY
	// sign-in fails, cloud backup silently never works, and the logs show only an
	// opaque 401. That exact misconfiguration shipped silently before. Fail loud
	// in production; warn in dev (where Google auth usually isn't exercised). The
	// value must match the mobile app's EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID.
	if cfg.GoogleWebClientID == "" {
		if os.Getenv("KAATA_ENV") == "production" {
			log.Fatal("GOOGLE_WEB_CLIENT_ID must be set in production — without it every Google sign-in returns 401 and cloud backup never works. Set it to the OAuth Web client ID that matches the mobile app.")
		}
		log.Println("[warn] GOOGLE_WEB_CLIENT_ID is unset — Google sign-in will 401. OK for local dev; REQUIRED in production.")
	}

	// SEC M1: BACKEND_DEVICE_ID stamps the hlc_device_id / device_id of
	// every server-emitted vault event. The zero-UUID fallback is fine
	// for single-replica dev (no collision possible), but in production
	// two replicas sharing the zero device id would have indistinguishable
	// HLC tiebreaks and audit forensics. Refuse to boot in production
	// without an explicit, parseable UUID; allow the unset/dev case to
	// fall through to the zero-UUID fallback inside vaults/event_emit.go.
	if os.Getenv("KAATA_ENV") == "production" {
		raw := os.Getenv("BACKEND_DEVICE_ID")
		if raw == "" {
			log.Fatal("BACKEND_DEVICE_ID is required in production (KAATA_ENV=production) — generate one with `uuidgen` per replica")
		}
		if _, err := uuid.Parse(raw); err != nil {
			log.Fatalf("BACKEND_DEVICE_ID is not a valid UUID: %v", err)
		}
	}

	// Mesh: load the Ed25519 signing keypair. If the private key is missing
	// the rest of the backend still boots — mesh just refuses to mint witness
	// attestations (503) and the /v1/check-in extension omits the Revocations
	// field (the pinned-pubkey announcement also goes silent). We log a
	// critical warning so this degradation is visible in startup logs.
	meshPriv, meshPubB64, meshRotationB64 := loadMeshSigningMaterial()
	if meshPriv == nil {
		log.Println("CRITICAL: MESH_SIGNING_PRIVKEY_PRIMARY missing or invalid — mesh witness attestation disabled. Run `go run ./cmd/genkeypair` to mint a fresh keypair; commit the public half to clients and store the private half in the backend's secret store.")
	}

	ctx := context.Background()
	pool, err := db.Open(ctx, cfg.PostgresURL)
	if err != nil {
		log.Fatalf("db open: %v", err)
	}
	defer pool.Close()

	if err := db.Migrate(ctx, pool); err != nil {
		log.Fatalf("migrate: %v", err)
	}

	// --- services & handlers ------------------------------------------------

	authSvc := auth.NewService(pool, cfg.GoogleWebClientID, cfg.SessionJWTSecret)
	authH := auth.NewHandler(authSvc)

	adminH := admin.NewHandler(admin.NewService(pool, cfg.OperatorAccountIDs, cfg.OperatorIPs))
	authenticator := auth.NewSessionAuthenticator(authSvc, cfg.SessionJWTSecret)
	// Wire the cache so SignOut purges the cached revocation entry instead of
	// leaving up to 60s of valid-looking auth in front of a deleted credential.
	authH.SetAuthenticator(authenticator)

	// Phase 4.1: wire the rate-limiter's per-account key function. httpx
	// cannot import auth directly (auth already imports httpx, so that
	// would be a cycle), so we inject the resolver as a closure here.
	httpx.SetAccountIDResolver(func(r *http.Request) string {
		claims, ok := auth.ClaimsFromContext(r.Context())
		if !ok {
			return ""
		}
		return claims.AccountID
	})

	// Mesh service. nil signingPriv puts it in disabled-but-loaded mode —
	// every witness call returns ErrSigningUnavailable (handler maps to 503)
	// and the /v1/check-in extension simply omits the mesh fields. M4 retired
	// the per-account credential-revocation hook: mesh revocation is now
	// re-sourced from membership-removal events (mesh.GetRevocationsForVault).
	meshSvc := mesh.NewService(pool, meshPriv, meshPubB64, meshRotationB64)
	meshH := mesh.NewHandler(meshSvc)

	checkinSvc := checkin.NewService(pool, cfg.MigrateToBackendURL, meshSvc)
	checkinH := checkin.NewHandler(checkinSvc, authSvc)

	visitSvc := visit.NewService(pool, cfg.APKDownloadURL)
	visitH := visit.NewHandler(visitSvc)

	waitlistH := waitlist.NewHandler(waitlist.NewService(pool))

	// Mythos crash-reporter. Public + anonymous (same group as check-in)
	// so local-only installs can report why they died.
	crashSvc := crashreport.NewService(pool)
	crashH := crashreport.NewHandler(crashSvc)

	vaultsSvc := vaults.NewService(pool)
	vaultsH := vaults.NewHandler(vaultsSvc)

	// Shared ledger snapshots ("see the full ledger on kaata.af"): store a small
	// per-person snapshot behind a short token; serve it as JSON + a tiny SSR shell.
	sharedH := shared.NewHandler(shared.NewService(pool), cfg.WebBaseURL, cfg.ShareLinkBaseURL, cfg.PublicAPIBaseURL)

	// Sync (Phase 3). The service holds membership + page LRUs (60s TTL);
	// the snapshot cron uses its own dedicated 4-conn Postgres pool so a
	// slow snapshot replay can't starve user-facing request connections.
	syncSvc := syncapi.NewService(pool)
	syncH := syncapi.NewHandler(syncSvc)

	// M2 (membership chain §8.2): pin the server witness verification key
	// set on the sync service so push-side membership verification can
	// check `witness` payloads. Primary + optional rotation pubkey — the
	// same material the mesh service announces on check-in. With mesh
	// signing disabled the set is empty and the witness arm simply never
	// matches (anchor / bound-owner verification still works).
	if keys := witnessVerifyKeys(meshPubB64, meshRotationB64); len(keys) > 0 {
		syncSvc.SetWitnessPubkeys(keys)
	}

	snapshotPool, snapshotMaxConns, err := syncapi.OpenSnapshotPool(ctx, cfg.PostgresURL)
	if err != nil {
		log.Fatalf("snapshot pool: %v", err)
	}
	defer snapshotPool.Close()

	// Wire the per-vault snapshot trigger: when a push burst crosses
	// snapshotEventThreshold accepted events since the last snapshot,
	// fire a single goroutine that builds a fresh snapshot off the
	// dedicated pool. ResetSnapshotPending is called on success so the
	// counter resumes from zero. Without this wiring, the counter
	// accumulates forever and the threshold path is dead code — only the
	// 5-minute cron tick generates snapshots.
	syncSvc.SetSnapshotTrigger(syncapi.BuildPushSnapshotTrigger(ctx, snapshotPool, syncSvc))

	// Phase 4.1: vaults/event_emit.go uses this hook so server-emitted
	// vault_member_* events bump the same per-vault pending-snapshot
	// counter PushEvents drives.
	vaults.SetServerEmitSnapshotHook(func(vaultID string) {
		syncSvc.BumpSnapshotPending(vaultID)
	})

	// --- router -------------------------------------------------------------

	r := chi.NewRouter()
	// RealIP MUST sit before any middleware that reads r.RemoteAddr so the
	// Dokploy/Traefik X-Forwarded-For chain is honored. The rate limiter's
	// per-IP key function depends on this; without it every request looks
	// like it came from the reverse-proxy's loopback IP and the cap becomes
	// global instead of per-client.
	r.Use(middleware.RealIP)
	r.Use(httpx.Logger)
	r.Use(httpx.Recoverer)
	r.Use(httpx.CORS)

	// PUBLIC routes. /v1/check-in is public for v0.4 back-compat (local-only
	// installs must continue to work forever) and uses OptionalMiddleware to
	// opportunistically refresh JWTs for installs that ARE signed in.
	r.Get("/v1/health", func(w http.ResponseWriter, _ *http.Request) {
		httpx.JSON(w, http.StatusOK, map[string]string{
			"status":  "ok",
			"version": Version,
			"commit":  Commit,
		})
	})
	r.Group(func(pr chi.Router) {
		pr.Use(authenticator.OptionalMiddleware())
		pr.Post("/v1/check-in", checkinH.CheckIn)
		// Mythos crash-reporter — anonymous-OK so local-only installs
		// can report why they died.
		pr.Post("/v1/crash-reports", crashH.Report)
	})
	r.Post("/v1/visit", visitH.Visit)
	r.Get("/v1/download", visitH.Download)
	// Waitlist: email opt-in for the "coming soon" app-store channels. Public +
	// rate-limited per IP (the email is the only PII; idempotent server-side).
	r.With(httpx.RateLimitPerIP(httpx.WaitlistJoinLimit, httpx.WaitlistJoinWindow)).
		Post("/v1/waitlist", waitlistH.Join)
	r.Post("/v1/auth/google", authH.GoogleSignIn)
	// Shared ledger ("see the full ledger on kaata.af"). All PUBLIC: the share
	// link is meant to be opened by a customer with no app/account. POST is
	// rate-limited per IP; GET-by-token + the SSR view are open (opaque tokens).
	r.With(httpx.RateLimitPerIP(httpx.ShareCreateLimit, httpx.ShareCreateWindow)).
		Post("/v1/shared", sharedH.Create)
	r.Get("/v1/shared/{token}", sharedH.Get)
	// SSR preview shell — see deploy note: kaata.af/v/* must route to the backend
	// for the OG preview; otherwise the SPA's /v/:token fallback renders it.
	r.Get("/v/{token}", sharedH.View)
	// Operator-only analytics dashboard (admin.kaata.af / /admin web page).
	// AdminKeyMiddleware 404s the whole group when ADMIN_API_KEY is unset, so a
	// deployment without the key has no admin surface at all.
	r.Group(func(pr chi.Router) {
		pr.Use(httpx.AdminKeyMiddleware(cfg.AdminAPIKey))
		pr.Get("/v1/admin/stats", adminH.Stats)
		pr.Get("/v1/admin/users", adminH.Users)
	})
	// Public invite landing read (kaata.af/i/<token>). 30/hr per IP caps
	// token-enumeration attempts; the handler still returns a uniform 404
	// on bad tokens so the limit does not leak token-existence either.
	r.With(httpx.RateLimitPerIP(httpx.InviteInfoLimit, httpx.InviteInfoWindow)).
		Get("/v1/vaults/invites/{token}/info", vaultsH.InviteInfo)

	// PROTECTED routes. RequireSession middleware checks signature, expiry,
	// auth_credentials.revoked_at (60s LRU cache).
	r.Group(func(pr chi.Router) {
		pr.Use(authenticator.Middleware())
		pr.Post("/v1/auth/signout", authH.SignOut)
		// Account-level phone: persists the shopkeeper's own number server-side so
		// it survives a reinstall (the device-local users.phone_e164 never syncs).
		pr.Put("/v1/account/phone", authH.UpdatePhone)
		// Vault management (Phase 4). All routes share the same protected
		// group; the lawful-at-HLC ACL gates the sync push path separately.
		pr.Get("/v1/vaults", vaultsH.List)
		// CreateVault: 20/day per account. Vault creation is rare in normal
		// use (a shopkeeper opens 1-2 vaults total); a higher rate is almost
		// always automation/abuse.
		pr.With(httpx.RateLimitPerAccount(httpx.CreateVaultLimit, httpx.CreateVaultWindow)).
			Post("/v1/vaults", vaultsH.Create)
		pr.Patch("/v1/vaults/{vault_id}", vaultsH.Update)
		pr.Post("/v1/vaults/{vault_id}/archive", vaultsH.Archive)
		pr.Post("/v1/vaults/{vault_id}/unarchive", vaultsH.Unarchive)
		pr.Post("/v1/vaults/{vault_id}/leave", vaultsH.Leave)
		pr.Post("/v1/vaults/{vault_id}/transfer-ownership", vaultsH.TransferOwnership)
		pr.Post("/v1/vaults/{vault_id}/members/{account_id}/role", vaultsH.SetMemberRole)
		pr.Post("/v1/vaults/{vault_id}/members/{account_id}/revoke", vaultsH.RevokeMember)
		pr.Get("/v1/vaults/{vault_id}/audit-log", vaultsH.AuditLog)
		// CreateInvite: 10/hr per account. This is the path that mints a
		// kaata.af/i/<token> URL; capping it tightly limits the blast
		// radius of a compromised session being used to flood SMS/email
		// pipes.
		pr.With(httpx.RateLimitPerAccount(httpx.CreateInviteLimit, httpx.CreateInviteWindow)).
			Post("/v1/vaults/{vault_id}/invites", vaultsH.CreateInvite)
		pr.With(httpx.RateLimitPerAccount(httpx.AcceptInviteLimit, httpx.AcceptInviteWindow)).
			Post("/v1/vaults/invites/accept", vaultsH.AcceptInvite)
		pr.Get("/v1/vaults/invites/pending", vaultsH.PendingInvites)
		// Mesh: device-key registration. Rare (per-install lifecycle) but
		// we cap as a brake against a buggy retry loop.
		pr.With(httpx.RateLimitPerAccount(httpx.RegisterKeyLimit, httpx.RegisterKeyWindow)).
			Post("/v1/devices/register-key", meshH.RegisterKey)
		// M2 witness endpoint (membership chain §8.1): signs the device /
		// member attestation tuples for the calling (account, install).
		// 60/hr per account absorbs the burst profile (invite accept, new
		// device of an existing member) without inviting abuse.
		pr.With(httpx.RateLimitPerAccount(httpx.IssueVMCLimit, httpx.IssueVMCWindow)).
			Post("/v1/vaults/{vault_id}/witness", meshH.Witness)
	})

	// PROTECTED sync routes. Wrapped in GzipResponseMiddleware so pull/snapshot
	// responses are compressed for clients that advertise Accept-Encoding: gzip.
	// Request-body gunzip is done inside the push handler so the 16 MiB
	// decompressed-size cap is enforced consistently.
	r.Group(func(pr chi.Router) {
		pr.Use(authenticator.Middleware())
		pr.Use(syncapi.GzipResponseMiddleware)
		// SyncPush: 1000/hr per account. Averaged that is ~1 req every 3.6s,
		// well above normal client churn. Pull/snapshot are NOT rate-limited;
		// they are read-only and the per-vault server_seq cursor already
		// bounds work per request.
		pr.With(httpx.RateLimitPerAccount(httpx.SyncPushLimit, httpx.SyncPushWindow)).
			Post("/v1/sync/push", syncH.Push)
		pr.Get("/v1/sync/pull", syncH.Pull)
		pr.Get("/v1/sync/snapshot", syncH.Snapshot)
		// M1 (sync v2 §5): advisory per-device author_seq summary so a
		// relay can ask "what is the server missing?" in one round trip.
		pr.Get("/v1/sync/vector", syncH.Vector)
	})

	// Background snapshot regeneration. Runs on its own dedicated 4-conn
	// Postgres pool so a slow snapshot replay can't starve the request path.
	// 5-minute tick interval is the plan default; tune via env if needed.
	go syncapi.StartSnapshotCron(ctx, snapshotPool, 5*time.Minute, snapshotMaxConns)

	// Background archive-purge. Scans vaults soft-archived for >30 days,
	// hard-deletes events + snapshots, revokes memberships, stamps
	// purged_at. Multi-replica safe via SELECT FOR UPDATE SKIP LOCKED.
	// Reuses the main pool — the work is I/O-light and runs once per
	// 6 hours, so a dedicated pool would be over-engineering.
	go vaults.StartArchivePurgeCron(ctx, pool, 6*time.Hour)

	srv := &http.Server{
		Addr:              ":" + cfg.BackendPort,
		Handler:           r,
		ReadHeaderTimeout: 10 * time.Second,
	}
	log.Printf("kaata-backend listening on :%s", cfg.BackendPort)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("server: %v", err)
	}
}

// loadMeshSigningMaterial reads MESH_SIGNING_PRIVKEY_PRIMARY +
// MESH_SIGNING_PUBKEY_PRIMARY (+ optional MESH_SIGNING_PUBKEY_ROTATION) from
// the env and validates them. Returns (nil, "", "") on any failure so main()
// can log a critical warning and continue with mesh disabled. We refuse to
// fatal-out because the rest of the backend (server sync, vault management,
// check-in, auth) keeps working without mesh — better to degrade than to
// brick the deployment over a misconfigured optional subsystem.
//
// Cross-check: we DERIVE the pubkey from the privkey and compare it against
// the announced MESH_SIGNING_PUBKEY_PRIMARY. A mismatch is operator error
// (e.g., copy-pasted halves from two different genkeypair runs) and would
// make every client refuse VMCs at handshake time without any visible
// backend symptom — we want to fail loud here. Treat as fatal because the
// only safe response is "don't issue VMCs at all", and there's nothing
// recoverable about a typo'd config.
// witnessVerifyKeys decodes the announced mesh signing pubkeys (primary +
// optional rotation) into the verification key set the sync push path pins
// for membership-event witness checks. Invalid entries are skipped —
// loadMeshSigningMaterial already validated/zeroed them and logged.
func witnessVerifyKeys(b64s ...string) []ed25519.PublicKey {
	keys := make([]ed25519.PublicKey, 0, len(b64s))
	for _, b64 := range b64s {
		if b64 == "" {
			continue
		}
		raw, err := base64.StdEncoding.DecodeString(b64)
		if err != nil || len(raw) != ed25519.PublicKeySize {
			continue
		}
		keys = append(keys, ed25519.PublicKey(raw))
	}
	return keys
}

func loadMeshSigningMaterial() (ed25519.PrivateKey, string, string) {
	privB64 := os.Getenv("MESH_SIGNING_PRIVKEY_PRIMARY")
	pubB64 := os.Getenv("MESH_SIGNING_PUBKEY_PRIMARY")
	rotB64 := os.Getenv("MESH_SIGNING_PUBKEY_ROTATION")
	if privB64 == "" || pubB64 == "" {
		return nil, "", ""
	}
	privRaw, err := base64.StdEncoding.DecodeString(privB64)
	if err != nil {
		log.Printf("MESH_SIGNING_PRIVKEY_PRIMARY is not standard base64: %v", err)
		return nil, "", ""
	}
	if len(privRaw) != ed25519.PrivateKeySize {
		log.Printf("MESH_SIGNING_PRIVKEY_PRIMARY decodes to %d bytes; expected %d", len(privRaw), ed25519.PrivateKeySize)
		return nil, "", ""
	}
	priv := ed25519.PrivateKey(privRaw)

	// Derive + compare. Use Public() so we don't double-rely on length checks.
	derived := base64.StdEncoding.EncodeToString(priv.Public().(ed25519.PublicKey))
	if derived != pubB64 {
		log.Fatalf("MESH_SIGNING_PUBKEY_PRIMARY does not match privkey's derived pubkey — config typo? Regenerate via `go run ./cmd/genkeypair`")
	}

	// Validate rotation pubkey shape if set.
	if rotB64 != "" {
		raw, err := base64.StdEncoding.DecodeString(rotB64)
		if err != nil {
			log.Printf("MESH_SIGNING_PUBKEY_ROTATION is not standard base64; ignoring: %v", err)
			rotB64 = ""
		} else if len(raw) != ed25519.PublicKeySize {
			log.Printf("MESH_SIGNING_PUBKEY_ROTATION decodes to %d bytes; expected %d (ignoring)", len(raw), ed25519.PublicKeySize)
			rotB64 = ""
		}
	}
	return priv, pubB64, rotB64
}
