// Behavior suites keep screen actions visible across the shared presentation
// boundary. onboarding-ui-selftest executes the real presentation components.
import { jsx, type UINode } from "./ui-fixture";

export const onboardingMock = {
  OnboardingHeader: "OnboardingHeader",
  OnboardingIntro: "OnboardingIntro",
  OnboardingAction: "Button",
  onboardingStyles: { screen: {}, content: {}, section: {}, footer: {} },
};

export function onboardingJSX(type: any, props: Record<string, any>): UINode {
  if (type === "OnboardingHeader") {
    return props.onBack
      ? jsx("Pressable", {
          onPress: props.onBack,
          disabled: props.disabled,
          accessibilityLabel: props.backLabel ?? "common.back",
          accessibilityRole: "button",
        })
      : jsx("View", {});
  }
  if (type === "OnboardingIntro") {
    return jsx("View", {
      children: [
        jsx("Text", { children: props.title }),
        props.description ? jsx("Text", { children: props.description }) : null,
        props.children,
      ],
    });
  }
  return jsx(type, props);
}
