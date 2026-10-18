const ImageModel = require('../models/ImageModel');
const { validateImage } = require('../validations/imageValidation');
const { sendSuccess, sendError } = require('../utils/responseHandler');
const { paginate } = require('../utils/pagination');
const cloudinaryConfig = require('../config/cloudinary');
const { uploadStream, deleteAsset, isConfigured } = cloudinaryConfig;
const db = require('../config/db');
const path = require('path');
const fs = require('fs');

/**
 * Helper function to format the image response.
 * Absolute HTTP/HTTPS URLs (including Cloudinary) are returned as-is.
 * Relative filenames are resolved to the authenticated proxy URL.
 */
function formatImageResponse(image, req) {
  if (!image || !image.url) return image;

  // Normalize metadata if stored as string in raw queries
  if (image.metadata && typeof image.metadata === 'string') {
    try {
      image.metadata = JSON.parse(image.metadata);
    } catch (e) {
      // keep original
    }
  }

  // If this is a Cloudinary asset with public_id, generate short-lived expiring URL for secure delivery
  if (image.metadata && image.metadata.public_id && isConfigured()) {
    try {
      const envListDuration = parseInt(process.env.CLOUDINARY_LIST_URL_EXPIRATION_SECONDS, 10);
      const listDuration = (!isNaN(envListDuration) && envListDuration > 0) ? envListDuration : 900;
      const expiring = cloudinaryConfig.generateExpiringUrl(image.metadata.public_id, {
        duration: listDuration,
        deliveryType: image.metadata.delivery_type || image.metadata.type || 'authenticated',
        format: image.metadata.format,
      });
      return {
        ...image,
        url: expiring.url,
        expiresAt: expiring.expiresAt,
      };
    } catch (err) {
      console.error('[formatImageResponse] Failed to generate expiring URL:', err.message);
    }
  }

  // If already an absolute HTTP/HTTPS URL (Cloudinary or remote CDN), return directly
  if (image.url.startsWith('http://') || image.url.startsWith('https://')) {
    return image;
  }

  // Defensive checks for req to support mock/test environments
  const headers = req && req.headers ? req.headers : {};
  const query = req && req.query ? req.query : {};

  const authHeader = headers['authorization'];
  let token = authHeader && authHeader.split(' ')[1];
  if (!token && query.token) {
    token = query.token;
  }
  const tokenParam = token ? `?token=${token}` : '';

  // Extract base filename from path
  let filename = image.url;
  if (filename.includes('/')) {
    filename = filename.split('/').pop();
  }

  let baseUrl = '';
  if (req && typeof req.protocol === 'string' && typeof req.get === 'function') {
    baseUrl = `${req.protocol}://${req.get('host')}`;
  } else {
    baseUrl = 'http://localhost:5001';
  }

  const proxyUrl = `${baseUrl}/images/proxy/${filename}${tokenParam}`;

  return {
    ...image,
    url: proxyUrl,
  };
}

/**
 * Sanitizes input URLs to extract clean URLs or filenames.
 */
function sanitizeInputUrl(url) {
  if (typeof url === 'string' && url.includes('/images/proxy/')) {
    const filename = url.split('/images/proxy/')[1].split('?')[0];
    return filename;
  }
  return url;
}

/**
 * Checks if a Cloudinary public_id is referenced by another image record in TiDB.
 * @param {string} publicId - Cloudinary public_id
 * @param {number} [excludeId] - Optional image record ID to exclude
 * @returns {Promise<boolean>}
 */
async function isPublicIdReferencedElsewhere(publicId, excludeId = null) {
  if (!publicId) return false;
  try {
    let sql = "SELECT COUNT(*) AS count FROM images WHERE JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.public_id')) = ?";
    const params = [publicId];
    if (excludeId !== null && excludeId !== undefined) {
      sql += " AND id != ?";
      params.push(excludeId);
    }
    const [rows] = await db.query(sql, params);
    return Boolean(rows && rows[0] && rows[0].count > 0);
  } catch (err) {
    console.error('[Reference Check Error] Failed to check public_id references:', err.message);
    // If check fails unexpectedly, conservatively assume referenced to avoid data loss
    return true;
  }
}

/**
 * Legacy helper for saving base64 to local disk if Cloudinary is unconfigured.
 */
