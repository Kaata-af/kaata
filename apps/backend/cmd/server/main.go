package main

import (
	"context"
	"log"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

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

	checkinSvc := checkin.NewService(pool, cfg.NextBackendURL)
	checkinH := checkin.NewHandler(checkinSvc)

	visitSvc := visit.NewService(pool, cfg.APKDownloadURL)
	visitH := visit.NewHandler(visitSvc)

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
