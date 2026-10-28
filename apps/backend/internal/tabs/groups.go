package tabs

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/matee/kaata-backend/internal/credit"
)

var (
	ErrGroupChanged         = errors.New("shared account changed; refresh before retrying")
	ErrGroupCurrencyHistory = errors.New("this currency has existing history; link it with a validated opening before sharing")
	ErrGroupOperation       = errors.New("manage all currencies through the shared account")
)

type GroupCurrencyInput struct {
	Currency                 string           `json:"currency"`
	Opening                  *OpeningInput    `json:"opening"`
	LinkedAtMS               *int64           `json:"linked_at_ms,omitempty"`
	ExpectedPreviousTabID    *string          `json:"expected_previous_tab_id,omitempty"`
	ExpectedPreviousRev      *int64           `json:"expected_previous_rev,omitempty"`
	ExpectedHistoryRevisions map[string]int64 `json:"expected_history_revisions,omitempty"`
}
type GroupCreateInput struct {
	RequestID      string               `json:"request_id"`
	InviteToken    string               `json:"invite_token"`
	RecordingMode  string               `json:"recording_mode"`
	Label          string               `json:"label"`
	VaultID        string               `json:"vault_id"`
	RelationshipID string               `json:"relationship_id"`
	Currencies     []GroupCurrencyInput `json:"currencies"`
	AccountID      string               `json:"-"`
	InstallID      *string              `json:"-"`
}
type GroupJoinInput struct {
	Token          string               `json:"token"`
	Label          string               `json:"label"`
	VaultID        string               `json:"vault_id"`
	RelationshipID string               `json:"relationship_id"`
	Currencies     []GroupCurrencyInput `json:"currencies"`
	AccountID      string               `json:"-"`
	InstallID      *string              `json:"-"`
}
type GroupPartyMeta struct {
	PartyMeta
	VaultID        *string `json:"vault_id"`
	RelationshipID *string `json:"relationship_id"`
}
type GroupMeta struct {
	ID            string                    `json:"id"`
	RecordingMode string                    `json:"recording_mode"`
	Rev           int64                     `json:"rev"`
	CreatedAtMS   int64                     `json:"created_at_ms"`
	ClosedAtMS    *int64                    `json:"closed_at_ms"`
	ClosedBy      *string                   `json:"closed_by"`
	You           string                    `json:"you"`
	Currencies    []string                  `json:"currencies"`
	Parties       map[string]GroupPartyMeta `json:"parties"`
}
type GroupResponse struct {
	Group     GroupMeta     `json:"group"`
	Tabs      []TabResponse `json:"tabs"`
	InviteURL string        `json:"invite_url,omitempty"`
}
type groupRow struct {
	ID, Mode, InviteHash, RequestHash              string
	Rev                                            int64
	Created                                        time.Time
	Closed                                         *time.Time
	ClosedBy                                       *string
	AAccount, AVault, ARel, BAccount, BVault, BRel *string
	BJoined                                        *time.Time
	BClaimed                                       bool
}

