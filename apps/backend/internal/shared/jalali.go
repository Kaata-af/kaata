package shared

// Afghan Solar Hijri date formatting for the server-painted OG/meta preview
// line. Port of the mobile app's lib/jalali.ts (the jalaali-js core, MIT,
// Behrang Noruzi Niya) — Go's integer division truncates toward zero exactly
// like the JS Math.trunc the algorithm is calibrated for (do NOT "fix" any
// of it to floor semantics; they differ on negative operands).
//
// The in-page bill-date pill is formatted client-side by the inline script's
// fmtDate (viewer's clock); this Go path exists only because the OG
// description is consumed by link scrapers that never run JS.

import (
	"strconv"
	"strings"
	"time"
)

var afghanMonths = [12]string{
	"حمل", "ثور", "جوزا", "سرطان", "اسد", "سنبله",
	"میزان", "عقرب", "قوس", "جدی", "دلو", "حوت",
}

// Latin transliteration of the same twelve months, for Solar Hijri dates on
// an English bill. Mirrors AFGHAN_MONTHS_LATIN in the app's lib/jalali.ts.
var afghanMonthsLatin = [12]string{
	"Hamal", "Sawr", "Jawza", "Saratan", "Asad", "Sunbula",
	"Mizan", "Aqrab", "Qaws", "Jadi", "Dalw", "Hut",
}

// Gregorian month names. The Dari set uses the Afghan forms (اگست, جنوری) —
// not the Iranian ones — matching GREGORIAN_MONTHS_FA in lib/jalali.ts.
var gregorianMonthsEn = [12]string{
	"Jan", "Feb", "Mar", "Apr", "May", "Jun",
	"Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
}

var gregorianMonthsFa = [12]string{
	"جنوری", "فبروری", "مارچ", "اپریل", "می", "جون",
	"جولای", "اگست", "سپتمبر", "اکتوبر", "نومبر", "دسمبر",
}

var faDigitRunes = []rune("۰۱۲۳۴۵۶۷۸۹")

func faDigits(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r >= '0' && r <= '9' {
			b.WriteRune(faDigitRunes[r-'0'])
		} else {
			b.WriteRune(r)
		}
	}
	return b.String()
}

var jalBreaks = []int{
	-61, 9, 38, 199, 426, 686, 756, 818, 1111, 1181, 1210, 1635, 2060, 2097,
	2192, 2262, 2324, 2394, 2456, 3178,
}

func jalG2D(gy, gm, gd int) int {
	// gm is 1..12 so gm+9 is positive — Go's % matches the JS mod() here.
	d := (gy+(gm-8)/6+100100)*1461/4 + (153*((gm+9)%12)+2)/5 + gd - 34840408
	d = d - ((gy+100100+(gm-8)/6)/100)*3/4 + 752
	return d
}

// jalCal returns leap + march for a jalali year; ok=false outside the
// algorithm's supported range (the TS port throws there).
func jalCal(jy int) (leap, gy, march int, ok bool) {
	bl := len(jalBreaks)
	gy = jy + 621
	leapJ := -14
	jp := jalBreaks[0]
	if jy < jp || jy >= jalBreaks[bl-1] {
		return 0, 0, 0, false
	}
	jump := 0
	for i := 1; i < bl; i++ {
		jm := jalBreaks[i]
		jump = jm - jp
		if jy < jm {
			break
		}
		leapJ = leapJ + jump/33*8 + (jump%33)/4
		jp = jm
	}
	n := jy - jp
	leapJ = leapJ + n/33*8 + (n%33+3)/4
	if jump%33 == 4 && jump-n == 4 {
		leapJ++
	}
	leapG := gy/4 - ((gy/100+1)*3)/4 - 150
	march = 20 + leapJ - leapG
	if jump-n < 6 {
		n = n - jump + (jump+4)/33*33
	}
	leap = ((n+1)%33 - 1) % 4
	if leap == -1 {
		leap = 4
	}
	return leap, gy, march, true
}

func jalD2G(jdn int) (gy, gm, gd int) {
	j := 4*jdn + 139361631
	j = j + ((4*jdn+183187720)/146097)*3/4*4 - 3908
	i := (j%1461)/4*5 + 308
	gd = (i%153)/5 + 1
	gm = (i/153)%12 + 1
	gy = j/1461 - 100100 + (8-gm)/6
	return gy, gm, gd
}

func jalD2J(jdn int) (jy, jm, jd int, ok bool) {
	gy, _, _ := jalD2G(jdn)
	jy = gy - 621
	leap, _, march, ok := jalCal(jy)
	if !ok {
		return 0, 0, 0, false
	}
	jdn1f := jalG2D(gy, 3, march)
	k := jdn - jdn1f
	if k >= 0 {
		if k <= 185 {
			jm = 1 + k/31
			jd = k%31 + 1
			return jy, jm, jd, true
		}
		k -= 186
	} else {
		jy--
		k += 179
		if leap == 1 {
			k++
		}
	}
	jm = 7 + k/30
	jd = k%30 + 1
	return jy, jm, jd, true
}

// Bills are cut on the shopkeeper's device in Afghanistan; format the issue
// date in Kabul time so a late-evening bill doesn't shift a day when the
// server clock is UTC.
var kabulTZ = time.FixedZone("AFT", 4*3600+30*60)

// billDate renders a bill's issue date for the preview line.
//
// The two axes are now independent, matching the mobile app (lib/jalali.ts):
// `jalali` picks the CALENDAR (which months exist), `rtl` picks the SCRIPT
// (Persian digits + Arabic-script month names, or Latin). Previously one
// boolean drove both, so "Dari language, Gregorian dates" was inexpressible.
// Empty string when ms is unusable.
func billDate(ms int64, rtl bool, jalali bool) string {
	if ms <= 0 {
		return ""
	}
	t := time.UnixMilli(ms).In(kabulTZ)
	num := func(n int) string {
		if rtl {
			return faDigits(strconv.Itoa(n))
		}
		return strconv.Itoa(n)
	}
	if jalali {
		if jy, jm, jd, ok := jalD2J(jalG2D(t.Year(), int(t.Month()), t.Day())); ok {
			month := afghanMonthsLatin[jm-1]
			if rtl {
				month = afghanMonths[jm-1]
			}
			return num(jd) + " " + month + " " + num(jy)
		}
	}
	month := gregorianMonthsEn[int(t.Month())-1]
	if rtl {
		month = gregorianMonthsFa[int(t.Month())-1]
	}
	return num(t.Day()) + " " + month + " " + num(t.Year())
}
