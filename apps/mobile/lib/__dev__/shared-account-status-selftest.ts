import assert from "node:assert/strict";
import {
  combinedSharedAccountStatus,
  personSharedAccountStatus,
  sharedAccountLinkStatus,
} from "../tabs/link-status";

const pending = { closed_at: null, other_joined_at: null, invitation_declined_at: null };
assert.equal(sharedAccountLinkStatus(pending), "waiting");
assert.equal(
  sharedAccountLinkStatus({ ...pending, invitation_expires_at: Date.now() + 60_000 }),
  "waiting",
);
assert.equal(
  sharedAccountLinkStatus({ ...pending, invitation_expires_at: Date.now() - 1 }),
  "expired",
);
assert.equal(
  sharedAccountLinkStatus({ ...pending, invitation_expires_at: 1, other_joined_at: 2 }),
  "joined",
);
assert.equal(
  sharedAccountLinkStatus({ ...pending, invitation_expires_at: 1, invitation_declined_at: 2 }),
  "declined",
);
assert.equal(
  sharedAccountLinkStatus({ ...pending, invitation_expires_at: 1, closed_at: 2 }),
  "none",
);
assert.equal(personSharedAccountStatus({ tab_id: "tab", tab_invitation_expires_at: 1 }), "expired");
assert.equal(
  personSharedAccountStatus({
    currency_balances: [
      { tab_id: "afn", tab_invitation_expires_at: 1 },
      { tab_id: "usd", tab_other_joined: 1, tab_invitation_expires_at: 1 },
    ],
  }),
  "joined",
);
assert.equal(combinedSharedAccountStatus(["expired", "waiting"]), "waiting");
console.log(
  "PASS: invitation status distinguishes expired, rejected, accepted and closed across currencies",
);
