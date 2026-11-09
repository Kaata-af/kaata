import { useLayoutEffect, useRef, useState } from "react";
import {
  Animated,
  Image,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  useWindowDimensions,
} from "react-native";
import { t } from "../lib/i18n";
import { useReducedMotion } from "../lib/reduced-motion";
import type { SponsorSlide } from "../lib/sponsor-placement";
import { space } from "../lib/tokens";
import { useToast } from "./Toast";

const WIDTH = 320;
const HEIGHT = 50;

export function SponsorBanner({
  slides,
  rotationSeconds,
}: {
  slides: readonly SponsorSlide[];
  rotationSeconds: number;
}) {
  const { width: screenWidth } = useWindowDimensions();
  const width = Math.min(WIDTH, screenWidth);
  const height = (width * HEIGHT) / WIDTH;
  const [index, setIndex] = useState(0);
  const [imageStatus, setImageStatus] = useState<Record<string, "ready" | "failed">>({});
  const offset = useRef(new Animated.Value(0)).current;
  const transitioning = useRef(false);
  const opening = useRef(false);
  const reducedMotion = useReducedMotion();
  const toast = useToast();

  const available = slides.filter((slide) => imageStatus[slide.image_url] !== "failed");
  const currentPosition = Math.max(0, available.indexOf(slides[index]));
  const current = available[currentPosition];
  const next = available.length > 1 ? available[(currentPosition + 1) % available.length] : null;
  const nextIndex = next ? slides.indexOf(next) : -1;
  const ready = !!current && imageStatus[current.image_url] === "ready";
  const nextReady = !!next && imageStatus[next.image_url] === "ready";

  useLayoutEffect(() => {
    if (!ready || !nextReady) return;
    const animation = Animated.timing(offset, {
      toValue: -width,
      duration: 300,
      useNativeDriver: Platform.OS !== "web",
    });
    const timer = setInterval(() => {
      if (opening.current || transitioning.current) return;
      if (reducedMotion) {
        setIndex(nextIndex);
        return;
      }
      transitioning.current = true;
      animation.start(({ finished }) => {
        if (finished) setIndex(nextIndex);
      });
    }, rotationSeconds * 1_000);
    return () => {
      clearInterval(timer);
      animation.stop();
      offset.setValue(0);
      transitioning.current = false;
    };
  }, [current, next, nextIndex, nextReady, offset, ready, reducedMotion, rotationSeconds, width]);

  if (!current) return null;
  const recordStatus = (imageUrl: string, status: "ready" | "failed") =>
    setImageStatus((previous) =>
      previous[imageUrl] === status ? previous : { ...previous, [imageUrl]: status },
    );
  return (
    <Pressable
      testID="home-sponsor-banner"
      accessible={ready}
      accessibilityRole="link"
      accessibilityLabel={t("sponsorBanner.sponsored")}
      disabled={!ready}
      onPress={async () => {
        if (transitioning.current || opening.current || !ready) return;
        opening.current = true;
        try {
          await Linking.openURL(current.destination_url);
        } catch {
          toast.push(t("sponsorBanner.openFailed"), "error");
        } finally {
          opening.current = false;
        }
      }}
      style={[styles.frame, { width, height: ready ? height : 0 }, ready && styles.spacing]}
    >
      <Animated.View
        style={[
          styles.track,
          { width: next ? 2 * width : width, transform: [{ translateX: offset }] },
        ]}
      >
        {[current, next].map((slide) =>
          slide ? (
            <Image
              key={slides.indexOf(slide)}
              accessible={false}
              source={{ uri: slide.image_url }}
              style={{ width, height }}
              resizeMode="contain"
              fadeDuration={0}
              onLoad={() => recordStatus(slide.image_url, "ready")}
              onError={() => recordStatus(slide.image_url, "failed")}
            />
          ) : null,
        )}
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  frame: { alignSelf: "center", direction: "ltr", overflow: "hidden" },
  spacing: { marginBottom: space.sm },
  track: { flexDirection: "row", alignSelf: "flex-start" },
});
