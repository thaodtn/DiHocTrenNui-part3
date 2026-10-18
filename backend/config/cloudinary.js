const cloudinary = require('cloudinary').v2;
const streamifier = require('streamifier');

// Configure Cloudinary from server-only environment variables
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

/**
 * Check if Cloudinary credentials are fully configured.
 * @returns {boolean}
 */
function isConfigured() {
  const { cloud_name, api_key, api_secret } = cloudinary.config();
  return Boolean(cloud_name && api_key && api_secret);
}

/**
 * Stream a memory Buffer directly to Cloudinary.
 * @param {Buffer} buffer - File buffer in memory
 * @param {Object} options - Cloudinary upload options (folder, tags, etc.)
 * @returns {Promise<Object>} Resolves with Cloudinary upload result
 */
function uploadStream(buffer, options = {}) {
  return new Promise((resolve, reject) => {
    if (!isConfigured()) {
      return reject(new Error('Cloudinary is not configured. Missing required environment variables.'));
    }

    if (!buffer || !Buffer.isBuffer(buffer)) {
      return reject(new Error('Invalid buffer provided for upload.'));
    }

    const defaultOptions = {
      folder: 'dhtn/images',
      resource_type: 'image',
      type: 'authenticated',
      ...options,
    };

    const stream = cloudinary.uploader.upload_stream(defaultOptions, (error, result) => {
      if (error) {
        return reject(new Error(`Cloudinary upload failed: ${error.message || 'Unknown error'}`));
      }
      resolve(result);
    });

    streamifier.createReadStream(buffer).pipe(stream);
  });
}

/**
 * Generate a short-lived, expiring access URL for a Cloudinary asset.
 * If CLOUDINARY_AUTH_TOKEN_KEY is set, uses Cloudinary token-based authentication (__cld_token__)
 * which enforces expiration at the CDN edge.
 * Otherwise, falls back to Cloudinary's signed private download URL with expires_at.
 *
 * @param {string} publicId - Cloudinary public_id
 * @param {Object} [options]
 * @param {number} [options.duration=300] - URL validity duration in seconds (default 5 minutes)
 * @param {string} [options.format] - Optional image format (e.g. 'jpg', 'png', 'webp')
 * @param {string} [options.deliveryType='authenticated'] - Asset delivery type ('authenticated' or 'upload')
 * @param {string} [options.resourceType='image'] - Asset resource type
 * @returns {{ url: string, expiresAt: string, expiresIn: number, deliveryType: string }}
 */
function generateExpiringUrl(publicId, options = {}) {
  if (!isConfigured()) {
    throw new Error('Cloudinary is not configured. Missing required environment variables.');
  }

  if (!publicId || typeof publicId !== 'string') {
    throw new Error('Invalid publicId provided for generating expiring URL.');
  }

  const envDefault = parseInt(process.env.CLOUDINARY_URL_EXPIRATION_SECONDS, 10);
  const defaultDuration = (!isNaN(envDefault) && envDefault > 0) ? envDefault : 300;
  const rawDuration = options.duration !== undefined ? parseInt(options.duration, 10) : defaultDuration;
  const parsedDuration = (!isNaN(rawDuration) && rawDuration > 0) ? rawDuration : defaultDuration;
  // Clamp duration between 60s (1 min) and 86400s (24 hours)
  const duration = Math.min(Math.max(parsedDuration, 60), 86400);

  const deliveryType = options.deliveryType || 'authenticated';
  const resourceType = options.resourceType || 'image';
  const format = options.format || undefined;
  const expiresAtMs = Date.now() + duration * 1000;
  const expiresAtIso = new Date(expiresAtMs).toISOString();
  const expiresAtEpoch = Math.floor(expiresAtMs / 1000);

  const authTokenKey = process.env.CLOUDINARY_AUTH_TOKEN_KEY;

  let url;
  if (authTokenKey) {
    // CDN Edge Token-based delivery (__cld_token__)
    const tokenAcl = `/${resourceType}/${deliveryType}/*`;
    url = cloudinary.url(publicId, {
      type: deliveryType,
      resource_type: resourceType,
      format,
      secure: true,
      sign_url: true,
      auth_token: {
        key: authTokenKey,
        acl: tokenAcl,
        duration,
      },
    });
  } else {
    // Server-signed expiring download URL via Cloudinary API
    url = cloudinary.utils.private_download_url(publicId, format || 'jpg', {
      resource_type: resourceType,
      type: deliveryType,
      expires_at: expiresAtEpoch,
      attachment: false,
    });
  }

  return {
    url,
    expiresAt: expiresAtIso,
    expiresIn: duration,
    deliveryType,
  };
}

/**
 * Delete an asset from Cloudinary by its public_id.
 * @param {string} publicId - Cloudinary public_id
 * @param {Object} [options] - Additional destroy options
 * @returns {Promise<Object>} Cloudinary destroy result
 */
async function deleteAsset(publicId, options = {}) {
  if (!isConfigured()) {
    console.warn('[Cloudinary] Cannot delete asset: Cloudinary credentials not configured.');
    return { result: 'not_configured' };
  }

  if (!publicId || typeof publicId !== 'string') {
    return { result: 'invalid_public_id' };
  }

  try {
    const destroyOptions = {
      type: options.type || 'authenticated',
      ...options,
    };
    const result = await cloudinary.uploader.destroy(publicId, destroyOptions);
    // If not found as authenticated, try upload type for backward-compatibility
    if (result && result.result === 'not_found' && destroyOptions.type === 'authenticated') {
      return await cloudinary.uploader.destroy(publicId, { ...options, type: 'upload' });
    }
    return result;
  } catch (error) {
    console.error(`[Cloudinary] Failed to delete asset ${publicId}:`, error.message);
    throw error;
  }
}

module.exports = {
  cloudinary,
  uploadStream,
  deleteAsset,
  generateExpiringUrl,
  isConfigured,
};