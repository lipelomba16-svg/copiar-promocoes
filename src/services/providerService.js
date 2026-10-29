import crypto from 'crypto';
import { getState, saveState } from '../lib/store.js';
import { decryptIfNeeded, encryptIfNeeded, maskSecret } from '../lib/crypto.js';
import { providerFromUrl } from '../lib/promoText.js';
import { createShopeeClient, parseShopeeIdentityFromUrl, resolveShopeeUrlForIdentity } from './shopeeHelpers.js';

// Credenciais deste app standalone (usuário único): ficam em
// state.settings.providers. Nunca há credencial global/ambiente como
// fallback — sem credencial salva, a conversão falha com erro claro
// e a mensagem não é enviada.

const SECRET_FIELDS = {
  shopee: ['secret'],
  amazon: ['cookies'],
  mercadolivre: ['cookie', 'csrfToken'],
  aliexpress: ['appSecret']
};

const NON_SECRET_FIELDS = {
  shopee: ['appId', 'endpoint'],
  amazon: ['affiliateTag'],
  mercadolivre: ['affiliateTag', 'listReplacementUrl', 'couponAlertImageUrl', 'createLinkUrl'],
  aliexpress: ['appKey', 'trackingId', 'endpoint']
};

function normalizeProvider(provider) {
  const id = String(provider || '').trim().toLowerCase();
  if (!['shopee', 'amazon', 'mercadolivre', 'aliexpress'].includes(id)) {
    throw new Error('Provider invalido.');
  }
  return id;
}

async function decryptConfig(provider, rawConfig) {
  const config = { ...(rawConfig || {}) };
  for (const field of SECRET_FIELDS[provider] || []) {
    config[field] = await decryptIfNeeded(config[field]);
  }
  return config;
}

async function maskedConfigAsync(provider, rawConfig) {
  const decrypted = await decryptConfig(provider, rawConfig);
  const config = { ...(rawConfig || {}) };
  for (const field of SECRET_FIELDS[provider] || []) {
    const plain = decrypted[field] || '';
    config[field] = plain ? maskSecret(plain) : '';
    config[`${field}Preview`] = plain ? maskSecret(plain) : '';
    config[`${field}Length`] = plain.length;
  }
  // Campos de exibição genéricos usados pelo frontend:
  config.secretPreview = config.secretPreview || config.appSecretPreview || '';
  config.cookieLength = config.cookiesLength ?? config.cookieLength ?? 0;
  return config;
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
  return String(url || '').match(/\/(?:dp|gp\/product|asin)\/([A-Z0-9]{10})/i)?.[1]?.toUpperCase() || '';
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

function extractSiteStripeShortUrl(json) {
  if (typeof json === 'string') return json;
  if (json && typeof json === 'object') {
    for (const key of ['shortUrl', 'shortURL', 'short_url', 'url', 'shortLink']) {
      const value = json[key];
      if (typeof value === 'string' && value.startsWith('http')) return value;
    }
    const found = JSON.stringify(json).match(/https:\/\/(?:amzn\.to|a\.co)\/[A-Za-z0-9_-]+/);
    if (found) return found[0];
  }
  return '';
}

function isAmazonShortLink(url) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return host === 'amzn.to' || host === 'a.co' || host.endsWith('amazon.com.br') || host.endsWith('amazon.com');
  } catch {
    return false;
  }
}

// SiteStripe real, sem fallback: retorna SOMENTE o shortlink da Amazon.
// Sem shortUrl, falha com erro claro — nunca /r/go, nunca link interno.
async function fetchAmazonSiteStripeShortUrl(taggedUrl, cookie) {
  const query = new URLSearchParams({ longUrl: taggedUrl, marketplaceId: '526970' });
  const response = await fetch(`https://www.amazon.com.br/associates/sitestripe/getShortUrl?${query.toString()}`, {
    method: 'GET',
    headers: {
      accept: 'application/json, text/javascript, */*; q=0.01',
      'accept-language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
      referer: taggedUrl,
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome',
      'x-requested-with': 'XMLHttpRequest',
      cookie
    },
    signal: AbortSignal.timeout(15000)
  });
  const data = await response.json().catch(() => null);
  const short = extractSiteStripeShortUrl(data);
  if (!response.ok || !short || !isAmazonShortLink(short)) {
    throw new Error(`Amazon SiteStripe HTTP ${response.status}; shortUrl ausente.`);
  }
  return short;
}