func loadGroup(ctx context.Context, q querier, id string, lock bool) (groupRow, error) {
	var g groupRow
	if _, err := uuid.Parse(id); err != nil {
		return g, ErrNotFound
	}
	suffix := ""
	if lock {
		suffix = " FOR UPDATE"
	}
	err := q.QueryRow(ctx, `SELECT id::text,recording_mode,invite_token_hash,request_hash,rev,created_at,closed_at,closed_by,
 a_account_id::text,a_vault_id::text,a_relationship_id::text,b_account_id::text,b_vault_id::text,b_relationship_id::text,b_joined_at,b_account_bound_once
 FROM tab_groups WHERE id=$1::uuid`+suffix, id).Scan(&g.ID, &g.Mode, &g.InviteHash, &g.RequestHash, &g.Rev, &g.Created, &g.Closed, &g.ClosedBy, &g.AAccount, &g.AVault, &g.ARel, &g.BAccount, &g.BVault, &g.BRel, &g.BJoined, &g.BClaimed)
	if errors.Is(err, pgx.ErrNoRows) {
		return g, ErrNotFound
	}
	return g, err
}
func groupTabIDs(ctx context.Context, q querier, id string) ([]string, error) {
	rows, err := q.Query(ctx, `SELECT id::text FROM tabs WHERE group_id=$1::uuid ORDER BY currency,id`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := []string{}
	for rows.Next() {
		var v string
		if err := rows.Scan(&v); err != nil {
			return nil, err
		}
		ids = append(ids, v)
	}
	return ids, rows.Err()
}
func groupResponse(ctx context.Context, q querier, g groupRow, role string) (GroupResponse, error) {
	ids, err := groupTabIDs(ctx, q, g.ID)
	if err != nil {
		return GroupResponse{}, err
	}
	if len(ids) == 0 {
		return GroupResponse{}, ErrNotFound
	}
	out := GroupResponse{Group: GroupMeta{ID: g.ID, RecordingMode: g.Mode, Rev: g.Rev, CreatedAtMS: g.Created.UnixMilli(), ClosedAtMS: msPtr(g.Closed), ClosedBy: g.ClosedBy, You: role, Currencies: []string{}}, Tabs: []TabResponse{}}
	for _, id := range ids {
		r, err := fullResponse(ctx, q, id, role)
		if err != nil {
			return GroupResponse{}, err
		}
		out.Tabs = append(out.Tabs, r)
		out.Group.Currencies = append(out.Group.Currencies, r.Tab.Currency)
	}
	p := out.Tabs[0].Tab.Parties
	out.Group.Parties = map[string]GroupPartyMeta{"a": {PartyMeta: p["a"], VaultID: g.AVault, RelationshipID: g.ARel}, "b": {PartyMeta: p["b"], VaultID: g.BVault, RelationshipID: g.BRel}}
	return out, nil
}
func groupAuthorized(ctx context.Context, q querier, g groupRow, account, role string, minRank int) (Party, error) {
	ids, err := groupTabIDs(ctx, q, g.ID)
	if err != nil {
		return Party{}, err
	}
	if len(ids) == 0 {
		return Party{}, ErrNotFound
	}
	p, err := partyByAccountRoleQuery(ctx, q, ids[0], account, role)
	if err != nil {
		return Party{}, err
	}
	if !p.allows(minRank) {
		return Party{}, ErrRoleInsufficient
	}
	for _, id := range ids[1:] {
		leg, err := partyByAccountRoleQuery(ctx, q, id, account, p.Role)
		if err != nil {
			return Party{}, err
		}
		if !leg.allows(minRank) {
			return Party{}, ErrRoleInsufficient
		}
		if !sameCreditVault(p, leg) {
			return Party{}, ErrNotFound
		}
	}
	return p, nil
}
func cleanGroupCurrencies(in []GroupCurrencyInput, allowOpening bool) ([]GroupCurrencyInput, error) {
	if len(in) == 0 || len(in) > 180 {
		return nil, ErrInvalidCurrency
	}
	out := append([]GroupCurrencyInput(nil), in...)
	sort.Slice(out, func(i, j int) bool { return out[i].Currency < out[j].Currency })
	for i, row := range out {
		if !credit.ValidCurrency(row.Currency) || (i > 0 && out[i-1].Currency == row.Currency) {
			return nil, ErrInvalidCurrency
		}
		if !allowOpening && row.Opening != nil {
			return nil, ErrGroupChanged
		}
	}
	return out, nil
}
func groupToken(token string) (string, error) {
	token = strings.TrimPrefix(strings.TrimSpace(token), "g_")
	bytes, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil || len(bytes) != 32 || len(token) != 43 {
		return "", ErrNotFound
	}
	return token, nil
}
func lockGroupContact(ctx context.Context, tx pgx.Tx, vault, relationship string) error {
	if err := credit.Lock(ctx, tx, vault); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, vault+":"+relationship)
	return err
}

