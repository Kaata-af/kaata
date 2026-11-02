import { useI18n } from "../lib/i18n";
import { PhoneFrame } from "./PhoneMockups";

const APP_FONT = { fontFamily: '"Vazirmatn", system-ui, sans-serif' };
const C = {
  ink: "#171717",
  text: "#292929",
  sub: "#616161",
  muted: "#F7F7F7",
  line: "#EFEFEF",
};

function MemberIcon({
  name,
  className,
}: {
  name: "back" | "mail" | "key" | "chevron";
  className?: string;
}) {
  const paths = {
    back: "m15 18-6-6 6-6",
    mail: "M3 5h18v14H3V5Zm0 0 9 7 9-7",
    key: "M14 9a5 5 0 1 1-10 0 5 5 0 0 1 10 0Zm0 0h8m-3 0v4m3-4v3",
    chevron: "m9 6 6 6-6 6",
  } as const;
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d={paths[name]} />
    </svg>
  );
}

function MemberHeader({ title }: { title: string }) {
  const { isRTL } = useI18n();
  return (
    <div
      className={`flex h-10 shrink-0 items-center px-2 ${isRTL ? "flex-row-reverse" : ""}`}
      style={{ color: C.ink }}
    >
      <div className="flex w-8 shrink-0 justify-center">
        <MemberIcon name="back" className={`h-[18px] w-[18px] ${isRTL ? "rotate-180" : ""}`} />
      </div>
      <p className="min-w-0 flex-1 truncate text-center text-[13px] font-semibold">{title}</p>
      <div className="w-8 shrink-0" />
    </div>
  );
}

function MemberSectionLabel({ children }: { children: string }) {
  const { isRTL } = useI18n();
  return (
    <p
      dir={isRTL ? "rtl" : "ltr"}
      className={`px-3.5 pb-1.5 pt-3 text-[8px] font-semibold uppercase ${isRTL ? "" : "tracking-wider"}`}
      style={{ color: C.sub }}
    >
      {children}
    </p>
  );
}

function HomeIndicator() {
  return <div className="mx-auto mb-2.5 mt-auto h-1 w-20 shrink-0 rounded-full bg-neutral-900" />;
}

function MembersListPreview() {
  const { t, isRTL } = useI18n();
  const members = [
    { name: t("mock.self.name") + t("members.youSuffix"), role: "owner" },
    { name: t("mock.name.ahmad"), role: "editor" },
    { name: t("mock.name.wahid"), role: "clerk" },
  ] as const;
  const actions = [
    { icon: "mail", label: t("members.row.sendInvite"), hint: t("members.row.sendInvite.hint") },
    { icon: "key", label: t("vaultSettings.row.transfer"), hint: null },
  ] as const;
  return (
    <PhoneFrame label={t("mock.members.list.preview.label")}>
      <div className="flex min-h-0 flex-1 flex-col" style={APP_FONT}>
        <MemberHeader title={t("members.title")} />
        <p
          dir={isRTL ? "rtl" : "ltr"}
          className="px-3.5 pb-1 pt-2 text-[9px] leading-relaxed"
          style={{ color: C.sub }}
        >
          {t("members.rolesHelp")}
        </p>
        <MemberSectionLabel>{t("members.section.members", { count: 3 })}</MemberSectionLabel>
        <div>
          {members.map((member, index) => (
            <div
              key={member.role}
              className={`flex min-h-[49px] items-center gap-2.5 px-3.5 py-2 ${isRTL ? "flex-row-reverse" : ""} ${index < members.length - 1 ? "border-b" : ""}`}
              style={{ borderColor: C.line }}
            >
              <span
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[14px] font-bold"
                style={{ background: C.muted, color: C.ink }}
              >
                {member.name.trim().charAt(0).toUpperCase()}
              </span>
              <p
                dir={isRTL ? "rtl" : "ltr"}
                className="min-w-0 flex-1 truncate text-[11px] font-semibold"
                style={{ color: C.ink }}
              >
                {member.name}
              </p>
              <span
                className={`shrink-0 rounded-full px-2 py-1 text-[8px] font-semibold uppercase ${isRTL ? "" : "tracking-wide"}`}
                style={{
                  background: member.role === "owner" ? C.ink : C.muted,
                  color: member.role === "owner" ? "#FFFFFF" : C.sub,
                }}
              >
                {t(`vaultSettings.role.${member.role}`)}
              </span>
            </div>
          ))}
        </div>
        <div className="mt-1">
          {actions.map((action, index) => (
            <div
              key={action.icon}
              className={`flex min-h-10 items-center gap-2.5 px-3.5 py-2.5 ${isRTL ? "flex-row-reverse" : ""} ${index === 0 ? "border-b" : ""}`}
              style={{ borderColor: C.line, color: C.ink }}
            >
              <MemberIcon name={action.icon} className="h-4 w-4 shrink-0" />
              <div className="min-w-0 flex-1" dir={isRTL ? "rtl" : "ltr"}>
                <p className={`text-[10px] ${index === 0 ? "font-semibold" : "font-medium"}`}>
                  {action.label}
                </p>
                {action.hint ? (
                  <p className="mt-0.5 text-[8px] leading-snug" style={{ color: C.sub }}>
                    {action.hint}
                  </p>
                ) : null}
              </div>
              <MemberIcon
                name="chevron"
                className={`h-3 w-3 shrink-0 ${isRTL ? "rotate-180" : ""}`}
              />
            </div>
          ))}
        </div>
        <HomeIndicator />
      </div>
    </PhoneFrame>
  );
}

