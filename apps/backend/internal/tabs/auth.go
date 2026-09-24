package tabs

// Shared accounts require a session. Party tokens are only invitation proofs
// on join/bind and are never accepted by the ledger read/write resolver.
// Directly bound accounts have party authority; other kaata members keep their
// viewer/clerk/editor/manager/owner permissions. X-Kaata-Party is only a selector.

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/matee/kaata-backend/internal/auth"
)

// Party is the resolved caller: which side of which tab, with the bindings
// the write routes need and the privilege the caller reaches it with.
type Party struct {
	TabID            string
	Role             string // 'a' | 'b'
	Label            string
	AccountID        *string
	VaultID          *string
	RelationshipID   *string
	JoinedAt         *time.Time
	AccountBoundOnce bool
	// MemberRole is "" when the caller holds the party token or IS the
	// bound account (full party rights); otherwise the caller's
	// vault_members.role in the party's kaata, which allows() ranks.
	MemberRole string
}

// Role ranks — roles v2 order, identical to sync.roleRank but declared here
// so tabs never imports sync (sync would then have to know about tabs for
// the poke and the two would cycle). Unknown roles rank 0 and fail closed.
var roleRank = map[string]int{"viewer": 1, "clerk": 2, "editor": 3, "manager": 4, "owner": 5}

const (
	// rankClerk gates append: a clerk writes new tallies into the book.
	rankClerk = 2
	// rankEditor gates accept / dispute / void / close / label / regenerate:
	// anything that changes the standing of what is already there.
	rankEditor = 3
)

// allows reports whether the caller may perform an action of the given
// minimum rank. Token callers and the bound account are unrestricted.
func (p Party) allows(minRank int) bool {
	if p.MemberRole == "" {
		return true
	}
	return roleRank[p.MemberRole] >= minRank
}

// Other is the counterparty's role.
func (p Party) Other() string { return otherRole(p.Role) }

// partyCols is the SELECT list both resolvers share.
const partyCols = `p.tab_id::text, p.role, p.label, p.account_id::text, p.vault_id::text,
	p.relationship_id::text, p.joined_at, p.account_bound_once`

// PartyByToken resolves a capability token. tabID "" skips the URL check
// (the /t/{token} page has no tab id). Every failure is ErrNotFound: unknown
// token, oversized token, token for another tab.
func (s *Service) PartyByToken(ctx context.Context, token, tabID string) (Party, error) {
	token = strings.TrimSpace(token)
	// Bound the sha256 work before hashing (vaults.InviteInfo discipline).
	if token == "" || len(token) > maxTokenLen {
		return Party{}, ErrNotFound
	}
	var p Party
	err := s.pool.QueryRow(ctx, `
		SELECT `+partyCols+` FROM tab_parties p WHERE p.token_hash = $1
	`, hashPartyToken(token)).Scan(&p.TabID, &p.Role, &p.Label, &p.AccountID, &p.VaultID, &p.RelationshipID, &p.JoinedAt, &p.AccountBoundOnce)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return Party{}, ErrNotFound
	case err != nil:
		return Party{}, fmt.Errorf("party by token: %w", err)
	}
	if tabID != "" && p.TabID != tabID {
		return Party{}, ErrNotFound
	}
	return p, nil
}

// PartyByAccount resolves a session account against one tab: the directly
// bound party first, else a party whose kaata the account is an active
// member of (with that membership's role). ErrNotFound when neither.
func (s *Service) PartyByAccount(ctx context.Context, tabID, accountID string) (Party, error) {
	return s.partyByAccountRole(ctx, tabID, accountID, "")
}

