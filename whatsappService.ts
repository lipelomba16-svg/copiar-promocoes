import qrcode from 'qrcode';
import makeWASocket, {
    Browsers,
    DisconnectReason,
    downloadMediaMessage,
    initAuthCreds,
    BufferJSON,
    proto,
    AuthenticationCreds,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore
} from '@whiskeysockets/baileys';
import P from 'pino';
import { WhatsAppAuth } from '../lib/db.js';
import { Boom } from '@hapi/boom';
import {
    buildNativeLinkPreview,
    getPreviewTitleDiagnostics,
    type PreviewMetadataOverride
} from './nativeLinkPreviewService.js';

/**
 * 🚀 WhatsApp Engine v24 — "Nuclear" Stability
 * Improvements:
 * - Sequential Auth Guard: Replaces Promise.all with sequential writes to avoid MongoDB saturation.
 * - Linux Identity: Uses Ubuntu/Chrome to match Render's environment.
 * - Anti-Conflict: Strictly forbids new connection if a socket exists, regardless of RAM status.
 * - Flap Delay: Increased base backoff for ultra-unstable networks.
 */

// ─── MongoDB Auth State Provider ─────────────────────────────────────────────

async function loadAuthState(userId: string) {
    const PREFIX = `wa_${userId}_`;
    const logger = P({ level: 'silent' });

    const writeData = async (data: any, key: string) => {
        const fullKey = `${PREFIX}${key}`;
        try {
            if (data === null) {
                await WhatsAppAuth.deleteOne({ key: fullKey });
            } else {
                await WhatsAppAuth.updateOne(
                    { key: fullKey },
                    { $set: { value: JSON.stringify(data, BufferJSON.replacer), updatedAt: new Date() } },
                    { upsert: true }
                );
            }
        } catch (e) {
            console.error(`[DB:WriteError] ${key}:`, (e as any).message);
        }
    };

    const readData = async (key: string) => {
        const fullKey = `${PREFIX}${key}`;
        try {
            const doc = await WhatsAppAuth.findOne({ key: fullKey }).lean();
            if ((doc as any)?.value) {
                return JSON.parse((doc as any).value, BufferJSON.reviver);
            }
        } catch (e) { }
        return null;
    };

    const creds: AuthenticationCreds = (await readData('creds')) || initAuthCreds();
    const reconnectAttempt = (await readData('reconnectAttempt')) || 0;

    return {
        state: {
            creds,
            reconnectAttempt,
            keys: makeCacheableSignalKeyStore({
                get: async (type: string, ids: string[]) => {
                    const data: { [id: string]: any } = {};
                    await Promise.all(
                        ids.map(async (id) => {
                            const value = await readData(`${type}-${id}`);
                            if (type === 'app-state-sync-key' && value) {
                                data[id] = proto.Message.AppStateSyncKeyData.fromObject(value);
                            } else {
                                data[id] = value;
                            }
                        })
                    );
                    return data;
                },
                set: async (data: any) => {
                    // v24: Sequential writes to avoid MongoDB "Too Many Requests" or lock saturation
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            await writeData(value, key);
                        }
                    }
                }
            }, logger as any)
        },
        saveCreds: async () => {
            await writeData(creds, 'creds');
        },
        saveReconnect: async (attempt: number) => await writeData(attempt, 'reconnectAttempt'),
        saveMeta: async (meta: any) => await writeData(meta, 'meta_v17'),
        getMeta: async () => await readData('meta_v17'),
        deleteSession: async () => {
            await WhatsAppAuth.deleteMany({ key: { $regex: `^wa_${userId}_` } });
        }
    };
}

// ─── Backoff helper ───────────────────────────────────────────────────────────

function getBackoffMs(attempt: number): number {
    const base = 1000;
    const delay = base * Math.pow(2, Math.min(attempt, 3));
    const jitter = delay * 0.15 * (Math.random() - 0.5);
    return Math.min(delay + jitter, 8000);
}

function extractIncomingText(message: any): string {
    return String(
        message?.conversation ||
        message?.extendedTextMessage?.text ||
        message?.imageMessage?.caption ||
        message?.videoMessage?.caption ||
        message?.documentMessage?.caption ||
        ''
    ).trim();
}

