// Browser → Worker → Frame.io new-version upload.
//
// V4 doesn't have an "upload new version" endpoint. The flow is:
//   1. POST /accounts/{a}/folders/{folder_id}/files/local_upload
//      → response carries upload_urls[] (chunked S3 presigned PUTs).
//   2. PUT each chunk's bytes to its signed URL with `x-amz-acl: private`.
//   3. If the file is unstacked, POST .../folders/{folder_id}/version_stacks
//      with { file_ids: [existing_file_id, new_file_id] }. If it is already
//      in a version stack, PATCH .../files/{new_file_id}/move with that
//      version stack as its parent instead.
//
// Limitations:
//   - Workers cap request bodies at ~100 MB. For larger files we'd need to
//     return the presigned URLs to the browser and let it PUT directly.

import type { Context } from "hono";
import type { Env } from "./env";
import { getWatchedAsset } from "./db/queries";
import {
  FrameIoClient,
  FrameIoApiError,
  hasFrameIoCredentials,
  isValidFrameIoId,
} from "./frameio/client";

export async function handleVersionUpload(c: Context<{ Bindings: Env }>, fileId: string) {
  const watched = await getWatchedAsset(c.env.DB, fileId);
  if (!watched) {
    return c.json({ error: "asset is not watched" }, 404);
  }
  if (!watched.account_id) {
    return c.json({ error: "watched asset is missing account_id; re-watch it first" }, 409);
  }
  if (!hasFrameIoCredentials(c.env)) {
    return c.json({ error: "FRAMEIO_TOKEN not set" }, 500);
  }

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch (err) {
    return c.json({ error: "invalid multipart body", detail: errorDetail(err) }, 400);
  }

  const fileEntry = form.get("file");
  if (!isUploadedFile(fileEntry)) {
    return c.json({ error: "missing file field" }, 400);
  }

  const client = new FrameIoClient(c.env);
  const contentType = fileEntry.type || "application/octet-stream";
  const filename = fileEntry.name || "upload.bin";
  const fileSize = fileEntry.size;

  try {
    // 1. Resolve the folder required by local_upload. A versioned file's
    // parent is its stack, so upload into that stack's containing folder.
    const location = await resolveUploadLocation(client, watched.account_id, fileId);
    if (!location) {
      return c.json({ error: "could not resolve parent folder of existing file" }, 502);
    }

    // 2. Create the new file with chunked presigned upload URLs.
    const created = await client.createLocalUpload(watched.account_id, location.folderId, {
      name: filename,
      file_size: fileSize,
    });

    // 3. Slice the in-memory bytes per the chunk sizes Frame.io returned and
    //    PUT each one. The number/size of chunks varies with file_size.
    //    Refuse to upload if the chunk sizes don't cover the file exactly —
    //    stacking a truncated version is worse than failing. The placeholder
    //    file created by local_upload is left unfilled in Frame.io.
    const bytes = await fileEntry.arrayBuffer();
    const totalChunkSize = created.upload_urls.reduce((sum, chunk) => sum + chunk.size, 0);
    if (totalChunkSize !== bytes.byteLength) {
      console.error(
        `upload aborted: chunk sizes total ${totalChunkSize} != file size ${bytes.byteLength} (placeholder file ${created.id})`,
      );
      return c.json(
        {
          error: "upload aborted",
          detail: `Frame.io returned upload chunks totalling ${totalChunkSize} bytes for a ${bytes.byteLength}-byte file; refusing to upload a truncated version.`,
        },
        502,
      );
    }
    let offset = 0;
    for (let i = 0; i < created.upload_urls.length; i++) {
      const chunk = created.upload_urls[i];
      const end = Math.min(offset + chunk.size, bytes.byteLength);
      const slice = bytes.slice(offset, end);
      await client.putUploadChunk(chunk.url, slice, contentType);
      offset = end;
    }

    // 4. Create a stack for an unstacked file, or extend its existing stack.
    let versionStackId: string;
    try {
      versionStackId = await addFileAsVersion(
        client,
        watched.account_id,
        fileId,
        created.id,
        location,
      );
    } catch (err) {
      // The new file is uploaded; if stacking fails the user still has both
      // files in the folder. Surface the partial success rather than aborting.
      console.error("version_stacks create failed:", err);
      return c.redirect(
        `/?uploaded=${encodeURIComponent(fileId)}&new_file=${encodeURIComponent(created.id)}&stack_failed=1`,
        303,
      );
    }

    return c.redirect(
      `/?uploaded=${encodeURIComponent(fileId)}&new_file=${encodeURIComponent(created.id)}&stack=${encodeURIComponent(versionStackId)}`,
      303,
    );
  } catch (err) {
    console.error("Upload failed:", err);
    const status = err instanceof FrameIoApiError ? err.status : 500;
    return c.json({ error: "upload failed", detail: errorDetail(err) }, status === 401 ? 502 : 500);
  }
}

