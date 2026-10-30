package sync

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/matee/kaata-backend/internal/auth"
	"github.com/matee/kaata-backend/internal/credit"
)

func creditAlertsRequest(t *testing.T, f *m1Fixture, method, relationshipID, body string, authenticated bool) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, "/v1/sync/credit-alerts?vault_id="+f.vaultID+"&relationship_id="+relationshipID, strings.NewReader(body))
	req.Header.Set("X-Kaata-Currencies", "1")
	if authenticated {
		token, err := auth.SignSession(testJWTSecret, f.accountID, uuid.NewString(), "google", "credit-alerts-test")
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	auth.RequireSession(testJWTSecret)(http.HandlerFunc(NewHandler(f.svc).CreditAlerts)).ServeHTTP(rec, req)
	return rec
}

func TestCreditAlertsAuthorityValidationAndIndependentLegacyLimits(t *testing.T) {
	f := newM1Fixture(t)
	rel := seedCreditContact(t, f)
	seedCreditPolicy(t, f, rel, "clerk_block", 12345)
	body := `{"relationship_id":"` + rel + `","groups":[{"direction":"collect","conditions":[{"currency":"USD","threshold_minor":500000},{"currency":"AFN","threshold_minor":10000000}]}],"updated_at_ms":0}`
	if r := creditAlertsRequest(t, f, "GET", "", "", true); r.Code != 200 || strings.TrimSpace(r.Body.String()) != "[]" {
		t.Fatalf("authoritative empty %d %s", r.Code, r.Body.String())
	}
	if r := creditAlertsRequest(t, f, "GET", "", "", false); r.Code != 401 {
		t.Fatalf("anonymous %d", r.Code)
	}
	for _, role := range []string{"owner", "manager", "editor", "clerk", "viewer"} {
		if _, err := f.pool.Exec(t.Context(), `UPDATE vault_members SET role=$1 WHERE vault_id=$2::uuid AND account_id=$3::uuid`, role, f.vaultID, f.accountID); err != nil {
			t.Fatal(err)
		}
		want := 403
		if role == "owner" || role == "manager" {
			want = 200
		}
		r := creditAlertsRequest(t, f, "PUT", "", body, true)
		if r.Code != want {
			t.Fatalf("%s PUT %d %s", role, r.Code, r.Body.String())
		}
		if want == 200 {
			var p credit.AlertPolicy
			if json.Unmarshal(r.Body.Bytes(), &p) != nil || p.UpdatedAtMS <= 0 || len(p.Groups[0].Conditions) != 2 {
				t.Fatalf("saved exact policy %s", r.Body.String())
			}
		} else if r := creditAlertsRequest(t, f, "DELETE", rel, "", true); r.Code != 403 {
			t.Fatalf("%s DELETE %d", role, r.Code)
		}
		if r := creditAlertsRequest(t, f, "GET", "", "", true); r.Code != 200 {
			t.Fatalf("%s GET %d %s", role, r.Code, r.Body.String())
		}
	}
	if _, err := f.pool.Exec(t.Context(), `UPDATE vault_members SET role='manager' WHERE vault_id=$1::uuid`, f.vaultID); err != nil {
		t.Fatal(err)
	}
	for _, invalid := range []string{
		strings.Replace(body, "500000", "500000.1", 1),
		strings.Replace(body, "500000", `"500000"`, 1),
		strings.Replace(body, "500000", "null", 1),
		strings.Replace(body, "500000", "0", 1),
		strings.Replace(body, "500000", "1000000000000", 1),
		strings.Replace(body, `"AFN"`, `"USD"`, 1),
		strings.Replace(body, `"collect"`, `"both"`, 1),
		strings.Replace(body, `"groups":[`, `"groups":null,"ignored":[`, 1),
		`{"relationship_id":"` + rel + `"}`,
		`{"relationship_id":"` + rel + `","groups":[{"direction":"collect","conditions":[]}]}`,
		body + " {}",
	} {
		if r := creditAlertsRequest(t, f, "PUT", "", invalid, true); r.Code != 400 {
			t.Fatalf("invalid accepted %d: %s", r.Code, invalid)
		}
	}
	if r := creditAlertsRequest(t, f, "PUT", "", strings.Replace(body, rel, uuid.NewString(), 1), true); r.Code != 409 {
		t.Fatalf("foreign customer %d %s", r.Code, r.Body.String())
	}
	var cap int64
	var mode string
	if err := f.pool.QueryRow(t.Context(), `SELECT max_collect_minor,mode FROM customer_credit_limits WHERE vault_id=$1::uuid AND relationship_id=$2::uuid`, f.vaultID, rel).Scan(&cap, &mode); err != nil || cap != 12345 || mode != "clerk_block" {
		t.Fatalf("alert save changed existing admission limit: %d %s %v", cap, mode, err)
	}
	if _, err := f.pool.Exec(t.Context(), `UPDATE accounts SET pending_delete_at=NOW() WHERE id=$1::uuid`, f.accountID); err != nil {
		t.Fatal(err)
	}
	for _, method := range []string{"GET", "PUT", "DELETE"} {
		if r := creditAlertsRequest(t, f, method, rel, body, true); r.Code != 401 {
			t.Fatalf("pending account %s %d", method, r.Code)
		}
	}
	if _, err := f.pool.Exec(t.Context(), `UPDATE accounts SET pending_delete_at=NULL WHERE id=$1::uuid`, f.accountID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(t.Context(), `UPDATE vault_members SET revoked_at=NOW() WHERE vault_id=$1::uuid`, f.vaultID); err != nil {
		t.Fatal(err)
	}
	if r := creditAlertsRequest(t, f, "GET", "", "", true); r.Code != 403 {
		t.Fatalf("revoked GET %d", r.Code)
	}
}

func TestCreditAlertsDefaultOverrideResetAndLiveSnapshot(t *testing.T) {
	f := newM1Fixture(t)
	rel := seedCreditContact(t, f)
	empty, err := ProjectionToJSON(NewProjection())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(t.Context(), `INSERT INTO vault_snapshots(vault_id,up_to_server_seq,snapshot,schema_version,byte_size) VALUES($1::uuid,0,$2::jsonb,$3,$4)`, f.vaultID, empty, SnapshotSchemaVersion, len(empty)); err != nil {
		t.Fatal(err)
	}
	body := `{"relationship_id":"` + credit.DefaultRelationshipID + `","groups":[{"direction":"pay","conditions":[{"currency":"USD","threshold_minor":12345}]}]}`
	if r := creditAlertsRequest(t, f, "PUT", "", body, true); r.Code != 200 {
		t.Fatalf("default %d %s", r.Code, r.Body.String())
	}
	p, err := credit.EffectiveAlerts(t.Context(), f.pool, f.vaultID, rel)
	if err != nil || p == nil || p.RelationshipID != credit.DefaultRelationshipID {
		t.Fatalf("missing customer did not inherit: %+v %v", p, err)
	}
	off := `{"relationship_id":"` + rel + `","groups":[]}`
	if r := creditAlertsRequest(t, f, "PUT", "", off, true); r.Code != 200 {
		t.Fatalf("explicit off %d %s", r.Code, r.Body.String())
	}
	p, err = credit.EffectiveAlerts(t.Context(), f.pool, f.vaultID, rel)
	if err != nil || p == nil || p.RelationshipID != rel || p.Groups == nil || len(p.Groups) != 0 {
		t.Fatalf("explicit off did not override: %+v %v", p, err)
	}
	snapshot, err := f.svc.LatestSnapshot(t.Context(), f.vaultID)
	if err != nil || len(snapshot.CreditAlerts) != 2 {
		t.Fatalf("snapshot lost current policies: %+v %v", snapshot, err)
	}
	if r := creditAlertsRequest(t, f, "DELETE", rel, "", true); r.Code != 204 {
		t.Fatalf("reset inherit %d %s", r.Code, r.Body.String())
	}
	p, err = credit.EffectiveAlerts(t.Context(), f.pool, f.vaultID, rel)
	if err != nil || p == nil || p.RelationshipID != credit.DefaultRelationshipID {
		t.Fatalf("reset did not inherit: %+v %v", p, err)
	}
	snapshot, err = f.svc.LatestSnapshot(t.Context(), f.vaultID)
	if err != nil || len(snapshot.CreditAlerts) != 1 {
		t.Fatalf("old snapshot revived removed policy: %+v %v", snapshot, err)
	}
	if r := creditAlertsRequest(t, f, "DELETE", credit.DefaultRelationshipID, "", true); r.Code != 204 {
		t.Fatalf("remove default %d %s", r.Code, r.Body.String())
	}
	if r := creditAlertsRequest(t, f, "DELETE", rel, "", true); r.Code != 204 {
		t.Fatalf("idempotent reset %d", r.Code)
	}
	p, err = credit.EffectiveAlerts(t.Context(), f.pool, f.vaultID, rel)
	if err != nil || p != nil {
		t.Fatalf("removed default survived: %+v %v", p, err)
	}
}

func TestCreditAlertsSaveRechecksRoleAfterSerializedPolicyLock(t *testing.T) {
	f := newM1Fixture(t)
	rel := seedCreditContact(t, f)
	tx, err := f.pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	if err := credit.Lock(t.Context(), tx, f.vaultID); err != nil {
		t.Fatal(err)
	}
	body := `{"relationship_id":"` + rel + `","groups":[]}`
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() { done <- creditAlertsRequest(t, f, "PUT", "", body, true) }()
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	for {
		var waiting bool
		if err := f.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%pg_advisory_xact_lock%')`).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal("policy save did not wait for serialized credit configuration")
		case <-time.After(10 * time.Millisecond):
		}
	}
	if _, err := tx.Exec(t.Context(), `UPDATE vault_members SET role='clerk' WHERE vault_id=$1::uuid AND account_id=$2::uuid`, f.vaultID, f.accountID); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	select {
	case response := <-done:
		if response.Code != http.StatusForbidden {
			t.Fatalf("old role admitted policy after demotion: %d %s", response.Code, response.Body.String())
		}
	case <-ctx.Done():
		t.Fatal("policy save remained blocked")
	}
	var count int
	if err := f.pool.QueryRow(t.Context(), `SELECT COUNT(*) FROM customer_credit_alerts`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("demoted save persisted: %d %v", count, err)
	}
}