function buildDataUrlFromBuffer(buffer: Buffer, mime = 'image/jpeg') {
    return `data:${mime};base64,${Buffer.from(buffer).toString('base64')}`;
}

function extractPreviewJpegThumbnailBuffer(item: any): Buffer | null {
    const jpegThumbnailRaw = item?.message?.extendedTextMessage?.jpegThumbnail;
    if (!jpegThumbnailRaw) return null;
    if (Buffer.isBuffer(jpegThumbnailRaw)) return jpegThumbnailRaw;
    if (jpegThumbnailRaw?.buffer) return Buffer.from(jpegThumbnailRaw.buffer);
    try {
        return Buffer.from(jpegThumbnailRaw);
    } catch {
        return null;
    }
}

async function extractIncomingImageDataUrl(item: any): Promise<string> {
    const message = item?.message || {};
    const imageMessage = message.imageMessage;
    if (!imageMessage) return '';
    try {
        const buffer = await Promise.race([
            downloadMediaMessage(item, 'buffer', {}),
            new Promise<Buffer>((_, reject) => setTimeout(() => reject(new Error('Timeout ao baixar imagem recebida')), 12000))
        ]);
        const mime = imageMessage.mimetype || 'image/jpeg';
        return `data:${mime};base64,${Buffer.from(buffer as Buffer).toString('base64')}`;
    } catch {
        return '';
    }
}

async function extractIncomingPreviewImageDataUrl(item: any): Promise<string> {
    const message = item?.message || {};
    const extendedTextMessage = message.extendedTextMessage;
    if (!extendedTextMessage) return '';

    try {
        if (extendedTextMessage.thumbnailDirectPath && extendedTextMessage.mediaKey) {
            const buffer = await Promise.race([
                downloadMediaMessage(item, 'buffer', {}),
                new Promise<Buffer>((_, reject) => setTimeout(() => reject(new Error('Timeout ao baixar preview recebido')), 12000))
            ]);
            return buildDataUrlFromBuffer(buffer as Buffer, 'image/jpeg');
        }
    } catch {
    }

    const jpegThumbnail = extractPreviewJpegThumbnailBuffer(item);
    if (jpegThumbnail?.length) {
        return buildDataUrlFromBuffer(jpegThumbnail, 'image/jpeg');
    }

    return '';
}

async function extractIncomingVisualImageDataUrl(item: any): Promise<string> {
    const directImage = await extractIncomingImageDataUrl(item);
    if (directImage) return directImage;
    return extractIncomingPreviewImageDataUrl(item);
}

// ─── WhatsApp Service Class ──────────────────────────────────────────────────

interface SessionRam {
    sock: any;
    status: 'disconnected' | 'connecting' | 'qr' | 'connected';
    qr: string | null;
    pairingCode: string | null;
    initLock: boolean;
    userDisconnected: boolean;
    connectionWaiters: Array<(connected: boolean) => void>;
    logs: string[];
    groups: Array<{ id: string; name: string; type?: 'group' | 'community' | 'newsletter' }>;
    syncInterval?: NodeJS.Timeout;
    reconnectAttempt: number;
    reconnectTimer?: NodeJS.Timeout;
    phoneNumber?: string;
    lastInitAt: number;
    connectedAt: number;
    heartbeatFailures: number;
}

interface SendMessageOptions {
    preferLinkPreview?: boolean;
    previewUrlOverride?: string;
    previewVisibleUrlOverride?: string;
    previewSuppressDescription?: boolean;
    previewMetadataOverride?: PreviewMetadataOverride;
}

export interface SendMessageResult {
    mode: 'photo' | 'native_preview' | 'native_preview_without_custom_image' | 'plain_text_fallback' | 'text';
    fallbackReason?: string;
}

export class WhatsAppService {
    private sessions = new Map<string, SessionRam>();
    private instanceId = process.env.RENDER_INSTANCE_ID || `local-${process.env.COMPUTERNAME || 'server'}`;

