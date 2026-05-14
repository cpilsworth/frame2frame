### File and comment maagement with ESM

If the customer is using **ESM-backed Workfront + Frame**, then:

- **Upload files / upload new versions:** use the **Workfront document/version API surface**.
- **Read review comments / commenter data:** use the **Frame API**.
- **Do not treat ESM itself as your public integration API** for either of those jobs.

In this model, **Workfront is the orchestration surface**, **ESM is the authoritative storage layer**, and **Frame is the review/comment surface**. Comments and markup remain in Frame rather than Workfront.

Sources:
- [Workfront + Frame + ESM (ACPC) Integration](https://wiki.corp.adobe.com/spaces/frameind/pages/3848421193/Workfront+Frame+ESM+ACPC+Integration)
- [Frame.io Product Integrations and Current Capabilities](https://wiki.corp.adobe.com/spaces/frameind/pages/3843191368/Frame.io+Product+Integrations+and+Current+Capabilities)
- [Unified review and approval overview](https://experienceleague.adobe.com/en/docs/workfront/using/review-and-approve-work/document-approvals-overview)
- [Review and approve with the Frame.io viewer](https://experienceleague.adobe.com/en/docs/workfront/using/review-and-approve-work/document-reviews-and-approvals/review-and-approve-documents/review-with-frame)

### What to use for your two use cases

#### 1) Upload files and upload **new versions** into ESM-backed assets

Use **Workfront**.

Why:
- In the ESM-backed architecture, upload from Workfront goes through the Workfront/ESM connector path into ESM.
- Versioning is expected to stay aligned across Workfront, ESM, and Frame.
- Internal requirements explicitly call out that customers should be able to upload/manage assets in Workfront stored in ESM, and upload new versions via Workfront.

Sources:
- [Frame.io Product Integrations and Current Capabilities](https://wiki.corp.adobe.com/spaces/frameind/pages/3843191368/Frame.io+Product+Integrations+and+Current+Capabilities)
- [W2.0 - Upload an asset](https://wiki.corp.adobe.com/display/ACPC/W2.0+-+Upload+an+asset)
- [Versioning of Documents](https://wiki.corp.adobe.com/display/ACPC/Versioning+of+Documents)
- [Workfront + Frame.io Lexicon](https://wiki.corp.adobe.com/pages/viewpage.action?pageId=3008795477)

**Practical recommendation:**  
If your system is the one creating/updating the asset, make Workfront the entry point for:
- initial file create
- subsequent new-version uploads

That gives you the least ambiguous lifecycle in ESM-backed projects.

#### 2) Enumerate comments for downstream sync

Use **Frame**.

Why:
- Adobe’s unified review docs say comments and markup are visible in the **Frame.io viewer** and remain there for context.
- The Frame connector/docs expose comment operations like **List comments** and **Get a comment** for a specific asset.
- Frame is explicitly the source of truth for annotations and Frame-viewer comments in the ESM-backed architecture.

Sources:
- [Unified review and approval overview](https://experienceleague.adobe.com/en/docs/workfront/using/review-and-approve-work/document-approvals-overview)
- [Review and approve with the Frame.io viewer](https://experienceleague.adobe.com/en/docs/workfront/using/review-and-approve-work/document-reviews-and-approvals/review-and-approve-documents/review-with-frame)
- [Frame.io modules](https://experienceleague.adobe.com/en/docs/workfront-fusion/using/references/apps-and-their-modules/adobe-connectors/frame-io-modules-new)
- [Frame.io Product Integrations and Current Capabilities](https://wiki.corp.adobe.com/spaces/frameind/pages/3843191368/Frame.io+Product+Integrations+and+Current+Capabilities)

### For the extra metadata you want

#### Asset names
**Yes** — get them from the **Frame asset** side (`Get asset` / `List assets in folder`) when you sync comments.

Sources:
- [Frame.io modules](https://experienceleague.adobe.com/en/docs/workfront-fusion/using/references/apps-and-their-modules/adobe-connectors/frame-io-modules-new)
- [Fusion + Frame.io V4](https://wiki.corp.adobe.com/pages/viewpage.action?pageId=3407185801)

#### Commenter names
**Likely yes in practice**, but I did **not** find a clean public doc snippet in the returned sources that enumerates the exact author fields in the comment payload. So I would design for:
- `List comments` / `Get comment`
- capture the author/user object returned by the Frame endpoint
- validate the exact field names in your tenant/API version before you finalize the mapping

That is the right implementation direction, but I don’t want to invent payload fields without a doc excerpt.

Sources:
- [Frame.io modules](https://experienceleague.adobe.com/en/docs/workfront-fusion/using/references/apps-and-their-modules/adobe-connectors/frame-io-modules-new)
- [Fusion + Frame.io V4](https://wiki.corp.adobe.com/pages/viewpage.action?pageId=3407185801)

### Important caveat: don’t build on internal bridge endpoints

There **are** Workfront/Frame bridge endpoints like `/workfront_files`, but the docs explicitly mark them as **internal-only** and scoped to allow-listed Workfront service usage. That means they are **not** the right dependency for a customer integration.

So if your plan was:
- upload through Workfront
- later ask Frame “which asset corresponds to this Workfront/ESM item?”
- using an internal bridge API

…don’t do that unless you are on a first-party Adobe implementation path.

Source:
- [/workfront_files - Workfront files (available) API for CSC Approval workflow](https://wiki.corp.adobe.com/spaces/FIO/pages/3616507630/workfront_files+-+Workfront+files+available+API+for+CSC+Approval+workflow)

### Recommended implementation pattern

#### Best pattern for your sync

1. **Create/update the file through Workfront**
   - initial upload
   - later new-version uploads

2. **Persist the cross-system IDs at creation time**
   - Workfront document ID
   - Workfront document version ID
   - Frame project/folder/asset ID if you can observe it from the integration flow
   - any ESM asset identifier you’re given

3. **Read comments from Frame**
   - `List comments` for the asset
   - optionally `Get comment` for detail enrichment

4. **Enrich with asset metadata**
   - `Get asset` or folder asset listing for asset name/path context

5. **Sync downstream using Frame as the review record**
   - comment text
   - timestamps
   - commenter identity
   - asset identity/name
   - version context if needed

Sources:
- [Frame.io Product Integrations and Current Capabilities](https://wiki.corp.adobe.com/spaces/frameind/pages/3843191368/Frame.io+Product+Integrations+and+Current+Capabilities)
- [Workfront + Frame.io Lexicon](https://wiki.corp.adobe.com/pages/viewpage.action?pageId=3008795477)
- [Frame.io modules](https://experienceleague.adobe.com/en/docs/workfront-fusion/using/references/apps-and-their-modules/adobe-connectors/frame-io-modules-new)
- [Fusion + Frame.io V4](https://wiki.corp.adobe.com/pages/viewpage.action?pageId=3407185801)

### Direct answer to your question

If ESM is the shared storage behind Workfront + Frame:

- **Use the Workfront API to upload files and create new versions**
- **Use the Frame API to enumerate comments and comment-related review data**
- **Use Frame asset endpoints to pull asset names**
- **Expect commenter identity from Frame comment detail payloads, but verify exact fields in your tenant**
- **Avoid internal `/workfront_*` bridge APIs**

### Decision checklist

- [Done] Identify the correct write surface for files: **Workfront**
- [Done] Identify the correct read surface for comments: **Frame**
- [Done] Confirm comments do **not** live in Workfront for this use case
- [Done] Flag internal-only APIs to avoid
- [Closed] Exact commenter field names in public docs: **not confirmed from the sources I retrieved**

If you want, I can next turn this into either:
1. a **concrete API workflow**,
2. a **Fusion scenario design**, or
3. a **field mapping spec** for `Workfront document ↔ Frame asset ↔ external system comment record`.