function saveUploadedFile(filename, fileData) {
  if (!filename || !fileData) return;

  const commaIdx = fileData.indexOf(';base64,');
  if (commaIdx === -1) {
    throw new Error('Invalid base64 image data format');
  }

  const base64Content = fileData.substring(commaIdx + 8);
  const buffer = Buffer.from(base64Content, 'base64');
  const uploadDir = path.join(__dirname, '../public/upload/event');

  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }

  const destPath = path.join(uploadDir, path.basename(filename));
  fs.writeFileSync(destPath, buffer);
}

class ImageController {
  async getAllImages(req, res) {
    try {
      let images = await ImageModel.findAll(req.user);

      // Search filter (by student_id, event_id, or month)
      const searchQuery = req.query.search ? req.query.search.toLowerCase().trim() : '';
      if (searchQuery) {
        images = images.filter(img => {
          const studentIdMatch = String(img.student_id).toLowerCase().includes(searchQuery);
          const eventIdMatch = img.event_id && String(img.event_id).toLowerCase().includes(searchQuery);
          let meta = img.metadata;
          if (typeof meta === 'string') {
            try { meta = JSON.parse(meta); } catch (e) { meta = {}; }
          }
          const monthMatch = meta && meta.month && String(meta.month).toLowerCase().includes(searchQuery);
          return studentIdMatch || eventIdMatch || monthMatch;
        });
      }

      const paginated = paginate(images, req, 'images');
      paginated.images = paginated.images.map(img => formatImageResponse(img, req));
      return sendSuccess(res, paginated);
    } catch (error) {
      return sendError(res, 'Failed to fetch images', error.message);
    }
  }

  async getImageById(req, res) {
    try {
      const imageId = parseInt(req.params.id, 10);
      const rawImage = await ImageModel.findById(imageId);
      if (!rawImage) {
        return sendError(res, 'Image not found', [], 404);
      }

      const image = await ImageModel.findById(imageId, req.user);
      if (!image) {
        return sendError(res, 'Access Denied: You are not authorized to view this image', [], 403);
      }

      return sendSuccess(res, formatImageResponse(image, req));
    } catch (error) {
      return sendError(res, 'Failed to fetch image', error.message);
    }
  }

  async getImageUrl(req, res) {
    try {
      const imageId = parseInt(req.params.id, 10);
      if (isNaN(imageId) || imageId <= 0) {
        return sendError(res, 'Invalid image ID', [], 400);
      }

      const rawImage = await ImageModel.findById(imageId);
      if (!rawImage) {
        return sendError(res, 'Image not found', [], 404);
      }

      const image = await ImageModel.findById(imageId, req.user);
      if (!image) {
        return sendError(res, 'Access Denied: You are not authorized to view this image', [], 403);
      }

      let meta = image.metadata;
      if (typeof meta === 'string') {
        try { meta = JSON.parse(meta); } catch (e) { meta = {}; }
      }
      meta = meta || {};

      const publicId = meta.public_id;
      const deliveryType = meta.delivery_type || meta.type || 'authenticated';
      const format = meta.format;

      // Set mandatory security cache headers to prevent caching of sensitive temporary URLs
      res.setHeader('Cache-Control', 'private, no-store, max-age=0, must-revalidate');
      res.setHeader('Pragma', 'no-cache');

      // If not a Cloudinary asset or Cloudinary not configured, return fallback proxy response
      if (!publicId || !isConfigured()) {
        const formatted = formatImageResponse(image, req);
        return sendSuccess(res, {
          id: image.id,
          url: formatted.url,
          expiresAt: null,
          expiresIn: null,
        }, 'Image access URL retrieved successfully');
      }

      const envUrlDuration = parseInt(process.env.CLOUDINARY_URL_EXPIRATION_SECONDS, 10);
      const defaultDuration = (!isNaN(envUrlDuration) && envUrlDuration > 0) ? envUrlDuration : 300;
      const requestedDuration = req.query.duration ? parseInt(req.query.duration, 10) : defaultDuration;
      const duration = Math.min(Math.max((!isNaN(requestedDuration) && requestedDuration > 0) ? requestedDuration : defaultDuration, 60), 86400);

      const result = cloudinaryConfig.generateExpiringUrl(publicId, {
        duration,
        deliveryType,
        format,
      });

      return sendSuccess(res, {
        id: image.id,
        url: result.url,
        expiresAt: result.expiresAt,
        expiresIn: result.expiresIn,
      }, 'Image access URL generated successfully');
    } catch (error) {
      console.error('[getImageUrl Error] Failed to generate secure access URL:', error.message);
      return sendError(res, 'Failed to generate secure image access URL', error.message, 500);
    }
  }

