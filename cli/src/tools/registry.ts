import { readFileTool } from "./read-file.js";
import { writeFileTool } from "./write-file.js";
import { applyPatchTool } from "./apply-patch.js";
import { grepTool } from "./grep.js";
import { globTool } from "./glob.js";
import { bashTool } from "./bash.js";
import { webScanTool } from "./web-scan.js";
import { CLIENT_TOOL_DEFINITIONS, type ClientToolName, type ClientToolResult, type ToolRunContext } from "./types.js";
import { normalizePlanItems } from "../plan-tool.js";

export { CLIENT_TOOL_DEFINITIONS };

export interface ToolRunInput {
  name: ClientToolName;
  path?: string;
  text?: string;
  query?: string;
  pattern?: string;
  command?: string;
  plan?: unknown;
  maxBytes?: number;
  offset?: number;
  url?: string;
}

export async function runClientTool(ctx: ToolRunContext, input: ToolRunInput): Promise<ClientToolResult> {
  if (ctx.sandbox === "read-only" && CLIENT_TOOL_DEFINITIONS.some((tool) => tool.name === input.name && tool.dangerous)) {
    throw new Error(`${input.name} is blocked by read-only sandbox`);
  }
  switch (input.name) {
    case "read_file":
      return readFileTool(ctx, input.path || ".", input.maxBytes, input.offset);
    case "write_file":
      return writeFileTool(ctx, input.path || "", input.text || "");
    case "apply_patch":
      return applyPatchTool(ctx, input.text || "");
    case "grep":
      return grepTool(ctx, input.query || "", input.path || ".");
    case "glob":
      return globTool(ctx, input.pattern || "**", input.path || ".");
    case "bash":
      return bashTool(ctx, input.command || "");
    case "web_scan":
      return webScanTool(ctx, input.url || "");
    case "update_plan":
      return {
        ok: true,
        tool: "update_plan",
        output: { items: normalizePlanItems(input.plan) },
      };
    default:
      throw new Error(`unknown client tool: ${String(input.name)}`);
  }
}
