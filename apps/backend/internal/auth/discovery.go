package auth

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/matee/kaata-backend/internal/httpx"
)

// DiscoverablePerson contains public identity fields and viewer-scoped search hints.
// Discovery defaults on for accounts; owners can turn it off in settings.
// Phone numbers and emails never appear in discovery responses.
type DiscoverablePerson struct {
	AccountID              string `json:"account_id"`
	Name                   string `json:"name"`
	Username               string `json:"username"`
	PictureURL             string `json:"picture_url"`
	ExistingRelationshipID string `json:"existing_relationship_id,omitempty"`
	IsFriend               bool   `json:"is_friend,omitempty"`
}

type PeopleSearchPage struct {
	People  []DiscoverablePerson `json:"people"`
	HasMore bool                 `json:"has_more"`
}

var errInvalidPeopleQuery = errors.New("search must contain 2 to 80 characters")
var errPeopleVault = errors.New("kaata not found")

func discoveryWords(query string) []string {
	return strings.FieldsFunc(query, func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsNumber(r) })
}

func escapeDiscoveryLike(query string) string {
	return strings.NewReplacer(`\`, `\\`, "%", `\%`, "_", `\_`).Replace(query)
}

func discoveryQuery(raw string) (query, prefix, phone string, err error) {
	query = strings.TrimSpace(foldDigits(raw))
	query = strings.TrimPrefix(query, "@")
	if n := utf8.RuneCountInString(query); n < 2 || n > 80 {
		return "", "", "", errInvalidPeopleQuery
	}
	looksPhone := true
	for _, r := range query {
		if !(unicode.IsDigit(r) || unicode.IsSpace(r) || strings.ContainsRune("+()-.", r)) {
			looksPhone = false
			break
		}
	}
	if looksPhone {
		// Never turn an incomplete phone into a name/username search.
		var valid bool
		phone, valid = NormalizeWebProfilePhone(query)
		if !valid {
			phone = "invalid"
		}
		return query, "", phone, nil
	}
	query = strings.ToLower(strings.NewReplacer("ي", "ی", "ى", "ی", "ك", "ک").Replace(query))
	words := discoveryWords(query)
	parts := make([]string, 0, len(words))
	for _, word := range words {
		parts = append(parts, word+":*")
	}
	prefix = strings.Join(parts, " & ")
	return query, prefix, "", nil
}

const discoveryDisplayName = `COALESCE(NULLIF(a.display_name,''),a.name,'')`
const discoveryNameText = `people_search_text(` + discoveryDisplayName + `)`
const discoveryNameVector = `to_tsvector('simple',` + discoveryNameText + `)`
const discoveryNameSound = `people_name_sound_keys(` + discoveryDisplayName + `)`

// Fuzzy matching is only for names across scripts. A mixed-script name may
// contain a Latin surname beside a Dari or Pashto given name, or vice versa.
func discoveryOtherNameScript(raw, query, phone string) string {
	if phone != "" || strings.HasPrefix(strings.TrimSpace(raw), "@") {
		return ""
	}
	var latin, arabic bool
	for _, r := range query {
		if !unicode.IsLetter(r) {
			continue
		}
		switch {
		case unicode.Is(unicode.Latin, r):
			latin = true
		case unicode.Is(unicode.Arabic, r):
			arabic = true
		default:
			return ""
		}
	}
	switch {
	case latin && arabic:
		return "[A-Za-zء-يٱ-ۓ]"
	case latin:
		return "[ء-يٱ-ۓ]"
	case arabic:
		return "[A-Za-z]"
	default:
		return ""
	}
}

func (s *Service) SearchPeople(ctx context.Context, accountID, raw string, vaultIDs ...string) (PeopleSearchPage, error) {
	vaultID := ""
	if len(vaultIDs) > 0 {
		vaultID = vaultIDs[0]
	}
	return s.SearchPeopleWithFriends(ctx, accountID, raw, vaultID, false)
}

// Including existing friends is an explicit client opt-in. It may match a
// private friend's name/username, but never their nonpublic phone number.
func (s *Service) SearchPeopleWithFriends(ctx context.Context, accountID, raw, vaultID string, includeFriends bool) (PeopleSearchPage, error) {
	page := PeopleSearchPage{People: []DiscoverablePerson{}}
	query, prefix, phone, err := discoveryQuery(raw)
	if err != nil {
		return page, err
	}
	if prefix == "" && phone == "" {
		return page, nil
	}
	if err := s.activeFriendViewer(ctx, accountID); err != nil {
		return page, err
	}
	if vaultID != "" {
		if _, err := uuid.Parse(vaultID); err != nil {
			return page, errPeopleVault
		}
		var allowed bool
		if err := s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM vault_members WHERE vault_id=$1::uuid AND account_id=$2::uuid AND accepted_at IS NOT NULL AND revoked_at IS NULL)`, vaultID, accountID).Scan(&allowed); err != nil {
			return page, err
		}
		if !allowed {
			return page, errPeopleVault
		}
	}
	like := escapeDiscoveryLike(query) + "%"
	otherScript := discoveryOtherNameScript(raw, query, phone)
	const directName = `(people_search_text(COALESCE(a.username,'')) LIKE $3 OR
 ` + discoveryNameVector + ` @@ to_tsquery('simple',NULLIF($5,'')))`
	const nameMatch = `(` + directName + ` OR ($8<>'' AND
 ` + discoveryNameSound + ` @> (SELECT keys FROM sounds) AND normalize(` + discoveryDisplayName + `, NFKD) ~ $8))`
	// Split public results from private friends so the public branch can use
	// the partial discovery indexes and the private branch starts with friends.
	rows, err := s.pool.Query(ctx, `WITH sounds AS (
 SELECT CASE WHEN $8<>'' THEN people_name_sound_keys($2,true) END AS keys
 ), matches AS (
 SELECT a.* FROM accounts a WHERE a.discovery_enabled AND a.disabled_at IS NULL AND a.pending_delete_at IS NULL
 AND (($4<>'' AND a.phone_e164=$4) OR ($4='' AND `+nameMatch+`))
 UNION ALL
 SELECT a.* FROM account_friendships friend JOIN accounts a ON a.id=CASE
 WHEN friend.account_low_id=$1::uuid THEN friend.account_high_id ELSE friend.account_low_id END
 WHERE $7 AND $4='' AND friend.status='accepted'
 AND (friend.account_low_id=$1::uuid OR friend.account_high_id=$1::uuid)
 AND NOT a.discovery_enabled AND a.disabled_at IS NULL AND a.pending_delete_at IS NULL AND `+nameMatch+`
 )
 SELECT a.id::text, `+discoveryDisplayName+`,COALESCE(a.username,''),COALESCE(a.picture_url,''),
 COALESCE((SELECT CASE WHEN g.a_vault_id=NULLIF($6,'')::uuid THEN g.a_relationship_id ELSE g.b_relationship_id END::text
 FROM tab_groups g LEFT JOIN people_requests r ON r.group_id=g.id
 WHERE (g.a_vault_id=NULLIF($6,'')::uuid AND (g.b_account_id=a.id OR (g.b_account_id IS NULL AND r.recipient_account_id=a.id)))
 OR (g.b_vault_id=NULLIF($6,'')::uuid AND g.a_account_id=a.id)
 ORDER BY (g.closed_at IS NULL) DESC,g.created_at DESC,g.id DESC LIMIT 1),''), f.id IS NOT NULL
 FROM matches a LEFT JOIN account_friendships f ON f.account_low_id=LEAST(a.id,$1::uuid) AND f.account_high_id=GREATEST(a.id,$1::uuid) AND f.status='accepted'
 WHERE a.id<>$1::uuid
 AND EXISTS(SELECT 1 FROM accounts viewer WHERE viewer.id=$1::uuid AND viewer.disabled_at IS NULL AND viewer.pending_delete_at IS NULL)
 ORDER BY CASE WHEN people_search_text(a.username)=$2 THEN 0
 WHEN `+discoveryNameText+`=$2 THEN 1 WHEN `+directName+` THEN 2 ELSE 3 END,
 `+discoveryNameText+`,a.id LIMIT 21`, accountID, query, like, phone, prefix, vaultID, includeFriends, otherScript)
	if err != nil {
		return page, err
	}
	defer rows.Close()
	for rows.Next() {
		var person DiscoverablePerson
		if err := rows.Scan(&person.AccountID, &person.Name, &person.Username, &person.PictureURL, &person.ExistingRelationshipID, &person.IsFriend); err != nil {
			return page, err
		}
		page.People = append(page.People, person)
	}
	if err := rows.Err(); err != nil {
		return page, err
	}
	if len(page.People) > 20 {
		page.People = page.People[:20]
		page.HasMore = true
	}
	return page, nil
}

