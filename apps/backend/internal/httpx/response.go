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
