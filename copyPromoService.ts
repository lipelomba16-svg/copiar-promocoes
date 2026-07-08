import crypto from 'crypto';
import { CopyPromoConfig, CopyPromoLog, ShopeeCredential, UserGroup } from '../lib/db.js';
import { decryptSecret, encryptSecret } from './cryptoService.js';
import { aliexpressAffiliateService } from './aliexpressAffiliateService.js';
import { amazonAffiliateService, buildAmazonTaggedUrl } from './amazonAffiliateService.js';
import { mercadoLivreN8nJsonService } from './mercadoLivreN8nJsonService.js';
import { createShopeeClient } from './shopeeClientFactory.js';
import {
  assertShopeeIdentityMatch,
  buildShopeeCanonicalProductUrl,
  parseShopeeIdentityFromUrl,
  resolveShopeeUrlForIdentity,
  selectShopeeProductCandidate,
  type ShopeeIdentity
} from './shopeeCopyPromoIntegrity.js';
import {
  extractMercadoLivreItemId,
  validateMercadoLivreReplacementSafety,
  type MercadoLivreUrlClassification,
  type MercadoLivreReplacementEntry
} from './mercadoLivreCopyPromoListHelper.js';
import {
  buildPartitionPreviewSendPlan,
  normalizePartitionNativePreviewValue
} from './partitionPreviewModeService.js';
import { waService } from './whatsappService.js';

const WORKFLOW_NAME = 'COLETADOR_2501_ORIGINAL_MONGO_SEM_IA';
const COPY_PROMO_ALLOWED_PROVIDERS: Provider[] = ['mercadolivre', 'amazon', 'shopee', 'aliexpress'];

type Provider = 'mercadolivre' | 'amazon' | 'shopee' | 'aliexpress' | 'unknown';

type ResolvedProviderUrl = {
  sourceUrl: string;
  resolvedUrl: string;
  provider: Provider;
  detectedFrom: 'source' | 'resolved';
};

type PreviewMetadataInput = {
  title?: string;
  description?: string;
  canonicalUrl?: string;
  imageUrl?: string;
  jpegThumbnail?: Buffer;
  source?: string;
};

function buildJpegDataUrl(buffer: Buffer | undefined) {
  if (!buffer?.length) return '';
  return `data:image/jpeg;base64,${buffer.toString('base64')}`;
}

type ShopeeProcessingTrace = {
  traceId: string;
  sourceMessageId: string;
  sourceGroupId: string;
  destinationGroupId: string;
  sourceUrl: string;
  resolvedUrl: string;
  selectedCouponUrl: string;
  originalIdentity: ShopeeIdentity | null;
  affiliateUrl: string;
  affiliateIdentity: ShopeeIdentity | null;
};

type MercadoLivreMessageKind =
  | 'mercadolivre_product_promotion'
  | 'mercadolivre_list_or_coupon_alert_with_source_media'
  | 'mercadolivre_list_or_coupon_alert_without_source_media'
  | 'mercadolivre_unsupported';


function firstString(...values: any[]) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function firstRawString(...values: any[]) {
  for (const value of values) {
    if (typeof value === 'string' && value.length) return value;
  }
  return '';
}

function maskCredential(value = '') {
  if (!value) return '';
  if (value.length <= 4) return `${value.slice(0, 1)}***`;
  return `${value.slice(0, 4)}${'*'.repeat(Math.min(12, Math.max(4, value.length - 4)))}`;
}

function normalizeText(payload: any) {
  const body = payload?.body || payload || {};
  const data = body.data || payload?.data || {};
  const msg = data.message || payload?.messageData || {};
  const imageMessage = msg.imageMessage || {};
  const videoMessage = msg.videoMessage || {};
  const documentMessage = msg.documentMessage || {};
  const extended = msg.extendedTextMessage || {};
  const conversation = msg.conversation || '';
  return firstString(
    payload.texto,
    payload.caption,
    payload.text,
    payload.message,
    body.texto,
    body.caption,
    body.text,
    body.message,
    imageMessage.caption,
    videoMessage.caption,
    documentMessage.caption,
    extended.text,
    conversation
  );
}

function normalizeOriginalText(payload: any) {
  const body = payload?.body || payload || {};
  const data = body.data || payload?.data || {};
  const msg = data.message || payload?.messageData || {};
  const imageMessage = msg.imageMessage || {};
  const videoMessage = msg.videoMessage || {};
  const documentMessage = msg.documentMessage || {};
  const extended = msg.extendedTextMessage || {};
  const conversation = msg.conversation || '';
  return firstRawString(
    payload.texto,
    payload.caption,
    payload.text,
    payload.message,
    body.texto,
    body.caption,
    body.text,
    body.message,
    imageMessage.caption,
    videoMessage.caption,
    documentMessage.caption,
    extended.text,
    conversation
  );
}

function normalizeImageUrl(payload: any) {
  const body = payload?.body || payload || {};
  const data = body.data || payload?.data || {};
  return firstString(
    payload.image_url,
    payload.imageUrl,
    payload.url_imagem,
    payload.imageDataUrl,
    body.image_url,
    body.imageUrl,
    body.url_imagem,
    data.image_url,
    data.imageUrl
  );
}

function normalizeSourceGroup(payload: any) {
  const body = payload?.body || payload || {};
  const data = body.data || payload?.data || {};
  const key = data.key || body.key || payload.key || {};
  const sourceGroupId = firstString(
    payload.sourceGroupId,
    payload.groupId,
    payload.remoteJid,
    body.sourceGroupId,
    body.groupId,
    body.remoteJid,
    data.sourceGroupId,
    data.groupId,
    data.remoteJid,
    key.remoteJid
  );
  const sourceGroupName = firstString(
    payload.sourceGroupName,
    payload.groupName,
    payload.pushName,
    body.sourceGroupName,
    body.groupName,
    body.pushName,
    data.sourceGroupName,
    data.groupName,
    data.pushName
  );
  const messageId = firstString(payload.messageId, body.messageId, body.keyId, data?.key?.id, key.id);
  return { sourceGroupId, sourceGroupName, messageId };
}

function expandWebhookPayloads(payload: any) {
  const body = payload?.body || payload || {};
  const data = body.data || payload?.data || {};
  const batch = [
    payload?.messages,
    body?.messages,
    data?.messages,
    payload?.items,
    body?.items,
    data?.items,
    payload?.events,
    body?.events,
    data?.events
  ].find(Array.isArray);

  if (!Array.isArray(batch) || batch.length === 0) return [payload];

  return batch.map((item: any) => {
    const itemBody = item?.body || item || {};
    const itemData = itemBody?.data || item?.data || {};
    return {
      ...payload,
      ...item,
      body: {
        ...body,
        ...itemBody,
        data: {
          ...data,
          ...itemData,
          message: itemData?.message || item?.message || data?.message
        }
      }
    };
  });
}

