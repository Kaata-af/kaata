// components/EmptyState.tsx
//
// The app's one "there is nothing here" block.
//
// There were four vocabularies for this, two of them adjacent on the same
// screen: this component (56px padding, 15/13, centred), SettingsScreen's
// EmptyHint (10px padding, 13px, LEFT-aligned), vault/audit-log's own (16px
// sansSemi textEmphasis — a near-black headline), and vault/archived +
// removed-people's own (15px sansRegular textSubtle — grey body copy). The
// last two are the same moment in the same section of the app, a full step of
// hierarchy apart. app/person/new.tsx hand-rolled a fifth rather than importing
// this one, so tapping + from home gave a tight top-hugging message while
// opening a fresh contact gave an airy centred one.
//
// `size` is the only axis that legitimately varies: a full page of nothing
// wants air; an empty section inside a populated screen must not shove the
// rest of the content off-screen.
//
// `icon` and `isRTL` are NOT optional decoration — they exist because the
// first migration onto this component silently dropped five 40px glyphs and
// nine textDir() calls. Without an icon slot, callers either lose the glyph or
// render it outside the atom (which reintroduces the spacing drift the atom
// exists to remove). Without isRTL, a wrapped Persian title aligns left.

import type { ComponentProps, ReactNode } from "react";
import { Ionicons } from "@expo/vector-icons";
import { StyleSheet, Text, View } from "react-native";
import { colors } from "../lib/colors";
import { textDir } from "../lib/direction";
import { icon as iconSize, space, typography } from "../lib/tokens";

export function EmptyState(props: {
  title: string;
  subtitle?: string;
  /**
   * - page   — the whole screen is empty. Generous vertical air. (default)
   * - inline — an empty SECTION inside a screen that has other content.
   */
  size?: "page" | "inline";
  /** Leading glyph above the copy, at icon.hero (40). */
  icon?: ComponentProps<typeof Ionicons>["name"];
  /** Tint for the glyph. Defaults to textMuted; pass colors.danger for errors. */
  iconColor?: string;
  /**
   * Required for correct alignment when the copy WRAPS. Both strings are
   * centred, so single-line text looks identical either way — but a wrapped
   * Persian title left-aligns without this.
   */
  isRTL?: boolean;
  /** Optional CTA under the copy — e.g. archived's "Add a contact". */
  action?: ReactNode;
}) {
  const inline = props.size === "inline";
  const dir = props.isRTL == null ? null : textDir(props.isRTL);
  return (
    <View style={[styles.container, inline && styles.containerInline]}>
      {props.icon ? (
        <Ionicons
          name={props.icon}
          size={iconSize.hero}
          color={props.iconColor ?? colors.textMuted}
          style={styles.icon}
        />
      ) : null}
      <Text style={[styles.title, dir, styles.center]}>{props.title}</Text>
      {props.subtitle ? (
        <Text style={[styles.subtitle, dir, styles.center]}>{props.subtitle}</Text>
      ) : null}
      {props.action ? <View style={styles.action}>{props.action}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { paddingVertical: 56, paddingHorizontal: space.xxl, alignItems: "center" },
  containerInline: { paddingVertical: space.xxl },
  icon: { marginBottom: space.md },
  // sansSemi at 15 — the middle of the two hierarchies that existed. audit-log's
  // 16px textEmphasis headline was too loud for "nothing to show"; archived's
  // 15px textSubtle body was too quiet to read as a heading at all.
  title: { ...typography.labelBold, color: colors.textEmphasis, marginBottom: space.xs },
  subtitle: { ...typography.bodySm, color: colors.textSubtle },
  // Applied AFTER textDir so centring wins for the common single-line case;
  // textDir still supplies writingDirection, which is what actually fixes bidi
  // resolution for mixed Persian + Latin strings.
  center: { textAlign: "center" },
  action: { marginTop: space.lg },
});
