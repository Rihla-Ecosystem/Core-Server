import { QdrantClient } from "@qdrant/js-client-rest";
import { QdrantVectorStore } from "@langchain/qdrant";
import { Document } from "@langchain/core/documents";
import { embeddings } from "./Embedding.service.js";

export const COLLECTION_NAME =
  process.env.QDRANT_COLLECTION ?? "documents";

const VECTOR_SIZE = 3072; // إذا كنت تستخدم gemini-embedding-001

let client: QdrantClient | null = null;
let store: QdrantVectorStore | null = null;

function getClient() {
  if (client) return client;

  if (!process.env.QDRANT_URL) {
    throw new Error("QDRANT_URL is missing");
  }

  client = new QdrantClient({
    url: process.env.QDRANT_URL,
    apiKey: process.env.QDRANT_API_KEY,
  });

  return client;
}

export async function ensureCollection() {
  const qdrant = getClient();

  const exists = await qdrant.collectionExists(COLLECTION_NAME);

  if (!exists.exists) {
    await qdrant.createCollection(COLLECTION_NAME, {
      vectors: {
        size: VECTOR_SIZE,
        distance: "Cosine",
      },
    });

    console.log(`Collection "${COLLECTION_NAME}" created`);
  }
}

async function getStore() {
  if (store) return store;

  await ensureCollection();

  store = new QdrantVectorStore(embeddings, {
    client: getClient(),
    collectionName: COLLECTION_NAME,
  });

  return store;
}

export async function upsertDocuments(documents: Document[]) {
  if (!documents.length) return;

  const vectorStore = await getStore();

  await vectorStore.addDocuments(documents);
}

export async function searchChunks(
  query: string,
  topK = 5
) {
  const vectorStore = await getStore();

  const results = await vectorStore.similaritySearchWithScore(
    query,
    topK
  );

  return results.map(([doc, score]) => ({
    text: doc.pageContent,
    score,
    metadata: doc.metadata,
  }));
}