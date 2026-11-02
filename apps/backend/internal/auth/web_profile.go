package auth

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/matee/kaata-backend/internal/httpx"
	"github.com/nyaruka/phonenumbers"
)

// WebProfile is the account's own identity, never a shared kaata owner's
// profile. A provider name may prefill the form, but needs confirmation before
// it completes setup. Native self profiles already supply that confirmation.
type WebProfile struct {
	Name         string `json:"name"`
	Phone        string `json:"phone"`
	ShopName     string `json:"shop_name"`
	NeedsSetup   bool   `json:"needs_setup"`
	HasOnboarded bool   `json:"has_onboarded"`
}

type ownProfileState struct {
	WebProfile
	confirmedName bool
	hasBook       bool
	bookName      string
	completedWeb  bool
}

func validWebProfileName(raw string) (string, bool) {
	name := sanitizeDisplayName(raw)
	n := utf8.RuneCountInString(name)
	return name, n >= 2 && n <= 60
}

var webProfilePhoneShape = regexp.MustCompile(`^\+[1-9][0-9]{6,14}$`)

// NormalizeWebProfilePhone mirrors mobile's permissive E.164 shape policy:
// parse national prefixes with the pinned numbering metadata, without claiming
// that a number is assigned, reachable, or verified. Unprefixed input is Afghan.
func NormalizeWebProfilePhone(raw string) (string, bool) {
	if len(raw) > 128 {
		return "", false
	}
	var b strings.Builder
	for _, r := range strings.TrimSpace(raw) {
		switch {
		case r >= '۰' && r <= '۹':
			b.WriteRune('0' + r - '۰')
		case r >= '٠' && r <= '٩':
			b.WriteRune('0' + r - '٠')
		case r >= '0' && r <= '9', r == '+':
			b.WriteRune(r)
		case unicode.IsSpace(r), r == '-', r == '(', r == ')', r == '.':
		default:
			return "", false
		}
	}
	value := b.String()
	if strings.HasPrefix(value, "00") {
		value = "+" + value[2:]
	}
	if value == "" || strings.Contains(value[1:], "+") {
		return "", false
	}
	explicit := strings.HasPrefix(value, "+")
	parsed, err := phonenumbers.Parse(value, "AF")
	if err == nil {
		value = phonenumbers.Format(parsed, phonenumbers.E164)
	} else if !explicit {
		value = "+93" + strings.TrimPrefix(value, "0")
	}
	return value, webProfilePhoneShape.MatchString(value)
}

// ReadOwnWebProfiles is shared by the authenticated web profile and the admin
// report. It batches account IDs and never repairs mobile installation history.
// The caller supplies proven account IDs inside its own transaction.
func ReadOwnWebProfiles(ctx context.Context, tx pgx.Tx, accountIDs []string) (map[string]WebProfile, error) {
	return readOwnWebProfiles(ctx, tx, accountIDs, nil, nil)
}

// ReadOwnWebProfilesFromSources uses the same own-account evidence while
// limiting device and book fallbacks to sources retained by a report. An empty
// slice permits no sources; nil permits all sources, as ReadOwnWebProfiles does.
// This keeps excluded test devices and books out of operator outreach.
func ReadOwnWebProfilesFromSources(ctx context.Context, tx pgx.Tx, accountIDs, installIDs, vaultIDs []string) (map[string]WebProfile, error) {
	return readOwnWebProfiles(ctx, tx, accountIDs, installIDs, vaultIDs)
}

