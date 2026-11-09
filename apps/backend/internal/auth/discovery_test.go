package auth

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/matee/kaata-backend/internal/testutil"
)

func TestDiscoveryQuery(t *testing.T) {
	for _, tc := range []struct{ raw, query, prefix, phone string }{
		{" John Smith ", "john smith", "john:* & smith:*", ""},
		{"@John_Smith", "john_smith", "john:* & smith:*", ""},
		{"علي كريم", "علی کریم", "علی:* & کریم:*", ""},
		{"۰۷۰۰ ۰۰۰ ۰۰۱", "0700 000 001", "", "+93700000001"},
		{"+1 (212) 555-0123", "+1 (212) 555-0123", "", "+12125550123"},
		{"12", "12", "", "invalid"},
		{"%%", "%%", "", ""},
	} {
		q, p, ph, err := discoveryQuery(tc.raw)
		if err != nil || q != tc.query || p != tc.prefix || ph != tc.phone {
			t.Errorf("%q => %q/%q/%q %v", tc.raw, q, p, ph, err)
		}
	}
	for _, raw := range []string{"", " ", "a", "@a", strings.Repeat("a", 81)} {
		if _, _, _, err := discoveryQuery(raw); err == nil {
			t.Errorf("accepted %q", raw)
		}
	}
}

func TestPeopleDiscoveryPrivacyAndMatching(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	svc := NewService(pool, "", emailTestSecret)
	self := seedGoogleAccount(t, pool, "self@example.test", uuid.NewString())
	seed := func(name, handle, phone string, enabled bool) string {
		t.Helper()
		id := seedGoogleAccount(t, pool, uuid.NewString()+"@example.test", uuid.NewString())
		_, err := pool.Exec(t.Context(), `UPDATE accounts SET display_name=$2,username=NULLIF($3,''),phone_e164=$4,discovery_enabled=$5,picture_url='https://example.test/photo' WHERE id=$1::uuid`, id, name, handle, phone, enabled)
		if err != nil {
			t.Fatal(err)
		}
		return id
	}
	john := seed("John Smith", "john_smith", "+93700000001", true)
	seed("John Private", "john_private", "+93700000002", false)
	disabled := seed("John Disabled", "john_disabled", "+93700000003", true)
	pending := seed("John Pending", "john_pending", "+93700000004", true)
	if _, err := pool.Exec(t.Context(), `UPDATE accounts SET disabled_at=NOW() WHERE id=$1::uuid`, disabled); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(t.Context(), `UPDATE accounts SET pending_delete_at=NOW() WHERE id=$1::uuid`, pending); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(t.Context(), `UPDATE accounts SET display_name='John Myself',discovery_enabled=TRUE WHERE id=$1::uuid`, self); err != nil {
		t.Fatal(err)
	}
	for _, query := range []string{"john", "smith", "smi joh", "@john_s", "۰۷۰۰ ۰۰۰ ۰۰۱"} {
		page, err := svc.SearchPeople(t.Context(), self, query)
		if err != nil || len(page.People) != 1 || page.People[0].AccountID != john {
			t.Fatalf("%q %+v %v", query, page, err)
		}
		raw, _ := json.Marshal(page)
		for _, secret := range []string{"phone", "email", "+937", "@example.test", "john_private"} {
			if strings.Contains(string(raw), secret) {
				t.Fatalf("disclosed %s in %s", secret, raw)
			}
		}
	}
	for _, query := range []string{"+937000", "0700000002", "john%", "john_", "%%"} {
		page, err := svc.SearchPeople(t.Context(), self, query)
		// Names still match literal punctuation-separated words, but a partial
		// phone never discovers another number.
		if err != nil {
			t.Fatal(err)
		}
		if strings.HasPrefix(query, "+") || strings.HasPrefix(query, "0") || query == "%%" {
			if len(page.People) != 0 {
				t.Fatalf("%q matched %+v", query, page)
			}
		}
	}
	seed("علی کریمی", "ali_karimi", "", true)
	page, err := svc.SearchPeople(t.Context(), self, "علي كري")
	if err != nil || len(page.People) != 1 {
		t.Fatalf("Persian/Arabic normalization: %+v %v", page, err)
	}
	if err := svc.SetDiscovery(t.Context(), john, false); err != nil {
		t.Fatal(err)
	}
	page, err = svc.SearchPeople(t.Context(), self, "john")
	if err != nil || len(page.People) != 0 {
		t.Fatalf("opt-out: %+v %v", page, err)
	}
	for i := 0; i < 23; i++ {
		seed(fmt.Sprintf("Alex Person %02d", i), fmt.Sprintf("alex%d", i), "", true)
	}
	page, err = svc.SearchPeople(t.Context(), self, "alex")
	if err != nil || len(page.People) != 20 || !page.HasMore {
		t.Fatalf("bounded search: %+v %v", page, err)
	}
}

