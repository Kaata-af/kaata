// Package credit holds directional credit policy. Amounts are exact hundredths.
package credit

import (
	"context"
	"errors"
	"fmt"
	"math/big"

	"github.com/jackc/pgx/v5"
)

var ErrLimit = errors.New("credit_limit_exceeded")

type Policy struct {
	RelationshipID  string `json:"relationship_id"`
	MaxCollectMinor *int64 `json:"max_collect_minor"`
	MaxPayMinor     *int64 `json:"max_pay_minor"`
	Mode            string `json:"mode"`
	UpdatedAtMS     int64  `json:"updated_at_ms"`
}

func (p Policy) Valid() bool {
	if p.Mode != "warn" && p.Mode != "clerk_block" {
		return false
	}
	for _, n := range []*int64{p.MaxCollectMinor, p.MaxPayMinor} {
		if n != nil && (*n < 0 || *n > 999999999999) {
			return false
		}
	}
	return true
}

// Exceeded compares directional exposure, not absolute balance. A repayment
// remains lawful above a cap; crossing through zero can increase the other side.
func (p Policy) Exceeded(before, after int64) bool {
	return (p.MaxCollectMinor != nil && after > before && after > 0 && after > *p.MaxCollectMinor) ||
		(p.MaxPayMinor != nil && after < before && after < 0 && after < -*p.MaxPayMinor)
}

// Minor parses historical major-unit JSON numbers without float rounding.
func Minor(raw string) (int64, error) {
	r, ok := new(big.Rat).SetString(raw)
	if !ok {
		return 0, fmt.Errorf("invalid money")
	}
	r.Mul(r, big.NewRat(100, 1))
	if !r.IsInt() || !r.Num().IsInt64() {
		return 0, fmt.Errorf("inexact money")
	}
	return r.Num().Int64(), nil
}

// Lock serializes policy saves, event admission and shared-tab append for one
// kaata. Always acquire before vault/tab row locks, after account locks.
func Lock(ctx context.Context, tx pgx.Tx, vaultID string) error {
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, "credit-vault:"+vaultID)
	return err
}

func Read(ctx context.Context, tx pgx.Tx, vaultID, relationshipID string) (*Policy, error) {
	var p Policy
	err := tx.QueryRow(ctx, `SELECT relationship_id::text,max_collect_minor,max_pay_minor,mode,updated_at_ms FROM customer_credit_limits WHERE vault_id=$1::uuid AND relationship_id=$2::uuid`, vaultID, relationshipID).Scan(&p.RelationshipID, &p.MaxCollectMinor, &p.MaxPayMinor, &p.Mode, &p.UpdatedAtMS)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &p, nil
}

type BalanceReader func(context.Context, pgx.Tx, string, string) (int64, error)