func readOwnWebProfiles(ctx context.Context, tx pgx.Tx, accountIDs, installIDs, vaultIDs []string) (map[string]WebProfile, error) {
	out := make(map[string]WebProfile, len(accountIDs))
	if len(accountIDs) == 0 {
		return out, nil
	}
	states := make(map[string]*ownProfileState, len(accountIDs))
	rows, err := tx.Query(ctx, `SELECT id::text, COALESCE(display_name,''), COALESCE(name,''), COALESCE(phone_e164,'')
		FROM accounts WHERE id=ANY($1::uuid[]) AND disabled_at IS NULL AND pending_delete_at IS NULL`, accountIDs)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var id, explicit, provider, phone string
		if err := rows.Scan(&id, &explicit, &provider, &phone); err != nil {
			rows.Close()
			return nil, err
		}
		state := &ownProfileState{}
		if name, valid := validWebProfileName(explicit); valid {
			state.Name, state.confirmedName = name, true
		} else if name, valid := validWebProfileName(provider); valid {
			state.Name = name
		}
		if normalized, valid := NormalizeWebProfilePhone(phone); valid {
			state.Phone = normalized
		}
		states[id] = state
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// Only the account's own current native binding is identity evidence. A
	// browser session's old telemetry or another account's shared ledger is not.
	rows, err = tx.Query(ctx, `SELECT COALESCE(i.account_id,c.account_id)::text,
		COALESCE(i.self_name,''), COALESCE(i.self_phone,''), COALESCE(i.shop_name,''),
		CASE WHEN COALESCE(i.platform,'') IN ('','unknown') AND i.app_version='web' THEN 'web' ELSE i.platform END
		FROM installs i LEFT JOIN LATERAL (
		  SELECT MIN(account_id::text)::uuid AS account_id FROM auth_credentials
		  WHERE install_id=i.install_id AND revoked_at IS NULL AND account_id IS NOT NULL
		  HAVING COUNT(DISTINCT account_id)=1
		) c ON i.account_id IS NULL
		WHERE COALESCE(i.account_id,c.account_id)=ANY($1::uuid[]) AND i.account_deleted_at IS NULL
		AND (i.platform IN ('ios','android','web') OR (COALESCE(i.platform,'') IN ('','unknown') AND i.app_version='web'))
		AND i.has_onboarded AND ($2::uuid[] IS NULL OR i.install_id=ANY($2::uuid[]))
		ORDER BY i.last_seen_at DESC NULLS LAST, i.install_id`, accountIDs, installIDs)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var id, name, phone, shop, platform string
		if err := rows.Scan(&id, &name, &phone, &shop, &platform); err != nil {
			rows.Close()
			return nil, err
		}
		state := states[id]
		if state == nil {
			continue
		}
		if platform == "web" {
			// Completion is historical for this proven account binding, like
			// mobile's latch. Browser self fields do not confirm profile values.
			state.completedWeb = true
			continue
		}
		if !state.confirmedName {
			if name, valid := validWebProfileName(name); valid {
				state.Name, state.confirmedName = name, true
			}
		}
		if state.Phone == "" {
			if phone, valid := NormalizeWebProfilePhone(phone); valid {
				state.Phone = phone
			}
		}
		if state.ShopName == "" {
			state.ShopName = strings.TrimSpace(shop)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	rows, err = tx.Query(ctx, `SELECT vm.account_id::text, v.name,
		(vm.role='owner' AND v.owner_account_id=vm.account_id)
		FROM vault_members vm JOIN vaults v ON v.vault_id=vm.vault_id
		WHERE vm.account_id=ANY($1::uuid[]) AND vm.accepted_at IS NOT NULL AND vm.revoked_at IS NULL AND v.purged_at IS NULL
		AND ($2::uuid[] IS NULL OR v.vault_id=ANY($2::uuid[]))
		ORDER BY v.created_at, v.vault_id`, accountIDs, vaultIDs)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var id, name string
		var owned bool
		if err := rows.Scan(&id, &name, &owned); err != nil {
			rows.Close()
			return nil, err
		}
		if state := states[id]; state != nil {
			state.hasBook = true
			if owned && state.bookName == "" {
				state.bookName = strings.TrimSpace(name)
			}
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	var missing []string
	for id, state := range states {
		if !state.confirmedName || state.Phone == "" || state.ShopName == "" {
			missing = append(missing, id)
		}
	}
	if len(missing) > 0 {
		// Extract only own-profile fragments, not customers or tally contents.
		// Owner-only membership prevents a clerk's first visit inheriting their
		// employer's identity. Malformed optional fragments are ignored.
		rows, err = tx.Query(ctx, `SELECT v.owner_account_id::text, s.snapshot->'shop_profile',
			COALESCE((SELECT jsonb_agg(u) FROM jsonb_array_elements(
			  CASE WHEN jsonb_typeof(s.snapshot->'users')='array' THEN s.snapshot->'users' ELSE '[]'::jsonb END) u
			  WHERE u->>'is_local_self'='1' AND u->>'account_id'=v.owner_account_id::text), '[]'::jsonb)
			FROM vaults v JOIN vault_members vm ON vm.vault_id=v.vault_id AND vm.account_id=v.owner_account_id
			JOIN LATERAL (SELECT snapshot FROM vault_snapshots WHERE vault_id=v.vault_id ORDER BY up_to_server_seq DESC LIMIT 1) s ON TRUE
			WHERE v.owner_account_id=ANY($1::uuid[]) AND vm.role='owner' AND vm.accepted_at IS NOT NULL AND vm.revoked_at IS NULL AND v.purged_at IS NULL
			AND ($2::uuid[] IS NULL OR v.vault_id=ANY($2::uuid[]))
			ORDER BY v.created_at, v.vault_id`, missing, vaultIDs)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var id string
			var shopRaw, usersRaw []byte
			if err := rows.Scan(&id, &shopRaw, &usersRaw); err != nil {
				rows.Close()
				return nil, err
			}
			state := states[id]
			if state == nil {
				continue
			}
			var shop struct {
				OwnerName string `json:"owner_name"`
				ShopName  string `json:"shop_name"`
			}
			if json.Unmarshal(shopRaw, &shop) == nil {
				if !state.confirmedName {
					if name, valid := validWebProfileName(shop.OwnerName); valid {
						state.Name, state.confirmedName = name, true
					}
				}
				if state.ShopName == "" {
					state.ShopName = strings.TrimSpace(shop.ShopName)
				}
			}
			var users []struct {
				Name  string `json:"display_name"`
				Phone string `json:"phone_e164"`
			}
			if json.Unmarshal(usersRaw, &users) == nil {
				for _, user := range users {
					if !state.confirmedName {
						if name, valid := validWebProfileName(user.Name); valid {
							state.Name, state.confirmedName = name, true
						}
					}
					if state.Phone == "" {
						if phone, valid := NormalizeWebProfilePhone(user.Phone); valid {
							state.Phone = phone
						}
					}
				}
			}
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
	}
	for id, state := range states {
		if state.ShopName == "" {
			state.ShopName = state.bookName
		}
		state.NeedsSetup = !state.confirmedName || state.Phone == ""
		state.HasOnboarded = state.completedWeb || !state.NeedsSetup && state.hasBook
		out[id] = state.WebProfile
	}
	return out, nil
}

// lockWebSession follows the shared account-before-install lock order, then
// holds the exact credential through commit. Cached middleware cannot authorize
// a stale profile edit after sign-out, rebinding, deletion or epoch rotation.
func lockWebSession(ctx context.Context, tx pgx.Tx, claims *SessionClaims) (string, error) {
	if claims == nil {
		return "", ErrSessionRevoked
	}
	var id, platform string
	err := tx.QueryRow(ctx, `SELECT id::text FROM accounts WHERE id=$1::uuid AND pending_delete_at IS NULL AND disabled_at IS NULL FOR UPDATE`, claims.AccountID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrSessionRevoked
	}
	if err != nil {
		return "", err
	}
	err = tx.QueryRow(ctx, `SELECT COALESCE(platform,'') FROM installs WHERE install_id=$1::uuid AND account_id=$2::uuid AND account_deleted_at IS NULL FOR UPDATE`, claims.InstallID, claims.AccountID).Scan(&platform)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrSessionRevoked
	}
	if err != nil {
		return "", err
	}
	err = tx.QueryRow(ctx, `SELECT install_id::text FROM auth_credentials WHERE install_id=$1::uuid AND provider=$2
		AND provider_sub=$3 AND COALESCE(account_id,$4::uuid)=$4::uuid AND session_epoch=$5 AND revoked_at IS NULL FOR SHARE`,
		claims.InstallID, claims.Provider, claims.ProviderSub, claims.AccountID, claims.Epoch).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrSessionRevoked
	}
	if err != nil {
		return "", err
	}
	return strings.ToLower(strings.TrimSpace(platform)), nil
}

