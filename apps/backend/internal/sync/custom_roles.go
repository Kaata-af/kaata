package sync

import (
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/matee/kaata-backend/internal/httpx"
	"github.com/matee/kaata-backend/internal/rolepolicy"
)

// Credit configuration routes hold the credit lock, also taken by custom
// role mutations, so a save cannot race a newly committed restriction.
func allowVaultSettings(w http.ResponseWriter, r *http.Request, tx pgx.Tx, vaultID, accountID, role string) bool {
	if role == "owner" {
		return true
	}
	if role == "manager" {
		allowed, err := rolepolicy.Allows(r.Context(), tx, vaultID, accountID, rolepolicy.VaultSettings)
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "storage unavailable")
			return false
		}
		if allowed {
			return true
		}
	}
	httpx.ErrorCode(w, http.StatusForbidden, "insufficient_role", "permission to change Kaata settings required")
	return false
}

// These actions narrow a current membership's preset. Their rank and
// historical signer checks still apply independently to every event.
func customRolePermission(eventType string) string {
	switch eventType {
	case EventEntryCreated:
		return rolepolicy.EntryCreate
	case EventEntryAmended, EventEntrySettled:
		return rolepolicy.EntryAmend
	case EventEntryDeleted:
		return rolepolicy.EntryDelete
	case EventPersonAdded:
		return rolepolicy.PersonAdd
	case EventPersonRenamed, EventPersonPhoneChanged, EventPersonDefaultCurrencySet, EventPersonNoteSet,
		EventPersonArchived, EventPersonUnarchived:
		return rolepolicy.PersonEdit
	case EventGroupCreated, EventGroupRenamed, EventGroupArchived, EventPersonGroupSet:
		return rolepolicy.GroupManage
	case EventTallyNoteAdded:
		return rolepolicy.TallyNoteAdd
	case EventTallyNoteRemoved:
		return rolepolicy.TallyNoteRemove
	case EventShopProfileUpdated, EventVaultSettingSet:
		return rolepolicy.VaultSettings
	case EventVaultMemberAdded, EventVaultMemberRoleChng, EventVaultMemberRemoved:
		return rolepolicy.VaultMembers
	default:
		return ""
	}
}