function InviteMemberPreview() {
  const { t, isRTL } = useI18n();
  const roles = ["editor", "clerk", "viewer"] as const;
  return (
    <PhoneFrame label={t("mock.members.invite.preview.label")}>
      <div className="flex min-h-0 flex-1 flex-col" style={APP_FONT}>
        <MemberHeader title={t("invite.title")} />
        <div className="min-h-0 flex-1">
          <p
            dir={isRTL ? "rtl" : "ltr"}
            className="px-3.5 pt-2 text-[9.5px] leading-relaxed"
            style={{ color: C.text }}
          >
            {t("invite.link.intro")}
          </p>
          <div className="mt-3 h-[3px]" style={{ background: C.muted }} />
          <MemberSectionLabel>{t("invite.section.role")}</MemberSectionLabel>
          {roles.map((role, index) => (
            <div
              key={role}
              className={`flex min-h-[43px] items-center gap-2.5 px-3.5 py-2 ${isRTL ? "flex-row-reverse" : ""} ${index < roles.length - 1 ? "border-b" : ""}`}
              style={{ borderColor: C.line }}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4 shrink-0">
                <circle
                  cx="12"
                  cy="12"
                  r="9.5"
                  fill={role === "editor" ? C.ink : "none"}
                  stroke={role === "editor" ? C.ink : "#6B6B6B"}
                  strokeWidth="1.5"
                />
                {role === "editor" ? (
                  <path
                    d="m7 12 3 3 7-7"
                    fill="none"
                    stroke="white"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                ) : null}
              </svg>
              <div className="min-w-0 flex-1" dir={isRTL ? "rtl" : "ltr"}>
                <p
                  className={`text-[10.5px] ${role === "editor" ? "font-semibold" : "font-medium"}`}
                  style={{ color: role === "editor" ? C.ink : C.text }}
                >
                  {t(`vaultSettings.role.${role}`)}
                </p>
                <p className="mt-0.5 text-[8px] leading-snug" style={{ color: C.sub }}>
                  {t(`invite.role.${role}.hint`)}
                </p>
              </div>
            </div>
          ))}
          <div className="px-3.5 pt-3" dir={isRTL ? "rtl" : "ltr"}>
            <p className="text-[8px] leading-relaxed" style={{ color: C.sub }}>
              {t("invite.link.editorDisclosure")}
            </p>
            <p className="mt-1.5 text-[8px] leading-relaxed" style={{ color: C.sub }}>
              {t("invite.managerNote")}
            </p>
            <div className="mt-4 flex min-h-8 items-center justify-center rounded-[7px] bg-black px-2 text-[10px] font-semibold text-white">
              {t("invite.link.create")}
            </div>
          </div>
        </div>
        <HomeIndicator />
      </div>
    </PhoneFrame>
  );
}

export function PhoneMockupMembers() {
  const { t } = useI18n();
  return (
    <div className="grid w-full max-w-3xl justify-items-center gap-10 md:grid-cols-2 md:gap-12">
      <figure className="flex w-full min-w-0 flex-col items-center">
        <figcaption className="mb-4 text-center text-sm font-semibold text-neutral-700">
          {t("mock.members.list.caption")}
        </figcaption>
        <MembersListPreview />
      </figure>
      <figure className="flex w-full min-w-0 flex-col items-center">
        <figcaption className="mb-4 text-center text-sm font-semibold text-neutral-700">
          {t("mock.members.invite.caption")}
        </figcaption>
        <InviteMemberPreview />
      </figure>
    </div>
  );
}