func browserProfilePlatform(platform string) bool {
	return platform == "web" || platform == "unknown" || platform == ""
}

func syncWebInstallProfile(ctx context.Context, tx pgx.Tx, installID string, profile WebProfile) error {
	// Current account data replaces a browser's stale profile after account
	// switching. Known native rows never enter this path.
	_, err := tx.Exec(ctx, `UPDATE installs SET
		self_name=CASE WHEN $2 THEN NULL ELSE NULLIF($3,'') END,
		self_phone=CASE WHEN $2 THEN NULL ELSE NULLIF($4,'') END,
		shop_name=NULLIF($5,''), has_onboarded=$6 WHERE install_id=$1::uuid`,
		installID, profile.NeedsSetup, profile.Name, profile.Phone, profile.ShopName, profile.HasOnboarded)
	return err
}

var errInvalidWebProfileName = errors.New("invalid web profile name")
var errInvalidWebProfilePhone = errors.New("invalid web profile phone")

func (s *Service) WebProfile(ctx context.Context, claims *SessionClaims) (WebProfile, error) {
	return s.webProfile(ctx, claims, nil)
}

func (s *Service) SaveWebProfile(ctx context.Context, claims *SessionClaims, name, phone string) (WebProfile, error) {
	name, valid := validWebProfileName(name)
	if !valid {
		return WebProfile{}, errInvalidWebProfileName
	}
	phone, valid = NormalizeWebProfilePhone(phone)
	if !valid {
		return WebProfile{}, errInvalidWebProfilePhone
	}
	return s.webProfile(ctx, claims, &WebProfile{Name: name, Phone: phone})
}

