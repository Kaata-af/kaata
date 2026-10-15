package sync

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"testing"

	"github.com/google/uuid"
	"github.com/matee/kaata-backend/internal/ownership"
)

func handoverFixture(t *testing.T, alias string) (*m2Fixture, string, PushEvent) {
	t.Helper()
	f := newM2Fixture(t)
	chainID := f.ownerAcct
	if alias != "" {
		chainID = alias
	}
	genesis := f.membershipEvent(EventVaultMemberAdded, f.anchorDeviceID, f.ownerAcct, chainID,
		map[string]any{"account_id": chainID, "role": "owner"})
	f.signEvent(t, &genesis, f.anchorPriv)
	if res := f.pushAs(t, f.ownerAcct, genesis); len(res.Accepted) != 1 {
		t.Fatalf("genesis rejected: %+v", res)
	}
	to := f.seedAccount(t, "recipient@example.com")
	_, err := f.pool.Exec(context.Background(), `INSERT INTO vault_members(vault_id,account_id,role,invited_at,accepted_at,invited_by)
	 VALUES($1::uuid,$2::uuid,'editor',NOW(),NOW(),$3::uuid)`, f.vaultID, to, f.ownerAcct)
	if err != nil {
		t.Fatal(err)
	}
	g := ownership.Grant{Domain: ownership.GrantDomain, TransferID: uuid.NewString(), VaultID: f.vaultID,
		FromAccountID: f.ownerAcct, RecipientEmailNormalized: "recipient@example.com", DemoteSelfTo: "editor",
		IssuedAtMS: f.nextPMS(), ExpiresAtMS: f.pms + 60000}
	if alias != "" {
		g.FromChainAccountID = alias
	}
	b, err := ownership.GrantBytes(g)
	if err != nil {
		t.Fatal(err)
	}
	hash, err := ownership.GrantHash(g)
	if err != nil {
		t.Fatal(err)
	}
	id := uuid.NewString()
	p := ownership.Proof{Authorization: ownership.Authorization{Grant: g,
		SignerDevicePubkey: base64.StdEncoding.EncodeToString(f.anchorPub), SigB64: base64.StdEncoding.EncodeToString(ed25519.Sign(f.anchorPriv, b))},
		Receipt: ownership.Receipt{Domain: ownership.ReceiptDomain, TransferID: g.TransferID, VaultID: f.vaultID,
			GrantSHA256: hash, ToAccountID: to, AcceptedAtMS: f.nextPMS(), EventID: id, VaultEpoch: f.vaultEpoch(t) + 1}}
	raw, err := json.Marshal(map[string]any{"account_id": to, "role": "owner", "ownership_transfer": p})
	if err != nil {
		t.Fatal(err)
	}
	ev := PushEvent{EventID: id, HLC: PushHLC{PhysicalMS: p.Receipt.AcceptedAtMS, DeviceID: uuid.NewString()},
		EventType: EventVaultMemberAdded, SchemaVersion: 1, TargetID: &to, Payload: raw}
	f.signEvent(t, &ev, f.serverPriv)
	return f, to, ev
}

func TestOwnershipTransferProofAndFormerAnchor(t *testing.T) {
	for _, alias := range []string{"", "local:abcdefghijklmnop"} {
		t.Run("chain_"+alias, func(t *testing.T) {
			f, to, ev := handoverFixture(t, alias)
			if res := f.pushAs(t, f.ownerAcct, ev); len(res.Accepted) != 1 {
				t.Fatalf("handover rejected: %+v", res)
			}
			if got := f.memberRow(t, f.ownerAcct); got != "editor" {
				t.Fatalf("old owner=%s", got)
			}
			if got := f.memberRow(t, to); got != "owner" {
				t.Fatalf("new owner=%s", got)
			}
			var pointer string
			if err := f.pool.QueryRow(context.Background(), `SELECT owner_account_id::text FROM vaults WHERE vault_id=$1::uuid`, f.vaultID).Scan(&pointer); err != nil {
				t.Fatal(err)
			}
			if pointer != to {
				t.Fatalf("owner pointer=%s", pointer)
			}
			// The old anchor remains a trust root, not an eternal owner.
			reclaim := f.membershipEvent(EventVaultMemberRoleChng, f.anchorDeviceID, f.ownerAcct, f.ownerAcct,
				map[string]any{"account_id": f.ownerAcct, "role": "owner"})
			f.signEvent(t, &reclaim, f.anchorPriv)
			if res := f.pushAs(t, f.ownerAcct, reclaim); len(res.Rejected) != 1 || res.Rejected[0].Reason != RejectReasonMembershipUnverified {
				t.Fatalf("former anchor reclaimed: %+v", res)
			}
			// Backdated, historically authorized history cannot undo the handover.
			reclaim.EventID = uuid.NewString()
			reclaim.HLC.PhysicalMS = ev.HLC.PhysicalMS - 1
			f.signEvent(t, &reclaim, f.anchorPriv)
			f.pushAs(t, f.ownerAcct, reclaim)
			if got := f.memberRow(t, f.ownerAcct); got != "editor" {
				t.Fatalf("late old role won: %s", got)
			}
			// A receipt cannot be given a fresh identity, even by the server key.
			replay := ev
			replay.EventID = uuid.NewString()
			f.signEvent(t, &replay, f.serverPriv)
			if res := f.pushAs(t, f.ownerAcct, replay); len(res.Rejected) != 1 {
				t.Fatalf("receipt replay accepted: %+v", res)
			}
		})
	}
}

func TestOwnershipTransferRejectsServerKeyAloneAndRemovedOwnerDevice(t *testing.T) {
	t.Run("server_key_alone", func(t *testing.T) {
		f, _, ev := handoverFixture(t, "")
		var p memberAddedWire
		if err := json.Unmarshal(ev.Payload, &p); err != nil {
			t.Fatal(err)
		}
		p.OwnershipTransfer.Authorization.SigB64 = base64.StdEncoding.EncodeToString(make([]byte, 64))
		raw, _ := json.Marshal(p)
		ev.Payload = raw
		f.signEvent(t, &ev, f.serverPriv)
		if res := f.pushAs(t, f.ownerAcct, ev); len(res.Rejected) != 1 {
			t.Fatalf("server minted owner: %+v", res)
		}
	})
	t.Run("removed_authorizing_device", func(t *testing.T) {
		f, _, ev := handoverFixture(t, "local:abcdefghijklmnop")
		_, err := f.pool.Exec(context.Background(), `INSERT INTO vault_devices(vault_id,device_id,device_pubkey,account_id,added_at_ms,removed_at_ms)
		 VALUES($1::uuid,$2::uuid,$3,$4::uuid,$5,$6)`, f.vaultID, f.anchorDeviceID, []byte(f.anchorPub), f.ownerAcct, ev.HLC.PhysicalMS-100, ev.HLC.PhysicalMS-1)
		if err != nil {
			t.Fatal(err)
		}
		if res := f.pushAs(t, f.ownerAcct, ev); len(res.Rejected) != 1 {
			t.Fatalf("removed device transferred: %+v", res)
		}
	})
}