  async getImagesByStudent(req, res) {
    try {
      const studentId = req.params.studentId;
      if (req.user && !(await ImageModel.isStudentAuthorized(studentId, req.user))) {
        return sendError(res, "Access Denied: You are not authorized to view this student's images", [], 403);
      }

      const images = await ImageModel.findByStudentId(studentId, req.user);
      const formatted = images.map(img => formatImageResponse(img, req));
      return sendSuccess(res, formatted);
    } catch (error) {
      return sendError(res, 'Failed to fetch student images', error.message);
    }
  }

  async getImagesByRange(req, res) {
    try {
      const { start, end } = req.query;
      if (!start || !end) {
        return sendError(res, 'Start and end dates are required', [], 400);
      }
      const images = await ImageModel.findByTimeRange(start, end, req.user);
      const formatted = images.map(img => formatImageResponse(img, req));
      return sendSuccess(res, formatted);
    } catch (error) {
      return sendError(res, 'Failed to fetch images in range', error.message);
    }
  }

  async createImage(req, res) {
    let uploadedAsset = null;
    try {
      // Parse metadata object
      let metadataObj = {};
      if (req.body && req.body.metadata) {
        if (typeof req.body.metadata === 'string') {
          try {
            metadataObj = JSON.parse(req.body.metadata);
          } catch (e) {
            metadataObj = {};
          }
        } else if (typeof req.body.metadata === 'object') {
          metadataObj = { ...req.body.metadata };
        }
      }
      if (req.body && req.body.month && !metadataObj.month) {
        metadataObj.month = req.body.month;
      }

      // 1. Handle in-memory file upload via Cloudinary
      if (req.file && req.file.buffer) {
        const studentId = req.body.student_id || 'unassigned';
        const folder = `dhtn/students/${studentId}`;

        uploadedAsset = await uploadStream(req.file.buffer, { folder, type: 'authenticated' });
        req.body.url = uploadedAsset.secure_url;
        metadataObj = {
          ...metadataObj,
          public_id: uploadedAsset.public_id,
          delivery_type: uploadedAsset.type || 'authenticated',
          width: uploadedAsset.width,
          height: uploadedAsset.height,
          format: uploadedAsset.format,
          bytes: uploadedAsset.bytes,
          resource_type: uploadedAsset.resource_type,
          secure_url: uploadedAsset.secure_url,
        };
      } else if (req.body && req.body.fileData) {
        // Fallback for legacy base64 fileData
        const fileData = req.body.fileData;
        delete req.body.fileData;
        const commaIdx = fileData.indexOf(';base64,');
        if (commaIdx !== -1) {
          const buffer = Buffer.from(fileData.substring(commaIdx + 8), 'base64');
          if (isConfigured()) {
            const studentId = req.body.student_id || 'unassigned';
            uploadedAsset = await uploadStream(buffer, { folder: `dhtn/students/${studentId}`, type: 'authenticated' });
            req.body.url = uploadedAsset.secure_url;
            metadataObj = {
              ...metadataObj,
              public_id: uploadedAsset.public_id,
              delivery_type: uploadedAsset.type || 'authenticated',
              width: uploadedAsset.width,
              height: uploadedAsset.height,
              format: uploadedAsset.format,
              bytes: uploadedAsset.bytes,
              resource_type: uploadedAsset.resource_type,
              secure_url: uploadedAsset.secure_url,
            };
          } else {
            saveUploadedFile(req.body.url, fileData);
          }
        }
      }

      if (req.body && req.body.url) {
        req.body.url = sanitizeInputUrl(req.body.url);
      }

      // If timestamp is missing, default to now for validation
      if (!req.body.timestamp) {
        req.body.timestamp = new Date().toISOString();
      }

      const validation = validateImage(req.body);
      if (!validation.isValid) {
        // Rollback uploaded Cloudinary asset if validation fails
        if (uploadedAsset && uploadedAsset.public_id) {
          try {
            await deleteAsset(uploadedAsset.public_id);
          } catch (cleanupErr) {
            console.error('[Rollback Cleanup Error]', cleanupErr.message);
          }
        }
        return sendError(res, 'Validation failed', validation.errors, 400);
      }

      // 2. Persist record to TiDB with rollback on DB failure
      let newImage;
      try {
        const newId = await ImageModel.generateNextId();
        newImage = await ImageModel.create({
          id: newId,
          student_id: req.body.student_id,
          event_id: req.body.event_id || null,
          url: req.body.url,
          timestamp: req.body.timestamp || new Date(),
          metadata: metadataObj,
        });
      } catch (dbError) {
        // Automatic rollback of Cloudinary asset if database write fails
        if (uploadedAsset && uploadedAsset.public_id) {
          try {
            await deleteAsset(uploadedAsset.public_id);
            console.log(`[Cloudinary Rollback] Successfully deleted orphaned asset: ${uploadedAsset.public_id}`);
          } catch (cleanupErr) {
            console.error(`[Cloudinary Rollback Error] Failed to delete ${uploadedAsset.public_id}:`, cleanupErr.message);
          }
        }
        throw dbError; // surface original error without masking
      }

      return sendSuccess(res, formatImageResponse(newImage, req), 'Image created successfully', 201);
    } catch (error) {
      return sendError(res, 'Failed to create image', error.message);
    }
  }

