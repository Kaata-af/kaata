// Every web ledger reader and writer understands these formats. Keep policy
// requests aligned with ledger requests so the same book passes upgrade guards.
export const WEB_SYNC_HEADERS = {
  "X-Kaata-Currencies": "1",
  "X-Kaata-Entry-Currency-Edit": "1",
  "X-Kaata-Tab-Group": "1",
} as const;
