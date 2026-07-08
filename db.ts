import mongoose from 'mongoose';
import { Resolver } from 'node:dns/promises';
import dotenv from 'dotenv';

// Ensure env is loaded even when imported via ESM hoisting
dotenv.config();

const uri = process.env.MONGODB_URI || process.env.MONGODB_URL || '';
let fallbackMongoUriPromise: Promise<string> | null = null;

function shouldUseMongoFallback(error: any): boolean {
  const text = String(error?.message || error || '');
  return /querySrv|ENOTFOUND|ECONNREFUSED|ETIMEOUT/i.test(text);
}

async function buildMongoFallbackUri(sourceUri: string): Promise<string> {
  if (!sourceUri.startsWith('mongodb+srv://')) return sourceUri;

  const parsed = new URL(sourceUri);
  const resolver = new Resolver();
  const dnsServers = String(process.env.MONGODB_DNS_SERVERS || '1.1.1.1,8.8.8.8')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
  if (dnsServers.length > 0) resolver.setServers(dnsServers);

  const [srvRecords, txtRecords] = await Promise.all([
    resolver.resolveSrv(`_mongodb._tcp.${parsed.hostname}`),
    resolver.resolveTxt(parsed.hostname).catch(() => [])
  ]);
  if (!srvRecords.length) throw new Error(`Nenhum no SRV encontrado para ${parsed.hostname}`);

  const auth = parsed.username
    ? `${encodeURIComponent(parsed.username)}${parsed.password ? `:${encodeURIComponent(parsed.password)}` : ''}@`
    : '';
  const hosts = [...srvRecords]
    .sort((a, b) => a.priority - b.priority || b.weight - a.weight || a.name.localeCompare(b.name))
    .map(record => `${record.name}:${record.port}`)
    .join(',');

  const searchParams = new URLSearchParams(parsed.search);
  for (const row of txtRecords) {
    for (const chunk of row) {
      const params = new URLSearchParams(chunk);
      for (const [key, value] of params.entries()) {
        if (!searchParams.has(key)) searchParams.set(key, value);
      }
    }
  }
  if (!searchParams.has('ssl') && !searchParams.has('tls')) searchParams.set('ssl', 'true');
  const pathname = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname : '/';
  const query = searchParams.toString();
  return `mongodb://${auth}${hosts}${pathname}${query ? `?${query}` : ''}`;
}

export const connectDB = async () => {
  if (mongoose.connection.readyState === 1) return true;
  try {
    console.log('[DB] Conectando ao MongoDB Atlas...');
    await mongoose.connect(uri);
    console.log(">>> MongoDB Conectado com sucesso! <<<");
    return true;
  } catch (error: any) {
    if (uri.startsWith('mongodb+srv://') && shouldUseMongoFallback(error)) {
      try {
        fallbackMongoUriPromise = fallbackMongoUriPromise || buildMongoFallbackUri(uri);
        const fallbackUri = await fallbackMongoUriPromise;
        console.warn('[DB] Falha no mongodb+srv. Tentando URI direta com DNS publico...');
        await mongoose.connect(fallbackUri);
        console.log('>>> MongoDB Conectado com fallback DNS! <<<');
        return true;
      } catch (fallbackError: any) {
        console.error('--- ERRO DE CONEXAO MONGODB (fallback) ---');
        console.error(fallbackError.message);
        return false;
      }
    }
    console.error("--- ERRO DE CONEXAO MONGODB ---");
    console.error(error.message);
    return false;
  }
};

export const getDbError = () => null;

// Cast models and schemas below...
const M: any = mongoose;

export const User = M.models.User || M.model('User', new M.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  passwordHash: { type: String },
  avatar: { type: String },
  googleId: { type: String },
  provider: { type: String, default: 'local' },
  role: { type: String, enum: ['user', 'admin'], default: 'user' },
  isEmailVerified: { type: Boolean, default: false },
  verificationCode: String,
  verificationCodeExpiresAt: Date,
  verificationCodeSentAt: Date,
  verificationAttempts: { type: Number, default: 0 },
  passwordResetCode: String,
  passwordResetExpiresAt: Date,
  passwordResetSentAt: Date,
  passwordResetAttempts: { type: Number, default: 0 },
  onboardingCompleted: { type: Boolean, default: false },
  learningTrack: String,
  subTrack: String,
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}));

export const Session = M.models.Session || M.model('Session', new M.Schema({
  userId: { type: M.Schema.Types.ObjectId, ref: 'User', required: true },
  token: { type: String, required: true, unique: true },
  expiresAt: { type: Date, required: true },
  createdAt: { type: Date, default: Date.now }
}));