func TestCreditAlertsRevisionsRemainMonotonicThroughDeletionAndClockRollback(t *testing.T) {
	f := newM1Fixture(t)
	rel := seedCreditContact(t, f)
	body := `{"relationship_id":"` + rel + `","groups":[]}`
	put := creditAlertsRequest(t, f, "PUT", "", body, true)
	var saved credit.AlertPolicy
	if put.Code != 200 || json.Unmarshal(put.Body.Bytes(), &saved) != nil || put.Header().Get("X-Kaata-Credit-Updated-At") != strconv.FormatInt(saved.UpdatedAtMS, 10) {
		t.Fatalf("save revision %d %s", put.Code, put.Body.String())
	}
	deleted := creditAlertsRequest(t, f, "DELETE", rel, "", true)
	deletion, err := strconv.ParseInt(deleted.Header().Get("X-Kaata-Credit-Updated-At"), 10, 64)
	if deleted.Code != 204 || err != nil || deletion <= saved.UpdatedAtMS {
		t.Fatalf("delete revision %d %d %v", deleted.Code, deletion, err)
	}
	get := creditAlertsRequest(t, f, "GET", "", "", true)
	if get.Code != 200 || strings.TrimSpace(get.Body.String()) != "[]" || get.Header().Get("X-Kaata-Credit-Updated-At") != strconv.FormatInt(deletion, 10) {
		t.Fatalf("empty list lost deletion cutoff: %d %s %v", get.Code, get.Body.String(), get.Header())
	}
	put = creditAlertsRequest(t, f, "PUT", "", body, true)
	if put.Code != 200 || json.Unmarshal(put.Body.Bytes(), &saved) != nil || saved.UpdatedAtMS <= deletion {
		t.Fatalf("same-ms recreate lost to tombstone: %d %s", put.Code, put.Body.String())
	}
	future := time.Now().Add(24 * time.Hour).UnixMilli()
	if _, err := f.pool.Exec(t.Context(), `UPDATE customer_credit_alert_revisions SET updated_at_ms=$2 WHERE vault_id=$1::uuid`, f.vaultID, future); err != nil {
		t.Fatal(err)
	}
	put = creditAlertsRequest(t, f, "PUT", "", body, true)
	if put.Code != 200 || json.Unmarshal(put.Body.Bytes(), &saved) != nil || saved.UpdatedAtMS != future+1 {
		t.Fatalf("server clock rollback broke ordering: %d %s", put.Code, put.Body.String())
	}
}