func TestDiscoveryIsEnabledByDefaultAndRequiresSession(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	svc, claims := seedWebProfileSession(t, pool)
	me, err := svc.AccountMe(t.Context(), claims.AccountID)
	if err != nil || !me.DiscoveryEnabled {
		t.Fatalf("default discovery missing: %+v %v", me, err)
	}
	if err := svc.SetDiscovery(t.Context(), claims.AccountID, false); err != nil {
		t.Fatal(err)
	}
	me, err = svc.AccountMe(t.Context(), claims.AccountID)
	if err != nil || me.DiscoveryEnabled {
		t.Fatalf("opt-out missing: %+v %v", me, err)
	}
	h := NewHandler(svc)
	for _, fn := range []func(*httptest.ResponseRecorder){
		func(w *httptest.ResponseRecorder) {
			h.SearchPeople(w, httptest.NewRequest("GET", "/v1/people/search?q=john", nil))
		},
		func(w *httptest.ResponseRecorder) {
			h.SetDiscovery(w, httptest.NewRequest("PUT", "/v1/account/discovery", strings.NewReader(`{"enabled":true}`)))
		},
	} {
		w := httptest.NewRecorder()
		fn(w)
		if w.Code != 401 {
			t.Fatalf("unauthenticated status %d", w.Code)
		}
	}
}

func TestPeopleSearchExistingRelationshipIsVaultScoped(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	svc, self := seedWebProfileSession(t, pool)
	_, other := seedWebProfileSession(t, pool)
	vault := seedVaultOwnedBy(t, pool, self.AccountID)
	if _, err := pool.Exec(t.Context(), `UPDATE accounts SET display_name='John Contact',discovery_enabled=TRUE WHERE id=$1::uuid`, other.AccountID); err != nil {
		t.Fatal(err)
	}
	group, relationship, request := uuid.NewString(), uuid.NewString(), uuid.NewString()
	if _, err := pool.Exec(t.Context(), `INSERT INTO tab_groups(id,recording_mode,invite_token_hash,request_hash,a_account_id,a_vault_id,a_relationship_id)
 VALUES($1::uuid,'notify','test-invite-hash','test-request-hash',$2::uuid,$3::uuid,$4::uuid)`, group, self.AccountID, vault, relationship); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(t.Context(), `INSERT INTO people_requests(id,group_id,sender_account_id,recipient_account_id)VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid)`, request, group, self.AccountID, other.AccountID); err != nil {
		t.Fatal(err)
	}
	page, err := svc.SearchPeople(t.Context(), self.AccountID, "john")
	if err != nil || len(page.People) != 1 || page.People[0].ExistingRelationshipID != "" {
		t.Fatalf("unscoped relation %+v %v", page, err)
	}
	page, err = svc.SearchPeople(t.Context(), self.AccountID, "john", vault)
	if err != nil || len(page.People) != 1 || page.People[0].ExistingRelationshipID != relationship {
		t.Fatalf("scoped relation %+v %v", page, err)
	}
	if _, err := svc.SearchPeople(t.Context(), other.AccountID, "john", vault); !errors.Is(err, errPeopleVault) {
		t.Fatalf("outsider relation %v", err)
	}
}

