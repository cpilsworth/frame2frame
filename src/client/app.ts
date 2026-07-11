// Client bundle for the Frame.io Asset Watch UI.
//
// Two jobs:
//   1. Register the Spectrum Web Components used by the server-rendered HTML so
//      the plain markup upgrades into Spectrum 2 widgets in the browser.
//   2. Progressive enhancement: the page is fully functional with plain POST
//      forms when this script never runs. When it does run we intercept the
//      forms to give richer behaviour (a switch that submits on toggle, a
//      direct-to-S3 chunked upload with a progress bar, toasts).
//
// Built with esbuild → public/app.js (see package.json "build"). The bundle is
// loaded as a module from the same origin, which the page CSP allows.

// --- Spectrum 2 theme + component registrations ---------------------------
// Registering the spectrum-two theme fragments makes <sp-theme
// system="spectrum-two"> resolve to the Spectrum 2 look.
import "@spectrum-web-components/theme/spectrum-two/theme-light.js";
import "@spectrum-web-components/theme/spectrum-two/theme-dark.js";
import "@spectrum-web-components/theme/spectrum-two/scale-medium.js";
import "@spectrum-web-components/theme/sp-theme.js";

import "@spectrum-web-components/switch/sp-switch.js";
import "@spectrum-web-components/action-button/sp-action-button.js";
import "@spectrum-web-components/button/sp-button.js";
import "@spectrum-web-components/dropzone/sp-dropzone.js";
import "@spectrum-web-components/progress-bar/sp-progress-bar.js";
import "@spectrum-web-components/toast/sp-toast.js";
import "@spectrum-web-components/accordion/sp-accordion.js";
import "@spectrum-web-components/accordion/sp-accordion-item.js";
import "@spectrum-web-components/avatar/sp-avatar.js";
import "@spectrum-web-components/field-label/sp-field-label.js";

// The DOM lib isn't in the worker tsconfig (this file is excluded from it and
// only ever built by esbuild), so lean on `any` for browser globals rather
// than pulling DOM types into the strict server typecheck.
/* eslint-disable @typescript-eslint/no-explicit-any */
declare const window: any;
declare const document: any;
declare const XMLHttpRequest: any;
declare const location: any;
declare const fetch: any;

function ready(fn: () => void): void {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", fn);
  } else {
    fn();
  }
}

// --- theme: follow the OS light/dark preference --------------------------
// sp-theme has a fixed `color`; there is no "auto". We mirror the OS
// preference onto it here. Because this module is deferred there is a brief
// flash of the SSR default (light) before this runs — an accepted trade-off
// for keeping scripts out of the inline CSP.
function wireTheme(): void {
  const theme = document.querySelector("sp-theme");
  if (!theme) return;
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const apply = () => theme.setAttribute("color", mq.matches ? "dark" : "light");
  apply();
  if (typeof mq.addEventListener === "function") {
    mq.addEventListener("change", apply);
  }
}

// --- watch/unwatch: submit the form when the switch toggles --------------
function wireWatchToggles(): void {
  const forms = document.querySelectorAll('form[data-enhance="toggle"]');
  forms.forEach((form: any) => {
    const sw = form.querySelector("sp-switch");
    if (!sw) return;
    sw.addEventListener("change", () => submitForm(form));
  });
}

// --- action buttons (unwatch, refresh comments): submit on click ---------
// These sp-action-buttons deliberately have no type="submit"; we submit via
// this handler so there is never a double submission.
function wireActionSubmits(): void {
  const buttons = document.querySelectorAll("sp-action-button[data-submit]");
  buttons.forEach((btn: any) => {
    btn.addEventListener("click", () => {
      const form = btn.closest("form");
      if (form) submitForm(form);
    });
  });
}

function submitForm(form: any): void {
  if (typeof form.requestSubmit === "function") form.requestSubmit();
  else form.submit();
}

// --- toasts ---------------------------------------------------------------
function toastRegion(): any {
  let region = document.getElementById("toast-region");
  if (!region) {
    region = document.createElement("div");
    region.id = "toast-region";
    const host = document.querySelector("sp-theme") || document.body;
    host.appendChild(region);
  }
  return region;
}

function showToast(text: string, variant?: string): any {
  const toast = document.createElement("sp-toast");
  toast.open = true;
  toast.timeout = 6000;
  if (variant) toast.variant = variant;
  toast.textContent = text;
  toast.addEventListener("close", () => toast.remove());
  toastRegion().appendChild(toast);
  return toast;
}

// --- direct-to-presigned-URL upload --------------------------------------
// Tagged so the catch below can tell a browser→S3 PUT failure (almost always
// CORS: the presigned host must allow this origin) apart from a prepare or
// finalize error returned by our own worker.
class PutError extends Error {
  stage = "put" as const;
}

function wireUploads(): void {
  const forms = document.querySelectorAll("form[data-upload]");
  forms.forEach((form: any) => {
    form.addEventListener("submit", (event: any) => {
      // Set by the CORS fallback below: let this one submit natively.
      if (form.dataset.fallback === "1") return;
      event.preventDefault();
      const input = form.querySelector('input[type="file"]');
      const file = input && input.files && input.files[0];
      if (!file) {
        showToast("Choose a file to upload first.", "negative");
        return;
      }
      void startDirectUpload(form, file);
    });
    wireDropzone(form);
  });
}

