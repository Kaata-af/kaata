import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { BACKEND_URL } from "../../env";
import {
  ConflictError,
  saveSponsorPlacement,
  sponsorPlacementKey,
  uploadSponsorImage,
  useAdminToken,
  useSponsorPlacement,
  validSponsorUrl,
  type SponsorPlacement as Placement,
} from "./api";
import { Card, ErrorCard, SkeletonCard } from "./ui";

const MAX_SLIDES = 8;
const fieldClass = "block min-w-0 space-y-1.5 text-sm font-medium text-brand-ink";

type Editor = { kind: "button" | "banner"; placement: Placement };

export function SponsorPlacement() {
  const token = useAdminToken();
  const client = useQueryClient();
  const query = useSponsorPlacement();
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

  if (!placement) {
    return query.isError ? (
      <ErrorCard
        message={`Couldn’t load the home placements. ${query.error.message}`}
        onRetry={() => void query.refetch()}
      />
    ) : (
      <SkeletonCard lines={3} />
    );
  }

  const { button, banner } = placement;
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
        title="Promotion button"
        sub="Opens the promotion proposal form. Its visibility is independent of the banner."
      >
        {editor?.kind === "button" ? (
          <ButtonEditor
            button={editor.placement.button}
            busy={busy}
            onCancel={cancel}
            onSave={(label) =>
              publish({ ...editor.placement, button: { ...editor.placement.button, label } })
            }
          />
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-brand-ink">
                {button.enabled ? "Shown on home" : "Hidden"}
              </p>
              <p dir="auto" className="mt-1 text-sm text-brand-muted [overflow-wrap:anywhere]">
                {button.label || "Default app label"}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={locked}
                onClick={() => edit("button")}
              >
                Edit label
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={locked}
                onClick={() =>
                  publish({ ...placement, button: { ...button, enabled: !button.enabled } })
                }
              >
                {button.enabled ? "Hide button" : "Show button"}
              </Button>
            </div>
          </div>
        )}
      </Card>
      <Card
        title="Home ad banner"
        sub="Mobile Leaderboard · 320 × 50. The image appears above the customers and opens its own link."
      >
        {editor?.kind === "banner" ? (
          <BannerEditor
            banner={editor.placement.banner}
            busy={busy}
            onCancel={cancel}
            onSave={(nextBanner) => publish({ ...editor.placement, banner: nextBanner })}
          />
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-brand-ink">
                {banner.enabled ? "Shown on home" : "Hidden"}
              </p>
              <p className="mt-1 text-sm text-brand-muted">
                {banner.slides.length === 0
                  ? "Save at least one slide to show the banner."
                  : `${banner.slides.length} ${banner.slides.length === 1 ? "image" : "images"} · ${banner.rotation_seconds} seconds per slide`}
              </p>
              {banner.slides[0] ? (
                <BannerPreview image={banner.slides[0].image_url} position={1} className="mt-3" />
              ) : null}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={locked}
                onClick={() => edit("banner")}
              >
                Edit carousel
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={locked || (!banner.enabled && banner.slides.length === 0)}
                onClick={() =>
                  publish({ ...placement, banner: { ...banner, enabled: !banner.enabled } })
                }
              >
                {banner.enabled ? "Hide banner" : "Show banner"}
              </Button>
            </div>
          </div>
        )}
      </Card>
    </>
  );
}

function ButtonEditor({
  button,
  busy,
  onCancel,
  onSave,
}: {
  button: Placement["button"];
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
        <Input name="label" defaultValue={button.label} dir="auto" disabled={busy} autoFocus />
        <span className="block text-xs font-normal text-brand-muted">
          Leave blank to use the app’s default label in each language.
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
  banner,
  busy,
  onCancel,
  onSave,
}: {
  banner: Placement["banner"];
  busy: boolean;
  onCancel: () => void;
  onSave: (banner: Placement["banner"]) => void;
}) {
  const token = useAdminToken();
  const [slides, setSlides] = useState(() =>
    banner.slides.map((slide, key) => ({ ...slide, key })),
  );
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
    const form = new FormData(event.currentTarget);
    const rotationSeconds = Number(form.get("rotation_seconds"));
    const cleaned = slides.map(({ image_url, destination_url }) => ({
      image_url,
      destination_url: destination_url.trim(),
    }));
    if (cleaned.some((slide) => !validSponsorUrl(slide.destination_url))) {
      setError("Enter a valid HTTP or HTTPS destination for every image.");
      return;
    }
    setError("");
    onSave({
      enabled: banner.enabled && cleaned.length > 0,
      rotation_seconds: rotationSeconds,
      slides: cleaned,
    });
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <fieldset disabled={locked} className="space-y-4">
        <label className={`${fieldClass} max-w-[13rem]`}>
          <span>Seconds per slide</span>
          <Input
            name="rotation_seconds"
            type="number"
            min={3}
            max={30}
            step={1}
            defaultValue={banner.rotation_seconds}
            required
          />
        </label>
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
      {banner.enabled && slides.length === 0 ? (
        <p className="text-sm text-brand-muted">Saving an empty carousel hides the banner.</p>
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
