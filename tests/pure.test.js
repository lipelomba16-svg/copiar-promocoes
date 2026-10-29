import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildFinalCaption, extractProductInfo, extractUrls, isGroupOrNewsletterJid, parseManualSource, providerFromUrl } from '../src/lib/promoText.js';
import { assignProvidersToItems, buildDiagnostics, interleaveProviders, providerRegistry, validateAutoSearchConfig } from '../src/services/autoSearch.js';
import { isEncryptedFormat, maskSecret } from '../src/lib/secrets.js';

describe('providerFromUrl / extractUrls', () => {
  it('identifica os 4 provedores e encurtadores', () => {
    assert.equal(providerFromUrl('https://www.mercadolivre.com.br/produto/MLB-1'), 'mercadolivre');
    assert.equal(providerFromUrl('https://meli.la/abc'), 'mercadolivre');
    assert.equal(providerFromUrl('https://shopee.com.br/produto-i.1.2'), 'shopee');
    assert.equal(providerFromUrl('https://shope.ee/abc'), 'shopee');
    assert.equal(providerFromUrl('https://www.amazon.com.br/dp/B0ABC12345'), 'amazon');
    assert.equal(providerFromUrl('https://amzn.to/abc'), 'amazon');
    assert.equal(providerFromUrl('https://a.co/d/abc'), 'amazon');
    assert.equal(providerFromUrl('https://pt.aliexpress.com/item/1.html'), 'aliexpress');
    assert.equal(providerFromUrl('https://s.click.aliexpress.com/e/abc'), 'aliexpress');
    assert.equal(providerFromUrl('https://ali.pub/abc'), 'aliexpress');
    assert.equal(providerFromUrl('https://mercadolivre.com.br.evil.com/x'), 'unknown');
    assert.equal(providerFromUrl('https://t.me/grupo'), 'unknown');
  });
  it('extractUrls limpa pontuação final e deduplica', () => {
    assert.deepEqual(extractUrls('Veja https://meli.la/abc. E https://meli.la/abc!'), ['https://meli.la/abc']);
  });
});

describe('buildFinalCaption', () => {
  it('preserva legenda, substitui só o permitido e remove telegram/assinatura', () => {
    const text = '🔥 *OFERTA*  R$ 99,90\n\nFone top\nhttps://meli.la/abc123\n\nSiga nosso canal: https://t.me/grupo\nGrupo de Promoções Top';
    const result = buildFinalCaption(text, new Map([['https://meli.la/abc123', 'https://mercadolivre.com.br/sec/AFF']]), 'Grupo de Promoções Top');
    assert.ok(result.caption.includes('🔥 *OFERTA*  R$ 99,90'));
    assert.ok(result.caption.includes('https://mercadolivre.com.br/sec/AFF'));
    assert.ok(!result.caption.includes('t.me'));
    assert.ok(!result.caption.includes('Grupo de Promoções Top'));
    assert.equal(result.replacedCount, 1);
  });
  it('remove link não permitido inline e link permitido sem afiliado', () => {
    const result = buildFinalCaption('Oferta https://exemplo.com/x e https://meli.la/1 fim', new Map());
    assert.equal(result.caption, 'Oferta  e  fim');
    assert.deepEqual(result.removedUrls, ['https://exemplo.com/x', 'https://meli.la/1']);
    assert.deepEqual(result.affiliateUrlsInCaption, []);
  });
  it('substitui todos os links individualmente', () => {
    const result = buildFinalCaption('A https://meli.la/1 B https://shope.ee/2', new Map([
      ['https://meli.la/1', 'https://mercadolivre.com.br/sec/A'],
      ['https://shope.ee/2', 'https://shope.ee/B']
    ]));
    assert.equal(result.replacedCount, 2);
    assert.ok(result.caption.includes('https://shope.ee/B'));
  });
  it('extrai preço antigo/atual e cupom só para o log', () => {
    const info = extractProductInfo('Fone Top\nDe R$ 199,90 por R$ 99,90\ncupom: ABC10');
    assert.equal(info.oldPrice, 'R$ 199,90');
    assert.equal(info.price, 'R$ 99,90');
    assert.equal(info.coupon, 'ABC10');
    assert.equal(info.productName, 'Fone Top');
  });
});

describe('origens WhatsApp', () => {
  it('só @g.us e @newsletter', () => {
    assert.equal(isGroupOrNewsletterJid('111@g.us'), true);
    assert.equal(isGroupOrNewsletterJid('111@newsletter'), true);
    assert.equal(isGroupOrNewsletterJid('5511999999999@s.whatsapp.net'), false);
  });
  it('parseManualSource', () => {
    assert.deepEqual(parseManualSource('111@g.us'), { kind: 'jid', jid: '111@g.us' });
    assert.equal(parseManualSource('https://chat.whatsapp.com/abc').kind, 'invite');
    assert.equal(parseManualSource('111').kind, 'invalid');
  });
});

describe('secrets', () => {
  it('formato criptografado e máscara', () => {
    assert.equal(isEncryptedFormat('a'.repeat(32) + ':' + 'b'.repeat(32)), true);
    assert.equal(isEncryptedFormat('texto-claro'), false);
    assert.equal(maskSecret('suatag-20'), 'suat*****');
  });
});

describe('AutoSearch / Compare', () => {
  it('registry tem os 4 provedores', () => {
    assert.deepEqual(Object.keys(providerRegistry).sort(), ['aliexpress', 'amazon', 'mercadolivre', 'shopee']);
  });
  it('intercala 1 de cada, repetindo', () => {
    assert.deepEqual(
      interleaveProviders(['shopee', 'mercadolivre', 'aliexpress', 'amazon'], 8),
      ['shopee', 'mercadolivre', 'aliexpress', 'amazon', 'shopee', 'mercadolivre', 'aliexpress', 'amazon']
    );
    assert.deepEqual(assignProvidersToItems(['a', 'b', 'c'], ['amazon', 'aliexpress']).map((x) => x.provider), ['aliexpress', 'amazon', 'aliexpress']);
  });
  it('validação exige primary entre os habilitados', () => {
    assert.equal(validateAutoSearchConfig({ primaryProvider: 'amazon', providersEnabled: ['shopee'] }).ok, false);
    assert.equal(validateAutoSearchConfig({ primaryProvider: 'amazon', providersEnabled: ['shopee', 'amazon'] }).ok, true);
  });
  it('diagnóstico: Amazon sem cookie não está pronta', () => {
    const diagnostics = buildDiagnostics({
      shopee: { appId: '1', secret: 's', isActive: true },
      mercadolivre: { affiliateTag: 't', cookie: 'c', isActive: true },
      aliexpress: { appKey: '', appSecret: '', trackingId: '', isActive: false },
      amazon: { affiliateTag: 'tag-20', cookies: '', isActive: true }
    });
    assert.equal(diagnostics.find((d) => d.provider === 'amazon').ready, false);
    assert.equal(diagnostics.find((d) => d.provider === 'shopee').ready, true);
    assert.equal(diagnostics.length, 4);
  });
});
