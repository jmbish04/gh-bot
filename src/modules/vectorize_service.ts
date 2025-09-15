/// <reference types="@cloudflare/workers-types" />

/**
 * Vectorization Service for Cloudflare Vectorize Integration
 *
 * This module provides semantic similarity search capabilities for documentation content
 * and chunked LLM text processing using Cloudflare Vectorize.
 */

export interface VectorizeConfig {
  indexName: string;
  dimensions: number;
  metric: 'cosine' | 'euclidean' | 'dot-product';
}

export interface ContentChunk {
  id: string;
  content: string;
  metadata: {
    source: string;
    category: string;
    title?: string;
    url?: string;
    chunkIndex: number;
    totalChunks: number;
    timestamp: string;
  };
}

export interface VectorizedChunk extends ContentChunk {
  vector: number[];
  embedding: Float32Array;
}

export interface SimilaritySearchResult {
  chunk: ContentChunk;
  score: number;
  distance: number;
}

export interface SimilaritySearchOptions {
  topK?: number;
  threshold?: number;
  filter?: Record<string, any>;
  includeMetadata?: boolean;
}

export class VectorizeService {
  private env: any;
  private config: VectorizeConfig;
  private vectorizeIndex: VectorizeIndex;

  constructor(env: any, config: VectorizeConfig = {
    indexName: 'llms-full-docs',
    dimensions: 1536, // OpenAI ada-002 dimensions
    metric: 'cosine'
  }) {
    this.env = env;
    this.config = config;
    this.vectorizeIndex = env.VECTORIZE_INDEX;
  }

  /**
   * Initialize the Vectorize index if it doesn't exist
   */
  async initializeIndex(): Promise<void> {
    try {
      // Check if index exists by attempting to query it
      await this.vectorizeIndex.query(new Array(this.config.dimensions).fill(0), { topK: 1 });
    } catch (error: unknown) {
      console.log('Index may not exist or needs initialization:', error instanceof Error ? error.message : String(error));
      // Index will be created automatically on first insert
    }
  }

