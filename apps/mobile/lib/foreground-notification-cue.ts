import type { AudioPlayer } from "expo-audio";
import * as Haptics from "expo-haptics";
import { requireOptionalNativeModule } from "expo-modules-core";
import { AppState } from "react-native";
import type { NotificationPolicy } from "./notification-policy";

const CUE_INTERVAL_MS = 800;
const MAX_SEEN_KEYS = 128;
const seenKeys = new Set<string>();
let lastCueAt = -Infinity;
let cueVersion = 0;
let playerPromise: Promise<AudioPlayer | undefined> | undefined;

function getChimePlayer(): Promise<AudioPlayer | undefined> {
  return (playerPromise ??= (async () => {
    // Older installed builds can still provide haptic feedback.
    if (!requireOptionalNativeModule("ExpoAudio")) return undefined;
    const { createAudioPlayer, setAudioModeAsync } = await import("expo-audio");
    await setAudioModeAsync({
      interruptionMode: "mixWithOthers",
      playsInSilentMode: false,
      shouldPlayInBackground: false,
    });
    return createAudioPlayer(require("../assets/notification-chime.wav"));
  })().catch(() => {
    playerPromise = undefined;
    return undefined;
  }));
}

async function playChime(isCurrent: () => boolean): Promise<void> {
  const player = await getChimePlayer();
  if (!player || !isCurrent()) return;
  if (player.currentTime > 0) await player.seekTo(0, 0, 0);
  if (isCurrent()) player.play();
}

/** Coalesce a burst of new notices into one foreground sound and tap. */
export function playForegroundNotificationCue(
  policy: Pick<NotificationPolicy, "sound" | "vibration">,
  isCurrent: () => boolean,
  key: string,
): void {
  const canPlay = () => AppState.currentState === "active" && isCurrent();
  if ((!policy.sound && !policy.vibration) || !canPlay() || seenKeys.has(key)) return;

  seenKeys.add(key);
  if (seenKeys.size > MAX_SEEN_KEYS) {
    const oldestKey = seenKeys.values().next().value;
    if (oldestKey !== undefined) seenKeys.delete(oldestKey);
  }

  const now = performance.now();
  if (now - lastCueAt < CUE_INTERVAL_MS) return;
  lastCueAt = now;
  const version = ++cueVersion;

  if (policy.vibration) void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
  if (policy.sound) void playChime(() => version === cueVersion && canPlay()).catch(() => {});
}
