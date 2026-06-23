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
	// GoogleWebClientID: the OAuth2 Web client ID from Google Cloud Console.
	// Used as the AUDIENCE when verifying Google ID tokens posted to
	// /v1/auth/google. Mobile (via @react-native-google-signin) requests
	// tokens with this audience; the backend rejects any token where `aud`
	// doesn't match. NOT a secret — public string baked into the APK too.
	GoogleWebClientID string
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
		GoogleWebClientID:   os.Getenv("GOOGLE_WEB_CLIENT_ID"),
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
