package auth

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/matee/kaata-backend/internal/testutil"
)

type friendFixture struct {
	pool    *pgxpool.Pool
	svc     *Service
	a, b, c string
}

func newFriendFixture(t *testing.T) *friendFixture {
	t.Helper()
	f := &friendFixture{pool: testutil.ConnectTestDB(t)}
	f.svc = NewService(f.pool, "", emailTestSecret)
	f.a, f.b, f.c = f.seed(t), f.seed(t), f.seed(t)
	return f
}
func (f *friendFixture) seed(t *testing.T) string {
	t.Helper()
	id := seedGoogleAccount(t, f.pool, uuid.NewString()+"@friend.test", uuid.NewString())
	f.exec(t, `UPDATE accounts SET display_name='Friend Person',username=$2,phone_e164='+93700000001',picture_url='https://example.test/avatar' WHERE id=$1::uuid`, id, "f"+strings.ReplaceAll(id, "-", "")[:20])
	return id
}
func (f *friendFixture) exec(t *testing.T, q string, args ...any) {
	t.Helper()
	if _, err := f.pool.Exec(t.Context(), q, args...); err != nil {
		t.Fatal(err)
	}
}
func (f *friendFixture) count(t *testing.T, q string, args ...any) int {
	t.Helper()
	var n int
	if err := f.pool.QueryRow(t.Context(), q, args...).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}
