import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { rotateSessionJWT } from "./auth";
import { getAppMeta, setAppMeta } from "./db";
import type { CheckInResponse } from "./types";

type Update = CheckInResponse["update"];
type Announcement = CheckInResponse["announcement"];

type AppMetaState = {
  update: Update;
  announcement: Announcement;
  currentVersion: string;
  forceUpdate: boolean;
  applyCheckIn: (resp: CheckInResponse) => Promise<void>;
  refresh: () => Promise<void>;
};

const Ctx = createContext<AppMetaState | null>(null);

export function AppMetaProvider(props: { currentVersion: string; children: ReactNode }) {
  const { currentVersion } = props;
  const [update, setUpdate] = useState<Update>(null);
  const [announcement, setAnnouncement] = useState<Announcement>(null);
  const [forceUpdate, setForceUpdate] = useState(false);

  const refresh = useCallback(async () => {
    const latestVersion = await getAppMeta("latest_known_version");
    const apkUrl = await getAppMeta("latest_known_apk_url");
    const playStoreUrl = await getAppMeta("latest_known_play_store_url");
    const releaseNotes = await getAppMeta("latest_known_release_notes");
    const dismissedUpdate = await getAppMeta("dismissed_update_version");

    if (latestVersion && latestVersion !== dismissedUpdate && latestVersion !== currentVersion) {
      setUpdate({
        version: latestVersion,
        apk_url: apkUrl,
        play_store_url: playStoreUrl,
        release_notes: releaseNotes,
      });
    } else {
      setUpdate(null);
    }

    const annId = await getAppMeta("latest_announcement_id");
    const annTitle = await getAppMeta("latest_announcement_title");
    const annBody = await getAppMeta("latest_announcement_body");
    const annCtaLabel = await getAppMeta("latest_announcement_cta_label");
    const annCtaUrl = await getAppMeta("latest_announcement_cta_url");
    const dismissedAnn = await getAppMeta("dismissed_announcement_id");

    if (annId && annTitle && annBody && annId !== dismissedAnn) {
      setAnnouncement({
        id: Number(annId),
        title: annTitle,
        body: annBody,
        cta_label: annCtaLabel,
        cta_url: annCtaUrl,
      });
    } else {
      setAnnouncement(null);
    }
  }, [currentVersion]);

  const applyCheckIn = useCallback(
    async (resp: CheckInResponse) => {
      if (resp.update) {
        await setAppMeta("latest_known_version", resp.update.version);
        if (resp.update.apk_url) await setAppMeta("latest_known_apk_url", resp.update.apk_url);
        if (resp.update.play_store_url)
          await setAppMeta("latest_known_play_store_url", resp.update.play_store_url);
        if (resp.update.release_notes)
          await setAppMeta("latest_known_release_notes", resp.update.release_notes);
      }
      if (resp.announcement) {
        await setAppMeta("latest_announcement_id", String(resp.announcement.id));
        await setAppMeta("latest_announcement_title", resp.announcement.title);
        await setAppMeta("latest_announcement_body", resp.announcement.body);
        if (resp.announcement.cta_label)
          await setAppMeta("latest_announcement_cta_label", resp.announcement.cta_label);
        if (resp.announcement.cta_url)
          await setAppMeta("latest_announcement_cta_url", resp.announcement.cta_url);
      }
      // Soft-migration: persist (or clear) the override so the next check-in
      // talks to the new backend. Omitted/null = leave the current setting
      // alone; "" = clear back to env default; any other string = use it.
      if (resp.migrate_to_backend_url != null) {
        await setAppMeta("backend_url_override", resp.migrate_to_backend_url);
      }
      // #43 P2 background-mesh kill-switch. Persist to app_meta (JS reads it) AND
      // mirror to native SharedPrefs (KaataBgMeshGate) so the killed-app
      // background entry can read it with a plain Service Context — the JS DB
      // isn't natively readable and appContext is dead post-kill. Omitted/null =
      // leave as-is (the live fleet defaults OFF until the backend flips it).
      if (resp.bg_mesh_enabled != null) {
        await setAppMeta("bg_mesh_enabled", resp.bg_mesh_enabled ? "1" : "0");
        try {
          const bt = await import("../modules/kaata-bt-classic");
          await bt.setBgMeshEnabled(resp.bg_mesh_enabled);
        } catch (err) {
          // native mirror is best-effort; the JS app_meta copy still governs the
          // JS-side re-check, and the next check-in retries the mirror.
          if (__DEV__) console.warn("[app-meta] setBgMeshEnabled mirror failed", err);
        }
      }
      // Rolling JWT refresh: backend opts to mint a fresh token whenever the
      // incoming one is past auth.RefreshIfOlderThan. Silent persist to
      // SecureStore; no UI surface. Skipped silently when absent / blank.
      if (resp.session_jwt_refresh && resp.session_jwt_refresh.length > 0) {
        try {
          await rotateSessionJWT(resp.session_jwt_refresh);
        } catch (err) {
          // SecureStore can fail on extremely-low-storage devices; the next
          // check-in will just hand us another refresh and we try again.
          console.warn("[app-meta] rotateSessionJWT failed", err);
        }
      }
      // Phase 4.1: heartbeat for the "different account on this phone?"
      // prompt. Only refresh when there's a binding to time-window;
      // otherwise the value stays absent and the prompt never fires on
      // a fresh install.
      const boundSub = await getAppMeta("account_google_sub");
      if (boundSub) {
        await setAppMeta("account_last_seen_at", String(Date.now()));
      }
      await setAppMeta("last_checkin_at", String(Date.now()));

      // Mesh (M4): pin the server WITNESS pubkey announcement and merge new
      // revocations. Both fields are optional. Dynamic imports keep the
      // module cost off cold-boot paths that don't need mesh. Order: pin
      // pubkeys FIRST (so a revocation arriving in the same response is
      // applied under the current pin), then revocations. Failures are
      // logged and don't propagate — mesh is best-effort relative to
      // check-in. (VMC renewals are retired — the chain carries trust.)
      if (resp.mesh_server_pubkeys?.primary) {
        try {
          const { persistPinnedServerPubkeys } = await import("./trust/proof");
          await persistPinnedServerPubkeys(
            resp.mesh_server_pubkeys.primary,
            resp.mesh_server_pubkeys.rotation ?? null,
          );
        } catch (err) {
          console.warn("[app-meta] persistPinnedServerPubkeys failed", err);
        }
      }
      if (resp.revocations && resp.revocations.length > 0) {
        try {
          const { applyServerRevocations } = await import("./trust/revocation");
          await applyServerRevocations(resp.revocations);
        } catch (err) {
          console.warn("[app-meta] applyServerRevocations failed", err);
        }
      }

      setForceUpdate(resp.force_update);
      await refresh();
    },
    [refresh],
  );

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <Ctx.Provider
      value={{ update, announcement, forceUpdate, currentVersion, applyCheckIn, refresh }}
    >
      {props.children}
    </Ctx.Provider>
  );
}

export function useAppMeta(): AppMetaState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAppMeta must be inside AppMetaProvider");
  return ctx;
}