const peoplePreviewLimit = 10

// SearchPeoplePreview is the public directory preview for local-only installs.
// Only opted-in active accounts can match. Phone lookup and viewer-scoped
// details require an authenticated search.
func (s *Service) SearchPeoplePreview(ctx context.Context, raw string) (PeopleSearchPage, error) {
	page := PeopleSearchPage{People: []DiscoverablePerson{}}
	query, prefix, phone, err := discoveryQuery(raw)
	if err != nil {
		return page, err
	}
	if prefix == "" || phone != "" {
		return page, nil
	}
	like := escapeDiscoveryLike(query)
	if utf8.RuneCountInString(query) >= 3 {
		like += "%"
	}
	// Short words can match exact display names. Require a real three-character
	// term for prefix matching so punctuation cannot turn "a!!" into "a:*".
	namePrefix := false
	for _, word := range discoveryWords(query) {
		if utf8.RuneCountInString(word) >= 3 {
			namePrefix = true
			break
		}
	}
	otherScript := discoveryOtherNameScript(raw, query, phone)
	const directName = `(people_search_text(COALESCE(a.username,'')) LIKE $2 OR (
 ` + discoveryNameVector + ` @@ to_tsquery('simple',$3) AND ($4 OR ` + discoveryNameText + `=$1)))`
	rows, err := s.pool.Query(ctx, `WITH sounds AS (
 SELECT CASE WHEN $6<>'' THEN people_name_sound_keys($1,true) END AS keys
 )
 SELECT a.id::text,`+discoveryDisplayName+`,
 COALESCE(a.username,''),COALESCE(a.picture_url,'')
 FROM accounts a WHERE a.discovery_enabled AND a.disabled_at IS NULL AND a.pending_delete_at IS NULL
 AND (`+directName+` OR ($6<>'' AND `+discoveryNameSound+` @> (SELECT keys FROM sounds)
 AND normalize(`+discoveryDisplayName+`, NFKD) ~ $6))
 ORDER BY CASE WHEN people_search_text(a.username)=$1 THEN 0
 WHEN `+discoveryNameText+`=$1 THEN 1 WHEN `+directName+` THEN 2 ELSE 3 END,
 `+discoveryNameText+`,a.id LIMIT $5`, query, like, prefix, namePrefix, peoplePreviewLimit+1, otherScript)
	if err != nil {
		return page, err
	}
	defer rows.Close()
	for rows.Next() {
		var person DiscoverablePerson
		if err := rows.Scan(&person.AccountID, &person.Name, &person.Username, &person.PictureURL); err != nil {
			return page, err
		}
		page.People = append(page.People, person)
	}
	if err := rows.Err(); err != nil {
		return page, err
	}
	if len(page.People) > peoplePreviewLimit {
		page.People = page.People[:peoplePreviewLimit]
		page.HasMore = true
	}
	return page, nil
}

