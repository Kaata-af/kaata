package config

import (
	"os"
	"strings"

	"github.com/joho/godotenv"
)

type Config struct {
	PostgresURL string
	BackendPort string
	// MigrateToBackendURL: when set, every check-in response carries it. Mobile
	// clients persist it to their local `app_meta.backend_url_override` and
	// switch to it on the next launch. The way to soft-migrate domains
	// without forcing a re-install. Leave empty to signal "no migration."
	MigrateToBackendURL string
	// APKDownloadURL: target of the /v1/download 302 redirect. Set this to
	// wherever the current APK is hosted (e.g. https://kaata.af/downloads/
	// kaata-0.1.0.apk). Changing it requires only a backend env update —
	// QR codes pointing at /v1/download?s=... keep working.
	APKDownloadURL string
	// WebBaseURL: canonical public site origin (e.g. https://kaata.af). Used to
	// build shared-ledger links (kaata.af/v/<token>) + their OG preview URLs.
	WebBaseURL string
	// ShareLinkBaseURL: the origin used to BUILD the WhatsApp share link
	// (`url` in POST /v1/shared) and its og:url. Defaults to WebBaseURL
	// (kaata.af). Per-customer WhatsApp previews require the share link to
	// resolve to the backend's SSR page (GET /v/<token>); the backend already
	// serves that on its own domain, so setting this to the backend's public
	// origin (e.g. https://api.kaata.af) makes previews work WITHOUT routing
	// kaata.af/v/* to the backend. The page's chrome links still point at the
	// canonical site (WebBaseURL). Empty → fall back to WebBaseURL.
	ShareLinkBaseURL string
	// PublicAPIBaseURL: the backend's OWN public origin (e.g. https://api.kaata.af),
	// baked into the shared-ledger SSR page so its inline script fetches the
	// snapshot from an absolute URL. This lets kaata.af/v/<token> be the only path
	// that needs routing to the backend — the page then talks to the API directly
	// (CORS-enabled) instead of relying on kaata.af/v1/* also being proxied here.
	// Empty (default) → the script uses a relative /v1/... fetch, which is correct
	// for local dev (SSR + API are same-origin) or when /v1/* is proxied too.
	PublicAPIBaseURL string
	// GoogleWebClientID: the OAuth2 Web client ID from Google Cloud Console.
	// Used as the AUDIENCE when verifying Google ID tokens posted to
	// /v1/auth/google. Mobile (via @react-native-google-signin) requests
	// tokens with this audience; the backend rejects any token where `aud`
	// doesn't match. NOT a secret — public string baked into the APK too.
	GoogleWebClientID string
	// AppleClientID: the audience for Apple identity tokens posted to
	// /v1/auth/apple. For native Sign in with Apple on iOS this is the app's
	// bundle identifier and MUST match apps/mobile/app.json's
	// ios.bundleIdentifier. Rejects any token whose `aud` differs. Not a
	// secret. Load() defaults it to af.kaata.app when APPLE_CLIENT_ID is
	// unset, so the endpoint is always live — the empty-audience guards in
	// apple.go/service.go are defense-in-depth for direct callers, not an
	// env-reachable off switch.
	AppleClientID string
	// SessionJWTSecret: HMAC key for signing session JWTs we issue to mobile
	// after a successful Google sign-in. MUST be a long random string (>=
	// 32 bytes recommended) and MUST NOT be committed. Rotating it
	// invalidates all currently-issued sessions, forcing every user to
	// sign in again.
	SessionJWTSecret string
	// AdminAPIKey: operator-only shared secret guarding the /v1/admin/* analytics
	// endpoints. When empty, the admin routes return 404 (feature disabled) — so a
	// deployment without the key simply has no admin surface. Generate with
	// `openssl rand -hex 32` and set in the backend env (Dokploy).
	AdminAPIKey string
	// OperatorAccountIDs / OperatorIPs: analytics noise filter. Your OWN
	// signed-in account UUID(s) and home/office IP(s) are excluded from the
	// admin dashboard aggregates so test devices and reinstalls don't inflate
	// the funnel. Comma-separated env values. Excluded at QUERY time, so it's
	// retroactive (fixes already-recorded rows the moment you set it) and fully
	// reversible (clear the env → rows reappear). account_id is the robust key
	// because it survives reinstalls once you've signed in on a test device.
	OperatorAccountIDs []string
	OperatorIPs        []string
}

func Load() Config {
	_ = godotenv.Load()
	return Config{
		PostgresURL:         getenv("POSTGRES_URL", "postgres://kaata:kaata_dev@localhost:5432/kaata?sslmode=disable"),
		BackendPort:         getenv("BACKEND_PORT", "8080"),
		MigrateToBackendURL: os.Getenv("MIGRATE_TO_BACKEND_URL"),
		APKDownloadURL:      getenv("APK_DOWNLOAD_URL", "http://localhost:3000/downloads/kaata-0.1.0.apk"),
		WebBaseURL:          getenv("WEB_BASE_URL", "https://kaata.af"),
		ShareLinkBaseURL:    os.Getenv("SHARE_LINK_BASE_URL"),
		PublicAPIBaseURL:    os.Getenv("PUBLIC_API_BASE_URL"),
		GoogleWebClientID:   os.Getenv("GOOGLE_WEB_CLIENT_ID"),
		AppleClientID:       getenv("APPLE_CLIENT_ID", "af.kaata.app"),
		// Read from JWT_SECRET first (Phase 2 canonical name), falling back to
		// SESSION_JWT_SECRET for compatibility with v0.4 deployments that
		// haven't rotated their .env yet.
		SessionJWTSecret:   firstNonEmpty(os.Getenv("JWT_SECRET"), os.Getenv("SESSION_JWT_SECRET")),
		AdminAPIKey:        os.Getenv("ADMIN_API_KEY"),
		OperatorAccountIDs: splitCSV(os.Getenv("OPERATOR_ACCOUNT_IDS")),
		OperatorIPs:        splitCSV(os.Getenv("OPERATOR_IPS")),
	}
}

// splitCSV parses a comma-separated env value into a trimmed, non-empty slice.
// ALWAYS returns a non-nil slice (empty when unset) so pgx encodes it as an
// empty SQL array rather than NULL — `x <> ALL('{}')` excludes nothing, which is
// the safe default; `x <> ALL(NULL)` is NULL/false and would exclude everything.
func splitCSV(v string) []string {
	out := []string{}
	for _, p := range strings.Split(v, ",") {
		if t := strings.TrimSpace(p); t != "" {
			out = append(out, t)
		}
	}
	return out
}

func getenv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}
