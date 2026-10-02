package auth

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/matee/kaata-backend/internal/testutil"
)

func seedDeletionSession(t *testing.T, pool *pgxpool.Pool) (string, string, string) {
	t.Helper()
	account := seedAccount(t, pool, uuid.NewString()+"@example.test")
	install := uuid.NewString()
	if _, err := pool.Exec(t.Context(), `INSERT INTO installs(install_id, account_id)
		VALUES ($1::uuid, $2::uuid)`, install, account); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(t.Context(), `INSERT INTO auth_credentials(install_id, provider, provider_sub, account_id)
		VALUES ($1::uuid, 'google', 'receipt-test', $2::uuid)`, install, account); err != nil {
		t.Fatal(err)
	}
	token, err := SignSession(testSecret, account, install, ProviderGoogle, "receipt-test")
	if err != nil {
		t.Fatal(err)
	}
	return account, install, token
}

func deletionRequest(handler http.Handler, token string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(http.MethodDelete, "/v1/account", nil)
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	return w
}

func TestDeletionMiddlewareConfirmsCommittedRetryOnly(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	account, install, token := seedDeletionSession(t, pool)
	svc := NewService(pool, "test-client", testSecret)
	a := NewSessionAuthenticator(svc, testSecret)
	h := NewHandler(svc)
	h.SetAuthenticator(a)
	claims, err := ParseSession(testSecret, token)
	if err != nil {
		t.Fatal(err)
	}
	// Prime the ordinary auth cache to verify account deletion also revokes it.
	if revoked, err := a.isRevoked(t.Context(), claims); err != nil || revoked {
		t.Fatalf("initial session: revoked=%v err=%v", revoked, err)
	}
	handlerCalls := 0
	endpoint := a.DeletionMiddleware()(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handlerCalls++
		h.DeleteAccount(w, r)
	}))
	for _, attempt := range []string{"original deletion", "retry after lost response"} {
		w := deletionRequest(endpoint, token)
		var body map[string]string
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil || w.Code != http.StatusOK || body["status"] != "deleted" {
			t.Fatalf("%s = %d %s; err=%v", attempt, w.Code, w.Body.String(), err)
		}
		if handlerCalls != 1 {
			t.Fatalf("%s reached destructive handler %d times, want exactly one total", attempt, handlerCalls)
		}
	}
	var completed bool
	if completed, err = svc.AccountDeletionCompleted(t.Context(), install, account); err != nil || !completed {
		t.Fatalf("committed deletion receipt=%v err=%v", completed, err)
	}
	normal := a.Middleware()(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Error("deleted session reached a normal protected handler")
	}))
	if w := deletionRequest(normal, token); w.Code != http.StatusUnauthorized {
		t.Fatalf("normal auth accepted a deletion receipt: status=%d body=%s", w.Code, w.Body.String())
	}

	signClaims := func(secret string, c SessionClaims) string {
		t.Helper()
		tok, err := jwt.NewWithClaims(jwt.SigningMethodHS256, c).SignedString([]byte(secret))
		if err != nil {
			t.Fatal(err)
		}
		return tok
	}
	wrongAccount, wrongInstall, expired, noExpiry := *claims, *claims, *claims, *claims
	wrongAccount.AccountID = uuid.NewString()
	wrongAccount.Subject = wrongAccount.AccountID
	wrongInstall.InstallID = uuid.NewString()
	expired.ExpiresAt = jwt.NewNumericDate(time.Now().Add(-time.Minute))
	noExpiry.ExpiresAt = nil
	for name, badToken := range map[string]string{
		"different account": signClaims(testSecret, wrongAccount),
		"different install": signClaims(testSecret, wrongInstall),
		"wrong signature":   signClaims("different-signing-secret", *claims),
		"expired token":     signClaims(testSecret, expired),
		"missing expiry":    signClaims(testSecret, noExpiry),
		"missing token":     "",
	} {
		t.Run(name, func(t *testing.T) {
			if w := deletionRequest(endpoint, badToken); w.Code != http.StatusUnauthorized {
				t.Fatalf("untrusted retry=%d %s, want 401", w.Code, w.Body.String())
			}
		})
	}
	if _, err := pool.Exec(t.Context(), `UPDATE installs SET deletion_account_id = NULL WHERE install_id = $1::uuid`, install); err != nil {
		t.Fatal(err)
	}
	if w := deletionRequest(endpoint, token); w.Code != http.StatusUnauthorized {
		t.Fatalf("retirement marker without matching account receipt=%d, want 401", w.Code)
	}
	if _, err := pool.Exec(t.Context(), `UPDATE installs SET deletion_account_id = $2::uuid, account_deleted_at = NULL
		WHERE install_id = $1::uuid`, install, account); err != nil {
		t.Fatal(err)
	}
	if w := deletionRequest(endpoint, token); w.Code != http.StatusUnauthorized {
		t.Fatalf("account receipt without completed retirement=%d, want 401", w.Code)
	}
	if handlerCalls != 1 {
		t.Fatalf("untrusted retry reached handler; total calls=%d", handlerCalls)
	}
}

