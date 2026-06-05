package main

import (
	"context"
	"log"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/matee/kaata-backend/internal/auth"
	"github.com/matee/kaata-backend/internal/backup"
	"github.com/matee/kaata-backend/internal/checkin"
	"github.com/matee/kaata-backend/internal/config"
	"github.com/matee/kaata-backend/internal/db"
	"github.com/matee/kaata-backend/internal/httpx"
	"github.com/matee/kaata-backend/internal/visit"
)

func main() {
	cfg := config.Load()

	ctx := context.Background()
	pool, err := db.Open(ctx, cfg.PostgresURL)
	if err != nil {
		log.Fatalf("db open: %v", err)
	}
	defer pool.Close()

	if err := db.Migrate(ctx, pool); err != nil {
		log.Fatalf("migrate: %v", err)
	}

	checkinSvc := checkin.NewService(pool, cfg.MigrateToBackendURL)
	checkinH := checkin.NewHandler(checkinSvc)

	visitSvc := visit.NewService(pool, cfg.APKDownloadURL)
	visitH := visit.NewHandler(visitSvc)

	authSvc := auth.NewService(pool, cfg.GoogleWebClientID, cfg.SessionJWTSecret)
	authH := auth.NewHandler(authSvc)

	backupSvc := backup.NewService(pool)
	backupH := backup.NewHandler(backupSvc)

	r := chi.NewRouter()
	r.Use(httpx.Logger)
	r.Use(httpx.Recoverer)
	r.Use(httpx.CORS)

	r.Get("/v1/health", func(w http.ResponseWriter, _ *http.Request) {
		httpx.JSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	r.Post("/v1/check-in", checkinH.CheckIn)
	r.Post("/v1/visit", visitH.Visit)
	r.Get("/v1/download", visitH.Download)

	// Auth: public sign-in (no session yet), protected sign-out (validates
	// the session JWT via RequireSession middleware). Backup endpoints
	// also require a session — they live on the same protected subtree.
	r.Post("/v1/auth/google", authH.GoogleSignIn)
	r.Group(func(pr chi.Router) {
		pr.Use(auth.RequireSession(cfg.SessionJWTSecret))
		pr.Post("/v1/auth/signout", authH.SignOut)
		pr.Post("/v1/backup/upload", backupH.Upload)
		pr.Get("/v1/backup/latest", backupH.Latest)
	})

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
