package tabs

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/matee/kaata-backend/internal/auth"
	"github.com/matee/kaata-backend/internal/httpx"
	applocale "github.com/matee/kaata-backend/internal/locale"
)

// AccountNotifications registers one signed-in installation independently of
// shared tallies, so even a person's first invitation can wake their phone.
func (h *Handler) AccountNotifications(w http.ResponseWriter, r *http.Request) {
	noStore(w)
	claims, ok := auth.ClaimsFromContext(r.Context())
	if !ok {
		writeServiceError(w, ErrAuthRequired)
		return
	}
	var req struct {
		InstallID   string          `json:"install_id"`
		Token       string          `json:"token"`
		Locale      string          `json:"locale"`
		Preferences json.RawMessage `json:"preferences"`
	}
	if !decodeBody(w, r, &req) {
		return
	}
	if _, err := uuid.Parse(req.InstallID); err != nil || (req.Token != "" && !expoTokenRE.MatchString(req.Token)) {
		httpx.ErrorCode(w, 400, "invalid_body", "invalid notification registration")
		return
	}
	var preferences []byte
	if len(req.Preferences) > 0 {
		policy, err := decodeNotificationPreferences(req.Preferences)
		if err != nil {
			httpx.ErrorCode(w, 400, "invalid_body", "invalid notification preferences")
			return
		}
		preferences, _ = json.Marshal(policy)
	}
	tx, err := h.svc.pool.Begin(r.Context())
	if err != nil {
		writeServiceError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	if err = lockActor(r.Context(), tx, &claims.AccountID); err != nil {
		writeServiceError(w, ErrAuthRequired)
		return
	}
	// Middleware may briefly cache a session. Push identity changes require a
	// fresh credential/epoch check so an old login cannot rebind the device.
	var credential int
	err = tx.QueryRow(r.Context(), `SELECT 1 FROM auth_credentials WHERE install_id=$1::uuid
 AND account_id=$2::uuid AND provider=$3 AND provider_sub=$4 AND session_epoch=$5 AND revoked_at IS NULL FOR SHARE`,
		claims.InstallID, claims.AccountID, claims.Provider, claims.ProviderSub, claims.Epoch).Scan(&credential)
	if errors.Is(err, pgx.ErrNoRows) {
		writeServiceError(w, ErrAuthRequired)
		return
	}
	if err != nil {
		writeServiceError(w, err)
		return
	}
	// Installation identity comes exclusively from the verified JWT. Serialize
	// rotation/logout/account switching before touching any delivery bindings.
	_, err = tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, "account-push:"+claims.InstallID)
	if err == nil && req.Token == "" {
		_, err = tx.Exec(r.Context(), `DELETE FROM account_push_subscriptions WHERE install_id=$1::uuid AND account_id=$2::uuid`, claims.InstallID, claims.AccountID)
	} else if err == nil {
		_, err = tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, req.Token)
		if err == nil {
			_, err = tx.Exec(r.Context(), `DELETE FROM account_push_subscriptions WHERE
    (install_id=$1::uuid AND account_id<>$2::uuid) OR (token=$3 AND (install_id<>$1::uuid OR account_id<>$2::uuid))`, claims.InstallID, claims.AccountID, req.Token)
		}
		if err == nil {
			_, err = tx.Exec(r.Context(), `DELETE FROM tab_push_subscriptions WHERE
    (install_id=$1::uuid AND account_id IS DISTINCT FROM $2::uuid) OR (token=$3 AND (install_id<>$1::uuid OR account_id IS DISTINCT FROM $2::uuid))`, claims.InstallID, claims.AccountID, req.Token)
		}
		if err == nil {
			_, err = tx.Exec(r.Context(), `INSERT INTO account_push_subscriptions(install_id,account_id,token,locale,preferences)
    VALUES($1::uuid,$2::uuid,$3,$4,$5::jsonb) ON CONFLICT(install_id) DO UPDATE SET token=EXCLUDED.token,
    locale=EXCLUDED.locale,preferences=COALESCE(EXCLUDED.preferences,account_push_subscriptions.preferences),renewed_at=NOW()`, claims.InstallID, claims.AccountID, req.Token, applocale.Normalize(req.Locale), preferences)
		}
	}
	if err == nil {
		err = tx.Commit(r.Context())
	}
	if err != nil {
		writeServiceError(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]bool{"enabled": h.svc.push != nil})
}

