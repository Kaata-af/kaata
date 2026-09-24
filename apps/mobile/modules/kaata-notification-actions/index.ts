import { requireOptionalNativeModule } from "expo";
export type PendingReview = { id: string; action: string; data: Record<string, unknown> };
export const notificationActions = requireOptionalNativeModule<{
  pending(): Promise<PendingReview[]>;
  complete(id: string): Promise<void>;
}>("KaataNotificationActions");
