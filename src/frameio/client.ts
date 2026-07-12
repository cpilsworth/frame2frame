// Frame.io V4 API client for the single-instance worker.
// Endpoint shapes marked `TODO(v4-verify):` are best-effort against the design
// doc and will need confirmation against the live V4 reference.

import type { Env } from "../env";
import { getImsAccessToken } from "./ims";
import { getUserAccessToken } from "./oauth";

const API_BASE = "https://api.frame.io/v4";

// Frame.io V4 ids are UUID-like. Anything else (slashes, dots, percent
// escapes) could redirect a request to a different API endpoint when
// interpolated into a URL path, so ids are validated before use.
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidFrameIoId(id: string): boolean {
  return SAFE_ID.test(id);
}

function safeId(kind: string, id: string): string {
  if (!isValidFrameIoId(id)) {
    throw new FrameIoApiError(400, `invalid ${kind} id`);
  }
  return id;
}

export interface FrameIoFile {
  id: string;
  name: string;
  account_id?: string;
  workspace_id?: string;
  project_id?: string;
  parent_folder_id?: string;
  media_links?: { original?: { download_url: string } };
}

export interface UploadUrlChunk {
  url: string;
  size: number;
}

export interface LocalUploadResponse {
  id: string;
  name: string;
  file_size?: number;
  upload_urls: UploadUrlChunk[];
}

export interface VersionStack {
  id: string;
  name?: string;
  parent_id?: string;
}

// True when the worker has enough configuration to authenticate against the
// Frame.io API — either an IMS OAuth Server-to-Server credential or a
// static FRAMEIO_TOKEN.
export function hasFrameIoCredentials(env: Env): boolean {
  return Boolean((env.IMS_CLIENT_ID && env.IMS_CLIENT_SECRET) || env.FRAMEIO_TOKEN);
}

export class FrameIoClient {
  constructor(private env: Env) {}

  async getFile(accountId: string, fileId: string): Promise<FrameIoFile> {
    return this.request<FrameIoFile>(
      "GET",
      `/accounts/${safeId("account", accountId)}/files/${safeId("file", fileId)}`,
    );
  }