  /**
   * Generate embeddings using Cloudflare AI
   */
  async generateEmbedding(text: string): Promise<number[]> {
    try {
      const response = await this.env.AI.run('@cf/baai/bge-base-en-v1.5', {
        text: [text]
      });

      if (response && response.data && response.data[0]) {
        return response.data[0];
      }
      throw new Error('Invalid embedding response');
    } catch (error: unknown) {
      console.error('Error generating embedding:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to generate embedding: ${errorMessage}`);
    }
  }

  /**
   * Chunk large text content into smaller, manageable pieces
   */
  chunkContent(content: string, source: string, category: string, metadata: any = {}): ContentChunk[] {
    const chunks: ContentChunk[] = [];
    const maxChunkSize = 1000; // Characters per chunk
    const overlap = 200; // Character overlap between chunks

    // Split content into sentences first for better chunking
    const sentences = content.split(/[.!?]+/).filter(s => s.trim().length > 0);

    let currentChunk = '';
    let chunkIndex = 0;

    for (const sentence of sentences) {
      const trimmedSentence = sentence.trim();
      if (!trimmedSentence) continue;

      // Check if adding this sentence would exceed chunk size
      if (currentChunk.length + trimmedSentence.length + 1 > maxChunkSize && currentChunk.length > 0) {
        // Create chunk from current content
        const chunkId = `${source}_chunk_${chunkIndex}`;
        chunks.push({
          id: chunkId,
          content: currentChunk.trim(),
          metadata: {
            source,
            category,
            chunkIndex,
            totalChunks: 0, // Will be updated later
            timestamp: new Date().toISOString(),
            ...metadata
          }
        });

        // Start new chunk with overlap
        const words = currentChunk.split(' ');
        const overlapWords = words.slice(-Math.floor(overlap / 5)); // Approximate word overlap
        currentChunk = overlapWords.join(' ') + ' ' + trimmedSentence;
        chunkIndex++;
      } else {
        currentChunk += (currentChunk ? ' ' : '') + trimmedSentence;
      }
    }

    // Add final chunk
    if (currentChunk.trim()) {
      const chunkId = `${source}_chunk_${chunkIndex}`;
      chunks.push({
        id: chunkId,
        content: currentChunk.trim(),
        metadata: {
          source,
          category,
          chunkIndex,
          totalChunks: 0,
          timestamp: new Date().toISOString(),
          ...metadata
        }
      });
    }

    // Update totalChunks for all chunks
    chunks.forEach(chunk => {
      chunk.metadata.totalChunks = chunks.length;
    });

    return chunks;
  }

  /**
   * Vectorize and store content chunks
   */
  async vectorizeAndStore(chunks: ContentChunk[]): Promise<VectorizedChunk[]> {
    const vectorizedChunks: VectorizedChunk[] = [];
    const batchSize = 10; // Process in batches to avoid rate limits

    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      const batchPromises = batch.map(async (chunk) => {
        try {
          const vector = await this.generateEmbedding(chunk.content);
          const embedding = new Float32Array(vector);

          const vectorizedChunk: VectorizedChunk = {
            ...chunk,
            vector,
            embedding
          };

          return vectorizedChunk;
        } catch (error) {
          console.error(`Error vectorizing chunk ${chunk.id}:`, error);
          return null;
        }
      });

      const batchResults = await Promise.all(batchPromises);
      const validResults = batchResults.filter(result => result !== null) as VectorizedChunk[];
      vectorizedChunks.push(...validResults);

      // Small delay between batches
      if (i + batchSize < chunks.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    // Store in Vectorize index
    if (vectorizedChunks.length > 0) {
      try {
        const vectors = vectorizedChunks.map(chunk => ({
          id: chunk.id,
          values: chunk.vector,
          metadata: chunk.metadata
        }));

        await this.vectorizeIndex.upsert(vectors);
        console.log(`Successfully stored ${vectorizedChunks.length} vectorized chunks`);
      } catch (error) {
        console.error('Error storing vectors in index:', error);
        throw error;
      }
    }

    return vectorizedChunks;
  }

  /**
   * Perform semantic similarity search
   */
  async semanticSearch(
    query: string,
    options: SimilaritySearchOptions = {}
  ): Promise<SimilaritySearchResult[]> {
    const {
      topK = 10,
      threshold = 0.7,
      filter = {},
      includeMetadata = true
    } = options;

    try {
      // Generate embedding for the query
      const queryVector = await this.generateEmbedding(query);

      // Perform vector search
      const searchResults = await this.vectorizeIndex.query(queryVector, {
        topK,
        filter
      });

      // Process and format results
      const results: SimilaritySearchResult[] = [];

      if (searchResults && searchResults.matches) {
        for (const match of searchResults.matches) {
          const score = match.score || 0;

          // Apply threshold filter
          if (score >= threshold) {
            const chunk: ContentChunk = {
              id: match.id,
              content: '', // Content not returned by query, would need separate lookup
              metadata: {
                source: (match.metadata as any)?.source || '',
                category: (match.metadata as any)?.category || '',
                title: (match.metadata as any)?.title,
                url: (match.metadata as any)?.url,
                chunkIndex: (match.metadata as any)?.chunkIndex || 0,
                totalChunks: (match.metadata as any)?.totalChunks || 0,
                timestamp: (match.metadata as any)?.timestamp || new Date().toISOString()
              }
            };

            results.push({
              chunk,
              score,
              distance: 1 - score // Convert cosine similarity to distance
            });
          }
        }
      }

      return results.sort((a, b) => b.score - a.score);
    } catch (error: unknown) {
      console.error('Error performing semantic search:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Semantic search failed: ${errorMessage}`);
    }
  }

  /**
   * Get chunk content by ID (for retrieving full content after search)
   */
  async getChunkContent(chunkId: string): Promise<ContentChunk | null> {
    try {
      // Query the D1 database for stored chunk content
      const result = await this.env.DB.prepare(`
        SELECT id, content, source, category, chunk_index, total_chunks, created_at,
               title, url
        FROM vectorized_chunks
        WHERE id = ?
      `).bind(chunkId).first();

      if (!result) {
        return null;
      }

      return {
        id: result.id,
        content: result.content,
        metadata: {
          source: result.source,
          category: result.category,
          chunkIndex: result.chunk_index,
          totalChunks: result.total_chunks,
          timestamp: result.created_at,
          title: result.title,
          url: result.url
        }
      };
    } catch (error) {
      console.error('Error retrieving chunk content:', error);
      return null;
    }
  }

  /**
   * Store chunk content in D1 database for retrieval
   */
  async storeChunkContent(chunks: ContentChunk[]): Promise<void> {
    try {
      const stmt = this.env.DB.prepare(`
        INSERT OR REPLACE INTO vectorized_chunks
        (id, content, source, category, chunk_index, total_chunks, title, url, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const chunk of chunks) {
        await stmt.bind(
          chunk.id,
          chunk.content,
          chunk.metadata.source,
          chunk.metadata.category,
          chunk.metadata.chunkIndex,
          chunk.metadata.totalChunks,
          chunk.metadata.title || null,
          chunk.metadata.url || null,
          chunk.metadata.timestamp
        ).run();
      }

      console.log(`Stored ${chunks.length} chunks in database`);
    } catch (error) {
      console.error('Error storing chunks in database:', error);
      throw error;
    }
  }

  /**
   * Delete chunks by source
   */
  async deleteChunksBySource(source: string): Promise<void> {
    try {
      // Delete from D1 database
      await this.env.DB.prepare(`
        DELETE FROM vectorized_chunks WHERE source = ?
      `).bind(source).run();

      // Delete from Vectorize index
      const chunks = await this.env.DB.prepare(`
        SELECT id FROM vectorized_chunks WHERE source = ?
      `).bind(source).all();

      if (chunks.results && chunks.results.length > 0) {
        const chunkIds = chunks.results.map((row: any) => row.id);
        await this.vectorizeIndex.deleteByIds(chunkIds);
      }

      console.log(`Deleted chunks for source: ${source}`);
    } catch (error) {
      console.error('Error deleting chunks:', error);
      throw error;
    }
  }

  /**
   * Get index statistics
   */
  async getIndexStats(): Promise<any> {
    try {
      // Get stats from D1
      const dbStats = await this.env.DB.prepare(`
        SELECT
          COUNT(*) as total_chunks,
          COUNT(DISTINCT source) as unique_sources,
          COUNT(DISTINCT category) as unique_categories,
          AVG(LENGTH(content)) as avg_content_length
        FROM vectorized_chunks
      `).first();

      return {
        database: dbStats,
        indexName: this.config.indexName,
        dimensions: this.config.dimensions,
        metric: this.config.metric
      };
    } catch (error) {
      console.error('Error getting index stats:', error);
      return null;
    }
  }
}

// Export utility functions
export function createVectorizeService(env: any): VectorizeService {
  return new VectorizeService(env);
}

export function calculateTextSimilarity(text1: string, text2: string): number {
  // Simple text similarity calculation as fallback
  const words1 = new Set(text1.toLowerCase().split(/\s+/));
  const words2 = new Set(text2.toLowerCase().split(/\s+/));

  const intersection = new Set(Array.from(words1).filter(word => words2.has(word)));
  const union = new Set([...words1, ...words2]);

  return intersection.size / union.size; // Jaccard similarity
}
