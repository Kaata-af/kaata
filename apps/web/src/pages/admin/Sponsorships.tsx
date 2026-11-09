import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import {
  saveSponsorCampaign,
  sponsorCampaignsKey,
  useAdminToken,
  useSponsorCampaigns,
  validSponsorUrl,
  type SponsorCampaign,
  type SponsorCampaignInput,
} from "./api";
import { SponsorPlacement } from "./SponsorPlacement";
import { Card, ErrorCard, PageHeader, SkeletonCard } from "./ui";

const localTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const scheduleFormat = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
});
const fieldClass = "min-w-0 space-y-1.5 text-sm font-medium text-brand-ink";
const textFields = [
  { name: "sponsor", label: "Sponsor name", limit: 80 },
  { name: "title", label: "Banner title", limit: 100 },
  { name: "body", label: "Banner text", limit: 180 },
  { name: "cta_label", label: "Button label (optional)", limit: 32 },
] as const;

function localDateTime(date: Date) {
  const wallTime = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return wallTime.toISOString().slice(0, 16);
}

function readSchedule(value: string, original?: string) {
  // Preserve the exact timestamp when editing other fields. The picker shows
  // minutes and cannot distinguish the two occurrences of a repeated local hour.
  if (original && localDateTime(new Date(original)) === value) return original;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || localDateTime(date) !== value) return null;
  return date.toISOString();
}

function campaignStatus(campaign: SponsorCampaign, now: number, liveId: number) {
  if (Date.parse(campaign.ends_at) <= now) return "Ended";
  if (!campaign.is_active) return "Paused";
  if (Date.parse(campaign.starts_at) > now) return "Scheduled";
  return campaign.id === liveId ? "Live" : "Overlapping";
}

export function Sponsorships() {
  return (
    <div className="min-w-0 max-w-full">
      <PageHeader
        title="Sponsorships"
        description="Manage the promotion button and image ads on Kaata’s mobile home screen."
      />
      <div className="flex min-w-0 flex-col gap-4">
        <SponsorPlacement />
        <LegacyCampaigns />
      </div>
    </div>
  );
}

