package config

import (
	"os"

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
}

func Load() Config {
	_ = godotenv.Load()
	return Config{
		PostgresURL:         getenv("POSTGRES_URL", "postgres://kaata:kaata_dev@localhost:5432/kaata?sslmode=disable"),
		BackendPort:         getenv("BACKEND_PORT", "8080"),
		MigrateToBackendURL: os.Getenv("MIGRATE_TO_BACKEND_URL"),
		APKDownloadURL:      getenv("APK_DOWNLOAD_URL", "http://localhost:3000/downloads/kaata-0.1.0.apk"),
		GoogleWebClientID:   os.Getenv("GOOGLE_WEB_CLIENT_ID"),
		// Read from JWT_SECRET first (Phase 2 canonical name), falling back to
		// SESSION_JWT_SECRET for compatibility with v0.4 deployments that
		// haven't rotated their .env yet.
		SessionJWTSecret: firstNonEmpty(os.Getenv("JWT_SECRET"), os.Getenv("SESSION_JWT_SECRET")),
	}
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