func (f *friendFixture) send(t *testing.T, a, b string) FriendshipState {
	t.Helper()
	s, err := f.svc.SendFriendRequest(t.Context(), a, b)
	if err != nil {
		t.Fatal(err)
	}
	return s
}
func (f *friendFixture) accepted(t *testing.T, a, b string) FriendshipState {
	t.Helper()
	s := f.send(t, a, b)
	s, err := f.svc.AcceptFriendRequest(t.Context(), b, s.ID)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestFriendshipExplicitMutualLifecycle(t *testing.T) {
	f := newFriendFixture(t)
	f.exec(t, `UPDATE accounts SET username='friend_search_target' WHERE id=$1::uuid`, f.b)
	assertSearchFriend := func(viewer string, want bool) {
		t.Helper()
		page, err := f.svc.SearchPeopleWithFriends(t.Context(), viewer, "@friend_search_target", "", true)
		if err != nil || len(page.People) != 1 || page.People[0].AccountID != f.b || page.People[0].IsFriend != want {
			t.Fatalf("search friend = %t: %+v %v", want, page, err)
		}
	}
	r := f.send(t, f.a, f.b)
	if r.State != "outgoing" || r.ID == "" {
		t.Fatalf("send %+v", r)
	}
	if again := f.send(t, f.a, f.b); again != r {
		t.Fatalf("duplicate changed %+v", again)
	}
	if crossed := f.send(t, f.b, f.a); crossed.State != "incoming" || crossed.ID != r.ID {
		t.Fatalf("cross-send accepted or duplicated: %+v", crossed)
	}
	if list, err := f.svc.Friends(t.Context(), f.a, ""); err != nil || len(list.Friends) != 0 {
		t.Fatalf("pending granted friendship: %+v %v", list, err)
	}
	assertSearchFriend(f.a, false)
	if list, err := f.svc.FriendRequests(t.Context(), f.b); err != nil || len(list) != 1 || list[0].ID != r.ID || list[0].From.AccountID != f.a {
		t.Fatalf("inbox: %+v %v", list, err)
	}
	for _, actor := range []string{f.a, f.c} {
		if _, err := f.svc.AcceptFriendRequest(t.Context(), actor, r.ID); !errors.Is(err, ErrFriendRequestNotFound) {
			t.Fatalf("non-recipient accepted: %v", err)
		}
	}
	if err := f.svc.DeleteFriendRequest(t.Context(), f.c, r.ID); !errors.Is(err, ErrFriendRequestNotFound) {
		t.Fatalf("foreign decline: %v", err)
	}
	accepted, err := f.svc.AcceptFriendRequest(t.Context(), f.b, r.ID)
	if err != nil || accepted.State != "friends" || accepted.ID != r.ID {
		t.Fatalf("accept: %+v %v", accepted, err)
	}
	if retry, err := f.svc.AcceptFriendRequest(t.Context(), f.b, r.ID); err != nil || retry != accepted {
		t.Fatalf("accept retry: %+v %v", retry, err)
	}
	assertSearchFriend(f.a, true)
	assertSearchFriend(f.c, false)
	for _, actor := range []string{f.a, f.b} {
		list, err := f.svc.Friends(t.Context(), actor, "")
		if err != nil || len(list.Friends) != 1 {
			t.Fatalf("mutual list: %+v %v", list, err)
		}
	}
	if list, err := f.svc.FriendRequests(t.Context(), f.b); err != nil || len(list) != 0 {
		t.Fatalf("accepted remains pending: %+v %v", list, err)
	}
	if err := f.svc.DeleteFriendRequest(t.Context(), f.b, r.ID); !errors.Is(err, ErrFriendRequestNotFound) {
		t.Fatalf("decline removed accepted friendship: %v", err)
	}
	if err := f.svc.RemoveFriend(t.Context(), f.c, r.ID); !errors.Is(err, ErrFriendRequestNotFound) {
		t.Fatalf("foreign removal: %v", err)
	}
	if err := f.svc.RemoveFriend(t.Context(), f.a, r.ID); err != nil {
		t.Fatal(err)
	}
	assertSearchFriend(f.a, false)
	if err := f.svc.RemoveFriend(t.Context(), f.a, r.ID); err != nil {
		t.Fatalf("remove retry: %v", err)
	}
	if _, err := f.svc.AcceptFriendRequest(t.Context(), f.b, r.ID); !errors.Is(err, ErrFriendRequestNotFound) {
		t.Fatalf("stale accept restored removed friendship: %v", err)
	}
	if next := f.send(t, f.a, f.b); next.State != "outgoing" || next.ID == r.ID {
		t.Fatalf("unfriend must allow a fresh request: %+v", next)
	}
	for _, table := range []string{"vaults", "vault_members", "tab_groups", "people_requests", "events"} {
		if f.count(t, `SELECT COUNT(*) FROM `+table) != 0 {
			t.Fatalf("friendship changed financial table %s", table)
		}
	}
}

func TestFriendshipProfileAndSearchPrivacy(t *testing.T) {
	f := newFriendFixture(t)
	f.exec(t, `UPDATE accounts SET display_name='Hidden Friend',username='hidden_friend' WHERE id=$1::uuid`, f.b)
	if p, err := f.svc.PeopleProfile(t.Context(), f.a, f.b); err != nil || p.Friendship.State != "none" || p.Person.Username != "hidden_friend" || !p.CanReceiveRequests {
		t.Fatalf("public profile: %+v %v", p, err)
	}
	if self, err := f.svc.PeopleProfile(t.Context(), f.a, f.a); err != nil || self.CanReceiveRequests {
		t.Fatalf("self profile request eligibility: %+v %v", self, err)
	}
	r := f.send(t, f.a, f.b)
	f.exec(t, `UPDATE accounts SET discovery_enabled=FALSE WHERE id=ANY($1::uuid[])`, []string{f.a, f.b})
	for _, pair := range [][2]string{{f.a, f.b}, {f.b, f.a}} {
		p, err := f.svc.PeopleProfile(t.Context(), pair[0], pair[1])
		if err != nil || p.Person.Name == "" || p.Person.Username != "" || p.CanReceiveRequests {
			t.Fatalf("private pending identity: %+v %v", p, err)
		}
	}
	if _, err := f.svc.PeopleProfile(t.Context(), f.c, f.b); !errors.Is(err, ErrPersonUnavailable) {
		t.Fatalf("stranger private profile: %v", err)
	}
	if requests, err := f.svc.FriendRequests(t.Context(), f.b); err != nil || len(requests) != 1 || requests[0].From.Username != "" {
		t.Fatalf("private request username: %+v %v", requests, err)
	}
	if _, err := f.svc.AcceptFriendRequest(t.Context(), f.b, r.ID); err != nil {
		t.Fatalf("opt-out stranded pending accept: %v", err)
	}
	p, err := f.svc.PeopleProfile(t.Context(), f.a, f.b)
	if err != nil || p.Friendship.State != "friends" || p.Person.Username != "hidden_friend" || !p.CanReceiveRequests {
		t.Fatalf("private friend profile: %+v %v", p, err)
	}
	raw, _ := json.Marshal(p)
	for _, secret := range []string{"email", "phone", "+937", "friend.test", "password", "google_sub", "providers"} {
		if strings.Contains(string(raw), secret) {
			t.Fatalf("profile leaked %s: %s", secret, raw)
		}
	}
	for _, q := range []string{"Hidden", "hidden_friend"} {
		if page, err := f.svc.SearchPeople(t.Context(), f.a, q); err != nil || len(page.People) != 0 {
			t.Fatalf("legacy search broadened: %+v %v", page, err)
		}
		if page, err := f.svc.SearchPeopleWithFriends(t.Context(), f.a, q, "", true); err != nil || len(page.People) != 1 || page.People[0].AccountID != f.b || !page.People[0].IsFriend {
			t.Fatalf("friend search: %+v %v", page, err)
		}
		if page, err := f.svc.SearchPeopleWithFriends(t.Context(), f.c, q, "", true); err != nil || len(page.People) != 0 {
			t.Fatalf("stranger search: %+v %v", page, err)
		}
	}
	if page, err := f.svc.SearchPeopleWithFriends(t.Context(), f.a, "+93700000001", "", true); err != nil || len(page.People) != 1 || page.People[0].AccountID != f.c {
		t.Fatalf("private friend phone became searchable: %+v %v", page, err)
	}
	if err := f.svc.RemoveFriend(t.Context(), f.a, r.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.PeopleProfile(t.Context(), f.a, f.b); !errors.Is(err, ErrPersonUnavailable) {
		t.Fatalf("removed friend kept private access: %v", err)
	}
}

func TestFriendshipRotatingInstancesAndCooldown(t *testing.T) {
	f := newFriendFixture(t)
	old := f.send(t, f.a, f.b)
	if err := f.svc.DeleteFriendRequest(t.Context(), f.b, old.ID); err != nil {
		t.Fatal(err)
	}
	if err := f.svc.DeleteFriendRequest(t.Context(), f.b, old.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.SendFriendRequest(t.Context(), f.a, f.b); !errors.Is(err, ErrFriendRequestLimited) {
		t.Fatalf("decline cooldown: %v", err)
	}
	f.exec(t, `UPDATE account_friendships SET updated_at=NOW()-INTERVAL '6 minutes' WHERE id=$1::uuid`, old.ID)
	next := f.send(t, f.a, f.b)
	if next.ID == old.ID {
		t.Fatal("new request reused old instance")
	}
	if _, err := f.svc.AcceptFriendRequest(t.Context(), f.b, old.ID); !errors.Is(err, ErrFriendRequestNotFound) {
		t.Fatalf("stale accept: %v", err)
	}
	if err := f.svc.DeleteFriendRequest(t.Context(), f.b, old.ID); !errors.Is(err, ErrFriendRequestNotFound) {
		t.Fatalf("stale cancel: %v", err)
	}
	if err := f.svc.RemoveFriend(t.Context(), f.a, old.ID); !errors.Is(err, ErrFriendRequestNotFound) {
		t.Fatalf("stale remove: %v", err)
	}
	if f.count(t, `SELECT COUNT(*) FROM account_friendships WHERE id=$1::uuid AND status='pending'`, next.ID) != 1 {
		t.Fatal("stale request changed replacement")
	}
	f.exec(t, `UPDATE account_friendships SET expires_at=NOW()-INTERVAL '1 second' WHERE id=$1::uuid`, next.ID)
	if _, err := f.svc.AcceptFriendRequest(t.Context(), f.b, next.ID); !errors.Is(err, ErrFriendRequestNotFound) {
		t.Fatalf("expired accept: %v", err)
	}
	renewed := f.send(t, f.a, f.b)
	if renewed.ID == next.ID {
		t.Fatal("expired request id reused")
	}
	if err := f.svc.DeleteFriendRequest(t.Context(), f.a, renewed.ID); err != nil {
		t.Fatal(err)
	}
	resent := f.send(t, f.a, f.b)
	if resent.State != "outgoing" || resent.ID == renewed.ID {
		t.Fatalf("cancel must allow a fresh request: %+v", resent)
	}
	if err := f.svc.DeleteFriendRequest(t.Context(), f.b, resent.ID); err != nil {
		t.Fatal(err)
	}
	if reversed := f.send(t, f.b, f.a); reversed.State != "outgoing" || reversed.ID == resent.ID {
		t.Fatalf("the person who declined may initiate a fresh request: %+v", reversed)
	}
}

func TestFriendshipActiveAccountAndDeletionLifecycle(t *testing.T) {
	f := newFriendFixture(t)
	for _, target := range []string{"", uuid.Nil.String(), "bad", f.a} {
		if _, err := f.svc.SendFriendRequest(t.Context(), f.a, target); !errors.Is(err, ErrInvalidFriendAccount) {
			t.Fatalf("invalid target %q: %v", target, err)
		}
	}
	for _, change := range []string{"discovery_enabled=FALSE", "disabled_at=NOW()", "pending_delete_at=NOW()"} {
		f.exec(t, `UPDATE accounts SET `+change+` WHERE id=$1::uuid`, f.b)
		if _, err := f.svc.SendFriendRequest(t.Context(), f.a, f.b); !errors.Is(err, ErrPersonUnavailable) {
			t.Fatalf("unavailable target %s: %v", change, err)
		}
		f.exec(t, `UPDATE accounts SET discovery_enabled=TRUE,disabled_at=NULL,pending_delete_at=NULL WHERE id=$1::uuid`, f.b)
	}
	r := f.send(t, f.a, f.b)
	f.exec(t, `UPDATE accounts SET disabled_at=NOW() WHERE id=$1::uuid`, f.a)
	if _, err := f.svc.AcceptFriendRequest(t.Context(), f.b, r.ID); !errors.Is(err, ErrFriendRequestNotFound) {
		t.Fatalf("disabled sender accepted: %v", err)
	}
	if _, err := f.svc.PeopleProfile(t.Context(), f.a, f.b); !errors.Is(err, ErrSessionRevoked) {
		t.Fatalf("disabled viewer profile: %v", err)
	}
	f.exec(t, `UPDATE accounts SET disabled_at=NULL WHERE id=$1::uuid`, f.a)
	if _, err := f.svc.AcceptFriendRequest(t.Context(), f.b, r.ID); err != nil {
		t.Fatal(err)
	}
	f.exec(t, `UPDATE accounts SET pending_delete_at=NOW() WHERE id=$1::uuid`, f.b)
	if list, err := f.svc.Friends(t.Context(), f.a, ""); err != nil || len(list.Friends) != 0 {
		t.Fatalf("pending-delete friend visible: %+v %v", list, err)
	}
	if _, err := f.svc.PeopleProfile(t.Context(), f.a, f.b); !errors.Is(err, ErrPersonUnavailable) {
		t.Fatalf("pending-delete profile: %v", err)
	}
	if f.count(t, `SELECT COUNT(*) FROM account_friendships WHERE id=$1::uuid`, r.ID) != 1 {
		t.Fatal("deletion grace erased friendship")
	}
	f.exec(t, `UPDATE accounts SET pending_delete_at=NULL WHERE id=$1::uuid`, f.b)
	if p, err := f.svc.PeopleProfile(t.Context(), f.a, f.b); err != nil || p.Friendship.ID != r.ID {
		t.Fatalf("recovery lost friendship: %+v %v", p, err)
	}
	f.exec(t, `DELETE FROM accounts WHERE id=$1::uuid`, f.b)
	if f.count(t, `SELECT COUNT(*) FROM account_friendships`) != 0 {
		t.Fatal("hard delete left dangling friendship")
	}
}

func TestFriendshipConcurrentCrossSendAndAcceptDecline(t *testing.T) {
	f := newFriendFixture(t)
	const n = 8
	var wg sync.WaitGroup
	results := make(chan FriendshipState, n)
	errs := make(chan error, n)
	for i := 0; i < n; i++ {
		a, b := f.a, f.b
		if i%2 != 0 {
			a, b = b, a
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			r, err := f.svc.SendFriendRequest(t.Context(), a, b)
			results <- r
			errs <- err
		}()
	}
	wg.Wait()
	close(results)
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	id := ""
	for r := range results {
		if id != "" && id != r.ID {
			t.Fatal("cross-send duplicated pair")
		}
		if r.State != "incoming" && r.State != "outgoing" {
			t.Fatal("cross-send auto-accepted")
		}
		id = r.ID
	}
	var sender string
	if err := f.pool.QueryRow(t.Context(), `SELECT requested_by::text FROM account_friendships WHERE id=$1::uuid`, id).Scan(&sender); err != nil {
		t.Fatal(err)
	}
	recipient := f.a
	if sender == f.a {
		recipient = f.b
	}
	aDone, dDone := make(chan error, 1), make(chan error, 1)
	go func() { _, err := f.svc.AcceptFriendRequest(t.Context(), recipient, id); aDone <- err }()
	go func() { dDone <- f.svc.DeleteFriendRequest(t.Context(), recipient, id) }()
	aErr, dErr := <-aDone, <-dDone
	if !((aErr == nil && errors.Is(dErr, ErrFriendRequestNotFound)) || (dErr == nil && errors.Is(aErr, ErrFriendRequestNotFound))) {
		t.Fatalf("accept/decline race: %v / %v", aErr, dErr)
	}
	if f.count(t, `SELECT COUNT(*) FROM account_friendships WHERE status IN ('accepted','declined')`) != 1 {
		t.Fatal("inconsistent final pair")
	}
}

func TestFriendshipPendingCapsAndPagination(t *testing.T) {
	f := newFriendFixture(t)
	for i := 0; i < maxPendingFriendRequests; i++ {
		f.send(t, f.a, f.seed(t))
	}
	if _, err := f.svc.SendFriendRequest(t.Context(), f.a, f.b); !errors.Is(err, ErrFriendRequestCapacity) {
		t.Fatalf("outgoing cap: %v", err)
	}
	f.exec(t, `DELETE FROM account_friendships`)
	for i := 0; i < maxPendingFriendRequests; i++ {
		f.send(t, f.seed(t), f.b)
	}
	if _, err := f.svc.SendFriendRequest(t.Context(), f.a, f.b); !errors.Is(err, ErrFriendRequestCapacity) {
		t.Fatalf("incoming cap: %v", err)
	}
	if requests, err := f.svc.FriendRequests(t.Context(), f.b); err != nil || len(requests) != maxPendingFriendRequests {
		t.Fatalf("bounded inbox: %d %v", len(requests), err)
	}
	f.exec(t, `DELETE FROM account_friendships`)
	for i := 0; i < friendPageSize+3; i++ {
		peer := f.seed(t)
		f.accepted(t, f.a, peer)
		f.exec(t, `UPDATE accounts SET discovery_enabled=FALSE WHERE id=$1::uuid`, peer)
	}
	first, err := f.svc.Friends(t.Context(), f.a, "")
	if err != nil || len(first.Friends) != friendPageSize || first.NextCursor == "" {
		t.Fatalf("first page: %+v %v", first, err)
	}
	second, err := f.svc.Friends(t.Context(), f.a, first.NextCursor)
	if err != nil || len(second.Friends) != 3 || second.NextCursor != "" {
		t.Fatalf("second page: %+v %v", second, err)
	}
	seen := map[string]bool{}
	for _, p := range append(first.Friends, second.Friends...) {
		if seen[p.AccountID] {
			t.Fatal("duplicate page item")
		}
		seen[p.AccountID] = true
	}
	if _, err := f.svc.Friends(t.Context(), f.a, "invalid"); !errors.Is(err, ErrInvalidFriendCursor) {
		t.Fatalf("invalid cursor: %v", err)
	}
}

func TestFriendshipDeletionLockPrecedesPairLock(t *testing.T) {
	f := newFriendFixture(t)
	r := f.send(t, f.a, f.b)
	if err := f.svc.DeleteFriendRequest(t.Context(), f.b, r.ID); err != nil {
		t.Fatal(err)
	}
	f.exec(t, `UPDATE account_friendships SET updated_at=NOW()-INTERVAL '6 minutes' WHERE id=$1::uuid`, r.ID)
	tx, err := f.pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(t.Context())
	if _, err := tx.Exec(t.Context(), `UPDATE accounts SET pending_delete_at=NOW() WHERE id=$1::uuid`, f.b); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { _, err := f.svc.SendFriendRequest(t.Context(), f.a, f.b); done <- err }()
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	for {
		var waiting bool
		if err := f.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FROM accounts WHERE id=ANY%' AND query LIKE '%FOR UPDATE%')`).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal("request did not wait for recipient")
		case <-time.After(10 * time.Millisecond):
		}
	}
	if _, err := tx.Exec(t.Context(), `SELECT 1 FROM account_friendships WHERE id=$1::uuid FOR UPDATE NOWAIT`, r.ID); err != nil {
		t.Fatalf("pair locked before accounts: %v", err)
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	if err := <-done; !errors.Is(err, ErrPersonUnavailable) {
		t.Fatalf("deleted recipient admitted: %v", err)
	}
}

func friendRouter(svc *Service) http.Handler {
	r := chi.NewRouter()
	r.Use(RequireSession(emailTestSecret))
	h := NewHandler(svc)
	r.Get("/v1/people/profiles/{account_id}", h.PeopleProfile)
	r.Get("/v1/friends", h.Friends)
	r.Get("/v1/friends/requests", h.FriendRequests)
	r.Post("/v1/friends/requests", h.SendFriendRequest)
	r.Post("/v1/friends/requests/{request_id}/accept", h.AcceptFriendRequest)
	r.Delete("/v1/friends/requests/{request_id}", h.DeleteFriendRequest)
	r.Delete("/v1/friends/{friendship_id}", h.RemoveFriend)
	r.Get("/v1/people/search", h.SearchPeople)
	return r
}
func friendRequest(t *testing.T, router http.Handler, method, url, actor, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, url, strings.NewReader(body))
	if actor != "" {
		token, err := SignSession(emailTestSecret, actor, uuid.NewString(), "google", "friend-test")
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	return w
}
func TestFriendshipHTTPValidation(t *testing.T) {
	router := friendRouter(NewService(nil, "", emailTestSecret))
	actor, target := uuid.NewString(), uuid.NewString()
	for _, body := range []string{"", `{}`, `null`, `{"account_id":null}`, `{"account_id":"bad"}`, `{"account_id":"` + target + `","role":"owner"}`, `{"account_id":"` + target + `"} {}`} {
		if w := friendRequest(t, router, "POST", "/v1/friends/requests", actor, body); w.Code != 400 {
			t.Fatalf("bad body %s: %d %s", body, w.Code, w.Body.String())
		}
	}
	for _, route := range [][2]string{{"GET", "/v1/friends"}, {"GET", "/v1/friends/requests"}, {"GET", "/v1/people/profiles/" + target}, {"POST", "/v1/friends/requests"}, {"POST", "/v1/friends/requests/" + target + "/accept"}, {"DELETE", "/v1/friends/requests/" + target}, {"DELETE", "/v1/friends/" + target}} {
		if w := friendRequest(t, router, route[0], route[1], "", ""); w.Code != 401 {
			t.Fatalf("anonymous route %+v: %d", route, w.Code)
		}
	}
	if w := friendRequest(t, router, "GET", "/v1/friends?after=bad", actor, ""); w.Code != 400 {
		t.Fatalf("cursor %d", w.Code)
	}
}
func TestFriendshipHTTPContractAndNonParticipantPrivacy(t *testing.T) {
	f := newFriendFixture(t)
	router := friendRouter(f.svc)
	w := friendRequest(t, router, "POST", "/v1/friends/requests", f.a, `{"account_id":"`+f.b+`"}`)
	var result FriendshipResult
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil || result.Friendship.State != "outgoing" {
		t.Fatalf("send %d %s", w.Code, w.Body.String())
	}
	id := result.Friendship.ID
	if w := friendRequest(t, router, "GET", "/v1/people/profiles/"+f.a, f.b, ""); w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" || !strings.Contains(w.Body.String(), `"state":"incoming"`) {
		t.Fatalf("profile %d %s", w.Code, w.Body.String())
	}
	for _, methodPath := range [][2]string{{"POST", "/v1/friends/requests/%s/accept"}, {"DELETE", "/v1/friends/requests/%s"}, {"DELETE", "/v1/friends/%s"}} {
		path := strings.Replace(methodPath[1], "%s", id, 1)
		unknown := strings.Replace(methodPath[1], "%s", uuid.NewString(), 1)
		foreign, missing := friendRequest(t, router, methodPath[0], path, f.c, ""), friendRequest(t, router, methodPath[0], unknown, f.c, "")
		if foreign.Code != 404 || missing.Code != 404 || foreign.Body.String() != missing.Body.String() {
			t.Fatalf("foreign request revealed existence: %d %s / %d %s", foreign.Code, foreign.Body.String(), missing.Code, missing.Body.String())
		}
	}
	if w := friendRequest(t, router, "POST", "/v1/friends/requests/"+id+"/accept", f.b, ""); w.Code != 200 || !strings.Contains(w.Body.String(), `"state":"friends"`) {
		t.Fatalf("accept %d %s", w.Code, w.Body.String())
	}
	if w := friendRequest(t, router, "DELETE", "/v1/friends/"+id, f.b, ""); w.Code != 204 {
		t.Fatalf("remove %d %s", w.Code, w.Body.String())
	}
}
