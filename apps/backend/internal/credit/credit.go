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
	RestrictEditors bool   `json:"restrict_editors"`
	UpdatedAtMS     int64  `json:"updated_at_ms"`
}

// Restricts keeps credit authority separate from ledger write authority.
// Owners/admins remain exempt; warning policies never refuse a mutation.
func (p Policy) Restricts(role, override string) bool {
	if p.Mode != "clerk_block" || (role != "clerk" && role != "editor") {
		return false
	}
	switch override {
	case "bypass":
		return false
	case "enforce":
		return true
	default:
		return role == "clerk" || p.RestrictEditors
	}
}

// MemberOverride reads only the current accepted membership seat. A removed
// member's old exemption must not survive a later invitation into a new seat.
func MemberOverride(ctx context.Context, tx pgx.Tx, vaultID, accountID string) (string, error) {
	if accountID == "" {
		return "inherit", nil
	}
	var override string
	err := tx.QueryRow(ctx, `SELECT p.credit_limit_override
	 FROM vault_member_credit_permissions p JOIN vault_members m
	 ON m.id=p.vault_member_id AND m.vault_id=p.vault_id AND m.account_id=p.account_id
	 WHERE p.vault_id=$1::uuid AND p.account_id=$2::uuid
	 AND m.accepted_at IS NOT NULL AND m.revoked_at IS NULL`, vaultID, accountID).Scan(&override)
	if errors.Is(err, pgx.ErrNoRows) {
		return "inherit", nil
	}
	return override, err
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

// DefaultRelationshipID keys the kaata-wide default limit in
// customer_credit_limits: it covers every customer without their own policy,
// newly added ones included, so re-adding a customer as a new contact no longer
// escapes a limit (Matee, 2026-10-12). No relationship can have this id.
const DefaultRelationshipID = "00000000-0000-0000-0000-000000000000"

// Effective is the customer's own policy, else the kaata default, else nil.
func Effective(ctx context.Context, tx pgx.Tx, vaultID, relationshipID string) (*Policy, error) {
	p, err := Read(ctx, tx, vaultID, relationshipID)
	if err != nil || p != nil || relationshipID == DefaultRelationshipID {
		return p, err
	}
	return Read(ctx, tx, vaultID, DefaultRelationshipID)
}

func Read(ctx context.Context, tx pgx.Tx, vaultID, relationshipID string) (*Policy, error) {
	var p Policy
	err := tx.QueryRow(ctx, `SELECT relationship_id::text,max_collect_minor,max_pay_minor,mode,restrict_editors,updated_at_ms FROM customer_credit_limits WHERE vault_id=$1::uuid AND relationship_id=$2::uuid`, vaultID, relationshipID).Scan(&p.RelationshipID, &p.MaxCollectMinor, &p.MaxPayMinor, &p.Mode, &p.RestrictEditors, &p.UpdatedAtMS)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &p, nil
}

type BalanceReader func(context.Context, pgx.Tx, string, string) (int64, error)
