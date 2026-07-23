/**
 * textChunker.service.ts
 *
 * Splits merged text into overlapping chunks using LangChain's
 * RecursiveCharacterTextSplitter, and wraps each chunk into a
 * LangChain Document with metadata attached — ready to hand straight
 * to a LangChain vector store.
 */

import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { Document } from "@langchain/core/documents";

export interface ChunkOptions {
  chunkSize?: number;
  overlap?: number;
}

const DEFAULT_CHUNK_SIZE = 1000;
const DEFAULT_OVERLAP = 200;

export async function chunkTextToDocuments(
  text: string,
  metadata: Record<string, unknown>,
  options: ChunkOptions = {}
): Promise<Document[]> {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const chunkOverlap = options.overlap ?? DEFAULT_OVERLAP;

  const cleaned = text.trim();
  if (cleaned.length === 0) return [];

  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize,
    chunkOverlap,
  });

  const chunks = await splitter.splitText(cleaned);

  return chunks.map(
    (chunk, index) =>
      new Document({
        pageContent: chunk,
        metadata: { ...metadata, chunkIndex: index },
      })
  );
}