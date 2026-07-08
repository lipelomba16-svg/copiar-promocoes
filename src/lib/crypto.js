import crypto from 'crypto';
import { getState, saveState } from './store.js';

const ALGORITHM = 'aes-256-cbc';

async function ensureKey() {
  const state = await getState();
  if (!state.settings.security.encryptionKey) {
    state.settings.security.encryptionKey = crypto.randomBytes(32).toString('hex');
    await saveState(state);
  }
  return Buffer.from(state.settings.security.encryptionKey, 'hex');
}

export async function encryptIfNeeded(value) {
  const plain = String(value || '');
  if (!plain) return '';
  const key = await ensureKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}:${encrypted.toString('hex')}`;
}

export async function decryptIfNeeded(value) {
  const encrypted = String(value || '');
  if (!encrypted) return '';
  if (!encrypted.includes(':')) return encrypted;
  const key = await ensureKey();
  const [ivHex, dataHex] = encrypted.split(':');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]);
  return decrypted.toString('utf8');
}
