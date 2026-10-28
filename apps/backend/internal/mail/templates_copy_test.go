package mail

import (
	"strings"
	"testing"

	"golang.org/x/net/html"
)

func TestCodeEmailsHaveOneCopyableValue(t *testing.T) {
	for lang, hint := range map[string]string{"en": copyHintEN, "fa": copyHintFA, "ps": copyHintPS} {
		for _, kind := range []Kind{KindSignupCode, KindResetCode, KindSetupCode} {
			t.Run(lang+"/"+string(kind), func(t *testing.T) {
				const code = "001234"
				m := Render(kind, lang, "owner@example.com", code)
				root, err := html.Parse(strings.NewReader(m.HTML))
				if err != nil {
					t.Fatal(err)
				}
				var targets []*html.Node
				var walk func(*html.Node)
				walk = func(n *html.Node) {
					if n.Type == html.ElementNode {
						switch n.Data {
						case "code":
							targets = append(targets, n)
						case "input", "textarea", "button", "form", "script":
							t.Fatalf("code mail must not depend on an interactive %s element", n.Data)
						}
						for _, attr := range n.Attr {
							if strings.HasPrefix(attr.Key, "on") || strings.Contains(attr.Val, code) {
								t.Fatalf("code must remain body text, without event handlers: %s", attr.Key)
							}
						}
					}
					for child := n.FirstChild; child != nil; child = child.NextSibling {
						walk(child)
					}
				}
				walk(root)
				if len(targets) != 1 {
					t.Fatalf("got %d copy targets, want one", len(targets))
				}
				target := targets[0]
				if target.FirstChild == nil || target.FirstChild.Type != html.TextNode || target.FirstChild.Data != code || target.FirstChild.NextSibling != nil {
					t.Fatal("copy target must contain only the exact six digits, including leading zeros")
				}
				ltr := false
				for _, attr := range target.Attr {
					if attr.Key == "dir" && attr.Val == "ltr" {
						ltr = true
					}
				}
				if !ltr || !strings.Contains(m.HTML, hint) || !strings.Contains(m.Text, hint) {
					t.Fatal("copy value needs LTR direction and localized instructions outside it")
				}
				plainCode := code
				if lang != "en" {
					plainCode = "\u2066" + code + "\u2069"
				}
				if !strings.Contains(m.Text, "\n\n"+plainCode+"\n\n") || strings.Contains(m.Subject, code) {
					t.Fatal("plaintext must retain its standalone code line and body-only privacy")
				}
			})
		}
	}
}

func TestNoticesHaveNoCodeCopyField(t *testing.T) {
	for _, lang := range []string{"en", "fa", "ps"} {
		for kind := range copyEN {
			if kind.HasCode() {
				continue
			}
			m := Render(kind, lang, "owner@example.com", "001234")
			if strings.Contains(m.HTML, "<code") || strings.Contains(m.Text, "001234") || strings.Contains(m.HTML, "001234") {
				t.Fatalf("%s/%s: security notice acquired a code field", lang, kind)
			}
			for _, hint := range []string{copyHintEN, copyHintFA, copyHintPS} {
				if strings.Contains(m.HTML, hint) || strings.Contains(m.Text, hint) {
					t.Fatalf("%s/%s: security notice acquired copying instructions", lang, kind)
				}
			}
		}
	}
}
