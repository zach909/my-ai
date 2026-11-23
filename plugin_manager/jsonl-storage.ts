import * as fs from "node:fs";
import * as path from "node:path";
import type { StoragePlugin, StorageRecord } from "./kinds.js";

/** Stream names become file names, so anything but letters, digits, "_" and "-" is replaced. */
function fileSafe(stream: string): string {
  return stream.replace(/[^a-zA-Z0-9_-]+/g, "_") || "default";
}

/**
 * One JSON object per line, one file per stream, under a directory you choose.
 * Append-only, so a crash can lose at most the line being written, and a
 * half-written last line is skipped on read rather than failing the stream.
 */
export class JsonlStorage implements StoragePlugin {
  readonly kind = "storage" as const;
  readonly id: string;
  readonly name = "JSONL storage";
  private readonly dir: string;

  constructor(dir: string, id = "jsonl") {
    this.dir = dir;
    this.id = id;
  }

  private file(stream: string): string {
    return path.join(this.dir, `${fileSafe(stream)}.jsonl`);
  }

  async activate(): Promise<void> {
    await fs.promises.mkdir(this.dir, { recursive: true });
  }

  async health(): Promise<boolean> {
    try {
      await fs.promises.access(this.dir, fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  async append(stream: string, record: StorageRecord): Promise<void> {
    await fs.promises.mkdir(this.dir, { recursive: true });
    await fs.promises.appendFile(this.file(stream), `${JSON.stringify(record)}\n`, "utf8");
  }

  async read(stream: string, options: { limit?: number } = {}): Promise<StorageRecord[]> {
    let text: string;
    try {
      text = await fs.promises.readFile(this.file(stream), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const records: StorageRecord[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line) as StorageRecord);
      } catch {
        // A torn final line from an interrupted write: skip it.
      }
    }
    return options.limit !== undefined ? records.slice(-Math.max(0, options.limit)) : records;
  }

  async streams(): Promise<string[]> {
    try {
      const names = await fs.promises.readdir(this.dir);
      return names.filter((n: string) => n.endsWith(".jsonl")).map((n: string) => n.slice(0, -".jsonl".length));
    } catch {
      return [];
    }
  }
}
