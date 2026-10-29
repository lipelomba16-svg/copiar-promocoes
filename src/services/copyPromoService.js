import crypto from 'crypto';
import { getState, saveState } from '../lib/store.js';
import { providerService } from './providerService.js';
import { whatsappService } from './whatsappService.js';
import { reconnectMongoFromSettings } from '../lib/mongoBridge.js';
import {
  applyShopeeCouponNote,
  buildFinalCaption,
  cleanCopiedCaption,
  extractProductInfo,
  extractUrls,
  isGroupOrNewsletterJid,
  providerFromUrl
} from '../lib/promoText.js';

const allowedProviders = ['mercadolivre', 'amazon', 'shopee', 'aliexpress'];

// Deduplicação em memória por (configId, rawMessageId): o mesmo
// WhatsApp/webhook pode redeliverar a mensagem. Sem messageId, não há
// dedupe (testes manuais e webhooks sem id continuam funcionando).
const seenMessageIds = new Set();
function isDuplicate(configId, messageId) {
  if (!messageId) return false;
  const key = `${configId}:${messageId}`;
  if (seenMessageIds.has(key)) return true;
  seenMessageIds.add(key);
  if (seenMessageIds.size > 2000) {
    const first = seenMessageIds.values().next().value;
    seenMessageIds.delete(first);
  }
  return false;
}

function normalizeText(payload) {
  const message = payload?.message || payload?.data?.message || payload?.body?.message || {};
  return String(
    payload?.texto ||
    payload?.caption ||
    payload?.text ||
    payload?.message ||
    message?.conversation ||
    message?.extendedTextMessage?.text ||
    message?.imageMessage?.caption ||
    payload?.body?.text ||
    payload?.body?.caption ||
    payload?.body?.message ||
    payload?.data?.text ||
    payload?.data?.caption ||
    ''
  ).trim();
}

function normalizeSource(payload) {
  const key = payload?.key || payload?.message?.key || {};
  const message = payload?.message || payload?.data?.message || {};
  return {
    sourceGroupId: String(
      payload?.sourceGroupId || payload?.groupId || payload?.remoteJid || payload?.chatId ||
      key?.remoteJid || payload?.body?.sourceGroupId || payload?.data?.remoteJid || ''
    ).trim(),
    sourceGroupName: String(payload?.sourceGroupName || payload?.groupName || payload?.body?.sourceGroupName || '').trim(),
    messageId: String(payload?.messageId || payload?.id || payload?.body?.messageId || key?.id || '').trim(),
    fromMe: Boolean(payload?.fromMe ?? key?.fromMe ?? false)
  };
}

function normalizeImageUrl(payload) {
  const message = payload?.message || payload?.data?.message || payload?.body?.message || {};
  const imageMessage = message?.imageMessage || {};
  return String(
    payload?.imageUrl || payload?.image_url || payload?.mediaUrl ||
    imageMessage?.url || payload?.body?.imageUrl || payload?.data?.imageUrl || ''
  ).trim();
}

// Cada entrada de lote é processada, não só a primeira.
// Aceita: array direto, messages/items/events (raiz, data.* ou body.*),
// objeto único ou data.* como mensagem única.
function expandWebhookPayloads(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [payload];
  const candidates = [
    payload.messages, payload.items, payload.events,
    payload.data?.messages, payload.data?.items, payload.data?.events,
    payload.body?.messages, payload.body?.items, payload.body?.events
  ];
  const batch = candidates.find((value) => Array.isArray(value) && value.length > 0);
  if (batch) return batch;
  if (payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)) {
    const data = payload.data;
    if (data.text || data.caption || data.message || data.imageUrl || data.remoteJid) return [data];
  }
  return [payload];
}

async function appendLog(entry) {
  const state = await getState();
  state.logs.push({
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    ...entry
  });
  state.logs = state.logs.slice(-300);
  await saveState(state);
}

async function updateConfigAfter(state, config, patch, increments) {
  config.lastRunAt = new Date().toISOString();
  Object.assign(config, patch);
  config.copiedCount = Number(config.copiedCount || 0) + (increments.copiedCount || 0);
  config.sentCount = Number(config.sentCount || 0) + (increments.sentCount || 0);
  config.skippedCount = Number(config.skippedCount || 0) + (increments.skippedCount || 0);
  await saveState(state);
}

