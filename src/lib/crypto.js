import crypto from 'crypto';
import { getState, saveState } from './store.js';
import { isEncryptedFormat } from './secrets.js';

const ALGORITHM = 'aes-256-cbc';

async function ensureKey() {
  const state = await getState();
  if (!state.settings.security.encryptionKey) {
    state.settings.security.encryptionKey = crypto.randomBytes(32).toString('hex');
    await saveState(state);
  }
  return Buffer.from(state.settings.security.encryptionKey, 'hex');
}

export { isEncryptedFormat } from './secrets.js';
export { maskSecret } from './secrets.js';

// Criptografa só se ainda não estiver no formato criptografado.
// Valores legados em texto claro continuam funcionando até o próximo
// save, quando são regravados criptografados.
export async function encryptIfNeeded(value) {
  const plain = String(value || '');
  if (!plain) return '';
  if (isEncryptedFormat(plain)) return plain;
  const key = await ensureKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}:${encrypted.toString('hex')}`;
}

// Descriptografa valores no formato criptografado; valores legados em
// texto claro (sem o formato iv:cipher) voltam como estão.
export async function decryptIfNeeded(value) {
  const encrypted = String(value || '');
  if (!encrypted) return '';
  if (!isEncryptedFormat(encrypted)) return encrypted;
  const key = await ensureKey();
  const [ivHex, dataHex] = encrypted.split(':');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]);
  return decrypted.toString('utf8');
}
