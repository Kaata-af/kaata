import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { FileMode, type File } from "expo-file-system";
import { DRIVE_BACKUP_FILE_LIMIT } from "./drive-backup";
import {
  connectGoogleDrive,
  disconnectGoogleDrive,
  driveResponseError,
  googleRequest,
  supportsGoogleDrive,
  withDriveToken,
} from "./google-drive-backup-auth";
import {
  PersonalCloudProviderError,
  type PersonalCloudCopy,
  type PersonalCloudProvider,
  type PersonalCloudTarget,
} from "./personal-cloud-types";

const DRIVE = "https://www.googleapis.com/drive/v3/files";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const ZIP = "application/zip";
const FOLDER = "application/vnd.google-apps.folder";
const BACKUP_KIND = "kaata-backup-v1";
const FOLDER_KIND = "kaata-backup-folder-v1";
const FIELDS =
  "id,name,mimeType,ownedByMe,shared,trashed,size,parents,appProperties,sha256Checksum";
const CHUNK_SIZE = 2 * 1024 * 1024;
const SCOPE_KEY = /^[a-f0-9]{32}$/;
const DRIVE_ID = /^[A-Za-z0-9_-]{1,200}$/;
const selectedVersions = new WeakMap<PersonalCloudCopy, string>();

type DriveFile = {
  id: string;
  name: string;
  mimeType?: string;
  ownedByMe?: boolean;
  shared?: boolean;
  trashed?: boolean;
  size?: string;
  parents?: string[];
  appProperties?: Record<string, string>;
  sha256Checksum?: string;
};

function query(url: string, parameters: Record<string, string>): string {
  return `${url}?${new URLSearchParams(parameters)}`;
}

function checkedId(id: string): string {
  if (!DRIVE_ID.test(id)) throw new PersonalCloudProviderError("providerFailed");
  return id;
}

function property(key: string, value: string): string {
  return `appProperties has { key='${key}' and value='${value}' }`;
}

function backupFilter(scope: string): string {
  if (!SCOPE_KEY.test(scope)) throw new PersonalCloudProviderError("providerFailed");
  return `mimeType='${ZIP}' and ${property("kind", BACKUP_KIND)} and ${property("scope", scope)}`;
}

function driveRequest(token: string, url: string, options: RequestInit = {}): Promise<Response> {
  return googleRequest(url, {
    ...options,
    headers: { ...options.headers, Authorization: `Bearer ${token}` },
  });
}

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) throw await driveResponseError(response);
  return response.json() as Promise<T>;
}

async function* listFiles(token: string, filter: string): AsyncGenerator<DriveFile> {
  const seen = new Set<string>();
  let pageToken = "";
  do {
    if (seen.has(pageToken)) throw new PersonalCloudProviderError("providerFailed");
    seen.add(pageToken);
    const page = await json<{ files?: DriveFile[]; nextPageToken?: string }>(
      await driveRequest(
        token,
        query(DRIVE, {
          q: `trashed=false and 'me' in owners and ${filter}`,
          spaces: "drive",
          fields: `nextPageToken,files(${FIELDS})`,
          orderBy: "modifiedTime desc",
          pageSize: "100",
          ...(pageToken ? { pageToken } : {}),
        }),
      ),
    );
    yield* page.files ?? [];
    pageToken = page.nextPageToken ?? "";
  } while (pageToken);
}

function privateFile(file: DriveFile): boolean {
  return file.ownedByMe === true && file.shared === false && file.trashed === false;
}

async function generateId(token: string): Promise<string> {
  const result = await json<{ ids: string[] }>(
    await driveRequest(
      token,
      query(`${DRIVE}/generateIds`, {
        count: "1",
        space: "drive",
        type: "files",
      }),
    ),
  );
  return checkedId(result.ids[0] ?? "");
}

async function backupFolders(token: string): Promise<Set<string>> {
  const folders = new Set<string>();
  for await (const file of listFiles(
    token,
    `mimeType='${FOLDER}' and ${property("kind", FOLDER_KIND)}`,
  )) {
    if (privateFile(file) && file.mimeType === FOLDER && file.appProperties?.kind === FOLDER_KIND) {
      folders.add(checkedId(file.id));
    }
  }
  if (folders.size) return folders;
  const id = await generateId(token);
  const folder = await json<DriveFile>(
    await driveRequest(token, query(DRIVE, { fields: FIELDS }), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id,
        name: "Kaata Backups",
        mimeType: FOLDER,
        appProperties: { kind: FOLDER_KIND },
      }),
    }),
  );
  if (folder.id !== id || !privateFile(folder))
    throw new PersonalCloudProviderError("providerFailed");
  return folders.add(id);
}

