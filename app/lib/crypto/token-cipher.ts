import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "../../env.server";

// Access tokens are the single most sensitive thing this app stores — a leaked
// token grants full Admin API access to a merchant's store. Never log the
// plaintext or the encrypted value together with the shop domain.
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // recommended nonce size for GCM

function getKey(): Buffer {
  return Buffer.from(env().TOKEN_ENCRYPTION_KEY, "hex");
}

// Stored format: base64(iv) + "." + base64(authTag) + "." + base64(ciphertext)
export function encryptToken(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return [
    iv.toString("base64"),
    authTag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(".");
}

export function decryptToken(stored: string): string {
  const [ivB64, authTagB64, ciphertextB64] = stored.split(".");
  if (!ivB64 || !authTagB64 || !ciphertextB64) {
    throw new Error("Malformed encrypted token payload");
  }

  const decipher = createDecipheriv(
    ALGORITHM,
    getKey(),
    Buffer.from(ivB64, "base64"),
  );
  decipher.setAuthTag(Buffer.from(authTagB64, "base64"));

  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextB64, "base64")),
    decipher.final(),
  ]);

  return plaintext.toString("utf8");
}
