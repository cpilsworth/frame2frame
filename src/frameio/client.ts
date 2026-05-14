// Frame.io V4 API client for the single-instance worker.
// Endpoint shapes marked `TODO(v4-verify):` are best-effort against the design
// doc and will need confirmation against the live V4 reference.

import type { Env } from "../env";

const API_BASE = "https://api.frame.io/v4";

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

export class FrameIoClient {
  constructor(private env: Env) {}

  async getFile(accountId: string, fileId: string): Promise<FrameIoFile> {
    return this.request<FrameIoFile>("GET", `/accounts/${accountId}/files/${fileId}`);
  }

  // The webhook for comment.created carries no file reference — we fetch the
  // comment record to discover its parent file. Response wraps in `data`.
  // `?include=owner` expands the author so we get name + email, not just an id.
  async getComment(accountId: string, commentId: string): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(
      "GET",
      `/accounts/${accountId}/comments/${commentId}?include=owner`,
    );
  }

  // List comments for a file. Cursor pagination via `links.next`; we follow
  // pages here so callers receive every comment in one array. `page_size`
  // default is 50. `?include=owner` for author details.
  async listFileComments(accountId: string, fileId: string): Promise<Record<string, unknown>[]> {
    const collected: Record<string, unknown>[] = [];
    let path: string | null = `/accounts/${accountId}/files/${fileId}/comments?page_size=50&include=owner`;
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
      `/accounts/${accountId}/folders/${folderId}/files/local_upload`,
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
      `/accounts/${accountId}/folders/${folderId}/version_stacks`,
      { data: { file_ids: args.file_ids } },
    );
    return wrapped.data;
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

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${API_BASE}${path}`;
    const resp = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.env.FRAMEIO_TOKEN}`,
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