// Ended requests remain visible as read history. They cannot ring later or
// leave a misleading unread badge merely because expiry has no writer.
const connectionNoticeCurrentSQL = `CASE n.event_kind
 WHEN 'friend_requested' THEN EXISTS(SELECT 1 FROM account_friendships f WHERE f.id=n.source_id
  AND f.status='pending' AND f.expires_at>NOW()
  AND CASE WHEN f.requested_by=f.account_low_id THEN f.account_high_id ELSE f.account_low_id END=n.recipient_account_id)
 WHEN 'vault_invite_requested' THEN EXISTS(SELECT 1 FROM vault_members vm JOIN vaults v ON v.vault_id=vm.vault_id
  WHERE vm.invite_request_id=n.source_id AND vm.invite_account_id=n.recipient_account_id
  AND vm.accepted_at IS NULL AND vm.revoked_at IS NULL AND vm.invite_expires_at>NOW()
  AND v.archived_at IS NULL AND v.purged_at IS NULL
  AND EXISTS(SELECT 1 FROM vault_members authority WHERE authority.vault_id=vm.vault_id AND authority.account_id=vm.invited_by
   AND authority.accepted_at IS NOT NULL AND authority.revoked_at IS NULL AND authority.role IN ('owner','manager')
   AND (authority.custom_role_id IS NULL OR EXISTS(SELECT 1 FROM vault_custom_roles cr WHERE cr.id=authority.custom_role_id AND 'vault.members'=ANY(cr.permissions)))))
 WHEN 'shared_invite_requested' THEN EXISTS(SELECT 1 FROM people_requests r JOIN tab_groups g ON g.id=r.group_id
  WHERE r.id=n.source_id AND r.recipient_account_id=n.recipient_account_id AND ` + pendingPeopleRequestSQL + `)
 WHEN 'vault_member_return_requested' THEN EXISTS(SELECT 1 FROM vault_members vm JOIN vaults v ON v.vault_id=vm.vault_id
  WHERE vm.invite_request_id=n.source_id AND vm.readmission_consented_at IS NOT NULL AND vm.accepted_at IS NULL
  AND vm.revoked_at IS NULL AND vm.invite_expires_at>NOW() AND v.archived_at IS NULL AND v.purged_at IS NULL
  AND EXISTS(SELECT 1 FROM vault_members owner WHERE owner.id=vm.readmission_owner_member_id
   AND owner.account_id=n.recipient_account_id AND owner.role='owner' AND owner.accepted_at IS NOT NULL AND owner.revoked_at IS NULL))
 ELSE TRUE END`

func connectionRequestCurrent(ctx context.Context, q querier, kind, source, recipient string) (bool, error) {
	var current bool
	err := q.QueryRow(ctx, `SELECT `+connectionNoticeCurrentSQL+` FROM account_connection_notifications n
  WHERE n.event_kind=$1 AND n.source_id=$2::uuid AND n.recipient_account_id=$3::uuid`, kind, source, recipient).Scan(&current)
	return current, err
}

