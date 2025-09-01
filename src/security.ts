// security.ts
// Electron safeStorage を利用したシンプルな暗号化/復号ユーティリティ

export function isEncryptionAvailable(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { safeStorage } = require('electron');
    return !!(safeStorage && safeStorage.isEncryptionAvailable && safeStorage.isEncryptionAvailable());
  } catch {
    return false;
  }
}

export function encryptToBase64(plain: string): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { safeStorage } = require('electron');
  if (!safeStorage || !safeStorage.encryptString) throw new Error('safeStorage が利用できません');
  const buf: Buffer = safeStorage.encryptString(plain);
  return buf.toString('base64');
}

export function decryptFromBase64(b64: string): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { safeStorage } = require('electron');
  if (!safeStorage || !safeStorage.decryptString) throw new Error('safeStorage が利用できません');
  const buf = Buffer.from(b64, 'base64');
  return safeStorage.decryptString(buf);
}

// ------------------ パスフレーズAES-GCMフォールバック ------------------
import { randomBytes, createCipheriv, createDecipheriv, pbkdf2Sync } from 'crypto';

export function encryptWithPassphrase(plain: string, passphrase: string): string {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = pbkdf2Sync(passphrase, salt, 120_000, 32, 'sha256');
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const packed = Buffer.concat([salt, iv, tag, enc]).toString('base64');
  return `aesgcm:${packed}`;
}

export function decryptWithPassphrase(packed: string, passphrase: string): string {
  if (!packed.startsWith('aesgcm:')) throw new Error('Invalid encrypted format');
  const buf = Buffer.from(packed.slice(7), 'base64');
  const salt = buf.subarray(0, 16);
  const iv = buf.subarray(16, 28);
  const tag = buf.subarray(28, 44);
  const data = buf.subarray(44);
  const key = pbkdf2Sync(passphrase, salt, 120_000, 32, 'sha256');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(data), decipher.final()]);
  return dec.toString('utf8');
}