    private getRam(userId: string): SessionRam {
        if (!this.sessions.has(userId)) {
            this.sessions.set(userId, {
                sock: null,
                status: 'disconnected',
                qr: null,
                pairingCode: null,
                initLock: false,
                userDisconnected: false,
                connectionWaiters: [],
                logs: [],
                groups: [],
                reconnectAttempt: 0,
                lastInitAt: 0,
                connectedAt: 0,
                heartbeatFailures: 0
            });
        }
        return this.sessions.get(userId)!;
    }

    private log(userId: string, msg: string) {
        const s = this.getRam(userId);
        const logEntry = `[${new Date().toLocaleTimeString()}] ${msg}`;
        s.logs.push(logEntry);
        if (s.logs.length > 50) s.logs.shift();
        console.log(`[WA:${userId}] [${this.instanceId}] ${msg}`);
    }

    public async waitForStatusChange(userId: string, timeoutMs: number = 20000): Promise<string> {
        return new Promise((resolve) => {
            const start = Date.now();
            const interval = setInterval(() => {
                const s = this.getRam(userId);
                if (s.status !== 'connecting' || (Date.now() - start) > timeoutMs) {
                    clearInterval(interval);
                    resolve(s.status);
                }
            }, 500);
        });
    }

    public async getStatus(userId: string) {
        const s = this.getRam(userId);
        const auth = await loadAuthState(userId);
        const meta = await auth.getMeta() || {};
        const now = Date.now();

        // v52: Smart Self-heal - ONLY trigger if lock is truly free or ours
        if (!s.sock && !s.initLock && !s.userDisconnected && meta.status === 'connected') {
            const nowTime = Date.now();
            const lockActive = meta.ownerInstance && meta.ownerInstance !== this.instanceId && (nowTime - (meta.lastHeartbeat || 0)) < 45000;

            if (!lockActive) {
                this.log(userId, 'Recuperando conexão ativa...');
                this.initialize(userId, s.phoneNumber, true).catch(() => { });
            }
        }

        return {
            status: s.status !== 'disconnected' ? s.status : (meta.status || 'disconnected'),
            qrCodeUrl: s.qr || meta.qrCodeUrl,
            pairingCode: s.pairingCode || meta.pairingCode,
            logs: s.logs.length > 0 ? s.logs : (meta.initLog || ['Pronto']),
            initLog: s.logs.length > 0 ? s.logs : (meta.initLog || ['Pronto']), // v42: Naming alias to fix UI mismatch
            groups: s.groups.length > 0 ? s.groups : (meta.groups || [])
        };
    }

    private async closeSocket(s: SessionRam) {
        if (s.sock) {
            try { s.sock.ev.removeAllListeners(); } catch { }
            try { (s.sock.ws as any)?.terminate(); } catch { }
            s.sock = null;
        }
        if (s.syncInterval) { clearInterval(s.syncInterval); s.syncInterval = undefined; }
    }

