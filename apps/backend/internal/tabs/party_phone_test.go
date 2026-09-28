package tabs

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/google/uuid"
)

// D18: the bound account's own phone (accounts.phone_e164) rides on every
// Tab payload as parties[role].phone so the OTHER party can match the
// invitation to a contact at join time. "" when the party is unbound or the
// account never set a number; never NULL on the wire.
func TestPartyPhoneRidesTheWire(t *testing.T) {
	f := newHTTPFixture(t)
	ctx := context.Background()
	const phoneA = "+93700123456"
	if _, err := f.pool.Exec(ctx, `UPDATE accounts SET phone_e164 = $2 WHERE id = $1::uuid`, f.acctA, phoneA); err != nil {
		t.Fatalf("seed phone: %v", err)
	}
	// B's account keeps phone_e164 NULL — the "never set one" case.

	jwtA := "Bearer " + f.jwtFor(t, f.acctA)
	jwtB := "Bearer " + f.jwtFor(t, f.acctB)

	// A creates from the phone: session-bound party a with kaata + contact.
	created := f.do(t, "POST", "/v1/tabs", jwtA, map[string]any{
		"currency": "AFN", "label": "Saafi Store", "vault_id": f.vaultA, "relationship_id": uuid.NewString(),
	})
	if created.status != 201 {
		t.Fatalf("create = %d %s", created.status, created.body)
	}
	var c CreateResponse
	if err := json.Unmarshal(created.body, &c); err != nil {
		t.Fatalf("decode create: %v", err)
	}
	if !c.Tab.Parties["a"].Bound || c.Tab.Parties["a"].Phone != phoneA {
		t.Fatalf("creator's own view: %+v", c.Tab.Parties["a"])
	}
	if c.Tab.Parties["b"].Bound || c.Tab.Parties["b"].Phone != "" {
		t.Fatalf("unjoined party b must carry an empty phone: %+v", c.Tab.Parties["b"])
	}
	path := "/v1/tabs/" + c.Tab.ID

	// The invitation preview, as B — the join screen's input. Raw JSON so
	// the exact key name is pinned, not just the Go field.
	preview := f.do(t, "POST", "/v1/tabs/by-token", jwtB, map[string]any{"token": c.InviteToken})
	if preview.status != 200 {
		t.Fatalf("preview = %d %s", preview.status, preview.body)
	}
	parties := preview.json(t)["tab"].(map[string]any)["parties"].(map[string]any)
	a := parties["a"].(map[string]any)
	b := parties["b"].(map[string]any)
	if got, ok := a["phone"]; !ok || got != phoneA {
		t.Fatalf("preview parties.a.phone = %v (present=%v), want %q", got, ok, phoneA)
	}
	if got, ok := b["phone"]; !ok || got != "" {
		t.Fatalf("preview parties.b.phone = %v (present=%v), want \"\" (unbound)", got, ok)
	}

	// B joins signed in: bound, but the account has no phone → still "".
	joined := f.do(t, "POST", path+"/join", jwtB, map[string]any{
		"token": c.InviteToken, "label": "Ahmad", "vault_id": f.vaultB, "relationship_id": uuid.NewString(),
	})
	if joined.status != 200 {
		t.Fatalf("join = %d %s", joined.status, joined.body)
	}
	var jr TabResponse
	if err := json.Unmarshal(joined.body, &jr); err != nil {
		t.Fatalf("decode join: %v", err)
	}
	if !jr.Tab.Parties["b"].Bound || jr.Tab.Parties["b"].Phone != "" {
		t.Fatalf("bound account with NULL phone_e164 must yield \"\": %+v", jr.Tab.Parties["b"])
	}
	if jr.Tab.Parties["a"].Phone != phoneA {
		t.Fatalf("join response lost a's phone: %+v", jr.Tab.Parties["a"])
	}

	// Every later read carries it too: A's pull, B's recovery list.
	got := f.do(t, "GET", path, jwtA, nil)
	if got.status != 200 {
		t.Fatalf("get = %d %s", got.status, got.body)
	}
	gp := got.json(t)["tab"].(map[string]any)["parties"].(map[string]any)
	if gp["a"].(map[string]any)["phone"] != phoneA || gp["b"].(map[string]any)["phone"] != "" {
		t.Fatalf("get parties = %v", gp)
	}
	mine := f.do(t, "GET", "/v1/tabs/mine", jwtB, nil)
	if mine.status != 200 {
		t.Fatalf("mine = %d %s", mine.status, mine.body)
	}
	var mr MineResponse
	if err := json.Unmarshal(mine.body, &mr); err != nil {
		t.Fatalf("decode mine: %v", err)
	}
	if len(mr.Tabs) != 1 || mr.Tabs[0].Tab.Parties["a"].Phone != phoneA || mr.Tabs[0].Tab.Parties["b"].Phone != "" {
		t.Fatalf("mine = %+v", mr.Tabs)
	}

	// Once B sets a number it appears on A's next pull — no rev bump needed,
	// it is read live from the account, like account_name.
	if _, err := f.pool.Exec(ctx, `UPDATE accounts SET phone_e164 = '+93799000000' WHERE id = $1::uuid`, f.acctB); err != nil {
		t.Fatalf("set B phone: %v", err)
	}
	again := f.do(t, "GET", path, jwtA, nil)
	if again.status != 200 || again.json(t)["tab"].(map[string]any)["parties"].(map[string]any)["b"].(map[string]any)["phone"] != "+93799000000" {
		t.Fatalf("B's phone not live: %d %s", again.status, again.body)
	}
}
