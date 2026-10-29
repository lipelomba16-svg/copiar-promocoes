import fs from 'fs/promises';
import path from 'path';
import makeWASocket, { Browsers, DisconnectReason, fetchLatestBaileysVersion, useMultiFileAuthState } from '@whiskeysockets/baileys';
import P from 'pino';
import qrcode from 'qrcode';
import { isGroupOrNewsletterJid, parseManualSource } from '../lib/promoText.js';

const sessionsDir = path.join(process.cwd(), 'data', 'whatsapp-session');

function normalizeNewsletterItems(value, found = new Map()) {
  if (!value) return found;
  if (Array.isArray(value)) {
    value.forEach((item) => normalizeNewsletterItems(item, found));
    return found;
  }
  if (typeof value === 'object') {
    const id = value.id || value.jid || value.newsletterJid;
    if (typeof id === 'string' && id.endsWith('@newsletter')) {
      found.set(id, { id, name: typeof value.name === 'string' ? value.name : id, type: 'newsletter' });
      return found;
    }
    for (const item of Object.values(value)) normalizeNewsletterItems(item, found);
  }
  return found;
}

function normalizeIncomingMessage(raw) {
  const key = raw?.key || {};
  const message = raw?.message || {};
  const extended = message.extendedTextMessage || {};
  const image = message.imageMessage || {};
  return {
    text: message.conversation || extended.text || image.caption || '',
    caption: image.caption || extended.text || '',
    imageUrl: image.url || '',
    remoteJid: key.remoteJid || '',
    sourceGroupId: key.remoteJid || '',
    sourceGroupName: raw?.pushName || '',
    messageId: key.id || '',
    id: key.id || '',
    fromMe: Boolean(key.fromMe),
    participant: key.participant || ''
  };
}

class WhatsAppService {
  constructor() {
    this.status = 'disconnected';
    this.logs = [];
    this.qrCodeUrl = '';
    this.pairingCode = '';
    this.groups = [];
    this.newsletters = [];
    this.phoneNumber = '';
    this.sock = null;
    this.auth = null;
    this.listenerAttached = false;
  }

  log(message) {
    this.logs.push(`[${new Date().toLocaleTimeString()}] ${message}`);
    this.logs = this.logs.slice(-60);
    console.log(`[WhatsApp] ${message}`);
  }

  async bootstrap() {
    await fs.mkdir(sessionsDir, { recursive: true });
  }

  async getStatus() {
    return {
      status: this.status,
      qrCodeUrl: this.qrCodeUrl,
      pairingCode: this.pairingCode,
      groups: this.groups,
      newsletters: this.newsletters,
      logs: this.logs
    };
  }

  async connect(phoneNumber = '') {
    if (this.sock) return;
    this.phoneNumber = phoneNumber || this.phoneNumber;
    this.status = 'connecting';
    this.auth = await useMultiFileAuthState(sessionsDir);
    let version = [2, 3000, 1015901307];
    try {
      const latest = await fetchLatestBaileysVersion();
      version = latest.version;
    } catch {}
    this.sock = makeWASocket({
      version,
      auth: this.auth.state,
      logger: P({ level: 'silent' }),
      browser: Browsers.macOS('Desktop'),
      printQRInTerminal: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: true
    });
    this.sock.ev.on('creds.update', this.auth.saveCreds);
    this.attachMessageListener();
    this.sock.ev.on('connection.update', async (update) => {
      if (update.qr) {
        this.status = 'qr';
        this.qrCodeUrl = await qrcode.toDataURL(update.qr);
      }
      if (update.connection === 'open') {
        this.status = 'connected';
        this.qrCodeUrl = '';
        this.pairingCode = '';
        this.log('WhatsApp conectado.');
        await this.refreshGroups();
      }
      if (update.connection === 'close') {
        const code = update.lastDisconnect?.error?.output?.statusCode;
        this.log(`Conexao encerrada (${code || 'n/a'}).`);
        this.sock = null;
        this.listenerAttached = false;
        if (code !== DisconnectReason.loggedOut) {
          this.status = 'disconnected';
        }
      }
    });
    if (this.phoneNumber && !this.sock.authState.creds.registered) {
      setTimeout(async () => {
        try {
          this.pairingCode = await this.sock.requestPairingCode(this.phoneNumber);
          this.log(`Codigo de pareamento gerado para ${this.phoneNumber}.`);
        } catch (error) {
          this.log(`Falha ao gerar pareamento: ${error.message || String(error)}`);
        }
      }, 4000);
    }
  }