func TestDeletionMiddlewareRejectsSignedOutSessionDespiteCachedAccess(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	account, install, token := seedDeletionSession(t, pool)
	svc := NewService(pool, "test-client", testSecret)
	a := NewSessionAuthenticator(svc, testSecret)
	claims, err := ParseSession(testSecret, token)
	if err != nil {
		t.Fatal(err)
	}
	if revoked, err := a.isRevoked(t.Context(), claims); err != nil || revoked {
		t.Fatalf("initial session: revoked=%v err=%v", revoked, err)
	}
	// Deliberately leave this process's LRU warm, as on a different replica.
	if err := svc.SignOut(t.Context(), install, ProviderGoogle); err != nil {
		t.Fatal(err)
	}
	endpoint := a.DeletionMiddleware()(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Error("signed-out session reached account deletion")
	}))
	if w := deletionRequest(endpoint, token); w.Code != http.StatusUnauthorized {
		t.Fatalf("signed-out deletion=%d %s, want 401", w.Code, w.Body.String())
	}
	var remains bool
	if err := pool.QueryRow(t.Context(), `SELECT EXISTS (SELECT 1 FROM accounts WHERE id = $1::uuid)`, account).Scan(&remains); err != nil || !remains {
		t.Fatalf("signed-out account remains=%v err=%v", remains, err)
	}
}

type deletionReceiptCheckFunc func(context.Context, string, string) (bool, error)

func (f deletionReceiptCheckFunc) AccountDeletionCompleted(ctx context.Context, install, account string) (bool, error) {
	return f(ctx, install, account)
}

func TestDeletionMiddlewareFailsClosedWhenStatusUnavailable(t *testing.T) {
	token, err := SignSession(testSecret, uuid.NewString(), uuid.NewString(), ProviderGoogle, "sub")
	if err != nil {
		t.Fatal(err)
	}
	for _, failingLookup := range []string{"credential", "receipt"} {
		t.Run(failingLookup, func(t *testing.T) {
			a := NewSessionAuthenticator(nil, testSecret)
			a.svc = revocationCheckFunc(func(context.Context, string, string, string) (bool, error) {
				if failingLookup == "credential" {
					return false, errors.New("database unavailable")
				}
				return true, nil
			})
			a.receipts = deletionReceiptCheckFunc(func(context.Context, string, string) (bool, error) {
				return false, errors.New("database unavailable")
			})
			endpoint := a.DeletionMiddleware()(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
				t.Error("unverified session reached deletion handler")
			}))
			if w := deletionRequest(endpoint, token); w.Code != http.StatusServiceUnavailable {
				t.Fatalf("failed %s check=%d %s, want 503", failingLookup, w.Code, w.Body.String())
			}
		})
	}
}
