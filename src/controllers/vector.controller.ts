import { Request, Response } from "express";
import { RagService } from "../services/rag.service.js";

const ragService = new RagService();

export class VectorController {
  async search(req: Request, res: Response) {
    try {
      const { query, topK = 5 } = req.body;

      if (!query?.trim()) {
        return res.status(400).json({
          success: false,
          message: "Query is required",
        });
      }

      const results = await ragService.search(query, topK);

      return res.json({
        success: true,
        results,
      });
    } catch (err) {
      console.error(err);

      return res.status(500).json({
        success: false,
        message: "Search failed",
      });
    }
  }
}