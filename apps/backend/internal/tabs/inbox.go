package tabs

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/matee/kaata-backend/internal/auth"
	"github.com/matee/kaata-backend/internal/httpx"
	applocale "github.com/matee/kaata-backend/internal/locale"
)

// Re-evaluate access for EVERY read/mark-read. A previously subscribed device,
// forwarded link, removed member or unrelated account cannot read this inbox.
const inboxAccess = `(p.account_id=$1::uuid OR EXISTS (
 SELECT 1 FROM vault_members vm WHERE vm.vault_id=p.vault_id
 AND vm.account_id=$1::uuid AND vm.accepted_at IS NOT NULL AND vm.revoked_at IS NULL))
 AND n.actor_account_id IS DISTINCT FROM $1::uuid`

type InboxItem struct {
	ID             string `json:"id"`
	TabID          string `json:"tab_id"`
	Role           string `json:"role"`
	Rev            int64  `json:"rev"`
	Kind           string `json:"kind"`
	EntryID        string `json:"entry_id"`
	ActorAccountID string `json:"actor_account_id,omitempty"`
	Body           string `json:"body"`
	CreatedAtMS    int64  `json:"created_at_ms"`
	Read           bool   `json:"read"`
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
	page, err := h.svc.listInbox(r.Context(), claims.AccountID, r.URL.Query().Get("locale"), before, r.URL.Query().Get("include_connections") == "1")
	if err != nil {
		writeServiceError(w, err)
		return
	}
	httpx.JSON(w, 200, page)
}

