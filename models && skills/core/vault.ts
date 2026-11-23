/**
 * An encrypted file for the server's own records. Ciphertext on disk, fails closed.
 *
 * What it does:
 *   - AES-256-GCM from Node's own node:crypto. The key comes from a passphrase
 *     through scrypt with a random salt kept in the file header (a salt is not
 *     a secret). The passphrase and the key are never written anywhere.
 *   - The header (format tag, salt, purpose) is authenticated along with the
 *     contents, so changing any byte of the file, or opening it as some other
 *     vault, fails the check.
 *   - Every file is padded to a multiple of 4 KiB before it is encrypted, so
 *     its size says little about how much is inside. The file name is a plain
 *     one chosen by the caller and holds nothing, and everything (names,
 *     numbers, structure) lives inside the encryption.
 *   - Failing closed: a wrong passphrase, a damaged file or a changed byte
 *     throws a VaultError and returns NOTHING. There is no fallback to an empty
 *     vault, to a guess, or to plaintext, and no switch to skip any of this. A
 *     file that does not exist yet is the one case that reads as empty.
 *
 * What it does not do (stated plainly):
 *   - Deleting the file, or putting back an older valid copy of it, is not
 *     detected: that needs a second holder of the latest state, which a single
 *     file cannot be. Keep a copy somewhere else if that matters.
 *   - The passphrase is read from the environment, so anyone who can read this
 *     process's memory or environment can read the vault. It protects the disk,
 *     a stolen backup and a powered-off machine; it is not a hardware-sealed key.
 *   - A random 96-bit nonce per write is safe for far more writes than a
 *     server will ever make with one salt (the limit is about four billion).
 */

import crypto from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./atomic-write.js";

export class VaultError extends Error {
  constructor(message: string, readonly status: number = 503) {
    super(message);
  }
}

export const MIN_PASSPHRASE_LENGTH = 12;
const MAGIC = Buffer.from("NCV1");
const SALT_BYTES = 16;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + SALT_BYTES + NONCE_BYTES + TAG_BYTES;
const BLOCK = 4096;
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

export class Vault<T> {
  private key: Buffer | null = null;
  private salt: Buffer | null = null;

  constructor(
    private readonly file: string,
    passphrase: string,
    /** What this vault is for. Part of what is authenticated: a vault for one purpose will not open as another. */
    private readonly purpose: string,
    private readonly empty: () => T,
  ) {
    if (typeof passphrase !== "string" || passphrase.length < MIN_PASSPHRASE_LENGTH) {
      throw new VaultError(`The vault passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters.`, 500);
    }
    this.passphrase = passphrase;
  }

  private readonly passphrase: string;

  private deriveKey(salt: Buffer): Buffer {
    if (this.key && this.salt && this.salt.equals(salt)) return this.key;
    const key = crypto.scryptSync(this.passphrase, salt, 32, SCRYPT);
    this.key = key;
    this.salt = Buffer.from(salt);
    return key;
  }

  private aad(salt: Buffer): Buffer {
    return Buffer.concat([MAGIC, salt, Buffer.from(this.purpose, "utf8")]);
  }

  exists(): boolean {
    return existsSync(this.file);
  }

  /** The decrypted contents, a fresh empty value if the file does not exist yet, or a thrown VaultError. */
  read(): T {
    if (!existsSync(this.file)) return this.empty();
    let blob: Buffer;
    try {
      blob = readFileSync(this.file);
    } catch (e) {
      throw new VaultError(`The vault could not be read: ${e instanceof Error ? e.message : String(e)}`);
    }
    const damaged = (): VaultError => new VaultError("The vault could not be opened: wrong passphrase, or the file was changed. Nothing was read.");
    if (blob.length < HEADER_BYTES + 1 || !blob.subarray(0, MAGIC.length).equals(MAGIC)) throw damaged();
    const salt = blob.subarray(MAGIC.length, MAGIC.length + SALT_BYTES);
    const nonce = blob.subarray(MAGIC.length + SALT_BYTES, MAGIC.length + SALT_BYTES + NONCE_BYTES);
    const tag = blob.subarray(MAGIC.length + SALT_BYTES + NONCE_BYTES, HEADER_BYTES);
    const body = blob.subarray(HEADER_BYTES);
    let plain: Buffer;
    try {
      const d = crypto.createDecipheriv("aes-256-gcm", this.deriveKey(salt), nonce);
      d.setAAD(this.aad(salt));
      d.setAuthTag(tag);
      plain = Buffer.concat([d.update(body), d.final()]);
    } catch {
      throw damaged();
    }
    if (plain.length < 4) throw damaged();
    const len = plain.readUInt32BE(0);
    if (len > plain.length - 4) throw damaged();
    try {
      return JSON.parse(plain.subarray(4, 4 + len).toString("utf8")) as T;
    } catch {
      throw damaged();
    }
  }

  /** Encrypt and replace the file, atomically. Throws VaultError if it cannot be written. */
  write(value: T): void {
    const json = Buffer.from(JSON.stringify(value), "utf8");
    const framed = Buffer.alloc(Math.ceil((4 + json.length) / BLOCK) * BLOCK);
    framed.writeUInt32BE(json.length, 0);
    json.copy(framed, 4);
    crypto.randomFillSync(framed, 4 + json.length);

    // One salt for the life of the file: a new one would cost a scrypt run on every save.
    let salt = this.salt;
    if (!salt && existsSync(this.file)) {
      try {
        const head = readFileSync(this.file).subarray(0, MAGIC.length + SALT_BYTES);
        if (head.length === MAGIC.length + SALT_BYTES && head.subarray(0, MAGIC.length).equals(MAGIC)) salt = Buffer.from(head.subarray(MAGIC.length));
      } catch { /* a new salt is fine */ }
    }
    salt ??= crypto.randomBytes(SALT_BYTES);
    const key = this.deriveKey(salt);
    const nonce = crypto.randomBytes(NONCE_BYTES);
    const c = crypto.createCipheriv("aes-256-gcm", key, nonce);
    c.setAAD(this.aad(salt));
    const body = Buffer.concat([c.update(framed), c.final()]);
    const blob = Buffer.concat([MAGIC, salt, nonce, c.getAuthTag(), body]);
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileAtomic(this.file, blob);
      try { chmodSync(this.file, 0o600); } catch { /* not every file system has modes */ }
    } catch (e) {
      throw new VaultError(`The vault could not be saved: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
