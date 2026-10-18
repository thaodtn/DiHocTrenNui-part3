# image-storage Specification

## Purpose
Provides secure, scalable image upload, Cloudinary cloud storage, metadata persistence in TiDB, and global CDN delivery across the application.

## Requirements

### Requirement: Secure image upload validation
The backend API SHALL accept multipart/form-data image uploads, enforce file size limits, verify file magic bytes, and reject invalid or spoofed image files.

#### Scenario: Valid image file upload
- **WHEN** an authenticated user uploads an allowed image file (JPEG, PNG, or WebP) within the configured size limit
- **THEN** the backend accepts the file and streams it directly to Cloudinary without persisting temporary files to disk

#### Scenario: Spoofed MIME type rejection
- **WHEN** a client submits a non-image file with a forged `image/jpeg` or `image/png` header
- **THEN** magic-byte signature validation rejects the request with a 400 Bad Request error

#### Scenario: File size limit exceeded
- **WHEN** a client uploads a file exceeding the configured maximum file size
- **THEN** the upload middleware rejects the request with an explicit size limit error

### Requirement: Cloudinary asset management and rollback
The system SHALL stream accepted image buffers to Cloudinary as authenticated assets under a predictable folder structure, persist the asset's `public_id`, delivery type, and metadata in TiDB, and rollback Cloudinary assets if database transactions fail.

#### Scenario: Successful image creation with metadata
- **WHEN** an image upload to Cloudinary succeeds
- **THEN** the asset is created with authenticated delivery type, and the `public_id`, delivery type, dimensions, and format are stored in the `metadata` JSON column of the `images` table in TiDB

#### Scenario: Database failure rollback
- **WHEN** an image is uploaded to Cloudinary but the subsequent database write fails
- **THEN** the system triggers immediate cleanup of the uploaded Cloudinary asset via its `public_id` and surfaces the original database error without masking

### Requirement: Atomic image replacement
The system SHALL allow updating an existing image record with a new file, deleting the obsolete Cloudinary asset only after the database update successfully commits.

#### Scenario: Image replacement succeeds
- **WHEN** a user updates an image record with a new image file
- **THEN** the new file is uploaded to Cloudinary, the database record is updated, and the previous Cloudinary asset is destroyed only if no other database record references it

#### Scenario: Keep existing image when no new file is provided
- **WHEN** an update request is submitted without a new file attachment
- **THEN** the existing `url` and `metadata` are retained in TiDB and no Cloudinary assets are deleted

### Requirement: Remote image rendering in Next.js
The frontend application SHALL fetch and render authenticated Cloudinary images using short-lived access URLs, handle token expiration gracefully with automatic refresh, and prevent caching of temporary credentials.

#### Scenario: Render Cloudinary image in image list
- **WHEN** an authorized user views an image in the image gallery or student profile
- **THEN** the Next.js `Image` component renders the image using a temporary signed access URL obtained from the backend URL-issuing endpoint, handling expiration with automatic refresh

#### Scenario: Temporary URLs are not persisted
- **WHEN** temporary image access URLs are fetched by the browser
- **THEN** the frontend avoids persisting the signed URLs in permanent storage or browser local storage

### Requirement: Authorized time-limited URL generation
The system SHALL provide an authorized endpoint that validates user authentication and student access permissions before generating a short-lived, time-limited Cloudinary access URL or token.

#### Scenario: Authorized user requests image access URL
- **WHEN** an authenticated user with permission to access a student's records requests the URL for an image belonging to that student
- **THEN** the backend responds with HTTP 200, returning a short-lived expiring URL or token with headers including `Cache-Control: private, no-store, max-age=0`

#### Scenario: Unauthenticated request rejected
- **WHEN** a request is made to the URL generation endpoint without a valid authentication token
- **THEN** the request is rejected with HTTP 401 Unauthorized

#### Scenario: Unauthorized cross-student IDOR attempt rejected
- **WHEN** an authenticated user attempts to request an access URL for an image belonging to a student outside their assigned scope
- **THEN** the request is rejected with HTTP 403 Forbidden without generating an access URL or token

#### Scenario: Non-existent image ID returns 404
- **WHEN** an authenticated user requests a URL for an image ID that does not exist in the database
- **THEN** the system responds with HTTP 404 Not Found

#### Scenario: Cloudinary signing failure does not fall back to public access
- **WHEN** an error occurs during Cloudinary token or URL generation
- **THEN** the backend returns an HTTP 500 error and SHALL NOT fall back to a public asset URL

### Requirement: Configurable expiring URL duration
The backend SHALL allow configuring the default duration of expiring signed URLs (both CDN token-based delivery and private download URLs) via environment variables, applying sensible fallbacks when environment variables are omitted or invalid.

#### Scenario: Custom expiration duration via environment variable
- **WHEN** `CLOUDINARY_URL_EXPIRATION_SECONDS` is set in the environment to a positive integer
- **THEN** the system uses this configured value as the default expiration duration for expiring image URLs

#### Scenario: Fallback to default duration when unconfigured
- **WHEN** `CLOUDINARY_URL_EXPIRATION_SECONDS` is omitted or contains an invalid value
- **THEN** the system falls back to a default expiration duration of 300 seconds

#### Scenario: Configurable list browsing duration
- **WHEN** `CLOUDINARY_LIST_URL_EXPIRATION_SECONDS` is set in the environment
- **THEN** the system uses this configured duration for dynamic URLs generated during list queries, falling back to 900 seconds when omitted
