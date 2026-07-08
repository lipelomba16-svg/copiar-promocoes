import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { getMongoStatus, loadSnapshotFromMongo, writeSnapshotToMongo } from './mongoBridge.js';

const storageFile = path.join(process.cwd(), 'data', 'local-store.json');

const defaultState = () => ({
  version: 1,
  settings: {
    security: { encryptionKey: crypto.randomBytes(32).toString('hex') },
    mongo: {
      enabled: false,
      uri: '',
      databaseName: '',
      lastTestAt: '',
      lastStatus: 'not_configured',
      lastError: ''
    },
    providers: {
      shopee: { appId: '', secret: '', endpoint: 'https://open-api.affiliate.shopee.com.br/graphql', isActive: false },
      amazon: { affiliateTag: '', cookies: '', isActive: false },
      mercadolivre: { affiliateTag: '', cookie: '', csrfToken: '', listReplacementUrl: '', couponAlertImageUrl: '', createLinkUrl: '', isActive: false },
      aliexpress: { appKey: '', appSecret: '', trackingId: 'default', endpoint: 'https://api-sg.aliexpress.com/sync', isActive: false }
    }
  },
  groups: [],
  copyPromoConfigs: [],
  logs: [],
  sourceAnalysis: {
    envClassification: {
      requiredForCopyPromo: ['MONGODB_URI/MONGODB_URL', 'MONGODB_DNS_SERVERS', 'RENDER_INSTANCE_ID'],
      unrelatedOrNonessential: ['RESEND_API_KEY', 'RESEND_FROM_EMAIL', 'CAKTO_WEBHOOK_SECRET'],
      authOrPlatformOnly: ['SESSION_SECRET', 'PORT', 'VERBOSE_REQUEST_LOGS', 'NODE_ENV', 'VERCEL']
    }
  },
  __meta: {
    storageFile
  }
});

let stateCache = null;

async function ensureFile() {
  try {
    await fs.access(storageFile);
  } catch {
    await fs.mkdir(path.dirname(storageFile), { recursive: true });
    await fs.writeFile(storageFile, JSON.stringify(defaultState(), null, 2), 'utf8');
  }
}

export async function initializeStore() {
  if (stateCache) return stateCache;
  await ensureFile();
  const diskState = JSON.parse(await fs.readFile(storageFile, 'utf8'));
  if (getMongoStatus().connected) {
    const mongoState = await loadSnapshotFromMongo();
    stateCache = mongoState || diskState;
  } else {
    stateCache = diskState;
  }
  stateCache.__meta = { storageFile };
  return stateCache;
}

export async function getState() {
  return initializeStore();
}

export async function saveState(nextState) {
  stateCache = nextState;
  await fs.writeFile(storageFile, JSON.stringify(nextState, null, 2), 'utf8');
  if (getMongoStatus().connected) {
    await writeSnapshotToMongo(nextState);
  }
  return stateCache;
}
