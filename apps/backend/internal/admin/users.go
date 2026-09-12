package admin

import (
	"context"
	"encoding/json"
	"time"

	"github.com/jackc/pgx/v5"
)

// Operator user drill-down: who's actually using kaata. For each signed-in
// account we surface their identity (Google name + email), their kaatas (names,
// role, members) and per-kaata activity COUNTS (tallies, customers) — but NEVER
// the tally contents themselves (Matee: "just not the tallies, but number of
// tallies of each kaata should be shown"). The shopkeeper's ledger name + phone
// come from the latest server snapshot (only present for backed-up vaults);
// everything else is structured-table data. Operator's own accounts are
// excluded via the same OPERATOR_ACCOUNT_IDS allowlist as the stats.

type KaataMember struct {
	Name  string `json:"name"`
	Email string `json:"email"`
	Role  string `json:"role"`
}

type UserKaata struct {
	VaultID       string        `json:"vault_id"`
	Name          string        `json:"name"`
	Role          string        `json:"role"`
	Archived      bool          `json:"archived"`
	MemberCount   int           `json:"member_count"`
	TallyCount    int64         `json:"tally_count"`
	CustomerCount int64         `json:"customer_count"`
	Members       []KaataMember `json:"members"`
}

type UserRow struct {
	AccountID   string `json:"account_id"`
	Name        string `json:"name"`
	Email       string `json:"email"`
	Locale      string `json:"locale"`
	CreatedAt   string `json:"created_at"`
	LastLoginAt string `json:"last_login_at"`
	// LastSeen = most recent check-in across the account's installs (just opening
	// the app updates it — no task needed). Empty if the account has no install.
	LastSeen string `json:"last_seen"`
	// LedgerName / LedgerPhone come from the self user in the latest snapshot of
	// a vault this account owns — the name/phone the shopkeeper entered in-app.
	// Empty when the account has no backed-up vault (e.g. never synced).
	LedgerName  string `json:"ledger_name"`
	LedgerPhone string `json:"ledger_phone"`
	// ShopName comes from the latest install's check-in-reported shop profile
	// (snapshots don't carry it). Empty when the device never reported one.
	ShopName string `json:"shop_name"`
	// Device/telemetry fields, folded in from the account's installs. Platform /
	// AppVersion / Source come from the account's MOST RECENT install; InstalledAt
	// is the earliest, LastActivityAt the latest real usage, HasOnboarded true if
	// any install onboarded, InstallCount how many devices/reinstalls.
	Platform    string `json:"platform"`
	AppVersion  string `json:"app_version"`
	InstalledAt string `json:"installed_at"`
	// FirstSeen = earliest first_seen_at across the account's installs. Mirrors
	// InstallRow.FirstSeen so the dashboard can date an account the same way it
	// dates an install. Needed because InstalledAt is DEVICE-supplied and
	// optional (checkin.Request.InstalledAtUnixMS is a *int64) — it is empty for
	// every install that predates the field or never sent it, while first_seen_at
	// is NOT NULL DEFAULT NOW(). Consumers should read
	// `installed_at || first_seen`, which is the same COALESCE the install series
	// in service.go uses; without it a date filter silently drops those rows.
	FirstSeen      string      `json:"first_seen"`
	LastActivityAt string      `json:"last_activity_at"`
	HasOnboarded   bool        `json:"has_onboarded"`
	Source         string      `json:"source"`
	InstallCount   int         `json:"install_count"`
	Kaatas         []UserKaata `json:"kaatas"`
}

