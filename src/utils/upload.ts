import multer from 'multer';

const IMAGE_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'image/gif',
  'image/bmp',
  'image/avif',
  'image/tiff',
]);

function rejectImage(msg: string) {
  const err = new Error(msg) as Error & { statusCode?: number };
  err.statusCode = 400;
  return err;
}

export const uploadAvatar = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(rejectImage('Only image files are allowed'));
    }
  },
});

/** Matches the formats the billed Voice service can parse and duration-check. */
const AUDIO_MIMES = new Set([
  'audio/wav',
  'audio/x-wav',
  'audio/mpeg',
  'audio/aiff',
  'audio/x-aiff',
  'audio/aac',
  'audio/ogg',
  'audio/flac',
  'audio/x-flac',
]);
export const uploadAudio = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (AUDIO_MIMES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(rejectImage('Only WAV, MP3, AIFF, AAC, OGG, and FLAC audio files are allowed'));
    }
  },
});

export const IDENTIFICATION_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

export class UnsupportedIdentificationMimeError extends Error {
  constructor() {
    super('Only JPEG and PNG image files are allowed');
    this.name = 'UnsupportedIdentificationMimeError';
  }
}

export const uploadIdentificationImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: IDENTIFICATION_IMAGE_MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    if (IMAGE_MIMES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(rejectImage('Only JPEG, PNG, WebP, HEIC, GIF, BMP, AVIF and TIFF images are allowed'));
    }
  },
});
