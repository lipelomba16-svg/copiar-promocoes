// Utilitários puros de segredo (sem dependências, sem acesso a estado).
// O formato criptografado usado por src/lib/crypto.js é `ivHex:cipherHex`
// (AES-256-CBC, IV de 16 bytes = 32 caracteres hex).

export function isEncryptedFormat(value) {
  return typeof value === 'string' && /^[0-9a-fA-F]{32}:[0-9a-fA-F]+$/.test(value.trim());
}

export function maskSecret(plaintext, visible = 4) {
  if (!plaintext) return '****';
  if (plaintext.length <= visible) return '*'.repeat(plaintext.length);
  return `${plaintext.slice(0, visible)}${'*'.repeat(Math.max(4, plaintext.length - visible))}`;
}
