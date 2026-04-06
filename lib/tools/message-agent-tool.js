/**
 * message-agent-tool.js — Agent 私信工具
 *
 * 让 agent 向其他 agent 发起直达私信，等待回复。
 * 底层走 Hub.send({ from, to }) → AgentMessenger，不经过频道。
 */

import { Type } from "@sinclair/typebox";
import { t } from "../../server/i18n.js";

/**
 * @param {object} opts
 * @param {string} opts.agentId - 当前 agent ID
 * @param {() => Array<{id: string}>} opts.listAgents - 列出可用 agent
 * @param {(toId: string, text: string, opts?: object) => Promise<string|null>} opts.onMessage - 实际发送实现（由 Hub 注入）
 */
export function createMessageAgentTool({ agentId, listAgents, onMessage }) {
  return {
    name: "message_agent",
    label: t("toolDef.messageAgent.label"),
    description: t("toolDef.messageAgent.description"),
    parameters: Type.Object({
      to: Type.String({ description: t("toolDef.messageAgent.toDesc") }),
      message: Type.String({ description: t("toolDef.messageAgent.messageDesc") }),
      max_rounds: Type.Optional(Type.Number({
        description: t("toolDef.messageAgent.maxTurnsDesc"),
      })),
    }),
    execute: async (_toolCallId, params) => {
      if (params.to === agentId) {
        return { content: [{ type: "text", text: t("error.cannotSelfDm") }] };
      }

      const agents = listAgents();
      if (!agents.find(a => a.id === params.to)) {
        const ids = agents.map(a => a.id).join(", ");
        return {
          content: [{ type: "text", text: t("error.msgAgentNotFound", { id: params.to, ids: ids || "" }) }],
        };
      }

      const reply = await onMessage(params.to, params.message, {
        maxRounds: params.max_rounds,
      });

      return {
        content: [{ type: "text", text: reply || t("error.msgAgentNoReply", { name: params.to }) }],
        details: { from: agentId, to: params.to },
      };
    },
  };
}
