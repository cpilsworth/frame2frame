import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context } from "hono";
import type { Env } from "../src/env";
import { handleFinalizeVersion, handlePrepareVersion, handleVersionUpload } from "../src/upload";

const ACCOUNT_ID = "account-123";
const FILE_ID = "existing-file";
const STACK_ID = "existing-stack";
const FOLDER_ID = "containing-folder";
const NEW_FILE_ID = "new-file";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("version uploads", () => {
  it("uploads into the containing folder when the watched file is already in a stack", async () => {
    const requests = mockFrameIo([
      fileResponse(STACK_ID),
      stackResponse(FOLDER_ID),
      localUploadResponse(),
    ]);

    const response = await handlePrepareVersion(jsonContext({ name: "replacement.mov", size: 42 }), FILE_ID);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ new_file_id: NEW_FILE_ID, upload_urls: [] });
    expect(requests.map((request) => request.url)).toEqual([
      frameIoPath(`/accounts/${ACCOUNT_ID}/files/${FILE_ID}`),
      frameIoPath(`/accounts/${ACCOUNT_ID}/version_stacks/${STACK_ID}`),
      frameIoPath(`/accounts/${ACCOUNT_ID}/folders/${FOLDER_ID}/files/local_upload`),
    ]);
    expect(requests[2].init?.method).toBe("POST");
    expect(requests[2].init?.body).toBe(
      JSON.stringify({ data: { name: "replacement.mov", file_size: 42 } }),
    );
  });

  it("moves a completed upload into an existing version stack", async () => {
    const requests = mockFrameIo([
      fileResponse(STACK_ID),
      stackResponse(FOLDER_ID),
      jsonResponse({ data: { id: NEW_FILE_ID, parent_id: STACK_ID } }),
    ]);

    const response = await handleFinalizeVersion(jsonContext({ new_file_id: NEW_FILE_ID }), FILE_ID);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ version_stack_id: STACK_ID });
    expect(requests.map((request) => request.url)).toEqual([
      frameIoPath(`/accounts/${ACCOUNT_ID}/files/${FILE_ID}`),
      frameIoPath(`/accounts/${ACCOUNT_ID}/version_stacks/${STACK_ID}`),
      frameIoPath(`/accounts/${ACCOUNT_ID}/files/${NEW_FILE_ID}/move`),
    ]);
    expect(requests[2].init?.method).toBe("PATCH");
    expect(requests[2].init?.body).toBe(JSON.stringify({ data: { parent_id: STACK_ID } }));
  });

  it("uses the same existing-stack flow for the server-proxy fallback", async () => {
    const requests = mockFrameIo([
      fileResponse(STACK_ID),
      stackResponse(FOLDER_ID),
      jsonResponse({
        data: {
          id: NEW_FILE_ID,
          upload_urls: [{ url: "https://upload.example.test/chunk", size: 4 }],
        },
      }),
      new Response(null, { status: 200 }),
      jsonResponse({ data: { id: NEW_FILE_ID, parent_id: STACK_ID } }),
    ]);

    const response = await handleVersionUpload(multipartContext(), FILE_ID);

    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toContain(`stack=${STACK_ID}`);
    expect(requests.map((request) => request.url)).toEqual([
      frameIoPath(`/accounts/${ACCOUNT_ID}/files/${FILE_ID}`),
      frameIoPath(`/accounts/${ACCOUNT_ID}/version_stacks/${STACK_ID}`),
      frameIoPath(`/accounts/${ACCOUNT_ID}/folders/${FOLDER_ID}/files/local_upload`),
      "https://upload.example.test/chunk",
      frameIoPath(`/accounts/${ACCOUNT_ID}/files/${NEW_FILE_ID}/move`),
    ]);
  });

  it("continues to upload directly to an unstacked file's folder", async () => {
    const requests = mockFrameIo([
      fileResponse(FOLDER_ID),
      jsonResponse({ errors: [{ title: "Not Found" }] }, 404),
      localUploadResponse(),
    ]);

    const response = await handlePrepareVersion(jsonContext({ name: "replacement.mov", size: 42 }), FILE_ID);

    expect(response.status).toBe(200);
    expect(requests[2].url).toBe(
      frameIoPath(`/accounts/${ACCOUNT_ID}/folders/${FOLDER_ID}/files/local_upload`),
    );
  });

  it("creates a stack for an unstacked file after upload", async () => {
    const requests = mockFrameIo([
      fileResponse(FOLDER_ID),
      jsonResponse({ errors: [{ title: "Not Found" }] }, 404),
      jsonResponse({ data: { id: STACK_ID } }),
    ]);

    const response = await handleFinalizeVersion(jsonContext({ new_file_id: NEW_FILE_ID }), FILE_ID);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ version_stack_id: STACK_ID });
    expect(requests[2].url).toBe(
      frameIoPath(`/accounts/${ACCOUNT_ID}/folders/${FOLDER_ID}/version_stacks`),
    );
    expect(requests[2].init?.body).toBe(
      JSON.stringify({ data: { file_ids: [FILE_ID, NEW_FILE_ID] } }),
    );
  });
});

interface RecordedRequest {
  url: string;
  init?: RequestInit;
}

function mockFrameIo(responses: Response[]): RecordedRequest[] {
  const requests: RecordedRequest[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      const response = responses.shift();
      if (!response) throw new Error(`unexpected request: ${url}`);
      return response;
    }),
  );
  return requests;
}

function jsonContext(body: unknown): Context<{ Bindings: Env }> {
  return {
    env: {
      DB: watchedAssetDb(),
      FRAMEIO_SIGNING_SECRET: "unused",
      FRAMEIO_TOKEN: "test-token",
    },
    req: { json: async () => body },
    json: (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
  } as unknown as Context<{ Bindings: Env }>;
}

function multipartContext(): Context<{ Bindings: Env }> {
  const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
  return {
    env: {
      DB: watchedAssetDb(),
      FRAMEIO_SIGNING_SECRET: "unused",
      FRAMEIO_TOKEN: "test-token",
    },
    req: {
      formData: async () => ({
        get: (name: string) =>
          name === "file"
            ? {
                name: "replacement.mov",
                size: bytes.byteLength,
                type: "video/quicktime",
                arrayBuffer: async () => bytes,
              }
            : null,
      }),
    },
    json: (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    redirect: (location: string, status = 302) =>
      new Response(null, { status, headers: { Location: location } }),
  } as unknown as Context<{ Bindings: Env }>;
}

function watchedAssetDb(): D1Database {
  return {
    prepare: (query: string) => {
      const statement = {
        bind: () => statement,
        first: async () =>
          query.includes("watched_assets")
            ? { file_id: FILE_ID, account_id: ACCOUNT_ID }
            : null,
      };
      return statement;
    },
  } as unknown as D1Database;
}

function fileResponse(parentId: string): Response {
  return jsonResponse({ data: { id: FILE_ID, parent_id: parentId } });
}

function stackResponse(parentId: string): Response {
  return jsonResponse({ data: { id: STACK_ID, parent_id: parentId } });
}

function localUploadResponse(): Response {
  return jsonResponse({ data: { id: NEW_FILE_ID, upload_urls: [] } });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function frameIoPath(path: string): string {
  return `https://api.frame.io/v4${path}`;
}