func (s *Service) listInbox(ctx context.Context, accountID, locale string, before int64, includeConnections bool) (InboxPage, error) {
	page := InboxPage{Items: []InboxItem{}}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return page, err
	}
	defer tx.Rollback(ctx)
	// Keep old clients' counts and cursors scoped to rows they can display.
	err = tx.QueryRow(ctx, `SELECT tabs.unread+friends.unread,GREATEST(tabs.latest,friends.latest)::text FROM (
 SELECT COUNT(*) FILTER (WHERE nr.notification_id IS NULL) AS unread,COALESCE(MAX(n.id),0) AS latest
 FROM tab_notifications n JOIN tab_parties p ON p.tab_id=n.tab_id AND p.role=n.recipient_role
 LEFT JOIN tab_notification_reads nr ON nr.notification_id=n.id AND nr.account_id=$1::uuid
 WHERE `+inboxAccess+`
 ) tabs CROSS JOIN (
 SELECT COUNT(*) FILTER (WHERE n.read_at IS NULL) AS unread,COALESCE(MAX(n.id),0) AS latest
 FROM account_friend_notifications n WHERE $2::boolean AND n.recipient_account_id=$1::uuid
 ) friends`, accountID, includeConnections).Scan(&page.Unread, &page.LatestID)
	if err != nil {
		return page, err
	}
	rows, err := tx.Query(ctx, `(
 SELECT n.id,n.tab_id::text,n.recipient_role,n.rev,n.event_kind,
 COALESCE(n.entry_id::text,''),n.actor_label,n.created_at,nr.notification_id IS NOT NULL,
 COALESCE(e.amount_minor,0),COALESCE(e.direction,''),t.currency,
 (p.account_id=$1::uuid OR EXISTS(SELECT 1 FROM vault_members vm WHERE vm.vault_id=p.vault_id
   AND vm.account_id=$1::uuid AND vm.accepted_at IS NOT NULL AND vm.revoked_at IS NULL
   AND vm.role IN ('owner','manager','editor'))) AND t.recording_mode='review' AND COALESCE(e.status='pending',FALSE),
 ''::text
 FROM tab_notifications n JOIN tab_parties p ON p.tab_id=n.tab_id AND p.role=n.recipient_role
 JOIN tabs t ON t.id=n.tab_id LEFT JOIN tab_entries e ON e.id=n.entry_id AND e.tab_id=n.tab_id
 LEFT JOIN tab_notification_reads nr ON nr.notification_id=n.id AND nr.account_id=$1::uuid
 WHERE `+inboxAccess+` AND ($2::bigint=0 OR n.id<$2) ORDER BY n.id DESC LIMIT 51
 ) UNION ALL (
 SELECT n.id,''::text,''::text,0,'friend_accepted',''::text,n.actor_label,n.created_at,n.read_at IS NOT NULL,
 0,''::text,''::text,FALSE,n.actor_account_id::text
 FROM account_friend_notifications n
 WHERE $3::boolean AND n.recipient_account_id=$1::uuid AND ($2::bigint=0 OR n.id<$2)
 ORDER BY n.id DESC LIMIT 51
 ) ORDER BY id DESC LIMIT 51`, accountID, before, includeConnections)
	if err != nil {
		return page, err
	}
	defer rows.Close()
	for rows.Next() {
		var item InboxItem
		var id int64
		var at time.Time
		var actor, direction, currency string
		var amount int64
		var canReview bool
		if err = rows.Scan(&id, &item.TabID, &item.Role, &item.Rev, &item.Kind, &item.EntryID, &actor, &at, &item.Read, &amount, &direction, &currency, &canReview, &item.ActorAccountID); err != nil {
			return page, err
		}
		item.ID = strconv.FormatInt(id, 10)
		item.CreatedAtMS = at.UnixMilli()
		if item.Kind == "friend_accepted" {
			item.Body = friendAcceptedBody(locale, actor)
		} else {
			item.Body = detailedPushBody(item.Kind, locale, actor, amount, direction, currency, item.Role, canReview)
		}
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

// ReadInbox marks notices read for the calling ACCOUNT. Exactly one selector
// is accepted (400 invalid_body otherwise):
//
//	{id}                   one notice by inbox id
//	{through}              every notice with id <= through (mark all)
//	{tab_id, entry_id}     every notice of that tab about that tally, any kind
//	{tab_id, rev}          the notice at (tab_id, rev)
//	{tab_id, through_rev}  every notice of that tab with rev <= through_rev
//
// The tab selectors exist because "handled means read": a phone that opened
// the tally from an OS notification, reviewed it, or showed the contact's
// screen knows the tab and a rev or entry, not the inbox id. Every form is
// filtered by inboxAccess, so an outsider marks nothing on anyone's rows, and
// reads are per row: a notice created after the mark is a new unread row.
// `marked` is the number of rows newly marked (0 when they were already read).
func (h *Handler) ReadInbox(w http.ResponseWriter, r *http.Request) {
	noStore(w)
	claims, ok := auth.ClaimsFromContext(r.Context())
	if !ok {
		writeServiceError(w, ErrAuthRequired)
		return
	}
	var req struct {
		ID         string      `json:"id"`
		Through    string      `json:"through"`
		TabID      string      `json:"tab_id"`
		EntryID    string      `json:"entry_id"`
		Rev        json.Number `json:"rev"`
		ThroughRev json.Number `json:"through_rev"`
	}
	if !decodeBody(w, r, &req) {
		return
	}
	where, args, ok := inboxReadSelector(req.ID, req.Through, req.TabID, req.EntryID, string(req.Rev), string(req.ThroughRev))
	if !ok {
		httpx.ErrorCode(w, 400, "invalid_body", "provide exactly one of: id, through, tab_id+entry_id, tab_id+rev, tab_id+through_rev")
		return
	}
	markTabs := `INSERT INTO tab_notification_reads(notification_id,account_id)
 SELECT n.id,$1::uuid FROM tab_notifications n
 JOIN tab_parties p ON p.tab_id=n.tab_id AND p.role=n.recipient_role
 WHERE ` + inboxAccess + ` AND ` + where + `
 ON CONFLICT DO NOTHING`
	params := append([]any{claims.AccountID}, args...)
	if req.TabID == "" && r.URL.Query().Get("include_connections") == "1" {
		var marked int64
		err := h.svc.pool.QueryRow(r.Context(), `WITH tabs AS (`+markTabs+` RETURNING 1), friends AS (
 UPDATE account_friend_notifications n SET read_at=NOW()
 WHERE n.recipient_account_id=$1::uuid AND n.read_at IS NULL AND `+where+` RETURNING 1
 ) SELECT (SELECT COUNT(*) FROM tabs)+(SELECT COUNT(*) FROM friends)`, params...).Scan(&marked)
		if err != nil {
			writeServiceError(w, err)
			return
		}
		httpx.JSON(w, 200, map[string]any{"ok": true, "marked": marked})
		return
	}
	tag, err := h.svc.pool.Exec(r.Context(), markTabs, params...)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true, "marked": tag.RowsAffected()})
}