    public async initialize(userId: string, phoneNumber?: string, internal = false): Promise<void> {
        const s = this.getRam(userId);

        if (s.userDisconnected && !phoneNumber) return;

        // v44: Atomic Lock - set IMMEDIATELY before any await
        if (s.initLock) return;
        s.initLock = true;

        try {
            const auth = await loadAuthState(userId);
            const meta = await auth.getMeta() || {};
            const now = Date.now();

            // 60s external guard
            if (!internal && meta.status === 'connecting' && (now - (meta.lastInitAttempt || 0)) < 60000) {
                this.log(userId, 'Sessão em uso. Aguarde 60s.');
                s.initLock = false; // Release lock for next retry
                return;
            }

            s.lastInitAt = now;
            s.status = 'connecting';
            if (phoneNumber) { s.phoneNumber = phoneNumber; s.userDisconnected = false; }

            this.clearReconnectTimer(s);
            await this.closeSocket(s);

            await auth.saveMeta({ ...meta, status: 'connecting', lastInitAttempt: now, phoneNumber: s.phoneNumber || meta.phoneNumber });

            this.log(userId, 'Preparando motor Baileys...');
            try {
                // v46: Singleton Lock Check - Improved takeover logic
                const metaCheck = await auth.getMeta() || {};
                const nowTime = Date.now();
                const ownerLockWindowMs = internal ? 1500 : 45000;
                if (metaCheck.ownerInstance && metaCheck.ownerInstance !== this.instanceId && (nowTime - (metaCheck.lastHeartbeat || 0)) < ownerLockWindowMs) {
                    this.log(userId, `Sessão ocupada por outra instância (${metaCheck.ownerInstance}). Tentando novamente em 2s...`);
                    s.initLock = false;
                    s.status = 'connecting';
                    setTimeout(() => this.initialize(userId, undefined, true).catch(() => { }), 2000);
                    return;
                }

                // v42: Dynamic versioning with 10s fetch timeout + fallback
                let version: [number, number, number] = [2, 3000, 1017531410];
                try {
                    const latest = await Promise.race([
                        fetchLatestBaileysVersion(),
                        new Promise<any>((_, reject) => setTimeout(() => reject('Timeout'), 10000))
                    ]);
                    version = latest.version;
                } catch (e) {
                    this.log(userId, 'Usando versão de fallback...');
                }

                this.log(userId, 'Estabelecendo conexão WS...');
                console.log(`[WA:${userId}] [v43] Instância: ${this.instanceId} | Versão: ${version.join('.')}`);

                // v43: Claim Ownership
                const m = await auth.getMeta() || {};
                await auth.saveMeta({ ...m, ownerInstance: this.instanceId, lastHeartbeat: Date.now() });

                s.sock = makeWASocket({
                    version,
                    auth: { creds: auth.state.creds, keys: auth.state.keys },
                    logger: P({ level: 'silent' }) as any,
                    browser: Browsers.macOS('Chrome'),
                    printQRInTerminal: false,
                    connectTimeoutMs: 60000,
                    defaultQueryTimeoutMs: 30000,
                    keepAliveIntervalMs: 15000,
                    markOnlineOnConnect: true,
                    syncFullHistory: false,
                    shouldSyncHistoryMessage: () => false,
                    generateHighQualityLinkPreview: true,
                    linkPreviewImageThumbnailWidth: 720,
                    getMessage: async () => ({ conversation: '...' } as any),
                });

                s.sock.ev.on('messaging-history.download', (m: any) => {
                    this.log(userId, `Sincronizando: ${m.progress}%`);
                });

                s.sock.ev.on('chats.set', (c: any) => {
                    this.log(userId, `Chats carregados: ${c.chats.length}`);
                });

                s.sock.ev.on('contacts.set', (c: any) => {
                    this.log(userId, `Contatos carregados: ${c.contacts.length}`);
                });

                s.sock.ev.on('messages.upsert', async (event: any) => {
                    if (event?.type && event.type !== 'notify') {
                        return;
                    }
                    const messages = Array.isArray(event?.messages) ? event.messages : [];
                    for (const item of messages) {
                        try {
                            const key = item?.key || {};
                            const remoteJid = key.remoteJid || '';
                            if (!remoteJid || key.fromMe) continue;
                            if (!remoteJid.endsWith('@g.us')) continue;

                            const text = extractIncomingText(item?.message);
                            if (!text) continue;

                            const source = s.groups.find(g => g.id === remoteJid);
                            const { copyPromoService } = await import('./copyPromoService.js');
                            const hasCopyPromo = await copyPromoService.hasActiveSourceConfig(userId, remoteJid);
                            if (!hasCopyPromo) continue;

                            const imageUrlPromise = extractIncomingImageDataUrl(item);
                            const sourceVisualImageUrlPromise = extractIncomingVisualImageDataUrl(item);
                            const result = await copyPromoService.handleIncomingWhatsAppMessage(userId, {
                                sourceGroupId: remoteJid,
                                sourceGroupName: source?.name || '',
                                messageId: key.id || '',
                                text,
                                imageUrlPromise,
                                sourceVisualImageUrlPromise,
                                body: {
                                    data: {
                                        key: { id: key.id || '', remoteJid },
                                        pushName: item?.pushName || source?.name || '',
                                        message: item?.message || {}
                                    }
                                }
                            });

                            if (result && !result.skipped) {
                                this.log(userId, `[Copiar Promo] Mensagem processada de ${source?.name || remoteJid}: ${result.success ? 'ok' : 'falha'}`);
                            }
                        } catch (e: any) {
                            this.log(userId, `[Copiar Promo] Erro ao processar mensagem recebida: ${e.message}`);
                        }
                    }
                });

                if (s.phoneNumber && !s.sock.authState.creds.registered) {
                    setTimeout(async () => {
                        try {
                            if (!s.sock) return;
                            const code = await s.sock.requestPairingCode(s.phoneNumber!);
                            s.pairingCode = code;
                            const mm = await auth.getMeta() || {};
                            await auth.saveMeta({ ...mm, pairingCode: code });
                            this.log(userId, `LINK: ${code}`);
                        } catch { }
                    }, 5000);
                }

                s.sock.ev.on('creds.update', auth.saveCreds);

                s.sock.ev.on('connection.update', async (up: any) => {
                    const { connection, lastDisconnect, qr } = up;

                    if (qr && !s.phoneNumber) {
                        s.status = 'qr';
                        s.qr = await qrcode.toDataURL(qr);
                    }

                    if (connection === 'open') {
                        s.status = 'connected';
                        s.qr = null;
                        s.pairingCode = null;
                        s.initLock = false;
                        s.connectedAt = Date.now();
                        s.heartbeatFailures = 0;

                        // v30: Force group fetch after a small delay to fix "0 groups" and allow stream settlement
                        setTimeout(() => {
                            this.log(userId, 'Solicitando atualização de grupos...');
                            this.refreshGroups(userId).catch(e => this.log(userId, `Erro refresh: ${e.message}`));
                        }, 5000);

                        // Flap detection: 15s stability required for reset (Aggressive)
                        setTimeout(async () => {
                            if (s.status === 'connected' && (Date.now() - s.connectedAt) >= 15000) {
                                s.reconnectAttempt = 0;
                                await auth.saveReconnect(0);
                            }
                        }, 16000);

                        const mm = await auth.getMeta() || {};
                        await auth.saveMeta({ ...mm, status: 'connected', lastSeen: Date.now(), ownerInstance: this.instanceId, lastHeartbeat: Date.now() });
                        this.log(userId, '✅ CONECTADO');

                        // Mantem a sessao viva e recupera quedas silenciosas sem deslogar o WhatsApp.
                        if (s.syncInterval) clearInterval(s.syncInterval);
                        s.syncInterval = setInterval(async () => {
                            try {
                                if (s.sock && s.status === 'connected') {
                                    await s.sock.sendPresenceUpdate('available');
                                    s.heartbeatFailures = 0;
                                }

                                const meta = await auth.getMeta() || {};
                                if (meta.ownerInstance === this.instanceId) {
                                    await auth.saveMeta({ ...meta, lastHeartbeat: Date.now() });
                                } else {
                                    this.log(userId, `Lock mudou para ${meta.ownerInstance}; reconexao automatica agendada sem deslogar.`);
                                    await this.closeSocket(s);
                                    s.status = 'connecting';
                                    this.clearReconnectTimer(s);
                                    s.reconnectTimer = setTimeout(() => {
                                        if (!s.userDisconnected) this.initialize(userId, undefined, true).catch(() => { });
                                    }, 1500);
                                }
                            } catch (error: any) {
                                s.heartbeatFailures++;
                                this.log(userId, `Heartbeat WhatsApp falhou (${s.heartbeatFailures}/1): ${error?.message || String(error)}`);

                                if (s.heartbeatFailures >= 1 && !s.initLock && !s.userDisconnected) {
                                    s.status = 'connecting';
                                    this.clearReconnectTimer(s);
                                    s.reconnectTimer = setTimeout(() => {
                                        if (!s.userDisconnected) this.initialize(userId, undefined, true).catch(() => { });
                                    }, 1500);
                                }
                            }
                        }, 10000);

                        this.notifyWaiters(userId, true);
                    }

                    if (connection === 'close') {
                        if (s.syncInterval) { clearInterval(s.syncInterval); s.syncInterval = undefined; }
                        s.initLock = false;
                        const bError = lastDisconnect?.error as Boom;
                        const code = bError?.output?.statusCode || (lastDisconnect?.error as any)?.code;
                        const reason = bError?.message || 'Motivo desconhecido';

                        this.log(userId, `Conexão fechada (${code}): ${reason}`);

                        if (code === DisconnectReason.loggedOut) {
                            if (s.userDisconnected) {
                                s.status = 'disconnected';
                                const mm = await auth.getMeta() || {};
                                await auth.saveMeta({ ...mm, status: 'disconnected' });
                                this.notifyWaiters(userId, false);
                                return;
                            }

                            this.log(userId, 'WhatsApp sinalizou loggedOut sem desconexao manual; preservando sessao e tentando reconectar.');
                            s.status = 'connecting';
                            const mm = await auth.getMeta() || {};
                            await auth.saveMeta({ ...mm, status: 'connecting' });
                            this.clearReconnectTimer(s);
                            s.reconnectTimer = setTimeout(() => {
                                if (!s.userDisconnected) this.initialize(userId, undefined, true).catch(() => { });
                            }, 1500);
                            return;
                        }

                        if (s.userDisconnected) {
                            s.status = 'disconnected';
                            this.notifyWaiters(userId, false);
                            return;
                        }

                        // v27: Persistent Backoff + Reason logging
                        s.reconnectAttempt++;
                        await auth.saveReconnect(s.reconnectAttempt);
                        let d = getBackoffMs(s.reconnectAttempt);

                        if (code === 440 || code === 428) {
                            this.log(userId, `Conflito/Timeout (${code}). Reconectando em instantes...`);
                            d += 1500;
                        }

                        s.status = 'connecting';
                        s.reconnectTimer = setTimeout(() => {
                            if (!s.userDisconnected) this.initialize(userId, undefined, true).catch(() => { });
                        }, d);
                    }
                });

            } catch (e: any) {
                s.initLock = false;
                this.log(userId, `Erro: ${e.message}`);
                if (!s.userDisconnected) {
                    const d = getBackoffMs(++s.reconnectAttempt);
                    s.reconnectTimer = setTimeout(() => this.initialize(userId, undefined, true).catch(() => { }), d);
                }
            } finally {
                // Ensure lock is released if we never reached the connect event
                // This is a safety timeout of 2 mins
                setTimeout(() => { if (s.status !== 'connected' && s.status !== 'qr') s.initLock = false; }, 120000);
            }
        } catch (outerError: any) {
            this.log(userId, `Erro fatal init: ${outerError.message}`);
            s.initLock = false;
        }
    }