async function buildAmazonAffiliateUrl(config, rawUrl) {
  if (!config.affiliateTag) throw new Error('Affiliate Tag Amazon ausente.');
  if (!config.cookies) throw new Error('Amazon: cookie ausente; Amazon não está pronta.');
  const resolved = await resolveAmazonShortUrl(rawUrl, config.cookies || '');
  const asin = extractAmazonAsin(resolved);
  if (!asin) throw new Error('Amazon: ASIN não encontrado na URL.');
  const taggedUrl = buildAmazonTaggedUrl(resolved, config.affiliateTag);
  return fetchAmazonSiteStripeShortUrl(taggedUrl, config.cookies);
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

function isAliExpressLink(url) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return host.endsWith('aliexpress.com') || host === 's.click.aliexpress.com' || host === 'a.aliexpress.com' || host === 'ali.pub';
  } catch {
    return false;
  }
}

// Extrai promotion_link de várias formas de resposta da TOP API,
// incluindo a forma aninhada e o campo de nível superior.
function extractPromotionLink(json, depth = 0) {
  if (depth > 8 || json == null) return '';
  if (typeof json === 'string') return isAliExpressLink(json) ? json : '';
  if (Array.isArray(json)) {
    for (const item of json) {
      const found = extractPromotionLink(item, depth + 1);
      if (found) return found;
    }
    return '';
  }
  if (typeof json === 'object') {
    for (const key of ['promotion_link', 'promotionLink', 'promotion_url', 'url']) {
      if (json[key] != null) {
        const found = extractPromotionLink(json[key], depth + 1);
        if (found) return found;
      }
    }
    for (const key of ['resp_result', 'result', 'data', 'aliexpress_affiliate_link_generate_response', 'response', 'promotion_links']) {
      if (json[key] != null) {
        const found = extractPromotionLink(json[key], depth + 1);
        if (found) return found;
      }
    }
  }
  return '';
}

// Resolve meli.la para o produto real antes de createLink, seguindo
// redirecionamentos sem trocar o produto. Falha em vez de adivinhar.
async function resolveMercadoLivreUrl(rawUrl) {
  let current = rawUrl;
  try {
    if (new URL(rawUrl).hostname.toLowerCase() !== 'meli.la') return rawUrl;
  } catch {
    return rawUrl;
  }
  for (let hop = 0; hop < 5; hop += 1) {
    const response = await fetch(current, {
      method: 'GET',
      redirect: 'manual',
      headers: browserHeaders(),
      signal: AbortSignal.timeout(15000)
    });
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      current = new URL(location, current).toString();
      continue;
    }
    if (response.status === 200) {
      if (new URL(current).hostname.toLowerCase() === 'meli.la') {
        throw new Error('Mercado Livre: link meli.la não redirecionou para o produto.');
      }
      return current;
    }
    throw new Error(`Mercado Livre: falha ao resolver link curto (HTTP ${response.status}).`);
  }
  throw new Error('Mercado Livre: redirecionamentos em excesso ao resolver link curto.');
}

function isMercadoLivreLink(url) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return host === 'mercadolivre.com.br' || host === 'mercadolivre.com' || host === 'meli.la' || host.endsWith('.mercadolivre.com.br');
  } catch {
    return false;
  }
}

function extractMercadoLivreLink(data) {
  const candidates = [];
  const collect = (value, depth = 0) => {
    if (depth > 3 || value == null) return;
    if (typeof value === 'string') {
      candidates.push(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => collect(item, depth + 1));
      return;
    }
    if (typeof value === 'object') {
      for (const key of ['short_url', 'shortUrl', 'url', 'link', 'affiliate_url', 'affiliateUrl']) {
        if (value[key] != null) collect(value[key], depth + 1);
      }
      if (value.urls != null) collect(value.urls, depth + 1);
      if (value.data != null) collect(value.data, depth + 1);
    }
  };
  collect(data);
  return candidates.find((candidate) => candidate.startsWith('http') && isMercadoLivreLink(candidate)) || '';
}