// inboxReadSelector validates one read body and returns its predicate over
// `n` with $2… placeholders ($1 is the account). ok is false for zero or
// several selectors, a tab_id/entry_id that is not a uuid, or an id, cursor
// or revision that is not a positive integer. rev/through_rev arrive as
// json.Number text, so a JSON number and a numeric string both work — the
// id/through forms are strings on the wire and a client may mirror that.
func inboxReadSelector(id, through, tabID, entryID, rev, throughRev string) (string, []any, bool) {
	positive := func(v string) (int64, bool) {
		n, err := strconv.ParseInt(v, 10, 64)
		return n, err == nil && n > 0
	}
	forms := 0
	for _, present := range []bool{id != "", through != "", entryID != "", rev != "", throughRev != ""} {
		if present {
			forms++
		}
	}
	if forms != 1 {
		return "", nil, false
	}
	if tabID == "" {
		switch {
		case id != "":
			n, ok := positive(id)
			return "n.id=$2", []any{n}, ok
		case through != "":
			n, ok := positive(through)
			return "n.id<=$2", []any{n}, ok
		}
		return "", nil, false
	}
	if _, err := uuid.Parse(tabID); err != nil {
		return "", nil, false
	}
	switch {
	case entryID != "":
		if _, err := uuid.Parse(entryID); err != nil {
			return "", nil, false
		}
		return "n.tab_id=$2::uuid AND n.entry_id=$3::uuid", []any{tabID, entryID}, true
	case rev != "":
		n, ok := positive(rev)
		return "n.tab_id=$2::uuid AND n.rev=$3", []any{tabID, n}, ok
	case throughRev != "":
		n, ok := positive(throughRev)
		return "n.tab_id=$2::uuid AND n.rev<=$3", []any{tabID, n}, ok
	}
	return "", nil, false
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

func friendAcceptedBody(locale, actor string) string {
	actor = notificationLabel(actor)
	if actor != "" {
		actor = "\u2068" + actor + "\u2069"
	}
	switch applocale.Normalize(locale) {
	case "fa":
		if actor == "" {
			return "درخواست دوستی شما پذیرفته شد."
		}
		return actor + " درخواست دوستی شما را پذیرفت."
	case "ps":
		if actor == "" {
			return "ستاسو د ملګرتیا غوښتنه ومنل شوه."
		}
		return actor + " ستاسو د ملګرتیا غوښتنه ومنله."
	default:
		if actor == "" {
			return "Your friend request was accepted."
		}
		return actor + " accepted your friend request."
	}
}

func detailedPushBody(kind, locale, actor string, minor int64, direction, currency, recipient string, canReview bool) string {
	locale = applocale.Normalize(locale)
	actor = notificationLabel(actor)
	if actor == "" {
		if locale == "ps" {
			actor = "بل لوری"
		} else if locale == "fa" {
			actor = "طرف مقابل"
		} else {
			actor = "The other party"
		}
	}
	actor = "\u2068" + actor + "\u2069"
	if minor <= 0 {
		return actor + ": " + pushBodyFor(kind, locale, canReview)
	}
	sign := "−"
	if (direction == "a_to_b" && recipient == "a") || (direction == "b_to_a" && recipient == "b") {
		sign = "+"
	}
	amount := "\u2066" + sign + formatMinor(minor) + " " + currency + "\u2069"
	if locale == "ps" {
		switch kind {
		case "entry_created":
			if !canReview {
				return fmt.Sprintf("%s یوه راکړه ورکړه (%s) زیاته کړه.", actor, amount)
			}
			return fmt.Sprintf("%s یوه راکړه ورکړه (%s) زیاته کړه. ویې منئ یا یې رد کړئ.", actor, amount)
		case "entry_accepted":
			return fmt.Sprintf("ستاسو راکړه ورکړه (%s) د %s له خوا ومنل شوه.", amount, actor)
		case "entry_rejected":
			return fmt.Sprintf("ستاسو راکړه ورکړه (%s) د %s له خوا رد شوه. په پاتې حساب کې نه شمېرل کېږي.", amount, actor)
		case "entry_voided":
			return fmt.Sprintf("%s یوه راکړه ورکړه (%s) لغوه کړه.", actor, amount)
		case "entry_removal_requested":
			return fmt.Sprintf("%s د راکړې ورکړې (%s) د لرې کولو غوښتنه کړې.", actor, amount)
		case "entry_removal_approved":
			return fmt.Sprintf("%s د راکړې ورکړې (%s) لرې کول تایید کړل.", actor, amount)
		case "entry_removal_declined":
			return fmt.Sprintf("%s د راکړې ورکړې (%s) د لرې کولو غوښتنه رد کړه.", actor, amount)
		}
	}
	if locale == "fa" {
		switch kind {
		case "entry_created":
			if !canReview {
				return fmt.Sprintf("%s یک ثبت %s افزود.", actor, amount)
			}
			return fmt.Sprintf("%s یک ثبت %s افزود. قبول یا رد کنید.", actor, amount)
		case "entry_accepted":
			return fmt.Sprintf("ثبت %s شما توسط %s قبول شد.", amount, actor)
		case "entry_rejected":
			return fmt.Sprintf("ثبت %s شما توسط %s رد شد؛ در مانده حساب نمی‌شود.", amount, actor)
		case "entry_voided":
			return fmt.Sprintf("ثبت %s توسط %s لغو شد.", amount, actor)
		case "entry_removal_requested":
			return fmt.Sprintf("%s درخواست حذف ثبت %s را فرستاد.", actor, amount)
		case "entry_removal_approved":
			return fmt.Sprintf("%s حذف ثبت %s را تأیید کرد.", actor, amount)
		case "entry_removal_declined":
			return fmt.Sprintf("%s درخواست حذف ثبت %s را رد کرد.", actor, amount)
		}
	}
	switch kind {
	case "entry_created":
		if !canReview {
			return fmt.Sprintf("%s added a tally (%s).", actor, amount)
		}
		return fmt.Sprintf("%s added a tally (%s). Accept or reject it.", actor, amount)
	case "entry_accepted":
		return fmt.Sprintf("Your tally (%s) was accepted by %s.", amount, actor)
	case "entry_rejected":
		return fmt.Sprintf("Your tally (%s) was rejected by %s. Excluded from the balance.", amount, actor)
	case "entry_voided":
		return fmt.Sprintf("%s voided a tally (%s).", actor, amount)
	case "entry_removal_requested":
		return fmt.Sprintf("%s requested to remove a tally (%s).", actor, amount)
	case "entry_removal_approved":
		return fmt.Sprintf("%s approved removing a tally (%s).", actor, amount)
	case "entry_removal_declined":
		return fmt.Sprintf("%s declined to remove a tally (%s).", actor, amount)
	}
	return actor + ": " + pushBodyFor(kind, locale, canReview)
}
