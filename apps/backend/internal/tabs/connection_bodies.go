package tabs

import (
	"fmt"
	applocale "github.com/matee/kaata-backend/internal/locale"
)

var connectionEventKinds = []string{
	"friend_requested", "friend_accepted", "friend_rejected", "friend_cancelled", "friend_removed",
	"vault_invite_requested", "vault_invite_accepted", "vault_invite_rejected", "vault_invite_cancelled",
	"vault_member_removed", "vault_member_left", "vault_member_role_changed", "vault_member_return_requested", "shared_invite_requested", "shared_invite_cancelled",
}

func connectionNoticeBody(kind, locale, actor, vault, detail string) string {
	locale = applocale.Normalize(locale)
	switch kind {
	case "friend_accepted":
		return friendAcceptedBody(locale, actor)
	case "vault_invite_accepted":
		return vaultInviteAcceptedBody(locale, actor, vault)
	case "vault_invite_rejected":
		return vaultInviteRejectedBody(locale, actor, vault)
	}
	actor, vault = notificationLabel(actor), notificationLabel(vault)
	if actor == "" {
		actor = map[string]string{"en": "Someone", "fa": "یک نفر", "ps": "یو کس"}[locale]
	}
	if vault == "" {
		vault = map[string]string{"en": "a Kaata", "fa": "یک کاتا", "ps": "یوه کاټا"}[locale]
	}
	actor, vault = "\u2068"+actor+"\u2069", "\u2068"+vault+"\u2069"
	// Snapshot labels are rendered only in the recipient's durable history or
	// according to their explicit push-preview choice, never used for routing.
	templates := map[string][3]string{
		"friend_requested":              {"%s sent you a friend request.", "%s برای شما درخواست دوستی فرستاد.", "%s تاسو ته د ملګرتیا غوښتنه واستوله."},
		"friend_rejected":               {"%s declined your friend request.", "%s درخواست دوستی شما را رد کرد.", "%s ستاسو د ملګرتیا غوښتنه رد کړه."},
		"friend_cancelled":              {"%s cancelled their friend request.", "%s درخواست دوستی خود را لغو کرد.", "%s خپله د ملګرتیا غوښتنه لغوه کړه."},
		"friend_removed":                {"%s ended your friendship.", "%s دوستی با شما را پایان داد.", "%s ستاسو ملګرتیا پای ته ورسوله."},
		"vault_invite_requested":        {"%s invited you to %s.", "%s شما را به %s دعوت کرد.", "%s تاسو %s ته راوبلئ."},
		"vault_invite_cancelled":        {"%s cancelled your invitation to %s.", "%s دعوت شما به %s را لغو کرد.", "%s %s ته ستاسو بلنه لغوه کړه."},
		"vault_member_removed":          {"%s removed your access to %s.", "%s دسترسی شما به %s را برداشت.", "%s %s ته ستاسو لاسرسی لرې کړ."},
		"vault_member_left":             {"%s left %s.", "%s از %s خارج شد.", "%s له %s څخه ووت."},
		"vault_member_role_changed":     {"%s changed your role in %s.", "%s نقش شما را در %s تغییر داد.", "%s په %s کې ستاسو دنده بدله کړه."},
		"vault_member_return_requested": {"%s is ready to return to %s. Restore their access in Members.", "%s آمادهٔ بازگشت به %s است. دسترسی او را در بخش اعضا برگردانید.", "%s بېرته %s ته د راتلو لپاره چمتو دی. د غړو په برخه کې یې لاسرسی بېرته ورکړئ."},
		"shared_invite_requested":       {"%s invited you to a shared account.", "%s شما را به یک حساب مشترک دعوت کرد.", "%s تاسو ګډ حساب ته راوبلئ."},
		"shared_invite_cancelled":       {"%s cancelled their shared account invitation.", "%s دعوت حساب مشترک خود را لغو کرد.", "%s د ګډ حساب بلنه لغوه کړه."},
	}
	forms, ok := templates[kind]
	if !ok {
		return pushBodyFor("updated", locale, false)
	}
	index := 0
	if locale == "fa" {
		index = 1
	}
	if locale == "ps" {
		index = 2
	}
	if kind == "vault_invite_requested" || kind == "vault_invite_cancelled" || kind == "vault_member_removed" || kind == "vault_member_left" || kind == "vault_member_role_changed" || kind == "vault_member_return_requested" {
		return fmt.Sprintf(forms[index], actor, vault)
	}
	return fmt.Sprintf(forms[index], actor)
}

func tabLifecycleBody(kind, locale, actor string) string {
	locale = applocale.Normalize(locale)
	actor = notificationLabel(actor)
	if actor != "" {
		actor = "\u2068" + actor + "\u2069"
		if kind == "settled" {
			switch locale {
			case "fa":
				return actor + " این حساب مشترک را تسویه کرد."
			case "ps":
				return actor + " دا ګډ حساب تصفیه کړ."
			default:
				return actor + " marked this shared account settled."
			}
		}
		switch locale {
		case "fa":
			return actor + " اشتراک این حساب را پایان داد. ثبت‌های قبلی محفوظ است."
		case "ps":
			return actor + " د دې حساب شریکول پای ته ورسول. پخواني ثبتونه خوندي دي."
		default:
			return actor + " stopped sharing this account. Existing records are kept."
		}
	}
	if kind == "settled" {
		switch locale {
		case "fa":
			return "حساب مشترک تسویه شد."
		case "ps":
			return "ګډ حساب تصفیه شو."
		default:
			return "The shared account was marked settled."
		}
	}
	switch locale {
	case "fa":
		return "اشتراک این حساب پایان یافت. ثبت‌های قبلی محفوظ است."
	case "ps":
		return "د دې حساب شریکول پای ته ورسېدل. پخواني ثبتونه خوندي دي."
	default:
		return "Sharing ended for this account. Existing records are kept."
	}
}
