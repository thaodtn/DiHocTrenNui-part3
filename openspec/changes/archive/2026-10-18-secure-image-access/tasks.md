# Tasks

## 1. Backend Cloudinary Configuration & Expiring Delivery Service

- [x] 1.1 Implement `generateExpiringUrl` supporting Cloudinary token-based (`__cld_token__`) and private download signature in `backend/config/cloudinary.js`, and verify unit tests pass
- [x] 1.2 Update `uploadStream` in `backend/config/cloudinary.js` to default to `type: 'authenticated'` for student assets while persisting delivery type in TiDB metadata, and verify test assertions pass
- [x] 1.3 Add `CLOUDINARY_AUTH_TOKEN_KEY` placeholder in `backend/.env.example` with security documentation

## 2. Backend URL-Issuing Endpoint & IDOR Protection

- [x] 2.1 Add route `GET /images/:id/url` with `authenticate` and `authorize(ACTIONS.READ, RESOURCES.IMAGE)` in `backend/routes/imageRoutes.js`
- [x] 2.2 Implement `getImageUrl` controller method in `backend/controllers/ImageController.js` enforcing row-level student authorization via `ImageModel.findById`, setting `Cache-Control: private, no-store, max-age=0`, and verify via automated route test
- [x] 2.3 Update `getAllImages` and `getImagesByStudent` response formatting in `backend/controllers/ImageController.js` to generate dynamic ephemeral URLs for paginated items rather than leaking static public URLs

## 3. Frontend Integration & Resilient Rendering

- [x] 3.1 Implement `getImageUrl` service method in `frontend/src/services/images.ts` calling `GET /images/:id/url`
- [x] 3.2 Update `ImageListClient.tsx` and image rendering logic to render expiring URLs, handle token refresh on expiration, and enforce a strict 1-retry limit to prevent infinite loops

## 4. Automated Testing & Verification

- [x] 4.1 Expand `backend/tests/test_cloudinary_image.js` to cover authenticated asset streaming, expiring token URL generation, and error fallback rejection
- [x] 4.2 Implement endpoint authorization tests for `GET /images/:id/url` covering unauthenticated (401), cross-student IDOR (403), missing image (404), and authorized success (200) scenarios
- [x] 4.3 Run full test suite and verify all image storage, security, and rendering tests pass cleanly

## 5. Configurable Expiring URL Duration via Environment Variables

- [x] 5.1 Add `CLOUDINARY_URL_EXPIRATION_SECONDS` and `CLOUDINARY_LIST_URL_EXPIRATION_SECONDS` to `backend/.env.example` with documentation
- [x] 5.2 Update `generateExpiringUrl` in `backend/config/cloudinary.js` to resolve default duration from `CLOUDINARY_URL_EXPIRATION_SECONDS` with safe integer parsing, fallback (300), and boundary clamping
- [x] 5.3 Update `formatImageResponse` and `getImageUrl` in `backend/controllers/ImageController.js` to resolve duration from environment variables
- [x] 5.4 Add automated tests verifying custom environment variables override expiration duration for single URLs and list browsing

