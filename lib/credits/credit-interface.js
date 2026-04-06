/**
 * CreditInterface — 积分系统抽象接口
 *
 * 开源版提供 noop 实现（本地使用不计费）。
 * 闭源 Cloud 插件可通过 registerPlugin() 注入真正的计费实现，
 * 替换 engine.creditInterface。
 */

export class CreditInterface {
  /**
   * 获取用户积分余额
   * @param {string} userId
   * @returns {Promise<number>}
   */
  async getBalance(userId) {
    return Infinity; // 本地模式：无限积分
  }

  /**
   * 消耗积分
   * @param {string} userId
   * @param {number} amount
   * @param {string} reason - 消费原因（如 "expert:financial-analyst"）
   * @returns {Promise<boolean>} - 是否成功
   */
  async consume(userId, amount, reason) {
    return true; // 本地模式：始终成功
  }

  /**
   * 检查是否有足够积分
   * @param {string} userId
   * @param {number} amount
   * @returns {Promise<boolean>}
   */
  async canAfford(userId, amount) {
    return true; // 本地模式：始终可以
  }
}
