# Native in-app ratings

Kaata uses Expo SDK 58's `expo-store-review` to request the system rating card.
The user chooses a rating and submits it directly to Apple or Google. Kaata
receives no stars, review text, or confirmation that a card appeared or a review
was submitted. It records only an attempted request.

## Timing

The app tracks successful new tallies locally. A request requires all of:

- At least seven distinct active days on which the user recorded tallies.
- At least seven full days since the first tracked tally.
- At least ten successful new tallies.
- No request for this marketing version yet.
- At least 90 days since the previous attempt, and fewer than three attempts in
  the past 365 days.

Install age alone never qualifies an existing user. Activity starts with this
feature and is bound to the current account; changing Kaatas keeps that activity.
Request limits apply across the installation. Edits, failed/refused saves,
pending credit admission, sign-in waiting, duplicate notices and credit warning
flows do not count as eligible successes.

After a qualifying save, the app waits for the user to return to Home and leave
it idle for five seconds. Touching the screen, opening the keyboard or a popup,
selecting customers, leaving Home or backgrounding the app cancels the attempt.
Opportunities expire after ten minutes and are not restored on the next launch.
Saving and navigation never wait for review logic.

No custom stars, satisfaction question, incentive, store-page redirect or
submission-success toast is shown. The stores may suppress the card. An
unavailable native API consumes no attempt; a native request that starts does
consume an attempt even if the store declines to show anything.

## Testing and release

- Expo Go, development builds, web and other application identities skip requests.
- TestFlight disables Apple's in-app rating prompt. Verify the eligibility and
  cancellation logic with `selftest:store-review`; absence of a card in
  TestFlight is expected.
- On Android, test the native card with an eligible account through the existing
  Play internal testing track. Internal app sharing cannot submit a review.
- The new native module requires a new app binary. Do not expect an older
  installed build to gain this feature from a JavaScript update.

References: [Expo SDK 58](https://docs.expo.dev/versions/v58.0.0/sdk/storereview/),
[Apple review requests](https://developer.apple.com/documentation/storekit/requesting-app-store-reviews),
[Google's review guidelines](https://developer.android.com/guide/playcore/in-app-review),
[Google's testing guidance](https://developer.android.com/guide/playcore/in-app-review/test).
