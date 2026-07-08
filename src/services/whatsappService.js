import fs from 'fs/promises';
import path from 'path';
import makeWASocket, { Browsers, DisconnectReason, fetchLatestBaileysVersion, useMultiFileAuthState } from '@whiskeysockets/baileys';
import P from 'pino';
import qrcode from 'qrcode';

const sessionsDir = path.join(process.cwd(), 'data', 'whatsapp-session');

class WhatsAppService {
  constructor() {
    this.status = 'disconnected';
    this.logs = [];
    this.qrCodeUrl = '';
    this.pairingCode = '';
    this.groups = [];
    this.phoneNumber = '';
    this.sock = null;
    this.auth = null;
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
    this.status = 'disconnected';
    this.qrCodeUrl = '';
    this.pairingCode = '';
  }

  async refreshGroups() {
    if (!this.sock) throw new Error('WhatsApp nao conectado.');
    const groups = await this.sock.groupFetchAllParticipating();
    this.groups = Object.values(groups).map((group) => ({
      id: group.id,
      name: group.subject,
      type: group.isCommunity || group.isCommunityAnnounce ? 'community' : 'group'
    }));
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