// InstallRow is a device with no known account binding. We have
// install-level telemetry plus the shopkeeper's OWN self profile (name / phone /
// shop, reported on check-in — migration 028) so the dashboard can show who's
// using the app even without sign-in. The customer ledger still never leaves the
// device. This is the "users without the ones signing in" view: everything we
// legitimately know about an anonymous install, and nothing we don't.
type InstallRow struct {
	InstallID string `json:"install_id"`
	// SelfName / SelfPhone / ShopName: the shopkeeper's OWN profile, reported on
	// check-in (migration 028). Present even for installs that never signed in —
	// this is how the dashboard now shows who's using the app regardless of
	// sign-in. NEVER customer data; the customer ledger still stays on-device.
	SelfName       string `json:"self_name"`
	SelfPhone      string `json:"self_phone"`
	ShopName       string `json:"shop_name"`
	Platform       string `json:"platform"`
	AppVersion     string `json:"app_version"`
	Locale         string `json:"locale"`
	InstalledAt    string `json:"installed_at"`
	FirstSeen      string `json:"first_seen"`
	LastSeen       string `json:"last_seen"`
	LastActivityAt string `json:"last_activity_at"`
	HasOnboarded   bool   `json:"has_onboarded"`
	Source         string `json:"source"`
	Attribution    string `json:"attribution_method"`
	UsageEntries   int64  `json:"usage_entries"`
	UsageCustomers int64  `json:"usage_customers"`
	UsageShares    int64  `json:"usage_shares"`
	CheckInCount   int    `json:"check_in_count"`
}

type UsersResult struct {
	Users []UserRow `json:"users"`
	// AnonymousInstalls = devices with no unambiguous account binding. Telemetry plus the
	// shopkeeper's own self profile reported on check-in (migration 028).
	AnonymousInstalls []InstallRow `json:"anonymous_installs"`
	SignedInCount     int          `json:"signed_in_count"`
	AnonymousCount    int          `json:"anonymous_count"`
	TotalInstalls     int          `json:"total_installs"`
	GeneratedAt       string       `json:"generated_at"`
}

// snapDoc is the minimal slice of vault_snapshots.snapshot we parse to recover
// the shopkeeper's in-app name + phone (the self user).
type snapDoc struct {
	Users []struct {
		PhoneE164   *string `json:"phone_e164"`
		DisplayName string  `json:"display_name"`
		IsLocalSelf int     `json:"is_local_self"`
		AccountID   *string `json:"account_id"`
	} `json:"users"`
}

// Migration 006 populated auth_credentials.account_id without backfilling
// installs.account_id. Authenticated check-in now repairs that link, but older
// dormant installations can still have only the credential as evidence.
// Resolve that proven link for this report without rewriting installation or
// activity history. An explicit install binding wins; conflicting active
// credential accounts remain unlinked. Names and self-reported phones are not
// identity evidence. Every install-dependent query must use this same CTE.
const userReportInstalls = `
	WITH report_installs AS (
		SELECT i.*, COALESCE(i.account_id, (
			SELECT (array_agg(DISTINCT ac.account_id))[1]
			FROM auth_credentials ac
			WHERE ac.install_id = i.install_id AND ac.revoked_at IS NULL
			HAVING COUNT(DISTINCT ac.account_id) = 1
		)) AS resolved_account_id
		FROM installs i
	)
`

