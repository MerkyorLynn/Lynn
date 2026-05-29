/**
 * registry.ts — default worker-adapter registry (B-line server view).
 *
 * The GUI dispatches through one normalized entry; Lynn's adapter layer maps it to
 * the concrete CLI argv. v0.80 ships a small enabled set; others are present but
 * disabled until their JSONL/permission/cwd behaviour is verified on the machine.
 */
import type { FleetAgentKind } from "../../shared/fleet-events.js";

export interface FleetAgentEntry {
  // mimo-vl / mimo-pro / mimo-fast are not yet in the shared FleetAgentKind union;
  // the CLI lane (owns shared/fleet-events.ts) should promote them. `| string` keeps
  // this registry buildable in the meantime without editing the shared protocol.
  id: FleetAgentKind | string;
  label: string;
  bin: string;
  supportsJsonl: boolean;
  enabled: boolean;
}

export const DEFAULT_FLEET_REGISTRY: FleetAgentEntry[] = [
  { id: "lynn-cli", label: "Lynn CLI", bin: "lynn", supportsJsonl: true, enabled: true },
  // MiMo profiles of the lynn CLI: the MiMo agent/model is selected via the worker
  // brief, not a separate binary, so bin stays `lynn`.
  { id: "mimo-vl", label: "MiMo Vision (mimo-v2.5)", bin: "lynn", supportsJsonl: true, enabled: true },
  { id: "mimo-pro", label: "MiMo Pro (long-endurance)", bin: "lynn", supportsJsonl: true, enabled: true },
  { id: "mimo-fast", label: "MiMo Fast", bin: "lynn", supportsJsonl: true, enabled: true },
  { id: "codex-cli", label: "Codex", bin: "codex", supportsJsonl: true, enabled: true },
  { id: "claude-internal", label: "Claude (internal)", bin: "claude-internal", supportsJsonl: false, enabled: true },
  { id: "claude-code", label: "Claude Code", bin: "claude", supportsJsonl: true, enabled: true },
  { id: "qwen-cli", label: "Qwen", bin: "qwen", supportsJsonl: false, enabled: true },
  { id: "kimi-cli", label: "Kimi", bin: "kimi", supportsJsonl: false, enabled: false },
  { id: "codebuddy", label: "CodeBuddy", bin: "codebuddy", supportsJsonl: false, enabled: false },
  { id: "opencode", label: "OpenCode", bin: "opencode", supportsJsonl: false, enabled: false },
  { id: "custom", label: "Custom", bin: "", supportsJsonl: false, enabled: false },
];
