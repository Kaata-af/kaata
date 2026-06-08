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

      // Phase 5 mesh: apply pinned pubkey announcement, cache fresh VMC
      // renewals, and merge new revocations. All three fields are
      // optional; the helper no-ops on absence. Dynamic import keeps the
      // @noble SHA-512 wiring cost off cold-boot paths that don't need
      // mesh. Failures inside applyVMCCheckInResponse are already logged
      // and don't propagate — mesh is best-effort relative to check-in.
      if (resp.vmc_renewals || resp.revocations || resp.mesh_server_pubkeys) {
        try {
          const mesh = await import("./mesh");
          await mesh.applyVMCCheckInResponse({
            vmc_renewals: resp.vmc_renewals ?? undefined,
            revocations: resp.revocations ?? undefined,
            mesh_server_pubkeys: resp.mesh_server_pubkeys ?? undefined,
          });
        } catch (err) {
          console.warn("[app-meta] applyVMCCheckInResponse failed", err);
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
