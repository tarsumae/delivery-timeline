// AES-GCM payload produced by tools/encrypt.py.
// Format: { v, kdf, iter, salt, iv, ct }
// Key: PBKDF2-SHA256, UTF-8 password, 32-byte AES-256-GCM key, no AAD.
// salt is 16 bytes, iv is 12 bytes, ct is ciphertext with the 16-byte tag appended.

const MIN_ITERATIONS = 200000;

export function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function toBuffer(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

export async function decryptBytes(payload, password) {
  if (!payload || payload.v !== 1 || payload.kdf !== "PBKDF2-SHA256") {
    throw new Error("unsupported");
  }
  if (!Number.isInteger(payload.iter) || payload.iter < MIN_ITERATIONS) {
    throw new Error("weak kdf");
  }
  const salt = b64ToBytes(payload.salt);
  const iv = b64ToBytes(payload.iv);
  const ct = b64ToBytes(payload.ct);
  if (salt.byteLength < 16 || iv.byteLength !== 12 || ct.byteLength < 17) {
    throw new Error("malformed");
  }
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  const key = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations: payload.iter,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, tagLength: 128 },
    key,
    toBuffer(ct)
  );
  return new Uint8Array(plain);
}

export async function decryptTimeline(payload, password) {
  const bytes = await decryptBytes(payload, password);
  return JSON.parse(new TextDecoder().decode(bytes));
}