// As with tab delivery, a leased row prevents concurrent workers sending the
// same job. Expo/APNs/FCM cannot promise exactly-once transport; stable event
// IDs, collapseId and Android tag reduce duplicate presentation on retries.
func (s *Service) deliverAccountPush(ctx context.Context) (bool, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)
	var id, notice int64
	var sub, recipient, token, locale, kind, source, actor, actorLabel, vault, vaultLabel, detail string
	var currentRaw, eventRaw []byte
	var at time.Time
	var receipt *string
	var attempts int
	var valid bool
	err = tx.QueryRow(ctx, `SELECT o.id,n.id,s.id::text,s.account_id::text,s.token,s.locale,n.event_kind,n.source_id::text,
  n.actor_account_id::text,n.actor_label,COALESCE(n.vault_id::text,''),COALESCE(n.vault_label,''),COALESCE(n.detail,''),
  s.preferences,o.event_preferences,n.created_at,o.receipt_id,o.attempts,
  n.recipient_account_id=s.account_id AND n.read_at IS NULL AND s.renewed_at>NOW()-INTERVAL '30 days'
  AND o.created_at>NOW()-INTERVAL '24 hours' AND a.disabled_at IS NULL AND a.pending_delete_at IS NULL
  AND actor.disabled_at IS NULL AND actor.pending_delete_at IS NULL
  AND EXISTS(SELECT 1 FROM auth_credentials c WHERE c.install_id=s.install_id AND c.account_id=s.account_id AND c.revoked_at IS NULL)
  FROM account_push_outbox o JOIN account_push_subscriptions s ON s.id=o.subscription_id
  JOIN account_connection_notifications n ON n.id=o.notification_id
  JOIN accounts a ON a.id=s.account_id JOIN accounts actor ON actor.id=n.actor_account_id
  WHERE o.next_at<=NOW() ORDER BY o.next_at,o.id LIMIT 1 FOR UPDATE OF o,s SKIP LOCKED`).Scan(
		&id, &notice, &sub, &recipient, &token, &locale, &kind, &source, &actor, &actorLabel, &vault, &vaultLabel, &detail,
		&currentRaw, &eventRaw, &at, &receipt, &attempts, &valid)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	policy := legacyNotificationPreferences()
	for i, raw := range [][]byte{eventRaw, currentRaw} {
		next := legacyNotificationPreferences()
		if len(raw) > 0 {
			next, err = decodeNotificationPreferences(raw)
			if err != nil {
				valid = false
			}
		}
		when := time.Now()
		if i == 0 {
			when = at
		}
		valid = valid && next.permits(kind, when)
		if i == 1 {
			policy = next
		}
	}
	if valid {
		valid, err = connectionRequestCurrent(ctx, tx, kind, source, recipient)
		if err != nil {
			return false, err
		}
	}
	if !valid {
		_, err = tx.Exec(ctx, `DELETE FROM account_push_outbox WHERE id=$1`, id)
	} else {
		var ticket pushTicket
		var sendErr error
		if receipt == nil {
			body := connectionNoticeBody(kind, locale, actorLabel, vaultLabel, detail)
			if policy.Previews == "private" {
				body = connectionNoticeBody(kind, locale, "", "", "")
			}
			if policy.Previews == "name" {
				body = connectionNoticeBody(kind, locale, actorLabel, "", "")
			}
			data := map[string]any{"notification_id": strconv.FormatInt(notice, 10), "kind": kind, "source_id": source, "actor_account_id": actor, "recipient_account_id": recipient, "target": "connection"}
			if vault != "" {
				data["vault_id"] = vault
			}
			payload := notificationPayloadWithPreferences(token, body, data, &policy)
			stable := "kaata-connection-" + strconv.FormatInt(notice, 10)
			payload["collapseId"], payload["tag"] = stable, stable
			var answer struct {
				Data pushTicket `json:"data"`
			}
			sendErr = s.push.post(ctx, "/send", payload, &answer)
			ticket = answer.Data
		} else {
			var answer struct {
				Data map[string]pushTicket `json:"data"`
			}
			sendErr = s.push.post(ctx, "/getReceipts", map[string]any{"ids": []string{*receipt}}, &answer)
			ticket = answer.Data[*receipt]
		}
		switch {
		case sendErr == nil && ticket.Details.Error == "DeviceNotRegistered":
			_, err = tx.Exec(ctx, `DELETE FROM account_push_subscriptions WHERE id=$1::uuid AND token=$2`, sub, token)
		case sendErr == nil && ticket.Status == "ok" && receipt != nil:
			_, err = tx.Exec(ctx, `DELETE FROM account_push_outbox WHERE id=$1`, id)
		case sendErr == nil && ticket.Status == "ok" && ticket.ID != "":
			_, err = tx.Exec(ctx, `UPDATE account_push_outbox SET receipt_id=$2,next_at=NOW()+INTERVAL '15 minutes' WHERE id=$1`, id, ticket.ID)
		case sendErr == nil && ticket.Status == "error" && attempts >= 1:
			_, err = tx.Exec(ctx, `DELETE FROM account_push_outbox WHERE id=$1`, id)
		case sendErr == nil && receipt != nil && ticket.Status == "":
			_, err = tx.Exec(ctx, `UPDATE account_push_outbox SET next_at=NOW()+INTERVAL '15 minutes' WHERE id=$1`, id)
		default:
			if receipt != nil && ticket.Status == "error" {
				receipt = nil
			}
			delay := time.Minute * time.Duration(1<<min(attempts, 6))
			_, err = tx.Exec(ctx, `UPDATE account_push_outbox SET attempts=attempts+1,receipt_id=$2,next_at=NOW()+$3::interval WHERE id=$1`, id, receipt, fmt.Sprintf("%d seconds", int(delay.Seconds())))
		}
	}
	if err != nil {
		return false, err
	}
	return true, tx.Commit(ctx)
}