// Direct-upload, step 1: create the placeholder file and hand its presigned
// chunk URLs back to the browser, which PUTs to them itself (no ~100 MB body
// cap). Supports both files directly inside folders and files already inside
// version stacks, but stops before bytes are transferred.
export async function handlePrepareVersion(c: Context<{ Bindings: Env }>, fileId: string) {
  const watched = await getWatchedAsset(c.env.DB, fileId);
  if (!watched) {
    return c.json({ error: "asset is not watched" }, 404);
  }
  if (!watched.account_id) {
    return c.json({ error: "watched asset is missing account_id; re-watch it first" }, 409);
  }
  if (!hasFrameIoCredentials(c.env)) {
    return c.json({ error: "no Frame.io credentials configured" }, 500);
  }

  let body: { name?: unknown; size?: unknown; type?: unknown };
  try {
    body = await c.req.json();
  } catch (err) {
    return c.json({ error: "invalid JSON body", detail: errorDetail(err) }, 400);
  }
  const name = typeof body.name === "string" && body.name.length > 0 ? body.name : "upload.bin";
  const size = typeof body.size === "number" ? body.size : NaN;
  if (!Number.isInteger(size) || size <= 0) {
    return c.json({ error: "invalid or missing file size" }, 400);
  }

  const client = new FrameIoClient(c.env);
  try {
    const location = await resolveUploadLocation(client, watched.account_id, fileId);
    if (!location) {
      return c.json({ error: "could not resolve parent folder of existing file" }, 502);
    }
    const created = await client.createLocalUpload(watched.account_id, location.folderId, {
      name,
      file_size: size,
    });
    return c.json({ new_file_id: created.id, upload_urls: created.upload_urls });
  } catch (err) {
    console.error("Prepare upload failed:", err);
    const status = err instanceof FrameIoApiError ? err.status : 500;
    return c.json({ error: "prepare failed", detail: errorDetail(err) }, status === 401 ? 502 : 500);
  }
}

// Direct-upload, step 2: once the browser has PUT every chunk, stack the new
// file on top of the existing one as a version.
export async function handleFinalizeVersion(c: Context<{ Bindings: Env }>, fileId: string) {
  const watched = await getWatchedAsset(c.env.DB, fileId);
  if (!watched) {
    return c.json({ error: "asset is not watched" }, 404);
  }
  if (!watched.account_id) {
    return c.json({ error: "watched asset is missing account_id; re-watch it first" }, 409);
  }
  if (!hasFrameIoCredentials(c.env)) {
    return c.json({ error: "no Frame.io credentials configured" }, 500);
  }

  let body: { new_file_id?: unknown };
  try {
    body = await c.req.json();
  } catch (err) {
    return c.json({ error: "invalid JSON body", detail: errorDetail(err) }, 400);
  }
  const newFileId = typeof body.new_file_id === "string" ? body.new_file_id : "";
  if (!isValidFrameIoId(newFileId)) {
    return c.json({ error: "invalid or missing new_file_id" }, 400);
  }

  const client = new FrameIoClient(c.env);
  try {
    const location = await resolveUploadLocation(client, watched.account_id, fileId);
    if (!location) {
      return c.json({ error: "could not resolve parent folder of existing file" }, 502);
    }
    const versionStackId = await addFileAsVersion(client, watched.account_id, fileId, newFileId, location);
    return c.json({ version_stack_id: versionStackId });
  } catch (err) {
    console.error("Finalize upload failed:", err);
    const status = err instanceof FrameIoApiError ? err.status : 500;
    return c.json({ error: "finalize failed", detail: errorDetail(err) }, status === 401 ? 502 : 500);
  }
}

interface UploadLocation {
  folderId: string;
  versionStackId: string | null;
}

// A Frame.io file is contained by exactly one folder or version stack. Probe
// the parent as a version stack: a 404 means it is the folder itself; a
// successful response gives the containing folder needed for local_upload.
async function resolveUploadLocation(
  client: FrameIoClient,
  accountId: string,
  fileId: string,
): Promise<UploadLocation | null> {
  const fileRecord = (await client.getFile(accountId, fileId)) as unknown as {
    data?: { parent_id?: string };
  };
  const parentId = fileRecord.data?.parent_id ?? null;
  if (!parentId) return null;

  try {
    const stack = await client.getVersionStack(accountId, parentId);
    if (!stack.parent_id) return null;
    return { folderId: stack.parent_id, versionStackId: parentId };
  } catch (err) {
    if (err instanceof FrameIoApiError && err.status === 404) {
      return { folderId: parentId, versionStackId: null };
    }
    throw err;
  }
}

async function addFileAsVersion(
  client: FrameIoClient,
  accountId: string,
  existingFileId: string,
  newFileId: string,
  location: UploadLocation,
): Promise<string> {
  if (location.versionStackId) {
    await client.moveFile(accountId, newFileId, { parent_id: location.versionStackId });
    return location.versionStackId;
  }
  const stack = await client.createVersionStack(accountId, location.folderId, {
    file_ids: [existingFileId, newFileId],
  });
  return stack.id;
}

function errorDetail(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface UploadedFile {
  name: string;
  size: number;
  type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

function isUploadedFile(v: unknown): v is UploadedFile {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as UploadedFile).name === "string" &&
    typeof (v as UploadedFile).size === "number" &&
    typeof (v as UploadedFile).type === "string" &&
    typeof (v as UploadedFile).arrayBuffer === "function"
  );
}