  attachMessageListener() {
    if (!this.sock || this.listenerAttached) return;
    this.listenerAttached = true;
    this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
      // Só mensagens novas ('notify'). Histórico ('append') não deve
      // reenviar promoções antigas.
      if (type && type !== 'notify') return;
      for (const raw of messages || []) {
        try {
          await this.handleIncomingMessage(raw);
        } catch (error) {
          this.log(`Falha ao processar mensagem recebida: ${error.message || String(error)}`);
        }
      }
    });
  }

  async handleIncomingMessage(raw) {
    const message = normalizeIncomingMessage(raw);
    if (message.fromMe) return;
    if (!isGroupOrNewsletterJid(message.remoteJid)) return;
    // Canal detectado numa mensagem: salvar/preservar para a listagem.
    if (message.remoteJid.endsWith('@newsletter')) {
      this.registerNewsletter(message.remoteJid, message.sourceGroupName || message.remoteJid);
    }
    // Import dinâmico para evitar ciclo: copyPromoService importa
    // whatsappService para enviar; o listener só precisa dele aqui.
    const { copyPromoService } = await import('./copyPromoService.js');
    const configs = await copyPromoService.listConfigs();
    const matching = configs.filter((config) => config.isActive && config.sourceGroupId === message.remoteJid);
    for (const config of matching) {
      await copyPromoService.processConfig(config.id, message);
    }
  }

  registerNewsletter(jid, name = '') {
    const entry = { id: jid, name: name || jid, type: 'newsletter' };
    if (!this.newsletters.some((item) => item.id === jid)) {
      this.newsletters.push(entry);
    }
    if (!this.groups.some((item) => item.id === jid)) {
      this.groups.push(entry);
    }
    return entry;
  }

  // Cadastro manual de origem por JID (fallback quando a listagem
  // automática falha). Links de convite/canal não viram origem sozinhos:
  // o JID precisa ser resolvido pela conexão ou digitado aqui.
  addManualSource(input, name = '') {
    const parsed = parseManualSource(input);
    if (parsed.kind !== 'jid') {
      throw new Error(parsed.kind === 'invite'
        ? 'Link de convite/canal não pode ser salvo como origem: resolva o JID pela conexão do WhatsApp ou cadastre o JID manualmente.'
        : parsed.reason);
    }
    const type = parsed.jid.endsWith('@newsletter') ? 'newsletter' : 'group';
    const entry = { id: parsed.jid, name: name || parsed.jid, type, manual: true };
    if (type === 'newsletter') this.registerNewsletter(parsed.jid, entry.name);
    else if (!this.groups.some((item) => item.id === parsed.jid)) this.groups.push(entry);
    return entry;
  }

  // Descoberta de canais: tenta newsletterSubscribed() e a query
  // w:mex newsletter_subscribed, preservando os já detectados.
  // Baileys nem sempre lista canais de forma confiável: cada tentativa
  // é best-effort e nunca lança erro.
  async discoverNewsletters() {
    const found = new Map(this.newsletters.map((item) => [item.id, item]));
    if (this.sock) {
      try {
        if (typeof this.sock.newsletterSubscribed === 'function') {
          normalizeNewsletterItems(await this.sock.newsletterSubscribed(), found);
        }
      } catch {}
      try {
        if (typeof this.sock.query === 'function') {
          const result = await this.sock.query({ tag: 'w:mex', attrs: { query: 'newsletter_subscribed' } });
          normalizeNewsletterItems(result, found);
        }
      } catch {}
    }
    this.newsletters = [...found.values()];
    for (const item of this.newsletters) {
      if (!this.groups.some((group) => group.id === item.id)) this.groups.push(item);
    }
    return this.newsletters;
  }

  async disconnect() {
    if (this.sock) {
      try {
        await this.sock.logout();
      } catch {}
      try {
        this.sock.end(new Error('manual_disconnect'));
      } catch {}
    }
    this.sock = null;
    this.listenerAttached = false;
    this.status = 'disconnected';
    this.qrCodeUrl = '';
    this.pairingCode = '';
  }

  async refreshGroups() {
    if (!this.sock) throw new Error('WhatsApp nao conectado.');
    const groups = await this.sock.groupFetchAllParticipating();
    const fetched = Object.values(groups).map((group) => ({
      id: group.id,
      name: group.subject,
      type: group.isCommunity || group.isCommunityAnnounce ? 'community' : 'group'
    }));
    // Preservar canais já detectados/cadastrados: o fetch de grupos
    // não lista newsletters de forma confiável.
    const preserved = this.groups.filter((item) => item.type === 'newsletter' || item.manual);
    this.groups = [...fetched, ...preserved.filter((item) => !fetched.some((group) => group.id === item.id))];
    await this.discoverNewsletters();
    this.log(`Grupos sincronizados: ${this.groups.length}.`);
    return this.groups;
  }

  async sendMessage(jid, text, imageUrl, options = {}) {
    if (!this.sock || this.status !== 'connected') {
      throw new Error('WhatsApp nao conectado.');
    }
    if (imageUrl && !options.preferLinkPreview) {
      if (imageUrl.startsWith('data:image/')) {
        const match = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
        if (!match) throw new Error('Imagem em data URL inválida.');
        await this.sock.sendMessage(jid, {
          image: Buffer.from(match[2], 'base64'),
          caption: text,
          mimetype: match[1]
        });
        return { mode: 'photo' };
      }
      await this.sock.sendMessage(jid, { image: { url: imageUrl }, caption: text });
      return { mode: 'photo' };
    }
    await this.sock.sendMessage(jid, { text });
    return { mode: options.preferLinkPreview ? 'native_preview' : 'text' };
  }
}

export const whatsappService = new WhatsAppService();
export { normalizeIncomingMessage, normalizeNewsletterItems };
