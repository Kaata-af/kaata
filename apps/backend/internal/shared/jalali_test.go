package shared

import (
	"testing"
	"time"
)

// The bill date is implemented four times across three runtimes (see the
// header of apps/mobile/lib/__dev__/jalali-selftest.ts). They render the same
// document through different pipes, so they must agree character for
// character: a customer's WhatsApp link preview (this Go path) and the page it
// opens (templates.go's inline JS) sit side by side on one screen.
//
// These vectors are THE SAME LIST as the TypeScript selftest's GOLDEN array.
// Change one, change both — a diff here that isn't mirrored there is the drift
// this test exists to make loud.
//
// The Gregorian anchors are externally checkable, not merely recorded from the
// implementation: Nowruz (1 Hamal) 1405 is 21 March 2026.
func TestBillDateGoldenVectors(t *testing.T) {
	// Noon Kabul: billDate pins to +04:30, and noon keeps every case clear of
	// a day boundary regardless of where the test runs.
	at := func(y int, m time.Month, d int) int64 {
		return time.Date(y, m, d, 12, 0, 0, 0, kabulTZ).UnixMilli()
	}

	cases := []struct {
		name     string
		ms       int64
		jalaliEn string
		jalaliFa string
		gregEn   string
		gregFa   string
	}{
		{
			name:     "mid-summer",
			ms:       at(2026, time.August, 5),
			jalaliEn: "14 Asad 1405",
			jalaliFa: "۱۴ اسد ۱۴۰۵",
			gregEn:   "5 Aug 2026",
			gregFa:   "۵ اگست ۲۰۲۶",
		},
		{
			name:     "Nowruz 1405",
			ms:       at(2026, time.March, 21),
			jalaliEn: "1 Hamal 1405",
			jalaliFa: "۱ حمل ۱۴۰۵",
			gregEn:   "21 Mar 2026",
			gregFa:   "۲۱ مارچ ۲۰۲۶",
		},
		{
			name:     "Gregorian NYE",
			ms:       at(2026, time.December, 31),
			jalaliEn: "10 Jadi 1405",
			jalaliFa: "۱۰ جدی ۱۴۰۵",
			gregEn:   "31 Dec 2026",
			gregFa:   "۳۱ دسمبر ۲۰۲۶",
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			// billDate(ms, rtl, jalali): rtl picks the SCRIPT, jalali the CALENDAR.
			if got := billDate(c.ms, false, true); got != c.jalaliEn {
				t.Errorf("jalali+en: got %q, want %q", got, c.jalaliEn)
			}
			if got := billDate(c.ms, true, true); got != c.jalaliFa {
				t.Errorf("jalali+fa: got %q, want %q", got, c.jalaliFa)
			}
			if got := billDate(c.ms, false, false); got != c.gregEn {
				t.Errorf("gregorian+en: got %q, want %q", got, c.gregEn)
			}
			if got := billDate(c.ms, true, false); got != c.gregFa {
				t.Errorf("gregorian+fa: got %q, want %q", got, c.gregFa)
			}
		})
	}
}

func TestBillDateRejectsUnusableTimestamp(t *testing.T) {
	for _, ms := range []int64{0, -1} {
		if got := billDate(ms, true, true); got != "" {
			t.Errorf("billDate(%d) = %q, want empty", ms, got)
		}
	}
}

// resolveCalendar is what makes the calendar setting backward compatible.
// Bills cut before it shipped carry no `calendar` field and MUST keep
// rendering exactly as they did — which was "Solar Hijri iff the message
// language was Persian".
func TestResolveCalendarFallsBackToLanguage(t *testing.T) {
	cases := []struct {
		calendar string
		rtl      bool
		want     bool
		why      string
	}{
		{"jalali", false, true, "explicit choice wins over an English bill"},
		{"gregorian", true, false, "explicit choice wins over a Dari bill"},
		{"", true, true, "absent + Dari → the pre-setting behaviour"},
		{"", false, false, "absent + English → the pre-setting behaviour"},
		{"nonsense", true, true, "unknown value is treated as absent, not trusted"},
		{"nonsense", false, false, "unknown value is treated as absent, not trusted"},
	}
	for _, c := range cases {
		if got := resolveCalendar(c.calendar, c.rtl); got != c.want {
			t.Errorf("resolveCalendar(%q, %v) = %v, want %v — %s",
				c.calendar, c.rtl, got, c.want, c.why)
		}
	}
}
