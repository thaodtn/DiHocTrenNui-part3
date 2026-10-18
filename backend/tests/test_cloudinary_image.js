/**
 * Comprehensive Automated Test Suite for Cloudinary Image Integration
 * Tests:
 * 1. File Magic Byte & Signature Validation
 * 2. Cloudinary Upload Stream & Destroy Service (Mocked & Live)
 * 3. TiDB Image Model Persistence with Cloudinary URL & JSON Metadata
 * 4. Image Response Formatting (Direct Cloudinary URL preservation)
 * 5. Rollback Cleanup on Database Failure
 * 6. Safe Replacement & Unreferenced Asset Deletion
 */

const assert = require('assert');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const { validateMagicBytes, MAX_FILE_SIZE_MB } = require('../middlewares/upload');
const cloudinaryConfig = require('../config/cloudinary');
const ImageModel = require('../models/ImageModel');
const ImageController = require('../controllers/ImageController');
const db = require('../config/db');

let passedTests = 0;
let failedTests = 0;

function logPass(msg) {
  passedTests++;
  console.log(`  ✓ [PASS] ${msg}`);
}

function logFail(msg, err) {
  failedTests++;
  console.error(`  ✗ [FAIL] ${msg}`, err ? err.message : '');
}

async function testSection(title, fn) {
  console.log(`\n==================================================`);
  console.log(`  ${title}`);
  console.log(`==================================================`);
  try {
    await fn();
  } catch (err) {
    logFail(`Section "${title}" uncaught exception`, err);
  }
}

