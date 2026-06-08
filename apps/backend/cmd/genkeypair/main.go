// genkeypair generates a fresh Ed25519 keypair for the mesh-signing role
// and prints both halves as standard-base64 strings ready to paste into a
// .env file:
//
//	$ go run ./cmd/genkeypair
//	# Ed25519 mesh-signing keypair (generated 2026-06-07T12:00:00Z)
//	# Paste these into the backend's environment (e.g. apps/backend/.env,
//	# or your orchestrator's secret store).
//	#
//	# PRIVATE KEY — keep secret. Anyone who has this can mint VMCs that
//	# every mesh peer will accept until the matching pubkey is rotated out
//	# of clients (60 days minimum, by VMC lifetime).
//	MESH_SIGNING_PRIVKEY_PRIMARY=...
//	# PUBLIC KEY — embed in every client.
//	MESH_SIGNING_PUBKEY_PRIMARY=...
//
// Pipe to a file (`go run ./cmd/genkeypair > .env.mesh`) and commit the
// PUBLIC half to the mobile build's env, the PRIVATE half to the
// backend's secret store ONLY.
package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"os"
	"time"
)

func main() {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		fmt.Fprintf(os.Stderr, "ed25519.GenerateKey: %v\n", err)
		os.Exit(1)
	}

	now := time.Now().UTC().Format(time.RFC3339)
	fmt.Printf("# Ed25519 mesh-signing keypair (generated %s)\n", now)
	fmt.Println("# Paste these into the backend's environment (e.g. apps/backend/.env,")
	fmt.Println("# or your orchestrator's secret store).")
	fmt.Println("#")
	fmt.Println("# PRIVATE KEY — keep secret. Anyone who has this can mint VMCs that")
	fmt.Println("# every mesh peer will accept until the matching pubkey is rotated out")
	fmt.Println("# of clients (60 days minimum, by VMC lifetime).")
	fmt.Printf("MESH_SIGNING_PRIVKEY_PRIMARY=%s\n", base64.StdEncoding.EncodeToString(priv))
	fmt.Println("# PUBLIC KEY — embed in every client.")
	fmt.Printf("MESH_SIGNING_PUBKEY_PRIMARY=%s\n", base64.StdEncoding.EncodeToString(pub))
	fmt.Println("#")
	fmt.Println("# Rotation procedure (when needed):")
	fmt.Println("#   1. Generate a NEW pair with `go run ./cmd/genkeypair > .env.mesh.next`.")
	fmt.Println("#   2. Set MESH_SIGNING_PUBKEY_ROTATION on the backend to the new pubkey,")
	fmt.Println("#      ship a mobile update that ALSO trusts the rotation pubkey, wait")
	fmt.Println("#      for adoption.")
	fmt.Println("#   3. After 60 days (all in-flight VMCs have expired):")
	fmt.Println("#      - Backend: PRIMARY := ROTATION values, then clear ROTATION.")
	fmt.Println("#      - Mobile: drop trust of the old pubkey in the next release.")
}
