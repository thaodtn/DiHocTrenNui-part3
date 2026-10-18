# Proposal

## Why

Protected images (such as student photos) stored in Cloudinary were previously uploaded with public delivery type and referenced via permanent public URLs, allowing anyone with a captured URL to access sensitive student images indefinitely. Securing image delivery with authenticated Cloudinary assets and short-lived, authorized URL/token issuance prevents unauthorized data access while preserving high-performance CDN delivery. Furthermore, the expiration durations for temporary URLs must be configurable via environment variables (`CLOUDINARY_URL_EXPIRATION_SECONDS` and `CLOUDINARY_LIST_URL_EXPIRATION_SECONDS`) to adapt to varying operational and security constraints.

## What Changes

- Change default Cloudinary asset upload delivery type from `upload` (public) to `authenticated` for protected student images.
- Introduce a dedicated, authorized backend URL-issuing endpoint `GET /images/:id/url` that validates user permissions, verifies student authorization via TiDB, and returns a time-limited signed Cloudinary access URL or token with `Cache-Control: private, no-store`.
- Implement server-side generation of short-lived expiring URLs using Cloudinary token-based authentication (`__cld_token__`) or signed download API (`private_download_url` with `expires_at`), without exposing Cloudinary API secrets.
- Make expiring URL validity durations configurable via environment variables (`CLOUDINARY_URL_EXPIRATION_SECONDS` defaulting to 300s, `CLOUDINARY_LIST_URL_EXPIRATION_SECONDS` defaulting to 900s), with automatic clamping to safe limits.
- Update frontend image fetching and components (`ImageListClient.tsx`, `SafeImage`) to load authenticated images via short-lived URLs, with automatic token refresh on expiration and retry limits to prevent request loops.
- Prevent caching or persistence of temporary signed URLs in local storage or permanent database records.

## Capabilities

### New Capabilities
<!-- None: Modifying existing image-storage capability -->

### Modified Capabilities
- `image-storage`: Introduce authenticated asset storage delivery type, backend authorized expiring URL/token issuance with configurable expiration durations via environment variables, and secure rendering of expiring image URLs in Next.js.

## Impact

- **Backend**: `backend/config/cloudinary.js`, `backend/controllers/ImageController.js`, `backend/routes/imageRoutes.js`, `backend/.env.example`.
- **Database**: Reuses existing `images` table in TiDB; metadata stores asset delivery type (`authenticated`).
- **Frontend**: `frontend/src/services/images.ts`, `frontend/src/app/(member)/images/_components/ImageListClient.tsx`.
- **Security**: Eliminates public image exposure; prevents IDOR via row-level permission enforcement on each access request.
