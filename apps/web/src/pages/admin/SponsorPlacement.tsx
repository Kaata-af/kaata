import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { BACKEND_URL } from "../../env";
import type { Lang } from "../../lib/language";
import {
  ConflictError,
  saveSponsorPlacement,
  sponsorPlacementKey,
  uploadSponsorImage,
  useAdminToken,
  useSponsorPlacement,
  validSponsorUrl,
  type SponsorPlacement as Placement,
  type SponsorSlide,
} from "./api";
import { Card, ErrorCard, SkeletonCard } from "./ui";

const MAX_SLIDES = 8;
const LANGUAGES = { en: "English", fa: "Dari", ps: "Pashto" } satisfies Record<Lang, string>;
const languageCodes = Object.keys(LANGUAGES) as Lang[];
const fieldClass = "block min-w-0 space-y-1.5 text-sm font-medium text-brand-ink";

type Editor = { kind: "button" | "banner" | "rotation"; placement: Placement };

export function SponsorPlacement() {
  const token = useAdminToken();
  const client = useQueryClient();
  const query = useSponsorPlacement();
  const [language, setLanguage] = useState<Lang>("en");
  const [editor, setEditor] = useState<Editor | null>(null);
  const [notice, setNotice] = useState("");
  const save = useMutation({
    mutationFn: (placement: Placement) => saveSponsorPlacement(token, placement),
    onSuccess: (placement) => {
      client.setQueryData(sponsorPlacementKey(token), placement);
      setNotice("Placement settings saved.");
      setEditor(null);
    },
    onSettled: () => client.invalidateQueries({ queryKey: sponsorPlacementKey(token) }),
  });
  const placement = query.data;

  if (!placement?.locales) {
    return query.isError || placement ? (
      <ErrorCard
        message={
          query.error?.message ?? "Language settings are unavailable. Refresh and try again."
        }
        onRetry={() => void query.refetch()}
      />
    ) : (
      <SkeletonCard lines={3} />
    );
  }

  const { button, banner, locales } = placement;
  const localized = locales[language];
  const languageName = LANGUAGES[language];
  const hasSlides = Object.values(locales).some((settings) => settings.slides.length > 0);
  const busy = save.isPending;
  const locked = busy || Boolean(editor) || query.isError;

  function edit(kind: Editor["kind"]) {
    if (!placement) return;
    save.reset();
    setNotice("");
    setEditor({ kind, placement });
  }

  function cancel() {
    save.reset();
    setEditor(null);
  }

  function publish(next: Placement) {
    setNotice("");
    save.mutate(next);
  }

  return (
    <>
      {notice ? (
        <p role="status" className="text-sm font-medium text-emerald-700">
          {notice}
        </p>
      ) : null}
      {query.isError ? (
        <ErrorCard
          message={`Couldn’t refresh the home placements. ${query.error.message}`}
          onRetry={() => void query.refetch()}
        />
      ) : null}
      {save.error ? (
        <p role="alert" className="text-sm text-red-700">
          {save.error instanceof ConflictError && editor
            ? "These settings changed while you were editing. Close the editor and reopen it to use the latest settings."
            : save.error.message}
        </p>
      ) : null}
      <Card
        title="All languages"
        sub="Visibility and rotation apply across English, Dari, and Pashto."
      >
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={locked}
            onClick={() =>
              publish({ ...placement, button: { ...button, enabled: !button.enabled } })
            }
          >
            {button.enabled ? "Hide promotion button" : "Show promotion button"}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={locked || (!banner.enabled && !hasSlides)}
            onClick={() =>
              publish({ ...placement, banner: { ...banner, enabled: !banner.enabled } })
            }
          >
            {banner.enabled ? "Hide banner" : "Show banner"}
          </Button>
        </div>
        {!banner.enabled && !hasSlides ? (
          <p className="mt-2 text-sm text-brand-muted">
            Add a slide in any language to turn on the banner.
          </p>
        ) : null}
        {editor?.kind === "rotation" ? (
          <RotationEditor
            seconds={editor.placement.banner.rotation_seconds}
            busy={busy}
            onCancel={cancel}
            onSave={(rotation_seconds) =>
              publish({
                ...editor.placement,
                banner: { ...editor.placement.banner, rotation_seconds },
              })
            }
          />
        ) : (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-brand-muted">
            <span>Rotate every {banner.rotation_seconds} seconds</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={locked}
              onClick={() => edit("rotation")}
            >
              Change timing
            </Button>
          </div>
        )}
      </Card>
      <div role="group" aria-label="App language" className="flex flex-wrap gap-2">
        {languageCodes.map((code) => (
          <Button
            key={code}
            type="button"
            variant={language === code ? "default" : "outline"}
            aria-pressed={language === code}
            disabled={Boolean(editor) || busy}
            onClick={() => {
              setLanguage(code);
              save.reset();
              setNotice("");
            }}
          >
            {LANGUAGES[code]}
          </Button>
        ))}
      </div>
      <Card
        title="Promotion button"
        sub={`Set the label for ${languageName}. The button opens the promotion proposal form.`}
      >
        {editor?.kind === "button" ? (
          <ButtonEditor
            label={editor.placement.locales[language].button_label}
            language={language}
            busy={busy}
            onCancel={cancel}
            onSave={(button_label) =>
              publish({
                ...editor.placement,
                locales: {
                  ...editor.placement.locales,
                  [language]: { ...editor.placement.locales[language], button_label },
                },
              })
            }
          />
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p
              dir="auto"
              lang={localized.button_label ? language : undefined}
              className="min-w-0 text-sm text-brand-ink [overflow-wrap:anywhere]"
            >
              {localized.button_label || "Default app label"}
            </p>
            <Button
              type="button"
              variant="outline"
              disabled={locked}
              onClick={() => edit("button")}
            >
              Edit label
            </Button>
          </div>
        )}
      </Card>
      <Card
        title="Home ad banner"
        sub={`Images and links for ${languageName} · Mobile Leaderboard, 320 × 50.`}
      >
        {editor?.kind === "banner" ? (
          <BannerEditor
            artwork={editor.placement.locales[language].slides}
            hidesBanner={
              editor.placement.banner.enabled &&
              languageCodes.every(
                (code) => code === language || editor.placement.locales[code].slides.length === 0,
              )
            }
            busy={busy}
            onCancel={cancel}
            onSave={(slides) => {
              const nextLocales = {
                ...editor.placement.locales,
                [language]: { ...editor.placement.locales[language], slides },
              };
              publish({
                ...editor.placement,
                banner: {
                  ...editor.placement.banner,
                  enabled:
                    editor.placement.banner.enabled &&
                    Object.values(nextLocales).some((settings) => settings.slides.length > 0),
                },
                locales: nextLocales,
              });
            }}
          />
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-brand-ink">
                {localized.slides.length === 0
                  ? `No banner for ${languageName}`
                  : `${localized.slides.length} ${localized.slides.length === 1 ? "image" : "images"}`}
              </p>
              {localized.slides[0] ? (
                <BannerPreview
                  image={localized.slides[0].image_url}
                  position={1}
                  className="mt-3"
                />
              ) : null}
            </div>
            <Button
              type="button"
              variant="outline"
              disabled={locked}
              onClick={() => edit("banner")}
            >
              Edit carousel
            </Button>
          </div>
        )}
      </Card>
    </>
  );
}

