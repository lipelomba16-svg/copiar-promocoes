// Busca Automática / Compare — registro único dos 4 provedores.
// Não há fluxo separado por provider: um único fluxo usa o registro,
// intercala os provedores habilitados e sempre usa as credenciais
// salvas neste app (settings.providers), nunca globais.

export const PROVIDER_ORDER = ['shopee', 'mercadolivre', 'aliexpress', 'amazon'];

export const providerRegistry = {
  shopee: { id: 'shopee', label: 'Shopee', credentialKind: 'shopee' },
  mercadolivre: { id: 'mercadolivre', label: 'Mercado Livre', credentialKind: 'mercadolivre' },
  aliexpress: { id: 'aliexpress', label: 'AliExpress', credentialKind: 'aliexpress' },
  amazon: { id: 'amazon', label: 'Amazon', credentialKind: 'amazon' }
};

export function validateAutoSearchConfig(config = {}) {
  const errors = [];
  const enabled = [...new Set(config.providersEnabled || [])].filter((p) => PROVIDER_ORDER.includes(p));
  if (enabled.length === 0) errors.push('Selecione ao menos um provedor.');
  const primary = config.primaryProvider;
  if (primary && !PROVIDER_ORDER.includes(primary)) errors.push('primaryProvider inválido.');
  if (primary && enabled.length > 0 && !enabled.includes(primary)) errors.push('primaryProvider deve estar entre os provedores habilitados.');
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    errors: [],
    normalized: {
      primaryProvider: primary || enabled[0],
      providersEnabled: enabled,
      isActive: config.isActive !== false
    }
  };
}

// Rodízio: com os 4 habilitados, Shopee, Mercado Livre, AliExpress,
// Amazon, repetindo — 1 de cada. Com subconjunto, só os habilitados,
// na mesma ordem relativa.
export function interleaveProviders(providersEnabled, count, startIndex = 0) {
  const enabled = PROVIDER_ORDER.filter((p) => (providersEnabled || []).includes(p));
  if (!enabled.length || count <= 0) return [];
  return Array.from({ length: count }, (_, i) => enabled[(startIndex + i) % enabled.length]);
}

export function assignProvidersToItems(items, providersEnabled) {
  const sequence = interleaveProviders(providersEnabled, items.length);
  return items.map((item, index) => ({ item, provider: sequence[index] }));
}

function hasStoredSecret(value) {
  return typeof value === 'string' && value.trim() !== '' && value.trim() !== '****';
}

export function providerCredentialStatus(providers = {}) {
  const shopee = providers.shopee || {};
  const mercadolivre = providers.mercadolivre || {};
  const aliexpress = providers.aliexpress || {};
  const amazon = providers.amazon || {};
  return {
    shopee: {
      hasCredential: Boolean(shopee.appId && hasStoredSecret(shopee.secret)),
      isActive: !!shopee.isActive,
      cookieLength: 0
    },
    mercadolivre: {
      hasCredential: Boolean(mercadolivre.affiliateTag && hasStoredSecret(mercadolivre.cookie)),
      isActive: !!mercadolivre.isActive,
      cookieLength: 0
    },
    aliexpress: {
      hasCredential: Boolean(aliexpress.appKey && hasStoredSecret(aliexpress.appSecret) && aliexpress.trackingId),
      isActive: !!aliexpress.isActive,
      cookieLength: 0
    },
    amazon: {
      // Amazon: sem cookie, não está pronta — mesmo com tag salva.
      hasCredential: Boolean(amazon.affiliateTag && hasStoredSecret(amazon.cookies)),
      isActive: !!amazon.isActive,
      cookieLength: hasStoredSecret(amazon.cookies) ? 1 : 0
    }
  };
}

// Diagnóstico dos 4 provedores a partir do estado (valores brutos,
// sem descriptografar segredos: só presença + ativo).
export function buildDiagnostics(providers = {}) {
  const status = providerCredentialStatus(providers);
  return PROVIDER_ORDER.map((provider) => {
    const item = status[provider];
    return {
      provider,
      label: providerRegistry[provider].label,
      hasCredential: item.hasCredential,
      isActive: item.isActive,
      ready: item.hasCredential && item.isActive
    };
  });
}

export function getAutoSearchDiagnostics(state) {
  return buildDiagnostics(state?.settings?.providers || {});
}
