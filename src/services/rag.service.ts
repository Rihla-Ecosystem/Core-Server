import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import { QdrantVectorStore } from "@langchain/qdrant";

export class RagService {
  private vectorStore?: QdrantVectorStore;

  async initialize() {
    if (this.vectorStore) return;

    const embeddings = new GoogleGenerativeAIEmbeddings({
      apiKey: process.env.GEMINI_API_KEY!,
      model: "gemini-embedding-001",
    });

    this.vectorStore =
      await QdrantVectorStore.fromExistingCollection(
        embeddings,
        {
          url: process.env.QDRANT_URL!,
          collectionName: process.env.QDRANT_COLLECTION!,
        }
      );
  }

  async search(query: string, topK = 5) {
    await this.initialize();

    const retriever = this.vectorStore!.asRetriever(topK);

    const docs = await retriever.invoke(query);

    return docs.map((doc) => ({
      text: doc.pageContent,
      metadata: doc.metadata,
    }));
  }
}