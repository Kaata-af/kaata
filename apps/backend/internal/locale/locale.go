// Package locale resolves the app's supported message languages independently
// of text direction and calendar choice.
package locale

import (
	"strconv"
	"strings"
)

func supported(tag string) string {
	tag = strings.ToLower(strings.TrimSpace(tag))
	tag = strings.ReplaceAll(tag, "_", "-")
	base, _, _ := strings.Cut(tag, "-")
	switch base {
	case "en", "ps":
		return base
	case "fa", "prs":
		return "fa"
	}
	return ""
}

// Normalize accepts regional language tags; unsupported languages use English.
func Normalize(tag string) string {
	if lang := supported(tag); lang != "" {
		return lang
	}
	return "en"
}

func RTL(lang string) bool { return Normalize(lang) != "en" }

// FromAcceptLanguage chooses the highest weighted supported language. A q=0
// tag is never selected, and equal weights retain the browser's stated order.
func FromAcceptLanguage(header string) string {
	best, bestQ := "en", 0.0
	for _, item := range strings.Split(header, ",") {
		parts := strings.Split(item, ";")
		lang := supported(parts[0])
		if strings.TrimSpace(parts[0]) == "*" {
			lang = "en"
		}
		if lang == "" {
			continue
		}
		q := 1.0
		for _, param := range parts[1:] {
			key, value, ok := strings.Cut(strings.TrimSpace(param), "=")
			if ok && strings.EqualFold(key, "q") {
				parsed, err := strconv.ParseFloat(value, 64)
				if err != nil || parsed < 0 || parsed > 1 {
					q = 0
				} else {
					q = parsed
				}
			}
		}
		if q > bestQ {
			best, bestQ = lang, q
		}
	}
	return best
}
