import crypto from 'crypto';
import { getState, saveState } from '../lib/store.js';
import { createShopeeClient, parseShopeeIdentityFromUrl, resolveShopeeUrlForIdentity } from './shopeeHelpers.js';

function normalizeProvider(provider) {
  const id = String(provider || '').trim().toLowerCase();
  if (!['shopee', 'amazon', 'mercadolivre', 'aliexpress'].includes(id)) {
    throw new Error('Provider invalido.');
  }
  return id;
}

function browserHeaders(cookie = '') {
  return {
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
    'user-agent': 'Mozilla/5.0',
    ...(cookie ? { cookie } : {})
  };
}

function extractAmazonAsin(url) {
  return String(url || '').match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i)?.[1] || '';
}

function buildAmazonTaggedUrl(url, tag) {
  const asin = extractAmazonAsin(url);
  if (asin) return `https://www.amazon.com.br/dp/${asin}?tag=${encodeURIComponent(tag)}`;
  const parsed = new URL(url);
  parsed.searchParams.set('tag', tag);
  return parsed.toString();
}

async function resolveAmazonShortUrl(url, cookie = '') {
  if (!/amzn\.to|a\.co/i.test(url)) return url;
  const response = await fetch(url, {
    method: 'GET',
    redirect: 'follow',
    headers: browserHeaders(cookie),
    signal: AbortSignal.timeout(12000)
  });
  return response.url || url;
}

function signAliExpress(params, secret, method = 'md5') {
  const base = Object.keys(params)
    .filter((key) => params[key] !== undefined && params[key] !== null && String(params[key]) !== '')
    .sort()
    .map((key) => `${key}${params[key]}`)
    .join('');
  if (method === 'sha256') return crypto.createHmac('sha256', secret).update(base).digest('hex').toUpperCase();
  return crypto.createHash('md5').update(`${secret}${base}${secret}`).digest('hex').toUpperCase();
}

async function runAliExpressRequest(config, method, extra = {}) {
  const base = {
    app_key: config.appKey,
    method,
    timestamp: new Date().toISOString().slice(0, 19).replace('T', ' '),
    format: 'json',
    v: '2.0',
    sign_method: 'md5',
    ...extra
  };
  const signed = { ...base, sign: signAliExpress(base, config.appSecret, 'md5') };
  let response = await fetch(`${config.endpoint}?${new URLSearchParams(signed).toString()}`, { signal: AbortSignal.timeout(20000) });
  let data = await response.json().catch(() => ({}));
  const error = JSON.stringify(data);
  if (/sign|signature/i.test(error)) {
    const retryBase = { ...base, sign_method: 'sha256' };
    const retrySigned = { ...retryBase, sign: signAliExpress(retryBase, config.appSecret, 'sha256') };
    response = await fetch(`${config.endpoint}?${new URLSearchParams(retrySigned).toString()}`, { signal: AbortSignal.timeout(20000) });
    data = await response.json().catch(() => ({}));
  }
  return { response, data };
}