// A legacy currency invitation cannot split a grouped contact by attaching a
// different currency beside it. The caller already holds the destination book
// credit lock, which serializes this check against CreateGroup/JoinGroup.
func checkGroupLinkDestination(ctx context.Context, tx pgx.Tx, tabID string, vault, relationship *string) error {
	if vault == nil || relationship == nil {
		return nil
	}
	var grouped bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM tab_groups g
 WHERE g.closed_at IS NULL AND ((g.a_vault_id=$1::uuid AND g.a_relationship_id=$2::uuid)
 OR(g.b_vault_id=$1::uuid AND g.b_relationship_id=$2::uuid))
 AND g.id IS DISTINCT FROM (SELECT t.group_id FROM tabs t WHERE t.id=$3::uuid))`, *vault, *relationship, tabID).Scan(&grouped); err != nil {
		return err
	}
	if grouped {
		return ErrGroupOperation
	}
	return nil
}
func groupReceiptCreate(in GroupCreateInput) string {
	in.AccountID = ""
	in.InstallID = nil
	raw, _ := json.Marshal(in)
	h := sha256.Sum256(raw)
	return hex.EncodeToString(h[:])
}
func validGroupScope(vault, relationship string) bool {
	_, a := uuid.Parse(vault)
	_, b := uuid.Parse(relationship)
	return a == nil && b == nil
}

func sameGroupBindings(a, b groupRow) bool {
	equal := func(x, y *string) bool {
		return (x == nil && y == nil) || (x != nil && y != nil && *x == *y)
	}
	return equal(a.AAccount, b.AAccount) && equal(a.AVault, b.AVault) && equal(a.ARel, b.ARel) &&
		equal(a.BAccount, b.BAccount) && equal(a.BVault, b.BVault) && equal(a.BRel, b.BRel)
}

// A persisted request UUID and invitation token make creation replayable even
// when its first committed response is lost. Only hashes are stored at rest.
func (s *Service) CreateGroup(ctx context.Context, in GroupCreateInput) (GroupResponse, error) {
	if _, err := uuid.Parse(in.RequestID); err != nil {
		return GroupResponse{}, ErrGroupChanged
	}
	token, err := groupToken(in.InviteToken)
	if err != nil {
		return GroupResponse{}, ErrGroupChanged
	}
	in.InviteToken = token
	if in.AccountID == "" {
		return GroupResponse{}, ErrAuthRequired
	}
	if !validGroupScope(in.VaultID, in.RelationshipID) {
		return GroupResponse{}, ErrNotFound
	}
	in.Currencies, err = cleanGroupCurrencies(in.Currencies, true)
	if err != nil {
		return GroupResponse{}, err
	}
	if in.RecordingMode == "" {
		in.RecordingMode = "notify"
	}
	if in.RecordingMode != "review" && !notificationOnlyMode(in.RecordingMode) {
		return GroupResponse{}, ErrInvalidRecordingMode
	}
	in.Label, err = validLabel(in.Label)
	if err != nil {
		return GroupResponse{}, err
	}
	tx, err := s.beginMutation(ctx, &in.AccountID)
	if err != nil {
		return GroupResponse{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err = lockGroupContact(ctx, tx, in.VaultID, in.RelationshipID); err != nil {
		return GroupResponse{}, err
	}
	if err = checkVaultBinding(ctx, tx, &in.VaultID, &in.AccountID); err != nil {
		return GroupResponse{}, err
	}
	fingerprint := groupReceiptCreate(in)
	prior, err := loadGroup(ctx, tx, in.RequestID, true)
	if err == nil {
		if prior.AAccount == nil || *prior.AAccount != in.AccountID || prior.RequestHash != fingerprint || prior.InviteHash != hashPartyToken(token) {
			return GroupResponse{}, ErrGroupChanged
		}
		if prior.Closed != nil {
			return GroupResponse{}, ErrTabClosed
		}
		out, err := groupResponse(ctx, tx, prior, "a")
		if err != nil {
			return GroupResponse{}, err
		}
		if err = tx.Commit(ctx); err != nil {
			return GroupResponse{}, err
		}
		return out, nil
	}
	if !errors.Is(err, ErrNotFound) {
		return GroupResponse{}, err
	}
	var conflict bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM tab_groups WHERE closed_at IS NULL AND ((a_vault_id=$1::uuid AND a_relationship_id=$2::uuid)OR(b_vault_id=$1::uuid AND b_relationship_id=$2::uuid)))`, in.VaultID, in.RelationshipID).Scan(&conflict); err != nil {
		return GroupResponse{}, err
	}
	if conflict {
		return GroupResponse{}, ErrAlreadyLinked
	}
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM tab_parties p JOIN tabs t ON t.id=p.tab_id WHERE p.vault_id=$1::uuid AND p.relationship_id=$2::uuid AND t.closed_at IS NULL)`, in.VaultID, in.RelationshipID).Scan(&conflict); err != nil {
		return GroupResponse{}, err
	}
	if conflict {
		return GroupResponse{}, ErrAlreadyLinked
	}
	if s.creditBalance == nil || s.groupSourceCurrencies == nil || s.groupSourceLatestRecordedAt == nil {
		return GroupResponse{}, ErrGroupCurrencyHistory
	}
	requested := map[string]bool{}
	for _, c := range in.Currencies {
		requested[c.Currency] = true
	}
	sourceCodes, err := s.groupSourceCurrencies(ctx, tx, in.VaultID, in.RelationshipID)
	if err != nil {
		return GroupResponse{}, err
	}
	for _, code := range sourceCodes {
		if !requested[code] {
			return GroupResponse{}, ErrGroupChanged
		}
	}
	var serverCutover int64
	if err = tx.QueryRow(ctx, `SELECT (EXTRACT(EPOCH FROM NOW())*1000)::BIGINT`).Scan(&serverCutover); err != nil {
		return GroupResponse{}, err
	}
	for i, c := range in.Currencies {
		before, err := s.creditBalance(ctx, tx, in.VaultID, in.RelationshipID, c.Currency)
		cutover := serverCutover
		if c.LinkedAtMS != nil && *c.LinkedAtMS < cutover {
			cutover = *c.LinkedAtMS
		}
		if cutover <= 0 {
			return GroupResponse{}, ErrInvalidOccurredAt
		}
		watermark, sourceErr := s.groupSourceLatestRecordedAt(ctx, tx, in.VaultID, in.RelationshipID, c.Currency)
		if sourceErr != nil {
			return GroupResponse{}, sourceErr
		}
		if watermark > cutover {
			return GroupResponse{}, ErrGroupChanged
		}
		// The original payload remains the durable request fingerprint, while
		// the stored cutover never moves ahead of authoritative server time.
		in.Currencies[i].LinkedAtMS = &cutover
		if err != nil {
			return GroupResponse{}, err
		}
		var opening int64
		if c.Opening != nil {
			if err = validDirection(c.Opening.Direction); err != nil {
				return GroupResponse{}, err
			}
			opening, err = parseAmountMinor(c.Opening.Amount)
			if err != nil {
				return GroupResponse{}, err
			}
			if c.Opening.Direction == "b_to_a" {
				opening = -opening
			}
		}
		if opening != before {
			return GroupResponse{}, ErrGroupChanged
		}
	}
	if _, err = tx.Exec(ctx, `INSERT INTO tab_groups(id,recording_mode,invite_token_hash,request_hash,a_account_id,a_vault_id,a_relationship_id)VALUES($1::uuid,$2,$3,$4,$5::uuid,$6::uuid,$7::uuid)`, in.RequestID, in.RecordingMode, hashPartyToken(token), fingerprint, in.AccountID, in.VaultID, in.RelationshipID); err != nil {
		return GroupResponse{}, err
	}
	for _, c := range in.Currencies {
		_, err = s.createTx(ctx, tx, CreateInput{GroupID: &in.RequestID, RecordingMode: in.RecordingMode, Currency: c.Currency, Label: in.Label, VaultID: &in.VaultID, RelationshipID: &in.RelationshipID, AccountID: &in.AccountID, InstallID: in.InstallID, Opening: c.Opening, LinkedAtMS: c.LinkedAtMS, ExpectedPreviousTabID: c.ExpectedPreviousTabID, ExpectedPreviousRev: c.ExpectedPreviousRev, ExpectedHistoryRevisions: c.ExpectedHistoryRevisions})
		if err != nil {
			return GroupResponse{}, err
		}
	}
	g, err := loadGroup(ctx, tx, in.RequestID, false)
	if err != nil {
		return GroupResponse{}, err
	}
	out, err := groupResponse(ctx, tx, g, "a")
	if err != nil {
		return GroupResponse{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return GroupResponse{}, err
	}
	for _, tab := range out.Tabs {
		s.poke(ctx, tab.Tab.ID)
	}
	return out, nil
}

func (s *Service) GetGroup(ctx context.Context, id, account, role string) (GroupResponse, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return GroupResponse{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	g, err := loadGroup(ctx, tx, id, false)
	if err != nil {
		return GroupResponse{}, err
	}
	p, err := groupAuthorized(ctx, tx, g, account, role, 1)
	if err != nil {
		return GroupResponse{}, err
	}
	return groupResponse(ctx, tx, g, p.Role)
}
func (s *Service) PreviewGroup(ctx context.Context, token, account string) (GroupResponse, error) {
	if account == "" {
		return GroupResponse{}, ErrAuthRequired
	}
	token, err := groupToken(token)
	if err != nil {
		return GroupResponse{}, err
	}
	var id string
	err = s.pool.QueryRow(ctx, `SELECT id::text FROM tab_groups WHERE invite_token_hash=$1`, hashPartyToken(token)).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return GroupResponse{}, ErrNotFound
	}
	if err != nil {
		return GroupResponse{}, err
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return GroupResponse{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	g, err := loadGroup(ctx, tx, id, false)
	if err != nil || g.InviteHash != hashPartyToken(token) {
		return GroupResponse{}, ErrNotFound
	}
	if g.BClaimed || g.BAccount != nil || g.BVault != nil {
		if _, err = groupAuthorized(ctx, tx, g, account, "b", 1); err != nil {
			return GroupResponse{}, err
		}
		return groupResponse(ctx, tx, g, "b")
	}
	if g.Closed != nil {
		return GroupResponse{}, ErrTabClosed
	}
	// Before explicit Join the token is only an invitation proof. It reveals
	// neither ledger records/balances nor account phones or local book bindings.
	currencies := []string{}
	var label string
	rows, err := tx.Query(ctx, `SELECT t.currency,p.label FROM tabs t JOIN tab_parties p ON p.tab_id=t.id AND p.role='a' WHERE t.group_id=$1::uuid ORDER BY t.currency`, g.ID)
	if err != nil {
		return GroupResponse{}, err
	}
	for rows.Next() {
		var code string
		if err = rows.Scan(&code, &label); err != nil {
			rows.Close()
			return GroupResponse{}, err
		}
		currencies = append(currencies, code)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return GroupResponse{}, err
	}
	if len(currencies) == 0 {
		return GroupResponse{}, ErrNotFound
	}
	joined := g.Created.UnixMilli()
	return GroupResponse{Group: GroupMeta{ID: g.ID, RecordingMode: g.Mode, Rev: g.Rev, CreatedAtMS: joined, You: "b", Currencies: currencies, Parties: map[string]GroupPartyMeta{"a": {PartyMeta: PartyMeta{Label: label, JoinedAtMS: &joined, Bound: g.AAccount != nil}}, "b": {PartyMeta: PartyMeta{Label: "", Bound: false}}}}, Tabs: []TabResponse{}}, nil
}
func groupInviteParty(ctx context.Context, q querier, id, account string, install *string) (Party, error) {
	var p Party
	err := q.QueryRow(ctx, `SELECT `+partyCols+` FROM tab_parties p WHERE p.tab_id=$1::uuid AND p.role='b'`, id).Scan(&p.TabID, &p.Role, &p.Label, &p.AccountID, &p.VaultID, &p.RelationshipID, &p.JoinedAt, &p.AccountBoundOnce)
	if err != nil {
		return p, err
	}
	p.ActorAccountID = account
	p.ActorInstallID = install
	return p, nil
}
func (s *Service) JoinGroup(ctx context.Context, id string, in GroupJoinInput) (GroupResponse, error) {
	if in.AccountID == "" {
		return GroupResponse{}, ErrAuthRequired
	}
	token, err := groupToken(in.Token)
	if err != nil {
		return GroupResponse{}, err
	}
	if !validGroupScope(in.VaultID, in.RelationshipID) {
		return GroupResponse{}, ErrNotFound
	}
	currencies, err := cleanGroupCurrencies(in.Currencies, false)
	if err != nil {
		return GroupResponse{}, err
	}
	tx, err := s.beginMutation(ctx, &in.AccountID)
	if err != nil {
		return GroupResponse{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err = lockGroupContact(ctx, tx, in.VaultID, in.RelationshipID); err != nil {
		return GroupResponse{}, err
	}
	var conflict bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM tab_groups WHERE id<>$3::uuid AND closed_at IS NULL AND ((a_vault_id=$1::uuid AND a_relationship_id=$2::uuid)OR(b_vault_id=$1::uuid AND b_relationship_id=$2::uuid)))`, in.VaultID, in.RelationshipID, id).Scan(&conflict); err != nil {
		return GroupResponse{}, err
	}
	if conflict {
		return GroupResponse{}, ErrAlreadyLinked
	}
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM tab_parties p JOIN tabs t ON t.id=p.tab_id WHERE p.vault_id=$1::uuid AND p.relationship_id=$2::uuid AND t.closed_at IS NULL AND t.group_id IS DISTINCT FROM $3::uuid)`, in.VaultID, in.RelationshipID, id).Scan(&conflict); err != nil {
		return GroupResponse{}, err
	}
	if conflict {
		return GroupResponse{}, ErrAlreadyLinked
	}
	g, err := loadGroup(ctx, tx, id, true)
	if err != nil {
		return GroupResponse{}, err
	}
	if g.InviteHash != hashPartyToken(token) {
		return GroupResponse{}, ErrNotFound
	}
	if g.Closed != nil {
		return GroupResponse{}, ErrTabClosed
	}
	if g.BClaimed || g.BAccount != nil || g.BVault != nil {
		if g.BAccount == nil || *g.BAccount != in.AccountID || g.BVault == nil || *g.BVault != in.VaultID || g.BRel == nil || *g.BRel != in.RelationshipID {
			return GroupResponse{}, ErrNotFound
		}
		if _, err = groupAuthorized(ctx, tx, g, in.AccountID, "b", rankEditor); err != nil {
			return GroupResponse{}, err
		}
		if g.BJoined != nil {
			out, err := groupResponse(ctx, tx, g, "b")
			if err != nil {
				return GroupResponse{}, err
			}
			if err = tx.Commit(ctx); err != nil {
				return GroupResponse{}, err
			}
			return out, nil
		}
	}
	ids, err := groupTabIDs(ctx, tx, id)
	if err != nil {
		return GroupResponse{}, err
	}
	if len(ids) != len(currencies) {
		return GroupResponse{}, ErrGroupChanged
	}
	if s.groupCurrencyHistory == nil || s.groupSourceCurrencies == nil || s.groupSourceLatestRecordedAt == nil {
		return GroupResponse{}, ErrGroupCurrencyHistory
	}
	requested := map[string]bool{}
	for _, c := range currencies {
		requested[c.Currency] = true
	}
	sourceCodes, err := s.groupSourceCurrencies(ctx, tx, in.VaultID, in.RelationshipID)
	if err != nil {
		return GroupResponse{}, err
	}
	for _, code := range sourceCodes {
		if !requested[code] {
			has, err := s.groupCurrencyHistory(ctx, tx, in.VaultID, in.RelationshipID, code)
			if err != nil {
				return GroupResponse{}, err
			}
			if has {
				return GroupResponse{}, ErrGroupCurrencyHistory
			}
		}
	}
	var serverCutover int64
	if err = tx.QueryRow(ctx, `SELECT (EXTRACT(EPOCH FROM NOW())*1000)::BIGINT`).Scan(&serverCutover); err != nil {
		return GroupResponse{}, err
	}
	// Do not cut a recipient's properly recorded book over to a different
	// opening. Both source checks and every leg's Join share this transaction.
	for i, tabID := range ids {
		code, err := tabCurrency(ctx, tx, tabID)
		if err != nil {
			return GroupResponse{}, err
		}
		if code != currencies[i].Currency {
			return GroupResponse{}, ErrGroupChanged
		}
		cutover := serverCutover
		if currencies[i].LinkedAtMS != nil && *currencies[i].LinkedAtMS < cutover {
			cutover = *currencies[i].LinkedAtMS
		}
		if cutover <= 0 {
			return GroupResponse{}, ErrInvalidOccurredAt
		}
		watermark, sourceErr := s.groupSourceLatestRecordedAt(ctx, tx, in.VaultID, in.RelationshipID, code)
		if sourceErr != nil {
			return GroupResponse{}, sourceErr
		}
		if watermark > cutover {
			return GroupResponse{}, ErrGroupChanged
		}
		currencies[i].LinkedAtMS = &cutover
		has, err := s.groupCurrencyHistory(ctx, tx, in.VaultID, in.RelationshipID, code)
		if err != nil {
			return GroupResponse{}, err
		}
		if has {
			if s.creditBalance == nil {
				return GroupResponse{}, ErrGroupCurrencyHistory
			}
			before, err := s.creditBalance(ctx, tx, in.VaultID, in.RelationshipID, code)
			if err != nil {
				return GroupResponse{}, err
			}
			var carried int64
			if err = tx.QueryRow(ctx, `SELECT COALESCE(SUM(CASE WHEN direction='b_to_a' THEN amount_minor ELSE -amount_minor END),0)::BIGINT FROM tab_entries WHERE tab_id=$1::uuid AND kind='opening' AND voided_by_entry_id IS NULL AND status IN('pending','accepted','recorded')`, tabID).Scan(&carried); err != nil {
				return GroupResponse{}, err
			}
			if before != 0 && (g.Mode == "review" || before != carried) {
				return GroupResponse{}, ErrGroupCurrencyHistory
			}
		}
	}
	for i, tabID := range ids {
		code, err := tabCurrency(ctx, tx, tabID)
		if err != nil {
			return GroupResponse{}, err
		}
		if code != currencies[i].Currency {
			return GroupResponse{}, ErrGroupChanged
		}
		c := currencies[i]
		p, err := groupInviteParty(ctx, tx, tabID, in.AccountID, in.InstallID)
		if err != nil {
			return GroupResponse{}, err
		}
		_, err = s.joinTx(ctx, tx, p, JoinInput{Label: in.Label, VaultID: &in.VaultID, RelationshipID: &in.RelationshipID, AccountID: &in.AccountID, InstallID: in.InstallID, LinkedAtMS: c.LinkedAtMS, ExpectedPreviousTabID: c.ExpectedPreviousTabID, ExpectedPreviousRev: c.ExpectedPreviousRev, ExpectedHistoryRevisions: c.ExpectedHistoryRevisions})
		if err != nil {
			return GroupResponse{}, err
		}
	}
	if _, err = tx.Exec(ctx, `UPDATE tab_groups SET b_account_id=$2::uuid,b_vault_id=$3::uuid,b_relationship_id=$4::uuid,b_joined_at=COALESCE(b_joined_at,NOW()),b_account_bound_once=TRUE,rev=rev+1 WHERE id=$1::uuid`, id, in.AccountID, in.VaultID, in.RelationshipID); err != nil {
		return GroupResponse{}, err
	}
	g, err = loadGroup(ctx, tx, id, false)
	if err != nil {
		return GroupResponse{}, err
	}
	out, err := groupResponse(ctx, tx, g, "b")
	if err != nil {
		return GroupResponse{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return GroupResponse{}, err
	}
	for _, v := range ids {
		s.poke(ctx, v)
	}
	return out, nil
}

func (s *Service) CloseGroup(ctx context.Context, id, account, role string, withdraw bool) (GroupResponse, error) {
	tx, err := s.beginMutation(ctx, &account)
	if err != nil {
		return GroupResponse{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// Read scope before locking rows; legacy monetary operations take the same
	// vault-credit lock before a tab lock.
	g, err := loadGroup(ctx, tx, id, false)
	if err != nil {
		return GroupResponse{}, err
	}
	p, err := groupAuthorized(ctx, tx, g, account, role, rankEditor)
	if err != nil {
		return GroupResponse{}, err
	}
	if p.VaultID != nil && p.RelationshipID != nil {
		if err = lockGroupContact(ctx, tx, *p.VaultID, *p.RelationshipID); err != nil {
			return GroupResponse{}, err
		}
	}
	g, err = loadGroup(ctx, tx, id, true)
	if err != nil {
		return GroupResponse{}, err
	}
	p, err = groupAuthorized(ctx, tx, g, account, p.Role, rankEditor)
	if err != nil {
		return GroupResponse{}, err
	}
	ids, err := groupTabIDs(ctx, tx, id)
	if err != nil {
		return GroupResponse{}, err
	}
	for _, tabID := range ids {
		leg, err := partyByAccountRoleQuery(ctx, tx, tabID, account, p.Role)
		if err != nil {
			return GroupResponse{}, err
		}
		if _, _, err = s.closeTx(ctx, tx, leg, withdraw); err != nil {
			return GroupResponse{}, err
		}
	}
	if _, err = tx.Exec(ctx, `UPDATE tab_groups SET closed_at=COALESCE(closed_at,NOW()),closed_by=CASE WHEN closed_at IS NULL THEN $2 ELSE closed_by END,rev=rev+CASE WHEN closed_at IS NULL THEN 1 ELSE 0 END WHERE id=$1::uuid`, id, p.Role); err != nil {
		return GroupResponse{}, err
	}
	g, err = loadGroup(ctx, tx, id, false)
	if err != nil {
		return GroupResponse{}, err
	}
	out, err := groupResponse(ctx, tx, g, p.Role)
	if err != nil {
		return GroupResponse{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return GroupResponse{}, err
	}
	for _, v := range ids {
		s.poke(ctx, v)
	}
	return out, nil
}
func (s *Service) RegenerateGroup(ctx context.Context, id, account, role string) (GroupResponse, string, error) {
	token, err := newPartyToken()
	if err != nil {
		return GroupResponse{}, "", err
	}
	tx, err := s.beginMutation(ctx, &account)
	if err != nil {
		return GroupResponse{}, "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	g, err := loadGroup(ctx, tx, id, true)
	if err != nil {
		return GroupResponse{}, "", err
	}
	p, err := groupAuthorized(ctx, tx, g, account, role, rankEditor)
	if err != nil {
		return GroupResponse{}, "", err
	}
	if p.Role != "a" {
		return GroupResponse{}, "", ErrNotPartyA
	}
	if g.Closed != nil {
		return GroupResponse{}, "", ErrTabClosed
	}
	if _, err = tx.Exec(ctx, `UPDATE tab_groups SET invite_token_hash=$2,rev=rev+1 WHERE id=$1::uuid`, id, hashPartyToken(token)); err != nil {
		return GroupResponse{}, "", err
	}
	g, err = loadGroup(ctx, tx, id, false)
	if err != nil {
		return GroupResponse{}, "", err
	}
	out, err := groupResponse(ctx, tx, g, "a")
	if err != nil {
		return GroupResponse{}, "", err
	}
	if err = tx.Commit(ctx); err != nil {
		return GroupResponse{}, "", err
	}
	for _, v := range out.Tabs {
		s.poke(ctx, v.Tab.ID)
	}
	return out, token, nil
}

// Fresh currencies may be activated through the group's existing consent only
// when neither contact has source history to absorb. Existing balances require
// a new source-checked invitation rather than an invented zero checkpoint.
func (s *Service) EnsureGroupCurrency(ctx context.Context, id, account, role string, c GroupCurrencyInput) (GroupResponse, error) {
	if !credit.ValidCurrency(c.Currency) {
		return GroupResponse{}, ErrInvalidCurrency
	}
	tx, err := s.beginMutation(ctx, &account)
	if err != nil {
		return GroupResponse{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	g, err := loadGroup(ctx, tx, id, false)
	if err != nil {
		return GroupResponse{}, err
	}
	p, err := groupAuthorized(ctx, tx, g, account, role, rankClerk)
	if err != nil {
		return GroupResponse{}, err
	}
	if !tallyWriterAllowed(g.Mode, p.Role) {
		return GroupResponse{}, ErrOneWayReadOnly
	}
	initialBindings := g
	// Creating a zero-value leg references both existing participants. Protect
	// those foreign keys before group/book locks, as account erasure takes its
	// account lock before the group row too.
	for _, accountID := range []*string{g.AAccount, g.BAccount} {
		if err = lockActor(ctx, tx, accountID); err != nil {
			return GroupResponse{}, err
		}
	}
	// Both source books are locked in a stable order before adding a denomination.
	type scope struct{ v, r string }
	scopes := []scope{}
	if g.AVault != nil && g.ARel != nil {
		scopes = append(scopes, scope{*g.AVault, *g.ARel})
	}
	if g.BVault != nil && g.BRel != nil {
		scopes = append(scopes, scope{*g.BVault, *g.BRel})
	}
	sort.Slice(scopes, func(i, j int) bool { return scopes[i].v < scopes[j].v })
	for _, v := range scopes {
		if err = lockGroupContact(ctx, tx, v.v, v.r); err != nil {
			return GroupResponse{}, err
		}
	}
	g, err = loadGroup(ctx, tx, id, true)
	if err != nil {
		return GroupResponse{}, err
	}
	if !sameGroupBindings(initialBindings, g) {
		// First Join or account deletion changed the set of books gathered above.
		// Retry from a fresh snapshot rather than acquiring more locks out of order.
		return GroupResponse{}, ErrGroupChanged
	}
	p, err = groupAuthorized(ctx, tx, g, account, p.Role, rankClerk)
	if err != nil {
		return GroupResponse{}, err
	}
	if g.Closed != nil {
		return GroupResponse{}, ErrTabClosed
	}
	var exists bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM tabs WHERE group_id=$1::uuid AND currency=$2)`, id, c.Currency).Scan(&exists); err != nil {
		return GroupResponse{}, err
	}
	if exists {
		return groupResponse(ctx, tx, g, p.Role)
	}
	if c.Opening != nil || g.BJoined == nil || g.AAccount == nil || g.AVault == nil || g.ARel == nil || g.BAccount == nil || g.BVault == nil || g.BRel == nil {
		return GroupResponse{}, ErrGroupCurrencyHistory
	}
	if s.groupCurrencyHistory == nil {
		return GroupResponse{}, ErrGroupCurrencyHistory
	}
	for _, v := range scopes {
		has, err := s.groupCurrencyHistory(ctx, tx, v.v, v.r, c.Currency)
		if err != nil {
			return GroupResponse{}, err
		}
		if has {
			return GroupResponse{}, ErrGroupCurrencyHistory
		}
		if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM tab_parties p JOIN tabs t ON t.id=p.tab_id WHERE p.vault_id=$1::uuid AND p.relationship_id=$2::uuid AND t.currency=$3)`, v.v, v.r, c.Currency).Scan(&has); err != nil {
			return GroupResponse{}, err
		}
		if has {
			return GroupResponse{}, ErrGroupCurrencyHistory
		}
	}
	current, err := groupResponse(ctx, tx, g, p.Role)
	if err != nil {
		return GroupResponse{}, err
	}
	labelA := current.Group.Parties["a"].Label
	labelB := current.Group.Parties["b"].Label
	var serverCutover int64
	if err = tx.QueryRow(ctx, `SELECT (EXTRACT(EPOCH FROM NOW())*1000)::BIGINT`).Scan(&serverCutover); err != nil {
		return GroupResponse{}, err
	}
	if c.LinkedAtMS != nil && *c.LinkedAtMS < serverCutover {
		serverCutover = *c.LinkedAtMS
	}
	if serverCutover <= 0 {
		return GroupResponse{}, ErrInvalidOccurredAt
	}
	c.LinkedAtMS = &serverCutover
	made, err := s.createTx(ctx, tx, CreateInput{GroupID: &id, RecordingMode: g.Mode, Currency: c.Currency, Label: labelA, VaultID: g.AVault, RelationshipID: g.ARel, AccountID: g.AAccount, LinkedAtMS: c.LinkedAtMS})
	if err != nil {
		return GroupResponse{}, err
	}
	invited, err := groupInviteParty(ctx, tx, made.Tab.ID, account, nil)
	if err != nil {
		return GroupResponse{}, err
	}
	if _, err = s.joinTx(ctx, tx, invited, JoinInput{Label: labelB, VaultID: g.BVault, RelationshipID: g.BRel, AccountID: g.BAccount, LinkedAtMS: c.LinkedAtMS}); err != nil {
		return GroupResponse{}, err
	}
	if _, err = tx.Exec(ctx, `UPDATE tab_parties SET joined_at=$2 WHERE tab_id=$1::uuid AND role='b'`, made.Tab.ID, g.BJoined); err != nil {
		return GroupResponse{}, err
	}
	if _, err = tx.Exec(ctx, `UPDATE tab_groups SET rev=rev+1 WHERE id=$1::uuid`, id); err != nil {
		return GroupResponse{}, err
	}
	g, err = loadGroup(ctx, tx, id, false)
	if err != nil {
		return GroupResponse{}, err
	}
	out, err := groupResponse(ctx, tx, g, p.Role)
	if err != nil {
		return GroupResponse{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return GroupResponse{}, err
	}
	s.poke(ctx, made.Tab.ID)
	return out, nil
}
