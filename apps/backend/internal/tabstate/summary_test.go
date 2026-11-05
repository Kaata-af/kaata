package tabstate

import (
	"math/big"
	"testing"
)

func number(n int64) *int64 { return &n }

func TestSummaryCarriesSavedPeriodsUntilOpeningIsSaved(t *testing.T) {
	for _, test := range []struct{ status, recorded, confirmed, pending string }{
		{"pending", "130.00", "100.00", "20.00"},
		{"accepted", "150.00", "120.00", "0.00"},
		{"recorded", "150.00", "0.00", "0.00"},
		{"disputed", "130.00", "100.00", "0.00"},
	} {
		t.Run(test.status, func(t *testing.T) {
			periods := []SummaryPeriod{
				{ID: "old", Currency: "AFN", Role: "a", Order: number(1), LinkedAt: number(100), ClosedAt: number(190), Entries: []SummaryEntry{{Minor: big.NewInt(10000), Kind: "entry", Status: "accepted", Seq: 1, OccurredAt: 150}}},
				{ID: "new", Currency: "AFN", Role: "a", Order: number(2), LinkedAt: number(200), Entries: []SummaryEntry{{Minor: big.NewInt(12000), Kind: "opening", Status: test.status, Seq: 1, OccurredAt: 201}}},
			}
			private := []SummaryPrivate{{Currency: "AFN", Minor: big.NewInt(99900), RecordedAt: 50, OccurredAt: 500}, {Currency: "AFN", Minor: big.NewInt(3000), RecordedAt: 250, OccurredAt: 75}}
			got, err := Summarize(periods, private)
			if err != nil || len(got.Balances) != 1 {
				t.Fatalf("summary=%+v error=%v", got, err)
			}
			balance := got.Balances[0]
			if balance.Recorded != test.recorded || balance.Confirmed != test.confirmed || balance.Pending != test.pending || balance.Private != "30.00" || got.LastEntryAt == nil || *got.LastEntryAt != 500 {
				t.Fatalf("summary=%+v", got)
			}
		})
	}
}

func TestSummaryUntouchedInvitationRetainsPrivateSource(t *testing.T) {
	period := SummaryPeriod{ID: "invite", Currency: "USD", Role: "a", Order: number(1), LinkedAt: number(100), Unjoined: true,
		Entries: []SummaryEntry{{Minor: big.NewInt(10005), Kind: "opening", Status: "pending", CreatedBy: "a", Seq: 1, OccurredAt: 200}}}
	private := []SummaryPrivate{{Currency: "USD", Minor: big.NewInt(10005), RecordedAt: 50, OccurredAt: 50}}
	for _, withdrawn := range []bool{false, true} {
		period.Entries[0].Voided = withdrawn
		got, err := Summarize([]SummaryPeriod{period}, private)
		if err != nil || len(got.Balances) != 1 || got.Balances[0].Recorded != "100.05" || got.Balances[0].Pending != "0.00" || got.LastEntryAt == nil || *got.LastEntryAt != 50 {
			t.Fatalf("withdrawn=%v summary=%+v error=%v", withdrawn, got, err)
		}
	}
}

func TestSummarySettlementUsesServerSequenceAndRejectsAmbiguousHistory(t *testing.T) {
	period := SummaryPeriod{ID: "settled", Currency: "AFN", Role: "a", Order: number(1), LinkedAt: number(100), SettledThrough: number(2),
		Entries: []SummaryEntry{{Minor: big.NewInt(100), Kind: "entry", Status: "recorded", Seq: 1, OccurredAt: 120}, {Minor: big.NewInt(-100), Kind: "entry", Status: "recorded", Seq: 2, OccurredAt: 130}}}
	got, err := Summarize([]SummaryPeriod{period}, nil)
	if err != nil || !got.IsSettled {
		t.Fatalf("settled=%+v error=%v", got, err)
	}
	period.Entries = append(period.Entries, SummaryEntry{Minor: big.NewInt(0), Kind: "entry", Status: "recorded", Seq: 3, OccurredAt: 110})
	got, err = Summarize([]SummaryPeriod{period}, nil)
	if err != nil || got.IsSettled {
		t.Fatalf("backdated row did not reopen chapter: %+v error=%v", got, err)
	}
	if _, err := Summarize([]SummaryPeriod{period, period}, nil); err != ErrHistoryUnavailable {
		t.Fatalf("ambiguous order accepted: %v", err)
	}
}

func TestSummaryPrivateDisputesKeepActivityWithoutChangingBalance(t *testing.T) {
	period := SummaryPeriod{ID: "closed-invite", Currency: "AFN", Role: "a", Order: number(1), LinkedAt: number(100), ClosedAt: number(200), Unjoined: true}
	private := []SummaryPrivate{
		{Currency: "AFN", Minor: big.NewInt(100), RecordedAt: 1, OccurredAt: 1, Settled: true},
		{Currency: "AFN", Minor: big.NewInt(-100), RecordedAt: 2, OccurredAt: 2, Settled: true},
		{Currency: "AFN", Minor: big.NewInt(99900), RecordedAt: 3, OccurredAt: 3, Disputed: true},
	}
	got, err := Summarize([]SummaryPeriod{period}, private)
	if err != nil || !got.IsSettled || got.LastEntryAt == nil || *got.LastEntryAt != 3 || got.Balances[0].Recorded != "0.00" {
		t.Fatalf("private summary=%+v error=%v", got, err)
	}
}

func TestSummaryReplacementKeepsPrivateMoneyAndVoidedOpeningRestoresCarry(t *testing.T) {
	old := SummaryPeriod{ID: "old", Currency: "AFN", Role: "a", Order: number(1), LinkedAt: number(100), ClosedAt: number(150), Entries: []SummaryEntry{{Minor: big.NewInt(10000), Kind: "entry", Status: "accepted", Seq: 1, OccurredAt: 100}}}
	latest := SummaryPeriod{ID: "invite", Currency: "AFN", Role: "a", Order: number(2), LinkedAt: number(200), Unjoined: true, Entries: []SummaryEntry{{Minor: big.NewInt(12000), Kind: "opening", Status: "pending", CreatedBy: "a", Seq: 1, OccurredAt: 200}}}
	private := []SummaryPrivate{{Currency: "AFN", Minor: big.NewInt(2000), RecordedAt: 175, OccurredAt: 175}, {Currency: "AFN", Minor: big.NewInt(700), RecordedAt: 250, OccurredAt: 250}}
	got, err := Summarize([]SummaryPeriod{old, latest}, private)
	if err != nil || got.Balances[0].Recorded != "127.00" || got.Balances[0].Pending != "0.00" {
		t.Fatalf("unjoined replacement=%+v error=%v", got, err)
	}
	latest.Unjoined = false
	latest.Entries[0].Status = "accepted"
	latest.Entries[0].Voided = true
	got, err = Summarize([]SummaryPeriod{old, latest}, private)
	if err != nil || got.Balances[0].Recorded != "107.00" || got.Balances[0].Confirmed != "100.00" {
		t.Fatalf("voided replacement=%+v error=%v", got, err)
	}
	latest.Order = number(0)
	if _, err = Summarize([]SummaryPeriod{latest}, nil); err != ErrHistoryUnavailable {
		t.Fatal("invalid explicit legacy order accepted")
	}
}
