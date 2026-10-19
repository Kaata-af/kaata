package locale

import "testing"

func TestNormalizeAndNegotiate(t *testing.T) {
	for tag, want := range map[string]string{" PS-af ": "ps", "prs-AF": "fa", "FA_ir": "fa", "fr": "en", "psuedo": "en"} {
		if got := Normalize(tag); got != want {
			t.Errorf("Normalize(%q) = %q, want %q", tag, got, want)
		}
	}
	for header, want := range map[string]string{
		"": "en", "ps-AF,fa;q=0.8,en;q=0.7": "ps", "prs-AF,en;q=0.8": "fa",
		"ps;q=0.2,en;q=0.9": "en", "fa;q=0,ps;q=0.5": "ps", "de,ps;q=0.8": "ps",
		"fa;q=invalid,ps;q=0.5": "ps", "ps;q=0,*;q=0.5": "en", "ps;q=0.8,fa;q=0.8": "ps",
	} {
		if got := FromAcceptLanguage(header); got != want {
			t.Errorf("FromAcceptLanguage(%q) = %q, want %q", header, got, want)
		}
	}
}
