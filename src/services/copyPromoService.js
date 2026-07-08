import crypto from 'crypto';
import { getState, saveState } from '../lib/store.js';
import { providerService } from './providerService.js';
import { whatsappService } from './whatsappService.js';
import { reconnectMongoFromSettings } from '../lib/mongoBridge.js';

const allowedProviders = ['mercadolivre', 'amazon', 'shopee', 'aliexpress'];

function extractUrls(text) {
  return Array.from(new Set((String(text || '').match(/https?:\/\/[^\s<>"')]+/gi) || []).map((value) => value.replace(/[),.;]+$/, ''))));
}

function normalizeText(payload) {
  return String(
    payload?.texto ||
    payload?.caption ||
    payload?.text ||
    payload?.message ||
    payload?.body?.text ||
    payload?.body?.caption ||
    payload?.body?.message ||
    ''
  ).trim();
}

function normalizeSource(payload) {
  return {
    sourceGroupId: String(payload?.sourceGroupId || payload?.groupId || payload?.remoteJid || payload?.body?.sourceGroupId || '').trim(),
    sourceGroupName: String(payload?.sourceGroupName || payload?.groupName || payload?.body?.sourceGroupName || '').trim(),
    messageId: String(payload?.messageId || payload?.body?.messageId || '').trim()
  };
}

function normalizeImageUrl(payload) {
  return String(payload?.imageUrl || payload?.image_url || payload?.body?.imageUrl || '').trim();
}

function expandWebhookPayloads(payload) {
  const batch = [payload?.messages, payload?.items, payload?.events, payload?.body?.messages].find(Array.isArray);
  return Array.isArray(batch) && batch.length ? batch : [payload];
}

function providerFromUrl(url) {
  if (/mercadolivre\.com|meli\.la/i.test(url)) return 'mercadolivre';
  if (/amazon\.com|amazon\.com\.br|amzn\.to|a\.co/i.test(url)) return 'amazon';
  if (/shopee\.com|shopee\.com\.br|s\.shopee\.com|shope\.ee/i.test(url)) return 'shopee';
  if (/aliexpress\.com|ali\.pub|s\.click\.aliexpress/i.test(url)) return 'aliexpress';
  return 'unknown';
}

function cleanCopiedCaption(text, sourceGroupName = '') {
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trimEnd());
  return lines
    .filter((line) => {
      if (!line.trim()) return true;
      const lower = line.toLowerCase();
      if (sourceGroupName && lower.includes(String(sourceGroupName).toLowerCase())) return false;
      return !/(grupo parceiro|canal parceiro|cupom nos comentarios|sigam|siga nosso)/i.test(lower);
    })
    .join('\n')
    .trim();
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

  async saveConfig(payload) {
    const state = await getState();
    if (!payload.name) throw new Error('Nome da automacao obrigatorio.');
    if (!payload.sourceGroupId) throw new Error('Grupo de origem obrigatorio.');
    if (!payload.targetGroupId) throw new Error('Particao de destino obrigatoria.');
    const next = {
      id: payload.id || crypto.randomUUID(),
      name: String(payload.name || '').trim(),
      webhookToken: payload.webhookToken || crypto.randomUUID(),
      sourceGroupId: String(payload.sourceGroupId || '').trim(),
      sourceGroupName: String(payload.sourceGroupName || '').trim(),
      targetGroupId: String(payload.targetGroupId || '').trim(),
      isActive: !!payload.isActive,
      copiedCount: Number(payload.copiedCount || 0),
      sentCount: Number(payload.sentCount || 0),
      skippedCount: Number(payload.skippedCount || 0),
      lastStatus: payload.lastStatus || 'idle',
      lastError: payload.lastError || '',
      lastRunAt: payload.lastRunAt || '',
      updatedAt: new Date().toISOString(),
      createdAt: payload.createdAt || new Date().toISOString()
    };
    state.copyPromoConfigs = state.copyPromoConfigs.filter((config) => config.id !== next.id).concat(next);
    await saveState(state);
    return next;
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
    return config;
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
      results.push(await this.processConfig(config.id, item));
    }
    return {
      success: results.some((result) => result.success),
      sent: results.reduce((sum, result) => sum + Number(result.sent || 0), 0),
      results
    };
  },

  async processConfig(configId, payload) {
    const state = await getState();
    const config = state.copyPromoConfigs.find((item) => item.id === configId);
    if (!config) throw new Error('Config inexistente.');
    const targetGroup = state.groups.find((group) => group.id === config.targetGroupId && group.isActive);
    if (!targetGroup) throw new Error('Particao de destino nao encontrada.');
    const { sourceGroupId, sourceGroupName, messageId } = normalizeSource(payload);
    if (config.sourceGroupId && config.sourceGroupId !== sourceGroupId) {
      return { success: true, skipped: true, reason: 'source_group_mismatch' };
    }

    const text = normalizeText(payload);
    const orderedUrls = extractUrls(text);
    const allowedUrls = orderedUrls.filter((url) => allowedProviders.includes(providerFromUrl(url)));
    if (!allowedUrls.length) {
      await appendLog({
        configId,
        sourceGroupId,
        sourceGroupName,
        status: 'skipped',
        error: 'no_allowed_provider_url',
        messagePreview: text.slice(0, 300)
      });
      return { success: true, skipped: true, reason: 'no_allowed_provider_url' };
    }

    let message = text;
    let primaryAffiliateUrl = '';
    let primaryProvider = providerFromUrl(allowedUrls[0]);
    let previewImage = normalizeImageUrl(payload);
    for (const url of allowedUrls) {
      const affiliate = await providerService.affiliateForUrl(url);
      message = message.replaceAll(url, affiliate.affiliateUrl);
      if (!primaryAffiliateUrl) primaryAffiliateUrl = affiliate.affiliateUrl;
      if (affiliate.imageUrl && !previewImage) previewImage = affiliate.imageUrl;
      if (affiliate.productName) primaryProvider = affiliate.provider;
    }
    message = cleanCopiedCaption(message, sourceGroupName || config.sourceGroupName);

    const destinations = Array.from(new Set((targetGroup.groupIdentifiers || [targetGroup.groupIdentifier]).filter(Boolean)));
    let sent = 0;
    let lastError = '';
    for (const jid of destinations) {
      try {
        await whatsappService.sendMessage(jid, message, targetGroup.useNativeLinkPreview ? '' : previewImage, {
          preferLinkPreview: !!targetGroup.useNativeLinkPreview
        });
        sent++;
      } catch (error) {
        lastError = error.message || String(error);
      }
    }

    config.lastRunAt = new Date().toISOString();
    config.lastStatus = sent > 0 ? 'success' : 'error';
    config.lastError = sent > 0 ? '' : lastError;
    if (sent > 0) {
      config.copiedCount += 1;
      config.sentCount += 1;
    } else {
      config.skippedCount += 1;
    }
    await saveState(state);

    await appendLog({
      configId,
      sourceGroupId,
      sourceGroupName,
      targetGroupId: targetGroup.id,
      provider: primaryProvider,
      originalUrl: allowedUrls[0],
      affiliateUrl: primaryAffiliateUrl,
      rawMessageId: messageId,
      imageUrl: previewImage,
      status: sent > 0 ? 'sent' : 'failed',
      error: sent > 0 ? '' : lastError,
      messagePreview: message.slice(0, 300)
    });
    return { success: sent > 0, sent, provider: primaryProvider };
  }
};
