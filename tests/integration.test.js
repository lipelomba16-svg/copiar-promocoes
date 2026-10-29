import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

// Isolar o estado: o store resolve data/local-store.json a partir do
// cwd no momento do import. Mudar o cwd ANTES dos imports dinâmicos.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-promo-test-'));
process.chdir(tmpDir);

const { getState } = await import('../src/lib/store.js');
const { copyPromoService } = await import('../src/services/copyPromoService.js');
const { providerService } = await import('../src/services/providerService.js');
const { whatsappService } = await import('../src/services/whatsappService.js');

// --- Stub de rede: nenhum provedor real é chamado ---
let mlCreateLinkBehavior = 'ok';
let mlLastCreateLinkBody = null;
let siteStripeBehavior = 'ok';
const fetchCalls = [];

function makeResponse({ status = 200, url = '', jsonData = {}, location = '' }) {
  return {
    status,
    ok: status >= 200 && status < 300,
    url,
    headers: { get: (name) => (name.toLowerCase() === 'location' ? location : null) },
    json: async () => jsonData,
    text: async () => ''
  };
}

globalThis.fetch = async (url, options = {}) => {
  const href = String(url);
  fetchCalls.push(href);
  if (href.startsWith('https://meli.la/')) {
    return makeResponse({ status: 302, location: 'https://www.mercadolivre.com.br/produto/MLB-123', url: href });
  }
  if (href === 'https://ml.test/createLink') {
    mlLastCreateLinkBody = JSON.parse(options.body || '{}');
    if (mlCreateLinkBehavior === 'empty') return makeResponse({ status: 200, jsonData: { urls: [] } });
    return makeResponse({ status: 200, jsonData: { urls: [{ short_url: 'https://mercadolivre.com.br/sec/AFF-ML' }] } });
  }
  if (href.includes('associates/sitestripe/getShortUrl')) {
    if (siteStripeBehavior === 'empty') return makeResponse({ status: 200, jsonData: {} });
    return makeResponse({ status: 200, jsonData: { shortUrl: 'https://amzn.to/AFF123' } });
  }
  if (href.includes('mercadolivre.com.br/produto/')) {
    return makeResponse({ status: 200, url: href, jsonData: {} });
  }
  if (href === 'https://www.amazon.com.br/dp/B0DCLPDVBM') {
    return makeResponse({ status: 200, url: href, jsonData: {} });
  }
  if (href.includes('open-api.affiliate.shopee.com.br')) {
    const body = JSON.parse(options.body || '{}');
    if (body.query?.includes('generateShortLink')) {
      return makeResponse({ status: 200, jsonData: { data: { generateShortLink: { shortLink: 'https://shope.ee/AFF-SHOPEE' } } } });
    }
    if (body.query?.includes('productOfferV2')) {
      return makeResponse({ status: 200, jsonData: { data: { productOfferV2: { nodes: [{ productName: 'Produto Shopee', price: '10', imageUrl: 'https://img.test/p.jpg', productLink: 'https://shopee.com.br/product/1/2', offerLink: 'https://shope.ee/OFFER' }] } } } });
    }
    return makeResponse({ status: 200, jsonData: { data: {} } });
  }
  if (href.startsWith('https://shopee.com.br/') || href.startsWith('https://shope.ee/')) {
    return makeResponse({ status: 200, url: 'https://shopee.com.br/product/1/2', jsonData: {}, location: '' });
  }
  if (href.includes('aliexpress')) {
    return makeResponse({ status: 200, jsonData: { aliexpress_affiliate_link_generate_response: { resp_result: { result: { promotion_links: { promotion_link: [{ promotion_link: 'https://s.click.aliexpress.com/e/AFF-AE' }] } } } } } });
  }
  return makeResponse({ status: 404, jsonData: {} });
};

// --- Stub de envio: sem WhatsApp real ---
const sent = [];
whatsappService.sendMessage = async (jid, text, imageUrl, options = {}) => {
  sent.push({ jid, text, imageUrl, options });
  return { mode: 'text' };
};

async function seedProviders() {
  await providerService.saveProvider('mercadolivre', {
    affiliateTag: 'tag-ml', cookie: 'cookie-ml', csrfToken: 'csrf-ml',
    createLinkUrl: 'https://ml.test/createLink', listReplacementUrl: '', isActive: true
  });
  await providerService.saveProvider('amazon', { affiliateTag: 'suatag-20', cookies: 'cookie-amz', isActive: true });
  await providerService.saveProvider('shopee', { appId: 'app-1', secret: 'secret-shopee', endpoint: 'https://open-api.affiliate.shopee.com.br/graphql', isActive: true });
  await providerService.saveProvider('aliexpress', { appKey: 'key-ae', appSecret: 'secret-ae', trackingId: 'track-1', endpoint: 'https://api-sg.aliexpress.com/sync', isActive: true });
}