// A person can be a member of both parties' kaatas. The app supplies the
// side of its local contact; this is a selector, NEVER an authorization grant.
func (s *Service) partyByAccountRole(ctx context.Context, tabID, accountID, role string) (Party, error) {
	if role != "" && role != "a" && role != "b" {
		return Party{}, ErrNotFound
	}
	if _, err := uuid.Parse(tabID); err != nil {
		return Party{}, ErrNotFound
	}
	var (
		p          Party
		direct     bool
		memberRole string
	)
	// COALESCE on the boolean: `p.account_id = $2` is NULL for an unbound
	// party and DESC ordering puts NULLs FIRST in Postgres, which would rank
	// an unbound party above the caller's own.
	err := s.pool.QueryRow(ctx, `
		SELECT `+partyCols+`,
		       COALESCE(p.account_id = $2::uuid, FALSE),
		       COALESCE(vm.role, '')
		  FROM tab_parties p
		  LEFT JOIN vault_members vm
		         ON vm.vault_id = p.vault_id AND vm.account_id = $2::uuid
		        AND vm.accepted_at IS NOT NULL AND vm.revoked_at IS NULL
		 WHERE p.tab_id = $1::uuid AND (p.account_id = $2::uuid OR vm.id IS NOT NULL)
		   AND ($3 = '' OR p.role = $3)
		 ORDER BY COALESCE(p.account_id = $2::uuid, FALSE) DESC, p.role ASC
		 LIMIT 1
	`, tabID, accountID, role).Scan(&p.TabID, &p.Role, &p.Label, &p.AccountID, &p.VaultID, &p.RelationshipID, &p.JoinedAt, &p.AccountBoundOnce,
		&direct, &memberRole)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return Party{}, ErrNotFound
	case err != nil:
		return Party{}, fmt.Errorf("party by account: %w", err)
	}
	if !direct {
		p.MemberRole = memberRole
	}
	return p, nil
}

// touchParty stamps last_seen_at (and install_id from the session, when
// any) on every successful resolution. Best-effort and a separate statement
// on purpose: it must never fail a request or join a mutation's transaction.
func (s *Service) touchParty(ctx context.Context, p Party, installID *string) {
	if _, err := s.pool.Exec(ctx, `
		UPDATE tab_parties
		   SET last_seen_at = NOW(), install_id = COALESCE($3::uuid, install_id)
		 WHERE tab_id = $1::uuid AND role = $2
	`, p.TabID, p.Role, installID); err != nil {
		log.Printf("tabs: touch party %s/%s: %v", p.TabID, p.Role, err)
	}
}

// tabTokenFromHeader extracts the token from `Authorization: Tab <token>`
// (scheme case-insensitive). "" for any other scheme or an empty token, so a
// Bearer session header falls through to the claims path.
func tabTokenFromHeader(authz string) string {
	authz = strings.TrimSpace(authz)
	if len(authz) < 5 || !strings.EqualFold(authz[:4], "Tab ") {
		return ""
	}
	return strings.TrimSpace(authz[4:])
}

// installIDFromClaims returns the session's install id as a nullable uuid
// string, or nil for anonymous callers / a malformed claim.
func installIDFromClaims(claims *auth.SessionClaims) *string {
	if claims == nil {
		return nil
	}
	if _, err := uuid.Parse(claims.InstallID); err != nil {
		return nil
	}
	id := claims.InstallID
	return &id
}

// resolveParty applies the §3.2 order to one request and stamps the party.
// tabID is the URL's {tab_id} ("" for the /t/{token} page). ErrNotFound is
// the only failure a caller can see; database errors are wrapped.
func (h *Handler) resolveParty(r *http.Request, tabID string) (Party, error) {
	ctx := r.Context()
	claims, _ := auth.ClaimsFromContext(ctx)
	if claims == nil && strings.HasPrefix(strings.ToLower(r.Header.Get("Authorization")), "bearer ") {
		return Party{}, ErrAuthRequired
	}

	if claims != nil {
		p, err := h.svc.partyByAccountRole(ctx, tabID, claims.AccountID, r.Header.Get("X-Kaata-Party"))
		if err != nil {
			return Party{}, err
		}
		h.svc.touchParty(ctx, p, installIDFromClaims(claims))
		return p, nil
	}
	return Party{}, ErrNotFound
}
