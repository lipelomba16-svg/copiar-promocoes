// Funções puras de texto/provider do Copiar Promo (sem dependências).
// Sem IA e sem reescrever a legenda: só troca/remove URLs e descarta
// linhas de assinatura/divulgação do grupo original.

export const PROVIDER_DOMAINS = {
  mercadolivre: ['mercadolivre.com.br', 'mercadolivre.com', 'meli.la'],
  shopee: ['shopee.com.br', 'shopee.com', 's.shopee.com.br', 'shope.ee'],
  aliexpress: ['aliexpress.com', 's.click.aliexpress.com', 'a.aliexpress.com', 'ali.pub'],
  amazon: ['amazon.com.br', 'amazon.com', 'amzn.to', 'a.co']
};

const TRAILING_PUNCTUATION = new Set(['.', ',', '!', '?', ';', ':', ')', ']', '}']);
const URL_TOKEN_REGEX = /https?:\/\/[^\s<>"'\\]+/gi;

const BAD_LINE_PATTERNS = [
  /t\.me/i,
  /telegram\.me/i,
  /telegram\.org/i,
  /chat\.whatsapp\.com/i,
  /whatsapp\.com\/channel/i,
  /whatsapp\.com\/invite/i,
  /grupo de promos/i,
  /grupo de promo[cç][oõ]es/i,
  /canal de promo/i,
  /canal do telegram/i,
  /\btelegram\b/i
];

function hostnameMatches(hostname, domain) {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

export function providerFromUrl(url) {
  const trimmed = String(url || '').trim();
  try {
    const host = new URL(trimmed).hostname.toLowerCase().replace(/^www\./, '');
    for (const [provider, domains] of Object.entries(PROVIDER_DOMAINS)) {
      if (domains.some((domain) => hostnameMatches(host, domain))) return provider;
    }
    return 'unknown';
  } catch {
    const lower = trimmed.toLowerCase();
    for (const [provider, domains] of Object.entries(PROVIDER_DOMAINS)) {
      if (domains.some((domain) => lower.includes(domain))) return provider;
    }
    return 'unknown';
  }
}

export function isAllowedUrl(url) {
  return providerFromUrl(url) !== 'unknown';
}

export function stripTrailingPunctuation(rawUrl) {
  let end = rawUrl.length;
  while (end > 0 && TRAILING_PUNCTUATION.has(rawUrl[end - 1])) {
    if (rawUrl[end - 1] === ')' && rawUrl.slice(0, end).includes('(')) break;
    end -= 1;
  }
  return rawUrl.slice(0, end);
}

export function extractUrls(text) {
  const matches = String(text || '').match(/https?:\/\/[^\s<>"')]+/gi) || [];
  return Array.from(new Set(matches.map((raw) => stripTrailingPunctuation(raw)).filter(Boolean)));
}

function stripTrailing(rawUrl) {
  const url = stripTrailingPunctuation(rawUrl);
  return { url, trailing: rawUrl.slice(url.length) };
}

// affiliateByOriginal: Map/Objeto original -> afiliado.
// Links permitidos sem afiliado no mapa e links não permitidos são
// removidos — nunca reenviados como link comum.
export function buildFinalCaption(text, affiliateByOriginal, sourceGroupName = '') {
  const map = affiliateByOriginal instanceof Map
    ? affiliateByOriginal
    : new Map(Object.entries(affiliateByOriginal || {}));
  const removedUrls = [];
  let replacedCount = 0;

  const withUrlsReplaced = String(text || '').replace(URL_TOKEN_REGEX, (raw) => {
    const { url, trailing } = stripTrailing(raw);
    if (!url) return raw;
    const affiliate = map.get(url);
    if (affiliate) {
      replacedCount += 1;
      return affiliate + trailing;
    }
    removedUrls.push(url);
    return '';
  });

  const sourceName = String(sourceGroupName || '').trim();
  const kept = [];
  for (const line of withUrlsReplaced.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') {
      kept.push(line);
      continue;
    }
    const isBadLine =
      BAD_LINE_PATTERNS.some((re) => re.test(line)) ||
      (sourceName.length >= 4 &&
        (trimmed.toLowerCase() === sourceName.toLowerCase() ||
          (trimmed.length <= 100 && line.toLowerCase().includes(sourceName.toLowerCase()))));
    if (isBadLine) continue;
    kept.push(line);
  }

  let caption = kept.join('\n').replace(/^\n+/, '').replace(/\n+$/, '');
  caption = caption.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

  const affiliateUrlsInCaption = [...map.values()].filter((affiliate) => caption.includes(affiliate));
  return { caption, replacedCount, removedUrls, affiliateUrlsInCaption };
}

// Compatibilidade: limpa sem substituir (não usar sozinha para enviar,
// pois deixaria links comuns). O processador usa buildFinalCaption.
export function cleanCopiedCaption(text, sourceGroupName = '') {
  const allowed = extractUrls(text).filter(isAllowedUrl);
  const identity = new Map(allowed.map((url) => [url, url]));
  return buildFinalCaption(text, identity, sourceGroupName).caption;
}

export const SHOPEE_COUPON_NOTE = 'cupom: Aplicável na hora da compra!';

// Única adição de texto permitida: mensagem Shopee sem cupom explícito
// ganha a frase padrão ao final. Desligável por automação.
export function applyShopeeCouponNote(caption, provider, addNote) {
  if (!addNote || provider !== 'shopee') return caption;
  if (!caption || /cupom/i.test(caption)) return caption;
  return `${caption}\n\n${SHOPEE_COUPON_NOTE}`;
}

const PRICE_REGEX = /R\$\s?\d{1,3}(?:\.\d{3})*(?:,\d{2})?/g;

function cleanName(line) {
  return String(line || '')
    .replace(/[*_`~]+/g, ' ')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Só para os campos do log. Nunca reescreve a legenda.
export function extractProductInfo(text) {
  if (!text) return {};
  const lines = String(text).split('\n').map((l) => l.trim()).filter(Boolean);
  const productName = lines.map(cleanName).find((l) => l.length >= 3 && !/^https?:\/\//i.test(l));
  const prices = [...String(text).matchAll(PRICE_REGEX)].map((m) => m[0].trim());
  const dePor = String(text).match(/de\s+(R\$\s?\d[\d.,]*)\s+por\s+(R\$\s?\d[\d.,]*)/i);
  let price;
  let oldPrice;
  if (dePor) {
    oldPrice = dePor[1].trim();
    price = dePor[2].trim();
  } else if (prices.length >= 2) {
    oldPrice = prices[0];
    price = prices[prices.length - 1];
  } else if (prices.length === 1) {
    price = prices[0];
  }
  const couponMatch =
    String(text).match(/cupom\s*[:\-]?\s*([A-Za-z0-9][A-Za-z0-9_-]{2,30})/i) ||
    String(text).match(/\bcupom\b\s+([A-Za-z0-9][A-Za-z0-9_-]{2,30})/i);
  const coupon = couponMatch?.[1] && !/^(de|do|da|no|na|aplic|na hora)/i.test(couponMatch[1]) ? couponMatch[1] : undefined;
  return {
    ...(productName ? { productName: productName.slice(0, 140) } : {}),
    ...(price ? { price } : {}),
    ...(oldPrice ? { oldPrice } : {}),
    ...(coupon ? { coupon } : {})
  };
}

export function isGroupOrNewsletterJid(remoteJid) {
  return String(remoteJid || '').endsWith('@g.us') || String(remoteJid || '').endsWith('@newsletter');
}

export function parseManualSource(input) {
  const trimmed = String(input || '').trim();
  if (!trimmed) return { kind: 'invalid', reason: 'Informe o JID, o link do canal ou o link de convite do grupo.' };
  if (trimmed.endsWith('@g.us') || trimmed.endsWith('@newsletter')) return { kind: 'jid', jid: trimmed };
  if (/^https?:\/\//i.test(trimmed)) {
    if (/chat\.whatsapp\.com\//i.test(trimmed) || /whatsapp\.com\/channel\//i.test(trimmed)) {
      return { kind: 'invite', url: trimmed };
    }
    return { kind: 'invalid', reason: 'Link não reconhecido: use um link de convite (chat.whatsapp.com) ou de canal (whatsapp.com/channel).' };
  }
  return { kind: 'invalid', reason: 'JID inválido: esperado algo como 120207xxx@g.us ou 120207xxx@newsletter.' };
}
