import type { ComponentProps } from "react";
import { useEffect, useRef } from "react";
import { Modal as NativeModal, Platform } from "react-native";
import { getAppLockPrivacy, useAppLockPrivacy } from "../lib/app-lock-privacy";

type ShowEvent = Parameters<NonNullable<ComponentProps<typeof NativeModal>["onShow"]>>[0];

/** Preserve sheet owners/drafts, but never expose their contents while locked.
 * iOS retains an existing presentation underneath the full-window lock cover:
 * rapidly dismissing/re-presenting UIKit controllers can lose the sheet. */
export function ProtectedModal(props: ComponentProps<typeof NativeModal>) {
  const blocked = useAppLockPrivacy();
  const requestedVisible = props.visible !== false;
  const ios = Platform.OS === "ios";
  const mounted = useRef(true);
  const latestProps = useRef(props);
  latestProps.current = props;
  const privacyDismissPending = useRef(false);
  const presentation = useRef({
    blocked,
    visible: requestedVisible,
    nativeVisible: false,
    version: 0,
    nativeVersion: 0,
    showed: false,
    pendingShow: null as { event: ShowEvent; nativeVersion: number } | null,
  });
  // A newly requested sheet must still wait for authentication. Only a native
  // presentation that was already allowed through can remain open on iOS.
  const nativeVisible =
    requestedVisible && (!blocked || (ios && presentation.current.nativeVisible));
  const nativeChanged = presentation.current.nativeVisible !== nativeVisible;
  if (
    presentation.current.blocked !== blocked ||
    presentation.current.visible !== requestedVisible ||
    nativeChanged
  )
    presentation.current = {
      ...presentation.current,
      blocked,
      visible: requestedVisible,
      nativeVisible,
      version: presentation.current.version + 1,
      ...(nativeChanged
        ? {
            nativeVersion: presentation.current.nativeVersion + 1,
            showed: false,
            pendingShow: null,
          }
        : {}),
    };
  const { version, nativeVersion } = presentation.current;
  const current = () =>
    mounted.current && presentation.current.version === version && !getAppLockPrivacy();
  if (!ios && blocked && requestedVisible) privacyDismissPending.current = true;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const current = presentation.current;
    const pending = current.pendingShow;
    if (
      !mounted.current ||
      blocked ||
      getAppLockPrivacy() ||
      !nativeVisible ||
      !requestedVisible ||
      !pending ||
      pending.nativeVersion !== current.nativeVersion ||
      current.showed
    )
      return;
    current.pendingShow = null;
    current.showed = true;
    privacyDismissPending.current = false;
    latestProps.current.onShow?.(pending.event);
  }, [blocked, nativeVisible, requestedVisible, nativeVersion]);

  return (
    <NativeModal
      {...props}
      visible={nativeVisible}
      animationType={blocked ? "none" : props.animationType}
      onShow={(event) => {
        const state = presentation.current;
        if (
          !mounted.current ||
          state.nativeVersion !== nativeVersion ||
          !state.nativeVisible ||
          !state.visible ||
          state.showed
        )
          return;
        if (state.blocked || getAppLockPrivacy()) {
          state.pendingShow = { event, nativeVersion };
          return;
        }
        state.pendingShow = null;
        state.showed = true;
        privacyDismissPending.current = false;
        latestProps.current.onShow?.(event);
      }}
      onDismiss={() => {
        if (presentation.current.version !== version) return;
        const hiddenForPrivacy = privacyDismissPending.current;
        privacyDismissPending.current = false;
        if (!hiddenForPrivacy && current()) props.onDismiss?.();
      }}
      onRequestClose={(event) => {
        if (current() && nativeVisible && requestedVisible) props.onRequestClose?.(event);
      }}
    >
      {blocked ? null : props.children}
    </NativeModal>
  );
}