func (s *Service) GetUsers(ctx context.Context) (UsersResult, error) {
	out := UsersResult{Users: []UserRow{}}
	// Account linkage may change while this multi-query report is loading.
	// Read all sections from one snapshot so an install cannot disappear
	// between the account and anonymous lists (or appear in both on unlink).
	// This groups only proven account links; matching names/phones do not prove
	// that an older installation belongs to a signed-in account.
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{
		IsoLevel:   pgx.RepeatableRead,
		AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return out, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// 1. Accounts = the app's signed-in users (operator excluded).
	byID := map[string]*UserRow{}
	order := []string{}
	rows, err := tx.Query(ctx, userReportInstalls+`
		, account_last_seen AS (
			SELECT resolved_account_id, MAX(last_seen_at) AS last_seen
			FROM report_installs
			WHERE resolved_account_id IS NOT NULL
			GROUP BY resolved_account_id
		)
		SELECT a.id::text, COALESCE(a.name, ''), a.email, COALESCE(a.locale, ''),
		       a.created_at, a.last_login_at, als.last_seen
		FROM accounts a
		LEFT JOIN account_last_seen als ON als.resolved_account_id = a.id
		WHERE a.id::text <> ALL($1::text[])
		ORDER BY last_seen DESC NULLS LAST, a.last_login_at DESC
		LIMIT 1000
	`, s.operatorAccountIDs)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var u UserRow
		var created, lastLogin time.Time
		var lastSeen *time.Time
		if err := rows.Scan(&u.AccountID, &u.Name, &u.Email, &u.Locale, &created, &lastLogin, &lastSeen); err != nil {
			rows.Close()
			return out, err
		}
		u.CreatedAt = created.UTC().Format(time.RFC3339)
		u.LastLoginAt = lastLogin.UTC().Format(time.RFC3339)
		if lastSeen != nil {
			u.LastSeen = lastSeen.UTC().Format(time.RFC3339)
		}
		u.Kaatas = []UserKaata{}
		byID[u.AccountID] = &u
		order = append(order, u.AccountID)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return out, err
	}
	// 1b. Fold device telemetry (platform, app version, install timeline, source)
	//     from the installs table into each signed-in account.
	if err := s.enrichInstallTelemetry(ctx, tx, byID); err != nil {
		return out, err
	}

	// 2. Per-vault members (name/email/role) — built once, attached to every
	//    member's kaata entry below.
	members := map[string][]KaataMember{}
	mrows, err := tx.Query(ctx, `
		SELECT vm.vault_id::text, COALESCE(a.name, ''), a.email, vm.role
		FROM vault_members vm
		JOIN accounts a ON a.id = vm.account_id
		WHERE vm.accepted_at IS NOT NULL AND vm.revoked_at IS NULL
		  AND vm.account_id IS NOT NULL
	`)
	if err != nil {
		return out, err
	}
	for mrows.Next() {
		var vid string
		var m KaataMember
		if err := mrows.Scan(&vid, &m.Name, &m.Email, &m.Role); err != nil {
			mrows.Close()
			return out, err
		}
		members[vid] = append(members[vid], m)
	}
	mrows.Close()
	if err := mrows.Err(); err != nil {
		return out, err
	}

	// 3. Per-vault activity COUNTS from the event log (never the contents). Net
	//    tallies = created - deleted; net customers = added - archived.
	type counts struct{ tallies, customers int64 }
	vcounts := map[string]counts{}
	crows, err := tx.Query(ctx, `
		SELECT vault_id::text,
		  COUNT(*) FILTER (WHERE event_type = 'entry_created')
		    - COUNT(*) FILTER (WHERE event_type = 'entry_deleted')  AS tallies,
		  COUNT(*) FILTER (WHERE event_type = 'person_added')
		    - COUNT(*) FILTER (WHERE event_type = 'person_archived') AS customers
		FROM events
		GROUP BY vault_id
	`)
	if err != nil {
		return out, err
	}
	for crows.Next() {
		var vid string
		var c counts
		if err := crows.Scan(&vid, &c.tallies, &c.customers); err != nil {
			crows.Close()
			return out, err
		}
		vcounts[vid] = c
	}
	crows.Close()
	if err := crows.Err(); err != nil {
		return out, err
	}

	// 4. Memberships → attach each kaata to its member account(s). A shared vault
	//    legitimately appears under each member's list.
	krows, err := tx.Query(ctx, `
		SELECT vm.account_id::text, v.vault_id::text, v.name, vm.role,
		       (v.archived_at IS NOT NULL) AS archived
		FROM vault_members vm
		JOIN vaults v ON v.vault_id = vm.vault_id
		WHERE vm.accepted_at IS NOT NULL AND vm.revoked_at IS NULL
		  AND vm.account_id IS NOT NULL
		ORDER BY v.name
	`)
	if err != nil {
		return out, err
	}
	for krows.Next() {
		var acct string
		var k UserKaata
		if err := krows.Scan(&acct, &k.VaultID, &k.Name, &k.Role, &k.Archived); err != nil {
			krows.Close()
			return out, err
		}
		u := byID[acct]
		if u == nil {
			continue // operator-excluded or unknown account
		}
		k.Members = members[k.VaultID]
		if k.Members == nil {
			k.Members = []KaataMember{}
		}
		k.MemberCount = len(k.Members)
		if c, ok := vcounts[k.VaultID]; ok {
			if c.tallies < 0 {
				c.tallies = 0
			}
			if c.customers < 0 {
				c.customers = 0
			}
			k.TallyCount = c.tallies
			k.CustomerCount = c.customers
		}
		u.Kaatas = append(u.Kaatas, k)
	}
	krows.Close()
	if err := krows.Err(); err != nil {
		return out, err
	}

	// 5. Best-effort: recover each shopkeeper's in-app name + phone from the
	//    latest snapshot's self user. Missing/unparseable snapshots just leave
	//    the fields blank — never an error (these are backed-up vaults only).
	if err := s.enrichLedgerIdentity(ctx, tx, byID); err != nil {
		return out, err
	}

	for _, id := range order {
		out.Users = append(out.Users, *byID[id])
	}

	// 7. Installs with no proven account link. Telemetry plus the self profile (name/phone/shop)
	//    the device reports on check-in regardless of sign-in.
	out.AnonymousInstalls, err = s.fetchAnonymousInstalls(ctx, tx)
	if err != nil {
		return out, err
	}

	out.SignedInCount = len(out.Users)
	out.AnonymousCount = len(out.AnonymousInstalls)
	signedInInstalls := 0
	for i := range out.Users {
		signedInInstalls += out.Users[i].InstallCount
	}
	out.TotalInstalls = signedInInstalls + out.AnonymousCount
	out.GeneratedAt = time.Now().UTC().Format(time.RFC3339)
	if err := tx.Commit(ctx); err != nil {
		return out, err
	}
	return out, nil
}

