# Android keyboard overlap

The tally Note Save dock and both customer/tally search docks must avoid the
keyboard based on actual window geometry. `DeviceInfo.isEdgeToEdge` is a React
Native feature flag, not proof that an OEM Activity or modal has resized.
Previously a false flag disabled all fallback avoidance, leaving controls
covered on hosts where native resize failed.

Every opted-in Android frame now measures its remaining intersection with the
keyboard. Native resizing or panning naturally results in zero extra padding.
RN 0.88 removes status-bar/cutout top insets from non-edge window measurements;
the frame restores `StatusBar.currentHeight` before comparing those coordinates
with the keyboard's screen-space top. The flag describes that coordinate
conversion only and never disables avoidance.

The tally form uses the same frame as both search screens. Its absolute Save
and calculator dock belong to an inner flex viewport: padding on the outer
frame shrinks that viewport rather than leaving the absolute dock at the old
screen bottom. Android Note scrolling waits for a current keyboard measurement
and a matching committed form viewport. It handles either Fabric callback
order and preserves focus intent through a layout arriving before keyboard
show. Actual keyboard hide cancels the reveal. iOS retains its native keyboard
motion and InputAccessoryView Save toolbar.

Regression coverage includes non-edge hosts with and without native resize,
offset/panned windows, status bars and cutouts, keyboard-height changes,
already-open keyboards, delayed viewport commits, both receipt/event orders,
repeated cycles, and stale focus/route callbacks. Existing entry, customer,
homepage and keyboard checks pass.

Physical Expo Go verification used the connected Xiaomi M2007J3SY, whose
feature flag is false and whose window resizes correctly. With a keyboard top
of 601.82 dp, the measured visible customer search, tally search and Save
button bottoms cleared it by approximately 8.73, 11.27 and 10.18 dp. No tally
was saved and no customer data was modified. Samsung hardware was not
connected; its unresized-window failure path is covered by controlled geometry
tests and still needs confirmation on the updated app on that phone.

No native dependency, app version, build or store-release change is included.
