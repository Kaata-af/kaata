// gen-reimport writes the production re-import script for the 2026-10-07
// incident from the carved events_recovered.jsonl AND the decoded complete
// pre-deletion oracle snapshots. It makes NO database connection: the output
// is reimport.sql (one transaction), rollback.sql and summary.txt, to be
// reviewed by Matee and run with
//
//	psql -v ON_ERROR_STOP=1 -f reimport.sql
//
// inside the production database container, only after explicit approval. The
// vault names default to the oracle; generation ABORTS if the folded ledger
// does not equal the oracle exactly (the equality gate in reimport.go).
//
//	go run ./scratch-reimport/cmd/gen-reimport \
//	  -jsonl <events_recovered.jsonl> -out <dir> \
//	  [-include-viewer]
package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/google/uuid"

	"github.com/matee/kaata-backend/scratch-reimport/reimport"
)

const scratchpad = `C:\Users\Matee\AppData\Local\Temp\claude\C--Users-Matee-Desktop-Projects-Kaata-kaata\02b77d52-d3e7-44aa-852e-2348f3342122\scratchpad`

func main() {
	jsonl := flag.String("jsonl", "", "path to events_recovered.jsonl (required)")
	out := flag.String("out", ".", "output directory")
	owner := flag.String("owner", "a98f0bc3-796e-4625-99ad-e8f7b1565ac1", "live owner account id")
	deleted := flag.String("deleted", "498717f1-6686-4961-9f1e-7ff852e6f275", "deleted account id that signed the history (post-condition counts only)")
	install := flag.String("install", "b4950978-cf4a-461f-b059-ba2b66bd86a8", "the phone's install id; the preflight refuses if it is retired, has no device key, or is not bound to the owner (empty disables)")
	anchor := flag.String("anchor", "pMauYtxNGJ4JxjOZMZFz8x5r8NZX7GxOfPWOSvRBqeg=", "K1, std base64 (signer of every recovered row)")
	mainID := flag.String("main-id", "eb7cd98d-32f0-4c6c-a456-7ad3e4ca8b6d", "main vault id")
	mainName := flag.String("main-name", "", "override for vaults.name of the main vault (default: the oracle name)")
	mainOracle := flag.String("main-oracle", filepath.Join(scratchpad, "skeptic-es", "snapshot_30613.json"), "decoded complete pre-deletion snapshot for the main vault")
	mainCursor := flag.Int64("main-cursor", 2300, "main vault snapshot cursor / final margin server_seq (safety margin above any pre-deletion seq)")
	secondID := flag.String("second-id", "98e2d78f-96f4-4188-919d-0d7d5501258c", "second vault id")
	secondName := flag.String("second-name", "", "override for vaults.name of the second vault (default: the oracle name)")
	secondOracle := flag.String("second-oracle", filepath.Join(scratchpad, "skeptic-es", "snapshot_second_210.json"), "decoded complete pre-deletion snapshot for the second vault")
	secondCursor := flag.Int64("second-cursor", 260, "second vault snapshot cursor / final margin server_seq")
	currency := flag.String("currency", "AFN", "vault currency")
	includeViewer := flag.Bool("include-viewer", false, "also seat the oracle's non-owner members (the main vault viewer) in vault_members")
	flag.Parse()

	if *jsonl == "" {
		fmt.Fprintln(os.Stderr, "-jsonl is required")
		flag.Usage()
		os.Exit(2)
	}
	rows, err := reimport.LoadJSONL(*jsonl)
	if err != nil {
		fail("load jsonl", err)
	}
	mainOra, err := reimport.LoadOracle(*mainOracle)
	if err != nil {
		fail("load main oracle", err)
	}
	secondOra, err := reimport.LoadOracle(*secondOracle)
	if err != nil {
		fail("load second oracle", err)
	}
	plan, err := reimport.BuildPlan(rows, reimport.Options{
		OwnerAccountID:   *owner,
		DeletedAccountID: *deleted,
		PhoneInstallID:   *install,
		AnchorPubB64:     *anchor,
		ReimportDeviceID: uuid.NewSHA1(uuid.NameSpaceURL, []byte("kaata-reimport-2026-10-07/device")).String(),
		IncludeViewer:    *includeViewer,
		Now:              time.Now(),
		Vaults: []reimport.VaultSpec{
			{ID: *mainID, Name: *mainName, Currency: *currency, Oracle: mainOra, UpTo: *mainCursor},
			{ID: *secondID, Name: *secondName, Currency: *currency, Oracle: secondOra, UpTo: *secondCursor},
		},
	})
	if err != nil {
		fail("build plan", err)
	}
	if err := os.MkdirAll(*out, 0o755); err != nil {
		fail("mkdir", err)
	}
	write(filepath.Join(*out, "reimport.sql"), plan.RenderSQL())
	write(filepath.Join(*out, "rollback.sql"), plan.RenderRollbackSQL())
	write(filepath.Join(*out, "summary.txt"), plan.Summary())
	fmt.Print(plan.Summary())
	fmt.Printf("wrote %s, %s, %s\n", filepath.Join(*out, "reimport.sql"), filepath.Join(*out, "rollback.sql"), filepath.Join(*out, "summary.txt"))
}

func write(path, body string) {
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		fail("write "+path, err)
	}
}

func fail(what string, err error) {
	fmt.Fprintf(os.Stderr, "%s: %v\n", what, err)
	os.Exit(1)
}
