package tabs

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestRemovedOriginalEditorLosesOnlyThatKaataSharedAuthority(t *testing.T) {
	f := newHTTPFixture(t)
	editor := seedAccount(t, f.pool, "original-editor@example.test", "Original editor")
	seedMember(t, f.pool, f.vaultA, editor, "editor")
	relA, relB := uuid.NewString(), uuid.NewString()
	created, err := f.svc.Create(t.Context(), CreateInput{Currency: "AFN", Label: "Shop", AccountID: &editor, VaultID: &f.vaultA, RelationshipID: &relA})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.svc.Join(t.Context(), f.party(t, created.InviteToken, created.Tab.ID), JoinInput{Label: "Peer", AccountID: &f.acctB, VaultID: &f.vaultB, RelationshipID: &relB}); err != nil {
		t.Fatal(err)
	}
	stale, err := f.svc.partyByAccountRole(t.Context(), created.Tab.ID, editor, "a")
	if err != nil {
		t.Fatal(err)
	}
	oldTokenParty := f.party(t, created.MyToken, created.Tab.ID)
	sends := 0
	var sentPayload map[string]any
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sends++
		if err := json.NewDecoder(r.Body).Decode(&sentPayload); err != nil {
			t.Error(err)
		}
		_, _ = w.Write([]byte(`{"data":{"status":"ok","id":"should-not-send"}}`))
	}))
	defer provider.Close()
	f.svc.push = &pushClient{client: provider.Client(), baseURL: provider.URL}
	jwt := f.jwtFor(t, editor)
	path := "/v1/tabs/" + created.Tab.ID
	registration := f.do(t, "POST", path+"/notifications", "Bearer "+jwt, map[string]any{"install_id": uuid.NewString(), "token": "ExpoPushToken[removed_editor_test]", "locale": "en"}, "a")
	if registration.status != 200 {
		t.Fatalf("register: %d %s", registration.status, registration.body)
	}
	peer, err := f.svc.PartyByAccount(t.Context(), created.Tab.ID, f.acctB)
	if err != nil {
		t.Fatal(err)
	}
	first, err := f.svc.Append(t.Context(), peer, AppendInput{ID: uuid.NewString(), Direction: "b_to_a", Amount: "5", OccurredAtMS: 100})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(t.Context(), `UPDATE vault_members SET revoked_at=NOW() WHERE vault_id=$1::uuid AND account_id=$2::uuid`, f.vaultA, editor); err != nil {
		t.Fatal(err)
	}
	for _, operation := range []struct {
		method, endpoint string
		body             any
	}{
		{"GET", path, nil},
		{"POST", path + "/label", map[string]any{"label": "Unauthorized"}},
		{"POST", path + "/entries/" + first.Entry.ID + "/accept", nil},
		{"POST", path + "/bind", map[string]any{"token": created.MyToken, "vault_id": f.vaultA, "relationship_id": relA}},
		{"POST", path + "/join", map[string]any{"token": created.MyToken, "label": "Unauthorized", "vault_id": f.vaultA, "relationship_id": relA}},
		{"POST", "/v1/tabs/by-token", map[string]any{"token": created.MyToken}},
	} {
		result := f.do(t, operation.method, operation.endpoint, "Bearer "+jwt, operation.body, "a")
		if result.status != 404 {
			t.Fatalf("removed editor retained %s %s: %d %s", operation.method, operation.endpoint, result.status, result.body)
		}
	}
	if _, err := f.svc.Append(t.Context(), stale, AppendInput{ID: uuid.NewString(), Direction: "a_to_b", Amount: "1", OccurredAtMS: 101}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("stale actor remained authorized: %v", err)
	}
	if _, err := f.svc.RegenerateLink(t.Context(), oldTokenParty); !errors.Is(err, ErrNotFound) {
		t.Fatalf("old bound token restored authority: %v", err)
	}
	if mine, err := f.svc.Mine(t.Context(), editor, f.vaultA); err != nil || len(mine.Tabs) != 0 {
		t.Fatalf("removed editor discovery: %+v %v", mine, err)
	}
	if inbox, err := f.svc.listInbox(t.Context(), editor, "en", 0, nil); err != nil || inbox.Unread != 0 || len(inbox.Items) != 0 {
		t.Fatalf("removed editor inbox: %+v %v", inbox, err)
	}
	if recipients, err := f.svc.recipients(t.Context(), created.Tab.ID); err != nil {
		t.Fatal(err)
	} else {
		for _, account := range recipients {
			if account == editor {
				t.Fatal("removed editor still received live pokes")
			}
		}
	}
	if more, err := f.svc.deliverPush(t.Context()); err != nil || !more || sends != 0 {
		t.Fatalf("queued alert survived removal: more=%v sends=%d err=%v", more, sends, err)
	}
	if _, err := f.svc.Append(t.Context(), peer, AppendInput{ID: uuid.NewString(), Direction: "b_to_a", Amount: "1", OccurredAtMS: 102}); err != nil {
		t.Fatalf("peer's independent account stopped working: %v", err)
	}
	var queued int
	if err := f.pool.QueryRow(t.Context(), `SELECT COUNT(*) FROM tab_push_outbox`).Scan(&queued); err != nil || queued != 0 {
		t.Fatalf("new alert queued for removed editor: %d, %v", queued, err)
	}
	// The owner can still operate the Kaata even though its original linker left.
	owner, err := f.svc.partyByAccountRole(t.Context(), created.Tab.ID, f.acctA, "a")
	if err != nil || !owner.allows(rankEditor) {
		t.Fatalf("owner lost authority with editor: %+v %v", owner, err)
	}
	// Real readmission retains the revoked seat and creates a fresh active
	// seat. The new role controls access; old revocation must not mask it.
	seedMember(t, f.pool, f.vaultA, editor, "viewer")
	restored, err := f.svc.partyByAccountRole(t.Context(), created.Tab.ID, editor, "a")
	if err != nil || restored.BoundMemberRole != "viewer" {
		t.Fatalf("readmitted viewer could not recover: %+v %v", restored, err)
	}
	if mine, err := f.svc.Mine(t.Context(), editor, f.vaultA); err != nil || len(mine.Tabs) != 1 || mine.Tabs[0].Tab.Access == nil || mine.Tabs[0].Tab.Access.Append {
		t.Fatalf("readmitted viewer discovery: %+v %v", mine, err)
	}
	if got := f.do(t, "GET", path, "Bearer "+jwt, nil, "a"); got.status != 200 {
		t.Fatalf("readmitted viewer GET: %d %s", got.status, got.body)
	}
	if _, err := f.svc.Append(t.Context(), restored, AppendInput{ID: uuid.NewString(), Direction: "a_to_b", Amount: "1", OccurredAtMS: 103}); !errors.Is(err, ErrRoleInsufficient) {
		t.Fatalf("readmission retained the revoked editor role: %v", err)
	}
	if _, err := f.svc.Create(t.Context(), CreateInput{Currency: "AFN", Label: "Unauthorized", AccountID: &editor, VaultID: &f.vaultA}); !errors.Is(err, ErrRoleInsufficient) {
		t.Fatalf("new-link creation used the revoked editor seat: %v", err)
	}
	if inbox, err := f.svc.listInbox(t.Context(), editor, "en", 0, nil); err != nil || inbox.Unread == 0 || len(inbox.Items) == 0 {
		t.Fatalf("readmitted viewer inbox remained hidden: %+v %v", inbox, err)
	} else {
		for _, item := range inbox.Items {
			if strings.Contains(item.Body, "Accept or reject") {
				t.Fatalf("readmitted viewer asked to review: %+v", item)
			}
		}
	}
	if recipients, err := f.svc.recipients(t.Context(), created.Tab.ID); err != nil {
		t.Fatal(err)
	} else {
		found := false
		for _, account := range recipients {
			found = found || account == editor
		}
		if !found {
			t.Fatal("readmitted viewer did not regain live pokes")
		}
	}
	if _, err := f.svc.Append(t.Context(), peer, AppendInput{ID: uuid.NewString(), Direction: "b_to_a", Amount: "1", OccurredAtMS: 104}); err != nil {
		t.Fatal(err)
	}
	if err := f.pool.QueryRow(t.Context(), `SELECT COUNT(*) FROM tab_push_outbox`).Scan(&queued); err != nil || queued != 1 {
		t.Fatalf("readmitted viewer alert not queued: %d, %v", queued, err)
	}
	if more, err := f.svc.deliverPush(t.Context()); err != nil || !more || sends != 1 {
		t.Fatalf("readmitted viewer alert not delivered: more=%v sends=%d err=%v", more, sends, err)
	}
	if sentPayload["categoryId"] != nil || strings.Contains(sentPayload["body"].(string), "Accept or reject") {
		t.Fatalf("readmitted viewer received review controls: %+v", sentPayload)
	}
}
