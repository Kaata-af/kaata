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
}

func Load() Config {
	_ = godotenv.Load()
	return Config{
		PostgresURL:         getenv("POSTGRES_URL", "postgres://kaata:kaata_dev@localhost:5432/kaata?sslmode=disable"),
		BackendPort:         getenv("BACKEND_PORT", "8080"),
		MigrateToBackendURL: os.Getenv("MIGRATE_TO_BACKEND_URL"),
		APKDownloadURL:      getenv("APK_DOWNLOAD_URL", "http://localhost:3000/downloads/kaata-0.1.0.apk"),
	}
}

func getenv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
