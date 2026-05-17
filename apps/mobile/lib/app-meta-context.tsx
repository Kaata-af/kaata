import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";
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
      await setAppMeta("last_checkin_at", String(Date.now()));
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
