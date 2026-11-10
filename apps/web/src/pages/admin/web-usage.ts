import { useQuery } from "@tanstack/react-query";
import { BACKEND_URL } from "../../env";
import { AuthError, useAdminToken } from "./api";
import { reportingDay } from "./dates";

export type WebUsageDay = {
  day: string;
  active_accounts: number | null;
  returning_accounts?: number | null;
  first_sign_ins: number;
  is_partial: boolean;
};

export type WebUsage = {
  generated_at: string;
  tracking_started_at: string;
  recent_accounts: number;
  returning_accounts_7d?: number | null;
  returning_7d_partial?: boolean;
  first_sign_ins_7d: number;
  first_sign_ins_previous_7d: number;
  days: WebUsageDay[];
};

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function parseWebUsage(value: unknown): WebUsage {
  const report = value as Partial<WebUsage> | null;
  if (
    !report ||
    !isCount(report.recent_accounts) ||
    (report.returning_accounts_7d != null && !isCount(report.returning_accounts_7d)) ||
    (report.returning_7d_partial !== undefined && typeof report.returning_7d_partial !== "boolean") ||
    !isCount(report.first_sign_ins_7d) ||
    !isCount(report.first_sign_ins_previous_7d) ||
    typeof report.generated_at !== "string" ||
    !reportingDay(report.generated_at) ||
    typeof report.tracking_started_at !== "string" ||
    (report.tracking_started_at !== "" && !reportingDay(report.tracking_started_at)) ||
    !Array.isArray(report.days) ||
    report.days.some(
      (day) =>
        !day ||
        typeof day.day !== "string" ||
        reportingDay(day.day) !== day.day ||
        (day.active_accounts !== null && !isCount(day.active_accounts)) ||
        (day.returning_accounts != null && !isCount(day.returning_accounts)) ||
        !isCount(day.first_sign_ins) ||
        typeof day.is_partial !== "boolean",
    )
  ) {
    throw new Error("Web usage report was incomplete.");
  }
  return report as WebUsage;
}

export function useWebUsage() {
  const token = useAdminToken();
  return useQuery({
    queryKey: ["admin", "web-usage", token],
    queryFn: async ({ signal }): Promise<WebUsage | null> => {
      const response = await fetch(`${BACKEND_URL}/v1/admin/web-usage`, {
        headers: { Authorization: `Bearer ${token}` },
        signal,
      });
      if (response.status === 401) throw new AuthError();
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`Server error (${response.status}).`);
      return parseWebUsage(await response.json());
    },
    enabled: !!token,
  });
}
