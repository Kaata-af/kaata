import type { File } from "expo-file-system";

export type PersonalCloudProviderId = "googleDrive" | "icloudDrive";
export type PersonalCloudConnection = { id: string; label?: string };
export type PersonalCloudTarget = { scope: string; device: string };
export type PersonalCloudCopy = {
  id: string;
  name: string;
  createdAt: number;
  size: number;
  pending?: boolean;
  error?: "providerFailed";
};

export class PersonalCloudProviderError extends Error {
  constructor(public readonly code: "reconnect" | "providerFailed" | "offline" | "tooLarge") {
    super(code);
    this.name = "PersonalCloudProviderError";
  }
}

export interface PersonalCloudProvider {
  supported(): boolean;
  connect(options?: { temporary?: boolean }): Promise<PersonalCloudConnection | null>;
  disconnect?(connection: PersonalCloudConnection): Promise<void>;
  upload(
    connection: PersonalCloudConnection,
    target: PersonalCloudTarget,
    file: File,
    createdAt: number,
  ): Promise<PersonalCloudCopy>;
  list(connection: PersonalCloudConnection, scope: string): Promise<PersonalCloudCopy[]>;
  download(
    connection: PersonalCloudConnection,
    scope: string,
    copy: PersonalCloudCopy,
    destination: File,
  ): Promise<void>;
}
