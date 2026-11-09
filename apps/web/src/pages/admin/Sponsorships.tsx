import { SponsorPlacement } from "./SponsorPlacement";
import { PageHeader } from "./ui";

export function Sponsorships() {
  return (
    <div className="min-w-0 max-w-full">
      <PageHeader
        title="Sponsorships"
        description="Manage the promotion button and image ads on Kaata’s mobile home screen."
      />
      <div className="flex min-w-0 flex-col gap-4">
        <SponsorPlacement />
      </div>
    </div>
  );
}
