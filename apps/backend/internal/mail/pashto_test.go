package mail

import (
	"strings"
	"testing"
)

func TestPashtoMailTemplates(t *testing.T) {
	for kind := range copyEN {
		m := Render(kind, "ps-AF", "owner@example.com", "482913")
		if m.Subject == "" || strings.Contains(m.Subject, "482913") || !strings.Contains(m.HTML, `<html lang="ps" dir="rtl">`) {
			t.Fatalf("%s: missing Pashto mail or code in subject", kind)
		}
		if m.Subject == copyEN[kind].subject || m.Subject == copyFA[kind].subject {
			t.Fatalf("%s uses another language", kind)
		}
		if kind.HasCode() && (!strings.Contains(m.Text, "⁦482913⁩") || !strings.Contains(m.Text, footerPS)) {
			t.Fatalf("%s code/expiry missing", kind)
		}
	}
}