func TestPeoplePreviewOnlyReturnsDiscoverableIdentity(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	svc := NewService(pool, "", emailTestSecret)
	handler := NewHandler(svc)
	seed := func(name, handle, phone, state string) string {
		t.Helper()
		id := seedGoogleAccount(t, pool, uuid.NewString()+"@example.test", uuid.NewString())
		if _, err := pool.Exec(t.Context(), `UPDATE accounts SET display_name=$2,username=NULLIF($3,''),phone_e164=$4,
 discovery_enabled=($5<>'private'),picture_url='https://example.test/photo',
 disabled_at=CASE WHEN $5='disabled' THEN NOW() END,
 pending_delete_at=CASE WHEN $5='deleting' THEN NOW() END WHERE id=$1::uuid`, id, name, handle, phone, state); err != nil {
			t.Fatal(err)
		}
		return id
	}
	john := seed("John Smith", "john_smith", "+93700000001", "public")
	seed("John Private", "john_private", "+93700000002", "private")
	seed("John Disabled", "john_disabled", "+93700000003", "disabled")
	seed("John Deleting", "john_deleting", "+93700000004", "deleting")
	li := seed("Li", "li_identity", "", "public")
	seed("Liam", "liam_identity", "", "public")
	ali := seed("علی کریمی", "ali_karimi", "", "public")

	search := func(q string) PeopleSearchPage {
		t.Helper()
		path := "/v1/people/search/preview?q=" + url.QueryEscape(q) + "&vault_id=" + uuid.NewString() + "&include_friends=1"
		w := httptest.NewRecorder()
		handler.SearchPeoplePreview(w, httptest.NewRequest("GET", path, nil))
		if w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("%q => %d %s", q, w.Code, w.Body)
		}
		var raw struct {
			People []map[string]json.RawMessage `json:"people"`
		}
		var result PeopleSearchPage
		if err := json.Unmarshal(w.Body.Bytes(), &raw); err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		if raw.People == nil {
			t.Fatal("expected a people array")
		}
		for _, person := range raw.People {
			if len(person) != 4 || person["account_id"] == nil || person["name"] == nil ||
				person["username"] == nil || person["picture_url"] == nil {
				t.Fatalf("unexpected preview fields: %s", w.Body)
			}
		}
		return result
	}
	for query, want := range map[string]string{
		"john": john, "smi": john, "@john_s": john, "li": li, "علي كري": ali,
	} {
		page := search(query)
		if len(page.People) != 1 || page.People[0].AccountID != want || page.People[0].PictureURL == "" {
			t.Fatalf("%q => %+v", query, page)
		}
	}
	for _, query := range []string{"jo", "@jo", "j!!!", "j j j", "+93700000001", "۰۷۰۰ ۰۰۰ ۰۰۱"} {
		if page := search(query); len(page.People) != 0 || page.HasMore {
			t.Fatalf("%q exposed an unintended match: %+v", query, page)
		}
	}
	if err := svc.SetDiscovery(t.Context(), john, false); err != nil {
		t.Fatal(err)
	}
	if page := search("john"); len(page.People) != 0 {
		t.Fatalf("preview ignored opt-out: %+v", page)
	}
	for i := 0; i < peoplePreviewLimit+3; i++ {
		seed(fmt.Sprintf("Alex Person %02d", i), fmt.Sprintf("alex%d", i), "", "public")
	}
	if page := search("alex"); len(page.People) != peoplePreviewLimit || !page.HasMore {
		t.Fatalf("unbounded preview: %+v", page)
	}

	w := httptest.NewRecorder()
	handler.PeopleProfile(w, httptest.NewRequest("GET", "/v1/people/profiles/"+li, nil))
	if w.Code != 401 {
		t.Fatalf("profile opened without a session: %d %s", w.Code, w.Body)
	}
}

func TestPeoplePreviewRejectsUnboundedQueries(t *testing.T) {
	handler := NewHandler(NewService(nil, "", emailTestSecret))
	for _, query := range []string{"", "a", "@ا", strings.Repeat("ک", 81)} {
		w := httptest.NewRecorder()
		handler.SearchPeoplePreview(w, httptest.NewRequest("GET", "/v1/people/search/preview?q="+url.QueryEscape(query), nil))
		if w.Code != 400 || !strings.Contains(w.Body.String(), "invalid_search") {
			t.Fatalf("%q => %d %s", query, w.Code, w.Body)
		}
	}
}
