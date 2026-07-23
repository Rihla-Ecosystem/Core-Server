/**
 * vectorSearch.route.ts
 *
 * POST /api/vector/search
 *
 * Body: { "query": string, "topK"?: number }
 *
 * searchChunks() now embeds the query internally via the LangChain vector
 * store, so this route no longer calls the embedding service directly.
 * No LLM generation — pure vector search, returns [{ text, score, metadata }].
 */

import { Router, Request, Response } from "express";
import { searchChunks } from "../services/Qdrant.service.js";

const router = Router();

router.post("/search", async (req: Request, res: Response) => {
  const { query, topK } = req.body as { query?: string; topK?: number };

  if (!query || typeof query !== "string" || query.trim().length === 0) {
    return res.status(400).json({
      success: false,
      message: "Field 'query' is required and must be a non-empty string.",
    });
  }

  const limit =
    typeof topK === "number" && topK > 0 && topK <= 50 ? topK : 5;

  try {
    const results = await searchChunks(query.trim(), limit);

    return res.status(200).json({
      success: true,
      results,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: `Search failed: ${(err as Error).message}`,
    });
  }
});

export default router;