# System Reduce Motion

Kaata uses normal animations, blur and automatic card movement. There is no
in-app Animations setting, saved motion mode or hardware-based motion policy.
Old saved animation choices are no longer read or applied. No preference-data
migration is needed.

The shared `lib/reduced-motion.ts` adapter follows the phone's accessibility
Reduce Motion setting through `AccessibilityInfo`. It provides a reactive hook
and a cached getter for imperative scrolling. A native accessibility event
supersedes older asynchronous reads; unmounting retires stale callbacks.
The default is normal motion, and unavailable system reads keep the cached state.

When the phone requests reduced motion, existing consumers still suppress
decorative transitions, autoplay, blur, error shaking, toast/highlight movement
and progress shimmer. Direct gestures, scrolling, navigation state and static
feedback remain available. This accessibility support does not depend on device
memory, database metadata or a native hardware lookup.

Run `selftest:motion` for the system adapter, visual consumers and navigator
behavior. Component suites also cover keyboard focus, card loops, swipe ownership,
toast spacing, sheets and account settings.
