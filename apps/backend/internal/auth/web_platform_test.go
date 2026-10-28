package auth

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"
	"github.com/matee/kaata-backend/internal/testutil"
)

func TestWebSignInLabelsBrowserWithoutRelabellingOrSigningOutPhone(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	svc := newEmailService(t, pool)
	phoneID := uuid.NewString()
	phone := signUp(t, svc, pool, "web-platform@shop.af", phoneID)
	if _, err := pool.Exec(t.Context(), `UPDATE installs SET platform='android', app_version='1.0.0' WHERE install_id=$1`, phoneID); err != nil {
		t.Fatal(err)
	}
	browserID := uuid.NewString()
	body, _ := json.Marshal(map[string]string{
		"install_id": browserID, "platform": "web", "identifier": "web-platform@shop.af", "password": goodPassword,
	})
	w := httptest.NewRecorder()
	NewHandler(svc).EmailSignIn(w, httptest.NewRequest(http.MethodPost, "/v1/auth/email/signin", bytes.NewReader(body)))
	if w.Code != http.StatusOK {
		t.Fatalf("browser sign-in status=%d body=%s", w.Code, w.Body.String())
	}
	var browser GoogleSignInResult
	if err := json.Unmarshal(w.Body.Bytes(), &browser); err != nil {
		t.Fatal(err)
	}
	if browser.AccountID != phone.AccountID {
		t.Fatal("browser must open the same account as the phone")
	}
	var platform string
	if err := pool.QueryRow(t.Context(), `SELECT platform FROM installs WHERE install_id=$1`, browserID).Scan(&platform); err != nil || platform != "web" {
		t.Fatalf("browser platform=%q err=%v", platform, err)
	}
	if err := pool.QueryRow(t.Context(), `SELECT platform FROM installs WHERE install_id=$1`, phoneID).Scan(&platform); err != nil || platform != "android" {
		t.Fatalf("phone platform=%q err=%v", platform, err)
	}
	if err := svc.SignOut(t.Context(), browserID, ProviderEmail); err != nil {
		t.Fatal(err)
	}
	if n := dbCount(t, pool, `SELECT COUNT(*) FROM auth_credentials WHERE install_id=$1`, phoneID); n != 1 {
		t.Fatalf("web sign-out revoked phone: credential count=%d", n)
	}
	// A forged analytics hint cannot relabel a known physical installation.
	if _, err := svc.EmailSignIn(t.Context(), phoneID, "web-platform@shop.af", goodPassword, SwitchOptions{Platform: "web"}); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(t.Context(), `SELECT platform FROM installs WHERE install_id=$1`, phoneID).Scan(&platform); err != nil || platform != "android" {
		t.Fatalf("known phone relabelled: platform=%q err=%v", platform, err)
	}
}
