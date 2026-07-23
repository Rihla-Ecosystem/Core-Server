/**
 * vectorUpload.route.ts
 *
 * POST /api/vector/upload
 *
 * Accepts one or more JSON files (multipart/form-data, field name "files"),
 * and for each file: parses it, extracts meaningful text, chunks it into
 * LangChain Documents, and upserts them into Qdrant via QdrantVectorStore
 * (embedding happens internally through the shared Embeddings instance).
 *
 * This route only orchestrates the services — no business logic lives here.
 *
 * FIX: the previous version returned a response immediately after
 * ensureCollection() succeeded, before the per-file loop ever ran — so no
 * file was ever actually processed. That early return is removed here.
 */

import { Router, Request, Response } from "express";
import multer from "multer";
import { parseJsonToText } from "../services/Jsonparser.service.js";
import { chunkTextToDocuments } from "../services/Textchunker.service.js";
import { ensureCollection, upsertDocuments } from "../services/Qdrant.service.js";

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB per file
  fileFilter: (_req, file, cb) => {
    const isJson =
      file.mimetype === "application/json" ||
      file.originalname.toLowerCase().endsWith(".json");
    if (!isJson) {
      cb(new Error(`Rejected non-JSON file: ${file.originalname}`));
      return;
    }
    cb(null, true);
  },
});

interface FileUploadResult {
  filename: string;
  status: "success" | "error";
  chunksStored?: number;
  error?: string;
}

router.post(
  "/",
  upload.array("files"),
  async (req: Request, res: Response) => {
    const files = req.files as Express.Multer.File[] | undefined;

    if (!files || files.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No files uploaded. Attach one or more JSON files under 'files'.",
      });
    }

    try {
      await ensureCollection();
    } catch (err) {
      return res.status(500).json({
        success: false,
        message: `Failed to prepare Qdrant collection: ${(err as Error).message}`,
      });
    }

    const results: FileUploadResult[] = [];

    for (const file of files) {
      const filename = file.originalname;

      try {
        const rawText = file.buffer.toString("utf-8");
        const mergedText = parseJsonToText(rawText);

        if (!mergedText) {
          results.push({
            filename,
            status: "error",
            error: "No meaningful text found in file.",
          });
          continue;
        }

        const uploadDate = new Date().toISOString();

        const documents = await chunkTextToDocuments(
          mergedText,
          { filename, uploadDate },
          { chunkSize: 1000, overlap: 200 }
        );

        await upsertDocuments(documents);

        results.push({
          filename,
          status: "success",
          chunksStored: documents.length,
        });
      } catch (err) {
        results.push({
          filename,
          status: "error",
          error: (err as Error).message,
        });
      }
    }

    const allFailed = results.every((r) => r.status === "error");

    return res.status(allFailed ? 500 : 200).json({
      success: !allFailed,
      results,
    });
  }
);

export default router;