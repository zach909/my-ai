/**
 * EEG plugin: the chat front door to the EEG decoder (eeg-decoder.ts).
 *
 *   eeg                      what it can do
 *   eeg demo                 decode a built-in simulated recording
 *   eeg list                 the recordings in the drop folder
 *   eeg decode <file>        decode a recording from the drop folder
 *
 * Recordings are CSV/TSV/text, one row per sample, one column per channel,
 * optionally with `# fs=256` on top. They are read only from the drop folder
 * `<data dir>/eeg/` by plain file name, so this plugin cannot be used to read
 * other files (that stays behind the File System plugin's gate). Nothing is
 * written and nothing leaves the machine.
 *
 * The result is plain text and goes back through the normal chat path, so the
 * agent reads decoded events like any other message, as the raw bits they are.
 * No tokenizer is involved.
 *
 * Dispatch is strict: onMessage() returns null unless the text starts with the
 * word "eeg", so ordinary chat falls through to the next plugin.
 */

import { closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readSync } from "node:fs";
import path from "node:path";
import type { PluginDefinition } from "../plugin_manager/types.js";
import { BasePlugin } from "../plugin_manager/sdk.js";
import { dataRoot } from "../interface/platform/app-paths.js";
import { EegError, MAX_SAMPLES, decodeEeg, demoRecording, describeDecoding, parseEegText } from "./eeg-decoder.js";

const MAX_FILE_BYTES = 32 * 1024 * 1024;
const FILE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,100}\.(?:csv|tsv|txt)$/;

const USAGE =
  "EEG commands:\n" +
  "  eeg demo — decode a built-in simulated recording\n" +
  "  eeg list — recordings in the drop folder\n" +
  "  eeg decode <file> — decode a recording (CSV/TSV, one column per channel, optional \"# fs=256\" line)\n" +
  "It reports band power, focus / relaxation / drowsiness, blinks and jaw clenches. " +
  "It measures signal patterns; it cannot read thoughts or words.";

export function eegDropFolder(): string {
  return path.join(dataRoot(), "eeg");
}

export class EegPlugin extends BasePlugin {
  constructor(definition: PluginDefinition) {
    super(definition);
  }

  describeCapabilities() {
    return {
      commands: ["eeg", "eeg demo", "eeg list", "eeg decode <file>"],
      verbs: ["decode"],
      nouns: ["eeg", "brainwave", "brainwaves", "brain signal", "brain signals", "neural signal", "bci"],
    };
  }

  wouldAct(message: unknown): boolean {
    return /^eeg\b/i.test(String(message ?? "").trim());
  }

  override async onMessage(message: unknown): Promise<unknown> {
    const input = (typeof message === "string" ? message : String(message ?? "")).trim();
    if (!/^eeg\b/i.test(input)) return null;

    if (/^eeg$|^eeg\s+help$/i.test(input)) return { tool: "eeg", result: USAGE };

    try {
      if (/^eeg\s+demo$/i.test(input)) {
        return { tool: "eeg", result: describeDecoding(decodeEeg(demoRecording())) + "\n(Simulated data: relaxed, then focused with a blink at 17 s, then drowsy.)" };
      }

      if (/^eeg\s+list$/i.test(input)) {
        const dir = eegDropFolder();
        const files = existsSync(dir) ? readdirSync(dir).filter(f => FILE_NAME.test(f)).sort().slice(0, 50) : [];
        return { tool: "eeg", result: files.length ? `Recordings in ${dir}:\n${files.map(f => `  ${f}`).join("\n")}` : `No recordings yet. Put a .csv, .tsv or .txt file in ${dir}.` };
      }

      const decode = /^eeg\s+decode\s+(\S+)$/i.exec(input);
      if (decode) return { tool: "eeg", result: describeDecoding(decodeEeg(parseEegText(readRecording(decode[1])))) };
    } catch (err) {
      if (err instanceof EegError) return { tool: "eeg", result: err.message };
      throw err;
    }
    return { tool: "eeg", result: USAGE };
  }
}

/** Read one recording from the drop folder by bare file name. */
function readRecording(name: string): string {
  if (!FILE_NAME.test(name)) throw new EegError("Give just a file name ending in .csv, .tsv or .txt (no folders).");
  const dir = eegDropFolder();
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  let fd: number;
  try {
    // O_NOFOLLOW: a symlink dropped in the folder must not lead outside it (0 where the OS has no such flag).
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    throw new EegError(`There is no recording ${name} in ${dir}.`);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new EegError(`${name} is not a regular file.`);
    if (st.size > MAX_FILE_BYTES) throw new EegError(`${name} is too large (limit ${MAX_FILE_BYTES / 1024 / 1024} MB, ${MAX_SAMPLES} samples).`);
    const buf = Buffer.alloc(st.size);
    let read = 0;
    while (read < st.size) {
      const n = readSync(fd, buf, read, st.size - read, read);
      if (n <= 0) break;
      read += n;
    }
    return buf.toString("utf8", 0, read);
  } finally {
    closeSync(fd);
  }
}
