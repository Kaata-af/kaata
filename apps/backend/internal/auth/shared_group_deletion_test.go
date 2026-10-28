package auth_test

import (
	"encoding/base64"
	"errors"
	"github.com/google/uuid"
	syncapi "github.com/matee/kaata-backend/internal/sync"
	"github.com/matee/kaata-backend/internal/tabs"
	"testing"
)

func TestSharedGroupAccountDeletionRetiresWholeInvitation(t *testing.T) {
	for _, joined := range []bool{false, true} {
		t.Run(map[bool]string{false: "unused", true: "joined"}[joined], func(t *testing.T) {
			f := newSharedDeletionFixture(t, false)
			f.tallies.SetCreditBalanceReader(syncapi.CreditBalance)
			f.tallies.SetGroupCurrencyHistoryReader(syncapi.HasCurrencyHistory)
			f.tallies.SetGroupSourceLatestRecordedAtReader(syncapi.GroupSourceLatestRecordedAt)
			f.tallies.SetGroupSourceCurrenciesReader(syncapi.GroupSourceCurrencies)
			token := base64.RawURLEncoding.EncodeToString([]byte(uuid.NewString()[:32]))
			created, err := f.tallies.CreateGroup(t.Context(), tabs.GroupCreateInput{RequestID: uuid.NewString(), InviteToken: token, RecordingMode: "notify", Label: "Group A", VaultID: f.va, RelationshipID: uuid.NewString(), AccountID: f.a, Currencies: []tabs.GroupCurrencyInput{{Currency: "AFN"}, {Currency: "USD"}}})
			if err != nil {
				t.Fatal(err)
			}
			for _, leg := range created.Tabs {
				p, err := f.tallies.PartyByAccount(t.Context(), leg.Tab.ID, f.a)
				if err != nil {
					t.Fatal(err)
				}
				amount, direction := "100", "a_to_b"
				if leg.Tab.Currency == "USD" {
					amount, direction = "12.34", "b_to_a"
				}
				if _, err = f.tallies.Append(t.Context(), p, tabs.AppendInput{ID: uuid.NewString(), Direction: direction, Amount: amount, OccurredAtMS: 100}); err != nil {
					t.Fatal(err)
				}
			}
			if joined {
				if _, err = f.tallies.JoinGroup(t.Context(), created.Group.ID, tabs.GroupJoinInput{Token: token, Label: "Group B", VaultID: f.vb, RelationshipID: uuid.NewString(), AccountID: f.b, Currencies: []tabs.GroupCurrencyInput{{Currency: "AFN"}, {Currency: "USD"}}}); err != nil {
					t.Fatal(err)
				}
			}
			if err = f.accounts.DeleteAccount(t.Context(), f.a); err != nil {
				t.Fatal(err)
			}
			var closed bool
			if err = f.pool.QueryRow(t.Context(), `SELECT closed_at IS NOT NULL FROM tab_groups WHERE id=$1::uuid`, created.Group.ID).Scan(&closed); err != nil || !closed {
				t.Fatalf("group not retired %v", err)
			}
			if _, err = f.tallies.PreviewGroup(t.Context(), token, f.b); !errors.Is(err, tabs.ErrNotFound) {
				t.Fatalf("deleted sender invitation still usable: %v", err)
			}
			for _, leg := range created.Tabs {
				var closed bool
				var amount int64
				if err = f.pool.QueryRow(t.Context(), `SELECT t.closed_at IS NOT NULL,e.amount_minor FROM tabs t JOIN tab_entries e ON e.tab_id=t.id AND e.kind='entry' WHERE t.id=$1::uuid`, leg.Tab.ID).Scan(&closed, &amount); err != nil || !closed {
					t.Fatalf("leg not retired %v", err)
				}
				if (leg.Tab.Currency == "AFN" && amount != 10000) || (leg.Tab.Currency == "USD" && amount != 1234) {
					t.Fatal("deletion changed monetary history")
				}
			}
		})
	}
}
