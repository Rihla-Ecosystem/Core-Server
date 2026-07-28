import multer from 'multer';

export const uploadAvatar = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  },
});

const AUDIO_MIMES = new Set(['audio/wav', 'audio/mpeg', 'audio/ogg', 'audio/webm', 'audio/mp4', 'audio/x-wav']);
export const uploadAudio = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (AUDIO_MIMES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only audio files (WAV, MP3, OGG, WEBM) are allowed'));
    }
  },
});

export const uploadIdentificationImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'image/jpeg' || file.mimetype === 'image/png') {
      cb(null, true);
    } else {
      cb(new Error('Only JPEG and PNG images are allowed'));
    }
  },
});
