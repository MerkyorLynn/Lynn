/**
 * vector-interface.js — 向量搜索接口（stub）
 *
 * 当前为空实现，预留未来向量检索接口。
 *
 * 未来选项：
 * - sqlite-vec：SQLite 向量扩展，零依赖
 * - OpenAI Embeddings：需要 API 调用，有延迟
 * - ONNX Runtime：本地运行小型 embedding 模型
 * - Transformers.js：浏览器/Node.js embedding
 */

/**
 * 向量检索接口
 *
 * @typedef {object} VectorRetriever
 * @property {(query: string, limit: number) => Promise<Array<{ id: number, score: number }>>} search
 * @property {(id: number, text: string, tags: string[]) => Promise<void>} index
 * @property {boolean} available
 */

/**
 * 空实现 — 所有方法返回空结果
 */
export class NullVectorRetriever {
  get available() { return false; }

  async search(_query, _limit) {
    return [];
  }

  async index(_id, _text, _tags) {
    // no-op
  }
}

/**
 * 工厂函数 — 根据配置创建向量检索器
 *
 * 当前总是返回 NullVectorRetriever。
 * 未来可根据 config 选择实现：
 *
 * @param {object} [config]
 * @param {string} [config.type] - "null" | "sqlite-vec" | "openai" | "onnx"
 * @param {string} [config.dbPath] - 向量数据库路径
 * @param {string} [config.apiKey] - OpenAI API key（仅 type=openai 时需要）
 * @returns {VectorRetriever}
 *
 * @example
 * // 未来使用示例：
 * // const retriever = createVectorRetriever({ type: "sqlite-vec", dbPath: "/path/to/vec.db" });
 * // const results = await retriever.search("Next.js routing", 5);
 */
export function createVectorRetriever(config = {}) {
  // 未来扩展点：
  // switch (config.type) {
  //   case "sqlite-vec":
  //     return new SqliteVecRetriever(config.dbPath);
  //   case "openai":
  //     return new OpenAIEmbeddingRetriever(config.apiKey);
  //   case "onnx":
  //     return new OnnxRetriever(config.modelPath);
  //   default:
  //     return new NullVectorRetriever();
  // }

  return new NullVectorRetriever();
}