export const UserProfile = M.models.UserProfile || M.model('UserProfile', new M.Schema({
  userId: { type: M.Schema.Types.ObjectId, ref: 'User', required: true },
  bio: String,
  socialLinks: {
    instagram: String,
    twitter: String,
    linkedin: String
  },
  preferences: {
    notifications: { type: Boolean, default: true },
    theme: { type: String, default: 'dark' },
    backgroundMode: { type: String, enum: ['animated', 'static'], default: 'animated' },
    backgroundAnimationMode: { type: Number, default: 3 },
    backgroundPalette: { type: Number, default: 2 },
    backgroundStaticColor: { type: String, default: '#030305' }
  },
  updatedAt: { type: Date, default: Date.now }
}));

export const PlanTemplate = M.models.PlanTemplate || M.model('PlanTemplate', new M.Schema({
  _id: { type: String, required: true },
  title: { type: String, required: true },
  description: String,
  goalBrl: { type: Number, required: true },
  timeMinDay: { type: Number, required: true },
  experience: { type: String, enum: ['iniciante', 'intermediario', 'avancado'], default: 'iniciante' },
  primaryTrack: { type: String, required: true }, // 'Marketplace', 'Afiliado', etc.
  createdAt: { type: Date, default: Date.now }
}));

export const PlanDay = M.models.PlanDay || M.model('PlanDay', new M.Schema({
  planTemplateId: { type: String, ref: 'PlanTemplate', required: true },
  dayNumber: { type: Number, required: true },
  title: { type: String, required: true },
  goal: String,
  tasks: [{
    title: { type: String, required: true },
    details: String,
    isCompleted: { type: Boolean, default: false }
  }]
}));

export const UserPlan = M.models.UserPlan || M.model('UserPlan', new M.Schema({
  userId: { type: M.Schema.Types.ObjectId, ref: 'User', required: true },
  planTemplateId: { type: String, ref: 'PlanTemplate', required: true },
  currentDay: { type: Number, default: 1 },
  startDate: { type: Date, default: Date.now },
  status: { type: String, enum: ['active', 'completed', 'paused'], default: 'active' }
}));

export const UserTask = M.models.UserTask || M.model('UserTask', new M.Schema({
  userId: { type: M.Schema.Types.ObjectId, ref: 'User', required: true },
  dayNumber: { type: Number, required: true },
  taskIndex: { type: Number, required: true },
  isCompleted: { type: Boolean, default: false },
  completedAt: Date
}));

export const CRMLead = M.models.CRMLead || M.model('CRMLead', new M.Schema({
  userId: { type: M.Schema.Types.ObjectId, ref: 'User', required: true },
  name: { type: String, required: true },
  email: String,
  phone: String,
  status: { type: String, enum: ['novo', 'contatado', 'negociando', 'fechado', 'perdido'], default: 'novo' },
  value: { type: Number, default: 0 },
  notes: String,
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}));

export const Alert = M.models.Alert || M.model('Alert', new M.Schema({
  userId: { type: M.Schema.Types.ObjectId, ref: 'User', required: true },
  title: { type: String, required: true },
  message: { type: String, required: true },
  type: { type: String, enum: ['info', 'warning', 'success', 'danger'], default: 'info' },
  isRead: { type: Boolean, default: false },
  link: String,
  createdAt: { type: Date, default: Date.now }
}));

export const AffiliateLink = M.models.AffiliateLink || M.model('AffiliateLink', new M.Schema({
  userId: { type: M.Schema.Types.ObjectId, ref: 'User', required: true },
  name: { type: String, required: true },
  originalUrl: { type: String, required: true },
  shortCode: { type: String, required: true, unique: true },
  platform: String,
  clicks: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
}));

export const AffiliateClick = M.models.AffiliateClick || M.model('AffiliateClick', new M.Schema({
  linkId: { type: M.Schema.Types.ObjectId, ref: 'AffiliateLink', required: true },
  affiliateLinkId: { type: M.Schema.Types.ObjectId, ref: 'AffiliateLink' },
  ip: String,
  userAgent: String,
  referrer: String,
  createdAt: { type: Date, default: Date.now }
}));

export const AffiliateEarning = M.models.AffiliateEarning || M.model('AffiliateEarning', new M.Schema({
  userId: { type: M.Schema.Types.ObjectId, ref: 'User', required: true },
  amountBrl: { type: Number, required: true },
  source: String,
  status: { type: String, enum: ['pending', 'available', 'withdrawn'], default: 'pending' },
  createdAt: { type: Date, default: Date.now }
}));

export const UserMetric = M.models.UserMetric || M.model('UserMetric', new M.Schema({
  userId: { type: M.Schema.Types.ObjectId, ref: 'User', required: true },
  type: { type: String, required: true }, // 'revenue', 'engagement', etc.
  value: { type: Number, required: true },
  date: { type: Date, default: Date.now }
}));

