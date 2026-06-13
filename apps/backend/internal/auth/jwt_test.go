package auth

import (
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

const testSecret = "0123456789abcdef0123456789abcdef" // 32 bytes

func TestSessionJWTRoundTrip(t *testing.T) {
	accountID := uuid.NewString()
	installID := uuid.NewString()

	tok, err := SignSession(testSecret, accountID, installID, ProviderGoogle, "sub-123")
	if err != nil {
		t.Fatalf("SignSession: %v", err)
	}

	claims, err := ParseSession(testSecret, tok)
	if err != nil {
		t.Fatalf("ParseSession: %v", err)
	}
	if claims.AccountID != accountID {
		t.Errorf("AccountID = %q, want %q", claims.AccountID, accountID)
	}
	if claims.InstallID != installID {
		t.Errorf("InstallID = %q, want %q", claims.InstallID, installID)
	}
	if claims.Provider != ProviderGoogle {
		t.Errorf("Provider = %q, want google", claims.Provider)
	}
	if claims.ProviderSub != "sub-123" {
		t.Errorf("ProviderSub = %q, want sub-123", claims.ProviderSub)
	}
	if claims.Subject != accountID {
		t.Errorf("Subject = %q, want account id %q (account id stays the subject)", claims.Subject, accountID)
	}
}

// TestSessionJWTToleratesLegacyClaimShape pins the M1 compatibility
// contract: a token minted by an older release carrying extra/legacy
// claims (e.g. a google-specific `google_sub`) must still parse — the
// 30-day sessions in the field cannot be invalidated by a claims cleanup.
// golang-jwt unmarshals via encoding/json, which ignores unknown fields;
// this test keeps that assumption from silently regressing (e.g. if
// someone adds DisallowUnknownFields-style strictness).
func TestSessionJWTToleratesLegacyClaimShape(t *testing.T) {
	accountID := uuid.NewString()
	installID := uuid.NewString()
	now := time.Now()

	legacy := jwt.MapClaims{
		"account_id":   accountID,
		"install_id":   installID,
		"provider":     "google",
		"provider_sub": "sub-legacy",
		// The legacy/extra claim a previous shape might have carried.
		"google_sub": "sub-legacy",
		"iss":        SessionIssuer,
		"sub":        accountID,
		"iat":        now.Unix(),
		"nbf":        now.Unix(),
		"exp":        now.Add(SessionLifetime).Unix(),
	}
	tok, err := jwt.NewWithClaims(jwt.SigningMethodHS256, legacy).SignedString([]byte(testSecret))
	if err != nil {
		t.Fatalf("sign legacy-shape token: %v", err)
	}

	claims, err := ParseSession(testSecret, tok)
	if err != nil {
		t.Fatalf("ParseSession rejected legacy-shape token: %v", err)
	}
	if claims.AccountID != accountID || claims.InstallID != installID {
		t.Errorf("legacy token parsed to (%q, %q), want (%q, %q)",
			claims.AccountID, claims.InstallID, accountID, installID)
	}
	if claims.Provider != "google" || claims.ProviderSub != "sub-legacy" {
		t.Errorf("legacy token provider claims = (%q, %q), want (google, sub-legacy)",
			claims.Provider, claims.ProviderSub)
	}
}

func TestParseSessionRejectsWrongIssuerAndAlg(t *testing.T) {
	accountID := uuid.NewString()

	// Wrong issuer.
	bad := jwt.MapClaims{
		"account_id": accountID,
		"iss":        "someone-else",
		"sub":        accountID,
		"exp":        time.Now().Add(time.Hour).Unix(),
	}
	tok, err := jwt.NewWithClaims(jwt.SigningMethodHS256, bad).SignedString([]byte(testSecret))
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	if _, err := ParseSession(testSecret, tok); err == nil {
		t.Errorf("ParseSession accepted a token with the wrong issuer")
	}

	// alg=none must never validate.
	none := jwt.NewWithClaims(jwt.SigningMethodNone, jwt.MapClaims{
		"account_id": accountID,
		"iss":        SessionIssuer,
		"exp":        time.Now().Add(time.Hour).Unix(),
	})
	noneTok, err := none.SignedString(jwt.UnsafeAllowNoneSignatureType)
	if err != nil {
		t.Fatalf("sign none: %v", err)
	}
	if _, err := ParseSession(testSecret, noneTok); err == nil ||
		!strings.Contains(err.Error(), "signing method") {
		t.Errorf("ParseSession must reject alg=none, got err=%v", err)
	}
}