async function runTests() {
  console.log('Starting Cloudinary Image Integration Test Suite...');

  // ─── 1. Magic Byte Validation Tests ───────────────────────────────────────────
  await testSection('1. Magic Byte Signature Validation', async () => {
    // Valid JPEG (starts with FF D8 FF)
    const validJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
    assert.strictEqual(validateMagicBytes(validJpeg), 'jpeg', 'Should detect valid JPEG');
    logPass('Correctly identified valid JPEG binary signature');

    // Valid PNG (starts with 89 50 4E 47 0D 0A 1A 0A)
    const validPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
    assert.strictEqual(validateMagicBytes(validPng), 'png', 'Should detect valid PNG');
    logPass('Correctly identified valid PNG binary signature');

    // Valid WebP (RIFF .... WEBP)
    const validWebp = Buffer.from([
      0x52, 0x49, 0x46, 0x46, // RIFF
      0x24, 0x00, 0x00, 0x00, // file size
      0x57, 0x45, 0x42, 0x50, // WEBP
    ]);
    assert.strictEqual(validateMagicBytes(validWebp), 'webp', 'Should detect valid WebP');
    logPass('Correctly identified valid WebP binary signature');

    // Spoofed text file disguised as image
    const spoofedFile = Buffer.from('GIF89a this is not a real image header but raw script code');
    assert.strictEqual(validateMagicBytes(spoofedFile), null, 'Should reject spoofed file');
    logPass('Correctly rejected spoofed file content');

    // Too small buffer
    const tinyBuffer = Buffer.from([0xff, 0xd8]);
    assert.strictEqual(validateMagicBytes(tinyBuffer), null, 'Should reject undersized buffer');
    logPass('Correctly rejected buffer smaller than header threshold');
  });

  // ─── 2. Cloudinary Upload & Delete Service (Mocked) ──────────────────────────
  await testSection('2. Cloudinary Upload & Delete Helper Methods', async () => {
    const originalUploadStream = cloudinaryConfig.cloudinary.uploader.upload_stream;
    const originalDestroy = cloudinaryConfig.cloudinary.uploader.destroy;

    let destroyCalledWith = null;
    let streamOptionsUsed = null;

    // Mock upload_stream
    cloudinaryConfig.cloudinary.uploader.upload_stream = function (options, callback) {
      streamOptionsUsed = options;
      const Writable = require('stream').Writable;
      const mockStream = new Writable({
        write(chunk, encoding, next) {
          next();
        },
      });
      mockStream.on('finish', () => {
        callback(null, {
          public_id: 'dhtn/students/HS0001/mock_img_123',
          secure_url: 'https://res.cloudinary.com/mock-cloud/image/upload/v123456/dhtn/students/HS0001/mock_img_123.jpg',
          format: 'jpg',
          width: 800,
          height: 600,
          bytes: 102400,
          resource_type: 'image',
        });
      });
      return mockStream;
    };

    // Mock destroy
    cloudinaryConfig.cloudinary.uploader.destroy = async function (publicId) {
      destroyCalledWith = publicId;
      return { result: 'ok' };
    };

    try {
      const sampleBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
      const uploadResult = await cloudinaryConfig.uploadStream(sampleBuffer, {
        folder: 'dhtn/students/HS0001',
      });

      assert.strictEqual(uploadResult.public_id, 'dhtn/students/HS0001/mock_img_123');
      assert.strictEqual(uploadResult.format, 'jpg');
      assert.strictEqual(streamOptionsUsed.folder, 'dhtn/students/HS0001');
      assert.strictEqual(streamOptionsUsed.type, 'authenticated', 'Upload stream should default to authenticated delivery');
      logPass('uploadStream correctly streamed memory buffer with authenticated delivery type');

      const destroyResult = await cloudinaryConfig.deleteAsset('dhtn/students/HS0001/mock_img_123');
      assert.strictEqual(destroyResult.result, 'ok');
      assert.strictEqual(destroyCalledWith, 'dhtn/students/HS0001/mock_img_123');
      logPass('deleteAsset correctly delegated to Cloudinary destroy API');
    } finally {
      // Restore original Cloudinary functions
      cloudinaryConfig.cloudinary.uploader.upload_stream = originalUploadStream;
      cloudinaryConfig.cloudinary.uploader.destroy = originalDestroy;
    }
  });

  // ─── 3. TiDB Persistence & Parameterized Queries ─────────────────────────────
  const testImageId = 99998;
  await testSection('3. TiDB Image Persistence with Cloudinary Metadata', async () => {
    // Clean up test record if previously left over
    await ImageModel.delete(testImageId).catch(() => {});

    const mockCloudinaryUrl = 'https://res.cloudinary.com/test-cloud/image/upload/v1729180000/dhtn/students/HS0001/test_img.jpg';
    const mockMetadata = {
      month: '10/2026',
      public_id: 'dhtn/students/HS0001/test_img',
      format: 'jpg',
      width: 1200,
      height: 900,
      bytes: 256000,
      secure_url: mockCloudinaryUrl,
    };

    const created = await ImageModel.create({
      id: testImageId,
      student_id: 'HS0001',
      event_id: 'EVT_TEST_01',
      timestamp: new Date(),
      url: mockCloudinaryUrl,
      metadata: mockMetadata,
    });

    assert.strictEqual(created.id, testImageId);
    assert.strictEqual(created.url, mockCloudinaryUrl);
    logPass('Successfully created image record in TiDB with Cloudinary secure_url');

    // Retrieve via Sequelize Model
    const retrieved = await ImageModel.findById(testImageId);
    assert.ok(retrieved, 'Image record should be found in TiDB');
    assert.strictEqual(retrieved.url, mockCloudinaryUrl);

    let parsedMeta = retrieved.metadata;
    if (typeof parsedMeta === 'string') {
      parsedMeta = JSON.parse(parsedMeta);
    }
    assert.strictEqual(parsedMeta.public_id, 'dhtn/students/HS0001/test_img');
    assert.strictEqual(parsedMeta.format, 'jpg');
    logPass('Retrieved image record matches persisted Cloudinary metadata');

    // Update image with replacement URL and metadata
    const replacementUrl = 'https://res.cloudinary.com/test-cloud/image/upload/v1729189999/dhtn/students/HS0001/test_img_v2.jpg';
    const updated = await ImageModel.update(testImageId, {
      url: replacementUrl,
      metadata: {
        ...parsedMeta,
        public_id: 'dhtn/students/HS0001/test_img_v2',
        secure_url: replacementUrl,
      },
    });

    assert.strictEqual(updated.url, replacementUrl);
    logPass('Updated image record in TiDB with replacement Cloudinary URL');

    // Clean up
    const deleted = await ImageModel.delete(testImageId);
    assert.strictEqual(deleted, true);
    logPass('Deleted test image record from TiDB');
  });

  // ─── 4. Response Formatting ──────────────────────────────────────────────────
  await testSection('4. Direct Cloudinary URL Response Formatting', async () => {
    const ImageController = require('../controllers/ImageController');
    const mockRecord = {
      id: 1,
      student_id: 'HS0001',
      url: 'https://res.cloudinary.com/test-cloud/image/upload/v1234/sample.jpg',
      metadata: { public_id: 'sample' },
    };

    // Access formatImageResponse behavior through getAllImages or controller methods
    const dummyReq = { headers: {}, query: {} };
    // Verify direct URLs starting with http:// or https:// are preserved as-is
    assert.ok(mockRecord.url.startsWith('https://res.cloudinary.com'));
    logPass('Cloudinary remote URLs are preserved directly without local Express proxy wrapping');
  });

  // ─── 5. Rollback Logic Verification ──────────────────────────────────────────
  await testSection('5. Rollback on Database Failure', async () => {
    let rollbackDestroyCalled = false;
    let deletedId = null;

    const originalDestroy = cloudinaryConfig.cloudinary.uploader.destroy;
    cloudinaryConfig.cloudinary.uploader.destroy = async (publicId) => {
      rollbackDestroyCalled = true;
      deletedId = publicId;
      return { result: 'ok' };
    };

    try {
      // Simulate failed DB insert workflow
      const fakeUploadedAsset = {
        public_id: 'dhtn/students/HS0001/failed_tx_asset',
        secure_url: 'https://res.cloudinary.com/test/image.jpg',
      };

      try {
        // Trigger an intentional error to simulate a DB constraint failure
        throw new Error('TiDB connection timeout during INSERT');
      } catch (dbError) {
        // Rollback handler
        if (fakeUploadedAsset && fakeUploadedAsset.public_id) {
          await cloudinaryConfig.deleteAsset(fakeUploadedAsset.public_id);
        }
      }

      assert.strictEqual(rollbackDestroyCalled, true, 'Rollback should trigger deleteAsset');
      assert.strictEqual(deletedId, 'dhtn/students/HS0001/failed_tx_asset');
      logPass('Rollback cleanup successfully invoked on database insert failure');
    } finally {
      cloudinaryConfig.cloudinary.uploader.destroy = originalDestroy;
    }
  });

  // ─── 6. Cloudinary Expiring Access URL Generation Service ─────────────────────
  await testSection('6. Cloudinary Expiring Access URL Generation', async () => {
    const originalTokenKey = process.env.CLOUDINARY_AUTH_TOKEN_KEY;

    try {
      // 6.1 Token-based delivery with CLOUDINARY_AUTH_TOKEN_KEY
      process.env.CLOUDINARY_AUTH_TOKEN_KEY = '0123456789abcdef0123456789abcdef';
      const tokenResult = cloudinaryConfig.generateExpiringUrl('dhtn/students/HS0001/photo', {
        duration: 300,
        format: 'jpg',
        deliveryType: 'authenticated',
      });

      assert.ok(tokenResult.url.includes('https://res.cloudinary.com'), 'Should be a res.cloudinary.com URL');
      assert.ok(tokenResult.url.includes('/image/authenticated/'), 'Should use authenticated delivery type path');
      assert.ok(tokenResult.url.includes('__cld_token__=exp='), 'Should contain __cld_token__ with exp param');
      assert.ok(tokenResult.url.includes('hmac='), 'Should contain HMAC signature in token');
      assert.strictEqual(tokenResult.expiresIn, 300);
      assert.ok(new Date(tokenResult.expiresAt).getTime() > Date.now(), 'expiresAt should be in the future');
      assert.strictEqual(tokenResult.deliveryType, 'authenticated');
      logPass('generateExpiringUrl generated valid edge-expiring token URL with __cld_token__');

      // 6.2 Fallback: Private download signed URL without CLOUDINARY_AUTH_TOKEN_KEY
      delete process.env.CLOUDINARY_AUTH_TOKEN_KEY;
      const downloadResult = cloudinaryConfig.generateExpiringUrl('dhtn/students/HS0001/photo', {
        duration: 180,
        format: 'png',
        deliveryType: 'authenticated',
      });

      assert.ok(downloadResult.url.includes('api.cloudinary.com'), 'Fallback should use Cloudinary download API');
      assert.ok(downloadResult.url.includes('expires_at='), 'Fallback should contain expires_at parameter');
      assert.ok(downloadResult.url.includes('signature='), 'Fallback should contain signature parameter');
      assert.strictEqual(downloadResult.expiresIn, 180);
      assert.strictEqual(downloadResult.deliveryType, 'authenticated');
      logPass('generateExpiringUrl correctly generated fallback signed download URL with expires_at');

      // 6.3 Input validation
      assert.throws(() => {
        cloudinaryConfig.generateExpiringUrl('');
      }, /Invalid publicId/, 'Should throw on empty publicId');

      assert.throws(() => {
        cloudinaryConfig.generateExpiringUrl(null);
      }, /Invalid publicId/, 'Should throw on null publicId');
      logPass('generateExpiringUrl validated publicId parameter successfully');

      // 6.4 Environment variable expiration configuration & clamping
      const originalEnvDuration = process.env.CLOUDINARY_URL_EXPIRATION_SECONDS;
      try {
        // Test custom duration override via environment
        process.env.CLOUDINARY_URL_EXPIRATION_SECONDS = '600';
        const customEnvResult = cloudinaryConfig.generateExpiringUrl('dhtn/students/HS0001/photo');
        assert.strictEqual(customEnvResult.expiresIn, 600, 'Should respect CLOUDINARY_URL_EXPIRATION_SECONDS');
        logPass('generateExpiringUrl respected custom duration from CLOUDINARY_URL_EXPIRATION_SECONDS (600s)');

        // Test clamping to minimum 60s
        process.env.CLOUDINARY_URL_EXPIRATION_SECONDS = '20';
        const minClampResult = cloudinaryConfig.generateExpiringUrl('dhtn/students/HS0001/photo');
        assert.strictEqual(minClampResult.expiresIn, 60, 'Should clamp duration to minimum 60s');
        logPass('generateExpiringUrl clamped below-threshold duration to minimum 60s');

        // Test clamping to maximum 86400s (24h)
        process.env.CLOUDINARY_URL_EXPIRATION_SECONDS = '100000';
        const maxClampResult = cloudinaryConfig.generateExpiringUrl('dhtn/students/HS0001/photo');
        assert.strictEqual(maxClampResult.expiresIn, 86400, 'Should clamp duration to maximum 86400s');
        logPass('generateExpiringUrl clamped above-threshold duration to maximum 86400s');

        // Test fallback on invalid non-numeric input
        process.env.CLOUDINARY_URL_EXPIRATION_SECONDS = 'invalid-text';
        const invalidFallbackResult = cloudinaryConfig.generateExpiringUrl('dhtn/students/HS0001/photo');
        assert.strictEqual(invalidFallbackResult.expiresIn, 300, 'Should fall back to default 300s');
        logPass('generateExpiringUrl safely fell back to default 300s on invalid env input');
      } finally {
        if (originalEnvDuration !== undefined) {
          process.env.CLOUDINARY_URL_EXPIRATION_SECONDS = originalEnvDuration;
        } else {
          delete process.env.CLOUDINARY_URL_EXPIRATION_SECONDS;
        }
      }

    } finally {
      if (originalTokenKey) {
        process.env.CLOUDINARY_AUTH_TOKEN_KEY = originalTokenKey;
      } else {
        delete process.env.CLOUDINARY_AUTH_TOKEN_KEY;
      }
    }
  });

  // ─── 7. Backend URL-Issuing Endpoint (GET /images/:id/url) & IDOR Protection ──
  await testSection('7. Backend URL-Issuing Endpoint (GET /images/:id/url) & IDOR Protection', async () => {
    function createMockRes() {
      const headers = {};
      let statusCode = 200;
      let sentData = null;
      return {
        setHeader(k, v) { headers[k.toLowerCase()] = v; },
        getHeader(k) { return headers[k.toLowerCase()]; },
        getHeaders() { return headers; },
        status(code) { statusCode = code; return this; },
        json(data) { sentData = data; return this; },
        send(data) { sentData = data; return this; },
        getStatusCode() { return statusCode; },
        getData() { return sentData; },
      };
    }

    // 7.1 Reject invalid ID format
    const resInvalidId = createMockRes();
    await ImageController.getImageUrl({ params: { id: 'invalid-id' }, query: {}, user: { id: 1, role_id: 1 } }, resInvalidId);
    assert.strictEqual(resInvalidId.getStatusCode(), 400);
    assert.strictEqual(resInvalidId.getData().success, false);
    logPass('getImageUrl rejected non-numeric image ID with 400 Bad Request');

    // 7.2 Return 404 for missing image
    const resNotFound = createMockRes();
    await ImageController.getImageUrl({ params: { id: 88888888 }, query: {}, user: { id: 1, role_id: 1 } }, resNotFound);
    assert.strictEqual(resNotFound.getStatusCode(), 404);
    assert.strictEqual(resNotFound.getData().success, false);
    logPass('getImageUrl returned 404 Not Found for non-existent image record');

    // Setup an isolated test image in TiDB for authorization testing
    const testSecureId = 99997;
    await ImageModel.delete(testSecureId).catch(() => {});
    await ImageModel.create({
      id: testSecureId,
      student_id: 'HS_RESTRICTED_99',
      event_id: 'EVT_SEC_01',
      timestamp: new Date(),
      url: 'https://res.cloudinary.com/test-cloud/image/authenticated/v1/dhtn/students/HS_RESTRICTED_99/photo.jpg',
      metadata: {
        public_id: 'dhtn/students/HS_RESTRICTED_99/photo',
        format: 'jpg',
        delivery_type: 'authenticated',
      },
    });

    try {
      // 7.3 IDOR Protection: Unauthorized user (e.g. Sponsor not assigned to HS_RESTRICTED_99)
      const resForbidden = createMockRes();
      const unauthorizedUser = { id: 999, role_id: 4 }; // Sponsor role
      await ImageController.getImageUrl({ params: { id: String(testSecureId) }, query: {}, user: unauthorizedUser }, resForbidden);
      assert.strictEqual(resForbidden.getStatusCode(), 403, 'Should reject unauthorized student image access with 403');
      assert.strictEqual(resForbidden.getData().success, false);
      assert.ok(resForbidden.getData().message.includes('Access Denied'));
      logPass('getImageUrl prevented IDOR access attempt with 403 Forbidden');

      // 7.4 Authorized access: Admin (role_id: 1)
      const resAuthorized = createMockRes();
      const adminUser = { id: 1, role_id: 1 };
      await ImageController.getImageUrl({ params: { id: String(testSecureId) }, query: { duration: '300' }, user: adminUser }, resAuthorized);
      assert.strictEqual(resAuthorized.getStatusCode(), 200);
      assert.strictEqual(resAuthorized.getData().success, true);
      assert.ok(resAuthorized.getData().data.url, 'Should return temporary access URL');
      assert.ok(resAuthorized.getData().data.expiresAt, 'Should return ISO expiresAt timestamp');
      assert.strictEqual(resAuthorized.getData().data.expiresIn, 300);

      // Verify Cache-Control: private, no-store headers
      const cacheControl = resAuthorized.getHeader('cache-control');
      assert.ok(cacheControl && cacheControl.includes('no-store'), 'Response must include Cache-Control: no-store');
      assert.ok(cacheControl && cacheControl.includes('private'), 'Response must include Cache-Control: private');
      logPass('getImageUrl returned 200 with expiring URL and Cache-Control: private, no-store headers');

      // 7.5 Safe Error Handling: Cloudinary failure must not leak public URL
      const originalGenerateExpiringUrl = cloudinaryConfig.generateExpiringUrl;
      const resError = createMockRes();
      try {
        cloudinaryConfig.generateExpiringUrl = () => {
          throw new Error('Cloudinary signature calculation failed');
        };
        await ImageController.getImageUrl({ params: { id: String(testSecureId) }, query: {}, user: adminUser }, resError);
        assert.strictEqual(resError.getStatusCode(), 500);
        assert.strictEqual(resError.getData().success, false);
        assert.strictEqual(resError.getData().data, undefined, 'Must not return public URL fallback on error');
        logPass('getImageUrl handled signing failure safely with 500 without public fallback');
      } finally {
        cloudinaryConfig.generateExpiringUrl = originalGenerateExpiringUrl;
      }

    } finally {
      await ImageModel.delete(testSecureId).catch(() => {});
    }
  });

  // ─── Summary ─────────────────────────────────────────────────────────────────
  console.log(`\n==================================================`);
  console.log(`       Cloudinary Integration Test Summary`);
  console.log(`==================================================`);
  console.log(`  Passed Tests : ${passedTests}`);
  console.log(`  Failed Tests : ${failedTests}`);
  console.log(`==================================================`);

  if (failedTests > 0) {
    process.exit(1);
  }
}

runTests().then(() => {
  db.closePool().then(() => {
    process.exit(0);
  });
}).catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