export const UserAction = M.models.UserAction || M.model('UserAction', new M.Schema({
  userId: { type: M.Schema.Types.ObjectId, ref: 'User', required: true },
  action: { type: String, required: true },
  details: M.Schema.Types.Mixed,
  createdAt: { type: Date, default: Date.now }
}));

export const Subscription = M.models.Subscription || M.model('Subscription', new M.Schema({
  userId: { type: M.Schema.Types.ObjectId, ref: 'User' },
  email: { type: String, required: true },
  planType: String,
  planId: String,
  status: { type: String, enum: ['active', 'canceled', 'past_due', 'pending'], default: 'active' },
  provider: { type: String, default: 'cakto' },
  externalId: String,
  startDate: Date,
  currentPeriodEnd: Date,
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}));

export const UserEntitlement = M.models.UserEntitlement || M.model('UserEntitlement', new M.Schema({
  userId: { type: M.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  hasAccess: { type: Boolean, default: false },
  reason: String,
  updatedAt: { type: Date, default: Date.now }
}));

export const LearningTrack = M.models.LearningTrack || M.model('LearningTrack', new M.Schema({
  _id: { type: String, required: true },
  title: { type: String, required: true },
  description: String,
  category: String,
  subCategory: String,
  level: String,
  iconSlug: String,
  tags: [String],
  createdAt: { type: Date, default: Date.now }
}));

export const Lesson = M.models.Lesson || M.model('Lesson', new M.Schema({
  trackId: { type: String, ref: 'LearningTrack', required: true },
  title: { type: String, required: true },
  youtubeUrl: String,
  durationLabel: String,
  level: String,
  tags: [String],
  createdAt: { type: Date, default: Date.now }
}));

export const ActionPlan = M.models.ActionPlan || M.model('ActionPlan', new M.Schema({
  trackId: { type: String, ref: 'LearningTrack', required: true },
  dayNumber: { type: Number, required: true },
  title: { type: String, required: true },
  goal: String,
  tasks: [{
    title: String,
    description: String,
    estimatedTime: String,
    relatedLessonId: { type: M.Schema.Types.ObjectId, ref: 'Lesson' }
  }],
  createdAt: { type: Date, default: Date.now }
}));

export const AIHistory = M.models.AIHistory || M.model('AIHistory', new M.Schema({
  userId: { type: M.Schema.Types.ObjectId, ref: 'User', required: true },
  prompt: String,
  response: String,
  type: String,
  createdAt: { type: Date, default: Date.now }
}));

export const Transaction = M.models.Transaction || M.model('Transaction', new M.Schema({
  userId: { type: M.Schema.Types.ObjectId, ref: 'User', required: true },
  amount: Number,
  type: { type: String, enum: ['in', 'out'] },
  category: String,
  description: String,
  date: { type: Date, default: Date.now }
}));

export const CommunityPost = M.models.CommunityPost || M.model('CommunityPost', new M.Schema({
  userId: { type: M.Schema.Types.ObjectId, ref: 'User', required: true },
  trackId: String,
  title: String,
  content: String,
  likes: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
}));

export const Comment = M.models.Comment || M.model('Comment', new M.Schema({
  userId: { type: M.Schema.Types.ObjectId, ref: 'User', required: true },
  postId: { type: M.Schema.Types.ObjectId, ref: 'CommunityPost', required: true },
  content: String,
  createdAt: { type: Date, default: Date.now }
}));

export const SupportTicket = M.models.SupportTicket || M.model('SupportTicket', new M.Schema({
  userId: { type: M.Schema.Types.ObjectId, ref: 'User', required: true },
  subject: String,
  message: String,
  status: { type: String, enum: ['open', 'closed'], default: 'open' },
  createdAt: { type: Date, default: Date.now }
}));

export const UserRoutine = M.models.UserRoutine || M.model('UserRoutine', new M.Schema({
  userId: { type: M.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  items: [{
    time: String,
    task: String,
    completed: { type: Boolean, default: false }
  }]
}));

export const AdminOverride = M.models.AdminOverride || M.model('AdminOverride', new M.Schema({
  userId: { type: M.Schema.Types.ObjectId, ref: 'User', required: true },
  targetUserId: { type: M.Schema.Types.ObjectId, ref: 'User', required: true },
  action: String,
  createdAt: { type: Date, default: Date.now }
}));

export const AgendaEvent = M.models.AgendaEvent || M.model('AgendaEvent', new M.Schema({
  userId: { type: M.Schema.Types.ObjectId, ref: 'User', required: true },
  title: { type: String, required: true },
  date: { type: Date, required: true },
  type: { type: String, enum: ['work', 'meeting', 'rest'], default: 'work' },
  completed: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
}));

export const DailyMetric = M.models.DailyMetric || M.model('DailyMetric', new M.Schema({
  userId: { type: M.Schema.Types.ObjectId, ref: 'User', required: true },
  date: { type: Date, required: true },
  revenue: { type: Number, default: 0 },
  clicks: { type: Number, default: 0 },
  leads: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
}));

export const LibraryProgress = M.models.LibraryProgress || M.model('LibraryProgress', new M.Schema({
  userId: { type: M.Schema.Types.ObjectId, ref: 'User', required: true },
  contentId: { type: String, required: true },
  status: { type: String, enum: ['locked', 'available', 'completed'], default: 'locked' },
  updatedAt: { type: Date, default: Date.now }
}));

export const ToolData = M.models.ToolData || M.model('ToolData', new M.Schema({
  userId: { type: M.Schema.Types.ObjectId, ref: 'User', required: true },
  toolId: { type: String, required: true },
  data: M.Schema.Types.Mixed,
  updatedAt: { type: Date, default: Date.now }
}));

export const AssetInteraction = M.models.AssetInteraction || M.model('AssetInteraction', new M.Schema({
  userId: { type: M.Schema.Types.ObjectId, ref: 'User', required: true },
  assetId: { type: String, required: true },
  type: { type: String, enum: ['view', 'download'], default: 'view' },
  createdAt: { type: Date, default: Date.now }
}));

export const MarketTrend = M.models.MarketTrend || M.model('MarketTrend', new M.Schema({
  keyword: String,
  score: Number,
  category: String,
  updatedAt: { type: Date, default: Date.now }
}));

export const MarketCalc = M.models.MarketCalc || M.model('MarketCalc', new M.Schema({
  userId: { type: M.Schema.Types.ObjectId, ref: 'User' },
  productName: String,
  cost: Number,
  sellingPrice: Number,
  margin: Number,
  createdAt: { type: Date, default: Date.now }
}));

export const MarketTitleTest = M.models.MarketTitleTest || M.model('MarketTitleTest', new M.Schema({
  userId: { type: M.Schema.Types.ObjectId, ref: 'User' },
  optionA: String,
  optionB: String,
  winner: String,
  score: Number,
  createdAt: { type: Date, default: Date.now }
}));

export const MarketReputation = M.models.MarketReputation || M.model('MarketReputation', new M.Schema({
  storeName: String,
  rating: Number,
  reviewsCount: Number,
  status: String,
  updatedAt: { type: Date, default: Date.now }
}));

export const MarketSupplier = M.models.MarketSupplier || M.model('MarketSupplier', new M.Schema({
  name: String,
  category: String,
  contact: String,
  rating: Number,
  isPremium: Boolean
}));

export const MarketAdPlan = M.models.MarketAdPlan || M.model('MarketAdPlan', new M.Schema({
  userId: { type: M.Schema.Types.ObjectId, ref: 'User' },
  platform: String,
  dailyBudget: Number,
  durationDays: Number,
  targetAudience: String,
  createdAt: { type: Date, default: Date.now }
}));

export const AffLinkTracker = M.models.AffLinkTracker || M.model('AffLinkTracker', new M.Schema({
  userId: { type: M.Schema.Types.ObjectId, ref: 'User' },
  linkName: String,
  originalUrl: String,
  trackedUrl: String,
  clicks: { type: Number, default: 0 },
  cr: { type: Number, default: 0 },
  updatedAt: { type: Date, default: Date.now }
}));

export const AffFunnel = M.models.AffFunnel || M.model('AffFunnel', new M.Schema({
  userId: { type: M.Schema.Types.ObjectId, ref: 'User' },
  funnelName: String,
  steps: [String],
  active: { type: Boolean, default: true }
}));

export const AffOfferReview = M.models.AffOfferReview || M.model('AffOfferReview', new M.Schema({
  platform: String,
  productName: String,
  commission: Number,
  copyRating: Number,
  vslRating: Number,
  finalScore: Number,
  updatedAt: { type: Date, default: Date.now }
}));

export const FreePricing = M.models.FreePricing || M.model('FreePricing', new M.Schema({
  userId: { type: M.Schema.Types.ObjectId, ref: 'User' },
  itemName: String,
  hourlyRate: Number,
  hoursEstimated: Number,
  totalPrice: Number,
  createdAt: { type: Date, default: Date.now }
}));

export const SaasMetric = M.models.SaasMetric || M.model('SaasMetric', new M.Schema({
  userId: { type: M.Schema.Types.ObjectId, ref: 'User' },
  mrr: Number,
  churnRate: Number,
  cac: Number,
  ltv: Number,
  date: { type: Date, default: Date.now }
}));

export const WhatsAppAuth = M.models.WhatsAppAuth || M.model('WhatsAppAuth', new M.Schema({
  key: { type: String, required: true, unique: true },
  value: { type: M.Schema.Types.Mixed, required: true },
  updatedAt: { type: Date, default: Date.now }
}));

export const WhatsAppBulkJob = M.models.WhatsAppBulkJob || M.model('WhatsAppBulkJob', new M.Schema({
  userId: { type: M.Schema.Types.ObjectId, ref: 'User', required: true },
  groupId: { type: String, required: true },
  groupIds: [String], // Nova lista de destinos múltiplos
  links: [String],
  subIds: [String],
  intervalMinutes: { type: Number, default: 15 },
  status: { type: String, enum: ['pending', 'running', 'completed', 'paused', 'canceled'], default: 'pending' },
  currentIndex: { type: Number, default: 0 },
  settings: {
    sendImages: { type: Boolean, default: true },
    customMessage: String,
    timezone: { type: String, default: 'America/Sao_Paulo' },
    useWorkHours: { type: Boolean, default: false },
    workHourStart: { type: String, default: '07:00' },
    workHourEnd: { type: String, default: '22:00' }
  },
  lastRunAt: Date,

  nextRunAt: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}));

// ─── MULTI-AFILIADO SHOPEE ────────────────────────────────────────────────────

/** Credenciais Shopee por usuário (secret criptografada) */
export const ShopeeCredential = M.models.ShopeeCredential || M.model('ShopeeCredential', new M.Schema({
  userId: { type: M.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  provider: { type: String, default: 'shopee' },
  appId: { type: String, required: true },
  secretEncrypted: { type: String, required: true },
  endpoint: { type: String, default: 'https://open-api.affiliate.shopee.com.br/graphql' },
  isActive: { type: Boolean, default: false },
  lastValidationStatus: { type: String, enum: ['valid', 'invalid', 'pending'], default: 'pending' },
  lastValidationError: String,
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}));

/** Credenciais AliExpress Afiliados por usuario */
export const AliExpressCredential = M.models.AliExpressCredential || M.model('AliExpressCredential', new M.Schema({
  userId: { type: M.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  appKey: { type: String, required: true },
  appSecretEncrypted: { type: String, required: true },
  trackingId: { type: String, default: 'default' },
  endpoint: { type: String, default: 'https://api-sg.aliexpress.com/sync' },
  isActive: { type: Boolean, default: false },
  lastValidationStatus: { type: String, enum: ['valid', 'invalid', 'pending'], default: 'pending' },
  lastValidationError: String,
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}));

/** Credenciais genéricas para providers da busca automática */
export const AffiliateCredential = M.models.AffiliateCredential || M.model('AffiliateCredential', new M.Schema({
  userId: { type: M.Schema.Types.ObjectId, ref: 'User', required: true },
  provider: { type: String, enum: ['shopee', 'mercadolivre', 'aliexpress', 'amazon'], required: true },
  appId: String,
  accessKey: String,
  clientId: String,
  secretEncrypted: String,
  accessTokenEncrypted: String,
  refreshTokenEncrypted: String,
  cookiesEncrypted: String,
  csrfTokenEncrypted: String,
  affiliateTagEncrypted: String,
  navigationUserAgent: String,
  navigationHeaders: String,
  partnerTag: String,
  endpoint: String,
  marketplace: { type: String, default: 'BR' },
  isActive: { type: Boolean, default: false },
  mode: { type: String, enum: ['automatic', 'search_only', 'affiliate_session', 'manual', 'pending'], default: 'pending' },
  sessionStatus: { type: String, enum: ['active', 'expired', 'invalid', 'pending'], default: 'pending' },
  sessionExpiresAt: Date,
  fallbackSearchEnabled: { type: Boolean, default: false },
  lastValidationStatus: { type: String, enum: ['valid', 'invalid', 'pending'], default: 'pending' },
  lastValidationError: String,
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, { indexes: [{ userId: 1, provider: 1, unique: true }] }));

/** Catálogo de nichos (global — gerenciado pelo admin) */
export const Niche = M.models.Niche || M.model('Niche', new M.Schema({
  name: { type: String, required: true },
  slug: { type: String, required: true, unique: true },
  description: String,
  keywords: [String],
  blockedKeywords: [String],
  shopeeCategoryIds: [String],
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}));

/** Grupos de WhatsApp configurados por usuário */
export const UserGroup = M.models.UserGroup || M.model('UserGroup', new M.Schema({
  userId: { type: M.Schema.Types.ObjectId, ref: 'User', required: true },
  groupName: { type: String, required: true },
  groupIdentifier: { type: String }, // legado
  groupIdentifiers: [String], // Array de destinos para a partição
  useNativeLinkPreview: { type: Boolean, default: false },
  preserveSourceImageInNativePreview: { type: Boolean, default: false },
  isActive: { type: Boolean, default: true },
  nicheId: { type: M.Schema.Types.ObjectId, ref: 'Niche' },
  customMessageTemplate: String, // Template com variáveis {productName} etc.
  maxPostsPerHour: { type: Number, default: 10 },
  maxPostsPerDay: { type: Number, default: 60 },
  delayBetweenPostsSeconds: { type: Number, default: 30 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}));

/** Configuração de busca automática por usuário e grupo */
export const AutoSearchConfig = M.models.AutoSearchConfig || M.model('AutoSearchConfig', new M.Schema({
  userId: { type: M.Schema.Types.ObjectId, ref: 'User', required: true },
  groupId: { type: M.Schema.Types.ObjectId, ref: 'UserGroup', required: true },
  nicheId: { type: M.Schema.Types.ObjectId, ref: 'Niche', required: true },
  isActive: { type: Boolean, default: false },
  searchIntervalMinutes: { type: Number, default: 15, min: 5 },
  maxPostsPerRun: { type: Number, default: 3 },
  maxPostsPerHour: { type: Number, default: 10 },
  maxPostsPerDay: { type: Number, default: 60 },
  delayBetweenPostsSeconds: { type: Number, default: 30 },
  providerMode: { type: String, enum: ['single', 'compare'], default: 'single' },
  primaryProvider: { type: String, enum: ['shopee', 'mercadolivre', 'aliexpress', 'amazon'], default: 'shopee' },
  providersEnabled: { type: [String], default: ['shopee'] },
  requireAffiliateLink: { type: Boolean, default: true },
  requireRealDiscount: { type: Boolean, default: true },
  minDiscountPercent: { type: Number, default: 10 },
  minPriceDropAmount: { type: Number, default: 5 },
  dealSelectionMode: { type: String, enum: ['best_deal', 'lowest_price', 'random_top'], default: 'best_deal' },
  compareBy: { type: String, enum: ['lowest_price', 'best_score'], default: 'lowest_price' },
  startTime: { type: String, default: '' }, // HH:MM (Vazio = Roda 24/7)
  stopTime: { type: String, default: '' },  // HH:MM (Vazio = Roda 24/7)
  timezone: { type: String, default: 'America/Sao_Paulo' },
  daysOfWeek: { type: [Number], default: [0, 1, 2, 3, 4, 5, 6] }, // 0=Dom ... 6=Sáb
  // Filtros de produto
  minPrice: Number,
  maxPrice: Number,
  minSales: Number,
  minRating: Number,
  minCommissionRate: Number,
  onlyWithCoupon: { type: Boolean, default: false },
  onlyFreeShipping: { type: Boolean, default: false },
  // Controle de execução e keywords
  lastKeywordIndex: { type: Number, default: 0 },
  lastRunAt: Date,
  nextRunAt: Date,
  lastStatus: {
    type: String,
    enum: ['ok', 'error', 'skipped', 'no_results', 'running',
           'no_products_from_shopee', 'products_found_but_all_filtered',
           'no_products_from_any_provider',
           'no_affiliate_links', 'provider_error', 'providers_not_configured', 'outside_schedule', 'limit_reached',
           'whatsapp_not_connected', 'failed'],
    default: 'ok'
  },
  lastError: String,
  // Diagnóstico detalhado da última execução
  lastRunDetails: { type: M.Schema.Types.Mixed, default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}));

/** Regras personalizadas de busca por usuário */
export const UserDealRule = M.models.UserDealRule || M.model('UserDealRule', new M.Schema({
  userId: { type: M.Schema.Types.ObjectId, ref: 'User', required: true },
  groupId: { type: M.Schema.Types.ObjectId, ref: 'UserGroup' }, // opcional
  nicheId: { type: M.Schema.Types.ObjectId, ref: 'Niche' },
  keyword: { type: String, required: true },
  maxPrice: Number,
  minPrice: Number,
  minSales: Number,
  minRating: Number,
  minCommissionRate: Number,
  onlyWithCoupon: { type: Boolean, default: false },
  maxPostsPerRun: { type: Number, default: 3 },
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}));

/** Histórico de produtos enviados por usuário/grupo/nicho (anti-repetição) */
export const PostedDeal = M.models.PostedDeal || M.model('PostedDeal', new M.Schema({
  userId: { type: M.Schema.Types.ObjectId, ref: 'User', required: true },
  groupId: { type: M.Schema.Types.ObjectId, ref: 'UserGroup', required: true },
  nicheId: { type: M.Schema.Types.ObjectId, ref: 'Niche' },
  provider: { type: String, default: 'shopee' },
  itemId: String,
  dealKey: { type: String, index: true, unique: true, sparse: true },
  shopId: String,
  appId: String,
  productLink: String,
  productName: String,
  price: Number,
  originalPrice: Number,
  discountPercent: Number,
  discountAmount: Number,
  dealScore: Number,
  niche: String,
  matchedKeywords: [String],
  promotionSource: String,
  reasonSelected: String,
  affiliateUrl: String,
  status: { type: String, enum: ['sending', 'sent', 'failed'], default: 'sent' },
  reservedAt: Date,
  lastError: String,
  sentAt: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}));

/** Log de cada envio com status */
export const SendLog = M.models.SendLog || M.model('SendLog', new M.Schema({
  userId: { type: M.Schema.Types.ObjectId, ref: 'User', required: true },
  groupId: { type: M.Schema.Types.ObjectId, ref: 'UserGroup' },
  nicheId: { type: M.Schema.Types.ObjectId, ref: 'Niche' },
  provider: { type: String, default: 'shopee' },
  itemId: String,
  shopId: String,
  appId: String,
  productLink: String,
  productName: String,
  price: Number,
  originalPrice: Number,
  discountPercent: Number,
  discountAmount: Number,
  dealScore: Number,
  niche: String,
  matchedKeywords: [String],
  promotionSource: String,
  reasonSelected: String,
  status: { type: String, enum: ['sent', 'failed', 'skipped'], default: 'sent' },
  reason: String,
  messagePreview: String,
  affiliateUrl: String,
  createdAt: { type: Date, default: Date.now }
}));

/** Configuracao do Copiar Promo por usuario */
export const CopyPromoConfig = M.models.CopyPromoConfig || M.model('CopyPromoConfig', new M.Schema({
  userId: { type: M.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  name: { type: String, default: 'Copiar Promo' },
  webhookToken: { type: String, required: true, unique: true, index: true },
  sourceGroupId: { type: String, default: '' },
  sourceGroupName: { type: String, default: '' },
  targetGroupId: { type: M.Schema.Types.ObjectId, ref: 'UserGroup' },
  amazonTagEncrypted: String,
  isActive: { type: Boolean, default: false },
  lastRunAt: Date,
  lastStatus: { type: String, enum: ['idle', 'success', 'error', 'skipped'], default: 'idle' },
  lastError: String,
  copiedCount: { type: Number, default: 0 },
  sentCount: { type: Number, default: 0 },
  skippedCount: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}));

/** Historico do Copiar Promo */
export const CopyPromoLog = M.models.CopyPromoLog || M.model('CopyPromoLog', new M.Schema({
  userId: { type: M.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  configId: { type: M.Schema.Types.ObjectId, ref: 'CopyPromoConfig' },
  sourceGroupId: String,
  sourceGroupName: String,
  targetGroupId: { type: M.Schema.Types.ObjectId, ref: 'UserGroup' },
  provider: { type: String, enum: ['mercadolivre', 'amazon', 'shopee', 'aliexpress', 'unknown'], default: 'unknown' },
  originalUrl: String,
  affiliateUrl: String,
  productName: String,
  price: String,
  oldPrice: String,
  coupon: String,
  discountStore: String,
  imageUrl: String,
  extractionSource: String,
  localAIModel: String,
  localAIError: String,
  messagePreview: String,
  rawMessageId: String,
  status: { type: String, enum: ['sent', 'failed', 'skipped'], default: 'sent' },
  error: String,
  createdAt: { type: Date, default: Date.now }
}));

/** Mercado Livre — Configuração operacional por usuário (novo modelo) */
export const MercadoLivreConfig = M.models.MercadoLivreConfig || M.model('MercadoLivreConfig', new M.Schema({
  userId: { type: M.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  mercadoLivreAffiliateTagEncrypted: String,
  cookieEncrypted: String,
  csrfTokenEncrypted: String,
  mercadoLivreListUrl: String,
  couponAlertImageUrl: String,
  couponAlertImagePublicId: String,
  couponAlertImageMimeType: String,
  couponAlertImageSize: { type: Number, default: 0 },
  couponAlertImageUpdatedAt: Date,
  credentialUpdatedAt: { type: Date },
  enabled: { type: Boolean, default: false },
  // Modo de execução
  runMode: { type: String, enum: ['24h', 'custom'], default: '24h' },
  startTime: { type: String, default: '08:00' },   // HH:MM
  endTime: { type: String, default: '22:00' },     // HH:MM
  // Intervalos e limites
  intervalMinutes: { type: Number, default: 8, min: 1 },
  sendInterval: { type: Number, default: 30 },
  schedules: { type: [String], default: [] },
  maxProductsPerRun: { type: Number, default: 10 },
  maxProductsPerGroup: { type: Number, default: 3 },
  // Destinos
  targetGroups: { type: [String], default: [] },  // JIDs WhatsApp
  // ──────────────────────────────────────────────────────────────────────────
  // Estado interno do scheduler
  lastRunAt: { type: Date },
  nextRunAt: { type: Date },
  lastStatus: { type: String, default: 'idle' },
  lastError: { type: String },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}));

/** Mercado Livre — Nichos com URLs e keywords por usuário (novo modelo) */
export const MercadoLivreNiche = M.models.MercadoLivreNiche || M.model('MercadoLivreNiche', new M.Schema({
  userId: { type: M.Schema.Types.ObjectId, ref: 'User', required: true },
  name: { type: String, required: true },
  active: { type: Boolean, default: true },
  urls: { type: [String], default: [] },          // URLs de categorias/buscas ML
  keywords: { type: [String], default: [] },
  priority: { type: Number, default: 1 },          // maior = processado primeiro
  maxProducts: { type: Number, default: 50 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}));

/** Mercado Livre — Histórico de execuções (novo modelo) */
export const MercadoLivreRunHistory = M.models.MercadoLivreRunHistory || M.model('MercadoLivreRunHistory', new M.Schema({
  userId: { type: M.Schema.Types.ObjectId, ref: 'User', required: true },
  phase: { type: String, enum: ['search', 'affiliate', 'send', 'full', 'cleanup'], default: 'full' },
  status: { type: String, enum: ['running', 'success', 'error', 'partial'], default: 'running' },
  startedAt: { type: Date, default: Date.now },
  finishedAt: { type: Date },
  totalFound: { type: Number, default: 0 },
  totalSaved: { type: Number, default: 0 },
  totalAffiliateGenerated: { type: Number, default: 0 },
  totalSent: { type: Number, default: 0 },
  errors: { type: [String], default: [] },
  details: { type: M.Schema.Types.Mixed }
}));

/** Mercado Livre Raw N8n - Categorias */
export const MercadoLivreRawCategory = M.models.MercadoLivreRawCategory || M.model('MercadoLivreRawCategory', new M.Schema({
  userId: { type: M.Schema.Types.ObjectId, ref: 'User', required: true },
  name: { type: String, required: true },
  url: { type: String, required: true },
  nicheId: { type: M.Schema.Types.ObjectId, ref: 'Niche' },
  status: { type: String, enum: ['ATIVO', 'INATIVO'], default: 'ATIVO' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}));

/** Mercado Livre Raw N8n - Produtos Extraidos/Prontos */
export const MercadoLivreRawProduct = M.models.MercadoLivreRawProduct || M.model('MercadoLivreRawProduct', new M.Schema({
  userId: { type: M.Schema.Types.ObjectId, ref: 'User', required: true },
  categoryId: { type: M.Schema.Types.ObjectId, ref: 'MercadoLivreRawCategory' },
  nicheId: { type: M.Schema.Types.ObjectId, ref: 'MercadoLivreNiche' },
  idProduto: { type: String, required: true },
  nomeProduto: { type: String },
  imagemProduto: { type: String },
  precoOriginal: { type: String },
  precoAtual: { type: String },
  preco_original_numero: { type: Number },
  preco_atual_numero: { type: Number },
  desconto: { type: String },
  searchKeyword: { type: String },
  searchUrl: { type: String },
  urlOriginal: { type: String },
  urlLimpa: { type: String },
  urlAfiliado: { type: String },
  cupom: { type: M.Schema.Types.Mixed },
  cycleId: { type: String, index: true },
  cycleDate: { type: String },
  cycleStartAt: { type: Date },
  cycleEndAt: { type: Date },
  archivedAt: { type: Date },
  // Status: legado lowercase + novo uppercase
  status: { type: String, enum: ['capturado', 'afiliado_gerado', 'pronto', 'erro', 'enviado', 'NOVO', 'PRONTO', 'ENVIADO', 'ERRO'], default: 'capturado' },
  sentAt: { type: Date },
  success: { type: Boolean, default: false },
  errorType: { type: String },
  errorMessage: { type: String },
  source: { type: String, default: 'n8n_raw' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}));


export const MercadoLivreRawPipelineConfig = M.models.MercadoLivreRawPipelineConfig || M.model('MercadoLivreRawPipelineConfig', new M.Schema({
  userId: { type: M.Schema.Types.ObjectId, ref: 'User', required: true },
  isActive: { type: Boolean, default: false },
  captureTime: { type: String, default: '07:00' },
  affiliateGenerationTime: { type: String, default: '08:00' },
  maxProductsPerCapture: { type: Number, default: 200 },
  maxAffiliateLinksPerRun: { type: Number, default: 50 },
  cleanupOldProducts: { type: Boolean, default: true },
  maxProductAgeHours: { type: Number, default: 24 },
  lastCaptureAt: { type: Date },
  lastAffiliateGenerationAt: { type: Date },
  lastRawPipelineRun: { type: M.Schema.Types.Mixed, default: {} },
  // Modo de execução: internal (backend) ou external_n8n_webhook (n8n self-hosted/VPS)
  rawExecutionMode: { type: String, enum: ['internal', 'external_n8n_webhook'], default: 'internal' },
  externalN8nCaptureWebhookUrl: { type: String, default: '' },
  externalN8nAffiliateWebhookUrl: { type: String, default: '' },
  externalN8nFullPipelineWebhookUrl: { type: String, default: '' },
  externalN8nAuthTokenEncrypted: { type: String, default: '' }
}));