    private clearReconnectTimer(s: SessionRam) {
        if (s.reconnectTimer) { clearTimeout(s.reconnectTimer); s.reconnectTimer = undefined; }
    }

    private notifyWaiters(userId: string, connected: boolean) {
        const s = this.getRam(userId);
        const ws = [...s.connectionWaiters];
        s.connectionWaiters = [];
        for (const r of ws) r(connected);
    }

    private replaceFirstLiteral(text: string, search: string, replacement: string) {
        if (!search) return text;
        const index = text.indexOf(search);
        if (index < 0) return text;
        return `${text.slice(0, index)}${replacement}${text.slice(index + search.length)}`;
    }

    public async disconnect(userId: string) {
        const s = this.getRam(userId);
        s.userDisconnected = true;
        s.status = 'disconnected';
        s.reconnectAttempt = 0;
        this.clearReconnectTimer(s);
        await this.closeSocket(s);
        const auth = await loadAuthState(userId);
        await auth.saveMeta({ status: 'disconnected' });
        this.log(userId, 'Desconectado.');
    }

    public async refreshGroups(userId: string) {
        const s = this.getRam(userId);
        if (!s.sock) return;
        try {
            this.log(userId, 'Sincronizando grupos e comunidades...');

            const allGroups = await s.sock.groupFetchAllParticipating();
            const groupsList = Object.values(allGroups).map((g: any) => {
                let type: 'group' | 'community' = 'group';
                if (g.isCommunity) type = 'community';
                if (g.isCommunityAnnounce) type = 'community';

                return {
                    id: g.id,
                    name: g.subject,
                    type
                };
            });

            s.groups = [...groupsList];
            const meta = await loadAuthState(userId);
            const m = await meta.getMeta() || {};
            await meta.saveMeta({ ...m, groups: s.groups });

            this.log(userId, `Sincronizacao de grupos concluida (${groupsList.length} itens).`);
        } catch (e: any) {
            this.log(userId, `Falha critica ao sincronizar: ${e.message}`);
        }
    }

