package tabs

// Invitation results describe connecting the account, not accepting an amount.
// They apply equally to review and notification-only shared accounts.
func sharedInvitationResultBody(kind, locale string) string {
	if kind == "invitation_accepted" {
		switch locale {
		case "fa":
			return "دعوت شما به حساب مشترک پذیرفته شد."
		case "ps":
			return "ګډ حساب ته ستاسو بلنه ومنل شوه."
		default:
			return "Your shared account invitation was accepted."
		}
	}
	switch locale {
	case "fa":
		return "دعوت شما به حساب مشترک رد شد."
	case "ps":
		return "ګډ حساب ته ستاسو بلنه رد شوه."
	default:
		return "Your shared account invitation was declined."
	}
}
