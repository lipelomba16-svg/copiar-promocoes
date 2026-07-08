import crypto from 'crypto';

export function createShopeeClient({ appId, secret, endpoint = 'https://open-api.affiliate.shopee.com.br/graphql' }) {
  function authHeader(payload) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = crypto.createHash('sha256').update(`${appId}${timestamp}${payload}${secret}`).digest('hex');
    return `SHA256 Credential=${appId}, Timestamp=${timestamp}, Signature=${signature}`;
  }

  async function graphql(query) {
    const payload = JSON.stringify({ query });
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: authHeader(payload)
      },
      body: payload,
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error(`Shopee HTTP ${response.status}`);
    return response.json();
  }

  return {
    async testConnection() {
      try {
        const data = await graphql('{ productOfferV2(keyword: "teste", limit: 1) { nodes { productName } } }');
        if (data?.errors?.length) return { valid: false, error: data.errors[0]?.message || 'Erro Shopee' };
        return { valid: true };
      } catch (error) {
        return { valid: false, error: error.message || String(error) };
      }
    },
    async getProductByIdentity(shopId, itemId) {
      const data = await graphql(`{ productOfferV2(shopId: ${Number(shopId)}, itemId: ${Number(itemId)}) { nodes { productName price imageUrl productLink offerLink itemId shopId } } }`);
      return data?.data?.productOfferV2?.nodes?.[0] || null;
    },
    async lookupProductByUrl(url) {
      const data = await graphql(`{ productOfferV2(keyword: "${String(url || '').replace(/"/g, '')}", limit: 1, listType: 0) { nodes { productName price imageUrl productLink offerLink itemId shopId } } }`);
      return data?.data?.productOfferV2?.nodes?.[0] || null;
    },
    async generateShortLink(url) {
      const data = await graphql(`mutation { generateShortLink(input: { originUrl: "${String(url || '').replace(/"/g, '')}" }) { shortLink } }`);
      return data?.data?.generateShortLink?.shortLink || null;
    }
  };
}

export function parseShopeeIdentityFromUrl(url = '') {
  const patterns = [
    /\/product\/(\d+)\/(\d+)/i,
    /-i\.(\d+)\.(\d+)/i,
    /\/(\d+)\/(\d+)(?:[/?#]|$)/i
  ];
  for (const pattern of patterns) {
    const match = String(url || '').match(pattern);
    if (match) {
      return {
        shopId: match[1],
        itemId: match[2],
        canonicalUrl: `https://shopee.com.br/product/${match[1]}/${match[2]}`
      };
    }
  }
  return null;
}

export async function resolveShopeeUrlForIdentity(url = '') {
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'user-agent': 'Mozilla/5.0',
        accept: 'text/html,application/xhtml+xml'
      },
      signal: AbortSignal.timeout(15000)
    });
    const html = await response.text().catch(() => '');
    const canonical = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)/i)?.[1] || '';
    return {
      finalUrl: response.url || url,
      canonicalUrl: canonical || response.url || url
    };
  } catch {
    return { finalUrl: url, canonicalUrl: url };
  }
}