function asCopy(file: DriveFile, scope: string): PersonalCloudCopy | null {
  const properties = file.appProperties;
  const createdAt = Number(properties?.createdAt);
  const size = Number(file.size);
  if (
    file.ownedByMe !== true ||
    file.trashed !== false ||
    file.mimeType !== ZIP ||
    properties?.kind !== BACKUP_KIND ||
    properties.scope !== scope ||
    !SCOPE_KEY.test(properties.device) ||
    !DRIVE_ID.test(file.id) ||
    typeof file.name !== "string" ||
    !file.name ||
    !Number.isSafeInteger(createdAt) ||
    createdAt <= 0 ||
    !Number.isSafeInteger(size) ||
    size <= 0
  )
    return null;
  return { id: file.id, name: file.name, createdAt, size };
}

function resumableLocation(response: Response): string {
  const location = response.headers.get("location");
  if (!location) throw new PersonalCloudProviderError("providerFailed");
  const url = new URL(location);
  if (
    url.origin !== "https://www.googleapis.com" ||
    url.username ||
    url.password ||
    url.hash ||
    !/^\/upload\/drive\/v3\/files(?:\/[A-Za-z0-9_-]+)?$/.test(url.pathname) ||
    !url.searchParams.get("upload_id")
  )
    throw new PersonalCloudProviderError("providerFailed");
  return location;
}

async function uploadChunks(
  token: string,
  location: string,
  file: File,
  size: number,
): Promise<DriveFile> {
  const handle = file.open(FileMode.ReadOnly);
  let offset = 0;
  let stalled = 0;
  try {
    while (offset < size) {
      handle.offset = offset;
      const count = Math.min(CHUNK_SIZE, size - offset);
      const bytes = await handle.readBytes(count);
      if (bytes.length !== count) throw new PersonalCloudProviderError("providerFailed");
      let response: Response;
      try {
        response = await driveRequest(token, location, {
          method: "PUT",
          headers: {
            "Content-Type": ZIP,
            "Content-Range": `bytes ${offset}-${offset + count - 1}/${size}`,
          },
          body: bytes,
        });
        if (response.status === 408 || response.status >= 500)
          throw await driveResponseError(response);
      } catch (error) {
        if (!(error instanceof PersonalCloudProviderError) || error.code !== "offline") throw error;
        response = await driveRequest(token, location, {
          method: "PUT",
          headers: { "Content-Range": `bytes */${size}` },
        });
      } finally {
        bytes.fill(0);
      }
      if (response.status !== 308) return json<DriveFile>(response);
      const range = response.headers.get("range");
      const end = range ? /^bytes=0-(\d+)$/.exec(range) : null;
      const next = end ? Number(end[1]) + 1 : 0;
      if ((range && !end) || next < offset || next > offset + count || next >= size) {
        throw new PersonalCloudProviderError("providerFailed");
      }
      stalled = next === offset ? stalled + 1 : 0;
      if (stalled >= 2) throw new PersonalCloudProviderError("offline");
      offset = next;
    }
    throw new PersonalCloudProviderError("providerFailed");
  } finally {
    handle.close();
  }
}

async function uploadFile(
  token: string,
  target: PersonalCloudTarget,
  file: File,
  createdAt: number,
): Promise<PersonalCloudCopy> {
  const size = file.size;
  if (size > DRIVE_BACKUP_FILE_LIMIT) throw new PersonalCloudProviderError("tooLarge");
  if (!size || !SCOPE_KEY.test(target.device))
    throw new PersonalCloudProviderError("providerFailed");
  const filter = backupFilter(target.scope);
  const folders = await backupFolders(token);
  const parent = [...folders][0]!;
  let existing: string | undefined;
  for await (const candidate of listFiles(
    token,
    `${filter} and ${property("device", target.device)}`,
  )) {
    if (
      !privateFile(candidate) ||
      !candidate.parents?.some((id) => folders.has(id)) ||
      !asCopy(candidate, target.scope) ||
      candidate.appProperties?.device !== target.device
    )
      continue;
    existing = checkedId(candidate.id);
    break;
  }
  const id = existing ?? (await generateId(token));
  const name = `Kaata Backup - ${target.device.slice(0, 8).toUpperCase()}.zip`;
  const metadata = {
    name,
    mimeType: ZIP,
    appProperties: { kind: BACKUP_KIND, ...target, createdAt: String(createdAt) },
    ...(existing ? {} : { id, parents: [parent] }),
  };
  const session = await driveRequest(
    token,
    query(existing ? `${UPLOAD}/${id}` : UPLOAD, {
      uploadType: "resumable",
      fields: FIELDS,
    }),
    {
      method: existing ? "PATCH" : "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Upload-Content-Type": ZIP,
        "X-Upload-Content-Length": String(size),
      },
      body: JSON.stringify(metadata),
    },
  );
  if (!session.ok) throw await driveResponseError(session);
  const stored = await uploadChunks(token, resumableLocation(session), file, size);
  const copy = asCopy(stored, target.scope);
  if (
    !copy ||
    copy.id !== id ||
    copy.size !== size ||
    copy.createdAt !== createdAt ||
    !privateFile(stored)
  ) {
    throw new PersonalCloudProviderError("providerFailed");
  }
  return copy;
}

