import path from "node:path";

/** A user-controlled name may identify one entry, never a filesystem path. */
export function isSafePathSegment(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200
    && value !== "." && value !== ".." && !/[\x00-\x1f\x7f]/.test(value)
    && !value.includes(":") && path.basename(value) === value && path.win32.basename(value) === value;
}