// enrichInstallTelemetry folds device-level telemetry from the installs table
// into each signed-in account: platform/version/source from the MOST RECENT
// install, and timeline aggregates (install count, first install, last activity,
// onboarded) across all the account's installs. A missing install
// just leaves the fields blank. Operator accounts are already absent from byID,
// so the unfiltered queries below only ever touch shown accounts.
func (s *Service) enrichInstallTelemetry(ctx context.Context, tx pgx.Tx, byID map[string]*UserRow) error {
	if len(byID) == 0 {
		return nil
	}
	// Latest install per account → platform / version / source / locale fallback,
	// plus the self profile (name/phone) the device reports on check-in. The self
	// profile is a FALLBACK only: it fills LedgerName/LedgerPhone for accounts
	// that signed in but never backed up a vault (so no snapshot to read from);
	// the snapshot enrich below overrides it when a backed-up name/phone exists.
	lrows, err := tx.Query(ctx, userReportInstalls+`
		SELECT DISTINCT ON (resolved_account_id) resolved_account_id::text,
		       COALESCE(platform, ''), COALESCE(app_version, ''),
		       COALESCE(source, ''),
		       COALESCE(NULLIF(app_locale, ''), COALESCE(device_locale, '')),
		       COALESCE(self_name, ''), COALESCE(self_phone, ''),
		       COALESCE(shop_name, '')
		FROM report_installs
		WHERE resolved_account_id IS NOT NULL
		ORDER BY resolved_account_id, last_seen_at DESC NULLS LAST
	`)
	if err != nil {
		return err
	}
	for lrows.Next() {
		var acct, platform, ver, source, locale, selfName, selfPhone, shopName string
		if err := lrows.Scan(&acct, &platform, &ver, &source, &locale, &selfName, &selfPhone, &shopName); err != nil {
			lrows.Close()
			return err
		}
		if u := byID[acct]; u != nil {
			u.Platform = platform
			u.AppVersion = ver
			u.Source = source
			if u.Locale == "" {
				u.Locale = locale
			}
			if u.LedgerName == "" {
				u.LedgerName = selfName
			}
			if u.LedgerPhone == "" {
				u.LedgerPhone = selfPhone
			}
			// Installs are the only shop_name source (snapshots don't carry it).
			u.ShopName = shopName
		}
	}
	lrows.Close()
	if err := lrows.Err(); err != nil {
		return err
	}
	// Aggregates per account → install count, first install, last activity, onboarded.
	arows, err := tx.Query(ctx, userReportInstalls+`
		SELECT resolved_account_id::text, COUNT(*),
		       MIN(installed_at), MIN(first_seen_at), MAX(last_activity_at), bool_or(has_onboarded)
		FROM report_installs
		WHERE resolved_account_id IS NOT NULL
		GROUP BY resolved_account_id
	`)
	if err != nil {
		return err
	}
	for arows.Next() {
		var acct string
		var cnt int64
		var firstInstall, firstSeen, lastActivity *time.Time
		var onboarded bool
		if err := arows.Scan(&acct, &cnt, &firstInstall, &firstSeen, &lastActivity, &onboarded); err != nil {
			arows.Close()
			return err
		}
		if u := byID[acct]; u != nil {
			u.InstallCount = int(cnt)
			u.HasOnboarded = onboarded
			if firstInstall != nil {
				u.InstalledAt = firstInstall.UTC().Format(time.RFC3339)
			}
			if firstSeen != nil {
				u.FirstSeen = firstSeen.UTC().Format(time.RFC3339)
			}
			if lastActivity != nil {
				u.LastActivityAt = lastActivity.UTC().Format(time.RFC3339)
			}
		}
	}
	arows.Close()
	if err := arows.Err(); err != nil {
		return err
	}
	return nil
}