function RotationEditor({
  seconds,
  busy,
  onCancel,
  onSave,
}: {
  seconds: number;
  busy: boolean;
  onCancel: () => void;
  onSave: (seconds: number) => void;
}) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    onSave(Number(new FormData(event.currentTarget).get("rotation_seconds")));
  }

  return (
    <form onSubmit={submit} className="mt-4 flex flex-wrap items-end gap-2">
      <label className={`${fieldClass} max-w-40`}>
        <span>Seconds per slide</span>
        <Input
          name="rotation_seconds"
          type="number"
          min={3}
          max={30}
          step={1}
          defaultValue={seconds}
          required
          disabled={busy}
          autoFocus
        />
      </label>
      <Button type="submit" disabled={busy}>
        Save timing
      </Button>
      <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
        Cancel
      </Button>
    </form>
  );
}

function ButtonEditor({
  label,
  language,
  busy,
  onCancel,
  onSave,
}: {
  label: string;
  language: Lang;
  busy: boolean;
  onCancel: () => void;
  onSave: (label: string) => void;
}) {
  const [error, setError] = useState("");

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const label = String(new FormData(event.currentTarget).get("label") ?? "").trim();
    if (Array.from(label).length > 32) {
      setError("The label can have up to 32 characters.");
      return;
    }
    setError("");
    onSave(label);
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <label className={`${fieldClass} max-w-sm`}>
        <span>Button label</span>
        <Input
          name="label"
          defaultValue={label}
          dir="auto"
          lang={language}
          disabled={busy}
          autoFocus
        />
        <span className="block text-xs font-normal text-brand-muted">
          Leave blank to use Kaata’s default {LANGUAGES[language]} label.
        </span>
      </label>
      {error ? (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy}>
          Save label
        </Button>
        <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function BannerEditor({
  artwork,
  hidesBanner,
  busy,
  onCancel,
  onSave,
}: {
  artwork: SponsorSlide[];
  hidesBanner: boolean;
  busy: boolean;
  onCancel: () => void;
  onSave: (slides: SponsorSlide[]) => void;
}) {
  const token = useAdminToken();
  const [slides, setSlides] = useState(() => artwork.map((slide, key) => ({ ...slide, key })));
  const [error, setError] = useState("");
  const nextKey = useRef(slides.length);
  const upload = useMutation({
    mutationFn: (file: File) => uploadSponsorImage(token, file),
    onSuccess: ({ image_url }) => {
      const key = nextKey.current++;
      setSlides((current) => [...current, { image_url, destination_url: "", key }]);
    },
  });
  const locked = busy || upload.isPending;

  function selectImage(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file || locked || slides.length >= MAX_SLIDES) return;
    upload.reset();
    if (
      (file.type && file.type !== "image/png" && file.type !== "image/jpeg") ||
      file.size > 1_048_576
    ) {
      setError("Choose a PNG or JPEG image no larger than 1 MB.");
      return;
    }
    setError("");
    upload.mutate(file);
  }

  function moveSlide(position: number, direction: -1 | 1) {
    setSlides((current) => {
      const next = [...current];
      const target = position + direction;
      [next[position], next[target]] = [next[target], next[position]];
      return next;
    });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (locked) return;
    const cleaned = slides.map(({ image_url, destination_url }) => ({
      image_url,
      destination_url: destination_url.trim(),
    }));
    if (cleaned.some((slide) => !validSponsorUrl(slide.destination_url))) {
      setError("Enter a valid HTTP or HTTPS destination for every image.");
      return;
    }
    setError("");
    onSave(cleaned);
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <fieldset disabled={locked} className="space-y-4">
        {slides.length > 0 ? (
          <ol className="space-y-3">
            {slides.map((slide, position) => (
              <li
                key={slide.key}
                className="grid min-w-0 gap-3 rounded-lg border border-brand-border p-3 lg:grid-cols-[minmax(0,320px)_1fr]"
              >
                <div className="min-w-0 space-y-2">
                  <p className="text-sm font-medium text-brand-ink">Slide {position + 1}</p>
                  <BannerPreview image={slide.image_url} position={position + 1} />
                </div>
                <div className="min-w-0 space-y-2">
                  <label className={fieldClass}>
                    <span>Destination link</span>
                    <Input
                      type="url"
                      placeholder="https://"
                      dir="ltr"
                      required
                      value={slide.destination_url}
                      onChange={(event) => {
                        const value = event.currentTarget.value;
                        setSlides((current) =>
                          current.map((item) =>
                            item.key === slide.key ? { ...item, destination_url: value } : item,
                          ),
                        );
                      }}
                    />
                  </label>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={position === 0}
                      aria-label={`Move slide ${position + 1} earlier`}
                      onClick={() => moveSlide(position, -1)}
                    >
                      Move earlier
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={position === slides.length - 1}
                      aria-label={`Move slide ${position + 1} later`}
                      onClick={() => moveSlide(position, 1)}
                    >
                      Move later
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-label={`Remove slide ${position + 1}`}
                      onClick={() =>
                        setSlides((current) => current.filter((item) => item.key !== slide.key))
                      }
                    >
                      Remove
                    </Button>
                  </div>
                </div>
              </li>
            ))}
          </ol>
        ) : null}
        <label className={`${fieldClass} max-w-sm`}>
          <span>Upload image</span>
          <Input
            type="file"
            accept="image/png,image/jpeg,.png,.jpg,.jpeg"
            disabled={slides.length >= MAX_SLIDES}
            onChange={selectImage}
          />
          <span className="block text-xs font-normal text-brand-muted">
            PNG or JPEG, up to 1 MB. Use 320 × 50, 640 × 100, or 960 × 150 pixels.
          </span>
          {slides.length >= MAX_SLIDES ? (
            <span className="block text-xs font-normal text-brand-muted">
              The carousel holds up to {MAX_SLIDES} images.
            </span>
          ) : null}
        </label>
      </fieldset>
      {upload.isPending ? (
        <p role="status" className="text-sm text-brand-muted">
          Uploading image…
        </p>
      ) : null}
      {error || upload.error ? (
        <p role="alert" className="text-sm text-red-700">
          {error || upload.error?.message}
        </p>
      ) : null}
      {slides.length === 0 ? (
        <p className="text-sm text-brand-muted">
          {hidesBanner
            ? "Saving will hide the banner in all languages because no slides will remain."
            : "Users who choose this language won’t see a banner."}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={locked}>
          Save carousel
        </Button>
        <Button type="button" variant="outline" disabled={locked} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function BannerPreview({
  image,
  position,
  className = "",
}: {
  image: string;
  position: number;
  className?: string;
}) {
  return (
    <img
      src={`${BACKEND_URL}${image}`}
      alt={`Banner image for slide ${position}`}
      width={320}
      height={50}
      className={`block h-auto max-w-full bg-brand-ivory ${className}`}
    />
  );
}
