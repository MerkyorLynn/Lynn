/**
 * restore-snapshot-tool.js — Agent 用于恢复工作区快照的工具
 *
 * 列出和恢复 ~/.lynn/snapshots/ 下的自动快照。
 */

import { listSnapshots, restoreSnapshot } from "../sandbox/snapshot.js";

export function createRestoreSnapshotTool(agentId) {
  return {
    name: "restore_snapshot",
    description: "List and restore workspace file snapshots. Use 'list' action to see available snapshots, 'restore' action to restore a specific snapshot to a target path.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "restore"],
          description: "Action to perform: 'list' to see snapshots, 'restore' to restore one.",
        },
        snapshot_name: {
          type: "string",
          description: "Name of the snapshot to restore (from the list). Required for 'restore' action.",
        },
        target_path: {
          type: "string",
          description: "Target directory to restore to. Required for 'restore' action.",
        },
      },
      required: ["action"],
    },
    execute: async (_toolCallId, params) => {
      const { action, snapshot_name, target_path } = params;

      if (action === "list") {
        const snapshots = listSnapshots(agentId);
        if (snapshots.length === 0) {
          return {
            content: [{ type: "text", text: "No snapshots available. Snapshots are created automatically before dangerous file operations." }],
          };
        }
        const lines = snapshots.map((s, i) =>
          `${i + 1}. ${s.name} (created: ${s.created.toISOString()})`,
        );
        return {
          content: [{ type: "text", text: `Available snapshots:\n${lines.join("\n")}` }],
        };
      }

      if (action === "restore") {
        if (!snapshot_name || !target_path) {
          return {
            content: [{ type: "text", text: "Error: both snapshot_name and target_path are required for restore action." }],
          };
        }

        const snapshots = listSnapshots(agentId);
        const match = snapshots.find(s => s.name === snapshot_name);
        if (!match) {
          return {
            content: [{ type: "text", text: `Error: snapshot "${snapshot_name}" not found. Use 'list' action to see available snapshots.` }],
          };
        }

        const result = restoreSnapshot(match.path, target_path);
        if (result.success) {
          return {
            content: [{ type: "text", text: `Successfully restored snapshot "${snapshot_name}" to ${target_path}` }],
          };
        }
        return {
          content: [{ type: "text", text: `Restore failed: ${result.error}` }],
        };
      }

      return {
        content: [{ type: "text", text: `Unknown action: ${action}. Use 'list' or 'restore'.` }],
      };
    },
  };
}