// fetchAnonymousInstalls returns installs with no explicit account binding and
// no unique active credential binding. Carries telemetry PLUS the shopkeeper's own
// self profile (self_name/self_phone/shop_name, reported on every check-in
// regardless of sign-in — migration 028) so the operator can identify and
// reach offline-mode users. Never customer ledger data. These rows can't be
// operator-filtered (no account, and installs don't store an IP), so a few of
// the operator's own pre-sign-in test installs may appear here.
func (s *Service) fetchAnonymousInstalls(ctx context.Context, tx pgx.Tx) ([]InstallRow, error) {
	out := []InstallRow{}
	rows, err := tx.Query(ctx, userReportInstalls+`
		SELECT install_id::text, COALESCE(platform, ''), COALESCE(app_version, ''),
		       COALESCE(NULLIF(app_locale, ''), COALESCE(device_locale, '')),
		       installed_at, first_seen_at, last_seen_at, last_activity_at,
		       has_onboarded, COALESCE(source, ''), COALESCE(attribution_method, ''),
		       usage_entries_created, usage_customers_added, usage_shares_sent,
		       check_in_count,
		       COALESCE(self_name, ''), COALESCE(self_phone, ''), COALESCE(shop_name, '')
		FROM report_installs
		WHERE resolved_account_id IS NULL
		ORDER BY last_seen_at DESC NULLS LAST
		LIMIT 1000
	`)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var r InstallRow
		var installedAt, lastActivity *time.Time
		var firstSeen, lastSeen time.Time
		if err := rows.Scan(&r.InstallID, &r.Platform, &r.AppVersion, &r.Locale,
			&installedAt, &firstSeen, &lastSeen, &lastActivity,
			&r.HasOnboarded, &r.Source, &r.Attribution,
			&r.UsageEntries, &r.UsageCustomers, &r.UsageShares, &r.CheckInCount,
			&r.SelfName, &r.SelfPhone, &r.ShopName); err != nil {
			return out, err
		}
		r.FirstSeen = firstSeen.UTC().Format(time.RFC3339)
		r.LastSeen = lastSeen.UTC().Format(time.RFC3339)
		if installedAt != nil {
			r.InstalledAt = installedAt.UTC().Format(time.RFC3339)
		}
		if lastActivity != nil {
			r.LastActivityAt = lastActivity.UTC().Format(time.RFC3339)
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// enrichLedgerIdentity reads the latest snapshot per vault and, for its
// self user, fills the owning account's ledger name + phone. Best-effort.
func (s *Service) enrichLedgerIdentity(ctx context.Context, tx pgx.Tx, byID map[string]*UserRow) error {
	rows, err := tx.Query(ctx, `
		SELECT DISTINCT ON (vault_id) snapshot
		FROM vault_snapshots
		ORDER BY vault_id, up_to_server_seq DESC
	`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var raw []byte
		if err := rows.Scan(&raw); err != nil {
			return err
		}
		var doc snapDoc
		if json.Unmarshal(raw, &doc) != nil {
			continue
		}
		for _, su := range doc.Users {
			if su.IsLocalSelf != 1 || su.AccountID == nil {
				continue
			}
			if u := byID[*su.AccountID]; u != nil {
				// Snapshot is the authoritative backed-up identity — override the
				// per-install self fallback when the snapshot actually carries a
				// value (empty snapshot fields never clobber a good fallback).
				if su.DisplayName != "" {
					u.LedgerName = su.DisplayName
				}
				if su.PhoneE164 != nil && *su.PhoneE164 != "" {
					u.LedgerPhone = *su.PhoneE164
				}
			}
		}
	}
	return rows.Err()
}
