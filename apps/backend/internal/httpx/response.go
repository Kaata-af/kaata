package httpx

import (
	"encoding/json"
	"net/http"
)

func JSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func Error(w http.ResponseWriter, status int, message string) {
	JSON(w, status, map[string]string{"error": message})
}

// ErrorCode writes a structured error with a stable machine-readable code, so
// clients can branch on `error_code` instead of fragile prose-substring matching
// of `error`. `error` stays for humans/back-compat.
func ErrorCode(w http.ResponseWriter, status int, code, message string) {
	JSON(w, status, map[string]string{"error": message, "error_code": code})
}

// ErrorFields is ErrorCode plus extra machine-readable fields (a refusal
// reason, retry_after_s, ...). The fields cannot override error/error_code.
func ErrorFields(w http.ResponseWriter, status int, code, message string, fields map[string]any) {
	body := make(map[string]any, len(fields)+2)
	for k, v := range fields {
		body[k] = v
	}
	body["error"] = message
	body["error_code"] = code
	JSON(w, status, body)
}
