package config

import (
	"os"

	"github.com/joho/godotenv"
)

type Config struct {
	PostgresURL string
	BackendPort string
}

func Load() Config {
	_ = godotenv.Load()
	return Config{
		PostgresURL: getenv("POSTGRES_URL", "postgres://kaata:kaata_dev@localhost:5432/kaata?sslmode=disable"),
		BackendPort: getenv("BACKEND_PORT", "8080"),
	}
}

func getenv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
