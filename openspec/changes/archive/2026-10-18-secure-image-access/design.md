# Design

## Context

The backend is an Express 5 application on Node.js using TiDB with `mysql2` and `sequelize`. User authentication uses JWT tokens verified in `backend/middlewares/authorize.js`, with row-level student authorization managed by `backend/models/ImageModel.js`. Image assets are uploaded to Cloudinary via `backend/config/cloudinary.js`. Expiration durations are made configurable via environment variables. See `proposal.md` for motivation.

## Goals / Non-Goals

**Goals:**
- Eliminate public exposure of protected student images in Cloudinary.
- Implement an authorized `GET /images/:id/url` endpoint issuing short-lived signed URLs/tokens.
- Protect against IDOR by enforcing row-level student access controls before URL issuance.
- Enable environment variable configuration for expiring URL durations (`CLOUDINARY_URL_EXPIRATION_SECONDS` and `CLOUDINARY_LIST_URL_EXPIRATION_SECONDS`) with safe defaults and clamping (60s to 86,400s).
- Provide secure client-side rendering with automatic retry/refresh and zero secret leakage.
- Hide raw image URL text inputs and raw URL string labels from the user interface to avoid confusing users with temporary expiring URLs or exposing internal asset paths.
- Maintain backward-compatibility for existing public images and local mock tests.

**Non-Goals:**
- Building a custom image binary proxy on Express (which would sacrifice CDN performance and introduce unnecessary server bandwidth overhead).
- Real-time instant revocation of already-issued tokens prior to their TTL expiration.

## Decisions

### Decision 1: Cloudinary Expiring Delivery Strategy
- **Choice**: Hybrid Token and Private Download Delivery.
  - Primary: If `CLOUDINARY_AUTH_TOKEN_KEY` is configured in the environment, use `cloudinary.utils.generate_auth_token` with `type: 'authenticated'` to generate edge-expiring tokens (`__cld_token__=exp=...~acl=...~hmac=...`).
  - Fallback: If `CLOUDINARY_AUTH_TOKEN_KEY` is omitted, use `cloudinary.utils.private_download_url` with signed `expires_at` via `CLOUDINARY_API_SECRET`.
- **Alternatives Considered**:
  - *Standard Signed URLs (`sign_url: true` without token)*: Rejected because standard Cloudinary signatures only protect against URL tampering and do NOT expire over time.
  - *Express Streaming Proxy for all images*: Rejected because streaming all image data through Node.js incurs high CPU and bandwidth cost, eliminating Cloudinary's global CDN advantages.

### Decision 2: Configurable Expiration Durations via Environment Variables
- **Choice**:
  - `CLOUDINARY_URL_EXPIRATION_SECONDS`: Single image URL expiration duration (default: 300s, clamped 60s - 86,400s).
  - `CLOUDINARY_LIST_URL_EXPIRATION_SECONDS`: List browsing URL duration (default: 900s, clamped 60s - 86,400s).
- **Rationale**: Keeps durations tunable across staging/production environments without touching code.

### Decision 3: Authorization & IDOR Enforcement
- **Choice**: Execute row-level verification in `ImageModel.findById(imageId, req.user)` before generating any signed URL.
  - Admins have access to all images.
  - Volunteers, Teachers, and Sponsors are restricted to their linked student IDs.
  - If unauthorized, return HTTP 403 immediately without calling Cloudinary.

### Decision 4: URL Issuance Endpoint & Response Caching
- **Choice**: `GET /images/:id/url` returning `{ "url": string, "expiresAt": string, "expiresIn": number }` with `Cache-Control: private, no-store, max-age=0`.
  - Does not expose Cloudinary secrets or internal metadata.
  - Instructs downstream proxies and browsers never to cache URL issuance responses.

### Decision 5: Frontend State & Refresh Strategy
- **Choice**: Extend `SafeImage` in `ImageListClient.tsx`.
  - When rendering an image, use the backend-provided expiring URL.
  - If an image fails to load or the URL expires, execute a single refresh via `GET /images/:id/url`.
  - Enforce a strict retry limit (`maxRetries: 1`) to eliminate infinite reload loops.
  - Never save temporary URLs to `localStorage` or `sessionStorage`.

### Decision 6: Hiding Raw Image URLs in the UI
- **Choice**: Remove the manual URL input box (`Form Input: Image URL`) and raw URL text span (`title={formUrl}`) from the Create/Edit modal in `ImageListClient.tsx`.
- **Form Behavior**:
  - **Create**: Requires selecting an image file via the file picker; the backend handles uploading and generating storage keys.
  - **Edit**: Allows selecting a new file to replace the existing image; if no new file is chosen, the existing asset reference is preserved without prompting the user to edit a raw URL.
- **Rationale**: Ephemeral signed URLs contain time-sensitive tokens and query parameters (`__cld_token__` or `expires_at`) that should never be manually entered or edited by users.

## Risks / Trade-offs

- **[Risk] Shared Bearer URL during active TTL**: A short-lived URL can be viewed by anyone who intercepts it before it expires.
  - *Mitigation*: Restrict TTL to a short duration (configurable, default 300s) and set `Cache-Control: private, no-store`.
- **[Risk] Invalid or non-numeric environment variable**:
  - *Mitigation*: Defensive integer parsing with `isNaN` check and fallback defaults.
- **[Risk] High API load if every thumbnail requests a fresh URL**:
  - *Mitigation*: Paginated list endpoint (`getAllImages`) provides temporary URLs for the active page items directly, avoiding N+1 requests on initial render.

## Migration Plan

1. Document `CLOUDINARY_AUTH_TOKEN_KEY`, `CLOUDINARY_URL_EXPIRATION_SECONDS`, and `CLOUDINARY_LIST_URL_EXPIRATION_SECONDS` in `backend/.env.example`.
2. Deploy backend updates (`cloudinary.js`, `ImageController.js`, `imageRoutes.js`).
3. Deploy frontend updates (`images.ts`, `ImageListClient.tsx`).
