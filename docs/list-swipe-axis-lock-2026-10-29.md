# List swipe axis locking

The homepage customer list and customer tally list used to recognize their
horizontal filter Pan simultaneously with the parent native ScrollView. A held
horizontal drag could therefore scroll vertically as well. `failOffsetY` only
rejects a Pan before activation; it cannot exclude the other active recognizer.

The shared `HomeBalanceFilterSwipe` now blocks the parent native gesture while
choosing an axis. Manual activation accepts horizontal intent at 24 points with
at least twice the vertical displacement. Vertical/ambiguous motion fails before
horizontal activation, handing the touch to scrolling. Once horizontal activates,
it owns the complete touch until release, including a long hold or vertical drift.
Both vertical ScrollViews also enable the native iOS directional lock.

Android can report the preceding MOVE coordinates in `onStart`. The Pan therefore
records its validated activation request before calling the native state manager,
rather than rejecting the activation using that older sample. Existing slow-swipe,
row long-press, cancellation, repeat-to-clear and stale-context guards remain.
Card currency carousels remain outside the list gesture subtree.

Verification: TypeScript, the list-swipe suite, home-selection and row-selection
gesture suites pass. Regressions cover both directions, initially diagonal or
vertical strokes, slow movement, long horizontal holds, previous-coordinate native
activation, multi-touch, cancellation, reduced motion and stale callbacks.

On the USB Xiaomi in Expo Go, native touch injection held horizontal movement for
four seconds before dragging vertically by 450 physical pixels. Both lists kept
their original vertical position (home 228.73 points, customer 270.18), retained
their horizontal displacement until release and then applied the expected filter.
Vertical-first tests scrolled normally, stayed at horizontal offset zero, and did
not change filters. A left swipe starting in the customer's empty-results area
also passed. Physical iPhone verification was not performed.

Evidence helpers and observations are ignored in `build/axis-lock-20261029/`.
Temporary filters were cleared, the phone returned to the homepage, and the native
touch helper removed. No financial records, app builds or store releases changed.