func (s *Service) webProfile(ctx context.Context, claims *SessionClaims, saved *WebProfile) (WebProfile, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return WebProfile{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	platform, err := lockWebSession(ctx, tx, claims)
	if err != nil {
		return WebProfile{}, err
	}
	if saved != nil {
		if _, err := tx.Exec(ctx, `UPDATE accounts SET display_name=$2,phone_e164=$3 WHERE id=$1::uuid`, claims.AccountID, saved.Name, saved.Phone); err != nil {
			return WebProfile{}, err
		}
	}
	profiles, err := ReadOwnWebProfiles(ctx, tx, []string{claims.AccountID})
	if err != nil {
		return WebProfile{}, err
	}
	profile := profiles[claims.AccountID]
	if browserProfilePlatform(platform) {
		if err := syncWebInstallProfile(ctx, tx, claims.InstallID, profile); err != nil {
			return WebProfile{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return WebProfile{}, err
	}
	return profile, nil
}

func (h *Handler) GetWebProfile(w http.ResponseWriter, r *http.Request) { h.webProfile(w, r, false) }
func (h *Handler) PutWebProfile(w http.ResponseWriter, r *http.Request) { h.webProfile(w, r, true) }

func (h *Handler) webProfile(w http.ResponseWriter, r *http.Request, save bool) {
	w.Header().Set("Cache-Control", "no-store")
	claims, ok := ClaimsFromContext(r.Context())
	if !ok || claims == nil {
		httpx.ErrorCode(w, http.StatusUnauthorized, "session_expired", "session has ended; sign in again")
		return
	}
	var profile WebProfile
	var err error
	if save {
		var req struct {
			Name  string `json:"name"`
			Phone string `json:"phone"`
		}
		if !decodeBody(w, r, &req) {
			return
		}
		profile, err = h.svc.SaveWebProfile(r.Context(), claims, req.Name, req.Phone)
	} else {
		profile, err = h.svc.WebProfile(r.Context(), claims)
	}
	if err != nil {
		switch {
		case errors.Is(err, ErrSessionRevoked):
			httpx.ErrorCode(w, http.StatusUnauthorized, "session_expired", "session has ended; sign in again")
		case errors.Is(err, errInvalidWebProfileName):
			httpx.ErrorCode(w, http.StatusBadRequest, "invalid_name", "enter a name between 2 and 60 characters")
		case errors.Is(err, errInvalidWebProfilePhone):
			httpx.ErrorCode(w, http.StatusBadRequest, "invalid_phone", "enter a valid phone number with its country code")
		default:
			httpx.ErrorCode(w, http.StatusServiceUnavailable, "profile_unavailable", "profile unavailable; try again")
		}
		return
	}
	httpx.JSON(w, http.StatusOK, profile)
}
