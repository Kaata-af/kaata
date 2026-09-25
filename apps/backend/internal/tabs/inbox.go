package tabs

import (
	"context"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/jackc/pgx/v5"
	"github.com/matee/kaata-backend/internal/auth"
	"github.com/matee/kaata-backend/internal/httpx"
)

// Re-evaluate access for EVERY read/mark-read. A previously subscribed device,
// forwarded link, removed member or unrelated account cannot read this inbox.
const inboxAccess = `(p.account_id=$1::uuid OR EXISTS (
 SELECT 1 FROM vault_members vm WHERE vm.vault_id=p.vault_id
 AND vm.account_id=$1::uuid AND vm.accepted_at IS NOT NULL AND vm.revoked_at IS NULL))
 AND n.actor_account_id IS DISTINCT FROM $1::uuid`

type InboxItem struct {
	ID          string `json:"id"`
	TabID       string `json:"tab_id"`
	Role        string `json:"role"`
	Rev         int64  `json:"rev"`
	Kind        string `json:"kind"`
	EntryID     string `json:"entry_id"`
	Body        string `json:"body"`
	CreatedAtMS int64  `json:"created_at_ms"`
	Read        bool   `json:"read"`
}
type InboxPage struct {
	Items      []InboxItem `json:"items"`
	Unread     int         `json:"unread"`
	NextBefore string      `json:"next_before"`
	LatestID   string      `json:"latest_id"`
}

func (h *Handler) Inbox(w http.ResponseWriter, r *http.Request) {
	noStore(w)
	claims, ok := auth.ClaimsFromContext(r.Context())
	if !ok {
		writeServiceError(w, ErrAuthRequired)
		return
	}
	before := int64(0)
	if v := r.URL.Query().Get("before"); v != "" {
		var err error
		before, err = strconv.ParseInt(v, 10, 64)
		if err != nil || before <= 0 {
			httpx.ErrorCode(w, 400, "invalid_cursor", "invalid cursor")
			return
		}
	}
	page, err := h.svc.listInbox(r.Context(), claims.AccountID, r.URL.Query().Get("locale"), before)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	httpx.JSON(w, 200, page)
}

func (s *Service) listInbox(ctx context.Context, accountID, locale string, before int64) (InboxPage, error) {
	page := InboxPage{Items: []InboxItem{}}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return page, err
	}
	defer tx.Rollback(ctx)
	err = tx.QueryRow(ctx, `SELECT COUNT(*) FILTER (WHERE nr.notification_id IS NULL), COALESCE(MAX(n.id),0)::text
 FROM tab_notifications n JOIN tab_parties p ON p.tab_id=n.tab_id AND p.role=n.recipient_role
 LEFT JOIN tab_notification_reads nr ON nr.notification_id=n.id AND nr.account_id=$1::uuid
 WHERE `+inboxAccess, accountID).Scan(&page.Unread, &page.LatestID)
	if err != nil {
		return page, err
	}
	rows, err := tx.Query(ctx, `SELECT n.id::text,n.tab_id::text,n.recipient_role,n.rev,n.event_kind,
 COALESCE(n.entry_id::text,''),CASE WHEN n.actor_account_id IS NULL THEN '' ELSE n.actor_label END,n.created_at,nr.notification_id IS NOT NULL,
 COALESCE(e.amount_minor,0),COALESCE(e.direction,''),t.currency
 FROM tab_notifications n JOIN tab_parties p ON p.tab_id=n.tab_id AND p.role=n.recipient_role
 JOIN tabs t ON t.id=n.tab_id LEFT JOIN tab_entries e ON e.id=n.entry_id AND e.tab_id=n.tab_id
 LEFT JOIN tab_notification_reads nr ON nr.notification_id=n.id AND nr.account_id=$1::uuid
 WHERE `+inboxAccess+` AND ($2::bigint=0 OR n.id<$2) ORDER BY n.id DESC LIMIT 51`, accountID, before)
	if err != nil {
		return page, err
	}
	defer rows.Close()
	for rows.Next() {
		var item InboxItem
		var at time.Time
		var actor, direction, currency string
		var amount int64
		if err = rows.Scan(&item.ID, &item.TabID, &item.Role, &item.Rev, &item.Kind, &item.EntryID, &actor, &at, &item.Read, &amount, &direction, &currency); err != nil {
			return page, err
		}
		item.CreatedAtMS = at.UnixMilli()
		item.Body = detailedPushBody(item.Kind, locale, actor, amount, direction, currency, item.Role)
		page.Items = append(page.Items, item)
	}
	if err = rows.Err(); err != nil {
		return page, err
	}
	rows.Close()
	if len(page.Items) > 50 {
		page.Items = page.Items[:50]
		page.NextBefore = page.Items[49].ID
	}
	return page, tx.Commit(ctx)
}

