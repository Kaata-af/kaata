package sync

// A kaata rename must reach the SHOP PROFILE in this projection, not just the
// vault_settings map.
//
// Why it matters, since the connection is three steps long: this projection is
// what a snapshot is built from, and a snapshot is the entire starting state
// for a reinstalling device and for every new member. Renaming a kaata emits
// only vault_setting_set; nothing in the app emits shop_profile_updated for a
// rename. So before this mirror existed, a snapshot carried the CURRENT name in
// vault.name and the PRE-RENAME name in shop_profile.shop_name. Mobile reads
// COALESCE(shop_profile.shop_name, vaults.name) for the home header, so the
// stale value shadowed the fresh one — and because restore sets the pull cursor
// past the rename event, the mobile applier's own mirror never ran to repair
// it. The wrong name was permanent on that device.
//
// The mobile applier (apps/mobile/lib/projection/vault_settings.ts) has always
// written both tables on a rename. These tests pin the server to the same
// behaviour, including the ordering rules, so the two sides cannot drift.

import (
	"encoding/json"
	"testing"
)

func renameEvent(vaultID, name string, hlc HLC) LedgerEvent {
	payload, err := json.Marshal(vaultSettingSetPayload{Key: "name", Value: name})
	if err != nil {
		panic(err)
	}
	return LedgerEvent{
		EventID:   "rename-" + name + "-" + hlc.DID,
		EventType: EventVaultSettingSet,
		VaultID:   vaultID,
		// The mobile emitter sets target_id to the vault id (the setting is
		// scoped to it), which is what the applier uses when it has to mint a
		// shop profile.
		TargetID: vaultID,
		HLC:      hlc,
		Payload:  payload,
	}
}

func settingEvent(vaultID, key, value string, hlc HLC) LedgerEvent {
	payload, err := json.Marshal(vaultSettingSetPayload{Key: key, Value: value})
	if err != nil {
		panic(err)
	}
	return LedgerEvent{
		EventID:   "setting-" + key + "-" + hlc.DID,
		EventType: EventVaultSettingSet,
		VaultID:   vaultID,
		TargetID:  vaultID,
		HLC:       hlc,
		Payload:   payload,
	}
}

func shopProfileEvent(vaultID, shopName string, hlc HLC) LedgerEvent {
	name := shopName
	payload, err := json.Marshal(shopProfilePayload{
		Changes: shopProfileChanges{ShopName: &name},
	})
	if err != nil {
		panic(err)
	}
	return LedgerEvent{
		EventID:   "shop-" + shopName + "-" + hlc.DID,
		EventType: "shop_profile_updated",
		VaultID:   vaultID,
		TargetID:  vaultID,
		HLC:       hlc,
		Payload:   payload,
	}
}

func shopNameOf(t *testing.T, p Projection) string {
	t.Helper()
	if p.ShopProfile == nil || p.ShopProfile.ShopName == nil {
		return ""
	}
	return *p.ShopProfile.ShopName
}