function extractUrls(text: string) {
  return Array.from(new Set((text.match(/https?:\/\/[^\s<>"')]+/gi) || []).map(url => url.replace(/[),.;]+$/, ''))));
}

function providerFromUrl(url: string): Provider {
  if (/mercadolivre\.com|mercadolivre\.com\.br|meli\.la/i.test(url)) return 'mercadolivre';
  if (/shopee\.com|shopee\.com\.br|s\.shopee\.com|shope\.ee/i.test(url)) return 'shopee';
  if (/aliexpress\.com|a\.aliexpress\.com|s\.click\.aliexpress\.com|ali\.pub/i.test(url)) return 'aliexpress';
  if (/amazon\.com\.br|amzn\.to|amazon\.com/i.test(url)) return 'amazon';
  return 'unknown';
}

async function resolveProviderUrl(url: string): Promise<ResolvedProviderUrl> {
  const sourceProvider = providerFromUrl(url);
  let resolvedUrl = url;

  try {
    if (sourceProvider === 'shopee') {
      const shopeeResolution = await resolveShopeeUrlForIdentity(url);
      resolvedUrl =
        shopeeResolution.canonicalUrl ||
        shopeeResolution.htmlRedirectUrl ||
        shopeeResolution.finalUrl ||
        url;
    } else {
      resolvedUrl = await expandFinalUrl(url);
    }
  } catch {}

  const resolvedProvider = providerFromUrl(resolvedUrl);
  if (resolvedProvider !== 'unknown') {
    return {
      sourceUrl: url,
      resolvedUrl,
      provider: resolvedProvider,
      detectedFrom: resolvedProvider === sourceProvider ? 'source' : 'resolved'
    };
  }

  return {
    sourceUrl: url,
    resolvedUrl,
    provider: sourceProvider,
    detectedFrom: 'source'
  };
}

function replaceLiteralAll(text: string, from: string, to: string) {
  return from ? text.split(from).join(to) : text;
}

function extractPreferredPreviewUrl(text: string, provider: Provider) {
  const urls = extractUrls(text);
  if (urls.length <= 1) return urls[0] || '';

  const lines = String(text || '').split(/\r?\n/);
  const scored = urls.map((url, index) => {
    const line = lines.find(value => value.includes(url)) || '';
    const loose = normalizeLoose(line);
    let score = 0;
    if (provider === 'shopee') {
      if (/\b(compre aqui|comprar aqui|link do produto|produto aqui|oferta aqui)\b/i.test(loose)) score += 100;
      if (/\b(resgate aqui|cupom|cupons)\b/i.test(loose)) score -= 100;
    }
    score += index;
    return { url, score };
  });

  return scored.sort((a, b) => b.score - a.score)[0]?.url || urls[0] || '';
}

function extractIncomingPreviewMetadata(payload: any): PreviewMetadataInput | null {
  const message = payload?.body?.data?.message || payload?.message || payload?.messageData || {};
  const extended = message?.extendedTextMessage || {};
  const title = firstString(extended.title);
  const description = firstRawString(extended.description);
  const canonicalUrl = firstString(extended.canonicalUrl);
  const jpegThumbnailRaw = extended.jpegThumbnail;
  const jpegThumbnail = Buffer.isBuffer(jpegThumbnailRaw)
    ? jpegThumbnailRaw
    : jpegThumbnailRaw?.buffer
      ? Buffer.from(jpegThumbnailRaw.buffer)
      : jpegThumbnailRaw
        ? Buffer.from(jpegThumbnailRaw)
        : undefined;

  if (!title && !description && !canonicalUrl && !jpegThumbnail) return null;

  return {
    title,
    description,
    canonicalUrl,
    jpegThumbnail,
    source: 'incoming-whatsapp-preview'
  };
}

function buildShopeeTraceId(messageId = '', sourceGroupId = '', sourceUrl = '') {
  return crypto
    .createHash('sha1')
    .update(`${messageId}|${sourceGroupId}|${sourceUrl}|${Date.now()}`)
    .digest('hex')
    .slice(0, 16);
}

function logShopeeTrace(event: string, payload: Record<string, any>) {
  console.info(`[CopyPromo][Shopee][${event}] ${JSON.stringify(payload)}`);
}

function logMercadoLivreTrace(event: string, payload: Record<string, any>) {
  console.info(`[CopyPromo][MercadoLivre][${event}] ${JSON.stringify(payload)}`);
}

function normalizeLoose(value = '') {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function looksLikeExternalSignature(line: string, sourceGroupName = '') {
  const raw = String(line || '');
  const loose = normalizeLoose(raw);
  if (!loose) return false;
  if (/https?:\/\/(?:t\.me|telegram\.me|telegram\.org|chat\.whatsapp\.com|whatsapp\.com\/channel)/i.test(raw)) return true;
  if (/\b(?:telegram|grupo do telegram|canal do telegram|canal de telegram)\b/i.test(loose)) return true;
  if (/\b(?:grupos?|canal|comunidade)\s+(?:de|das?|dos?)\s+(?:promos?|promocoes|ofertas|achadinhos?)\b/i.test(loose)) return true;
  if (/\b(?:promos?|promocoes|ofertas|achadinhos?)\s+(?:no|do|da|dos|das)\s+(?:telegram|whatsapp|zap)\b/i.test(loose)) return true;
  const source = normalizeLoose(sourceGroupName);
  if (source && source.length >= 8 && loose.includes(source)) return true;
  const sourceParts = String(sourceGroupName || '')
    .split(/[|>→\-–—:]+/g)
    .map(part => normalizeLoose(part))
    .filter(part => part.length >= 8);
  if (sourceParts.some(part => loose.includes(part))) return true;
  return false;
}

function cleanCopiedCaption(text: string, sourceGroupName = '') {
  const lines = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  return lines
    .filter(line => !looksLikeExternalSignature(line, sourceGroupName))
    .join('\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{5,}/g, '\n\n\n\n')
    .trim();
}

function extractCopiedProductName(message: string, fallbackUrl = '') {
  const line = String(message || '')
    .split(/\r?\n/)
    .map(value => value.trim())
    .find(value => value && !/^https?:\/\//i.test(value) && !/^cupom\s*:/i.test(value) && !/^de\s+r\$/i.test(value) && !/^por\s+/i.test(value));
  return (line || fallbackUrl || 'Promocao copiada').slice(0, 180);
}

async function expandFinalUrl(url: string) {
  const headers = {
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7'
  };
  try {
    const response = await fetch(url, { method: 'HEAD', redirect: 'follow', headers, signal: AbortSignal.timeout(8000) });
    if (response.url && response.url !== url) return response.url;
  } catch {}
  try {
    const response = await fetch(url, { method: 'GET', redirect: 'follow', headers, signal: AbortSignal.timeout(10000) });
    const html = await response.text().catch(() => '');
    const metaUrl = html.match(/<meta[^>]+http-equiv=["']refresh["'][^>]+content=["'][^"']*url=([^"']+)/i)?.[1]
      || html.match(/(?:window\.location(?:\.href)?|location\.replace)\s*=\s*["']([^"']+)/i)?.[1]
      || html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)/i)?.[1];
    if (metaUrl) return new URL(metaUrl.replace(/&amp;/g, '&'), response.url || url).toString();
    return response.url || url;
  } catch {
    return url;
  }
}

async function appendAmazonTag(url: string, tag: string) {
  if (!tag) throw Object.assign(new Error('Tag Amazon ausente no Copiar Promo.'), { errorType: 'missing_amazon_tag' });
  const finalUrl = /amzn\.to/i.test(url) ? await expandFinalUrl(url) : url;
  const asin = finalUrl.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i)?.[1];
  if (asin) return `https://www.amazon.com.br/dp/${asin}/?tag=${encodeURIComponent(tag)}`;
  const parsed = new URL(finalUrl);
  parsed.searchParams.set('tag', tag);
  return parsed.toString();
}

async function generateShopeeLinksForUser(
  userId: string,
  input: {
    sourceUrl: string;
    resolvedUrl: string;
    message: string;
    payload: any;
    traceId: string;
    sourceMessageId: string;
    sourceGroupId: string;
    destinationGroupId: string;
    selectedCouponUrl?: string;
  }
) {
  const cred = await ShopeeCredential.findOne({ userId, isActive: true }).lean() as any;
  if (!cred?.secretEncrypted) throw new Error('Credenciais Shopee ausentes ou inativas.');
  const secret = decryptSecret(cred.secretEncrypted);
  const client = createShopeeClient({ appId: cred.appId, secret, endpoint: cred.endpoint });
  const incomingPreview = extractIncomingPreviewMetadata(input.payload);
  const shopeeSourceResolution = await resolveShopeeUrlForIdentity(input.sourceUrl).catch(() => null);
  const shopeeResolvedResolution = input.resolvedUrl && input.resolvedUrl !== input.sourceUrl
    ? await resolveShopeeUrlForIdentity(input.resolvedUrl).catch(() => null)
    : null;
  const identityCandidates = [
    { label: 'source_resolution_canonical', url: shopeeSourceResolution?.canonicalUrl || '' },
    { label: 'source_resolution_redirect', url: shopeeSourceResolution?.htmlRedirectUrl || '' },
    { label: 'source_resolution_final', url: shopeeSourceResolution?.finalUrl || '' },
    { label: 'resolved_resolution_canonical', url: shopeeResolvedResolution?.canonicalUrl || '' },
    { label: 'resolved_resolution_redirect', url: shopeeResolvedResolution?.htmlRedirectUrl || '' },
    { label: 'resolved_resolution_final', url: shopeeResolvedResolution?.finalUrl || '' },
    { label: 'resolved_url', url: input.resolvedUrl },
    { label: 'source_url', url: input.sourceUrl },
    { label: 'incoming_preview', url: incomingPreview?.canonicalUrl || '' }
  ].filter(candidate => candidate.url);

  let originalIdentity: ShopeeIdentity | null = null;
  let originalIdentitySource = '';
  for (const candidate of identityCandidates) {
    const parsed = parseShopeeIdentityFromUrl(candidate.url);
    if (parsed) {
      originalIdentity = parsed;
      originalIdentitySource = candidate.label;
      break;
    }
  }

  let lookupProduct: any = null;
  if (!originalIdentity) {
    for (const candidate of identityCandidates) {
      const product = await client.lookupProductByUrl(candidate.url).catch(() => null);
      const parsed = parseShopeeIdentityFromUrl(product?.productLink || '');
      if (product && parsed) {
        originalIdentity = parsed;
        originalIdentitySource = `lookup:${candidate.label}`;
        lookupProduct = product;
        break;
      }
    }
  }

  if (!originalIdentity) {
    logShopeeTrace('abort', {
      traceId: input.traceId,
      reason: 'source_identity_unverified',
      sourceMessageId: input.sourceMessageId,
      sourceGroupId: input.sourceGroupId,
      sourceUrl: input.sourceUrl,
      resolvedUrl: input.resolvedUrl
    });
    throw new Error('Shopee nao permitiu confirmar o produto original desta promocao.');
  }

  const previewProduct = lookupProduct || await client.getProductByIdentity(originalIdentity.shopId, originalIdentity.itemId).catch(() => null);
  if (!previewProduct?.productLink) {
    throw new Error('Shopee nao retornou os dados do produto original para esta promocao.');
  }

  const productIdentity = parseShopeeIdentityFromUrl(previewProduct.productLink || buildShopeeCanonicalProductUrl(originalIdentity));
  assertShopeeIdentityMatch(originalIdentity, productIdentity, 'source_product_verification');

  const affiliateUrl = previewProduct.offerLink || await client.generateShortLink(previewProduct.productLink).catch(() => null);
  if (!affiliateUrl) {
    throw new Error('Shopee nao retornou link afiliado para esta promocao.');
  }

  const affiliateIdentity = parseShopeeIdentityFromUrl(affiliateUrl) || productIdentity;
  assertShopeeIdentityMatch(originalIdentity, affiliateIdentity, 'affiliate_product_verification');

  const previewMetadata: PreviewMetadataInput | undefined = {
    title: previewProduct.productName || incomingPreview?.title || '',
    description: incomingPreview?.description || '',
    canonicalUrl: previewProduct.productLink || originalIdentity.canonicalUrl,
    imageUrl: previewProduct.imageUrl || '',
    jpegThumbnail: incomingPreview?.jpegThumbnail,
    source: previewProduct.imageUrl ? 'shopee-api-product' : incomingPreview?.source || 'shopee-fallback'
  };

  const trace: ShopeeProcessingTrace = {
    traceId: input.traceId,
    sourceMessageId: input.sourceMessageId,
    sourceGroupId: input.sourceGroupId,
    destinationGroupId: input.destinationGroupId,
    sourceUrl: input.sourceUrl,
    resolvedUrl: input.resolvedUrl,
    selectedCouponUrl: input.selectedCouponUrl || '',
    originalIdentity,
    affiliateUrl,
    affiliateIdentity
  };

  logShopeeTrace('validated', {
    traceId: trace.traceId,
    sourceMessageId: trace.sourceMessageId,
    sourceGroupId: trace.sourceGroupId,
    destinationGroupId: trace.destinationGroupId,
    sourceUrl: trace.sourceUrl,
    resolvedUrl: trace.resolvedUrl,
    sourceResolvedFinalUrl: shopeeSourceResolution?.finalUrl || '',
    sourceResolvedCanonicalUrl: shopeeSourceResolution?.canonicalUrl || '',
    resolvedResolvedFinalUrl: shopeeResolvedResolution?.finalUrl || '',
    resolvedResolvedCanonicalUrl: shopeeResolvedResolution?.canonicalUrl || '',
    selectedCouponUrl: trace.selectedCouponUrl,
    originalItemId: trace.originalIdentity?.itemId,
    originalShopId: trace.originalIdentity?.shopId,
    originalIdentitySource,
    canonicalProductUrl: previewProduct.productLink,
    affiliateUrl: trace.affiliateUrl,
    affiliateItemId: trace.affiliateIdentity?.itemId,
    affiliateShopId: trace.affiliateIdentity?.shopId,
    previewTitle: previewMetadata.title
  });

  return {
    affiliateUrl,
    previewUrl: previewProduct.productLink || originalIdentity.canonicalUrl,
    previewMetadata,
    trace
  };
}

class CopyPromoService {
  private indexesChecked = false;
  private readonly recentlyProcessedMessages = new Map<string, number>();
  private readonly recentProcessingTtlMs = 10 * 60 * 1000;

  private cleanupRecentProcessing(now = Date.now()) {
    for (const [key, expiresAt] of this.recentlyProcessedMessages.entries()) {
      if (expiresAt <= now) {
        this.recentlyProcessedMessages.delete(key);
      }
    }
  }

  private buildProcessingKey(input: {
    userId: string;
    sourceGroupId: string;
    messageId?: string;
    targetGroupId: string;
    text?: string;
    originalUrl?: string;
  }) {
    const normalizedMessageId = String(input.messageId || '').trim();
    const normalizedTargetGroupId = String(input.targetGroupId || '').trim();
    const normalizedSourceGroupId = String(input.sourceGroupId || '').trim();
    const base = normalizedMessageId
      ? normalizedMessageId
      : crypto
          .createHash('sha1')
          .update(`${normalizedSourceGroupId}|${String(input.originalUrl || '').trim()}|${String(input.text || '').trim().slice(0, 500)}`)
          .digest('hex');
    return `${String(input.userId)}|${normalizedTargetGroupId}|${normalizedSourceGroupId}|${base}`;
  }

  private reserveProcessingKey(key: string) {
    const now = Date.now();
    this.cleanupRecentProcessing(now);
    const existing = this.recentlyProcessedMessages.get(key);
    if (existing && existing > now) {
      return false;
    }
    this.recentlyProcessedMessages.set(key, now + this.recentProcessingTtlMs);
    return true;
  }

  private async ensureMultiConfigIndexes() {
    if (this.indexesChecked) return;
    this.indexesChecked = true;
    try {
      const collection = CopyPromoConfig.collection;
      const indexes = await collection.indexes();
      const legacy = indexes.find((idx: any) => idx.name === 'userId_1' && idx.unique);
      if (legacy) await collection.dropIndex('userId_1');
    } catch (error: any) {
      console.warn('[CopyPromo] Nao foi possivel ajustar indice legado userId_1:', error?.message || error);
    }
  }

  private sanitizeConfig(cfg: any) {
    return {
      ...cfg,
      amazonTagEncrypted: undefined,
      webhookPath: `/api/copy-promo/webhook/${cfg.webhookToken}`,
      workflowSource: WORKFLOW_NAME
    };
  }

  async listConfigs(userId: string) {
    await this.ensureMultiConfigIndexes();
    const configs = await CopyPromoConfig.find({ userId }).populate('targetGroupId').sort({ createdAt: 1 }).lean() as any[];
    if (configs.length === 0) {
      await CopyPromoConfig.create({ userId, webhookToken: crypto.randomUUID(), isActive: false, name: 'Copiar Promo 1' });
      return this.listConfigs(userId);
    }
    return configs.map(cfg => this.sanitizeConfig(cfg));
  }

  async getConfig(userId: string, configId?: string) {
    await this.ensureMultiConfigIndexes();
    let cfg = configId
      ? await CopyPromoConfig.findOne({ _id: configId, userId }).populate('targetGroupId').lean() as any
      : await CopyPromoConfig.findOne({ userId }).populate('targetGroupId').sort({ createdAt: 1 }).lean() as any;
    if (!cfg) {
      const created = await CopyPromoConfig.create({ userId, webhookToken: crypto.randomUUID(), isActive: false, name: 'Copiar Promo 1' });
      cfg = await CopyPromoConfig.findById(created._id).populate('targetGroupId').lean();
    }
    return this.sanitizeConfig(cfg);
  }

  async saveConfig(userId: string, body: any, configId?: string) {
    await this.ensureMultiConfigIndexes();
    const update: any = {
      name: String(body.name || '').trim() || 'Copiar Promo',
      sourceGroupId: String(body.sourceGroupId || '').trim(),
      sourceGroupName: String(body.sourceGroupName || '').trim(),
      targetGroupId: body.targetGroupId || null,
      isActive: !!body.isActive,
      updatedAt: new Date()
    };
    let saved: any;
    if (configId) {
      saved = await CopyPromoConfig.findOneAndUpdate(
        { _id: configId, userId },
        { $set: update },
        { new: true }
      );
    } else {
      saved = await CopyPromoConfig.create({
        userId,
        webhookToken: crypto.randomUUID(),
        createdAt: new Date(),
        ...update
      });
    }
    if (!saved) throw new Error('Automacao Copiar Promo nao encontrada.');
    return this.getConfig(userId, String(saved._id));
  }

  async rotateWebhook(userId: string, configId: string) {
    await this.ensureMultiConfigIndexes();
    await CopyPromoConfig.updateOne({ _id: configId, userId }, { $set: { webhookToken: crypto.randomUUID(), updatedAt: new Date() } }, { upsert: false });
    return this.getConfig(userId, configId);
  }

  async deleteConfig(userId: string, configId: string) {
    await this.ensureMultiConfigIndexes();
    await CopyPromoConfig.deleteOne({ _id: configId, userId });
    return { success: true };
  }

  async getLogs(userId: string, limit = 20) {
    return CopyPromoLog.find({ userId }).sort({ createdAt: -1 }).limit(Math.min(100, Math.max(1, limit))).lean();
  }

  async hasActiveSourceConfig(userId: string, sourceGroupId: string) {
    if (!userId || !sourceGroupId) return false;
    await this.ensureMultiConfigIndexes();
    return !!await CopyPromoConfig.exists({ userId, isActive: true, sourceGroupId });
  }

  async handleWebhook(token: string, payload: any) {
    const cfg = await CopyPromoConfig.findOne({ webhookToken: token }).lean() as any;
    if (!cfg || !cfg.isActive) return { success: false, skipped: true, reason: 'copy_promo_inactive_or_invalid_token' };
    const payloads = expandWebhookPayloads(payload);
    if (payloads.length === 1) return this.processConfig(cfg, payloads[0]);
    const results = [];
    for (const item of payloads) {
      results.push(await this.processConfig(cfg, item));
    }
    return {
      success: results.some((result: any) => result?.success),
      sent: results.reduce((sum: number, result: any) => sum + Number(result?.sent || 0), 0),
      processedMessages: results.length,
      results
    };
  }

  async handleIncomingWhatsAppMessage(userId: string, payload: any) {
    const { sourceGroupId } = normalizeSourceGroup(payload);
    if (!sourceGroupId) return { success: true, skipped: true, reason: 'missing_source_group_id' };
    await this.ensureMultiConfigIndexes();
    const configs = await CopyPromoConfig.find({ userId, isActive: true, sourceGroupId }).lean() as any[];
    if (configs.length === 0) return { success: true, skipped: true, reason: 'copy_promo_not_configured_for_group' };
    const results = [];
    for (const cfg of configs) {
      results.push(await this.processConfig(cfg, payload));
    }
    return {
      success: results.some((result: any) => result?.success),
      sent: results.reduce((sum: number, result: any) => sum + Number(result?.sent || 0), 0),
      processedConfigs: results.length,
      results
    };
  }

  private async processConfig(cfg: any, payload: any) {
    const userId = String(cfg.userId);
    const { sourceGroupId, sourceGroupName, messageId } = normalizeSourceGroup(payload);
    if (cfg.sourceGroupId && sourceGroupId !== cfg.sourceGroupId) {
      await this.bump(cfg._id, 'skipped', 'source_group_mismatch');
      return { success: true, skipped: true, reason: sourceGroupId ? 'source_group_mismatch' : 'missing_source_group_id' };
    }

    const targetGroup = await UserGroup.findOne({ _id: cfg.targetGroupId, userId, isActive: true }).lean() as any;
    if (!targetGroup) {
      await this.record(cfg, { sourceGroupId, sourceGroupName, status: 'failed', error: 'target_group_not_found', rawMessageId: messageId });
      await this.bump(cfg._id, 'error', 'target_group_not_found');
      return { success: false, error: 'Particao de destino nao encontrada ou inativa.' };
    }

    const text = normalizeOriginalText(payload) || normalizeText(payload);
    const processingKey = this.buildProcessingKey({
      userId,
      sourceGroupId,
      messageId,
      targetGroupId: String(cfg.targetGroupId || targetGroup._id || ''),
      text
    });
    if (!this.reserveProcessingKey(processingKey)) {
      await this.record(cfg, {
        sourceGroupId,
        sourceGroupName,
        targetGroupId: targetGroup._id,
        provider: 'unknown',
        originalUrl: '',
        affiliateUrl: '',
        status: 'skipped',
        error: 'duplicate_message_suppressed',
        rawMessageId: messageId,
        extractionSource: 'original',
        messagePreview: text.slice(0, 300)
      });
      return { success: true, skipped: true, reason: 'duplicate_message_suppressed' };
    }
    const imageUrlPromise = payload?.imageUrlPromise;
    const sourceVisualImageUrlPromise = payload?.sourceVisualImageUrlPromise;
    let imageUrl = normalizeImageUrl(payload);
    const orderedUrls = extractUrls(text);
    const resolvedUrls: ResolvedProviderUrl[] = [];
    for (const url of orderedUrls) {
      resolvedUrls.push(await resolveProviderUrl(url));
    }

    const allowedResolvedUrls = resolvedUrls.filter(item => COPY_PROMO_ALLOWED_PROVIDERS.includes(item.provider));
    const originalResolvedUrl = allowedResolvedUrls[0];
    const originalUrl = originalResolvedUrl?.sourceUrl || '';
    if (!originalUrl) {
      await this.record(cfg, {
        sourceGroupId,
        sourceGroupName,
        targetGroupId: targetGroup._id,
        provider: providerFromUrl(orderedUrls[0] || ''),
        originalUrl: orderedUrls[0] || '',
        status: 'skipped',
        error: orderedUrls.length ? 'no_allowed_provider_url' : 'no_url_found',
        rawMessageId: messageId,
        extractionSource: 'original',
        messagePreview: text.slice(0, 300)
      });
      await this.bump(cfg._id, 'skipped', orderedUrls.length ? 'no_allowed_provider_url' : 'no_url_found');
      return { success: true, skipped: true, reason: orderedUrls.length ? 'no_allowed_provider_url' : 'no_url_found' };
    }

    const provider = originalResolvedUrl.provider;
    const affiliateByOriginal = new Map<string, string>();
    const previewUrlByOriginal = new Map<string, string>();
    const previewMetadataByOriginal = new Map<string, PreviewMetadataInput>();
    const mercadoLivreClassifications = new Map<string, MercadoLivreUrlClassification>();
    const mercadoLivreReplacementEntries: MercadoLivreReplacementEntry[] = [];
    const hasMercadoLivreUrls = allowedResolvedUrls.some(item => item.provider === 'mercadolivre');
    const mercadoLivreReplacementConfig = hasMercadoLivreUrls
      ? await mercadoLivreN8nJsonService.getListReplacementConfig(userId)
      : null;
    const mercadoLivreCredentialDiagnostics = hasMercadoLivreUrls
      ? await mercadoLivreN8nJsonService.getCredentialDiagnostics(userId).catch(() => null)
      : null;
    const incomingPreview = extractIncomingPreviewMetadata(payload);
    const shopeeResolvedUrls = allowedResolvedUrls.filter(item => item.provider === 'shopee');
    const shopeeSelection = selectShopeeProductCandidate(
      text,
      shopeeResolvedUrls.map(item => ({ sourceUrl: item.sourceUrl, resolvedUrl: item.resolvedUrl })),
      incomingPreview?.canonicalUrl || ''
    );
    const shopeeSelectedProductUrl = shopeeSelection.selectedProduct?.sourceUrl || '';
    const shopeeSelectedCouponUrl = shopeeSelection.selectedCoupon?.sourceUrl || '';
    const traceId = provider === 'shopee'
      ? buildShopeeTraceId(messageId, sourceGroupId, shopeeSelectedProductUrl || originalUrl)
      : '';

    if (provider === 'shopee') {
      logShopeeTrace('classified_urls', {
        traceId,
        sourceMessageId: messageId,
        sourceGroupId,
        destinationGroupId: String(targetGroup._id),
        classified: shopeeSelection.classified.map(item => ({
          sourceUrl: item.sourceUrl,
          resolvedUrl: item.resolvedUrl,
          role: item.role,
          score: item.score,
          itemId: item.identity?.itemId || '',
          shopId: item.identity?.shopId || '',
          reasons: item.reasons
        })),
        selectedProductUrl: shopeeSelectedProductUrl,
        selectedCouponUrl: shopeeSelectedCouponUrl,
        reason: shopeeSelection.reason || 'ok'
      });
      if (!shopeeSelectedProductUrl) {
        const reason = shopeeSelection.reason || 'shopee_product_url_not_verified';
        await this.record(cfg, {
          sourceGroupId,
          sourceGroupName,
          targetGroupId: targetGroup._id,
          provider,
          originalUrl,
          status: 'skipped',
          error: reason,
          rawMessageId: messageId,
          extractionSource: 'original',
          messagePreview: text.slice(0, 300)
        });
        await this.bump(cfg._id, 'skipped', reason);
        return { success: true, skipped: true, reason, provider };
      }
    }

    try {
      for (const item of allowedResolvedUrls) {
        const url = item.sourceUrl;
        const resolvedUrl = item.resolvedUrl || url;
        const urlProvider = item.provider;
        if (urlProvider === 'mercadolivre') {
          const inspection = await mercadoLivreN8nJsonService.inspectCopyPromoIncomingUrl(url);
          const classification = inspection.finalClassification;
          mercadoLivreClassifications.set(url, classification);

          let finalMercadoLivreUrl = url;
          let affiliateResolvedProductUrl = '';
          let affiliateItemId = '';
          let affiliateServiceCalled = false;
          let affiliateSkipReason = '';
          if (classification.urlType === 'product') {
            affiliateServiceCalled = true;
            finalMercadoLivreUrl = await mercadoLivreN8nJsonService.generateAffiliateLinkForUrl(userId, inspection.affiliateInputUrl);
            affiliateResolvedProductUrl = await mercadoLivreN8nJsonService.resolveProductUrlFromShareLink(finalMercadoLivreUrl).catch(() => finalMercadoLivreUrl);
            affiliateItemId = extractMercadoLivreItemId(affiliateResolvedProductUrl);
            const originalItemId = classification.itemId || inspection.affiliateInputItemId || extractMercadoLivreItemId(inspection.affiliateInputUrl);
            if (originalItemId && affiliateItemId && originalItemId !== affiliateItemId) {
              throw Object.assign(
                new Error(`Link afiliado do Mercado Livre retornou produto diferente. Esperado ${originalItemId}, recebido ${affiliateItemId}.`),
                { errorType: 'mercadolivre_affiliate_product_identity_mismatch' }
              );
            }
            if (!finalMercadoLivreUrl || finalMercadoLivreUrl === url || finalMercadoLivreUrl === inspection.affiliateInputUrl) {
              throw Object.assign(
                new Error('Link afiliado do Mercado Livre nao substituiu a URL original da promocao.'),
                { errorType: 'mercadolivre_affiliate_link_not_replaced' }
              );
            }
          } else if (classification.urlType === 'list') {
            if (!mercadoLivreReplacementConfig?.configuredReplacementListUrl) {
              throw Object.assign(
                new Error('Link da lista do Mercado Livre nao configurado para mensagens de lista/cupom.'),
                { errorType: 'missing_mercadolivre_list_url_config' }
              );
            }
            finalMercadoLivreUrl = mercadoLivreReplacementConfig.configuredReplacementListUrl;
            affiliateSkipReason = 'list_message_uses_configured_list_url';
          } else {
            affiliateSkipReason = `mercadolivre_${classification.urlType}_url_skipped`;
          }

          affiliateByOriginal.set(url, finalMercadoLivreUrl);
          mercadoLivreReplacementEntries.push({
            sourceUrl: url,
            incomingUrlType: classification.urlType,
            finalUrl: finalMercadoLivreUrl,
            itemId: classification.itemId
          });
          logMercadoLivreTrace('url_classified', {
            sourceMessageId: messageId,
            sourceGroupId,
            destinationGroupId: String(targetGroup._id),
            credentialSource: mercadoLivreCredentialDiagnostics?.credentialSource || 'unknown',
            hasAffiliateTag: !!mercadoLivreCredentialDiagnostics?.hasAffiliateTag,
            hasCookie: !!mercadoLivreCredentialDiagnostics?.hasCookie,
            incomingSourceUrl: classification.incomingSourceUrl,
            normalizedIncomingUrl: classification.normalizedIncomingUrl,
            resolvedUrl: classification.resolvedUrl,
            canonicalUrl: classification.canonicalUrl,
            redirectChain: classification.redirectChain,
            classificationSource: inspection.classificationSource,
            affiliateInputUrl: inspection.affiliateInputUrl,
            incomingUrlType: classification.urlType,
            confidence: classification.confidence,
            evidence: classification.evidence,
            visibleSignals: classification.visibleSignals,
            resolvedSignals: classification.resolvedSignals,
            failureReason: classification.failureReason || '',
            transientFailure: !!classification.transientFailure,
            affiliateServiceCalled,
            affiliateSkipReason,
            affiliateResolvedProductUrl,
            originalItemId: classification.itemId || inspection.affiliateInputItemId || '',
            affiliateItemId,
            configuredReplacementListUrlFound: !!mercadoLivreReplacementConfig?.configuredReplacementListUrl,
            finalUrl: finalMercadoLivreUrl
          });
        } else if (urlProvider === 'shopee') {
          if (url !== shopeeSelectedProductUrl) {
            affiliateByOriginal.set(url, url);
            continue;
          }
          const shopeeLinks = await generateShopeeLinksForUser(userId, {
            sourceUrl: url,
            resolvedUrl,
            message: text,
            payload,
            traceId,
            sourceMessageId: messageId,
            sourceGroupId,
            destinationGroupId: String(targetGroup._id),
            selectedCouponUrl: shopeeSelectedCouponUrl
          });
          affiliateByOriginal.set(url, shopeeLinks.affiliateUrl);
          if (shopeeLinks.previewUrl) {
            previewUrlByOriginal.set(url, shopeeLinks.previewUrl);
          }
          if (shopeeLinks.previewMetadata) {
            previewMetadataByOriginal.set(url, shopeeLinks.previewMetadata);
          }
        } else if (urlProvider === 'aliexpress') {
          affiliateByOriginal.set(url, await aliexpressAffiliateService.generateAffiliateLinkForUser(userId, resolvedUrl));
        } else if (urlProvider === 'amazon') {
          affiliateByOriginal.set(url, await amazonAffiliateService.generateAffiliateLinkForUser(userId, resolvedUrl, extractCopiedProductName(text, url)));
          const creds = await amazonAffiliateService.loadCredentialsForUser(userId);
          if (creds?.affiliateTag) {
            previewUrlByOriginal.set(url, buildAmazonTaggedUrl(resolvedUrl, creds.affiliateTag));
          }
        }
      }
    } catch (error: any) {
      await this.record(cfg, {
        sourceGroupId,
        sourceGroupName,
        targetGroupId: targetGroup._id,
        provider,
        originalUrl,
        status: 'failed',
        error: error.message,
        rawMessageId: messageId,
        extractionSource: 'original',
        messagePreview: text.slice(0, 300)
      });
      await this.bump(cfg._id, 'error', error.message);
      return { success: false, error: error.message, provider };
    }

    const mercadoLivreClassificationList = Array.from(mercadoLivreClassifications.values());
    const hasMercadoLivreList = mercadoLivreClassificationList.some(item => item.urlType === 'list');
    const hasMercadoLivreProduct = mercadoLivreClassificationList.some(item => item.urlType === 'product');
    const hasMercadoLivreOnlyList = hasMercadoLivreList && !hasMercadoLivreProduct;
    const orderedMercadoLivreProductUrls = orderedUrls.filter(url => mercadoLivreClassifications.get(url)?.urlType === 'product');
    const orderedMercadoLivreListUrls = orderedUrls.filter(url => mercadoLivreClassifications.get(url)?.urlType === 'list');
    const orderedMercadoLivreUnknownUrls = orderedUrls.filter(url => mercadoLivreClassifications.get(url)?.urlType === 'unknown');
    const primaryMercadoLivreProductUrl = orderedMercadoLivreProductUrls[0] || '';
    const primaryMercadoLivreListUrl = orderedMercadoLivreListUrls[0] || '';

    let message = text;
    for (const url of orderedUrls) {
      const affiliateUrlForOriginal = affiliateByOriginal.get(url);
      message = replaceLiteralAll(message, url, affiliateUrlForOriginal || url);
    }
    message = cleanCopiedCaption(message, sourceGroupName || cfg.sourceGroupName || '');
    const affiliateUrl = provider === 'mercadolivre'
      ? (primaryMercadoLivreProductUrl
        ? affiliateByOriginal.get(primaryMercadoLivreProductUrl) || ''
        : primaryMercadoLivreListUrl
          ? affiliateByOriginal.get(primaryMercadoLivreListUrl) || ''
          : '')
      : affiliateByOriginal.get(originalUrl) || originalUrl || '';
    const mercadoLivreSafety = validateMercadoLivreReplacementSafety({
      classifications: mercadoLivreClassificationList,
      replacements: mercadoLivreReplacementEntries,
      configuredReplacementListUrl: mercadoLivreReplacementConfig?.configuredReplacementListUrl || '',
      finalMessage: message
    });
    if (!mercadoLivreSafety.ok) {
      const error = mercadoLivreSafety.error || 'mercadolivre_replacement_safety_failed';
      logMercadoLivreTrace('safety_failed', {
        sourceMessageId: messageId,
        sourceGroupId,
        destinationGroupId: String(targetGroup._id),
        error,
        urlsExtracted: orderedUrls,
        classifications: mercadoLivreClassificationList.map(item => ({
          incomingSourceUrl: item.incomingSourceUrl,
          urlType: item.urlType,
          canonicalUrl: item.canonicalUrl
        })),
        configuredReplacementListUrl: mercadoLivreReplacementConfig?.configuredReplacementListUrl || ''
      });
      await this.record(cfg, {
        sourceGroupId,
        sourceGroupName,
        targetGroupId: targetGroup._id,
        provider,
        originalUrl,
        affiliateUrl,
        status: 'failed',
        error,
        rawMessageId: messageId,
        extractionSource: 'original',
        messagePreview: message.slice(0, 300)
      });
      await this.bump(cfg._id, 'error', error);
      return { success: false, error, provider };
    }

    if (provider === 'mercadolivre' && !primaryMercadoLivreProductUrl && !primaryMercadoLivreListUrl && mercadoLivreClassificationList.length > 0) {
      const primaryUnknown = mercadoLivreClassificationList.find(item => item.urlType === 'unknown');
      const error = primaryUnknown?.failureReason || 'mercadolivre_url_not_classified_as_product_or_list';
      logMercadoLivreTrace('classification_blocked_send', {
        sourceMessageId: messageId,
        sourceGroupId,
        destinationGroupId: String(targetGroup._id),
        reason: error,
        unknownUrls: orderedMercadoLivreUnknownUrls,
        classifications: mercadoLivreClassificationList.map(item => ({
          incomingSourceUrl: item.incomingSourceUrl,
          incomingUrlType: item.urlType,
          confidence: item.confidence,
          evidence: item.evidence,
          canonicalUrl: item.canonicalUrl,
          resolvedUrl: item.resolvedUrl,
          redirectChain: item.redirectChain,
          failureReason: item.failureReason || '',
          transientFailure: !!item.transientFailure
        }))
      });
      await this.record(cfg, {
        sourceGroupId,
        sourceGroupName,
        targetGroupId: targetGroup._id,
        provider,
        originalUrl,
        affiliateUrl,
        status: 'skipped',
        error,
        rawMessageId: messageId,
        extractionSource: 'original',
        messagePreview: message.slice(0, 300)
      });
      await this.bump(cfg._id, 'skipped', error);
      return { success: true, skipped: true, reason: error, provider };
    }

    const preferredPreviewSourceUrl = provider === 'mercadolivre'
      ? primaryMercadoLivreProductUrl || extractPreferredPreviewUrl(text, provider) || originalUrl
      : extractPreferredPreviewUrl(text, provider) || originalUrl;
    const preferredPreviewVisibleUrl = affiliateByOriginal.get(preferredPreviewSourceUrl) || preferredPreviewSourceUrl || affiliateUrl;
    const previewUrlOverride = hasMercadoLivreOnlyList
      ? ''
      : previewUrlByOriginal.get(preferredPreviewSourceUrl) || previewUrlByOriginal.get(originalUrl) || '';
    const previewMetadataOverride = hasMercadoLivreOnlyList
      ? undefined
      : previewMetadataByOriginal.get(preferredPreviewSourceUrl) || previewMetadataByOriginal.get(originalUrl);
    const mercadoLivreOriginalProductStillPresent = orderedMercadoLivreProductUrls.filter(url => message.includes(url));
    if (
      !message
      || !affiliateUrl
      || !message.includes(affiliateUrl)
      || (provider === 'mercadolivre' && primaryMercadoLivreProductUrl && (
        affiliateUrl === primaryMercadoLivreProductUrl
        || mercadoLivreOriginalProductStillPresent.length > 0
      ))
    ) {
      const error = 'message_without_valid_affiliate_link';
      logMercadoLivreTrace('message_validation_failed', {
        sourceMessageId: messageId,
        sourceGroupId,
        destinationGroupId: String(targetGroup._id),
        reason: error,
        primaryMercadoLivreProductUrl,
        affiliateUrl,
        originalSourceUrlRemains: mercadoLivreOriginalProductStillPresent,
        messageContainsAffiliateUrl: !!affiliateUrl && message.includes(affiliateUrl)
      });
      await this.record(cfg, {
        sourceGroupId,
        sourceGroupName,
        targetGroupId: targetGroup._id,
        provider,
        originalUrl,
        affiliateUrl,
        status: 'skipped',
        error,
        rawMessageId: messageId,
        extractionSource: 'original',
        messagePreview: message.slice(0, 300)
      });
      await this.bump(cfg._id, 'skipped', error);
      return { success: true, skipped: true, reason: error, provider };
    }

    if (!imageUrl && imageUrlPromise && typeof imageUrlPromise.then === 'function') {
      imageUrl = await imageUrlPromise.catch(() => '');
    }

    const nativePreviewEnabled = normalizePartitionNativePreviewValue(targetGroup.useNativeLinkPreview, false);
    const preserveSourceImageInNativePreview = normalizePartitionNativePreviewValue(targetGroup.preserveSourceImageInNativePreview, false);
    let recoveredSourceVisualImageUrl = '';
    if (nativePreviewEnabled && preserveSourceImageInNativePreview) {
      if (sourceVisualImageUrlPromise && typeof sourceVisualImageUrlPromise.then === 'function') {
        recoveredSourceVisualImageUrl = await sourceVisualImageUrlPromise.catch(() => '');
      }
      if (!recoveredSourceVisualImageUrl && imageUrl) {
        recoveredSourceVisualImageUrl = imageUrl;
      }
      if (!recoveredSourceVisualImageUrl && incomingPreview?.jpegThumbnail) {
        recoveredSourceVisualImageUrl = buildJpegDataUrl(incomingPreview.jpegThumbnail);
      }
    }

    const sourceContainsMedia = !!imageUrl;
    let mercadoLivreMessageKind: MercadoLivreMessageKind = 'mercadolivre_unsupported';
    if (provider === 'mercadolivre') {
      if (hasMercadoLivreOnlyList) {
        mercadoLivreMessageKind = sourceContainsMedia
          ? 'mercadolivre_list_or_coupon_alert_with_source_media'
          : 'mercadolivre_list_or_coupon_alert_without_source_media';
      } else if (hasMercadoLivreProduct) {
        mercadoLivreMessageKind = 'mercadolivre_product_promotion';
      }
    }

    let usedCredentialCouponAlertImage = false;
    if (hasMercadoLivreOnlyList && !sourceContainsMedia && mercadoLivreReplacementConfig?.couponAlertImageUrl) {
      imageUrl = mercadoLivreReplacementConfig.couponAlertImageUrl;
      usedCredentialCouponAlertImage = true;
    }
    if (hasMercadoLivreOnlyList && !sourceContainsMedia && !imageUrl) {
      logMercadoLivreTrace('missing_coupon_alert_image_fallback', {
        sourceMessageId: messageId,
        sourceGroupId,
        destinationGroupId: String(targetGroup._id),
        reason: 'sending_text_without_native_preview',
        configuredReplacementListUrlFound: !!mercadoLivreReplacementConfig?.configuredReplacementListUrl
      });
    }

    if (hasMercadoLivreUrls) {
      logMercadoLivreTrace('message_routing', {
        sourceMessageId: messageId,
        sourceGroupId,
        destinationGroupId: String(targetGroup._id),
        destinationPartitionName: targetGroup.groupName || '',
        urlsExtracted: orderedUrls,
        classifications: mercadoLivreClassificationList.map(item => ({
          incomingSourceUrl: item.incomingSourceUrl,
          incomingUrlType: item.urlType,
          canonicalUrl: item.canonicalUrl,
          redirectUrl: item.redirectUrl
        })),
        configuredReplacementListUrlFound: !!mercadoLivreReplacementConfig?.configuredReplacementListUrl,
        replacedListUrlCount: mercadoLivreReplacementEntries.filter(item => item.incomingUrlType === 'list' && item.finalUrl !== item.sourceUrl).length,
        preservedProductUrlCount: mercadoLivreReplacementEntries.filter(item => item.incomingUrlType === 'product').length,
        selectedProductUrl: primaryMercadoLivreProductUrl,
        selectedListUrl: primaryMercadoLivreListUrl,
        unknownMercadoLivreUrlCount: orderedMercadoLivreUnknownUrls.length,
        finalOutgoingProductUrl: primaryMercadoLivreProductUrl ? (affiliateByOriginal.get(primaryMercadoLivreProductUrl) || '') : '',
        originalSourceUrlStillPresent: mercadoLivreOriginalProductStillPresent.length > 0,
        sourceContainsMedia,
        preservedOriginalSourceImage: hasMercadoLivreOnlyList && sourceContainsMedia,
        usedCredentialCouponAlertImage,
        nativePreviewDisabled: hasMercadoLivreOnlyList,
        finalSendingMode: imageUrl ? 'image' : 'text',
        messageKind: mercadoLivreMessageKind,
        finalSafetyResult: 'ok'
      });
    }

    const effectivePreviewMetadataOverride = !hasMercadoLivreOnlyList
      ? (() => {
          const effectiveImageUrlForPreview = recoveredSourceVisualImageUrl
            || previewMetadataOverride?.imageUrl
            || imageUrl
            || undefined;
          const override = {
            ...(previewMetadataOverride || {}),
            ...(effectiveImageUrlForPreview
              ? {
                  imageUrl: effectiveImageUrlForPreview,
                  jpegThumbnail: previewMetadataOverride?.jpegThumbnail || incomingPreview?.jpegThumbnail,
                  source: recoveredSourceVisualImageUrl
                    ? 'source-message-visual-image'
                    : (previewMetadataOverride?.source || incomingPreview?.source || 'product-image-fallback')
                }
              : {})
          };
          return Object.keys(override).length ? override : undefined;
        })()
      : undefined;
    const sourcePreviewImageFallbackReason = nativePreviewEnabled && preserveSourceImageInNativePreview && !recoveredSourceVisualImageUrl
      ? (effectivePreviewMetadataOverride?.imageUrl ? 'source_image_unavailable_fallback_to_product_image' : 'source_image_unavailable_fallback_to_preview_without_custom_image')
      : '';

    const destinations: string[] = Array.from(new Set(
      (targetGroup.groupIdentifiers?.length ? targetGroup.groupIdentifiers : [targetGroup.groupIdentifier])
        .filter(Boolean)
        .map((value: any) => String(value).trim())
        .filter(Boolean)
    ));
    const partitionSendPlan = buildPartitionPreviewSendPlan({
      featureSource: 'copy_promo',
      useNativeLinkPreview: nativePreviewEnabled,
      useSourceImageForNativePreview: nativePreviewEnabled && preserveSourceImageInNativePreview && !!recoveredSourceVisualImageUrl,
      preferNativePreviewWithoutImage: true,
      messageText: message,
      affiliateUrl,
      imageUrl,
      previewUrlOverride: !hasMercadoLivreOnlyList ? (previewUrlOverride || undefined) : undefined,
      previewVisibleUrlOverride: !hasMercadoLivreOnlyList ? (preferredPreviewVisibleUrl || affiliateUrl) : affiliateUrl,
      previewSuppressDescription: true,
      previewMetadataOverride: effectivePreviewMetadataOverride,
      blockNativePreview: hasMercadoLivreOnlyList
    });
    console.info('[CopyPromo][PartitionMode]', JSON.stringify({
      userId,
      partitionId: String(targetGroup._id),
      partitionName: targetGroup.groupName || '',
      featureSource: 'copy_promo',
      sourceMessageId: messageId,
      provider,
      useNativeLinkPreview: nativePreviewEnabled,
      preserveSourceImageInNativePreview,
      normalizedUseNativeLinkPreview: nativePreviewEnabled,
      normalizedPreserveSourceImageMode: preserveSourceImageInNativePreview,
      selectedSendingMode: partitionSendPlan.selectedMode,
      fallbackMode: partitionSendPlan.fallbackMode,
      photoAvailable: !!imageUrl,
      photoPayloadCreated: !!partitionSendPlan.imageUrlToSend,
      nativePreviewPayloadCreated: !!partitionSendPlan.waOptions.preferLinkPreview,
      sourceVisualImageRecovered: !!recoveredSourceVisualImageUrl,
      sourceImageMessageFallbackReason: sourcePreviewImageFallbackReason,
      affiliateUrl
    }));
    let sent = 0;
    let lastError = '';
    const sendModes: string[] = [];
    for (const jid of destinations) {
      try {
        const sendResult = await waService.sendMessage(
          userId,
          jid,
          message,
          partitionSendPlan.imageUrlToSend,
          partitionSendPlan.waOptions
        );
        sendModes.push(sendResult.mode);
        console.info('[CopyPromo][PartitionDelivery]', JSON.stringify({
          userId,
          partitionId: String(targetGroup._id),
          partitionName: targetGroup.groupName || '',
          featureSource: 'copy_promo',
          sourceMessageId: messageId,
          destinationGroupId: jid,
          useNativeLinkPreview: nativePreviewEnabled,
          preserveSourceImageInNativePreview,
          selectedSendingMode: partitionSendPlan.selectedMode,
          actualSendMode: sendResult.mode,
          fallbackReason: sendResult.fallbackReason || '',
          photoAvailable: !!imageUrl,
          photoPayloadCreated: !!partitionSendPlan.imageUrlToSend,
          nativePreviewPayloadCreated: !!partitionSendPlan.waOptions.preferLinkPreview,
          sourceVisualImageRecovered: !!recoveredSourceVisualImageUrl,
          sourceImageMessageFallbackReason: sourcePreviewImageFallbackReason,
          finalSender: 'baileys',
          sendResult: 'sent'
        }));
        sent++;
      } catch (error: any) {
        lastError = error.message || String(error);
        console.info('[CopyPromo][PartitionDelivery]', JSON.stringify({
          userId,
          partitionId: String(targetGroup._id),
          partitionName: targetGroup.groupName || '',
          featureSource: 'copy_promo',
          sourceMessageId: messageId,
          destinationGroupId: jid,
          useNativeLinkPreview: nativePreviewEnabled,
          preserveSourceImageInNativePreview,
          selectedSendingMode: partitionSendPlan.selectedMode,
          photoAvailable: !!imageUrl,
          photoPayloadCreated: !!partitionSendPlan.imageUrlToSend,
          nativePreviewPayloadCreated: !!partitionSendPlan.waOptions.preferLinkPreview,
          sourceVisualImageRecovered: !!recoveredSourceVisualImageUrl,
          sourceImageMessageFallbackReason: sourcePreviewImageFallbackReason,
          finalSender: 'baileys',
          sendResult: 'failed',
          failureReason: lastError
        }));
      }
    }

    if (provider === 'mercadolivre') {
      logMercadoLivreTrace('send_result', {
        sourceMessageId: messageId,
        sourceGroupId,
        destinationGroupId: String(targetGroup._id),
        destinationCount: destinations.length,
        sent,
        failed: destinations.length - sent,
        partitionId: String(targetGroup._id),
        partitionName: targetGroup.groupName || '',
        requestedSendingMode: partitionSendPlan.selectedMode,
        actualSendModes: sendModes,
        finalOutgoingProductUrl: primaryMercadoLivreProductUrl ? (affiliateByOriginal.get(primaryMercadoLivreProductUrl) || '') : '',
        finalOutgoingListUrl: primaryMercadoLivreListUrl ? (affiliateByOriginal.get(primaryMercadoLivreListUrl) || '') : '',
        originalSourceUrlStillPresent: mercadoLivreOriginalProductStillPresent.length > 0,
        lastError
      });
    }

    const status = sent > 0 ? 'sent' : 'failed';
    await this.record(cfg, {
      sourceGroupId,
      sourceGroupName,
      targetGroupId: targetGroup._id,
      provider,
      originalUrl,
      affiliateUrl,
      productName: extractCopiedProductName(message, originalUrl),
      price: '',
      oldPrice: '',
      coupon: '',
      discountStore: '',
      imageUrl,
      extractionSource: 'original',
      messagePreview: message.slice(0, 300),
      rawMessageId: messageId,
      status,
      error: sent > 0 ? '' : lastError
    });
    await this.bump(cfg._id, sent > 0 ? 'success' : 'error', sent > 0 ? '' : lastError);
    return { success: sent > 0, sent, provider, targetGroup: targetGroup.groupName, extractionSource: 'original' };
  }

  private async record(cfg: any, data: any) {
    if (data.status === 'sent') return null;
    const payload: any = {
      userId: cfg.userId,
      configId: cfg._id,
      sourceGroupId: data.sourceGroupId,
      sourceGroupName: data.sourceGroupName,
      targetGroupId: data.targetGroupId,
      provider: data.provider,
      originalUrl: data.originalUrl,
      affiliateUrl: data.affiliateUrl,
      productName: data.productName,
      price: data.price,
      oldPrice: data.oldPrice,
      coupon: data.coupon,
      discountStore: data.discountStore,
      extractionSource: data.extractionSource,
      rawMessageId: data.rawMessageId,
      status: data.status,
      error: data.error,
      createdAt: new Date()
    };
    if (data.messagePreview) {
      payload.messagePreview = String(data.messagePreview).slice(0, 300);
    }
    return CopyPromoLog.create(payload);
  }

  private async bump(configId: any, status: 'success' | 'error' | 'skipped', error = '') {
    const inc: any = {};
    if (status === 'success') {
      inc.copiedCount = 1;
      inc.sentCount = 1;
    } else if (status === 'skipped') {
      inc.skippedCount = 1;
    }
    await CopyPromoConfig.updateOne(
      { _id: configId },
      {
        $set: { lastRunAt: new Date(), lastStatus: status, lastError: error, updatedAt: new Date() },
        ...(Object.keys(inc).length ? { $inc: inc } : {})
      }
    );
  }
}

export const copyPromoService = new CopyPromoService();
