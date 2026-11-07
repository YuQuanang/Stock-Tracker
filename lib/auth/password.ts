/**
 * Password hashing and verification for the single-user gate.
 *
 * We use scrypt from Node's built-in crypto module, so there is no native
 * dependency to compile on Vercel. scrypt is a memory-hard password hash
 * suitable for this purpose.
 *
 * Stored format (":" separators on purpose, because "$" is expanded by .env
 * loaders and would corrupt the value):
 *
 *   scrypt:<N>:<r>:<p>:<salt base64url>:<hash base64url>
 */
import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const SCRYPT_COST = 32768; // N: CPU/memory cost (2^15)
const SCRYPT_BLOCK_SIZE = 8; // r
const SCRYPT_PARALLELISM = 1; // p
const KEY_LENGTH_BYTES = 32;
const SALT_LENGTH_BYTES = 16;
// scrypt needs about 128 * N * r bytes (32 MiB here); allow headroom.
const SCRYPT_MAX_MEMORY_BYTES = 128 * 1024 * 1024;

function deriveKey(
  password: string,
  salt: Buffer,
  cost: number,
  blockSize: number,
  parallelism: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      KEY_LENGTH_BYTES,
      { N: cost, r: blockSize, p: parallelism, maxmem: SCRYPT_MAX_MEMORY_BYTES },
      (error, derivedKey) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(derivedKey);
      },
    );
  });
}

/** Creates a storable hash string for a plaintext password. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH_BYTES);
  const derivedKey = await deriveKey(
    password,
    salt,
    SCRYPT_COST,
    SCRYPT_BLOCK_SIZE,
    SCRYPT_PARALLELISM,
  );

  return [
    "scrypt",
    SCRYPT_COST,
    SCRYPT_BLOCK_SIZE,
    SCRYPT_PARALLELISM,
    salt.toString("base64url"),
    derivedKey.toString("base64url"),
  ].join(":");
}

/** Checks a plaintext password against a stored hash string. */
export async function verifyPasswordHash(
  password: string,
  storedHash: string,
): Promise<boolean> {
  const parts = storedHash.split(":");
  if (parts.length !== 6 || parts[0] !== "scrypt") {
    return false;
  }

  const cost = Number(parts[1]);
  const blockSize = Number(parts[2]);
  const parallelism = Number(parts[3]);
  const expectedKey = Buffer.from(parts[5], "base64url");
  const salt = Buffer.from(parts[4], "base64url");

  const parametersAreValid =
    Number.isInteger(cost) &&
    Number.isInteger(blockSize) &&
    Number.isInteger(parallelism) &&
    cost > 1 &&
    blockSize > 0 &&
    parallelism > 0;
  if (!parametersAreValid || expectedKey.length !== KEY_LENGTH_BYTES) {
    return false;
  }

  const actualKey = await deriveKey(password, salt, cost, blockSize, parallelism);
  return timingSafeEqual(actualKey, expectedKey);
}

/**
 * Compares two strings without leaking their length or content through timing.
 * Both sides are hashed first so the buffers are always the same length.
 */
export function constantTimeStringEqual(a: string, b: string): boolean {
  const hashA = createHash("sha256").update(a).digest();
  const hashB = createHash("sha256").update(b).digest();
  return timingSafeEqual(hashA, hashB);
}