  async updateImage(req, res) {
    let newlyUploadedAsset = null;
    try {
      const imageId = parseInt(req.params.id, 10);
      const existingImage = await ImageModel.findById(imageId);
      if (!existingImage) {
        return sendError(res, 'Image not found', [], 404);
      }

      let existingMeta = {};
      if (existingImage.metadata) {
        if (typeof existingImage.metadata === 'string') {
          try { existingMeta = JSON.parse(existingImage.metadata); } catch (e) { existingMeta = {}; }
        } else if (typeof existingImage.metadata === 'object') {
          existingMeta = { ...existingImage.metadata };
        }
      }

      let incomingMeta = {};
      if (req.body && req.body.metadata) {
        if (typeof req.body.metadata === 'string') {
          try { incomingMeta = JSON.parse(req.body.metadata); } catch (e) { incomingMeta = {}; }
        } else if (typeof req.body.metadata === 'object') {
          incomingMeta = { ...req.body.metadata };
        }
      }
      if (req.body && req.body.month) {
        incomingMeta.month = req.body.month;
      }

      // Handle replacement file upload
      if (req.file && req.file.buffer) {
        const studentId = req.body.student_id || existingImage.student_id || 'unassigned';
        const folder = `dhtn/students/${studentId}`;

        newlyUploadedAsset = await uploadStream(req.file.buffer, { folder, type: 'authenticated' });
        req.body.url = newlyUploadedAsset.secure_url;
        incomingMeta = {
          ...incomingMeta,
          public_id: newlyUploadedAsset.public_id,
          delivery_type: newlyUploadedAsset.type || 'authenticated',
          width: newlyUploadedAsset.width,
          height: newlyUploadedAsset.height,
          format: newlyUploadedAsset.format,
          bytes: newlyUploadedAsset.bytes,
          resource_type: newlyUploadedAsset.resource_type,
          secure_url: newlyUploadedAsset.secure_url,
        };
      } else if (req.body && req.body.fileData) {
        const fileData = req.body.fileData;
        delete req.body.fileData;
        const commaIdx = fileData.indexOf(';base64,');
        if (commaIdx !== -1) {
          const buffer = Buffer.from(fileData.substring(commaIdx + 8), 'base64');
          if (isConfigured()) {
            const studentId = req.body.student_id || existingImage.student_id || 'unassigned';
            newlyUploadedAsset = await uploadStream(buffer, { folder: `dhtn/students/${studentId}`, type: 'authenticated' });
            req.body.url = newlyUploadedAsset.secure_url;
            incomingMeta = {
              ...incomingMeta,
              public_id: newlyUploadedAsset.public_id,
              delivery_type: newlyUploadedAsset.type || 'authenticated',
              width: newlyUploadedAsset.width,
              height: newlyUploadedAsset.height,
              format: newlyUploadedAsset.format,
              bytes: newlyUploadedAsset.bytes,
              resource_type: newlyUploadedAsset.resource_type,
              secure_url: newlyUploadedAsset.secure_url,
            };
          } else {
            saveUploadedFile(req.body.url, fileData);
          }
        }
      }

      if (req.body && req.body.url) {
        req.body.url = sanitizeInputUrl(req.body.url);
      }

      const validation = validateImage(req.body, true);
      if (!validation.isValid) {
        if (newlyUploadedAsset && newlyUploadedAsset.public_id) {
          try { await deleteAsset(newlyUploadedAsset.public_id); } catch (e) {}
        }
        return sendError(res, 'Validation failed', validation.errors, 400);
      }

      const updateData = {
        ...req.body,
        metadata: {
          ...existingMeta,
          ...incomingMeta,
        },
      };

      let updatedImage;
      try {
        updatedImage = await ImageModel.update(imageId, updateData);
      } catch (dbError) {
        // Rollback newly uploaded asset if DB update fails
        if (newlyUploadedAsset && newlyUploadedAsset.public_id) {
          try {
            await deleteAsset(newlyUploadedAsset.public_id);
            console.log(`[Cloudinary Rollback] Cleaned up asset ${newlyUploadedAsset.public_id} after DB update failure`);
          } catch (cleanupErr) {
            console.error(`[Cloudinary Rollback Error]`, cleanupErr.message);
          }
        }
        throw dbError;
      }

      // Safe replacement: if new asset uploaded and DB update succeeded, delete old asset only if unreferenced elsewhere
      if (newlyUploadedAsset && existingMeta.public_id && existingMeta.public_id !== newlyUploadedAsset.public_id) {
        const isReferenced = await isPublicIdReferencedElsewhere(existingMeta.public_id, imageId);
        if (!isReferenced) {
          try {
            await deleteAsset(existingMeta.public_id);
            console.log(`[Cloudinary Replacement] Old asset ${existingMeta.public_id} destroyed safely`);
          } catch (delErr) {
            console.error(`[Cloudinary Replacement Error] Failed to destroy old asset ${existingMeta.public_id}:`, delErr.message);
          }
        }
      }

      return sendSuccess(res, formatImageResponse(updatedImage, req), 'Image updated successfully');
    } catch (error) {
      return sendError(res, 'Failed to update image', error.message);
    }
  }

