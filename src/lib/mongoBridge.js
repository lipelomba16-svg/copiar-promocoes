import mongoose from 'mongoose';
import { getState, saveState } from './store.js';

let status = {
  connected: false,
  uri: '',
  databaseName: '',
  lastError: '',
  lastTestAt: ''
};

let SnapshotModel;

function ensureModel() {
  if (SnapshotModel) return SnapshotModel;
  const schema = new mongoose.Schema({
    key: { type: String, unique: true },
    payload: mongoose.Schema.Types.Mixed,
    updatedAt: Date
  }, { collection: 'copyPromoStandaloneSnapshots' });
  SnapshotModel = mongoose.models.CopyPromoStandaloneSnapshot || mongoose.model('CopyPromoStandaloneSnapshot', schema);
  return SnapshotModel;
}

export function getMongoStatus() {
  return {
    ...status,
    readyState: mongoose.connection.readyState
  };
}

export async function testMongoConnection(input) {
  const uri = String(input?.uri || '').trim();
  const databaseName = String(input?.databaseName || '').trim();
  if (!uri) return { ok: false, error: 'Informe a URI do MongoDB.' };
  const connection = await mongoose.createConnection(uri, {
    dbName: databaseName || undefined,
    serverSelectionTimeoutMS: 8000
  }).asPromise();
  await connection.db.admin().ping();
  await connection.close();
  status.lastTestAt = new Date().toISOString();
  status.lastError = '';
  return { ok: true, databaseName: connection.name || databaseName || '' };
}

export async function saveMongoSettings(input) {
  const state = await getState();
  state.settings.mongo = {
    enabled: !!input.enabled,
    uri: String(input.uri || '').trim(),
    databaseName: String(input.databaseName || '').trim(),
    lastTestAt: new Date().toISOString(),
    lastStatus: 'saved',
    lastError: ''
  };
  await saveState(state);
  if (state.settings.mongo.enabled && state.settings.mongo.uri) {
    await connectMongo(state.settings.mongo);
    await writeSnapshotToMongo(state);
  } else if (mongoose.connection.readyState) {
    await mongoose.disconnect();
    status.connected = false;
  }
  return { ok: true, mongo: getMongoStatus() };
}

async function connectMongo(settings) {
  if (!settings?.uri) return;
  if (mongoose.connection.readyState === 1 && status.uri === settings.uri && status.databaseName === settings.databaseName) {
    status.connected = true;
    return;
  }
  if (mongoose.connection.readyState) {
    await mongoose.disconnect();
  }
  await mongoose.connect(settings.uri, {
    dbName: settings.databaseName || undefined,
    serverSelectionTimeoutMS: 8000
  });
  ensureModel();
  status = {
    connected: true,
    uri: settings.uri,
    databaseName: settings.databaseName || mongoose.connection.name || '',
    lastError: '',
    lastTestAt: new Date().toISOString()
  };
}

export async function reconnectMongoFromSettings() {
  const state = await getState();
  if (state.settings.mongo.enabled && state.settings.mongo.uri) {
    try {
      await connectMongo(state.settings.mongo);
    } catch (error) {
      status.connected = false;
      status.lastError = error.message || String(error);
    }
  }
}

export async function writeSnapshotToMongo(payload) {
  ensureModel();
  if (!status.connected) return;
  await SnapshotModel.findOneAndUpdate(
    { key: 'local-single-user' },
    { $set: { payload, updatedAt: new Date() } },
    { upsert: true }
  );
}

export async function loadSnapshotFromMongo() {
  ensureModel();
  if (!status.connected) return null;
  const doc = await SnapshotModel.findOne({ key: 'local-single-user' }).lean();
  return doc?.payload || null;
}