async function buildMercadoLivreAffiliateUrl(config, productUrl) {
  const response = await fetch(config.createLinkUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/plain, */*',
      'user-agent': 'Mozilla/5.0',
      ...(config.cookie ? { cookie: config.cookie } : {}),
      ...(config.csrfToken ? { 'x-csrf-token': config.csrfToken } : {})
    },
    body: JSON.stringify({ urls: [productUrl], tag: config.affiliateTag }),
    signal: AbortSignal.timeout(20000)
  });
  const data = await response.json().catch(() => ({}));
  const affiliateUrl =
    data?.urls?.[0]?.short_url ||
    data?.urls?.[0]?.shortUrl ||
    data?.short_url ||
    data?.shortUrl ||
    '';
  if (!response.ok || !affiliateUrl || affiliateUrl === productUrl) {
    throw new Error(`Mercado Livre createLink falhou (${response.status}).`);
  }
  return affiliateUrl;
}

export const providerService = {
  async getConfig(provider) {
    const state = await getState();
    return state.settings.providers[normalizeProvider(provider)];
  },

  async saveProvider(provider, payload) {
    const state = await getState();
    const normalized = normalizeProvider(provider);
    state.settings.providers[normalized] = {
      ...state.settings.providers[normalized],
      ...payload,
      isActive: !!payload.isActive
    };
    await saveState(state);
    return state.settings.providers[normalized];
  },

  async testProvider(provider, payload) {
    const normalized = normalizeProvider(provider);
    if (normalized === 'shopee') {
      const client = createShopeeClient({
        appId: String(payload.appId || '').trim(),
        secret: String(payload.secret || '').trim(),
        endpoint: String(payload.endpoint || '').trim() || 'https://open-api.affiliate.shopee.com.br/graphql'
      });
      return client.testConnection();
    }
    if (normalized === 'amazon') {
      try {
        if (!payload.affiliateTag) throw new Error('Affiliate Tag obrigatoria.');
        if (!payload.cookies) throw new Error('Cookie Amazon/SiteStripe obrigatorio.');
        const resolved = await resolveAmazonShortUrl('https://www.amazon.com.br/dp/B0DCLPDVBM', payload.cookies);
        return { valid: !!buildAmazonTaggedUrl(resolved, payload.affiliateTag) };
      } catch (error) {
        return { valid: false, error: error.message || String(error) };
      }
    }
    if (normalized === 'aliexpress') {
      try {
        const { response, data } = await runAliExpressRequest({
          appKey: payload.appKey,
          appSecret: payload.appSecret,
          endpoint: payload.endpoint || 'https://api-sg.aliexpress.com/sync'
        }, 'aliexpress.affiliate.product.query', {
          tracking_id: payload.trackingId || 'default',
          category_ids: '7',
          page_no: 1,
          page_size: 1,
          target_currency: 'BRL',
          target_language: 'PT'
        });
        return response.ok ? { valid: true, raw: data } : { valid: false, error: `AliExpress HTTP ${response.status}` };
      } catch (error) {
        return { valid: false, error: error.message || String(error) };
      }
    }
    if (normalized === 'mercadolivre') {
      try {
        if (!payload.listReplacementUrl && !payload.createLinkUrl) throw new Error('Informe ao menos a URL de lista ou a createLink URL.');
        if (payload.listReplacementUrl) new URL(payload.listReplacementUrl);
        if (payload.createLinkUrl) new URL(payload.createLinkUrl);
        return { valid: true };
      } catch (error) {
        return { valid: false, error: error.message || String(error) };
      }
    }
    return { valid: false, error: 'Provider invalido.' };
  },

  async affiliateForUrl(url) {
    const state = await getState();
    const rawUrl = String(url || '').trim();
    if (/amazon\.com|amazon\.com\.br|amzn\.to|a\.co/i.test(rawUrl)) {
      const config = state.settings.providers.amazon;
      if (!config.affiliateTag) throw new Error('Affiliate Tag Amazon ausente.');
      const resolved = await resolveAmazonShortUrl(rawUrl, config.cookies || '');
      return {
        provider: 'amazon',
        affiliateUrl: buildAmazonTaggedUrl(resolved, config.affiliateTag)
      };
    }
    if (/aliexpress\.com|ali\.pub|s\.click\.aliexpress/i.test(rawUrl)) {
      const config = state.settings.providers.aliexpress;
      const { response, data } = await runAliExpressRequest(config, 'aliexpress.affiliate.link.generate', {
        promotion_link_type: 2,
        source_values: rawUrl,
        tracking_id: config.trackingId || 'default'
      });
      const affiliateUrl =
        data?.aliexpress_affiliate_link_generate_response?.resp_result?.result?.promotion_links?.promotion_link?.[0]?.promotion_link ||
        data?.resp_result?.result?.promotion_links?.promotion_link?.[0]?.promotion_link ||
        '';
      if (!response.ok || !affiliateUrl) throw new Error('Nao foi possivel gerar link AliExpress.');
      return { provider: 'aliexpress', affiliateUrl };
    }
    if (/shopee\.com|shopee\.com\.br|s\.shopee\.com|shope\.ee/i.test(rawUrl)) {
      const config = state.settings.providers.shopee;
      const client = createShopeeClient(config);
      const resolution = await resolveShopeeUrlForIdentity(rawUrl);
      const identity = parseShopeeIdentityFromUrl(resolution.canonicalUrl || resolution.finalUrl || rawUrl);
      if (!identity) throw new Error('Shopee nao permitiu confirmar o produto.');
      const product = await client.getProductByIdentity(identity.shopId, identity.itemId);
      const affiliateUrl = product?.offerLink || await client.generateShortLink(product?.productLink || identity.canonicalUrl);
      if (!affiliateUrl) throw new Error('Shopee nao retornou link afiliado.');
      return {
        provider: 'shopee',
        affiliateUrl,
        productName: product?.productName || '',
        imageUrl: product?.imageUrl || ''
      };
    }
    if (/mercadolivre\.com|meli\.la/i.test(rawUrl)) {
      const config = state.settings.providers.mercadolivre;
      const isListLike = /\/social\/.+\/lists|lista\.mercadolivre\.com\.br|\/ofertas\b|\/coupons?\b/i.test(rawUrl);
      if (isListLike) {
        if (!config.listReplacementUrl) throw new Error('URL de lista do Mercado Livre nao configurada.');
        return { provider: 'mercadolivre', affiliateUrl: config.listReplacementUrl };
      }
      if (!config.createLinkUrl || !config.cookie || !config.affiliateTag) {
        throw new Error('Config Mercado Livre incompleta para gerar link afiliado.');
      }
      return {
        provider: 'mercadolivre',
        affiliateUrl: await buildMercadoLivreAffiliateUrl(config, rawUrl)
      };
    }
    return { provider: 'unknown', affiliateUrl: rawUrl };
  }
};
