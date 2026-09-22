package tabs

// Push is a delivery hint, never the ledger. Mutations enqueue inside their
// transaction; the worker sends generic text and a tab ID, with no customer
// name, balance, note, invitation token or authority to accept a tally.
import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"regexp"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/matee/kaata-backend/internal/auth"
	"github.com/matee/kaata-backend/internal/httpx"
)

type pushClient struct {
	client               *http.Client
	baseURL, accessToken string
}

var expoTokenRE = regexp.MustCompile(`^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]{10,200}\]$`)

// StartPush is configured once before serving HTTP. Disabled unless the
// deployment explicitly enables it after configuring EAS FCM/APNs keys.
func (s *Service) StartPush(ctx context.Context, enabled bool, accessToken string) {
	if !enabled {
		return
	}
	s.push = &pushClient{client: &http.Client{Timeout: 8 * time.Second}, baseURL: "https://exp.host/--/api/v2/push", accessToken: accessToken}
	go func() {
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		for {
			for n := 0; n < 100 && ctx.Err() == nil; n++ {
				more, err := s.deliverPush(ctx)
				if err != nil {
					log.Printf("tabs push: delivery attempt failed (%T)", err)
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

// Notifications registers/refreshes this installation for this party, or
// unregisters when token is empty (permission revoked). Party auth is required.
func (h *Handler) Notifications(w http.ResponseWriter, r *http.Request) {
	noStore(w)
	p, ok := h.partyOr404(w, r)
	if !ok {
		return
	}
	if h.svc.push == nil {
		httpx.JSON(w, 200, map[string]bool{"enabled": false})
		return
	}
	var req struct {
		InstallID string `json:"install_id"`
		Token     string `json:"token"`
		Locale    string `json:"locale"`
	}
	if !decodeBody(w, r, &req) {
		return
	}
	if _, err := uuid.Parse(req.InstallID); err != nil || (req.Token != "" && !expoTokenRE.MatchString(req.Token)) {
		httpx.ErrorCode(w, 400, "invalid_body", "invalid notification registration")
		return
	}
	if req.Locale != "fa" {
		req.Locale = "en"
	}
	var accountID *string
	var capability *string
	if token := tabTokenFromHeader(r.Header.Get("Authorization")); token != "" {
		hash := hashPartyToken(token)
		capability = &hash
	} else if claims, ok := auth.ClaimsFromContext(r.Context()); ok {
		accountID = &claims.AccountID
	}
	if req.Token == "" {
		_, err := h.svc.pool.Exec(r.Context(), `DELETE FROM tab_push_subscriptions WHERE tab_id=$1::uuid AND role=$2 AND install_id=$3::uuid`, p.TabID, p.Role, req.InstallID)
		if err != nil {
			writeServiceError(w, err)
			return
		}
	} else {
		_, err := h.svc.pool.Exec(r.Context(), `INSERT INTO tab_push_subscriptions
   (tab_id,role,install_id,token,locale,account_id,capability_hash)
   VALUES($1::uuid,$2,$3::uuid,$4,$5,$6::uuid,$7)
   ON CONFLICT(tab_id,install_id) DO UPDATE SET role=EXCLUDED.role,token=EXCLUDED.token,
    locale=EXCLUDED.locale,account_id=EXCLUDED.account_id,capability_hash=EXCLUDED.capability_hash,renewed_at=NOW()`,
			p.TabID, p.Role, req.InstallID, req.Token, req.Locale, accountID, capability)
		if err != nil {
			writeServiceError(w, err)
			return
		}
	}
	httpx.JSON(w, 200, map[string]bool{"enabled": true})
}

func queuePush(ctx context.Context, tx pgx.Tx, tabID, actor string, rev int64) error {
	_, err := tx.Exec(ctx, `INSERT INTO tab_push_outbox(subscription_id,rev)
  SELECT id,$2 FROM tab_push_subscriptions WHERE tab_id=$1::uuid AND role<>$3
   AND renewed_at>NOW()-INTERVAL '30 days' ON CONFLICT DO NOTHING`, tabID, rev, actor)
	return err
}

type pushTicket struct {
	Status  string `json:"status"`
	ID      string `json:"id"`
	Details struct {
		Error string `json:"error"`
	} `json:"details"`
}

func (p *pushClient) post(ctx context.Context, path string, body any, out any) error {
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
		return fmt.Errorf("push HTTP %d", res.StatusCode)
	}
	return json.NewDecoder(io.LimitReader(res.Body, 64<<10)).Decode(out)
}

// One leased job per transaction, so concurrent workers cannot send the
// same revision together. An ambiguous network failure can deliver twice;
// the stable tab_id/rev lets clients dedupe. Receipt success is provider
// acceptance, not a promise that a person saw the notification.
func (s *Service) deliverPush(ctx context.Context) (bool, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)
	var id, rev int64
	var subID, tabID, role, token, locale string
	var receipt *string
	var attempts int
	var valid bool
	err = tx.QueryRow(ctx, `SELECT o.id,o.rev,o.subscription_id::text,s.tab_id::text,s.role,s.token,s.locale,
  o.receipt_id,o.attempts,
	  s.renewed_at>NOW()-INTERVAL '30 days' AND o.created_at>NOW()-INTERVAL '24 hours' AND COALESCE((
   (s.capability_hash IS NOT NULL AND s.capability_hash=p.token_hash) OR
   (s.account_id IS NOT NULL AND (s.account_id=p.account_id OR EXISTS(
    SELECT 1 FROM vault_members vm WHERE vm.vault_id=p.vault_id AND vm.account_id=s.account_id
      AND vm.accepted_at IS NOT NULL AND vm.revoked_at IS NULL)))), FALSE)
  FROM tab_push_outbox o JOIN tab_push_subscriptions s ON s.id=o.subscription_id
  JOIN tab_parties p ON p.tab_id=s.tab_id AND p.role=s.role
  WHERE o.next_at<=NOW() ORDER BY o.next_at,o.id LIMIT 1 FOR UPDATE OF o SKIP LOCKED`).Scan(
		&id, &rev, &subID, &tabID, &role, &token, &locale, &receipt, &attempts, &valid)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if !valid {
		_, err = tx.Exec(ctx, `DELETE FROM tab_push_outbox WHERE id=$1`, id)
	} else {
		var ticket pushTicket
		var sendErr error
		if receipt == nil {
			body := "Your shared account has an update. Open Kaata to review it."
			if locale == "fa" {
				body = "حساب مشترک شما به‌روز شده است. برای بررسی، کاتا را باز کنید."
			}
			var answer struct {
				Data pushTicket `json:"data"`
			}
			sendErr = s.push.post(ctx, "/send", map[string]any{"to": token, "title": "Kaata", "body": body,
				"sound": "default", "channelId": "tab-updates", "ttl": 86400,
				"data": map[string]any{"tab_id": tabID, "rev": rev}}, &answer)
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
			_, err = tx.Exec(ctx, `DELETE FROM tab_push_subscriptions WHERE id=$1::uuid AND token=$2`, subID, token)
		case sendErr == nil && ticket.Status == "ok" && receipt != nil:
			_, err = tx.Exec(ctx, `DELETE FROM tab_push_outbox WHERE id=$1`, id)
		case sendErr == nil && ticket.Status == "ok" && ticket.ID != "":
			_, err = tx.Exec(ctx, `UPDATE tab_push_outbox SET receipt_id=$2,next_at=NOW()+INTERVAL '15 minutes' WHERE id=$1`, id, ticket.ID)
		default:
			// Never log a provider message: it can contain the device token.
			delay := time.Minute * time.Duration(1<<min(attempts, 6))
			// A negative receipt needs a new send; a missing receipt just needs another lookup.
			if receipt != nil && ticket.Status == "error" {
				receipt = nil
			}
			_, err = tx.Exec(ctx, `UPDATE tab_push_outbox SET attempts=attempts+1,receipt_id=$2,next_at=NOW()+$3::interval WHERE id=$1`, id, receipt, fmt.Sprintf("%d seconds", int(delay.Seconds())))
		}
	}
	if err != nil {
		return false, err
	}
	return true, tx.Commit(ctx)
}
