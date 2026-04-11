export function inferReportKind(text: string): "" | "stock" | "real_estate";
export function normalizeReportResponseText(text: string): string;
export function inferReportPromptKind(text: string): "" | "stock" | "real_estate";
export function buildReportStructureHint(text: string, locale?: string): string;