  // The webhook for comment.created carries no file reference — we fetch the
  // comment record to discover its parent file. Response wraps in `data`.
  // `?include=owner` expands the author so we get name + email, not just an id.
  async getComment(accountId: string, commentId: string): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(
      "GET",
      `/accounts/${safeId("account", accountId)}/comments/${safeId("comment", commentId)}?include=owner`,
    );
  }

  // List comments for a file. Cursor pagination via `links.next`; we follow
  // pages here so callers receive every comment in one array. `page_size`
  // default is 50. `?include=owner` for author details.
  async listFileComments(accountId: string, fileId: string): Promise<Record<string, unknown>[]> {
    const collected: Record<string, unknown>[] = [];
    let path: string | null = `/accounts/${safeId("account", accountId)}/files/${safeId("file", fileId)}/comments?page_size=50&include=owner`;
    while (path) {
      const resp: { data?: Record<string, unknown>[]; links?: { next?: string } } =
        await this.request("GET", path);
      if (Array.isArray(resp.data)) collected.push(...resp.data);
      const next = resp.links?.next;
      if (typeof next === "string" && next.length > 0) {
        // V4 returns absolute URLs in pagination; strip the base if so.
        path = next.startsWith(API_BASE) ? next.slice(API_BASE.length) : next;
      } else {
        path = null;
      }
    }
    return collected;
  }

  // Create a new file in a folder via the local-upload flow. Response carries
  // `upload_urls[]` — chunked S3 presigned PUT targets the caller writes
  // bytes to. There is no finalize endpoint; once the PUTs complete, Frame.io
  // detects the upload and transitions the file's status.
  async createLocalUpload(
    accountId: string,
    folderId: string,
    args: { name: string; file_size: number },
  ): Promise<LocalUploadResponse> {
    const wrapped = await this.request<{ data: LocalUploadResponse }>(
      "POST",
      `/accounts/${safeId("account", accountId)}/folders/${safeId("folder", folderId)}/files/local_upload`,
      { data: { name: args.name, file_size: args.file_size } },
    );
    return wrapped.data;
  }

  // Stack files together as versions. The first id is the oldest (bottom),
  // the last is the newest (top). Files must already exist in the same folder.
  async createVersionStack(
    accountId: string,
    folderId: string,
    args: { file_ids: string[] },
  ): Promise<VersionStack> {
    const wrapped = await this.request<{ data: VersionStack }>(
      "POST",
      `/accounts/${safeId("account", accountId)}/folders/${safeId("folder", folderId)}/version_stacks`,
      { data: { file_ids: args.file_ids } },
    );
    return wrapped.data;
  }

  // Returns the folder that contains a version stack. A file's parent is
  // either a folder or a version stack, so callers can use this to resolve a
  // stack child back to the folder required by the local-upload endpoint.
  async getVersionStack(accountId: string, versionStackId: string): Promise<VersionStack> {
    const wrapped = await this.request<{ data: VersionStack }>(
      "GET",
      `/accounts/${safeId("account", accountId)}/version_stacks/${safeId("version stack", versionStackId)}`,
    );
    return wrapped.data;
  }

  // Adds an already-uploaded file to an existing version stack. The file must
  // first be created in the stack's containing folder; Frame.io does not allow
  // local_upload directly into a stack.
  async moveFile(
    accountId: string,
    fileId: string,
    args: { parent_id: string },
  ): Promise<void> {
    await this.request<unknown>(
      "PATCH",
      `/accounts/${safeId("account", accountId)}/files/${safeId("file", fileId)}/move`,
      { data: { parent_id: safeId("parent", args.parent_id) } },
    );
  }

  // PUT one chunk to a Frame.io presigned S3 URL. Not authed with the bearer
  // token — the URL carries its own signature. `x-amz-acl: private` is the
  // header the docs require.
  async putUploadChunk(url: string, body: ArrayBuffer | Blob, contentType: string): Promise<void> {
    const resp = await fetch(url, {
      method: "PUT",
      headers: {
        "Content-Type": contentType,
        "x-amz-acl": "private",
      },
      body,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new FrameIoApiError(resp.status, `PUT signed URL → ${resp.status} ${text.slice(0, 200)}`);
    }
  }

  // ---------------------------------------------------------------------------

  // Credential priority: a stored user-OAuth connection (authorization-code
  // flow) wins, then IMS Server-to-Server client credentials, then the static
  // FRAMEIO_TOKEN. Failures at each step fall through with a log so a broken
  // credential source degrades instead of hard-failing every request.
  private async resolveBearer(): Promise<string> {
    try {
      const userToken = await getUserAccessToken(this.env);
      if (userToken) return userToken;
    } catch (err) {
      console.error("user OAuth token unavailable:", err);
    }
    if (this.env.IMS_CLIENT_ID && this.env.IMS_CLIENT_SECRET) {
      try {
        return await getImsAccessToken(this.env);
      } catch (err) {
        if (this.env.FRAMEIO_TOKEN) {
          console.error("IMS client_credentials failed; falling back to FRAMEIO_TOKEN:", err);
          return this.env.FRAMEIO_TOKEN;
        }
        throw err;
      }
    }
    return this.env.FRAMEIO_TOKEN;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${API_BASE}${path}`;
    const bearer = await this.resolveBearer();
    const resp = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${bearer}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new FrameIoApiError(resp.status, `${method} ${path} → ${resp.status} ${text.slice(0, 500)}`);
    }
    if (resp.status === 204 || method === "DELETE") {
      return undefined as T;
    }
    return (await resp.json()) as T;
  }
}

export class FrameIoApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "FrameIoApiError";
  }
}