async function buildMercadoLivreAffiliateUrl(config, productUrl) {
  const resolvedUrl = await resolveMercadoLivreUrl(productUrl);
  const response = await fetch(config.createLinkUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/plain, */*',
      'user-agent': 'Mozilla/5.0',
      ...(config.cookie ? { cookie: config.cookie } : {}),
      ...(config.csrfToken ? { 'x-csrf-token': config.csrfToken } : {})
    },
    body: JSON.stringify({ urls: [resolvedUrl], tag: config.affiliateTag }),
    signal: AbortSignal.timeout(20000)
  });
  const data = await response.json().catch(() => ({}));
  const affiliateUrl = extractMercadoLivreLink(data);
  if (!response.ok || !affiliateUrl || affiliateUrl === resolvedUrl) {
    throw new Error(`Mercado Livre createLink falhou (${response.status}) sem link válido.`);
  }
  return affiliateUrl;
}

async function buildShopeeAffiliateUrl(config, rawUrl) {
  const client = createShopeeClient(config);
  const resolution = await resolveShopeeUrlForIdentity(rawUrl);
  const canonicalUrl = resolution.canonicalUrl || resolution.finalUrl || rawUrl;
  let lastError = null;
  // 1) Caminho principal: confirmar o produto e usar offerLink.
  try {
    const identity = parseShopeeIdentityFromUrl(canonicalUrl);
    if (identity) {
      const product = await client.getProductByIdentity(identity.shopId, identity.itemId);
      const affiliateUrl = product?.offerLink || (await client.generateShortLink(product?.productLink || canonicalUrl));
      if (affiliateUrl) return affiliateUrl;
    }
  } catch (error) {
    lastError = error;
  }
  // 2) generateShortLink direto sobre a URL resolvida.
  try {
    const shortLink = await client.generateShortLink(canonicalUrl);
    if (shortLink) return shortLink;
  } catch (error) {
    lastError = error;
  }
  // 3) Fallback de busca já existente no projeto (lookupProductByUrl).
  try {
    const product = await client.lookupProductByUrl(rawUrl);
    if (product?.offerLink) return product.offerLink;
  } catch (error) {
    lastError = error;
  }
  throw lastError || new Error('Shopee nao retornou link afiliado.');
}

export const providerService = {
  // Leitura mascarada: segredos nunca voltam completos para o frontend.
  async getConfig(provider) {
    const state = await getState();
    const normalized = normalizeProvider(provider);
    return maskedConfigAsync(normalized, state.settings.providers[normalized]);
  },

  async getMaskedProviders() {
    const state = await getState();
    const masked = {};
    for (const provider of Object.keys(SECRET_FIELDS)) {
      masked[provider] = await maskedConfigAsync(provider, state.settings.providers[provider]);
    }
    return masked;
  },

  // Uso interno (conversão/teste): credencial descriptografada, nunca logada.
  async getDecryptedConfig(provider) {
    const state = await getState();
    const normalized = normalizeProvider(provider);
    return decryptConfig(normalized, state.settings.providers[normalized]);
  },

  async saveProvider(provider, payload) {
    const state = await getState();
    const normalized = normalizeProvider(provider);
    const existing = state.settings.providers[normalized] || {};
    const decryptedExisting = await decryptConfig(normalized, existing);
    const next = { ...existing };
    for (const field of NON_SECRET_FIELDS[normalized] || []) {
      if (payload[field] !== undefined) next[field] = String(payload[field] ?? '').trim();
    }
    for (const field of SECRET_FIELDS[normalized] || []) {
      const incoming = payload[field];
      if (incoming === undefined || String(incoming).trim() === '') {
        // Campo em branco = manter a credencial salva.
        continue;
      }
      const incomingTrimmed = String(incoming).trim();
      const preview = decryptedExisting[field] ? maskSecret(decryptedExisting[field]) : '';
      if (preview && (incomingTrimmed === preview || incomingTrimmed === '****')) {
        continue;
      }
      next[field] = await encryptIfNeeded(incomingTrimmed);
    }
    next.isActive = !!payload.isActive;
    state.settings.providers[normalized] = next;
    await saveState(state);
    return maskedConfigAsync(normalized, next);
  },

  async testProvider(provider, payload) {
    const normalized = normalizeProvider(provider);
    const state = await getState();
    const savedDecrypted = await decryptConfig(normalized, state.settings.providers[normalized] || {});
    // Campos em branco no formulário = usar o valor salvo.
    const merged = { ...savedDecrypted };
    for (const field of [...(NON_SECRET_FIELDS[normalized] || []), ...(SECRET_FIELDS[normalized] || [])]) {
      if (payload[field] !== undefined && String(payload[field]).trim() !== '') merged[field] = String(payload[field]).trim();
    }
    if (normalized === 'shopee') {
      const client = createShopeeClient({
        appId: String(merged.appId || '').trim(),
        secret: String(merged.secret || '').trim(),
        endpoint: String(merged.endpoint || '').trim() || 'https://open-api.affiliate.shopee.com.br/graphql'
      });
      return client.testConnection();
    }
    if (normalized === 'amazon') {
      try {
        if (!merged.affiliateTag) throw new Error('Affiliate Tag obrigatoria.');
        if (!merged.cookies) throw new Error('Cookie Amazon/SiteStripe obrigatorio.');
        const short = await fetchAmazonSiteStripeShortUrl(
          buildAmazonTaggedUrl('https://www.amazon.com.br/dp/B0DCLPDVBM', merged.affiliateTag),
          merged.cookies
        );
        return { valid: !!short, shortUrl: short };
      } catch (error) {
        return { valid: false, error: error.message || String(error) };
      }
    }
    if (normalized === 'aliexpress') {
      try {
        const { response, data } = await runAliExpressRequest({
          appKey: merged.appKey,
          appSecret: merged.appSecret,
          endpoint: merged.endpoint || 'https://api-sg.aliexpress.com/sync'
        }, 'aliexpress.affiliate.product.query', {
          tracking_id: merged.trackingId || 'default',
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
        if (!merged.listReplacementUrl && !merged.createLinkUrl) throw new Error('Informe ao menos a URL de lista ou a createLink URL.');
        if (merged.listReplacementUrl) new URL(merged.listReplacementUrl);
        if (merged.createLinkUrl) new URL(merged.createLinkUrl);
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
    const provider = providerFromUrl(rawUrl);
    if (provider === 'amazon') {
      const config = await decryptConfig('amazon', state.settings.providers.amazon);
      return { provider: 'amazon', affiliateUrl: await buildAmazonAffiliateUrl(config, rawUrl) };
    }
    if (provider === 'aliexpress') {
      const config = await decryptConfig('aliexpress', state.settings.providers.aliexpress);
      if (!config.appKey || !config.appSecret) throw new Error('AliExpress: credenciais não configuradas.');
      const { response, data } = await runAliExpressRequest(config, 'aliexpress.affiliate.link.generate', {
        promotion_link_type: 2,
        source_values: rawUrl,
        tracking_id: config.trackingId || 'default'
      });
      const affiliateUrl = extractPromotionLink(data);
      if (!response.ok || !affiliateUrl) throw new Error('Nao foi possivel gerar link AliExpress.');
      return { provider: 'aliexpress', affiliateUrl };
    }
    if (provider === 'shopee') {
      const config = await decryptConfig('shopee', state.settings.providers.shopee);
      if (!config.appId || !config.secret) throw new Error('Shopee: credenciais não configuradas.');
      const affiliateUrl = await buildShopeeAffiliateUrl(config, rawUrl);
      if (!affiliateUrl) throw new Error('Shopee nao retornou link afiliado.');
      // Nome/imagem do produto, quando a busca confirmar o produto.
      let productName = '';
      let imageUrl = '';
      try {
        const resolution = await resolveShopeeUrlForIdentity(rawUrl);
        const identity = parseShopeeIdentityFromUrl(resolution.canonicalUrl || resolution.finalUrl || rawUrl);
        if (identity) {
          const product = await createShopeeClient(config).getProductByIdentity(identity.shopId, identity.itemId);
          productName = product?.productName || '';
          imageUrl = product?.imageUrl || '';
        }
      } catch {}
      return { provider: 'shopee', affiliateUrl, productName, imageUrl };
    }
    if (provider === 'mercadolivre') {
      const config = await decryptConfig('mercadolivre', state.settings.providers.mercadolivre);
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
    // Provider desconhecido: nunca devolver o link comum como afiliado.
    throw new Error(`Provider desconhecido para a URL: ${rawUrl}`);
  }
};

// Exportado para testes/uso interno (assinatura e extração).
export { extractPromotionLink, fetchAmazonSiteStripeShortUrl, buildAmazonAffiliateUrl, resolveMercadoLivreUrl };