export const copyPromoService = {
  async saveSettings(payload) {
    const state = await getState();
    state.settings = {
      ...state.settings,
      ...payload,
      mongo: state.settings.mongo,
      providers: state.settings.providers
    };
    await saveState(state);
    await reconnectMongoFromSettings();
    return {
      ...state.settings,
      providers: await providerService.getMaskedProviders(),
      security: { encryptionKey: 'stored-locally-hidden' }
    };
  },

  async listGroups() {
    const state = await getState();
    return state.groups;
  },

  async saveGroup(payload) {
    const state = await getState();
    const ids = Array.isArray(payload.groupIdentifiers) ? payload.groupIdentifiers : [payload.groupIdentifier].filter(Boolean);
    if (!payload.groupName) throw new Error('Nome da particao e obrigatorio.');
    if (!ids.length) throw new Error('Informe ao menos um destino de WhatsApp.');
    const next = {
      id: payload.id || crypto.randomUUID(),
      groupName: String(payload.groupName || '').trim(),
      groupIdentifier: String(ids[0] || '').trim(),
      groupIdentifiers: ids.map((value) => String(value || '').trim()).filter(Boolean),
      useNativeLinkPreview: !!payload.useNativeLinkPreview,
      preserveSourceImageInNativePreview: !!payload.preserveSourceImageInNativePreview,
      customMessageTemplate: String(payload.customMessageTemplate || '').trim(),
      isActive: payload.isActive !== false,
      updatedAt: new Date().toISOString(),
      createdAt: payload.createdAt || new Date().toISOString()
    };
    state.groups = state.groups.filter((group) => group.id !== next.id).concat(next);
    await saveState(state);
    return next;
  },

  async deleteGroup(id) {
    const state = await getState();
    state.groups = state.groups.filter((group) => group.id !== id);
    state.copyPromoConfigs = state.copyPromoConfigs.map((config) => config.targetGroupId === id ? { ...config, isActive: false } : config);
    await saveState(state);
    return { ok: true };
  },

  async listConfigs() {
    const state = await getState();
    return state.copyPromoConfigs.map((config) => ({
      ...config,
      webhookPath: `/api/copy-promo/webhook/${config.webhookToken}`,
      targetGroup: state.groups.find((group) => group.id === config.targetGroupId) || null
    }));
  },

  async getConfig(id) {
    const configs = await this.listConfigs();
    return configs.find((config) => config.id === id) || null;
  },

  async saveConfig(payload) {
    const state = await getState();
    const existing = payload.id ? state.copyPromoConfigs.find((config) => config.id === payload.id) : null;
    if (!payload.name && !existing) throw new Error('Nome da automacao obrigatorio.');
    const sourceGroupId = String(payload.sourceGroupId ?? existing?.sourceGroupId ?? '').trim();
    const targetGroupId = String(payload.targetGroupId ?? existing?.targetGroupId ?? '').trim();
    if (!sourceGroupId) throw new Error('Grupo de origem obrigatorio.');
    if (!isGroupOrNewsletterJid(sourceGroupId)) {
      throw new Error('Origem inválida: esperado JID de grupo (@g.us) ou canal (@newsletter). Use o cadastro manual por JID quando a listagem automática falhar.');
    }
    if (!targetGroupId) throw new Error('Particao de destino obrigatoria.');
    // Merge: NUNCA aceitar do cliente webhookToken, contadores,
    // lastStatus/lastError/lastRunAt — edição/toggle não pode zerar
    // contadores nem trocar o webhook sem querer.
    const next = existing
      ? {
          ...existing,
          name: String(payload.name ?? existing.name).trim(),
          sourceGroupId,
          sourceGroupName: String(payload.sourceGroupName ?? existing.sourceGroupName ?? '').trim(),
          targetGroupId,
          isActive: payload.isActive !== undefined ? !!payload.isActive : !!existing.isActive,
          addShopeeCouponNote: payload.addShopeeCouponNote !== undefined ? !!payload.addShopeeCouponNote : (existing.addShopeeCouponNote !== false),
          updatedAt: new Date().toISOString()
        }
      : {
          id: crypto.randomUUID(),
          name: String(payload.name || '').trim(),
          webhookToken: crypto.randomUUID(),
          sourceGroupId,
          sourceGroupName: String(payload.sourceGroupName || '').trim(),
          targetGroupId,
          isActive: !!payload.isActive,
          addShopeeCouponNote: payload.addShopeeCouponNote !== false,
          copiedCount: 0,
          sentCount: 0,
          skippedCount: 0,
          lastStatus: 'idle',
          lastError: '',
          lastRunAt: '',
          updatedAt: new Date().toISOString(),
          createdAt: new Date().toISOString()
        };
    state.copyPromoConfigs = state.copyPromoConfigs.filter((config) => config.id !== next.id).concat(next);
    await saveState(state);
    return { ...next, webhookPath: `/api/copy-promo/webhook/${next.webhookToken}` };
  },

  async deleteConfig(id) {
    const state = await getState();
    state.copyPromoConfigs = state.copyPromoConfigs.filter((config) => config.id !== id);
    await saveState(state);
    return { ok: true };
  },

  async rotateWebhook(configId) {
    const state = await getState();
    const config = state.copyPromoConfigs.find((item) => item.id === configId);
    if (!config) throw new Error('Automacao nao encontrada.');
    config.webhookToken = crypto.randomUUID();
    config.updatedAt = new Date().toISOString();
    await saveState(state);
    return { ...config, webhookPath: `/api/copy-promo/webhook/${config.webhookToken}` };
  },

  async getLogs(limit = 100) {
    const state = await getState();
    return state.logs.slice(-Math.min(300, Math.max(1, limit))).reverse();
  },

  async testConfig(payload) {
    const configs = await this.listConfigs();
    const config = configs.find((item) => item.id === payload.configId) || configs[0];
    if (!config) throw new Error('Nenhuma automacao configurada.');
    return this.handleWebhook(config.webhookToken, {
      ...payload,
      sourceGroupId: payload.sourceGroupId || config.sourceGroupId,
      sourceGroupName: payload.sourceGroupName || config.sourceGroupName
    });
  },

  async handleWebhook(token, payload) {
    const state = await getState();
    const config = state.copyPromoConfigs.find((item) => item.webhookToken === token);
    if (!config || !config.isActive) return { success: false, skipped: true, reason: 'copy_promo_inactive_or_invalid_token' };
    const results = [];
    for (const item of expandWebhookPayloads(payload)) {
      try {
        results.push(await this.processConfig(config.id, item));
      } catch (error) {
        results.push({ success: false, sent: 0, error: error.message || String(error) });
      }
    }
    return {
      success: results.some((result) => result.success),
      processed: results.length,
      sent: results.reduce((sum, result) => sum + Number(result.sent || 0), 0),
      skipped: results.filter((result) => result.skipped).length,
      failed: results.filter((result) => !result.success && !result.skipped).length,
      results
    };
  },

  async processConfig(configId, payload) {
    const state = await getState();
    const config = state.copyPromoConfigs.find((item) => item.id === configId);
    if (!config) throw new Error('Config inexistente.');
    const targetGroup = state.groups.find((group) => group.id === config.targetGroupId && group.isActive);
    if (!targetGroup) throw new Error('Particao de destino nao encontrada.');
    const { sourceGroupId, sourceGroupName, messageId, fromMe } = normalizeSource(payload);
    if (fromMe) return { success: true, skipped: true, reason: 'own_message' };
    if (config.sourceGroupId && sourceGroupId && config.sourceGroupId !== sourceGroupId) {
      return { success: true, skipped: true, reason: 'source_group_mismatch' };
    }
    if (messageId && isDuplicate(config.id, messageId)) {
      return { success: true, skipped: true, reason: 'duplicate' };
    }

    const text = normalizeText(payload);
    const orderedUrls = extractUrls(text);
    const allowedUrls = orderedUrls.filter((url) => allowedProviders.includes(providerFromUrl(url)));
    const effectiveSourceGroupId = sourceGroupId || config.sourceGroupId;
    const effectiveSourceGroupName = sourceGroupName || config.sourceGroupName;
    const baseLog = {
      configId,
      sourceGroupId: effectiveSourceGroupId,
      sourceGroupName: effectiveSourceGroupName,
      targetGroupId: targetGroup.id,
      rawMessageId: messageId,
      originalUrl: allowedUrls[0] || '',
      originalUrls: allowedUrls
    };

    if (!allowedUrls.length) {
      await appendLog({
        ...baseLog,
        provider: 'unknown',
        status: 'skipped',
        error: 'no_allowed_provider_url',
        messagePreview: text.slice(0, 300)
      });
      await updateConfigAfter(state, config, { lastStatus: 'skipped', lastError: '' }, { skippedCount: 1 });
      return { success: true, skipped: true, reason: 'no_allowed_provider_url' };
    }

    const firstProvider = providerFromUrl(allowedUrls[0]);
    let providerImageUrl = '';
    // Converter TODOS os links permitidos, individualmente. Se qualquer
    // conversão falhar, registrar failed e NÃO enviar (nunca link comum).
    const affiliateByOriginal = new Map();
    const affiliateUrls = [];
    let failedConversion = null;
    for (const url of allowedUrls) {
      try {
        const affiliate = await providerService.affiliateForUrl(url);
        affiliateByOriginal.set(url, affiliate.affiliateUrl);
        affiliateUrls.push(affiliate.affiliateUrl);
        if (affiliate.productName) baseLog.productName = affiliate.productName;
        if (affiliate.imageUrl) providerImageUrl = affiliate.imageUrl;
      } catch (error) {
        failedConversion = { provider: providerFromUrl(url), originalUrl: url, error: error.message || String(error) };
        break;
      }
    }
    if (failedConversion) {
      const info = extractProductInfo(text);
      await appendLog({
        ...baseLog,
        provider: failedConversion.provider,
        originalUrl: failedConversion.originalUrl,
        status: 'failed',
        error: failedConversion.error,
        messagePreview: text.slice(0, 300),
        ...info
      });
      await updateConfigAfter(state, config, { lastStatus: 'error', lastError: failedConversion.error }, {});
      return { success: false, sent: 0, provider: failedConversion.provider, error: failedConversion.error };
    }

    const built = buildFinalCaption(text, affiliateByOriginal, effectiveSourceGroupName);
    if (built.affiliateUrlsInCaption.length === 0) {
      await appendLog({
        ...baseLog,
        provider: firstProvider,
        status: 'skipped',
        error: 'no_valid_affiliate_link_in_final_message',
        messagePreview: built.caption.slice(0, 300)
      });
      await updateConfigAfter(state, config, { lastStatus: 'skipped', lastError: '' }, { skippedCount: 1 });
      return { success: true, skipped: true, reason: 'no_valid_affiliate_link_in_final_message' };
    }

    let message = applyShopeeCouponNote(built.caption, firstProvider, config.addShopeeCouponNote !== false);
    let previewImage = normalizeImageUrl(payload) || providerImageUrl || '';
    const info = extractProductInfo(message);

    const destinations = Array.from(new Set((targetGroup.groupIdentifiers || [targetGroup.groupIdentifier]).filter(Boolean)));
    let sent = 0;
    let lastError = '';
    const failedDestinations = [];
    for (const jid of destinations) {
      try {
        await whatsappService.sendMessage(jid, message, targetGroup.useNativeLinkPreview ? '' : previewImage, {
          preferLinkPreview: !!targetGroup.useNativeLinkPreview
        });
        sent++;
      } catch (error) {
        lastError = error.message || String(error);
        failedDestinations.push(`${jid}: ${lastError}`);
      }
    }

    const partiallyFailed = sent > 0 && failedDestinations.length > 0;
    await updateConfigAfter(
      state,
      config,
      { lastStatus: sent > 0 ? 'success' : 'error', lastError: sent > 0 ? '' : lastError },
      sent > 0 ? { copiedCount: 1, sentCount: 1 } : { skippedCount: 1 }
    );

    await appendLog({
      ...baseLog,
      provider: firstProvider,
      affiliateUrl: affiliateUrls[0] || '',
      affiliateUrls,
      imageUrl: previewImage || undefined,
      status: sent > 0 ? 'sent' : 'failed',
      error: sent > 0 ? (partiallyFailed ? `Envio parcial: ${failedDestinations.join('; ')}` : '') : lastError,
      messagePreview: message.slice(0, 300),
      ...info
    });
    return { success: sent > 0, sent, provider: firstProvider };
  }
};

export { buildFinalCaption, cleanCopiedCaption, extractProductInfo, extractUrls, providerFromUrl, expandWebhookPayloads };