// A drop onto sp-dropzone just populates the hidden file input; the rest of
// the flow is identical to picking a file.
function wireDropzone(form: any): void {
  const dropzone = form.querySelector("sp-dropzone");
  const input = form.querySelector('input[type="file"]');
  if (!dropzone || !input) return;
  dropzone.addEventListener("sp-dropzone-drop", (event: any) => {
    const dt = event.detail && event.detail.dataTransfer;
    if (dt && dt.files && dt.files.length > 0) {
      input.files = dt.files;
      const name = form.querySelector("[data-file-name]");
      if (name) name.textContent = dt.files[0].name;
    }
  });
  input.addEventListener("change", () => {
    const name = form.querySelector("[data-file-name]");
    if (name) name.textContent = input.files && input.files[0] ? input.files[0].name : "";
  });
}

async function startDirectUpload(form: any, file: any): Promise<void> {
  const fileId = form.dataset.fileId;
  const progress = form.querySelector("sp-progress-bar");
  const submit = form.querySelector('[data-upload-submit]');
  const setProgress = (pct: number) => {
    if (progress) {
      progress.hidden = false;
      progress.progress = pct;
      progress.label = `Uploading… ${pct}%`;
    }
  };
  if (submit) submit.disabled = true;
  setProgress(0);

  try {
    // 1. Ask the worker to create the placeholder file + presigned chunk URLs.
    const prep = await fetch(`/assets/${encodeURIComponent(fileId)}/versions/prepare`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: file.name || "upload.bin",
        size: file.size,
        type: file.type || "application/octet-stream",
      }),
    });
    if (!prep.ok) {
      const detail = await readError(prep);
      throw new Error(detail);
    }
    const prepared = await prep.json();
    const uploadUrls: Array<{ url: string; size: number }> = prepared.upload_urls || [];
    const newFileId: string = prepared.new_file_id;

    // 2. PUT each chunk straight to S3 from the browser.
    //    Browser chunk PUTs depend on Frame.io's S3 CORS allowing this origin,
    //    the PUT method, and the x-amz-acl / Content-Type headers. When that
    //    isn't configured the PUT throws and we fall back to the proxy form.
    const total = uploadUrls.reduce((sum, c) => sum + c.size, 0);
    if (total !== file.size) {
      throw new Error(
        `Frame.io returned chunks totalling ${total} bytes for a ${file.size}-byte file.`,
      );
    }
    const contentType = file.type || "application/octet-stream";
    let uploadedBase = 0;
    let offset = 0;
    for (const chunk of uploadUrls) {
      const end = Math.min(offset + chunk.size, file.size);
      const slice = file.slice(offset, end);
      await putChunk(chunk.url, slice, contentType, (loaded: number) => {
        setProgress(Math.min(100, Math.round(((uploadedBase + loaded) / total) * 100)));
      });
      uploadedBase += chunk.size;
      offset = end;
      setProgress(Math.min(100, Math.round((uploadedBase / total) * 100)));
    }

    // 3. Stack the uploaded file as a new version of the watched asset.
    const fin = await fetch(`/assets/${encodeURIComponent(fileId)}/versions/finalize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ new_file_id: newFileId }),
    });
    if (!fin.ok) {
      // The bytes are uploaded; only the version stacking failed. Re-submitting
      // the form would upload a duplicate, so surface a warning instead.
      const detail = await readError(fin);
      showToast(`New version uploaded, but stacking it failed: ${detail}`, "negative");
      if (progress) progress.hidden = true;
      if (submit) submit.disabled = false;
      return;
    }

    showToast("New version submitted.", "positive");
    setTimeout(() => location.assign(`/?uploaded=${encodeURIComponent(fileId)}`), 900);
  } catch (err: any) {
    if (err instanceof PutError) {
      // CORS (or any direct-PUT failure): retry through the server-side proxy
      // form, which PUTs from the worker and so isn't subject to browser CORS.
      showToast("Direct upload blocked; retrying through the server…", "info");
      if (progress) progress.hidden = true;
      form.dataset.fallback = "1";
      form.submit();
      return;
    }
    showToast(`Upload failed: ${err && err.message ? err.message : String(err)}`, "negative");
    if (progress) progress.hidden = true;
    if (submit) submit.disabled = false;
  }
}

function putChunk(
  url: string,
  body: any,
  contentType: string,
  onProgress: (loaded: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", contentType);
    xhr.setRequestHeader("x-amz-acl", "private");
    if (xhr.upload) {
      xhr.upload.onprogress = (e: any) => {
        if (e.lengthComputable) onProgress(e.loaded);
      };
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new PutError(`PUT chunk → ${xhr.status}`));
    };
    xhr.onerror = () => reject(new PutError("PUT chunk failed (network or CORS)"));
    xhr.ontimeout = () => reject(new PutError("PUT chunk timed out"));
    xhr.send(body);
  });
}

async function readError(resp: any): Promise<string> {
  try {
    const body = await resp.json();
    return body.detail || body.error || `HTTP ${resp.status}`;
  } catch {
    return `HTTP ${resp.status}`;
  }
}

ready(() => {
  wireTheme();
  wireWatchToggles();
  wireActionSubmits();
  wireUploads();
});
