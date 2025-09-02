import { describe, it, expect } from 'vitest';
import {
  encryptWithPassphrase,
  decryptWithPassphrase,
  obfuscateToBase64,
  deobfuscateFromBase64,
  deobfuscateLegacyFromBase64,
} from '../src/security';
import { createHash } from 'crypto';

const SALT = Buffer.from('saltsalt').toString('base64');

function obfuscateLegacy(plain: string, saltB64: string): string {
  const salt = Buffer.from(saltB64 || '', 'base64');
  const key = createHash('sha256').update(salt).digest();
  const data = Buffer.from(plain, 'utf8');
  const out = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i] ^ key[i % key.length];
  return 'obf:' + out.toString('base64');
}

describe('encryptWithPassphrase/decryptWithPassphrase', () => {
  it('round-trips', () => {
    const enc = encryptWithPassphrase('hello', 'pass');
    const dec = decryptWithPassphrase(enc, 'pass');
    expect(dec).toBe('hello');
  });

  it('fails on wrong passphrase', () => {
    const enc = encryptWithPassphrase('hello', 'pass1');
    expect(() => decryptWithPassphrase(enc, 'pass2')).toThrow();
  });

  it('fails on invalid format', () => {
    expect(() => decryptWithPassphrase('foo', 'pass')).toThrow('Invalid encrypted format');
  });
});

describe('obfuscateToBase64/deobfuscateFromBase64', () => {
  it('round-trips', () => {
    const obf = obfuscateToBase64('hello', SALT);
    const dec = deobfuscateFromBase64(obf, SALT);
    expect(dec).toBe('hello');
  });

  it('fails on MAC mismatch when salt differs', () => {
    const obf = obfuscateToBase64('hello', SALT);
    const badSalt = Buffer.from('othersalt').toString('base64');
    expect(() => deobfuscateFromBase64(obf, badSalt)).toThrow('MAC mismatch');
  });

  it('fails on invalid prefix', () => {
    const obf = obfuscateToBase64('hello', SALT).replace(/^obf1:/, 'xxx:');
    expect(() => deobfuscateFromBase64(obf, SALT)).toThrow('Invalid obfuscation format');
  });
});

describe('deobfuscateLegacyFromBase64', () => {
  it('round-trips', () => {
    const obf = obfuscateLegacy('hello', SALT);
    const dec = deobfuscateLegacyFromBase64(obf, SALT);
    expect(dec).toBe('hello');
  });

  it('fails on invalid prefix', () => {
    expect(() => deobfuscateLegacyFromBase64('invalid', SALT)).toThrow('Invalid legacy format');
  });
});
