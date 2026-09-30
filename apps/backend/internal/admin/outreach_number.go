package admin

// Number plausibility (2026-09-30): every outreach phone is described with
// libphonenumber's numbering-plan metadata — the nyaruka Go port, pinned in
// go.mod — so the prospect queue can pass over a number that cannot ring
// before the operator opens a chat for it. Plausibility is NOT WhatsApp
// presence: an invalid number is a numbering-plan fact, "not on WhatsApp" is
// an outcome only the operator records (status no_whatsapp). Pure; the table
// test in outreach_test.go pins the fixture numbers against this exact
// metadata version.

import "github.com/nyaruka/phonenumbers"

// OutreachNumber is the per-contact numbering-plan description on the wire.
type OutreachNumber struct {
	Valid    bool   `json:"valid"`    // phonenumbers.IsValidNumber
	Possible bool   `json:"possible"` // phonenumbers.IsPossibleNumber (length only)
	Type     string `json:"type"`     // mobile | fixed_line | fixed_line_or_mobile | voip | toll_free | premium_rate | shared_cost | personal | pager | uan | voicemail | unknown
	Region   string `json:"region"`   // ISO 3166-1 alpha-2; "" when unknown or non-geographic (+800 …)
	National string `json:"national"` // phonenumbers.Format(n, NATIONAL); "" when unparsable
}

var outreachNumberTypes = map[phonenumbers.PhoneNumberType]string{
	phonenumbers.FIXED_LINE:           "fixed_line",
	phonenumbers.MOBILE:               "mobile",
	phonenumbers.FIXED_LINE_OR_MOBILE: "fixed_line_or_mobile",
	phonenumbers.TOLL_FREE:            "toll_free",
	phonenumbers.PREMIUM_RATE:         "premium_rate",
	phonenumbers.SHARED_COST:          "shared_cost",
	phonenumbers.VOIP:                 "voip",
	phonenumbers.PERSONAL_NUMBER:      "personal",
	phonenumbers.PAGER:                "pager",
	phonenumbers.UAN:                  "uan",
	phonenumbers.VOICEMAIL:            "voicemail",
}

// describeOutreachNumber parses a normalized "+digits" phone in international
// form with no default region: the "+" is the only country evidence there is.
// A parse failure — "+000…", a "00"-trunk-prefixed key — is reported as an
// invalid, impossible, unknown number rather than an error, because the page
// still has to list such a number so the operator can see why it will never
// be opened. libphonenumber's "001" region is not a country — it marks the
// non-geographic codes (+800 freephone, +882 / +883 networks …) — so it is
// reported as "" (2026-09-30), like an unknown region, and the page never
// shows "001" as a country.
func describeOutreachNumber(phone string) OutreachNumber {
	n, err := phonenumbers.Parse(phone, "")
	if err != nil || n == nil {
		return OutreachNumber{Type: "unknown"}
	}
	typ, ok := outreachNumberTypes[phonenumbers.GetNumberType(n)]
	if !ok {
		typ = "unknown"
	}
	region := phonenumbers.GetRegionCodeForNumber(n)
	if region == phonenumbers.REGION_CODE_FOR_NON_GEO_ENTITY {
		region = ""
	}
	return OutreachNumber{
		Valid:    phonenumbers.IsValidNumber(n),
		Possible: phonenumbers.IsPossibleNumber(n),
		Type:     typ,
		Region:   region,
		National: phonenumbers.Format(n, phonenumbers.NATIONAL),
	}
}