function LegacyCampaigns() {
  const token = useAdminToken();
  const client = useQueryClient();
  const query = useSponsorCampaigns();
  const [editor, setEditor] = useState<SponsorCampaign | "new" | null>(null);
  const [notice, setNotice] = useState("");
  const save = useMutation({
    mutationFn: ({
      campaign,
      input,
    }: {
      campaign?: SponsorCampaign;
      input: SponsorCampaignInput;
    }) => saveSponsorCampaign(token, input, campaign),
    onSuccess: (campaign) => {
      setEditor(null);
      setNotice(campaign.is_active ? "Campaign saved and enabled." : "Campaign saved and paused.");
    },
    // Also refresh after an ambiguous connection failure. An automatic write
    // retry could create another campaign after the first request succeeded.
    onSettled: () => client.invalidateQueries({ queryKey: sponsorCampaignsKey(token) }),
  });

  function openEditor(campaign: SponsorCampaign | "new" | null) {
    save.reset();
    setNotice("");
    setEditor(campaign);
  }

  function toggle(campaign: SponsorCampaign) {
    const { id, created_at, updated_at, ...input } = campaign;
    setNotice("");
    save.mutate({ campaign, input: { ...input, is_active: !campaign.is_active } });
  }

  // Read dataUpdatedAt so status advances with polling even if the campaigns
  // have not changed. The latest ID wins when enabled schedules overlap.
  const now = Math.max(query.dataUpdatedAt, Date.now());
  const campaigns = query.data?.campaigns ?? [];
  const liveId = campaigns.reduce(
    (id, campaign) =>
      campaign.is_active &&
      Date.parse(campaign.starts_at) <= now &&
      Date.parse(campaign.ends_at) > now
        ? Math.max(id, campaign.id)
        : id,
    0,
  );
  const error = save.error?.message;

  return (
    <details className="min-w-0">
      <summary className="cursor-pointer text-sm font-medium text-brand-ink">
        Legacy scheduled campaigns
      </summary>
      <div className="mt-3 flex min-w-0 flex-col gap-4">
        {notice ? (
          <p role="status" className="text-sm font-medium text-emerald-700">
            {notice}
          </p>
        ) : null}
        {editor ? (
          <CampaignEditor
            key={editor === "new" ? "new" : editor.id}
            campaign={editor === "new" ? undefined : editor}
            busy={save.isPending}
            saveError={error}
            onCancel={() => openEditor(null)}
            onSave={(input) =>
              save.mutate({ campaign: editor === "new" ? undefined : editor, input })
            }
          />
        ) : error ? (
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
        ) : null}
        {query.isPending ? (
          <SkeletonCard lines={3} />
        ) : query.isError ? (
          <ErrorCard
            message={`Couldn’t load sponsorships. ${query.error.message}`}
            onRetry={() => void query.refetch()}
          />
        ) : (
          <Card
            title="Campaigns"
            sub={`Schedules use your local time (${localTimeZone}). When schedules overlap, the newest enabled campaign appears.`}
            action={
              <Button
                disabled={Boolean(editor) || save.isPending}
                onClick={() => openEditor("new")}
              >
                New campaign
              </Button>
            }
          >
            {campaigns.length === 0 ? (
              <p className="text-sm text-brand-muted">No sponsorship campaigns yet.</p>
            ) : (
              <ul className="divide-y divide-brand-faint">
                {campaigns.map((campaign) => {
                  const status = campaignStatus(campaign, now, liveId);
                  return (
                    <li
                      key={campaign.id}
                      className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
                    >
                      <div className="min-w-0">
                        <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-brand-ink">
                          <span dir="auto" className="min-w-0 [overflow-wrap:anywhere]">
                            {campaign.sponsor}
                          </span>
                          <span
                            className={`rounded-full px-2 py-0.5 text-xs ${status === "Live" ? "bg-emerald-50 text-emerald-800" : "bg-brand-ivory text-brand-sub"}`}
                          >
                            {status}
                          </span>
                        </p>
                        <p dir="auto" className="mt-1 break-words text-sm text-brand-sub">
                          {campaign.title}
                        </p>
                        <p className="mt-1 text-xs text-brand-muted">
                          {scheduleFormat.format(new Date(campaign.starts_at))} –{" "}
                          {scheduleFormat.format(new Date(campaign.ends_at))}
                        </p>
                      </div>
                      <div className="flex shrink-0 flex-wrap gap-2">
                        <Button
                          variant="outline"
                          aria-label={`Edit campaign for ${campaign.sponsor}`}
                          disabled={Boolean(editor) || save.isPending}
                          onClick={() => openEditor(campaign)}
                        >
                          Edit
                        </Button>
                        {status !== "Ended" ? (
                          <Button
                            variant="outline"
                            aria-label={`${campaign.is_active ? "Pause" : "Enable"} campaign for ${campaign.sponsor}`}
                            disabled={Boolean(editor) || save.isPending}
                            onClick={() => toggle(campaign)}
                          >
                            {campaign.is_active ? "Pause" : "Enable"}
                          </Button>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        )}
      </div>
    </details>
  );
}

function CampaignEditor({
  campaign,
  busy,
  saveError,
  onCancel,
  onSave,
}: {
  campaign?: SponsorCampaign;
  busy: boolean;
  saveError?: string;
  onCancel: () => void;
  onSave: (input: SponsorCampaignInput) => void;
}) {
  const [validationError, setValidationError] = useState("");

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const read = (name: string) => String(form.get(name) ?? "").trim();
    for (const { name, label, limit } of textFields) {
      const value = read(name);
      if (name !== "cta_label" && !value) {
        setValidationError(`${label} is required.`);
        return;
      }
      if (Array.from(value).length > limit) {
        setValidationError(
          `${label.replace(" (optional)", "")} can have up to ${limit} characters.`,
        );
        return;
      }
    }
    const image = read("image_url");
    const ctaLabel = read("cta_label");
    const ctaUrl = read("cta_url");
    const startsAt = readSchedule(read("starts_at"), campaign?.starts_at);
    const endsAt = readSchedule(read("ends_at"), campaign?.ends_at);
    if (image && !validSponsorUrl(image, true)) {
      setValidationError("Enter a valid HTTPS image URL up to 2,048 bytes.");
      return;
    }
    if (Boolean(ctaLabel) !== Boolean(ctaUrl) || (ctaUrl && !validSponsorUrl(ctaUrl))) {
      setValidationError(
        "Provide both a button label and a valid HTTP or HTTPS URL, or leave both blank.",
      );
      return;
    }
    if (!startsAt || !endsAt || Date.parse(endsAt) <= Date.parse(startsAt)) {
      setValidationError("Choose valid local times with the end after the start.");
      return;
    }
    setValidationError("");
    onSave({
      sponsor: read("sponsor"),
      title: read("title"),
      body: read("body"),
      image_url: image || null,
      cta_label: ctaLabel || null,
      cta_url: ctaUrl || null,
      starts_at: startsAt,
      ends_at: endsAt,
      is_active: form.has("is_active"),
    });
  }

  return (
    <Card
      title={campaign ? "Edit sponsorship" : "New sponsorship"}
      sub={`Start and end times use your local time (${localTimeZone}).`}
    >
      <form onSubmit={submit}>
        <fieldset disabled={busy} className="grid min-w-0 gap-4 sm:grid-cols-2">
          {textFields.slice(0, 3).map(({ name, label }) => (
            <label key={name} className={`${fieldClass} ${name === "body" ? "sm:col-span-2" : ""}`}>
              <span>{label}</span>
              <Input
                name={name}
                defaultValue={campaign?.[name] ?? ""}
                dir="auto"
                required
                autoFocus={name === "sponsor"}
              />
            </label>
          ))}
          <label className={`${fieldClass} sm:col-span-2`}>
            <span>Image URL (optional)</span>
            <Input
              name="image_url"
              type="url"
              placeholder="https://"
              defaultValue={campaign?.image_url ?? ""}
            />
          </label>
          <label className={fieldClass}>
            <span>Button label (optional)</span>
            <Input name="cta_label" defaultValue={campaign?.cta_label ?? ""} dir="auto" />
          </label>
          <label className={fieldClass}>
            <span>Button URL (optional)</span>
            <Input
              name="cta_url"
              type="url"
              placeholder="https://"
              defaultValue={campaign?.cta_url ?? ""}
            />
          </label>
          <label className={fieldClass}>
            <span>Starts</span>
            <Input
              name="starts_at"
              type="datetime-local"
              defaultValue={campaign ? localDateTime(new Date(campaign.starts_at)) : ""}
              required
            />
          </label>
          <label className={fieldClass}>
            <span>Ends</span>
            <Input
              name="ends_at"
              type="datetime-local"
              defaultValue={campaign ? localDateTime(new Date(campaign.ends_at)) : ""}
              required
            />
          </label>
          <label className="flex items-center gap-2 text-sm text-brand-ink sm:col-span-2">
            <input
              name="is_active"
              type="checkbox"
              defaultChecked={campaign?.is_active ?? false}
              className="h-4 w-4 shrink-0 accent-brand-primary"
            />
            Enable during the scheduled dates
          </label>
        </fieldset>
        {validationError || saveError ? (
          <p role="alert" className="mt-3 text-sm text-red-700">
            {validationError || saveError}
          </p>
        ) : null}
        <div className="mt-4 flex flex-wrap gap-2">
          <Button type="submit" disabled={busy}>
            {busy ? "Saving…" : "Save campaign"}
          </Button>
          <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}