let config;
let group;

describe('integração CopyPromo (store local isolado, rede stubada)', () => {
  it('seed: credenciais salvas criptografadas e mascaradas na leitura', async () => {
    await seedProviders();
    const masked = await providerService.getConfig('shopee');
    assert.ok(!JSON.stringify(masked).includes('secret-shopee'), 'segredo não pode vazar na leitura mascarada');
    assert.ok(masked.secretPreview.startsWith('secr'));
    const decrypted = await providerService.getDecryptedConfig('shopee');
    assert.equal(decrypted.secret, 'secret-shopee');
    group = await copyPromoService.saveGroup({
      groupName: 'Partição Teste',
      groupIdentifiers: ['999@g.us'],
      useNativeLinkPreview: false
    });
    config = await copyPromoService.saveConfig({
      name: 'CP Teste', sourceGroupId: '111@g.us', sourceGroupName: 'Grupo Original',
      targetGroupId: group.id, isActive: true
    });
    assert.ok(config.webhookToken);
    assert.equal(config.copiedCount, 0);
  });

  it('ML: converte, preserva legenda, remove telegram/assinatura, envia com imagem e registra preço/cupom', async () => {
    sent.length = 0;
    const result = await copyPromoService.processConfig(config.id, {
      text: '🔥 *Fone* De R$ 199,90 por R$ 99,90 cupom ABC10\n\nhttps://meli.la/abc\n\nSiga: https://t.me/grupo\nGrupo Original',
      imageUrl: 'https://img.test/foto.jpg',
      remoteJid: '111@g.us',
      sourceGroupId: '111@g.us',
      sourceGroupName: 'Grupo Original',
      messageId: 'msg-1'
    });
    assert.equal(result.success, true);
    assert.equal(result.sent, 1);
    assert.equal(sent.length, 1);
    assert.ok(sent[0].text.includes('🔥 *Fone*'));
    assert.ok(sent[0].text.includes('https://mercadolivre.com.br/sec/AFF-ML'));
    assert.ok(!sent[0].text.includes('t.me'));
    assert.ok(!sent[0].text.includes('meli.la'));
    assert.equal(sent[0].imageUrl, 'https://img.test/foto.jpg');
    // meli.la resolvido para o produto real antes de createLink:
    assert.deepEqual(mlLastCreateLinkBody.urls, ['https://www.mercadolivre.com.br/produto/MLB-123']);
    const logs = await copyPromoService.getLogs(10);
    assert.equal(logs[0].status, 'sent');
    assert.equal(logs[0].price, 'R$ 99,90');
    assert.equal(logs[0].oldPrice, 'R$ 199,90');
    assert.equal(logs[0].coupon, 'ABC10');
    const updated = (await copyPromoService.listConfigs()).find((c) => c.id === config.id);
    assert.equal(updated.sentCount, 1);
    assert.equal(updated.lastStatus, 'success');
  });

  it('ML: createLink 200 sem link válido -> failed, sem envio de link comum', async () => {
    mlCreateLinkBehavior = 'empty';
    sent.length = 0;
    try {
      const result = await copyPromoService.processConfig(config.id, {
        text: 'Oferta https://meli.la/xyz', remoteJid: '111@g.us', sourceGroupId: '111@g.us', messageId: 'msg-2'
      });
      assert.equal(result.success, false);
      assert.equal(sent.length, 0);
      const logs = await copyPromoService.getLogs(10);
      assert.equal(logs[0].status, 'failed');
      assert.match(logs[0].error, /sem link válido/);
    } finally {
      mlCreateLinkBehavior = 'ok';
    }
  });

  it('Amazon: shortlink real do SiteStripe, nunca URL com tag', async () => {
    sent.length = 0;
    const result = await copyPromoService.processConfig(config.id, {
      text: 'Oferta Amazon https://www.amazon.com.br/dp/B0ABC12345', remoteJid: '111@g.us', sourceGroupId: '111@g.us', messageId: 'msg-3'
    });
    assert.equal(result.success, true);
    assert.ok(sent[0].text.includes('https://amzn.to/AFF123'));
    assert.ok(!sent[0].text.includes('tag=suatag-20'));
    assert.ok(!sent[0].text.includes('/dp/B0ABC12345'));
  });

  it('Amazon: SiteStripe sem shortUrl -> failed com mensagem clara', async () => {
    siteStripeBehavior = 'empty';
    sent.length = 0;
    try {
      const result = await copyPromoService.processConfig(config.id, {
        text: 'Oferta https://www.amazon.com.br/dp/B0ABC12345', remoteJid: '111@g.us', sourceGroupId: '111@g.us', messageId: 'msg-4'
      });
      assert.equal(result.success, false);
      assert.equal(sent.length, 0);
      const logs = await copyPromoService.getLogs(10);
      assert.match(logs[0].error, /SiteStripe HTTP 200; shortUrl ausente/);
    } finally {
      siteStripeBehavior = 'ok';
    }
  });

  it('AliExpress: promotion_link real da TOP API', async () => {
    const result = await providerService.affiliateForUrl('https://s.click.aliexpress.com/e/abc');
    assert.equal(result.provider, 'aliexpress');
    assert.equal(result.affiliateUrl, 'https://s.click.aliexpress.com/e/AFF-AE');
  });

  it('webhook em lote: processa cada entrada de messages; fromMe é ignorado', async () => {
    sent.length = 0;
    const result = await copyPromoService.handleWebhook(config.webhookToken, {
      messages: [
        { text: 'Promo 1 https://meli.la/1', remoteJid: '111@g.us', id: 'w1' },
        { text: 'Promo 2 https://shope.ee/2', remoteJid: '111@g.us', id: 'w2' },
        { text: 'Minha https://meli.la/3', remoteJid: '111@g.us', id: 'w3', fromMe: true }
      ]
    });
    assert.equal(result.processed, 3);
    assert.equal(result.sent, 2);
    assert.equal(sent.length, 2);
    // Shopee sem cupom ganha a nota padrão:
    assert.ok(sent[1].text.endsWith('cupom: Aplicável na hora da compra!'));
  });

  it('saveConfig em edição preserva webhookToken e contadores', async () => {
    const before = (await copyPromoService.listConfigs()).find((c) => c.id === config.id);
    const updated = await copyPromoService.saveConfig({ id: config.id, isActive: false });
    assert.equal(updated.webhookToken, before.webhookToken);
    assert.equal(updated.sentCount, before.sentCount);
    assert.equal(updated.isActive, false);
    await copyPromoService.saveConfig({ id: config.id, isActive: true });
  });

  it('saveProvider em branco preserva o segredo salvo', async () => {
    await providerService.saveProvider('shopee', { endpoint: 'https://open-api.affiliate.shopee.com.br/graphql', isActive: true });
    const decrypted = await providerService.getDecryptedConfig('shopee');
    assert.equal(decrypted.secret, 'secret-shopee');
  });

  it('listener: mensagem Baileys de grupo é processada; fromMe e DM são ignorados', async () => {
    sent.length = 0;
    await whatsappService.handleIncomingMessage({
      key: { remoteJid: '111@g.us', id: 'live-1', fromMe: false },
      message: { imageMessage: { caption: 'Ao vivo https://meli.la/live', url: 'https://img.test/live.jpg' } },
      pushName: 'Grupo Original'
    });
    assert.equal(sent.length, 1);
    assert.ok(sent[0].text.includes('https://mercadolivre.com.br/sec/AFF-ML'));
    await whatsappService.handleIncomingMessage({
      key: { remoteJid: '111@g.us', id: 'live-2', fromMe: true },
      message: { conversation: 'Minha https://meli.la/x' }
    });
    await whatsappService.handleIncomingMessage({
      key: { remoteJid: '5511999999999@s.whatsapp.net', id: 'live-3', fromMe: false },
      message: { conversation: 'DM https://meli.la/x' }
    });
    assert.equal(sent.length, 1);
  });

  it('newsletter detectada numa mensagem é preservada; origem manual valida JID', async () => {
    await whatsappService.handleIncomingMessage({
      key: { remoteJid: '222@newsletter', id: 'live-n1', fromMe: false },
      message: { conversation: 'Sem link aqui' }
    });
    const status = await whatsappService.getStatus();
    assert.ok(status.newsletters.some((n) => n.id === '222@newsletter'));
    const entry = whatsappService.addManualSource('333@newsletter', 'Canal Manual');
    assert.equal(entry.type, 'newsletter');
    assert.throws(() => whatsappService.addManualSource('https://chat.whatsapp.com/abc'), /não pode ser salvo como origem/);
  });

  it('duplicata não reenvia', async () => {
    sent.length = 0;
    const payload = { text: 'Dup https://meli.la/dup', remoteJid: '111@g.us', sourceGroupId: '111@g.us', messageId: 'dup-1' };
    assert.equal((await copyPromoService.processConfig(config.id, payload)).sent, 1);
    assert.equal((await copyPromoService.processConfig(config.id, payload)).skipped, true);
    assert.equal(sent.length, 1);
  });
});