async function listBackups(token: string, scope: string): Promise<PersonalCloudCopy[]> {
  const copies = new Map<string, PersonalCloudCopy>();
  for await (const file of listFiles(token, backupFilter(scope))) {
    const copy = asCopy(file, scope);
    const checksum = file.sha256Checksum;
    if (
      !copy ||
      copy.size > DRIVE_BACKUP_FILE_LIMIT ||
      !checksum ||
      !/^[a-fA-F0-9]{64}$/.test(checksum)
    )
      continue;
    selectedVersions.set(copy, checksum.toLowerCase());
    const device = file.appProperties!.device;
    const previous = copies.get(device);
    if (!previous || previous.createdAt < copy.createdAt) copies.set(device, copy);
  }
  return [...copies.values()].sort((a, b) => b.createdAt - a.createdAt);
}

async function downloadFile(
  token: string,
  scope: string,
  copy: PersonalCloudCopy,
  destination: File,
): Promise<void> {
  const url = `${DRIVE}/${checkedId(copy.id)}`;
  const stored = await json<DriveFile>(await driveRequest(token, query(url, { fields: FIELDS })));
  const actual = asCopy(stored, scope);
  const checksum = stored.sha256Checksum;
  if (
    !actual ||
    actual.id !== copy.id ||
    actual.createdAt !== copy.createdAt ||
    actual.size !== copy.size ||
    !checksum ||
    checksum.toLowerCase() !== selectedVersions.get(copy)
  )
    throw new PersonalCloudProviderError("providerFailed");
  if (actual.size > DRIVE_BACKUP_FILE_LIMIT) throw new PersonalCloudProviderError("tooLarge");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180_000);
  try {
    const response = await driveRequest(token, query(url, { alt: "media" }), {
      signal: controller.signal,
    });
    if (!response.ok) throw await driveResponseError(response);
    const reader = response.body?.getReader();
    if (!reader) throw new PersonalCloudProviderError("providerFailed");
    let written = 0;
    const digest = sha256.create();
    try {
      if (!destination.exists) destination.create();
      const handle = destination.open(FileMode.Truncate);
      try {
        while (true) {
          const { done, value } = await reader.read().catch(() => {
            throw new PersonalCloudProviderError("offline");
          });
          if (done) break;
          try {
            written += value.length;
            if (written > actual.size) throw new PersonalCloudProviderError("providerFailed");
            digest.update(value);
            await handle.writeBytes(value);
          } finally {
            value.fill(0);
          }
        }
        if (written !== actual.size || bytesToHex(digest.digest()) !== checksum.toLowerCase()) {
          throw new PersonalCloudProviderError("providerFailed");
        }
      } finally {
        handle.close();
      }
    } finally {
      reader.releaseLock();
      digest.destroy();
    }
  } catch (error) {
    if (destination.exists) destination.delete();
    throw error;
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

export const googleDriveBackupProvider: PersonalCloudProvider = {
  supported: supportsGoogleDrive,
  connect: connectGoogleDrive,
  disconnect: disconnectGoogleDrive,
  upload: (connection, target, file, createdAt) =>
    withDriveToken(connection, (token) => uploadFile(token, target, file, createdAt)),
  list: (connection, scope) => withDriveToken(connection, (token) => listBackups(token, scope)),
  download: (connection, scope, copy, destination) =>
    withDriveToken(connection, (token) => downloadFile(token, scope, copy, destination)),
};
