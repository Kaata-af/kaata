import { useIsFocused } from "expo-router";
import { useCallback, useEffect, useRef } from "react";
import { AppState, Keyboard, Platform } from "react-native";
import {
  dismissReviewOpportunity,
  getReviewOpportunity,
  requestReviewOpportunity,
  subscribeReviewOpportunities,
  type StoreReviewContext,
} from "./store-review";

const IDLE_MS = 5000;
const contextKey = (context: StoreReviewContext | null) =>
  context ? JSON.stringify([context.installId, context.accountId, context.vaultId]) : null;

/** Home owns this opportunity, after the tally form and customer workflow have
 * finished. A new interaction cancels it rather than delaying an interruption. */
export function useStoreReviewPrompt({
  context,
  ready,
}: {
  context: StoreReviewContext | null;
  ready: boolean;
}): () => void {
  const focused = useIsFocused();
  const key = contextKey(context);
  const mounted = useRef(false);
  const native = useRef({
    app: AppState.currentState,
    keyboard: Keyboard.isVisible(),
    windowFocused: true,
  });
  const latest = useRef({ context, key, ready, focused, epoch: 0 });
  const previous = latest.current;
  const epoch =
    previous.key !== key || previous.ready !== ready || previous.focused !== focused
      ? previous.epoch + 1
      : previous.epoch;
  latest.current = { context, key, ready, focused, epoch };
  const generation = useRef(0);
  const armed = useRef<{
    id: string;
    context: StoreReviewContext;
    key: string;
    epoch: number;
    generation: number;
    timer: ReturnType<typeof setTimeout> | null;
  } | null>(null);
  const reconcile = useRef<() => void>(() => {});
  const cancel = useCallback(() => {
    generation.current++;
    const job = armed.current;
    armed.current = null;
    if (job) {
      if (job.timer !== null) clearTimeout(job.timer);
      dismissReviewOpportunity(job.id);
    }
    const current = latest.current.context;
    const pending = current && getReviewOpportunity(current);
    if (pending && pending !== job?.id) dismissReviewOpportunity(pending);
  }, []);
  const available = () =>
    mounted.current &&
    latest.current.context !== null &&
    latest.current.ready &&
    latest.current.focused &&
    native.current.app === "active" &&
    AppState.currentState === "active" &&
    native.current.windowFocused &&
    !native.current.keyboard &&
    !Keyboard.isVisible();
  reconcile.current = () => {
    if (!mounted.current) return;
    const job = armed.current;
    if (job) {
      const pending = getReviewOpportunity(job.context);
      if (pending && pending !== job.id) {
        generation.current++;
        armed.current = null;
        if (job.timer !== null) clearTimeout(job.timer);
        dismissReviewOpportunity(job.id);
        reconcile.current();
        return;
      }
      if (!available() || job.epoch !== latest.current.epoch) cancel();
      else return;
    }
    // A tally can finish while Home is behind its form/customer page. Retain
    // that fresh opportunity until Home returns, but never across backgrounding.
    if (native.current.app !== "active" || AppState.currentState !== "active") {
      cancel();
      return;
    }
    if (!available()) return;
    const current = latest.current;
    const id = getReviewOpportunity(current.context!);
    if (!id || current.key === null) return;
    const next = {
      id,
      context: { ...current.context! },
      key: current.key,
      epoch: current.epoch,
      generation: generation.current,
      timer: null as ReturnType<typeof setTimeout> | null,
    };
    const isReady = () =>
      armed.current === next &&
      next.epoch === latest.current.epoch &&
      next.generation === generation.current &&
      next.key === latest.current.key &&
      available();
    armed.current = next;
    next.timer = setTimeout(() => {
      next.timer = null;
      if (!isReady()) {
        if (armed.current === next) cancel();
        return;
      }
      // The native API may await availability/storage. Its final readiness
      // check remains tied to this exact idle interval, even after an ABA change.
      void requestReviewOpportunity(next.context, next.id, isReady)
        .catch(() => undefined)
        .finally(() => {
          if (armed.current !== next) return;
          armed.current = null;
          dismissReviewOpportunity(next.id);
        });
    }, IDLE_MS);
  };
  useEffect(() => {
    mounted.current = true;
    const opportunities = subscribeReviewOpportunities(() => reconcile.current());
    const app = AppState.addEventListener("change", (state) => {
      if (!mounted.current) return;
      native.current.app = state;
      if (state !== "active") cancel();
      else reconcile.current();
    });
    const blur =
      Platform.OS === "android"
        ? AppState.addEventListener("blur", () => {
            if (!mounted.current) return;
            native.current.windowFocused = false;
            cancel();
          })
        : null;
    const focus =
      Platform.OS === "android"
        ? AppState.addEventListener("focus", () => {
            if (!mounted.current) return;
            native.current.windowFocused = true;
            reconcile.current();
          })
        : null;
    const shown = () => {
      if (!mounted.current) return;
      native.current.keyboard = true;
      cancel();
    };
    const hidden = () => {
      if (!mounted.current) return;
      native.current.keyboard = false;
      reconcile.current();
    };
    const keyboard = [
      Keyboard.addListener("keyboardWillShow", shown),
      Keyboard.addListener("keyboardDidShow", shown),
      Keyboard.addListener("keyboardWillHide", hidden),
      Keyboard.addListener("keyboardDidHide", hidden),
    ];
    return () => {
      mounted.current = false;
      cancel();
      opportunities();
      app.remove();
      blur?.remove();
      focus?.remove();
      keyboard.forEach((listener) => listener.remove());
    };
  }, [cancel]);
  const previousContext = useRef(context);
  useEffect(() => {
    if (contextKey(previousContext.current) !== key && previousContext.current) {
      const old = getReviewOpportunity(previousContext.current);
      if (old) dismissReviewOpportunity(old);
    }
    previousContext.current = context;
    reconcile.current();
  }, [key, epoch]);
  return useCallback(() => {
    if (mounted.current) cancel();
  }, [cancel]);
}
