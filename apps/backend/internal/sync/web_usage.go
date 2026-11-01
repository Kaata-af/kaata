package sync

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

type webPushUsage struct {
	accountID string
	installID string
	events    []PushEvent
}

// Browser usage comes from accepted actions, not presence or a caller-supplied
// transport ID. Native installations keep reporting their own mobile deltas.
// Lock in account -> install -> credential -> vault order, as sign-in/deletion
// and browser profile updates do, so a late request cannot revive a retired or
// rebound browser's activity. A missing binding simply leaves analytics alone.
func lockWebPushUsage(ctx context.Context, tx pgx.Tx, in PushInput) (*webPushUsage, error) {
	c := in.Session
	if len(in.Events) == 0 || c == nil || c.AccountID != in.AccountID || c.InstallID != in.DeviceID {
		return nil, nil
	}
	var id string
	err := tx.QueryRow(ctx, `SELECT a.id::text FROM accounts a
		WHERE a.id=$1::uuid AND a.disabled_at IS NULL AND a.pending_delete_at IS NULL
		AND EXISTS (SELECT 1 FROM installs i WHERE i.install_id=$2::uuid
		  AND i.account_id=a.id AND i.platform='web' AND i.account_deleted_at IS NULL)
		FOR SHARE`, c.AccountID, c.InstallID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("lock browser usage account: %w", err)
	}
	err = tx.QueryRow(ctx, `SELECT install_id::text FROM installs
		WHERE install_id=$1::uuid AND account_id=$2::uuid
		AND platform='web' AND account_deleted_at IS NULL FOR UPDATE`, c.InstallID, c.AccountID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("lock browser usage install: %w", err)
	}
	err = tx.QueryRow(ctx, `SELECT install_id::text FROM auth_credentials
		WHERE install_id=$1::uuid AND provider=$2 AND COALESCE(account_id,$3::uuid)=$3::uuid
		AND session_epoch=$4 AND provider_sub=$5 AND revoked_at IS NULL FOR SHARE`, c.InstallID, c.Provider, c.AccountID, c.Epoch, c.ProviderSub).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("lock browser usage credential: %w", err)
	}
	return &webPushUsage{accountID: c.AccountID, installID: c.InstallID}, nil
}

// This runs only with freshly inserted events, in the event transaction. An
// exact retry, rejected write or native event therefore cannot increment web
// usage. Proof must match this browser's registered key; relayed authors and
// unverified actor/device labels are never attributed to the current browser.
func recordWebPushUsage(ctx context.Context, tx pgx.Tx, vaultID string, usage *webPushUsage) error {
	if usage == nil || len(usage.events) == 0 {
		return nil
	}
	var key []byte
	err := tx.QueryRow(ctx, `SELECT device_pubkey FROM vault_devices
		WHERE vault_id=$1::uuid AND device_id=$2::uuid AND account_id=$3::uuid
		AND removed_at_ms IS NULL`, vaultID, usage.installID, usage.accountID).Scan(&key)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read browser usage device: %w", err)
	}
	var entries, customers int64
	active := false
	for _, ev := range usage.events {
		if ev.HLC.DeviceID != usage.installID || ev.ActorAccountID == nil || *ev.ActorAccountID != usage.accountID {
			continue
		}
		pub, err := base64.StdEncoding.DecodeString(derefStr(ev.SignerDevicePubkeyB64))
		if err != nil || len(pub) != ed25519.PublicKeySize || !bytes.Equal(pub, key) {
			continue
		}
		sig, err := base64.StdEncoding.DecodeString(derefStr(ev.EventSigB64))
		if err != nil || len(sig) != ed25519.SignatureSize {
			continue
		}
		signable, err := canonicalSignableEvent(vaultID, &ev)
		if err != nil || !ed25519.Verify(ed25519.PublicKey(pub), signable, sig) {
			continue
		}
		switch ev.EventType {
		case EventAccountBound, EventVaultDeviceAdded, EventVaultDeviceRemoved:
			continue // Device/bootstrap bookkeeping is not a user action.
		case EventEntryCreated:
			entries++
		case EventPersonAdded:
			customers++
		}
		active = true
	}
	if !active {
		return nil
	}
	_, err = tx.Exec(ctx, `UPDATE installs SET last_activity_at=NOW(),
		usage_entries_created=usage_entries_created+$2,
		usage_customers_added=usage_customers_added+$3
		WHERE install_id=$1::uuid`, usage.installID, entries, customers)
	if err != nil {
		return fmt.Errorf("record browser action usage: %w", err)
	}
	return nil
}
