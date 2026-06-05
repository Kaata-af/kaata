# First-time guided tour — postmortem and design notes

## Status

**Removed in full.** Two iterations were shipped and both felt wrong on
real devices. The code, refs, app_meta keys consumed at runtime, i18n
strings, and `TourProvider` are gone. The DB still contains
`tour_step` / `tour_completed` keys for any installs that wrote them —
they're harmless k/v entries; a future tour can overwrite them or
ignore them.

If you want the tour back, build it from scratch using the
recommendations at the bottom of this doc. Do **not** restore either
of the previous implementations from git.

## What we built and what failed

### Attempt 1 — `GuidedTour` with spotlight cutouts

**Design**: a full-screen `<Modal>`-less overlay that drew four dark
rectangles around a target rect — creating a "hole" through which the
real UI showed. Each step had a target ref measured via
`measureInWindow`, an "above"/"below"/"center" callout placement, and
either info-kind (tap anywhere to advance) or action-kind (only the
real button advances). A `BlurView` covered the whole screen behind
the cutout strips.

**Why it failed**:

1. **`measureInWindow` returns window-absolute coordinates** but the
   overlay rendered inside the screen's `SafeAreaView`, which adds
   `paddingTop: insets.top` to its content area. Positioning at
   measured `y` put the cutout `insets.top` pixels too low — top dim
   strip extended over the actual button → unreachable taps + visibly
   misaligned spotlights. We chased this through three rounds of
   "calibration" patches before realizing the root cause was the
   coordinate system mismatch.
2. **Touch routing through cutouts was brittle.** The root
   `Animated.View` started as `pointerEvents="auto"` — touches in the
   empty cutout area got silently swallowed instead of falling through
   to the highlighted button. Fixed by switching to `box-none`, then
   discovered the strip `Pressable`s themselves were blocking gestures
   for the swipe step (since they capture taps even with `onPress`
   = noop).
3. **`BlurView` covered the spotlight target.** Even though the
   cutout strips drew dark _around_ the target, the full-screen
   `BlurView` rendered _behind_ the strips and blurred the target
   itself. Removing the BlurView removed the "shadowed, unreadable"
   complaint but the cutouts still misaligned.
4. **Persian text broke the "above" callout placement.** The estimate
   `top: rect.y - 130 - GAP` assumed a ~130px card height; Persian
   often wraps the card taller and the card overlapped the
   highlighted button.
5. **Stale ref measurements after navigation.** `useFocusEffect`-
   driven re-measurement helped but didn't fully resolve the case
   where the screen's content shifted between mounts.
6. **Multi-screen coordination via `TourProvider`** worked, but the
   per-screen wiring (passing refs to each give/receive/ping button,
   wrapping them in measure-able `<View ref={...} collapsable={false}>`,
   threading advance calls into every relevant `onPress`) was a lot
   of surface area for a v1 feature that wasn't validated yet.

### Attempt 2 — `TourOverlay` with light dim + pulse pointer

**Design**: a rewrite optimizing for the problems above. No cutouts,
just a light full-screen dim (`rgba(0,0,0,0.45)`). Pointer animations
(pulse ring for tap targets, slider for swipe) drew attention. Action
steps made the dim transparent to touch (`pointerEvents: 'none'`) so
the real UI gestures fired directly. Cut down to 8 steps; tab-tap no
longer advanced the swipe step (the user explicitly wanted "remove
tapping the tabs completely").

**Why it failed**:

1. **The dim background was still too dark to read through.** Users
   experienced this as "background shadowed and unreadable" — the
   point of a light dim was to show the real UI through, but at 45%
   black the real UI was murky enough to misread.
2. **The bottom-anchored action card overlapped form fields.** On
   `person/new` and `entry/new`, the bottom card sat over the inputs
   the user needed to interact with — especially after the keyboard
   opened. Added a `Keyboard.addListener` to lift the card above the
   keyboard, but the card still occluded fields like the phone-number
   row and the contacts-picker shortcut.
3. **The pulse pointer was still "slightly off."** Static positions
   (FAB) worked fine, but the give and ping buttons still required
   `measureInWindow`. Even with multi-pass remeasure (mount + 350ms +
   750ms) the visual alignment felt off on Android during the inset-
   settle window. The "forgiveness" of a pulse ring helped technically
   but not subjectively.
4. **Action steps could trap the user.** Forcing the real gesture to
   advance is good pedagogy, but if the user fundamentally
   misunderstood the prompt (e.g. tapped a tab instead of swiping),
   the tour just sat there with the swipe slider animating until they
   hit Skip — which felt like a dead-end.
5. **It still added cognitive friction.** Real-world users on a
   shopkeeper app want to start logging numbers. A tour — even a
   short, well-designed one — slows them down before they've decided
   the app is worth investing in.

## User-reported symptoms across both attempts

| Round | Symptom                                                      | Root cause                                   |
| ----- | ------------------------------------------------------------ | -------------------------------------------- |
| 1     | "highlights are very off mark"                               | measureInWindow vs SAV inset mismatch        |
| 1     | "whole page is blurred"                                      | full-screen BlurView under the cutout strips |
| 1     | "I can't tap the add button"                                 | root Animated.View `pointerEvents="auto"`    |
| 1     | "text blocks fields"                                         | centered callout placement over form         |
| 2     | "background shadowed and unreadable"                         | 45% black dim too opaque                     |
| 2     | "messages in bad positions blocking fields and buttons"      | bottom card overlapped inputs                |
| 2     | "highlights the buttons in the wrong places or slightly off" | measureInWindow timing on Android            |

## What to do next time

### Don't repeat these patterns

- **Don't render the tour inside any `SafeAreaView` or other padded
  container.** Window coordinates are the only honest coordinate
  system; the overlay needs to live at window root or use coords
  relative to its own measured position.
- **Don't use BlurView as a backdrop** in the cutout pattern. It
  blurs the target too.
- **Don't try to use `measureInWindow` for moving targets** (buttons
  inside scroll views, rows that depend on dynamic content above).
  Insets settle, fonts load, banners appear — the rect drifts.
