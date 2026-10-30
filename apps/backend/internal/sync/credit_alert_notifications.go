package sync

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/matee/kaata-backend/internal/auth"
	"github.com/matee/kaata-backend/internal/credit"
	"github.com/matee/kaata-backend/internal/httpx"
	applocale "github.com/matee/kaata-backend/internal/locale"
)

type creditPushClient struct {
	client               *http.Client
	baseURL, accessToken string
}

var creditExpoTokenRE = regexp.MustCompile(`^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]{10,200}\]$`)

// StartCreditPush uses the app's existing opt-in Expo transport. The provider
// receives generic text and a random event key only. Customer/account/ledger
// metadata remains server-side behind an authenticated installation-bound read.
func (s *Service) StartCreditPush(ctx context.Context, enabled bool, accessToken string) {
	if !enabled {
		return
	}
	s.creditPush = &creditPushClient{client: &http.Client{Timeout: 8 * time.Second}, baseURL: "https://exp.host/--/api/v2/push", accessToken: accessToken}
	go func() {
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		for {
			if err := s.scanCreditAlerts(ctx); err != nil && ctx.Err() == nil {
				log.Printf("credit alerts: scan failed (%T)", err)
			}
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
	// A slow provider must not postpone observing a repayment/rearm in another
	// customer. Delivery owns short leases and runs independently of scanning.
	go func() {
		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()
		for {
			for n := 0; n < 100 && ctx.Err() == nil; n++ {
				more, err := s.deliverCreditPush(ctx)
				if err != nil {
					log.Printf("credit alerts: delivery failed (%T)", err)
					break
				}
				if !more {
					break
				}
			}
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
}

func (h *Handler) CreditAlertNotifications(w http.ResponseWriter, r *http.Request) {
	claims, ok := auth.ClaimsFromContext(r.Context())
	if !ok {
		httpx.Error(w, 401, "authentication required")
		return
	}
	vaultID := r.URL.Query().Get("vault_id")
	if _, err := uuid.Parse(vaultID); err != nil {
		httpx.Error(w, 400, "invalid vault_id")
		return
	}
	if !h.allowCurrencyClient(w, r, vaultID, claims.AccountID) {
		return
	}
	var input struct {
		InstallID   string                      `json:"install_id"`
		Token       string                      `json:"token"`
		Locale      string                      `json:"locale"`
		Preferences json.RawMessage             `json:"preferences"`
		Customers   []creditCustomerPreferences `json:"customer_preferences"`
		LimitAlerts bool                        `json:"limit_alerts"`
	}
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2<<20))
	d.DisallowUnknownFields()
	if d.Decode(&input) != nil || d.Decode(new(any)) != io.EOF || (input.Token != "" && !creditExpoTokenRE.MatchString(input.Token)) || len(input.Customers) > 2000 {
		httpx.Error(w, 400, "invalid credit notification registration")
		return
	}
	var prefs, customers []byte
	var leaseMS int64
	var leaseObserved time.Time
	if len(input.Preferences) > 0 {
		p, err := decodeCreditNotificationPreferences(input.Preferences)
		if err != nil {
			httpx.Error(w, 400, "invalid notification preferences")
			return
		}
		prefs, _ = json.Marshal(p)
	}
	if input.Customers != nil {
		seen := map[string]bool{}
		for i, c := range input.Customers {
			if _, err := uuid.Parse(c.RelationshipID); err != nil || c.RelationshipID == credit.DefaultRelationshipID || seen[c.RelationshipID] {
				httpx.Error(w, 400, "invalid customer preferences")
				return
			}
			seen[c.RelationshipID] = true
			p, err := decodeCreditNotificationPreferences(c.Preferences)
			if err != nil {
				httpx.Error(w, 400, "invalid customer preferences")
				return
			}
			input.Customers[i].Preferences, _ = json.Marshal(p)
		}
		customers, _ = json.Marshal(input.Customers)
	}
	tx, err := h.svc.pool.Begin(r.Context())
	if err != nil {
		httpx.Error(w, 500, "storage unavailable")
		return
	}
	defer tx.Rollback(r.Context())
	valid, err := lockCreditPushIdentity(r.Context(), tx, claims.AccountID, claims.InstallID, claims.Epoch)
	if err != nil {
		httpx.Error(w, 500, "storage unavailable")
		return
	}
	if !valid {
		httpx.Error(w, 401, "account unavailable")
		return
	}
	if err := credit.Lock(r.Context(), tx, vaultID); err != nil {
		httpx.Error(w, 500, "storage unavailable")
		return
	}
	valid, err = creditPushMembership(r.Context(), tx, vaultID, claims.AccountID)
	if err != nil {
		httpx.Error(w, 500, "storage unavailable")
		return
	}
	if !valid {
		httpx.ErrorCode(w, 403, "insufficient_role", "active owner or manager required")
		return
	}
	var memberID int64
	if err := tx.QueryRow(r.Context(), `SELECT id FROM vault_members WHERE vault_id=$1::uuid AND account_id=$2::uuid AND accepted_at IS NOT NULL AND revoked_at IS NULL`, vaultID, claims.AccountID).Scan(&memberID); err != nil {
		httpx.Error(w, 500, "storage unavailable")
		return
	}
	if input.Token == "" {
		_, err = tx.Exec(r.Context(), `DELETE FROM credit_push_subscriptions WHERE vault_id=$1::uuid AND install_id=$2::uuid AND account_id=$3::uuid`, vaultID, claims.InstallID, claims.AccountID)
	} else {
		if _, err = tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, "credit-token:"+input.Token); err == nil {
			_, err = tx.Exec(r.Context(), `DELETE FROM credit_push_subscriptions WHERE (token=$1 AND (install_id<>$2::uuid OR account_id<>$3::uuid)) OR (install_id=$2::uuid AND (account_id<>$3::uuid OR session_epoch<>$4))`, input.Token, claims.InstallID, claims.AccountID, claims.Epoch)
		}
		if err == nil {
			_, err = tx.Exec(r.Context(), `DELETE FROM credit_push_subscriptions WHERE vault_id=$1::uuid AND install_id=$2::uuid AND vault_member_id<>$3`, vaultID, claims.InstallID, memberID)
		}
		if err == nil {
			var oldPrefs, oldCustomers []byte
			var oldLimits bool
			oldErr := tx.QueryRow(r.Context(), `SELECT preferences,customer_preferences,limit_alerts FROM credit_push_subscriptions WHERE vault_id=$1::uuid AND install_id=$2::uuid FOR UPDATE`, vaultID, claims.InstallID).Scan(&oldPrefs, &oldCustomers, &oldLimits)
			if oldErr != nil && !errors.Is(oldErr, pgx.ErrNoRows) {
				httpx.Error(w, 500, "storage unavailable")
				return
			}
			defaults, _ := json.Marshal(defaultCreditNotificationPreferences())
			var subID string
			var savedPrefs, savedCustomers []byte
			err = tx.QueryRow(r.Context(), `INSERT INTO credit_push_subscriptions(vault_id,install_id,account_id,session_epoch,token,locale,preferences,customer_preferences,vault_member_id,limit_alerts)
 VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,COALESCE($7::jsonb,$9::jsonb),COALESCE($8::jsonb,'[]'::jsonb),$10,$11)
 ON CONFLICT(vault_id,install_id) DO UPDATE SET token=EXCLUDED.token,locale=EXCLUDED.locale,preferences=COALESCE($7::jsonb,credit_push_subscriptions.preferences),customer_preferences=COALESCE($8::jsonb,credit_push_subscriptions.customer_preferences),renewed_at=NOW(),limit_alerts=EXCLUDED.limit_alerts RETURNING id::text,preferences,customer_preferences,GREATEST(0,FLOOR(EXTRACT(EPOCH FROM (renewed_at+INTERVAL '30 days'-clock_timestamp()))*1000))::bigint`, vaultID, claims.InstallID, claims.AccountID, claims.Epoch, input.Token, applocale.Normalize(input.Locale), nullableCreditJSON(prefs), nullableCreditJSON(customers), defaults, memberID, input.LimitAlerts).Scan(&subID, &savedPrefs, &savedCustomers, &leaseMS)
			leaseObserved = time.Now()
			if err == nil {
				quietID := ""
				if oldErr != nil || !sameCreditJSON(oldPrefs, savedPrefs) || !sameCreditJSON(oldCustomers, savedCustomers) || oldLimits != input.LimitAlerts {
					quietID = subID
				}
				err = h.svc.scanCreditAlertVaultTx(r.Context(), tx, vaultID, quietID)
			}
		}
	}
	if err != nil || tx.Commit(r.Context()) != nil {
		httpx.Error(w, 500, "storage unavailable")
		return
	}
	enabled := h.svc.creditPush != nil && input.Token != ""
	if enabled {
		leaseMS = max(0, leaseMS-time.Since(leaseObserved).Milliseconds())
	} else {
		leaseMS = 0
	}
	w.Header().Set("X-Kaata-Credit-Limit-Notifications", "1")
	httpx.JSON(w, 200, map[string]any{"remote_delivery_enabled": enabled, "remote_delivery_lease_ms": leaseMS, "limit_notifications_enabled": enabled && input.LimitAlerts})
}

func nullableCreditJSON(raw []byte) any {
	if len(raw) == 0 {
		return nil
	}
	return raw
}

func sameCreditJSON(a, b []byte) bool {
	var first, second any
	if json.Unmarshal(a, &first) != nil || json.Unmarshal(b, &second) != nil {
		return false
	}
	left, _ := json.Marshal(first)
	right, _ := json.Marshal(second)
	return bytes.Equal(left, right)
}

// Take account/install locks before the credit lock, matching account deletion
// and credential rotation. A session from a previous installation account or
// epoch cannot revive a subscription even if its HTTP authentication raced.
func lockCreditPushIdentity(ctx context.Context, tx pgx.Tx, accountID, installID string, epoch int64) (bool, error) {
	var id string
	err := tx.QueryRow(ctx, `SELECT id::text FROM accounts WHERE id=$1::uuid AND pending_delete_at IS NULL AND disabled_at IS NULL FOR SHARE`, accountID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	err = tx.QueryRow(ctx, `SELECT i.install_id::text FROM installs i JOIN auth_credentials ac ON ac.install_id=i.install_id WHERE i.install_id=$1::uuid AND i.account_id=$2::uuid AND ac.account_id=$2::uuid AND ac.revoked_at IS NULL AND ac.session_epoch=$3 FOR SHARE OF i,ac`, installID, accountID, epoch).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

func creditPushMembership(ctx context.Context, tx pgx.Tx, vaultID, accountID string) (bool, error) {
	var role string
	err := tx.QueryRow(ctx, `SELECT m.role FROM vault_members m JOIN vaults v ON v.vault_id=m.vault_id WHERE m.vault_id=$1::uuid AND m.account_id=$2::uuid AND m.accepted_at IS NOT NULL AND m.revoked_at IS NULL AND m.role IN ('owner','manager') AND v.archived_at IS NULL FOR SHARE OF m,v`, vaultID, accountID).Scan(&role)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

func creditAlertFingerprint(p *credit.AlertPolicy, direction string) string {
	groups := []string{}
	if p != nil {
		for _, g := range p.Groups {
			if g.Direction != direction {
				continue
			}
			conditions := append([]credit.AlertCondition{}, g.Conditions...)
			sort.Slice(conditions, func(i, j int) bool {
				if conditions[i].Currency == conditions[j].Currency {
					return conditions[i].ThresholdMinor < conditions[j].ThresholdMinor
				}
				return conditions[i].Currency < conditions[j].Currency
			})
			raw, _ := json.Marshal(credit.AlertGroup{Direction: direction, Conditions: conditions})
			groups = append(groups, string(raw))
		}
	}
	sort.Strings(groups)
	unique := groups[:0]
	for _, g := range groups {
		if len(unique) == 0 || unique[len(unique)-1] != g {
			unique = append(unique, g)
		}
	}
	raw, _ := json.Marshal(unique)
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

func (s *Service) scanCreditAlerts(ctx context.Context) error {
	rows, err := s.pool.Query(ctx, `SELECT vault_id::text FROM credit_push_subscriptions s WHERE renewed_at>NOW()-INTERVAL '30 days' AND (EXISTS(SELECT 1 FROM customer_credit_alerts p WHERE p.vault_id=s.vault_id AND jsonb_array_length(p.groups)>0) OR EXISTS(SELECT 1 FROM customer_credit_limit_notifications p WHERE p.vault_id=s.vault_id AND p.enabled)) GROUP BY vault_id ORDER BY MIN(scanned_at) NULLS FIRST,vault_id LIMIT 25`)
	if err != nil {
		return err
	}
	vaults := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		vaults = append(vaults, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, id := range vaults {
		if err := s.scanCreditAlertVault(ctx, id); err != nil {
			return err
		}
	}
	_, err = s.pool.Exec(ctx, `DELETE FROM credit_alert_events WHERE created_at<NOW()-INTERVAL '30 days'`)
	return err
}

func (s *Service) scanCreditAlertVault(ctx context.Context, vaultID string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := credit.Lock(ctx, tx, vaultID); err != nil {
		return err
	}
	if err := s.scanCreditAlertVaultTx(ctx, tx, vaultID, ""); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// Called while credit.Lock is held, also from policy saves/registration. This
// commits the baseline before a following tally can change exposure, avoiding
// a lost first crossing between registration/save and the 15-second scan.
func (s *Service) scanCreditAlertVaultTx(ctx context.Context, tx pgx.Tx, vaultID, quietSubscriptionID string) error {
	return s.scanCreditAlertWatches(ctx, tx, vaultID, quietSubscriptionID)
}

type creditPushTicket struct {
	Status  string `json:"status"`
	ID      string `json:"id"`
	Details struct {
		Error string `json:"error"`
	} `json:"details"`
}

func (p *creditPushClient) post(ctx context.Context, path string, body, out any) error {
	raw, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, "POST", p.baseURL+path, bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if p.accessToken != "" {
		req.Header.Set("Authorization", "Bearer "+p.accessToken)
	}
	res, err := p.client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return fmt.Errorf("credit push HTTP %d", res.StatusCode)
	}
	return json.NewDecoder(io.LimitReader(res.Body, 64<<10)).Decode(out)
}

// Runs after the observation transaction commits. Recheck current policy,
// exposure, account/install and membership before sending the opaque notice.
func (s *Service) deliverCreditPush(ctx context.Context) (bool, error) {
	if s.creditPush == nil {
		return false, nil
	}
	var id, epoch int64
	var vaultID, accountID, installID string
	err := s.pool.QueryRow(ctx, `SELECT o.id,s.vault_id::text,s.account_id::text,s.install_id::text,s.session_epoch FROM credit_push_outbox o JOIN credit_push_subscriptions s ON s.id=o.subscription_id WHERE o.next_at<=NOW() AND (o.claimed_until IS NULL OR o.claimed_until<NOW()) ORDER BY o.next_at,o.id LIMIT 1`).Scan(&id, &vaultID, &accountID, &installID, &epoch)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)
	valid, err := lockCreditPushIdentity(ctx, tx, accountID, installID, epoch)
	if err != nil {
		return false, err
	}
	if err := credit.Lock(ctx, tx, vaultID); err != nil {
		return false, err
	}
	member, err := creditPushMembership(ctx, tx, vaultID, accountID)
	if err != nil {
		return false, err
	}
	valid = valid && member
	var subID, relID, direction, watchKey, fingerprint, eventKey, token, locale string
	var generation int64
	var attempts int
	var receipt *string
	var prefsRaw, customers []byte
	var fresh bool
	err = tx.QueryRow(ctx, `SELECT s.id::text,o.relationship_id::text,o.direction,o.watch_key,o.fingerprint,o.generation,o.event_key::text,o.attempts,o.receipt_id,s.token,s.locale,s.preferences,s.customer_preferences,(o.watch_key='' OR s.limit_alerts) AND s.renewed_at>NOW()-INTERVAL '30 days' AND o.created_at>NOW()-INTERVAL '24 hours' AND EXISTS(SELECT 1 FROM vault_members m WHERE m.id=s.vault_member_id AND m.vault_id=s.vault_id AND m.account_id=s.account_id AND m.accepted_at IS NOT NULL AND m.revoked_at IS NULL AND m.role IN ('owner','manager')) FROM credit_push_outbox o JOIN credit_push_subscriptions s ON s.id=o.subscription_id WHERE o.id=$1 AND (o.claimed_until IS NULL OR o.claimed_until<NOW()) FOR UPDATE OF o,s SKIP LOCKED`, id).Scan(&subID, &relID, &direction, &watchKey, &fingerprint, &generation, &eventKey, &attempts, &receipt, &token, &locale, &prefsRaw, &customers, &fresh)
	if errors.Is(err, pgx.ErrNoRows) {
		return true, nil
	}
	if err != nil {
		return false, err
	}
	valid = valid && fresh
	prefs, prefErr := creditPreferencesFor(prefsRaw, customers, relID)
	valid = valid && prefErr == nil && prefs.permits(time.Now())
	policy, err := creditWatchPolicy(ctx, tx, vaultID, relID, watchKey)
	if err != nil {
		return false, err
	}
	valid = valid && policy != nil && creditAlertFingerprint(policy, direction) == fingerprint
	var stateMatches bool
	err = tx.QueryRow(ctx, `SELECT matched AND fingerprint=$4 AND generation=$5 FROM credit_alert_states WHERE subscription_id=$1::uuid AND relationship_id=$2::uuid AND direction=$3 AND watch_key=$6`, subID, relID, direction, fingerprint, generation, watchKey).Scan(&stateMatches)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return false, err
	}
	valid = valid && stateMatches
	projection, err := LoadVaultProjection(ctx, tx, vaultID)
	if err != nil {
		return false, err
	}
	rel := projection.Relationships[relID]
	valid = valid && rel != nil && rel.ArchivedAt == nil
	if valid {
		balances, err := creditWatchBalances(ctx, tx, vaultID, relID, policy, projection, direction)
		if err != nil {
			return false, err
		}
		valid = policy.Matches(direction, balances)
	}

	if !valid {
		if _, err := tx.Exec(ctx, `DELETE FROM credit_push_outbox WHERE id=$1`, id); err != nil {
			return false, err
		}
		return true, tx.Commit(ctx)
	}
	// Lease and commit before HTTP: even an unavailable provider cannot hold
	// the credit lock or delay normal tally recording. A unique claim fences
	// late acknowledgements; concurrent workers skip this one-minute lease.
	claim := uuid.NewString()
	if _, err := tx.Exec(ctx, `UPDATE credit_push_outbox SET claim_token=$2::uuid,claimed_until=NOW()+INTERVAL '1 minute' WHERE id=$1`, id, claim); err != nil {
		return false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, err
	}
	var ticket creditPushTicket
	var sendErr error
	if receipt == nil {
		sound, vibration := 0, 0
		if prefs.Sound {
			sound = 1
		}
		if prefs.Vibration {
			vibration = 1
		}
		// Privacy boundary: no customer/name/amount/vault/account/policy/direction
		// metadata is sent to the provider, even with full previews enabled.
		payload := map[string]any{"to": token, "title": "Kaata", "body": creditAlertPushBody(locale), "channelId": fmt.Sprintf("tab-updates-s%d-v%d", sound, vibration), "ttl": 86400, "data": map[string]any{"kind": "credit_alert", "event_key": eventKey}}
		if prefs.Sound {
			payload["sound"] = "default"
		}
		var answer struct {
			Data creditPushTicket `json:"data"`
		}
		sendErr = s.creditPush.post(ctx, "/send", payload, &answer)
		ticket = answer.Data
	} else {
		var answer struct {
			Data map[string]creditPushTicket `json:"data"`
		}
		sendErr = s.creditPush.post(ctx, "/getReceipts", map[string]any{"ids": []string{*receipt}}, &answer)
		ticket = answer.Data[*receipt]
	}
	switch {
	case sendErr == nil && ticket.Details.Error == "DeviceNotRegistered":
		_, err = s.pool.Exec(ctx, `DELETE FROM credit_push_subscriptions WHERE id=$1::uuid AND token=$2 AND EXISTS(SELECT 1 FROM credit_push_outbox WHERE id=$3 AND claim_token=$4::uuid)`, subID, token, id, claim)
	case sendErr == nil && ticket.Status == "ok" && receipt != nil:
		_, err = s.pool.Exec(ctx, `DELETE FROM credit_push_outbox WHERE id=$1 AND claim_token=$2::uuid`, id, claim)
	case sendErr == nil && ticket.Status == "ok" && ticket.ID != "":
		_, err = s.pool.Exec(ctx, `UPDATE credit_push_outbox SET receipt_id=$2,next_at=NOW()+INTERVAL '15 minutes',claim_token=NULL,claimed_until=NULL WHERE id=$1 AND claim_token=$3::uuid`, id, ticket.ID, claim)
	case sendErr == nil && ticket.Status == "error" && attempts >= 1:
		_, err = s.pool.Exec(ctx, `DELETE FROM credit_push_outbox WHERE id=$1 AND claim_token=$2::uuid`, id, claim)
	case sendErr == nil && receipt != nil && ticket.Status == "":
		_, err = s.pool.Exec(ctx, `UPDATE credit_push_outbox SET next_at=NOW()+INTERVAL '15 minutes',claim_token=NULL,claimed_until=NULL WHERE id=$1 AND claim_token=$2::uuid`, id, claim)
	default:
		delay := time.Minute * time.Duration(1<<min(attempts, 6))
		if receipt != nil && ticket.Status == "error" {
			receipt = nil
		}
		_, err = s.pool.Exec(ctx, `UPDATE credit_push_outbox SET attempts=attempts+1,receipt_id=$2,next_at=NOW()+$3::interval,claim_token=NULL,claimed_until=NULL WHERE id=$1 AND claim_token=$4::uuid`, id, receipt, fmt.Sprintf("%d seconds", int(delay.Seconds())), claim)
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

func creditAlertPushBody(locale string) string {
	switch applocale.Normalize(locale) {
	case "fa":
		return "به حد هشدار قرض رسیده‌اید. برای بررسی، کاتا را باز کنید."
	case "ps":
		return "د پور د خبرتیا حد ته رسېدلی. د کتلو لپاره کاټا پرانیزئ."
	default:
		return "A credit alert threshold was reached. Open Kaata to review."
	}
}

func (h *Handler) CreditAlertEvent(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	claims, ok := auth.ClaimsFromContext(r.Context())
	if !ok {
		httpx.Error(w, 401, "authentication required")
		return
	}
	eventKey := chi.URLParam(r, "event_key")
	if _, err := uuid.Parse(eventKey); err != nil {
		httpx.Error(w, 404, "notification unavailable")
		return
	}
	var vaultID, relID, direction, watchKey, fingerprint string
	var generation int64
	err := h.svc.pool.QueryRow(r.Context(), `SELECT s.vault_id::text,e.relationship_id::text,e.direction,e.watch_key,e.fingerprint,e.generation FROM credit_alert_events e JOIN credit_push_subscriptions s ON s.id=e.subscription_id JOIN credit_alert_states st ON st.subscription_id=e.subscription_id AND st.relationship_id=e.relationship_id AND st.direction=e.direction AND st.watch_key=e.watch_key WHERE e.event_key=$1::uuid AND s.account_id=$2::uuid AND s.install_id=$3::uuid AND s.session_epoch=$4 AND e.created_at>NOW()-INTERVAL '30 days' AND st.fingerprint=e.fingerprint AND st.generation=e.generation AND st.matched`, eventKey, claims.AccountID, claims.InstallID, claims.Epoch).Scan(&vaultID, &relID, &direction, &watchKey, &fingerprint, &generation)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(w, 404, "notification unavailable")
		return
	}
	if err != nil {
		httpx.Error(w, 500, "storage unavailable")
		return
	}
	tx, err := h.svc.pool.Begin(r.Context())
	if err != nil {
		httpx.Error(w, 500, "storage unavailable")
		return
	}
	defer tx.Rollback(r.Context())
	valid, err := lockCreditPushIdentity(r.Context(), tx, claims.AccountID, claims.InstallID, claims.Epoch)
	if err != nil {
		httpx.Error(w, 500, "storage unavailable")
		return
	}
	if !valid {
		httpx.Error(w, 404, "notification unavailable")
		return
	}
	if err := credit.Lock(r.Context(), tx, vaultID); err != nil {
		httpx.Error(w, 500, "storage unavailable")
		return
	}
	valid, err = creditPushMembership(r.Context(), tx, vaultID, claims.AccountID)
	if err != nil {
		httpx.Error(w, 500, "storage unavailable")
		return
	}
	if !valid {
		httpx.Error(w, 404, "notification unavailable")
		return
	}
	// Recheck the event after taking the vault lock. Registration, rearming or
	// a replaced membership seat may have changed since the initial lookup.
	err = tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM credit_alert_events e JOIN credit_push_subscriptions s ON s.id=e.subscription_id JOIN vault_members m ON m.id=s.vault_member_id AND m.vault_id=s.vault_id AND m.account_id=s.account_id JOIN credit_alert_states st ON st.subscription_id=e.subscription_id AND st.relationship_id=e.relationship_id AND st.direction=e.direction AND st.watch_key=e.watch_key WHERE e.event_key=$1::uuid AND s.account_id=$2::uuid AND s.install_id=$3::uuid AND s.session_epoch=$4 AND e.created_at>NOW()-INTERVAL '30 days' AND s.renewed_at>NOW()-INTERVAL '30 days' AND (e.watch_key='' OR s.limit_alerts) AND m.accepted_at IS NOT NULL AND m.revoked_at IS NULL AND m.role IN ('owner','manager') AND st.fingerprint=e.fingerprint AND st.generation=e.generation AND st.matched)`, eventKey, claims.AccountID, claims.InstallID, claims.Epoch).Scan(&valid)
	if err != nil {
		httpx.Error(w, 500, "storage unavailable")
		return
	}
	if !valid {
		httpx.Error(w, 404, "notification unavailable")
		return
	}
	policy, err := creditWatchPolicy(r.Context(), tx, vaultID, relID, watchKey)
	if err != nil {
		httpx.Error(w, 500, "storage unavailable")
		return
	}
	if policy == nil || creditAlertFingerprint(policy, direction) != fingerprint {
		httpx.Error(w, 404, "notification unavailable")
		return
	}
	projection, err := LoadVaultProjection(r.Context(), tx, vaultID)
	if err != nil {
		httpx.Error(w, 500, "storage unavailable")
		return
	}
	rel := projection.Relationships[relID]
	if rel == nil || rel.ArchivedAt != nil {
		httpx.Error(w, 404, "notification unavailable")
		return
	}
	balances, err := creditWatchBalances(r.Context(), tx, vaultID, relID, policy, projection, direction)
	if err != nil {
		httpx.Error(w, 500, "storage unavailable")
		return
	}

	if !policy.Matches(direction, balances) {
		httpx.Error(w, 404, "notification unavailable")
		return
	}
	payload := map[string]any{"kind": "credit_alert", "owner_scope": "account:" + claims.AccountID, "vault_id": vaultID, "relationship_id": relID, "person_id": rel.UserBID, "direction": direction, "event_key": eventKey, "rule_fingerprint": fingerprint, "policy_updated_at_ms": policy.UpdatedAtMS}
	if watchKey != "" {
		payload["limit_currency"] = strings.TrimPrefix(watchKey, "limit:")
	}
	httpx.JSON(w, 200, payload)
}
