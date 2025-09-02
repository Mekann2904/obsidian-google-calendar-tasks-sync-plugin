// security.ts
// 暗号化/難読化ユーティリティ（safeStorage は未使用）
import {
  createHash,
  createHmac,
  randomBytes,
  createCipheriv,
  createDecipheriv,
  pbkdf2,
  timingSafeEqual,
} from 'crypto';
import { promisify } from 'util';
import os from 'os';

// ------------------ パスフレーズAES-GCM ------------------
const pbkdf2Async = promisify(pbkdf2);

export async function encryptWithPassphrase(plain: string, passphrase: string): Promise<string> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await pbkdf2Async(passphrase, salt, 120_000, 32, 'sha256');
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return 'aesgcm:' + Buffer.concat([salt, iv, tag, enc]).toString('base64');
}

export async function decryptWithPassphrase(packed: string, passphrase: string): Promise<string> {
  if (!packed.startsWith('aesgcm:')) throw new Error('Invalid encrypted format');
  const buf = Buffer.from(packed.slice(7), 'base64');
  const salt = buf.subarray(0,16);
  const iv = buf.subarray(16,28);
  const tag = buf.subarray(28,44);
  const data = buf.subarray(44);
  const key = await pbkdf2Async(passphrase, salt, 120_000, 32, 'sha256');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(data), decipher.final()]);
  return dec.toString('utf8');
}

// ------------------ 難読化（obf1） ------------------
// 形式: "obf1:" + base64( nonce(12) | mac(32) | xored )
// key = sha256( base64salt || APP_ID || username || hostname )
// MAC = HMAC-SHA256(key, "obf1|" + nonce + xored)

const APP_ID = 'obsidian-gcal-sync';
const OBF1_MAGIC = 'obf1:';

function cryptoTimingSafeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function deriveKeyFromSalt(saltB64: string): Buffer {
  if (!saltB64) throw new Error('saltB64 is required');
  const salt = Buffer.from(saltB64, 'base64');
  if (salt.length < 8) throw new Error('salt too short');
  const mix = `${APP_ID}|${os.userInfo().username}|${os.hostname()}`;
  return createHash('sha256').update(salt).update(mix).digest();
}

export function obfuscateToBase64(plain: string, saltB64: string): string {
  const key = deriveKeyFromSalt(saltB64);
  const nonce = randomBytes(12);
  const data = Buffer.from(plain, 'utf8');
  const out = Buffer.allocUnsafe(data.length);
  const counterBuf = Buffer.alloc(4);
  let counter = 0, offset = 0;
  while (offset < data.length) {
    counterBuf.writeUInt32BE(counter);
    const block = createHash('sha256').update(key).update(nonce).update(counterBuf).digest();
    const n = Math.min(32, data.length - offset);
    for (let i=0;i<n;i++) out[offset + i] = data[offset + i] ^ block[i];
    offset += n; counter++;
  }
  const mac = createHmac('sha256', key).update('obf1|').update(nonce).update(out).digest();
  const packed = Buffer.concat([nonce, mac, out]);
  return OBF1_MAGIC + packed.toString('base64');
}

export function deobfuscateFromBase64(obf: string, saltB64: string): string {
  if (!obf.startsWith(OBF1_MAGIC)) throw new Error('Invalid obfuscation format (expect obf1:)');
  const key = deriveKeyFromSalt(saltB64);
  const buf = Buffer.from(obf.slice(OBF1_MAGIC.length), 'base64');
  if (buf.length < 12 + 32) throw new Error('Malformed payload');
  const nonce = buf.subarray(0, 12);
  const mac   = buf.subarray(12, 44);
  const body  = buf.subarray(44);
  const mac2 = createHmac('sha256', key).update('obf1|').update(nonce).update(body).digest();
  if (!cryptoTimingSafeEqual(mac, mac2)) throw new Error('MAC mismatch');
  const out = Buffer.allocUnsafe(body.length);
  const counterBuf = Buffer.alloc(4);
  let counter = 0, offset = 0;
  while (offset < body.length) {
    counterBuf.writeUInt32BE(counter);
    const block = createHash('sha256').update(key).update(nonce).update(counterBuf).digest();
    const n = Math.min(32, body.length - offset);
    for (let i=0;i<n;i++) out[offset + i] = body[offset + i] ^ block[i];
    offset += n; counter++;
  }
  return out.toString('utf8');
}

// 旧 obf: 形式（固定キーXOR）からの移行用・読み取り専用
export function deobfuscateLegacyFromBase64(obf: string, saltB64: string): string {
  if (!obf.startsWith('obf:')) throw new Error('Invalid legacy format');
  const salt = Buffer.from(saltB64 || '', 'base64');
  const key = createHash('sha256').update(salt).digest();
  const data = Buffer.from(obf.slice(4), 'base64');
  const out = Buffer.alloc(data.length);
  for (let i=0;i<data.length;i++) out[i] = data[i] ^ key[i % key.length];
  return out.toString('utf8');
}
