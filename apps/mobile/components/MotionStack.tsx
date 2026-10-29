import { Stack } from "expo-router";
import type { PropsWithChildren } from "react";
import { colors } from "../lib/colors";
import { useSheetMotionPreference } from "./SheetBackdrop";

/** Change navigation motion without replacing the navigator or its routes. */
export function MotionStack({ children }: PropsWithChildren) {
  const reducedMotion = useSheetMotionPreference();
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.bgDefault },
        animation: reducedMotion ? "none" : "default",
      }}
    >
      {children}
    </Stack>
  );
}