    public async sendMessage(userId: string, jid: string, text: string, imageUrl?: string, options: SendMessageOptions = {}): Promise<SendMessageResult> {
        const s = this.getRam(userId);
        if (s.status !== 'connected') {
            s.userDisconnected = false;
            await this.initialize(userId, undefined, false);
            const ok = await new Promise(r => {
                s.connectionWaiters.push(r);
                // v44: Increased wait to 45s for slower networks (Render cold start)
                setTimeout(() => r(false), 45000);
            });
            if (!ok) {
                this.log(userId, 'Timeout aguardando conexão no sendMessage.');
                throw new Error('Falha ao reconectar dentro do tempo limite.');
            }
        }

        // v44: Pre-flight check - Force presence update to ensure socket is TRULY responsive
        try {
            if (s.sock) {
                // v44: Presence update should be fast, but we wrap it in a race for safety
                await Promise.race([
                    s.sock.sendPresenceUpdate('available', jid),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Presence Timeout')), 5000))
                ]);
            }
        } catch (e: any) {
            this.log(userId, `Pre-flight instavel (${e.message}); tentando enviar sem reiniciar a sessao.`);
        }

        // v46: Robust image sending with fallback
        try {
            if (imageUrl && imageUrl.startsWith('data:image/')) {
                const match = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
                if (!match) throw new Error('Imagem base64 invalida.');
                this.log(userId, `Enviando imagem copiada (${match[1]})`);
                await s.sock.sendMessage(jid, {
                    image: Buffer.from(match[2], 'base64'),
                    caption: text,
                    mimetype: match[1]
                });
                return { mode: 'photo' };
            } else if (imageUrl && imageUrl.startsWith('http')) {
                this.log(userId, `Enviando imagem: ${imageUrl.split('/').pop()}`);
                await s.sock.sendMessage(jid, {
                    image: { url: imageUrl },
                    caption: text,
                    mimetype: 'image/jpeg'
                });
                return { mode: 'photo' };
            } else {
                if (imageUrl) this.log(userId, `URL de imagem inválida ou ausente, enviando apenas texto.`);
                const prefersPreview = !!options.preferLinkPreview && /https?:\/\//i.test(text || '');
                if (prefersPreview) {
                    try {
                        const visibleUrl = options.previewVisibleUrlOverride
                            || text.match(/https?:\/\/[^\s<>"')]+/i)?.[0]?.replace(/[),.;]+$/, '')
                            || '';
                        const previewInput = options.previewUrlOverride
                            ? this.replaceFirstLiteral(text, visibleUrl, options.previewUrlOverride)
                            : text;
                        const { urlInfo, diagnostics } = await buildNativeLinkPreview(
                            previewInput,
                            s.sock,
                            (message) => this.log(userId, message),
                            {
                                suppressDescription: options.previewSuppressDescription,
                                fallbackMetadata: options.previewMetadataOverride
                            }
                        );

                        if (urlInfo) {
                            if (visibleUrl) {
                                urlInfo['matched-text'] = visibleUrl;
                                diagnostics.visibleUrl = visibleUrl;
                            }
                            Object.assign(diagnostics, getPreviewTitleDiagnostics(String(urlInfo.title || '')));
                            diagnostics.previewDescriptionPresent = typeof urlInfo.description !== 'undefined' && urlInfo.description !== null && String(urlInfo.description).length > 0;
                            this.log(
                                userId,
                                `Preview nativo anexado. visivel=${diagnostics.visibleUrl || 'n/a'} metadata=${diagnostics.metadataUrl || diagnostics.resolvedUrl || 'n/a'} imagem=${diagnostics.selectedImageSource || 'sem-imagem'} finalFonte=${diagnostics.finalPreviewImageSource || diagnostics.selectedImageSource || 'n/a'} original=${diagnostics.imageOriginalWidth || diagnostics.selectedImageWidth || '?'}x${diagnostics.imageOriginalHeight || diagnostics.selectedImageHeight || '?'} final=${diagnostics.processedImageWidth || diagnostics.processedThumbnailWidth || '?'}x${diagnostics.processedImageHeight || diagnostics.processedThumbnailHeight || '?'} resize=${diagnostics.processedImageResizeMode || 'n/a'} flatten=${diagnostics.processedImageFlattenApplied ? 'yes' : 'no'} bytes=${diagnostics.processedThumbnailBytes || 0} hashOrig=${diagnostics.imageHashPrefix || 'n/a'} hashFinal=${diagnostics.processedImageHashPrefix || 'n/a'} titleCp=${(diagnostics.previewTitleCodePoints || []).join(',') || 'n/a'} titleLen=${diagnostics.previewTitleLength ?? 0} descPresent=${diagnostics.previewDescriptionPresent ? 'yes' : 'no'}`
                            );
                            await s.sock.sendMessage(jid, { text, linkPreview: urlInfo });
                            return {
                                mode: diagnostics.selectedImageSource ? 'native_preview' : 'native_preview_without_custom_image'
                            };
                        }

                        this.log(
                            userId,
                            `Preview nativo indisponivel. visivel=${diagnostics.visibleUrl || 'n/a'} motivo=${diagnostics.fallbackFailureReason || diagnostics.failureReason || 'desconhecido'}`
                        );
                        await s.sock.sendMessage(jid, { text, linkPreview: null as any });
                        return {
                            mode: 'plain_text_fallback',
                            fallbackReason: diagnostics.fallbackFailureReason || diagnostics.failureReason || 'preview_unavailable'
                        };
                    } catch (previewError: any) {
                        this.log(userId, `Falha ao gerar preview nativo (${previewError.message}); enviando texto puro.`);
                        await s.sock.sendMessage(jid, { text, linkPreview: null as any });
                        return {
                            mode: 'plain_text_fallback',
                            fallbackReason: previewError.message || 'preview_generation_failed'
                        };
                    }
                }

                await s.sock.sendMessage(jid, { text });
                return { mode: 'text' };
            }
        } catch (sendError: any) {
            this.log(userId, `Erro ao enviar com imagem: ${sendError.message}. Tentando apenas texto...`);
            await s.sock.sendMessage(jid, { text });
            return {
                mode: 'plain_text_fallback',
                fallbackReason: sendError.message || 'image_send_failed'
            };
        }
    }

    /**
     * 🚀 v26: "Forever Online" Daemon
     * This function runs on server boot. It crawls the DB for any user who was 
     * 'connected' before the server died/restarted, and silently boots their
     * WhatsApp session back to life in the background, exactly like WhatsApp Web.
     */
    public async bootDaemon() {
        console.log('[WADaemon] Acordando sessões do banco de dados...');
        try {
            // Find all meta documents in MongoDB
            const metas = await WhatsAppAuth.find({ key: /_meta_v17$/ }).lean();
            let bootedCount = 0;

            for (const doc of metas) {
                try {
                    const userIdMatch = doc.key.match(/^wa_(.*)_meta_v17$/);
                    if (userIdMatch) {
                        const userId = userIdMatch[1];
                        const meta = JSON.parse((doc as any).value, BufferJSON.reviver);

                        if (meta.status === 'connected' || meta.status === 'connecting') {
                            bootedCount++;
                            console.log(`[WADaemon] Restaurando sessão (Forever Online) do usuário: ${userId}`);

                            // Jitter to prevent Code 440/MongoDB death if 100 users boot at exact same millisecond
                            const jitterMs = 250 + (Math.random() * 1000);
                            setTimeout(() => {
                                // internal = true, bypass auth locks to force recovery
                                this.initialize(userId, meta.phoneNumber, true).catch(() => { });
                            }, jitterMs);
                        }
                    }
                } catch (e) { }
            }
            console.log(`[WADaemon] ${bootedCount} sessões colocadas na fila de reconexão automática.`);
        } catch (e) {
            console.error('[WADaemon] Falha ao verificar sessões inativas', e);
        }
    }
}

export const waService = new WhatsAppService();
