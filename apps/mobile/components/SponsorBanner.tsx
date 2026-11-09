import { useIsFocused } from "expo-router";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Animated, AppState, Image, Linking, Pressable, StyleSheet, View } from "react-native";
import { colors } from "../lib/colors";
import { t } from "../lib/i18n";
import { useReducedMotion } from "../lib/reduced-motion";
import type { SponsorSlide } from "../lib/sponsor-placement";
import { useToast } from "./Toast";

export function SponsorBanner({
  slides,
  rotationSeconds,
  separated,
  interactive = true,
}: {
  slides: readonly SponsorSlide[];
  rotationSeconds: number;
  separated: boolean;
  interactive?: boolean;
}) {
  const [width, setWidth] = useState(0);
  const [index, setIndex] = useState(0);
  const [appState, setAppState] = useState(AppState.currentState);
  const [imageStatus, setImageStatus] = useState<Record<string, "ready" | "failed">>({});
  const [progress] = useState(() => new Animated.Value(0));
  const transition = useRef<Animated.CompositeAnimation | null>(null);
  const opening = useRef(false);
  const reducedMotion = useReducedMotion();
  const focused = useIsFocused();
  const canInteract = interactive && focused && appState === "active";
  const interaction = useRef(canInteract);
  interaction.current = canInteract;
  const toast = useToast();

  const available = slides.filter((slide) => imageStatus[slide.image_url] !== "failed");
  const currentPosition = Math.max(0, available.indexOf(slides[index]));
  const current = available[currentPosition];
  const next = available.length > 1 ? available[(currentPosition + 1) % available.length] : null;
  const nextIndex = next ? slides.indexOf(next) : -1;
  const ready = !!current && imageStatus[current.image_url] === "ready";
  const nextReady = !!next && imageStatus[next.image_url] === "ready";

  useEffect(() => {
    const subscription = AppState.addEventListener("change", setAppState);
    return () => subscription.remove();
  }, []);

  useLayoutEffect(() => {
    return () => {
      const animation = transition.current;
      transition.current = null;
      animation?.stop();
      progress.setValue(0);
    };
  }, [current, next, progress, width]);

  useLayoutEffect(() => {
    if (!canInteract || !ready || !nextReady || width <= 0) return;
    const timer = setInterval(() => {
      if (!interaction.current || opening.current || transition.current) return;
      if (reducedMotion) {
        setIndex(nextIndex);
        return;
      }
      const animation = Animated.timing(progress, {
        toValue: 1,
        duration: 300,
        useNativeDriver: false,
      });
      transition.current = animation;
      animation.start(({ finished }) => {
        if (transition.current !== animation) return;
        if (finished) setIndex(nextIndex);
        else transition.current = null;
      });
    }, rotationSeconds * 1_000);
    // Opening a sheet pauses rotation without resetting a slide in flight.
    return () => clearInterval(timer);
  }, [
    canInteract,
    current,
    next,
    nextIndex,
    nextReady,
    progress,
    ready,
    reducedMotion,
    rotationSeconds,
    width,
  ]);

  if (!current) return null;
  const size =
    width > 0 && next && next.aspect_ratio !== current.aspect_ratio
      ? {
          height: progress.interpolate({
            inputRange: [0, 1],
            outputRange: [width / current.aspect_ratio, width / next.aspect_ratio],
          }),
        }
      : { aspectRatio: current.aspect_ratio };
  const offset = progress.interpolate({ inputRange: [0, 1], outputRange: [0, -width] });
  const recordStatus = (imageUrl: string, status: "ready" | "failed") =>
    setImageStatus((previous) =>
      previous[imageUrl] === status ? previous : { ...previous, [imageUrl]: status },
    );
  return (
    <View style={separated ? styles.divider : styles.singleRowBorder}>
      <Animated.View
        testID="home-sponsor-banner-frame"
        onLayout={({ nativeEvent }) => {
          if (width !== nativeEvent.layout.width) setWidth(nativeEvent.layout.width);
        }}
        style={[styles.frame, size]}
      >
        <Pressable
          testID="home-sponsor-banner"
          accessible={ready}
          accessibilityRole="link"
          accessibilityLabel={t("sponsorBanner.sponsored")}
          disabled={!ready || !canInteract}
          style={StyleSheet.absoluteFill}
          onPress={async () => {
            if (!interaction.current || transition.current || opening.current || !ready) return;
            opening.current = true;
            try {
              await Linking.openURL(current.destination_url);
            } catch {
              toast.push(t("sponsorBanner.openFailed"), "error");
            } finally {
              opening.current = false;
            }
          }}
        >
          <Animated.View
            style={[
              styles.track,
              { width: next ? "200%" : "100%", transform: [{ translateX: offset }] },
            ]}
          >
            {[current, next].map((slide) =>
              slide ? (
                <Image
                  key={slides.indexOf(slide)}
                  accessible={false}
                  source={{ uri: slide.image_url }}
                  style={{ width: next ? "50%" : "100%", aspectRatio: slide.aspect_ratio }}
                  resizeMode="stretch"
                  fadeDuration={0}
                  onLoad={() => recordStatus(slide.image_url, "ready")}
                  onError={() => recordStatus(slide.image_url, "failed")}
                />
              ) : null,
            )}
          </Animated.View>
        </Pressable>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { width: "100%", direction: "ltr", overflow: "hidden" },
  track: { flexDirection: "row", alignItems: "flex-start" },
  divider: { borderBottomWidth: 1, borderColor: colors.borderDefault },
  singleRowBorder: {
    borderWidth: 1,
    borderRadius: 12,
    borderColor: colors.borderDefault,
    overflow: "hidden",
  },
});
