import { useEffect, useId, useRef, useSyncExternalStore } from "react";
import { Button } from "../../components/ui/button";
import { useI18n, type Lang } from "../../lib/i18n";
import { isSameWebSession, type WebSession } from "../../lib/web-auth";
import { createWebDiscoveryFlow, type WebDiscoveryState } from "../../lib/web-discovery-flow";
import { webProfileCopy } from "./web-profile-copy";

export function WebDiscoverySetting({
  session,
  online,
  disabled,
  onBusyChange,
}: {
  session: WebSession;
  online: boolean;
  disabled: boolean;
  onBusyChange: (saving: boolean) => void;
}) {
  const { lang } = useI18n();
  const onlineRef = useRef(online);
  onlineRef.current = online;
  const owner = useRef<{
    session: WebSession;
    flow: ReturnType<typeof createWebDiscoveryFlow>;
  } | null>(null);
  if (!owner.current || !isSameWebSession(owner.current.session, session))
    owner.current = {
      session,
      flow: createWebDiscoveryFlow(session, { online: () => onlineRef.current }),
    };
  const flow = owner.current.flow;
  const state = useSyncExternalStore(flow.subscribe, flow.getState, flow.getState);
  useEffect(() => {
    flow.start();
    return () => flow.stop();
  }, [flow]);
  useEffect(() => {
    if (online) flow.recover();
  }, [flow, online]);
  useEffect(() => onBusyChange(state.saving), [onBusyChange, state.saving]);
  return (
    <WebDiscoveryControl
      state={state}
      lang={lang}
      online={online}
      disabled={disabled}
      onChange={(enabled) => void flow.save(enabled)}
      onRetry={() => void flow.load()}
    />
  );
}

export function WebDiscoveryControl({
  state,
  lang,
  online,
  disabled,
  onChange,
  onRetry,
}: {
  state: WebDiscoveryState;
  lang: Lang;
  online: boolean;
  disabled: boolean;
  onChange: (enabled: boolean) => void;
  onRetry: () => void;
}) {
  const c = webProfileCopy[lang];
  const id = useId();
  return (
    <section
      className="web-profile-discovery"
      aria-labelledby={`${id}-label`}
      aria-busy={state.saving}
    >
      <div className="web-profile-discovery-row">
        <h3 id={`${id}-label`}>{c.discoveryLabel}</h3>
        {state.enabled !== null && (
          <button
            type="button"
            role="switch"
            className="web-profile-discovery-switch"
            aria-checked={state.enabled}
            aria-labelledby={`${id}-label`}
            aria-describedby={`${id}-hint`}
            disabled={disabled || !online || state.loading || state.saving}
            onClick={() => onChange(!state.enabled)}
          >
            <span aria-hidden="true" className="web-profile-discovery-track">
              <span />
            </span>
          </button>
        )}
      </div>
      <p className="web-profile-hint" id={`${id}-hint`}>
        {c.discoveryHint}
      </p>
      {!online ? (
        <p className="web-profile-hint" role="status">
          {c.discoveryOffline}
        </p>
      ) : state.loading ? (
        <p className="web-profile-hint" role="status">
          {c.discoveryLoading}
        </p>
      ) : state.saving ? (
        <p className="web-profile-hint" role="status">
          {c.saving}
        </p>
      ) : state.error ? (
        <div>
          <p className="web-profile-error" role="alert">
            {state.error === "save" ? c.discoverySaveError : c.discoveryLoadError}
          </p>
          <Button type="button" variant="ghost" disabled={disabled} onClick={onRetry}>
            {c.discoveryRetry}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