func TestRenameMirrorsOntoShopProfile(t *testing.T) {
	const vault = "11111111-1111-1111-1111-111111111111"

	t.Run("rename updates an existing shop profile", func(t *testing.T) {
		p, err := ApplyEvents([]LedgerEvent{
			shopProfileEvent(vault, "Matee's kaata", HLC{PMS: 1000, DID: "a"}),
			renameEvent(vault, "Matiullah Saafi", HLC{PMS: 2000, DID: "a"}),
		})
		if err != nil {
			t.Fatalf("ApplyEvents: %v", err)
		}
		if got := shopNameOf(t, p); got != "Matiullah Saafi" {
			t.Fatalf("shop_name = %q, want the renamed value — a snapshot built "+
				"from this projection would hand a restoring device the old name", got)
		}
		// The settings map is still the record of the setting itself.
		if p.VaultSettings["name"] != "Matiullah Saafi" {
			t.Fatalf("vault_settings[name] = %q, want the renamed value", p.VaultSettings["name"])
		}
	})

	t.Run("a non-Latin name round-trips unchanged", func(t *testing.T) {
		// The reported case was an English name replaced by a Persian one. The
		// applier is byte-transparent and must stay that way.
		const persian = "متی الله صافی"
		p, err := ApplyEvents([]LedgerEvent{
			shopProfileEvent(vault, "Matee's kaata", HLC{PMS: 1000, DID: "a"}),
			renameEvent(vault, persian, HLC{PMS: 2000, DID: "a"}),
		})
		if err != nil {
			t.Fatalf("ApplyEvents: %v", err)
		}
		if got := shopNameOf(t, p); got != persian {
			t.Fatalf("shop_name = %q, want %q", got, persian)
		}
	})

	t.Run("no shop profile is invented when none exists", func(t *testing.T) {
		// With no shop profile the mobile COALESCE already falls back to the
		// vault name, which is correct. Minting one here would put state into
		// every snapshot that no event ever asserted.
		p, err := ApplyEvents([]LedgerEvent{
			renameEvent(vault, "Matiullah Saafi", HLC{PMS: 2000, DID: "a"}),
		})
		if err != nil {
			t.Fatalf("ApplyEvents: %v", err)
		}
		if p.ShopProfile != nil {
			t.Fatalf("shop profile was created from a rename alone: %+v", p.ShopProfile)
		}
		if p.VaultSettings["name"] != "Matiullah Saafi" {
			t.Fatalf("vault_settings[name] = %q, want the renamed value", p.VaultSettings["name"])
		}
	})

	t.Run("a newer rename beats an older shop_profile_updated", func(t *testing.T) {
		p, err := ApplyEvents([]LedgerEvent{
			shopProfileEvent(vault, "Old Shop Name", HLC{PMS: 1000, DID: "a"}),
			renameEvent(vault, "Matiullah Saafi", HLC{PMS: 3000, DID: "a"}),
		})
		if err != nil {
			t.Fatalf("ApplyEvents: %v", err)
		}
		if got := shopNameOf(t, p); got != "Matiullah Saafi" {
			t.Fatalf("shop_name = %q, want the newer rename to win", got)
		}
	})

	t.Run("an older rename does NOT clobber a newer shop_profile_updated", func(t *testing.T) {
		// ApplyEvents sorts by HLC, so wire order is irrelevant; what is pinned
		// here is that the rename mirror shares hlcShopName with
		// applyShopProfileUpdated rather than writing unconditionally.
		p, err := ApplyEvents([]LedgerEvent{
			renameEvent(vault, "Stale Rename", HLC{PMS: 1000, DID: "a"}),
			shopProfileEvent(vault, "Deliberate Shop Name", HLC{PMS: 4000, DID: "b"}),
		})
		if err != nil {
			t.Fatalf("ApplyEvents: %v", err)
		}
		if got := shopNameOf(t, p); got != "Deliberate Shop Name" {
			t.Fatalf("shop_name = %q, want the newer shop_profile_updated to win", got)
		}
	})

	t.Run("ties break the same way as every other field", func(t *testing.T) {
		// Equal pms and logical: the device id breaks it, and the comparison is
		// strictly-greater, so the event that sorts LAST wins. "b" > "a".
		p, err := ApplyEvents([]LedgerEvent{
			renameEvent(vault, "From A", HLC{PMS: 5000, DID: "a"}),
			shopProfileEvent(vault, "Existing", HLC{PMS: 1000, DID: "a"}),
			shopProfileEvent(vault, "From B", HLC{PMS: 5000, DID: "b"}),
		})
		if err != nil {
			t.Fatalf("ApplyEvents: %v", err)
		}
		if got := shopNameOf(t, p); got != "From B" {
			t.Fatalf("shop_name = %q, want the higher device id to win the tie", got)
		}
	})

	t.Run("a non-name setting never touches the shop profile", func(t *testing.T) {
		p, err := ApplyEvents([]LedgerEvent{
			shopProfileEvent(vault, "Matee's kaata", HLC{PMS: 1000, DID: "a"}),
			settingEvent(vault, "currency", "USD", HLC{PMS: 2000, DID: "a"}),
			settingEvent(vault, "archived_at", "1700000000000", HLC{PMS: 3000, DID: "a"}),
		})
		if err != nil {
			t.Fatalf("ApplyEvents: %v", err)
		}
		if got := shopNameOf(t, p); got != "Matee's kaata" {
			t.Fatalf("shop_name = %q, want it untouched by a currency/archive setting", got)
		}
		if p.VaultSettings["currency"] != "USD" {
			t.Fatalf("vault_settings[currency] = %q, want USD", p.VaultSettings["currency"])
		}
	})

	t.Run("the last of several renames wins", func(t *testing.T) {
		p, err := ApplyEvents([]LedgerEvent{
			shopProfileEvent(vault, "First", HLC{PMS: 1000, DID: "a"}),
			renameEvent(vault, "Second", HLC{PMS: 2000, DID: "a"}),
			renameEvent(vault, "Third", HLC{PMS: 3000, DID: "a"}),
			renameEvent(vault, "Fourth", HLC{PMS: 4000, DID: "a"}),
		})
		if err != nil {
			t.Fatalf("ApplyEvents: %v", err)
		}
		if got := shopNameOf(t, p); got != "Fourth" {
			t.Fatalf("shop_name = %q, want the latest rename", got)
		}
		if p.ShopProfile.UpdatedAt != 4000 {
			t.Fatalf("updated_at = %d, want the winning event's pms", p.ShopProfile.UpdatedAt)
		}
	})
}