func (h *Handler) ReadInbox(w http.ResponseWriter, r *http.Request) {
	noStore(w)
	claims, ok := auth.ClaimsFromContext(r.Context())
	if !ok {
		writeServiceError(w, ErrAuthRequired)
		return
	}
	var req struct {
		ID      string `json:"id"`
		Through string `json:"through"`
	}
	if !decodeBody(w, r, &req) {
		return
	}
	value := req.ID
	if value == "" {
		value = req.Through
	}
	id, err := strconv.ParseInt(value, 10, 64)
	if err != nil || id <= 0 || (req.ID != "" && req.Through != "") {
		httpx.ErrorCode(w, 400, "invalid_body", "provide one notification id or through cursor")
		return
	}
	_, err = h.svc.pool.Exec(r.Context(), `INSERT INTO tab_notification_reads(notification_id,account_id)
 SELECT n.id,$1::uuid FROM tab_notifications n
 JOIN tab_parties p ON p.tab_id=n.tab_id AND p.role=n.recipient_role
 WHERE `+inboxAccess+` AND (n.id=$2 OR ($3::boolean AND n.id<=$2))
 ON CONFLICT DO NOTHING`, claims.AccountID, id, req.Through != "")
	if err != nil {
		writeServiceError(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]bool{"ok": true})
}

func notificationLabel(label string) string {
	// Bound payload size; remove direction overrides/newlines from user input.
	label = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			return -1
		}
		return r
	}, label)
	runes := []rune(strings.TrimSpace(label))
	if len(runes) > 60 {
		runes = append(runes[:60], '…')
	}
	return string(runes)
}

func detailedPushBody(kind, locale, actor string, minor int64, direction, currency, recipient string) string {
	actor = notificationLabel(actor)
	if actor == "" {
		if locale == "fa" {
			actor = "طرف مقابل"
		} else {
			actor = "The other party"
		}
	}
	actor = "\u2068" + actor + "\u2069"
	if minor <= 0 {
		return actor + ": " + pushBody(kind, locale)
	}
	sign := "−"
	if (direction == "a_to_b" && recipient == "a") || (direction == "b_to_a" && recipient == "b") {
		sign = "+"
	}
	amount := "\u2066" + sign + formatMinor(minor) + " " + currency + "\u2069"
	if locale == "fa" {
		switch kind {
		case "entry_created":
			return fmt.Sprintf("%s یک ثبت %s افزود. قبول یا رد کنید.", actor, amount)
		case "entry_accepted":
			return fmt.Sprintf("ثبت %s شما توسط %s قبول شد.", amount, actor)
		case "entry_rejected":
			return fmt.Sprintf("ثبت %s شما توسط %s رد شد؛ در مانده حساب نمی‌شود.", amount, actor)
		case "entry_voided":
			return fmt.Sprintf("ثبت %s توسط %s لغو شد.", amount, actor)
		}
	}
	switch kind {
	case "entry_created":
		return fmt.Sprintf("%s added a tally (%s). Accept or reject it.", actor, amount)
	case "entry_accepted":
		return fmt.Sprintf("Your tally (%s) was accepted by %s.", amount, actor)
	case "entry_rejected":
		return fmt.Sprintf("Your tally (%s) was rejected by %s. Excluded from the balance.", amount, actor)
	case "entry_voided":
		return fmt.Sprintf("%s voided a tally (%s).", actor, amount)
	}
	return actor + ": " + pushBody(kind, locale)
}
