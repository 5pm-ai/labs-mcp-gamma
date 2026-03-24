import { createDecipheriv } from "node:crypto";
import { KeyManagementServiceClient } from "@google-cloud/kms";
import { config } from "../../config.js";

let kms: KeyManagementServiceClient | null = null;

function getKmsClient(): KeyManagementServiceClient {
  if (!kms) {
    kms = new KeyManagementServiceClient();
  }
  return kms;
}

export interface EncryptedPayload {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  wrappedDek: Buffer;
}

export async function envelopeDecrypt(payload: EncryptedPayload): Promise<string> {
  if (!config.kms.keyName) {
    throw new Error("KMS_KEY_NAME not configured — cannot decrypt warehouse credentials");
  }

  const [unwrapResponse] = await getKmsClient().decrypt({
    name: config.kms.keyName,
    ciphertext: payload.wrappedDek,
  });

  if (!unwrapResponse.plaintext) {
    throw new Error("KMS decrypt returned empty plaintext");
  }

  const dek = Buffer.isBuffer(unwrapResponse.plaintext)
    ? unwrapResponse.plaintext
    : Buffer.from(unwrapResponse.plaintext);

  const decipher = createDecipheriv("aes-256-gcm", dek, payload.iv);
  decipher.setAuthTag(payload.authTag);
  const plaintext = Buffer.concat([
    decipher.update(payload.ciphertext),
    decipher.final(),
  ]);

  return plaintext.toString("utf8");
}
