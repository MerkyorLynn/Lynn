import fs from "node:fs";
import path from "node:path";

export class AuthStorage {
  private readonly file: string;
  private data: Record<string, unknown> = {};

  private constructor(file: string) {
    this.file = file;
    this.load();
  }

  static create(fileOrDir?: string): AuthStorage {
    const target = fileOrDir && fileOrDir.endsWith(".json")
      ? fileOrDir
      : path.join(fileOrDir || path.join(process.cwd(), ".lynn"), "auth.json");
    return new AuthStorage(target);
  }

  private load(): void {
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, "utf8")) as Record<string, unknown>;
    } catch {
      this.data = {};
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, `${JSON.stringify(this.data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.chmodSync(this.file, 0o600);
  }

  get(key: string): unknown {
    return this.data[key];
  }

  set(key: string, value: unknown): void {
    this.data[key] = value;
    this.save();
  }

  remove(key: string): void {
    delete this.data[key];
    this.save();
  }

  delete(key: string): void {
    this.remove(key);
  }

  has(key: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.data, key);
  }

  list(): Record<string, unknown> {
    return { ...this.data };
  }
}