  async deleteImage(req, res) {
    try {
      const imageId = parseInt(req.params.id, 10);
      const existingImage = await ImageModel.findById(imageId);
      if (!existingImage) {
        return sendError(res, 'Image not found', [], 404);
      }

      let existingMeta = {};
      if (existingImage.metadata) {
        if (typeof existingImage.metadata === 'string') {
          try { existingMeta = JSON.parse(existingImage.metadata); } catch (e) { existingMeta = {}; }
        } else if (typeof existingImage.metadata === 'object') {
          existingMeta = { ...existingImage.metadata };
        }
      }

      const success = await ImageModel.delete(imageId);
      if (!success) return sendError(res, 'Image not found', [], 404);

      // Safe deletion: delete Cloudinary asset if not referenced by another record
      if (existingMeta.public_id) {
        const isReferenced = await isPublicIdReferencedElsewhere(existingMeta.public_id, imageId);
        if (!isReferenced) {
          try {
            await deleteAsset(existingMeta.public_id, {
              type: existingMeta.delivery_type || existingMeta.type || 'authenticated',
            });
            console.log(`[Cloudinary Deletion] Asset ${existingMeta.public_id} deleted safely`);
          } catch (delErr) {
            console.error(`[Cloudinary Deletion Error] Failed to delete asset ${existingMeta.public_id}:`, delErr.message);
          }
        }
      }

      return sendSuccess(res, null, 'Image deleted successfully');
    } catch (error) {
      return sendError(res, 'Failed to delete image', error.message);
    }
  }

  async proxyImage(req, res) {
    try {
      const filename = path.basename(req.params.filename);
      const filePath = path.join(__dirname, '../public/upload/event', filename);
      const fallbackPath = path.join(__dirname, '../public/placeholder.jpg');

      const image = await ImageModel.findOne({ url: filename }, req.user);
      if (!image) {
        const rawImage = await ImageModel.findOne({ url: filename });
        if (rawImage) {
          return res.status(403).send('Forbidden: Access Denied');
        }
      }

      const options = {
        maxAge: '1d',
        immutable: true,
        lastModified: true,
        etag: true,
      };

      if (fs.existsSync(filePath)) {
        return res.sendFile(filePath, options);
      } else {
        if (fs.existsSync(fallbackPath)) {
          return res.sendFile(fallbackPath, { maxAge: '1h', lastModified: true, etag: true });
        } else {
          return res.status(404).send('Image not found');
        }
      }
    } catch (error) {
      console.error('Error in image proxy:', error);
      return res.status(500).send('Internal server error');
    }
  }
}

module.exports = new ImageController();