func (h *Handler) SearchPeoplePreview(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	page, err := h.svc.SearchPeoplePreview(r.Context(), r.URL.Query().Get("q"))
	if errors.Is(err, errInvalidPeopleQuery) {
		httpx.ErrorCode(w, 400, "invalid_search", err.Error())
		return
	}
	if err != nil {
		httpx.Error(w, 500, "people search unavailable")
		return
	}
	httpx.JSON(w, 200, page)
}

func (h *Handler) SearchPeople(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	claims, ok := ClaimsFromContext(r.Context())
	if !ok || claims == nil {
		httpx.Error(w, 401, "authentication required")
		return
	}
	page, err := h.svc.SearchPeopleWithFriends(r.Context(), claims.AccountID, r.URL.Query().Get("q"), r.URL.Query().Get("vault_id"), r.URL.Query().Get("include_friends") == "1")
	if errors.Is(err, ErrSessionRevoked) {
		writeFriendError(w, err)
		return
	}
	if errors.Is(err, errPeopleVault) {
		httpx.Error(w, 404, err.Error())
		return
	}
	if errors.Is(err, errInvalidPeopleQuery) {
		httpx.ErrorCode(w, 400, "invalid_search", err.Error())
		return
	}
	if err != nil {
		httpx.Error(w, 500, "people search unavailable")
		return
	}
	httpx.JSON(w, 200, page)
}

func (s *Service) SetDiscovery(ctx context.Context, account string, enabled bool) error {
	tag, err := s.pool.Exec(ctx, `UPDATE accounts SET discovery_enabled=$2 WHERE id=$1::uuid AND disabled_at IS NULL AND pending_delete_at IS NULL`, account, enabled)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrSessionRevoked
	}
	return nil
}

func (h *Handler) SetDiscovery(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	claims, ok := ClaimsFromContext(r.Context())
	if !ok || claims == nil {
		httpx.Error(w, 401, "authentication required")
		return
	}
	var req struct {
		Enabled *bool `json:"enabled"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1024)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Enabled == nil {
		httpx.ErrorCode(w, 400, "invalid_body", "enabled is required")
		return
	}
	if err := h.svc.SetDiscovery(r.Context(), claims.AccountID, *req.Enabled); err != nil {
		writeAccountError(w, "account/discovery", claims.InstallID, err)
		return
	}
	httpx.JSON(w, 200, map[string]bool{"discovery_enabled": *req.Enabled})
}
