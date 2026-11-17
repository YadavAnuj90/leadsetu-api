import { BadGatewayException, Logger } from '@nestjs/common';
import axios from 'axios';
import { createHash } from 'crypto';

const logger = new Logger('CloudinaryStorage');

export interface CloudinaryUploadOptions {
  folder: string;
  publicId?: string;
  resourceType?: 'image' | 'auto' | 'raw';
}

export function isCloudinaryConfigured(): boolean {
  return Boolean(
    process.env.CLOUDINARY_CLOUD_NAME?.trim() &&
      process.env.CLOUDINARY_API_KEY?.trim() &&
      process.env.CLOUDINARY_API_SECRET?.trim(),
  );
}

/**
 * Uploads a base64 `data:...` image or file payload to Cloudinary using signed REST upload
 * and returns the HTTPS `secure_url`. If already an HTTP(S) URL or empty, returns unchanged.
 */
export async function uploadToCloudinary(
  dataUrlOrUrl: string,
  options: CloudinaryUploadOptions,
): Promise<string> {
  const value = String(dataUrlOrUrl || '').trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  if (!value.startsWith('data:')) return value;

  const cloudName = process.env.CLOUDINARY_CLOUD_NAME?.trim();
  const apiKey = process.env.CLOUDINARY_API_KEY?.trim();
  const apiSecret = process.env.CLOUDINARY_API_SECRET?.trim();
  if (!cloudName || !apiKey || !apiSecret) {
    logger.warn('Cloudinary credentials missing in environment; storing inline data URL.');
    return value;
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const resourceType = options.resourceType || 'image';

  // Build sorted params to sign per Cloudinary signed upload specification
  const signParams: Record<string, string | number> = {
    folder: options.folder,
    timestamp,
  };
  if (options.publicId) {
    signParams.public_id = options.publicId;
    signParams.overwrite = 'true';
  }

  const paramString = Object.keys(signParams)
    .sort()
    .map((key) => `${key}=${signParams[key]}`)
    .join('&');
  const signature = createHash('sha1')
    .update(`${paramString}${apiSecret}`)
    .digest('hex');

  const body = new URLSearchParams();
  body.set('file', value);
  body.set('api_key', apiKey);
  body.set('timestamp', String(timestamp));
  body.set('signature', signature);
  body.set('folder', options.folder);
  if (options.publicId) {
    body.set('public_id', options.publicId);
    body.set('overwrite', 'true');
  }

  const endpoint = `https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudName)}/${resourceType}/upload`;
  try {
    const response = await axios.post<{ secure_url?: string; url?: string }>(
      endpoint,
      body.toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 20000,
        maxBodyLength: Infinity,
      },
    );
    const secureUrl = response.data?.secure_url || response.data?.url;
    if (secureUrl) {
      return secureUrl;
    }
    throw new Error('Cloudinary did not return a secure_url.');
  } catch (err) {
    const msg =
      axios.isAxiosError(err) && err.response?.data
        ? JSON.stringify(err.response.data)
        : err instanceof Error
          ? err.message
          : String(err);
    logger.error(`Cloudinary upload failed (${options.folder}): ${msg}`);
    throw new BadGatewayException(`Image upload to Cloudinary failed: ${msg}`);
  }
}