- **Don't dim the whole screen at 30%+** unless you want users to
  read the real UI as "muted/disabled."
- **Don't make action steps unforgiving.** If the user does
  anything other than the prompted action, the tour should either
  pivot or quietly fade out.

### Patterns worth trying

1. **Coachmark library.** [`react-native-copilot`](https://github.com/mohebifar/react-native-copilot)
   handles measurement + positioning + step state for you, including
   the Android measure-timing edge cases. Adopting it would be ~1 day
   of integration vs. the multi-week effort we sunk into the home-
   rolled version. Trade-off: a native dep + the library's visual
   defaults to override.
2. **Dedicated tutorial screens instead of overlays.** Show 3-5
   full-screen illustrated cards _before_ the real UI mounts —
   carousel-style intro, swipe to dismiss. The real UI is never
   modified; the tour is just a sequence of regular screens. Pair
   with a small "Show me how again" affordance in Settings.
   - Reference: [`react-native-onboarding-swiper`](https://github.com/jfilter/react-native-onboarding-swiper)
   - Pro: zero coordinate math; works in every locale; the tour
     can't break the app
   - Con: lower fidelity than a real-UI overlay; users still have
     to translate from the illustration to the actual button
3. **Lottie illustrations** for the welcome / done screens regardless
   of which other pattern is chosen. The polish-per-effort ratio is
   high and Lottie is the standard.
4. **Empty-state hints** instead of any tour. When the home list is
   empty, the EmptyState body becomes the tutorial: a labeled arrow
   pointing at the + FAB with "Tap to add your first person." When
   the person screen has no entries, the empty state explains "Tap I
   gave or I received to log something." This is the pattern Linear,
   Notion, and most modern productivity apps use. Pro: passive,
   never blocks, can't go stale. Con: doesn't teach the swipe
   gesture (probably fine — users discover it via the tab tap, then
   notice the rail responds to drag).

### Recommended path

If/when the team revisits this, the **simplest viable answer** is:

1. **Onboarding intro carousel** (3-5 full-screen cards with
   illustrations + copy) — covers welcome, swipe, and "how a kaata
   works" conceptually. Use `react-native-onboarding-swiper` or
   build it as 3-5 regular `expo-router` Stack screens.
2. **Inline empty-state coaching** on the home screen and on
   `person/[id]` — the existing `EmptyState` component already takes
   `title` + `subtitle`; extend it to optionally render a small
   directional arrow icon.
3. **Skip a real overlay tour for now.** Revisit only if real-user
   feedback says people are confused after the intro carousel + empty
   states. If so, adopt `react-native-copilot` rather than re-rolling
   the overlay.

Reserve LOE: 1-2 days for the intro carousel + empty-state
enhancements, vs. the multi-week loop the overlay approach generated.

## Files removed in the cleanup

```
apps/mobile/components/TourOverlay.tsx
apps/mobile/components/GuidedTour.tsx          (already deleted before this round)
apps/mobile/lib/tour.ts
```

## References surgically removed

```
apps/mobile/app/_layout.tsx
  - TourProvider import + wrapper

apps/mobile/app/index.tsx
  - useTour() / tabsRef / fabRef / TourOverlay mounts
  - tour.advance() calls in swipe-commit branches and FAB onPress
  - tour.advance() in Tabs.onChange
  - screenHeight (no longer needed without tour math)

apps/mobile/app/person/new.tsx
  - useTour() + tour advance in createAndOpen
  - TourOverlay mount

apps/mobile/app/person/[id].tsx
  - useTour() / giveBtnRef / pingBtnRef / measureInWindow effect
  - entriesConfirmedEmpty state + safety-net effect
  - tour.advance() in give and ping onPress handlers
  - All three TourOverlay mounts

apps/mobile/app/entry/new.tsx
  - useTour() / showGaveTip / TourOverlay mount
  - tour.advance() in onSave

apps/mobile/lib/i18n.ts
  - tour.* keys in both EN and FA blocks
```

The `app_meta` rows `tour_step` and `tour_completed` are intentionally
left in any installs that wrote them. They're cheap k/v entries and
removing them would require a no-op migration with no behavioral
benefit. A future tour implementation can reuse the same key names or
pick new ones — readers of `app_meta` should treat both as optional.

## Lessons

- **Tour overlays over real UI are HARD.** Two iterations from a
  capable engineer + multiple verification rounds + adversarial code
  review still produced something the user described as "terrible."
  The pattern requires deep familiarity with mobile rendering quirks
  and a willingness to test on real devices across multiple Android
  versions / iOS versions / screen sizes. Not a v1 feature.
- **Tutorials for shopkeeper-style apps probably want to be passive.**
  Users open the app to do work, not to be taught. Passive empty-state
  coaching + a one-time intro carousel deliver most of the educational
  value with none of the overlay-rendering risk.
- **When two rebuilds in a row fail user testing, stop iterating and
  remove.** Sunk cost is real; doubling down on a pattern that isn't
  landing produces more code without producing the outcome. This doc
  is the receipt.
