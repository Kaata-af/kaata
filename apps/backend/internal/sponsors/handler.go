package sponsors

import "github.com/jackc/pgx/v5/pgxpool"

type Handler struct {
	pool *pgxpool.Pool
}

func NewHandler(pool *pgxpool.Pool) *Handler {
	return &Handler{pool: pool}
}
