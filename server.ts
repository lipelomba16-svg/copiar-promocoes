// Force redeploy - Vercel Build Fix v2
import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import multer from 'multer';
import { Resend } from 'resend';
import bcrypt from 'bcryptjs';
import cookieParser from 'cookie-parser';
import crypto from 'crypto';
import mongoose from 'mongoose';
import {
  connectDB, getDbError, User, Session, UserProfile, PlanTemplate, PlanDay, UserPlan, UserTask, CRMLead, Alert,
  AffiliateLink, AffiliateClick, AffiliateEarning, UserMetric, UserAction, Subscription, UserEntitlement,
  LearningTrack, Lesson, ActionPlan, AIHistory, Transaction, CommunityPost, Comment, SupportTicket, UserRoutine, AdminOverride,
  AgendaEvent, DailyMetric, LibraryProgress, ToolData, AssetInteraction,
  MarketTrend, MarketCalc, MarketTitleTest, MarketReputation, MarketSupplier, MarketAdPlan,
  AffLinkTracker, AffFunnel, AffOfferReview, FreePricing, SaasMetric, WhatsAppAuth, WhatsAppBulkJob,
  ShopeeCredential, AliExpressCredential, AffiliateCredential, Niche, UserGroup, AutoSearchConfig, UserDealRule, PostedDeal, SendLog,
  MercadoLivreRawProduct,
  MercadoLivreConfig, MercadoLivreNiche, MercadoLivreRunHistory
} from './lib/db.js';
import { decryptSecret, encryptSecret, maskAppId } from './services/cryptoService.js';
import { createShopeeClient } from './services/shopeeClientFactory.js';
import { seedNiches, getActiveNiches } from './services/nicheService.js';
import { autoSearchScheduler } from './services/autoSearchScheduler.js';
import { renderKeepAliveService } from './services/renderKeepAliveService.js';
import { waService } from './services/whatsappService.js';
import { shopeeService } from './services/shopeeService.js';
import { schedulerService } from './services/schedulerService.js';
import { robustSchedulerService } from './services/robustSchedulerService.js';

import { providerRegistry, normalizeProviderId } from './services/providers/providerRegistry.js';
// multiProviderDealSearch — only utility exports used below
import { mercadoLivreN8nJsonService, MERCADO_LIVRE_DEFAULT_NICHES as DEFAULT_NICHES } from './services/mercadoLivreN8nJsonService.js';
import { copyPromoService } from './services/copyPromoService.js';
import { aliexpressAffiliateService } from './services/aliexpressAffiliateService.js';
import { databaseCleanupService } from './services/databaseCleanupService.js';
import {
  sanitizeUserGroupCreatePayload,
  sanitizeUserGroupUpdatePayload
} from './services/partitionPreviewModeService.js';
import whatsappWebJsRouter from './api/whatsappWebJs.js';
import whatsappWebJsV2Router from './api/whatsappWebJsV2.js';
import { MERCADO_LIVRE_COUPON_ALERT_IMAGE_MAX_BYTES } from './services/mercadoLivreCouponAlertImageUploadService.js';

// Cast models to any to avoid Mongoose typing noise on Vercel's TS checker.
const UserM: any = User;
const SessionM: any = Session;
const UserProfileM: any = UserProfile;

const DEFAULT_BACKGROUND_PREFERENCES = {
  backgroundMode: 'animated',
  backgroundAnimationMode: 3,
  backgroundPalette: 2,
  backgroundStaticColor: '#030305'
} as const;

function normalizeBackgroundPreferences(input: any = {}) {
  const backgroundMode = input?.backgroundMode === 'static' ? 'static' : 'animated';
  const rawAnimationMode = Number(input?.backgroundAnimationMode);
  const rawPalette = Number(input?.backgroundPalette);
  const backgroundAnimationMode = Number.isFinite(rawAnimationMode) ? Math.min(3, Math.max(0, Math.round(rawAnimationMode))) : DEFAULT_BACKGROUND_PREFERENCES.backgroundAnimationMode;
  const backgroundPalette = Number.isFinite(rawPalette) ? Math.min(2, Math.max(0, Math.round(rawPalette))) : DEFAULT_BACKGROUND_PREFERENCES.backgroundPalette;
  const backgroundStaticColor = /^#([0-9a-f]{6})$/i.test(String(input?.backgroundStaticColor || '').trim())
    ? String(input.backgroundStaticColor).trim()
    : DEFAULT_BACKGROUND_PREFERENCES.backgroundStaticColor;
  return {
    backgroundMode,
    backgroundAnimationMode,
    backgroundPalette,
    backgroundStaticColor
  };
}
const PlanTemplateM: any = PlanTemplate;
const PlanDayM: any = PlanDay;
const UserPlanM: any = UserPlan;
const UserTaskM: any = UserTask;
const CRMLeadM: any = CRMLead;
const AlertM: any = Alert;
const AffiliateLinkM: any = AffiliateLink;
const AffiliateClickM: any = AffiliateClick;
const AffiliateEarningM: any = AffiliateEarning;
const UserMetricM: any = UserMetric;
const UserActionM: any = UserAction;
const SubscriptionM: any = Subscription;
const UserEntitlementM: any = UserEntitlement;
const LearningTrackM: any = LearningTrack;
const LessonM: any = Lesson;
const ActionPlanM: any = ActionPlan;
const AIHistoryM: any = AIHistory;
const TransactionM: any = Transaction;
const CommunityPostM: any = CommunityPost;
const CommentM: any = Comment;
const SupportTicketM: any = SupportTicket;
const UserRoutineM: any = UserRoutine;
const AdminOverrideM: any = AdminOverride;

const AgendaEventM: any = AgendaEvent;
const DailyMetricM: any = DailyMetric;
const LibraryProgressM: any = LibraryProgress;
const ToolDataM: any = ToolData;
const AssetInteractionM: any = AssetInteraction;

const MarketTrendM: any = MarketTrend;
const MarketCalcM: any = MarketCalc;
const MarketTitleTestM: any = MarketTitleTest;
const MarketReputationM: any = MarketReputation;
const MarketSupplierM: any = MarketSupplier;
const MarketAdPlanM: any = MarketAdPlan;
const AffLinkTrackerM: any = AffLinkTracker;
const AffFunnelM: any = AffFunnel;
const AffOfferReviewM: any = AffOfferReview;
const FreePricingM: any = FreePricing;
const SaasMetricM: any = SaasMetric;
const WhatsAppBulkJobM: any = WhatsAppBulkJob;

const resendApiKey = process.env.RESEND_API_KEY || '';
const resend = resendApiKey ? new Resend(resendApiKey) : null;
const RESEND_FROM = process.env.RESEND_FROM_EMAIL || 'Longevita <onboarding@resend.dev>';
console.log(`[Resend] Initialized with FROM: ${RESEND_FROM}`);

const APP_ROOT = process.cwd();
const mercadoLivreConfigUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MERCADO_LIVRE_COUPON_ALERT_IMAGE_MAX_BYTES,
    files: 1
  },
  fileFilter: (_req, file, cb) => {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(String(file.mimetype || '').toLowerCase())) {
      return cb(Object.assign(new Error('Formato de imagem invalido. Use JPG, PNG ou WEBP.'), { errorType: 'invalid_coupon_alert_image_mime' }));
    }
    cb(null, true);
  }
});

function mercadoLivreCouponAlertUploadMiddleware(req: any, res: any, next: any) {
  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  if (!contentType.includes('multipart/form-data')) return next();
  mercadoLivreConfigUpload.single('couponAlertImage')(req, res, (error: any) => {
    if (!error) return next();
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        success: false,
        errorType: 'coupon_alert_image_too_large',
        errorMessage: 'A imagem de alerta de cupom excede 2 MB.'
      });
    }
    return res.status(Number(error?.httpStatus || 400)).json({
      success: false,
      errorType: error?.errorType || 'coupon_alert_image_upload_invalid',
      errorMessage: error?.message || 'Falha ao processar a imagem enviada.'
    });
  });
}

// --- SEEDING LOGIC ---
const seedData = async () => {
  if (mongoose.connection.readyState !== 1) {
    console.log("Skipping seed: DB not connected");
    return;
  }

  // Generate Admin user always
  const adminEmail = 'stopolliny@gmail.com';
  let adminUser = await UserM.findOne({ email: adminEmail });
  let pHash = '';
  if (!adminUser) {
    pHash = await bcrypt.hash('eusoueu01', 10);
    adminUser = await UserM.create({
      name: 'Arthur',
      email: adminEmail,
      passwordHash: pHash,
      role: 'admin',
      isEmailVerified: true
    });
    console.log("Admin user created.");
  } else {
    // Force admin role and password for stopolliny@gmail.com for final delivery consistency
    pHash = await bcrypt.hash('eusoueu01', 10);
    adminUser.name = 'Arthur';
    adminUser.role = 'admin';
    adminUser.passwordHash = pHash;
    adminUser.isEmailVerified = true;
    await adminUser.save();
  }
  await UserEntitlementM.updateOne(
    { userId: adminUser._id },
    { hasAccess: true, reason: 'Admin bypass' },
    { upsert: true }
  );

  // Liberar acesso para e-mails específicos (Whitelist manual)
  const whitelistedEmails = ['bernardodealmeida0@gmail.com'];
  for (const email of whitelistedEmails) {
    const user = await UserM.findOne({ email });
    if (user) {
      await UserEntitlementM.updateOne(
        { userId: user._id },
        { hasAccess: true, reason: 'Acesso liberado via suporte' },
        { upsert: true }
      );
      console.log(`[Seed] Acesso liberado para: ${email}`);
    }
  }


  // Optimize: skip seeding if data already exists
  const trackCount = await LearningTrackM.countDocuments();
  if (trackCount > 0) {
    console.log("Skipping seed: Database already initialized.");
    return;
  }


  // Seed Learning Tracks (idempotente)
  const TRACKS = [
    { _id: 'microsaas', title: 'Micro SaaS do Zero', description: 'Crie e monetize seu próprio SaaS.', category: 'SaaS/IA', level: 'Avançado', iconSlug: 'rocket', tags: ['saas', 'ia', 'negócios'] },
    { _id: 'shopee-vendedor', title: 'Shopee Vendedor Pro', description: 'Domine a Shopee e venda muito mais.', category: 'Marketplace', subCategory: 'Shopee', level: 'Intermediário', iconSlug: 'shopping-bag', tags: ['shopee', 'marketplace', 'ecommerce'] },
    { _id: 'mercado-livre-vendedor', title: 'Mercado Livre Vendedor', description: 'Venda no Mercado Livre do zero ao avançado.', category: 'Marketplace', subCategory: 'Mercado Livre', level: 'Intermediário', iconSlug: 'shopping-bag', tags: ['mercado livre', 'marketplace', 'ecommerce'] },
    { _id: 'amazon-vendedor', title: 'Amazon Seller', description: 'Comece e escale suas vendas na Amazon.', category: 'Marketplace', subCategory: 'Amazon', level: 'Intermediário', iconSlug: 'shopping-bag', tags: ['amazon', 'marketplace', 'ecommerce'] },
    { _id: 'hotmart-afiliado', title: 'Hotmart Afiliados', description: 'Rota de afiliados com foco em execução.', category: 'Afiliado', subCategory: 'Hotmart', level: 'Iniciante', iconSlug: 'dollar-sign', tags: ['hotmart', 'afiliado'] },
    { _id: 'eduzz-afiliado', title: 'Eduzz Afiliados', description: 'Afiliados na Eduzz com foco em conversão.', category: 'Afiliado', subCategory: 'Eduzz', level: 'Iniciante', iconSlug: 'dollar-sign', tags: ['eduzz', 'afiliado'] },
    { _id: 'monetizze-afiliado', title: 'Monetizze Afiliados', description: 'Afiliados na Monetizze com execução diária.', category: 'Afiliado', subCategory: 'Monetizze', level: 'Iniciante', iconSlug: 'dollar-sign', tags: ['monetizze', 'afiliado'] },
    { _id: 'trafego', title: 'Tráfego & Redes', description: 'Fundamentos de tráfego e conteúdo para vender todo dia.', category: 'Conteúdo', subCategory: 'Ads', level: 'Iniciante', iconSlug: 'megaphone', tags: ['ads', 'trafego', 'conteudo'] },
    { _id: 'afiliado-ninja', title: 'Afiliado Ninja', description: 'Estratégias para afiliados de alta performance.', category: 'Afiliado', level: 'Iniciante', iconSlug: 'dollar-sign', tags: ['afiliado', 'marketing digital'] },
    { _id: 'servico-digital', title: 'Serviço Digital Lucrativo', description: 'Transforme suas habilidades em serviços digitais de alto valor.', category: 'Serviço', level: 'Intermediário', iconSlug: 'briefcase', tags: ['serviços', 'freelance'] },
  ];
  console.log("Seeding learning tracks (idempotente)...");
  await Promise.all(
    TRACKS.map((t) => LearningTrackM.updateOne({ _id: t._id }, { $setOnInsert: t }, { upsert: true }))
  );

  // Seed Lessons (idempotente)
  const LESSONS = [
    { trackId: 'microsaas', title: 'Validação de ideia (busca curada)', youtubeUrl: 'https://www.youtube.com/results?search_query=como+validar+ideia+de+microsaas', durationLabel: '15 min', level: 'Iniciante', tags: ['saas', 'validação'] },
    { trackId: 'microsaas', title: 'MVP no-code (busca curada)', youtubeUrl: 'https://www.youtube.com/results?search_query=como+criar+mvp+no+code', durationLabel: '20 min', level: 'Intermediário', tags: ['mvp', 'nocode'] },
    { trackId: 'microsaas', title: 'Primeiros clientes SaaS (busca curada)', youtubeUrl: 'https://www.youtube.com/results?search_query=como+conseguir+primeiros+clientes+saas', durationLabel: '18 min', level: 'Intermediário', tags: ['clientes', 'saas'] },
    { trackId: 'microsaas', title: 'Deploy na Vercel (busca curada)', youtubeUrl: 'https://www.youtube.com/results?search_query=vercel+deploy+tutorial', durationLabel: '12 min', level: 'Iniciante', tags: ['vercel', 'deploy'] },
    { trackId: 'shopee-vendedor', title: 'Shopee do zero (busca curada)', youtubeUrl: 'https://www.youtube.com/results?search_query=como+vender+na+shopee+do+zero+2025+2026', durationLabel: '10 min', level: 'Iniciante', tags: ['shopee', 'loja'] },
    { trackId: 'shopee-vendedor', title: 'Shopee Ads (busca curada)', youtubeUrl: 'https://www.youtube.com/results?search_query=shopee+ads+como+anunciar', durationLabel: '18 min', level: 'Intermediário', tags: ['shopee', 'anúncios', 'ads'] },
    { trackId: 'shopee-vendedor', title: 'SEO título Shopee (busca curada)', youtubeUrl: 'https://www.youtube.com/results?search_query=seo+titulo+produto+shopee', durationLabel: '14 min', level: 'Iniciante', tags: ['seo', 'título'] },
    { trackId: 'afiliado-ninja', title: 'Hotmart afiliado iniciante (busca curada)', youtubeUrl: 'https://www.youtube.com/results?search_query=hotmart+afiliado+iniciante+primeira+venda', durationLabel: '12 min', level: 'Iniciante', tags: ['afiliado', 'hotmart'] },
    { trackId: 'afiliado-ninja', title: 'Funil WhatsApp afiliados (busca curada)', youtubeUrl: 'https://www.youtube.com/results?search_query=funil+whatsapp+hotmart+afiliado', durationLabel: '25 min', level: 'Intermediário', tags: ['funil', 'whatsapp'] },
    { trackId: 'hotmart-afiliado', title: 'Hotmart afiliado iniciante (busca curada)', youtubeUrl: 'https://www.youtube.com/results?search_query=hotmart+afiliado+iniciante+primeira+venda', durationLabel: '12 min', level: 'Iniciante', tags: ['hotmart', 'afiliado'] },
    { trackId: 'hotmart-afiliado', title: 'Funil WhatsApp Hotmart (busca curada)', youtubeUrl: 'https://www.youtube.com/results?search_query=funil+whatsapp+hotmart+afiliado', durationLabel: '20 min', level: 'Intermediário', tags: ['funil', 'whatsapp'] },
    { trackId: 'eduzz-afiliado', title: 'Eduzz afiliado iniciante (busca curada)', youtubeUrl: 'https://www.youtube.com/results?search_query=eduzz+afiliado+primeira+venda', durationLabel: '12 min', level: 'Iniciante', tags: ['eduzz', 'afiliado'] },
    { trackId: 'eduzz-afiliado', title: 'Eduzz afiliado tutorial (busca curada)', youtubeUrl: 'https://www.youtube.com/results?search_query=eduzz+tutorial+afiliados+iniciante', durationLabel: '20 min', level: 'Intermediário', tags: ['eduzz', 'tutorial'] },
    { trackId: 'monetizze-afiliado', title: 'Monetizze afiliado iniciante (busca curada)', youtubeUrl: 'https://www.youtube.com/results?search_query=monetizze+afiliados+tutorial+iniciante', durationLabel: '12 min', level: 'Iniciante', tags: ['monetizze', 'afiliado'] },
    { trackId: 'monetizze-afiliado', title: 'Primeira venda Monetizze (busca curada)', youtubeUrl: 'https://www.youtube.com/results?search_query=como+fazer+primeira+venda+monetizze', durationLabel: '18 min', level: 'Intermediário', tags: ['vendas', 'afiliado'] },
    { trackId: 'servico-digital', title: '99Freelas iniciante (busca curada)', youtubeUrl: 'https://www.youtube.com/results?search_query=99freelas+como+come%C3%A7ar+iniciante', durationLabel: '17 min', level: 'Iniciante', tags: ['serviço', 'freelance'] },
    { trackId: 'servico-digital', title: 'Primeiro cliente (busca curada)', youtubeUrl: 'https://www.youtube.com/results?search_query=99freelas+primeiro+cliente', durationLabel: '22 min', level: 'Intermediário', tags: ['prospecção', 'clientes'] },
    { trackId: 'mercado-livre-vendedor', title: 'ML do zero (busca curada)', youtubeUrl: 'https://www.youtube.com/results?search_query=como+vender+no+mercado+livre+do+zero+2025+2026', durationLabel: '14 min', level: 'Iniciante', tags: ['mercado livre', 'seller'] },
    { trackId: 'mercado-livre-vendedor', title: 'Mercado Ads (busca curada)', youtubeUrl: 'https://www.youtube.com/results?search_query=mercado+ads+mercado+livre+como+funciona', durationLabel: '18 min', level: 'Intermediário', tags: ['ads', 'mercado livre'] },
    { trackId: 'amazon-vendedor', title: 'Amazon do zero (busca curada)', youtubeUrl: 'https://www.youtube.com/results?search_query=como+vender+na+amazon+brasil+do+zero', durationLabel: '14 min', level: 'Iniciante', tags: ['amazon', 'seller'] },
    { trackId: 'amazon-vendedor', title: 'Amazon Ads (busca curada)', youtubeUrl: 'https://www.youtube.com/results?search_query=amazon+ads+brasil+vendedor', durationLabel: '18 min', level: 'Intermediário', tags: ['ads', 'amazon'] },
  ];
  console.log("Seeding lessons (idempotente)...");
  await Promise.all(
    LESSONS.map((l) => LessonM.updateOne(
      { trackId: l.trackId, title: l.title },
      { $setOnInsert: l },
      { upsert: true }
    ))
  );

  // Seed Action Plans (simplified for initial setup)
  const actionPlanCount = await ActionPlanM.countDocuments();
  if (actionPlanCount === 0) {
    console.log("Seeding action plans...");
    await ActionPlanM.insertMany([
      {
        trackId: 'microsaas',
        dayNumber: 1,
        title: 'Dia 1: Descoberta de Nicho',
        goal: 'Validar 3 ideias de Micro SaaS',
        tasks: [
          { title: 'Brainstorm de ideias', description: 'Liste 10 problemas que você ou outros enfrentam.', estimatedTime: '60 min' },
          { title: 'Pesquisa de mercado', description: 'Use Google Trends e Reddit para validar a demanda.', estimatedTime: '90 min' },
          { title: 'Análise de concorrência', description: 'Identifique 3 concorrentes e seus pontos fortes/fracos.', estimatedTime: '60 min', relatedLessonId: (await LessonM.findOne({ trackId: 'microsaas', title: 'Validação de ideia (busca curada)' }))?._id },
        ],
      },
      {
        trackId: 'shopee-vendedor',
        dayNumber: 1,
        title: 'Dia 1: Configuração Essencial da Loja',
        goal: 'Ter sua loja Shopee pronta para o primeiro anúncio.',
        tasks: [
          { title: 'Criar e verificar conta Shopee', description: 'Siga o guia oficial da Shopee.', estimatedTime: '30 min' },
          { title: 'Configurar métodos de envio', description: 'Escolha as transportadoras e endereços.', estimatedTime: '45 min' },
          { title: 'Personalizar perfil da loja', description: 'Adicione logo, banner e descrição atraente.', estimatedTime: '60 min', relatedLessonId: (await LessonM.findOne({ trackId: 'shopee-vendedor', title: 'Shopee do zero (busca curada)' }))?._id },
        ],
      },
    ] as any);
    console.log("Action plans seeded.");
  }

  // IMPORTANT: Do NOT seed Subscription documents.
  // Subscriptions are user-specific and are created only after payment events (Cakto webhook).

  // Seed UserEntitlements (default for all existing users)
  const userCount = await UserM.countDocuments();
  const entitlementCount = await UserEntitlementM.countDocuments();
  if (userCount > 0 && entitlementCount === 0) {
    console.log("Seeding default user entitlements...");
    const users = await UserM.find({});
    const entitlements = users.map(user => ({
      userId: user._id,
      hasAccess: false,
      reason: 'Default access for existing users',
      createdAt: new Date(),
      updatedAt: new Date(),
    }));
    await UserEntitlementM.insertMany(entitlements as any);
    console.log("Default user entitlements seeded.");
  }

  // Original PlanTemplate seeding (keep if still needed for legacy/other flows)
  const planTemplateCount = await PlanTemplateM.countDocuments();
  if (planTemplateCount === 0) { // Only seed if empty
    console.log("Seeding plan templates (legacy)...");

    const goals = [500, 1000, 2000, 3000, 5000];
    const times = [30, 60, 120];
    const tracks = ['Marketplace', 'Afiliado', 'Serviço', 'MicroSaaS'];

    for (const goal of goals) {
      for (const time of times) {
        for (const track of tracks) {
          const id = `plan_${goal}_${time}_${track.toLowerCase()}`;
          const title = `Rota ${track}: Meta R$ ${goal}`;
          const description = `Plano de 30 dias focado em ${track} para atingir R$ ${goal}/mês com ${time} min/dia.`;

          await PlanTemplate.create({
            _id: id,
            title,
            goalBrl: goal,
            timeMinDay: time,
            experience: 'iniciante',
            primaryTrack: track,
            description
          });

          // Generate 30 days
          for (let day = 1; day <= 30; day++) {
            let dayTitle = `Dia ${day}: `;
            let dayGoal = "";
            let tasks = [];

            if (track === 'Marketplace') {
              if (day <= 3) {
                dayTitle += "Configuração de Conta";
                dayGoal = "Ter conta ativa na Shopee/ML";
                tasks = [
                  { title: "Criar conta vendedor", details: "Preencher dados e validar e-mail" },
                  { title: "Configurar frete", details: "Definir endereço de coleta" }
                ];
              } else if (day <= 10) {
                dayTitle += "Garimpo de Produtos";
                dayGoal = "Encontrar 5 produtos vencedores";
                tasks = [
                  { title: "Analisar tendências", details: "Usar ferramentas de busca do marketplace" },
                  { title: "Contatar fornecedores", details: "Verificar estoque e prazos" }
                ];
              } else {
                dayTitle += "Otimização e Escala";
                dayGoal = `Vender R$ ${Math.round(goal / 20)} hoje`;
                tasks = [
                  { title: "Ajustar anúncios", details: "Melhorar títulos e fotos com base em cliques" },
                  { title: "Responder clientes", details: "Agilidade no chat aumenta conversão" }
                ];
              }
            } else if (track === 'MicroSaaS') {
              if (day <= 3) {
                dayTitle += "Ideia, Nicho e Problema";
                dayGoal = "Escolher 1 problema pagável e ICP";
                tasks = [
                  { title: "Listar 10 problemas que você viveu", details: "Escolha dores frequentes, urgentes e caras" },
                  { title: "Definir ICP (cliente ideal)", details: "Cargo, segmento, tamanho, onde encontra" },
                  { title: "Validar com 10 conversas", details: "Mensagem curta + perguntas objetivas" }
                ];
              } else if (day <= 7) {
                dayTitle += "Oferta e Landing";
                dayGoal = "Criar landing com proposta clara + lista de espera";
                tasks = [
                  { title: "Escrever promessa e benefícios", details: "Uma frase: 'Ajudo X a conseguir Y sem Z'" },
                  { title: "Criar landing no Carrd/Framer", details: "Headline, prova, CTA, preço âncora" },
                  { title: "Configurar captura de e-mail", details: "Lista de espera + tag da trilha" }
                ];
              } else if (day <= 15) {
                dayTitle += "MVP na Prática";
                dayGoal = "Entregar uma primeira versão utilizável";
                tasks = [
                  { title: "Definir 3 features essenciais", details: "Sem extras: só o que entrega valor" },
                  { title: "Construir MVP (no-code/código)", details: "Use IA para acelerar: prompts e checklist" },
                  { title: "Colocar 3 usuários para testar", details: "Acompanhe e anote travas e bugs" }
                ];
              } else if (day <= 20) {
                dayTitle += "Preço, Pagamento e Onboarding";
                dayGoal = "Ter checkout e onboarding simples rodando";
                tasks = [
                  { title: "Definir preço e plano", details: "Mensal + anual; comece simples" },
                  { title: "Configurar pagamento (Stripe/Cakto)", details: "Link de pagamento + confirmação" },
                  { title: "Criar onboarding de 3 perguntas", details: "Para personalizar experiência sem IA" }
                ];
              } else {
                dayTitle += "Aquisição e Primeiras Vendas";
                dayGoal = "Conseguir os primeiros 3 clientes";
                tasks = [
                  { title: "Fazer lista de 30 leads", details: "LinkedIn, grupos, comunidades" },
                  { title: "Enviar 10 mensagens/dia", details: "Oferta curta + CTA para demo" },
                  { title: "Criar 1 conteúdo por dia", details: "Dor -> solução -> prova -> CTA" }
                ];
              }
            } else if (track === 'Afiliado') {
              if (day <= 3) {
                dayTitle += "Escolha de Nicho";
                dayGoal = "Definir 1 nicho lucrativo";
                tasks = [
                  { title: "Pesquisar na Hotmart/Kiwify", details: "Olhar temperatura e comissão" },
                  { title: "Analisar concorrência", details: "Ver o que outros afiliados estão fazendo" }
                ];
              } else if (day <= 10) {
                dayTitle += "Criação de Audiência";
                dayGoal = "Atrair 50 seguidores qualificados";
                tasks = [
                  { title: "Postar 2 Reels/TikToks", details: "Conteúdo focado na dor do cliente" },
                  { title: "Criar link na bio", details: "Usar Linktree ou similar" }
                ];
              } else {
                dayTitle += "Conversão e Remarketing";
                dayGoal = "Gerar 1 venda";
                tasks = [
                  { title: "Fazer oferta direta", details: "Story com CTA forte e prova social" },
                  { title: "Chamar leads no direct", details: "Tirar dúvidas de quem interagiu" }
                ];
              }
            } else {
              if (day <= 3) {
                dayTitle += "Definição de Oferta";
                dayGoal = "Ter 1 serviço claro para vender";
                tasks = [
                  { title: "Listar habilidades", details: "O que você sabe fazer que resolve um problema?" },
                  { title: "Criar portfólio simples", details: "Pode ser um PDF ou link no Notion" }
                ];
              } else if (day <= 10) {
                dayTitle += "Prospecção Ativa";
                dayGoal = "Enviar 20 propostas";
                tasks = [
                  { title: "Mapear leads no LinkedIn/IG", details: "Buscar tomadores de decisão" },
                  { title: "Personalizar scripts", details: "Não envie a mesma mensagem para todos" }
                ];
              } else {
                dayTitle += "Fechamento e Entrega";
                dayGoal = "Fechar 1 contrato";
                tasks = [
                  { title: "Fazer reunião de vendas", details: "Focar nos benefícios, não só no preço" },
                  { title: "Iniciar onboarding", details: "Coletar dados para começar o serviço" }
                ];
              }
            }

            await PlanDay.create({
              planTemplateId: id,
              dayNumber: day,
              title: dayTitle,
              goal: dayGoal,
              tasks
            });
          }
        }
      }
    }
    console.log("Seeding complete.");
  }
};

// The app creation is now synchronous
export function createApp() {
  const app = express();
  const PORT = Number(process.env.PORT || 10000);

  // --- LISTEN FIRST (Satisfy Render/Healthchecks ASAP) ---
  if (!process.env.VERCEL) {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`\n>>> [BOOT] SERVIDOR ONLINE NA PORTA ${PORT} <<<`);
    });
  }

  console.log("Setting up Express app...");

  app.use(express.json());
  app.use(cookieParser(process.env.SESSION_SECRET || 'fallback_secret'));
  app.use(cors({
    origin: (origin, callback) => {
      // Permitir qualquer origem para que os cookies funcionem (CORS com credenciais exige origem específica, não *)
      callback(null, true);
    },
    credentials: true
  }));

  // Inicia os serviços robustos (nova arquitetura)
  robustSchedulerService.start();

  // Inicia o auto-search scheduler multi-afiliado
  autoSearchScheduler.start();
  // Mercado Livre nao tem scheduler proprio: o abastecimento roda dentro da Busca Automatica.

  // Limpeza automatica para impedir que logs e payloads temporarios crescam sem controle
  databaseCleanupService.start();

  // Mantem o processo acordado em hospedagens com idle timeout (Render free/low activity)
  renderKeepAliveService.start();

  // Executa o seeding em background (inclui seed de nichos)
  connectDB().then(async () => {
    await seedData();
    await seedNiches().catch(e => console.error('[NicheService] Falha no seed:', e));
    await databaseCleanupService.runCleanup('boot').catch(e => console.error('[DBCleanup] Falha apos boot:', e));
  }).catch(e => console.error("[Seed] Falha na inicializacao:", e));

  // Inicia serviço WhatsApp Web.js V2 (ES Module Compatible) - DESATIVADO PARA EVITAR CONFLITOS COM BAILEYS
  // connectDB().then(() => {
  //   whatsappWebJsServiceV2.loadPersistedSessions().catch(e => console.error("[WhatsAppWebJS V2] Falha ao carregar sessões:", e));
  // }).catch(e => console.error("[DB] Falha na conexão:", e));

  // Serviços antigos desativados para evitar conflitos
  // schedulerService.start();  // DESATIVADO
  connectDB().then(() => {
    waService.bootDaemon();
  }).catch(e => console.error("[WA:Legacy] Falha no background:", e));

  // Request logger
  app.use((req, res, next) => {
    if (process.env.VERBOSE_REQUEST_LOGS === 'true' && !/\.(?:js|css|png|jpg|jpeg|gif|svg|ico|webp|map|woff2?)($|\?)/i.test(req.url)) {
      console.log(`${req.method} ${req.url}`);
    }
    next();
  });

  // Middleware to ensure DB connection before handling API requests
  app.use(async (req, res, next) => {
    if (req.url.startsWith("/api/") && !req.url.includes("/health") && !req.url.includes("/debug")) {
      try {
        const connected = await connectDB();
        if (!connected) {
          return res.status(500).json({
            error: "Erro de conexão com o banco de dados",
            details: "O servidor não conseguiu se conectar ao MongoDB."
          });
        }
      } catch (e: any) {
        console.error("[DB] Erro crítico na conexão via middleware:", e);
        return res.status(500).json({ error: "Erro interno de conexão", details: e.message });
      }
    }
    next();
  });

  // Helper to create session
  const createSession = async (userId: string) => {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await Session.create({ userId, token, expiresAt });
    return token;
  };

  // --- BILLING / ENTITLEMENT HELPERS ---
  const getEntitlement = async (userId: any) => {
    try {
      const ent = await UserEntitlement.findOne({ userId });
      return ent || null;
    } catch { return null; }
  };

  const ensureEntitlement = async (userId: any) => {
    try {
      const existing = await UserEntitlement.findOne({ userId });
      const user = await UserM.findById(userId);
      const whitelist = ['bernardodealmeida0@gmail.com', 'stopolliny@gmail.com'];
      const isWhitelisted = user && whitelist.includes(user.email);

      if (!existing) {
        await UserEntitlement.create({
          userId,
          hasAccess: isWhitelisted,
          reason: isWhitelisted ? 'Manual whitelist' : 'No active subscription'
        });
      } else if (isWhitelisted && !existing.hasAccess) {
        existing.hasAccess = true;
        existing.reason = 'Manual whitelist';
        await existing.save();
      }
    } catch { }
  };

  const computeHasAccess = async (userId: any) => {
    const ent = await getEntitlement(userId);
    return !!ent?.hasAccess;
  };

  const PLATFORM_ADMIN_EMAIL = 'stopolliny@gmail.com';
  const isPrimaryAdmin = (user: any) =>
    user?.role === 'admin' &&
    String(user?.email || '').toLowerCase().trim() === PLATFORM_ADMIN_EMAIL;

  const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const normalizeCaktoValue = (value: any): string => String(value || '').trim();

  const parseCaktoWebhook = (payload: any) => {
    const eventRaw = normalizeCaktoValue(payload?.event || payload?.type || payload?.event_id || payload?.eventId).toLowerCase();
    const data = payload?.data || payload?.order || payload || {};
    const meta = data?.metadata || payload?.metadata || {};

    const candidateEmails = [
      meta?.email,
      meta?.userEmail,
      data?.customer?.email,
      payload?.customer?.email,
      data?.buyer?.email,
      payload?.buyer?.email,
      data?.email,
      payload?.email,
      data?.customer_email,
      payload?.customer_email,
      data?.contact?.email,
      payload?.contact?.email,
      data?.customer?.contact?.email,
    ]
      .map((value) => normalizeCaktoValue(value).toLowerCase())
      .filter(Boolean);

    const candidateUserIds = [
      meta?.userId,
      meta?.uid,
      data?.userId,
      payload?.userId,
      data?.external_id,
      payload?.external_id,
      data?.external_reference,
      payload?.external_reference,
      data?.sck,
      payload?.sck,
      data?.utm_content,
      payload?.utm_content,
    ]
      .map((value) => normalizeCaktoValue(value))
      .filter(Boolean)
      .map((value) => {
        const match = value.match(/[a-f0-9]{24}/i);
        return match ? match[0] : value;
      });

    const statusRaw = normalizeCaktoValue(
      data?.status ||
      payload?.status ||
      data?.payment_status ||
      payload?.payment_status
    ).toLowerCase();

    const isGrantEvent =
      eventRaw.includes('purchase_approved') ||
      eventRaw.includes('subscription_renewed') ||
      eventRaw.includes('paid') ||
      ['paid', 'completed', 'success'].includes(statusRaw);

    const isRevokeEvent =
      eventRaw.includes('refund') ||
      eventRaw.includes('chargeback') ||
      eventRaw.includes('subscription_canceled') ||
      ['refunded', 'chargedback', 'canceled', 'cancelled'].includes(statusRaw);

    const changeType: 'grant' | 'revoke' | 'ignore' =
      isGrantEvent ? 'grant' : isRevokeEvent ? 'revoke' : 'ignore';

    const planType = normalizeCaktoValue(
      meta?.planType ||
      meta?.planId ||
      data?.plan?.name ||
      data?.product?.name ||
      payload?.product?.name ||
      data?.plan_id ||
      payload?.plan_id ||
      data?.offer?.name ||
      payload?.offer?.name
    ) || 'Mensal';

    const externalId = normalizeCaktoValue(
      data?.id ||
      payload?.id ||
      data?.order_id ||
      payload?.order_id ||
      data?.refId ||
      payload?.refId
    );

    return {
      rawEvent: eventRaw,
      data,
      meta,
      candidateEmails,
      candidateUserIds,
      statusRaw,
      changeType,
      planType,
      externalId,
    };
  };

  // --- CACHE DE SESSÃO EM RAM (PARA EVITAR TRAVAMENTO DO DB) ---
  const sessionCache = new Map<string, { user: any, expires: number }>();

  // Middleware to check session
  const authMiddleware = async (req: any, res: any, next: any) => {
    const token = req.signedCookies.longevita_session || req.cookies.longevita_session;

    if (!token) {
      return res.status(401).json({ error: "Não autorizado" });
    }

    // 1. Verificação em Cache (Instantânea)
    const cached = sessionCache.get(token);
    if (cached && cached.expires > Date.now()) {
      req.user = cached.user;
      return next();
    }

    try {
      // 2. Fallback para o Banco (apenas se não estiver no cache)
      const session = await Session.findOne({ token, expiresAt: { $gt: new Date() } });
      if (!session) {
        res.clearCookie('longevita_session');
        return res.status(401).json({ error: "Sessão expirada ou inválida" });
      }

      const user = await User.findById(session.userId);
      if (!user) return res.status(401).json({ error: "Usuário não encontrado" });

      // Cacheamos por 5 minutos para desafogar o MongoDB
      sessionCache.set(token, {
        user,
        expires: Date.now() + (5 * 60 * 1000)
      });

      req.user = user;

      res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      next();
    } catch (err: any) {
      console.error(`[Auth] Erro no middleware:`, err.message);
      // Se o banco falhar mas tivermos algo no cache (mesmo que levemente expirado), usamos como emergência
      if (cached) {
        req.user = cached.user;
        return next();
      }
      return res.status(500).json({ error: "Erro de autenticação (Banco Indisponível)" });
    }
  };

  // API Routes
  app.get("/api/health", (req, res) => {
    const states = ["disconnected", "connected", "connecting", "disconnecting"];
    const dbState = mongoose.connection.readyState;

    res.json({
      status: "ok",
      db: {
        state: states[dbState] || "unknown",
        readyState: dbState,
        error: getDbError(),
        hint: dbState !== 1 ? "O banco de dados ainda está conectando..." : "Conectado!"
      },
      resend: {
        initialized: !!resend,
        from: RESEND_FROM,
        hasApiKey: !!resendApiKey
      },
      timestamp: new Date().toISOString()
    });
  });

  app.get("/api/debug", (req, res) => {
    res.send("API is reachable");
  });

  // WhatsApp Web.js Routes (Nova Arquitetura Robusta)
  app.use('/api/whatsapp-webjs', authMiddleware, whatsappWebJsRouter);

  // WhatsApp Web.js V2 Routes (ES Module Compatible)
  app.use('/api/whatsapp-webjs-v2', authMiddleware, whatsappWebJsV2Router);

  // WhatsApp Routes (Legado - será removido)
  app.get("/api/whatsapp/version", (req, res) => {
    res.json({ version: "Baileys (Chrome-Free-Multi)" });
  });

  app.get("/api/whatsapp/status", authMiddleware, async (req: any, res) => {
    try {
      const userId = req.user._id.toString();
      const status = await waService.getStatus(userId);
      // Log for debugging the UI drop
      console.log(`[Status Poll] User: ${userId} | Status: ${status.status} | HasQR: ${!!status.qrCodeUrl}`);
      res.json(status);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/whatsapp/connect", authMiddleware, async (req: any, res) => {
    try {
      const userId = req.user._id.toString();
      console.log(`[WhatsApp] Iniciando conexão para o usuário ${userId}... (Awaiting)`);
      waService.initialize(userId).catch(e => console.error(`[WhatsApp User:${userId}] Init Error:`, e));

      // Espera até 20s pelo primeiro estado (QR ou Conexo) para não derrubar o Lambda do Vercel
      await waService.waitForStatusChange(userId, 20000);

      const status = await waService.getStatus(userId);
      res.json({ success: true, status, message: "Conexão iniciada no servidor" });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/whatsapp/pair", authMiddleware, async (req: any, res) => {
    try {
      const { phoneNumber } = req.body;
      if (!phoneNumber) return res.status(400).json({ error: "Phone number is required" });
      const userId = req.user._id.toString();
      console.log(`[WhatsApp] Iniciando pareamento por número para ${userId}: ${phoneNumber}...`);
      waService.initialize(userId, phoneNumber).catch(e => console.error(`[WhatsApp User:${userId}] Pair Error:`, e));

      // Espera até 15s pelo código de pareamento no banco
      await waService.waitForStatusChange(userId, 15000);

      const status = await waService.getStatus(userId);
      res.json({ success: true, status, message: "Pareamento iniciado" });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/whatsapp/disconnect", authMiddleware, async (req: any, res) => {
    try {
      await waService.disconnect(req.user._id.toString());
      res.json({ success: true, message: "Disconnected" });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/whatsapp/reset", authMiddleware, async (req: any, res) => {
    try {
      const userId = req.user._id.toString();
      console.log(`[WhatsApp] Comando de RESET recebido para o usuário ${userId}`);
      await waService.disconnect(userId);

      // Limpa docs de autenticação do Baileys e web.js no MongoDB
      await WhatsAppAuth.deleteMany({ key: { $regex: `^(wa|session|qr)_${userId}` } });
      console.log(`[WhatsApp] Documentos WhatsAppAuth deletados para ${userId}`);

      try {
        const fs = require('fs');
        const path = require('path');
        const sessionPath = path.join(process.cwd(), '.sessions', `whatsapp_${userId}`);
        if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true, force: true });
      } catch (e) {
        console.error(`Erro ao limpar pasta da sessão:`, e);
      }

      res.json({ success: true, message: "Session reset" });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/whatsapp/groups/refresh", authMiddleware, async (req: any, res) => {
    try {
      const userId = req.user._id.toString();
      console.log(`[WhatsApp] Comando de REFRESH de grupos recebido para ${userId}`);
      await waService.refreshGroups(userId);
      res.json({ success: true, message: "Group refresh triggered" });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/whatsapp/send", authMiddleware, async (req: any, res) => {
    try {
      const { groupId, groupIds, message, imageUrl } = req.body;
      if ((!groupId && !groupIds) || !message) return res.status(400).json({ error: "Missing parameters" });

      const targets = groupIds || [groupId];
      const userId = req.user._id.toString();

      for (const targetId of targets) {
        await waService.sendMessage(userId, targetId, message, imageUrl);
      }

      res.json({ success: true, message: `Message sent to ${targets.length} targets` });
    } catch (e: any) {
      console.error(e);
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/whatsapp/bulk/create", authMiddleware, async (req: any, res) => {
    try {
      const { groupId, groupIds, links, intervalMinutes, startImmediately, settings } = req.body;
      const userId = req.user._id.toString();

      if ((!groupId && !groupIds) || !links || links.length === 0) {
        return res.status(400).json({ error: "Target group(s) and links are required" });
      }

      console.log(`[WhatsApp:Bulk] Criando disparo em massa para ${userId} em ${groupIds?.length || 1} destinos (${links.length} itens)`);

      const jobId = await robustSchedulerService.createJob({
        userId,
        groupId,
        groupIds,
        links,
        intervalMinutes: intervalMinutes || 1,
        startImmediately: startImmediately !== false, // Default to true if not specified
        settings: settings || { sendImages: true }
      });

      res.json({ success: true, message: "Job de disparo em massa criado", jobId });
    } catch (e: any) {
      console.error(`[WhatsApp:Bulk] Erro ao criar job:`, e);
      res.status(500).json({ error: e.message });
    }
  });

  // --- SHOPEE SEARCH (protegido por authMiddleware) ---
  app.post("/api/shopee/search", authMiddleware, async (req: any, res) => {
    try {
      const { query } = req.body;
      if (!query) return res.status(400).json({ error: "Query is required" });
      const results = await shopeeService.searchProducts(query);
      res.json({ products: results });
    } catch (e: any) {
      console.error("[Shopee API Error]", e);
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/shopee/info", authMiddleware, async (req: any, res) => {
    try {
      const { url } = req.body;
      if (!url) return res.status(400).json({ error: "URL is required" });
      const product = await shopeeService.getProductInfoByUrl(url);
      if (!product) return res.status(404).json({ error: "Produto não encontrado ou link inválido" });
      res.json(product);
    } catch (e: any) {
      console.error("[Shopee Info API Error]", e);
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/shopee/shorten", authMiddleware, async (req: any, res) => {
    try {
      const { url, subIds } = req.body;
      if (!url) return res.status(400).json({ error: "URL is required" });
      const shortLink = await shopeeService.generateShortLink(url, subIds);
      res.json({ shortLink });
    } catch (e: any) {
      console.error("[Shopee Shorten API Error]", e);
      res.status(500).json({ error: e.message });
    }
  });

  // ─── SHOPEE AFFILIATE CREDENTIALS ────────────────────────────────────────────

  /** GET /api/affiliate/shopee — Status das credenciais (mascarado) */
  app.get('/api/affiliate/shopee', authMiddleware, async (req: any, res) => {
    try {
      const userId = req.user._id;
      const cred = await ShopeeCredential.findOne({ userId }).lean() as any;
      if (!cred) return res.json({ configured: false });
      res.json({
        configured: true,
        provider: cred.provider,
        appId: maskAppId(cred.appId),
        endpoint: cred.endpoint,
        isActive: cred.isActive,
        lastValidationStatus: cred.lastValidationStatus,
        lastValidationError: cred.isActive ? undefined : cred.lastValidationError
      });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  /** POST /api/affiliate/shopee — Salvar/Atualizar credenciais */
  app.post('/api/affiliate/shopee', authMiddleware, async (req: any, res) => {
    try {
      const userId = req.user._id;
      const { appId, secret, endpoint } = req.body;
      if (!appId || !secret) return res.status(400).json({ error: 'appId e secret são obrigatórios' });

      const secretEncrypted = encryptSecret(secret);
      const ep = endpoint || 'https://open-api.affiliate.shopee.com.br/graphql';

      // Testar credenciais antes de salvar
      const client = createShopeeClient({ appId, secret, endpoint: ep });
      const { valid, error: valErr } = await client.testConnection();

      const update: any = {
        appId,
        secretEncrypted,
        endpoint: ep,
        isActive: valid,
        lastValidationStatus: valid ? 'valid' : 'invalid',
        lastValidationError: valid ? undefined : (valErr || 'Credenciais inválidas'),
        updatedAt: new Date()
      };

      await ShopeeCredential.findOneAndUpdate(
        { userId },
        { $set: update, $setOnInsert: { userId, provider: 'shopee', createdAt: new Date() } },
        { upsert: true }
      );

      if (!valid) {
        return res.status(422).json({
          success: false,
          message: 'Não foi possível validar suas credenciais da Shopee. Confira seu APP_ID e SECRET.',
          error: valErr
        });
      }

      res.json({ success: true, message: 'Credenciais conectadas com sucesso.' });
    } catch (e: any) {
      console.error('[Affiliate] Erro ao salvar credenciais:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  /** POST /api/affiliate/shopee/test — Testar credenciais sem salvar */
  app.post('/api/affiliate/shopee/test', authMiddleware, async (req: any, res) => {
    try {
      const { appId, secret, endpoint } = req.body;
      if (!appId || !secret) return res.status(400).json({ error: 'appId e secret são obrigatórios' });
      const ep = endpoint || 'https://open-api.affiliate.shopee.com.br/graphql';
      const client = createShopeeClient({ appId, secret, endpoint: ep });
      const result = await client.testConnection();
      res.json(result);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  /** DELETE /api/affiliate/shopee — Remover credenciais */
  app.delete('/api/affiliate/shopee', authMiddleware, async (req: any, res) => {
    try {
      const userId = req.user._id;
      await ShopeeCredential.deleteOne({ userId });
      res.json({ success: true, message: 'Credenciais removidas.' });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // ─── NICHOS ──────────────────────────────────────────────────────────────────

  /** AliExpress Affiliate Credentials */
  app.get('/api/affiliate/aliexpress', authMiddleware, async (req: any, res) => {
    try {
      const userId = String(req.user._id);
      res.json(await aliexpressAffiliateService.status(userId));
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/affiliate/aliexpress/test', authMiddleware, async (req: any, res) => {
    try {
      const { appKey, appSecret, trackingId, endpoint } = req.body || {};
      const normalizedAppKey = String(appKey || '').trim();
      const normalizedAppSecret = String(appSecret || '').trim();
      if (!normalizedAppKey || !normalizedAppSecret) return res.status(400).json({ valid: false, error: 'App Key e App Secret sao obrigatorios.' });
      res.json(await aliexpressAffiliateService.test({
        appKey: normalizedAppKey,
        appSecret: normalizedAppSecret,
        trackingId: String(trackingId || 'default').trim() || 'default',
        endpoint: String(endpoint || '').trim()
      }));
    } catch (e: any) { res.status(500).json({ valid: false, error: e.message }); }
  });

  app.post('/api/affiliate/aliexpress', authMiddleware, async (req: any, res) => {
    try {
      const userId = req.user._id;
      const { appKey, appSecret, trackingId, endpoint } = req.body || {};
      const normalizedAppKey = String(appKey || '').trim();
      const normalizedAppSecret = String(appSecret || '').trim();
      const normalizedTrackingId = String(trackingId || 'default').trim() || 'default';
      const ep = String(endpoint || 'https://api-sg.aliexpress.com/sync').trim() || 'https://api-sg.aliexpress.com/sync';
      if (!normalizedAppKey || !normalizedAppSecret) return res.status(400).json({ error: 'App Key e App Secret sao obrigatorios.' });
      const validation = await aliexpressAffiliateService.test({
        appKey: normalizedAppKey,
        appSecret: normalizedAppSecret,
        trackingId: normalizedTrackingId,
        endpoint: ep
      });
      const update = {
        appKey: normalizedAppKey,
        appSecretEncrypted: encryptSecret(normalizedAppSecret),
        trackingId: normalizedTrackingId,
        endpoint: ep,
        isActive: !!validation.valid,
        lastValidationStatus: validation.valid ? 'valid' : 'invalid',
        lastValidationError: validation.valid ? undefined : validation.error,
        updatedAt: new Date()
      };
      await AliExpressCredential.findOneAndUpdate(
        { userId },
        { $set: update, $setOnInsert: { userId, createdAt: new Date() } },
        { upsert: true }
      );
      if (!validation.valid) {
        return res.status(422).json({ success: false, message: 'Nao foi possivel validar as credenciais AliExpress.', error: validation.error });
      }
      res.json({ success: true, message: 'Credenciais AliExpress conectadas com sucesso.' });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete('/api/affiliate/aliexpress', authMiddleware, async (req: any, res) => {
    try {
      const userId = req.user._id;
      await AliExpressCredential.deleteOne({ userId });
      res.json({ success: true, message: 'Credenciais AliExpress removidas.' });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  /** GET /api/niches — Lista nichos ativos */
  app.get('/api/shopee/performance', authMiddleware, async (req: any, res) => {
    try {
      const range = String(req.query.range || 'yesterday');
      const saoPauloParts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Sao_Paulo',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      }).formatToParts(new Date()).reduce((acc: any, part) => {
        if (part.type !== 'literal') acc[part.type] = Number(part.value);
        return acc;
      }, {});
      const daysByRange: Record<string, number> = { yesterday: 1, '7d': 7, '30d': 30, '90d': 90 };
      const days = daysByRange[range] || 1;
      const todayUtcNoon = Date.UTC(saoPauloParts.year, saoPauloParts.month - 1, saoPauloParts.day, 12, 0, 0);
      const yesterdayUtcNoon = todayUtcNoon - 24 * 60 * 60 * 1000;
      const startDayUtcNoon = yesterdayUtcNoon - (days - 1) * 24 * 60 * 60 * 1000;
      const startDay = new Date(startDayUtcNoon);
      const endDay = new Date(yesterdayUtcNoon);
      const start = new Date(Date.UTC(startDay.getUTCFullYear(), startDay.getUTCMonth(), startDay.getUTCDate(), 3, 0, 0, 0));
      const end = new Date(Date.UTC(endDay.getUTCFullYear(), endDay.getUTCMonth(), endDay.getUTCDate() + 1, 2, 59, 59, 999));

      const userId = req.user._id;
      const cred = await ShopeeCredential.findOne({ userId, isActive: true }).lean() as any;
      let apiReport: any = {
        source: 'none',
        orders: [],
        summary: {
          clicksFromConversions: 0,
          orders: 0,
          confirmedOrders: 0,
          grossRevenue: 0,
          estimatedCommission: 0,
          validatedCommission: 0
        },
        error: cred ? '' : 'Credenciais Shopee nao configuradas.'
      };

      if (cred?.secretEncrypted) {
        const client = createShopeeClient({
          appId: cred.appId,
          secret: decryptSecret(cred.secretEncrypted),
          endpoint: cred.endpoint
        });
        apiReport = await client.getPerformanceReport(Math.floor(start.getTime() / 1000), Math.floor(end.getTime() / 1000));
      }

      const shopeeLinks = await AffiliateLink.find({ userId, platform: { $regex: /shopee/i } }).select('_id').lean() as any[];
      const shopeeLinkIds = shopeeLinks.map(link => link._id);
      const [trackedClicks, sentPromotions, sentGroups, topSentProducts] = await Promise.all([
        shopeeLinkIds.length
          ? AffiliateClick.countDocuments({
            $or: [{ linkId: { $in: shopeeLinkIds } }, { affiliateLinkId: { $in: shopeeLinkIds } }],
            createdAt: { $gte: start, $lte: end }
          } as any)
          : Promise.resolve(0),
        PostedDeal.countDocuments({ userId, provider: 'shopee', status: 'sent', sentAt: { $gte: start, $lte: end } }),
        PostedDeal.distinct('groupId', { userId, provider: 'shopee', status: 'sent', sentAt: { $gte: start, $lte: end } }),
        PostedDeal.aggregate([
          { $match: { userId: new mongoose.Types.ObjectId(String(userId)), provider: 'shopee', status: 'sent', sentAt: { $gte: start, $lte: end } } },
          { $group: { _id: '$productName', total: { $sum: 1 }, lastPrice: { $last: '$price' }, itemId: { $last: '$itemId' } } },
          { $sort: { total: -1 } },
          { $limit: 5 }
        ])
      ]);

      const localClicks = Number(trackedClicks || 0);
      const convertedClicks = Number(apiReport.summary?.clicksFromConversions || 0);
      const orders = Number(apiReport.summary?.orders || 0);
      const confirmedOrders = Number(apiReport.summary?.confirmedOrders || 0);
      const grossRevenue = Number(apiReport.summary?.grossRevenue || 0);
      const estimatedCommission = Number(apiReport.summary?.estimatedCommission || 0);
      const validatedCommission = Number(apiReport.summary?.validatedCommission || 0);

      res.json({
        success: true,
        range,
        period: { start, end, note: 'A Shopee consolida as metricas em D+1; os periodos terminam em ontem.' },
        configured: !!cred,
        appIdMasked: cred?.appId ? `${String(cred.appId).slice(0, 4)}${'*'.repeat(Math.max(4, String(cred.appId).length - 4))}` : '',
        api: { source: apiReport.source, error: apiReport.error || '', supported: apiReport.source !== 'none' },
        metrics: {
          convertedClicks,
          localTrackedClicks: localClicks,
          apiClicksFromConversions: convertedClicks,
          sentPromotions,
          activeGroups: sentGroups.filter(Boolean).length,
          orders,
          confirmedOrders,
          grossRevenue,
          estimatedCommission,
          validatedCommission,
          conversionRate: convertedClicks > 0 ? (orders / convertedClicks) * 100 : 0,
          epc: convertedClicks > 0 ? estimatedCommission / convertedClicks : 0
        },
        topProducts: topSentProducts.map((item: any) => ({
          productName: item._id || 'Produto sem nome',
          totalSent: item.total || 0,
          lastPrice: item.lastPrice || 0,
          itemId: item.itemId || ''
        })),
        recentOrders: (apiReport.orders || []).slice(0, 8)
      });
    } catch (e: any) {
      res.status(500).json({ success: false, errorMessage: e.message });
    }
  });

  app.get('/api/affiliate/providers', authMiddleware, async (req: any, res) => {
    try {
      const userId = req.user._id;
      const mercadoLivreConfig = await MercadoLivreConfig.findOne({ userId }).lean() as any;
      const genericCredentials = await AffiliateCredential.find({ userId, provider: { $in: ['amazon'] } }).lean() as any[];
      const genericByProvider = Object.fromEntries(genericCredentials.map((cred: any) => [cred.provider, cred]));
      let amazonAffiliateTagPreview = '';
      let amazonCookieLength = 0;
      if (genericByProvider.amazon?.affiliateTagEncrypted) {
        try {
          const value = decryptSecret(genericByProvider.amazon.affiliateTagEncrypted);
          amazonAffiliateTagPreview = `${String(value).slice(0, 4)}${'*'.repeat(Math.min(Math.max(String(value).length - 4, 4), 16))}`;
        } catch {}
      }
      if (genericByProvider.amazon?.cookiesEncrypted) {
        try { amazonCookieLength = decryptSecret(genericByProvider.amazon.cookiesEncrypted).length; } catch {}
      }
      const byProvider: any = {
        mercadolivre: {
          configured: !!mercadoLivreConfig?.mercadoLivreAffiliateTagEncrypted,
          provider: 'mercadolivre',
          hasAffiliateTag: !!mercadoLivreConfig?.mercadoLivreAffiliateTagEncrypted,
          isActive: mercadoLivreConfig?.enabled !== false,
          mode: 'n8n_json',
          service: mercadoLivreN8nJsonService.serviceName
        },
        amazon: {
          configured: !!genericByProvider.amazon,
          provider: 'amazon',
          hasAffiliateTag: !!genericByProvider.amazon?.affiliateTagEncrypted,
          affiliateTagPreview: amazonAffiliateTagPreview,
          hasCookie: !!genericByProvider.amazon?.cookiesEncrypted,
          cookieLength: amazonCookieLength,
          isActive: !!genericByProvider.amazon?.isActive,
          mode: genericByProvider.amazon?.mode || 'automatic',
          lastValidationStatus: genericByProvider.amazon?.lastValidationStatus || 'pending',
          lastValidationError: genericByProvider.amazon?.isActive ? undefined : genericByProvider.amazon?.lastValidationError,
          updatedAt: genericByProvider.amazon?.updatedAt
        }
      };
      res.json(byProvider);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/affiliate/provider/:provider/test', authMiddleware, async (req: any, res) => {
    try {
      const providerId = normalizeProviderId(req.params.provider);
      if (!providerId || providerId === 'shopee') return res.status(400).json({ error: 'Provider inválido.' });
      const { appId, accessKey, clientId, secret, accessToken, refreshToken, partnerTag, cookies, csrfToken, affiliateTag, endpoint, marketplace, mode, fallbackSearchEnabled, sessionExpiresAt } = req.body || {};
      const result = await providerRegistry[providerId].validateCredentials({
        provider: providerId,
        appId: appId || accessKey || clientId,
        accessKey,
        clientId,
        secret,
        accessToken,
        refreshToken,
        partnerTag,
        cookies,
        csrfToken,
        affiliateTag,
        endpoint,
        marketplace,
        mode: 'automatic'
      });
      res.json(result);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/affiliate/provider/:provider', authMiddleware, async (req: any, res) => {
    try {
      const userId = req.user._id;
      const providerId = normalizeProviderId(req.params.provider);
      if (!providerId || providerId === 'shopee') return res.status(400).json({ error: 'Provider inválido.' });
      const { appId, accessKey, clientId, secret, accessToken, refreshToken, partnerTag, cookies, csrfToken, affiliateTag, endpoint, marketplace, mode, fallbackSearchEnabled, sessionExpiresAt, navigationUserAgent, navigationHeaders } = req.body || {};
      const normalizedAppId = appId || accessKey || clientId || '';
      const existingCredential = await AffiliateCredential.findOne({ userId, provider: providerId }).lean() as any;
      const selectedMode = 'automatic';
      const validation = await providerRegistry[providerId].validateCredentials({
        provider: providerId,
        appId: normalizedAppId,
        accessKey,
        clientId,
        secret,
        accessToken,
        refreshToken,
        partnerTag,
        cookies,
        csrfToken,
        affiliateTag,
        endpoint,
        marketplace,
        mode: selectedMode
      });
      const isActive = validation.valid;
      const secretEncrypted = secret ? encryptSecret(secret) : undefined;
      const accessTokenEncrypted = accessToken ? encryptSecret(accessToken) : undefined;
      const refreshTokenEncrypted = refreshToken ? encryptSecret(refreshToken) : undefined;
      const cookiesEncrypted = cookies ? encryptSecret(cookies) : undefined;
      const csrfTokenEncrypted = csrfToken ? encryptSecret(csrfToken) : undefined;
      const affiliateTagEncrypted = affiliateTag ? encryptSecret(affiliateTag) : undefined;
      const sessionReady = false;

      let filteredHeaders = undefined;
      if (navigationHeaders) {
        try {
          const parsedHeaders = JSON.parse(navigationHeaders);
          const allowedHeaders = [
            'accept', 'accept-language', 'user-agent', 'sec-ch-ua', 
            'sec-ch-ua-mobile', 'sec-ch-ua-platform', 'sec-fetch-site', 
            'sec-fetch-mode', 'sec-fetch-dest', 'upgrade-insecure-requests'
          ];
          const finalHeaders: any = {};
          for (const [k, v] of Object.entries(parsedHeaders)) {
            const lowerK = k.toLowerCase();
            if (allowedHeaders.includes(lowerK)) {
              finalHeaders[lowerK] = v;
            }
          }
          if (Object.keys(finalHeaders).length > 0) {
            filteredHeaders = JSON.stringify(finalHeaders);
          }
        } catch (e) {}
      }
      await AffiliateCredential.findOneAndUpdate(
        { userId, provider: providerId },
        {
          $set: {
            appId: normalizedAppId,
            accessKey,
            clientId: clientId,
            ...(secretEncrypted ? { secretEncrypted } : {}),
            ...(accessTokenEncrypted ? { accessTokenEncrypted } : {}),
            ...(refreshTokenEncrypted ? { refreshTokenEncrypted } : {}),
            ...(cookiesEncrypted ? { cookiesEncrypted } : {}),
            ...(csrfTokenEncrypted ? { csrfTokenEncrypted } : {}),
            ...(affiliateTagEncrypted ? { affiliateTagEncrypted } : {}),
            ...(navigationUserAgent ? { navigationUserAgent } : { navigationUserAgent: '' }),
            ...(filteredHeaders !== undefined ? { navigationHeaders: filteredHeaders } : { navigationHeaders: '' }),
            partnerTag,
            endpoint,
            marketplace: marketplace || 'BR',
            isActive,
            mode: selectedMode,
            fallbackSearchEnabled: !!fallbackSearchEnabled,
            sessionStatus: undefined,
            ...(sessionExpiresAt ? { sessionExpiresAt: new Date(sessionExpiresAt) } : {}),
            lastValidationStatus: isActive ? 'valid' : 'invalid',
            lastValidationError: isActive ? undefined : validation.error,
            updatedAt: new Date()
          },
          $setOnInsert: { userId, provider: providerId, createdAt: new Date() }
        },
        { upsert: true }
      );
      if (!isActive) {
        return res.status(422).json({ success: false, message: 'Credenciais inválidas.', error: validation.error, errorType: validation.errorType });
      }
      res.json({ success: true, message: 'Credenciais conectadas com sucesso.' });
    } catch (e: any) {
      console.error('[Affiliate] Erro ao salvar provider:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  app.delete('/api/affiliate/provider/:provider', authMiddleware, async (req: any, res) => {
    try {
      const userId = req.user._id;
      const providerId = normalizeProviderId(req.params.provider);
      if (!providerId || providerId === 'shopee') return res.status(400).json({ error: 'Provider inválido.' });
      await AffiliateCredential.deleteOne({ userId, provider: providerId });
      res.json({ success: true, message: 'Credenciais removidas.' });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  const mercadoLivreOAuthDisabled = (_req: any, res: any) => res.status(410).json({ success: false, errorType: 'legacy_disabled', errorMessage: 'OAuth/App ID/Secret do Mercado Livre foi desativado. A integracao ativa usa apenas a tag de afiliado e o JSON n8n.' });
  app.get('/api/affiliate/mercadolivre/connect', authMiddleware, mercadoLivreOAuthDisabled);
  app.get('/api/affiliate/mercadolivre/callback', mercadoLivreOAuthDisabled);

  app.post('/api/mercadolivre/session-test', authMiddleware, async (req: any, res) => {
    try {
      res.json({ success: true, ...mercadoLivreN8nJsonService.getDiagnostics() });
    } catch (e: any) {
      res.status(500).json({ success: false, errorType: 'session_test_failed', errorMessage: e.message });
    }
  });

  // ==========================================
  // MERCADO LIVRE — NOVAS ROTAS /api/ml/*
  // ==========================================

  // ─── CONFIG ───────────────────────────────────────────────────────────────
  app.get('/api/ml/config', authMiddleware, async (req: any, res) => {
    try {
      const config = await mercadoLivreN8nJsonService.getSafeConfig(String(req.user._id));
      res.json({ success: true, config });
    } catch (e: any) { res.status(500).json({ success: false, errorMessage: e.message }); }
  });

  app.put('/api/ml/config', authMiddleware, mercadoLivreCouponAlertUploadMiddleware, async (req: any, res) => {
    try {
      const config = await mercadoLivreN8nJsonService.saveConfig(
        String(req.user._id),
        req.body || {},
        encryptSecret,
        { couponAlertImageFile: req.file || null }
      );
      res.json({ success: true, config });
    } catch (e: any) { res.status(Number(e?.httpStatus || 500)).json({ success: false, errorType: e?.errorType || 'mercadolivre_config_save_failed', errorMessage: e.message }); }
  });

  app.post('/api/ml/config', authMiddleware, mercadoLivreCouponAlertUploadMiddleware, async (req: any, res) => {
    try {
      const config = await mercadoLivreN8nJsonService.saveConfig(
        String(req.user._id),
        req.body || {},
        encryptSecret,
        { couponAlertImageFile: req.file || null }
      );
      res.json({ success: true, config });
    } catch (e: any) { res.status(Number(e?.httpStatus || 500)).json({ success: false, errorType: e?.errorType || 'mercadolivre_config_save_failed', errorMessage: e.message }); }
  });

  // ─── AFFILIATE TAG ────────────────────────────────────────────────────────
  app.get('/api/ml/affiliate-tag', authMiddleware, async (req: any, res) => {
    try {
      const cfg: any = await MercadoLivreConfig.findOne({ userId: req.user._id });
      const hasTag = !!(cfg?.mercadoLivreAffiliateTagEncrypted);
      let tag = '';
      if (hasTag) {
        try {
          const decrypted = decryptSecret(cfg.mercadoLivreAffiliateTagEncrypted);
          tag = `${String(decrypted).slice(0, 4)}${'*'.repeat(Math.min(Math.max(String(decrypted).length - 4, 8), 32))}`;
        } catch { tag = '****'; }
      }
      res.json({ success: true, hasTag, tagMasked: tag });
    } catch (e: any) { res.status(500).json({ success: false, errorMessage: e.message }); }
  });

  app.put('/api/ml/affiliate-tag', authMiddleware, async (req: any, res) => {
    try {
      const { affiliateTag } = req.body;
      if (!affiliateTag || typeof affiliateTag !== 'string' || affiliateTag.trim().length < 3) {
        return res.status(400).json({ success: false, errorMessage: 'Tag de afiliado inválida.' });
      }
      const encrypted = encryptSecret(affiliateTag.trim());
      await MercadoLivreConfig.findOneAndUpdate(
        { userId: req.user._id },
        { $set: { mercadoLivreAffiliateTagEncrypted: encrypted, enabled: true, updatedAt: new Date() } },
        { upsert: true, new: true }
      );
      res.json({ success: true, message: 'Tag de afiliado salva com sucesso.' });
    } catch (e: any) { res.status(500).json({ success: false, errorMessage: e.message }); }
  });

  // ─── NICHOS ───────────────────────────────────────────────────────────────
  app.get('/api/ml/niches', authMiddleware, async (req: any, res) => {
    try {
      const niches = await MercadoLivreNiche.find({ userId: req.user._id }).sort({ priority: -1, createdAt: -1 });
      res.json({ success: true, niches });
    } catch (e: any) { res.status(500).json({ success: false, errorMessage: e.message }); }
  });

  app.post('/api/ml/niches', authMiddleware, async (req: any, res) => {
    try {
      const { name, active, urls, keywords, priority, maxProducts } = req.body;
      if (!name) return res.status(400).json({ success: false, errorMessage: 'Nome do nicho é obrigatório.' });
      const niche = await MercadoLivreNiche.create({
        userId: req.user._id, name, active: active ?? true,
        urls: urls || [], keywords: keywords || [],
        priority: priority ?? 1, maxProducts: maxProducts ?? 50
      });
      res.json({ success: true, niche });
    } catch (e: any) { res.status(500).json({ success: false, errorMessage: e.message }); }
  });

  app.put('/api/ml/niches/:id', authMiddleware, async (req: any, res) => {
    try {
      const { name, active, urls, keywords, priority, maxProducts } = req.body;
      const upd: any = { updatedAt: new Date() };
      if (name !== undefined) upd.name = name;
      if (active !== undefined) upd.active = active;
      if (urls !== undefined) upd.urls = urls;
      if (keywords !== undefined) upd.keywords = keywords;
      if (priority !== undefined) upd.priority = priority;
      if (maxProducts !== undefined) upd.maxProducts = maxProducts;
      const niche = await MercadoLivreNiche.findOneAndUpdate(
        { _id: req.params.id, userId: req.user._id }, { $set: upd }, { new: true }
      );
      if (!niche) return res.status(404).json({ success: false, errorMessage: 'Nicho não encontrado.' });
      res.json({ success: true, niche });
    } catch (e: any) { res.status(500).json({ success: false, errorMessage: e.message }); }
  });

  app.delete('/api/ml/niches/:id', authMiddleware, async (req: any, res) => {
    try {
      await MercadoLivreNiche.findOneAndDelete({ _id: req.params.id, userId: req.user._id });
      res.json({ success: true });
    } catch (e: any) { res.status(500).json({ success: false, errorMessage: e.message }); }
  });

  // Seed dos nichos padrão
  app.post('/api/ml/niches/seed', authMiddleware, async (req: any, res) => {
    try {
      const userId = req.user._id;
      const existing = await MercadoLivreNiche.find({ userId }).lean() as any[];
      const existingNames = new Set(existing.map((n: any) => n.name.toLowerCase()));
      const toCreate = DEFAULT_NICHES.filter(n => !existingNames.has(n.name.toLowerCase()));
      if (toCreate.length === 0) return res.json({ success: true, created: 0, message: 'Todos os nichos padrão já existem.' });
      const created = await MercadoLivreNiche.insertMany(
        toCreate.map((n, i) => ({ userId, name: n.name, active: false, urls: n.urls, keywords: n.keywords, priority: DEFAULT_NICHES.length - i, maxProducts: 50 }))
      );
      res.json({ success: true, created: created.length, message: `${created.length} nichos criados.` });
    } catch (e: any) { res.status(500).json({ success: false, errorMessage: e.message }); }
  });

  // ─── PRODUTOS ─────────────────────────────────────────────────────────────
  app.get('/api/ml/products', authMiddleware, async (req: any, res) => {
    try {
      const { status, nicheId, page = 1, limit = 50 } = req.query as any;
      const query: any = { userId: req.user._id };
      if (status) query.status = status;
      if (nicheId) query.nicheId = nicheId;
      const skip = (Number(page) - 1) * Number(limit);
      const [products, total] = await Promise.all([
        MercadoLivreRawProduct.find(query).sort({ updatedAt: -1 }).skip(skip).limit(Number(limit)).lean(),
        MercadoLivreRawProduct.countDocuments(query)
      ]);
      // Contadores por status
      const [novo, pronto, enviado, erro, capturado] = await Promise.all([
        MercadoLivreRawProduct.countDocuments({ userId: req.user._id, status: { $in: ['NOVO', 'capturado'] } }),
        MercadoLivreRawProduct.countDocuments({ userId: req.user._id, status: { $in: ['PRONTO', 'pronto'] } }),
        MercadoLivreRawProduct.countDocuments({ userId: req.user._id, status: { $in: ['ENVIADO', 'enviado'] } }),
        MercadoLivreRawProduct.countDocuments({ userId: req.user._id, status: { $in: ['ERRO', 'erro'] } }),
        MercadoLivreRawProduct.countDocuments({ userId: req.user._id, status: 'capturado' }),
      ]);
      res.json({ success: true, products, total, page: Number(page), pages: Math.ceil(total / Number(limit)), counts: { novo: novo + capturado, pronto, enviado, erro } });
    } catch (e: any) { res.status(500).json({ success: false, errorMessage: e.message }); }
  });

  app.delete('/api/ml/products/clear', authMiddleware, async (req: any, res) => {
    try {
      const { status } = req.query as any;
      const query: any = { userId: req.user._id };
      if (status) query.status = status;
      const result = await MercadoLivreRawProduct.deleteMany(query);
      res.json({ success: true, deleted: result.deletedCount });
    } catch (e: any) { res.status(500).json({ success: false, errorMessage: e.message }); }
  });

  // ─── HISTÓRICO ────────────────────────────────────────────────────────────
  app.get('/api/ml/history', authMiddleware, async (req: any, res) => {
    try {
      const { page = 1, limit = 20 } = req.query as any;
      const skip = (Number(page) - 1) * Number(limit);
      const [history, total] = await Promise.all([
        MercadoLivreRunHistory.find({ userId: req.user._id }).sort({ startedAt: -1 }).skip(skip).limit(Number(limit)).lean(),
        MercadoLivreRunHistory.countDocuments({ userId: req.user._id })
      ]);
      res.json({ success: true, history, total });
    } catch (e: any) { res.status(500).json({ success: false, errorMessage: e.message }); }
  });

  // ─── ESTATÍSTICAS ─────────────────────────────────────────────────────────
  app.get('/api/ml/stats', authMiddleware, async (req: any, res) => {
    try {
      const userId = req.user._id;
      const [novo, pronto, enviado, erro, total, nicheCount, lastRun, lastCleanup, cfg, autoCfg] = await Promise.all([
        MercadoLivreRawProduct.countDocuments({ userId, status: { $in: ['NOVO', 'capturado'] } }),
        MercadoLivreRawProduct.countDocuments({ userId, status: { $in: ['PRONTO', 'pronto'] } }),
        MercadoLivreRawProduct.countDocuments({ userId, status: { $in: ['ENVIADO', 'enviado'] } }),
        MercadoLivreRawProduct.countDocuments({ userId, status: { $in: ['ERRO', 'erro'] } }),
        MercadoLivreRawProduct.countDocuments({ userId }),
        MercadoLivreNiche.countDocuments({ userId }),
        MercadoLivreRunHistory.findOne({ userId }).sort({ startedAt: -1 }).lean(),
        MercadoLivreRunHistory.findOne({ userId, phase: { $in: ['cleanup', 'daily_cleanup'] } }).sort({ startedAt: -1 }).lean(),
        MercadoLivreConfig.findOne({ userId }).lean(),
        AutoSearchConfig.findOne({ userId, isActive: true, providersEnabled: 'mercadolivre' }).sort({ nextRunAt: 1 }).lean()
      ]);
      const stockNeed = autoCfg ? mercadoLivreN8nJsonService.calculateAutoSearchStockNeed(autoCfg) : null;
      const currentCycle = autoCfg ? mercadoLivreN8nJsonService.getCycleInfo(String(userId), autoCfg) : null;
      const sentInCycle = currentCycle
        ? await MercadoLivreRawProduct.countDocuments({ userId, cycleId: currentCycle.cycleId, status: { $in: ['ENVIADO', 'enviado'] } })
        : 0;
      const remainingInCycle = currentCycle
        ? await MercadoLivreRawProduct.countDocuments({ userId, cycleId: currentCycle.cycleId, status: { $in: ['NOVO', 'PRONTO', 'capturado', 'pronto'] } })
        : 0;
      res.json({
        success: true,
        stats: {
          novo, pronto, enviado, erro, total,
          activeNiches: nicheCount,
          hasAffiliateTag: !!(cfg as any)?.mercadoLivreAffiliateTagEncrypted,
          hasCookie: !!(cfg as any)?.cookieEncrypted,
          enabled: !!(cfg as any)?.enabled,
          lastRunAt: (cfg as any)?.lastRunAt,
          lastStatus: (cfg as any)?.lastStatus,
          stockNeed,
          currentCycle,
          sentInCycle,
          remainingInCycle,
          lastCleanup: lastCleanup || null,
          nextAutoSearchRunAt: (autoCfg as any)?.nextRunAt,
          lastRun: lastRun || null
        }
      });
    } catch (e: any) { res.status(500).json({ success: false, errorMessage: e.message }); }
  });

  // ─── EXECUÇÕES MANUAIS ────────────────────────────────────────────────────
  app.post('/api/ml/run/search', authMiddleware, async (req: any, res) => {
    try {
      const userId = req.user._id.toString();
      const result = await mercadoLivreN8nJsonService.run(userId, 'manual', 'search');
      res.status(result.success ? 200 : 422).json(result);
    } catch (e: any) { res.status(500).json({ success: false, errorMessage: e.message }); }
  });

  app.post('/api/ml/run/affiliate', authMiddleware, async (req: any, res) => {
    try {
      const userId = req.user._id.toString();
      const result = await mercadoLivreN8nJsonService.run(userId, 'manual', 'affiliate');
      res.status(result.success ? 200 : 422).json(result);
    } catch (e: any) { res.status(500).json({ success: false, errorMessage: e.message }); }
  });

  app.post('/api/ml/run/send', authMiddleware, async (req: any, res) => {
    res.status(410).json({ success: false, errorType: 'standalone_send_disabled', errorMessage: 'Envio Mercado Livre separado foi desativado. Use Busca Automatica em modo compare.' });
  });

  app.post('/api/ml/run/full', authMiddleware, async (req: any, res) => {
    try {
      const userId = req.user._id.toString();
      const result = await mercadoLivreN8nJsonService.run(userId, 'manual', 'full');
      res.json(result);
    } catch (e: any) { res.status(500).json({ success: false, errorMessage: e.message }); }
  });

  app.get('/api/mercadolivre/config', authMiddleware, async (req: any, res) => {
    try {
      const config = await mercadoLivreN8nJsonService.getSafeConfig(String(req.user._id));
      const niches = await MercadoLivreNiche.find({ userId: req.user._id }).sort({ priority: -1, createdAt: -1 });
      res.json({ success: true, config, niches });
    } catch (e: any) { res.status(500).json({ success: false, errorMessage: e.message }); }
  });

  app.post('/api/mercadolivre/config', authMiddleware, async (req: any, res) => {
    try {
      const config = await mercadoLivreN8nJsonService.saveConfig(String(req.user._id), req.body || {}, encryptSecret);
      res.json({ success: true, config });
    } catch (e: any) { res.status(500).json({ success: false, errorMessage: e.message }); }
  });

  app.post('/api/mercadolivre/test', authMiddleware, async (req: any, res) => {
    try {
      const phase = (req.body?.phase || 'search') as 'search' | 'affiliate' | 'send' | 'full';
      const result = await mercadoLivreN8nJsonService.run(req.user._id.toString(), 'test', phase);
      res.status(result.success ? 200 : 422).json(result);
    } catch (e: any) { res.status(500).json({ success: false, errorMessage: e.message }); }
  });

  app.post('/api/mercadolivre/run', authMiddleware, async (req: any, res) => {
    try {
      const phase = (req.body?.phase || 'full') as 'search' | 'affiliate' | 'send' | 'full';
      const result = await mercadoLivreN8nJsonService.run(req.user._id.toString(), 'manual', phase);
      res.status(result.success ? 200 : 422).json(result);
    } catch (e: any) { res.status(500).json({ success: false, errorMessage: e.message }); }
  });

  app.get('/api/mercadolivre/diagnostics', authMiddleware, async (req: any, res) => {
    try {
      const userId = req.user._id;
      const [lastRuns, lastErrors, config] = await Promise.all([
        MercadoLivreRunHistory.find({ userId }).sort({ startedAt: -1 }).limit(5).lean(),
        MercadoLivreRunHistory.find({ userId, status: { $in: ['error', 'partial'] } }).sort({ startedAt: -1 }).limit(5).lean(),
        mercadoLivreN8nJsonService.getSafeConfig(String(userId))
      ]);
      res.json({
        success: true,
        environment: process.env.NODE_ENV || 'development',
        mercadoLivre: mercadoLivreN8nJsonService.getDiagnostics(),
        config,
        legacyDetected: {
          rawN8nSchedulerStarted: false,
          rawN8nRoutesActive: false,
          oauthAppCredentialsRequired: false
        },
        lastRuns,
        lastErrors
      });
    } catch (e: any) { res.status(500).json({ success: false, errorMessage: e.message }); }
  });

  // ─── RETROCOMPATIBILIDADE (raw-n8n legado) ─────────────────────────────────
  // Legacy raw-n8n endpoints kept only as explicit tombstones.
  app.post('/api/mercadolivre/debug/compare-json-flow', authMiddleware, async (req: any, res) => {
    try {
      const result = await mercadoLivreN8nJsonService.compareJsonFlow(String(req.user._id));
      res.json({ success: true, ...result });
    } catch (e: any) {
      res.status(500).json({ success: false, errorType: 'compare_json_flow_failed', errorMessage: e.message });
    }
  });

  const mercadoLivreLegacyDisabled = (_req: any, res: any) => res.status(410).json({ success: false, errorType: 'legacy_disabled', errorMessage: 'Fluxo Mercado Livre legado desativado. Use /api/mercadolivre/config, /api/mercadolivre/test e /api/mercadolivre/run.' });
  app.get('/api/mercadolivre/raw-n8n/categories', authMiddleware, mercadoLivreLegacyDisabled);
  app.post('/api/mercadolivre/raw-n8n/categories', authMiddleware, mercadoLivreLegacyDisabled);
  app.delete('/api/mercadolivre/raw-n8n/categories/:id', authMiddleware, mercadoLivreLegacyDisabled);
  app.get('/api/mercadolivre/raw-n8n/products', authMiddleware, mercadoLivreLegacyDisabled);
  app.get('/api/mercadolivre/raw-n8n/config', authMiddleware, mercadoLivreLegacyDisabled);
  app.put('/api/mercadolivre/raw-n8n/config', authMiddleware, mercadoLivreLegacyDisabled);

  app.post('/api/mercadolivre/affiliate-test', authMiddleware, async (req: any, res) => {
    try {
      const result = await mercadoLivreN8nJsonService.run(req.user._id.toString(), 'test', 'affiliate');
      res.status(result.success ? 200 : 422).json(result);
    } catch (e: any) {
      res.status(500).json({ success: false, errorType: 'affiliate_test_failed', errorMessage: e.message });
    }
  });

  app.post('/api/mercadolivre/search-test', authMiddleware, async (req: any, res) => {
    // DEPRECATED: ML search is now handled by the new mercadoLivreScheduler (/api/ml/*)
    return res.json({ success: false, errorType: 'deprecated', errorMessage: 'Este endpoint foi descontinuado. Use /api/ml/run/search para iniciar uma busca manual.' });
  });

  app.post('/api/mercadolivre/search-test__legacy', authMiddleware, async (_req: any, res) => {
    // This legacy route is fully disabled - functions were removed.
    return res.json({ success: false, errorType: 'deprecated', errorMessage: 'Legacy search-test desativado. Use /api/ml/run/search.' });
  });

  app.get('/api/niches', authMiddleware, async (req: any, res) => {
    try {
      const niches = await getActiveNiches();
      res.json(niches);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  /** POST /api/admin/niches — Criar nicho (admin) */
  app.post('/api/admin/niches', authMiddleware, async (req: any, res) => {
    try {
      if (req.user.role !== 'admin') return res.status(403).json({ error: 'Acesso negado' });
      const { name, slug, description, keywords, blockedKeywords } = req.body;
      if (!name || !slug) return res.status(400).json({ error: 'name e slug são obrigatórios' });
      const niche = await Niche.create({ name, slug, description, keywords: keywords || [], blockedKeywords: blockedKeywords || [], isActive: true });
      res.status(201).json(niche);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  /** PUT /api/admin/niches/:id — Editar nicho (admin) */
  app.put('/api/admin/niches/:id', authMiddleware, async (req: any, res) => {
    try {
      if (req.user.role !== 'admin') return res.status(403).json({ error: 'Acesso negado' });
      const niche = await Niche.findByIdAndUpdate(req.params.id, { ...req.body, updatedAt: new Date() }, { new: true });
      if (!niche) return res.status(404).json({ error: 'Nicho não encontrado' });
      res.json(niche);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  /** DELETE /api/admin/niches/:id — Desativar nicho (admin) */
  app.delete('/api/admin/niches/:id', authMiddleware, async (req: any, res) => {
    try {
      if (req.user.role !== 'admin') return res.status(403).json({ error: 'Acesso negado' });
      await Niche.findByIdAndUpdate(req.params.id, { isActive: false, updatedAt: new Date() });
      res.json({ success: true });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // ─── GRUPOS DO USUÁRIO ────────────────────────────────────────────────────────

  /** GET /api/groups — Lista grupos do usuário */
  app.get('/api/groups', authMiddleware, async (req: any, res) => {
    try {
      const userId = req.user._id;
      const groups = await UserGroup.find({ userId }).populate('nicheId', 'name slug').sort({ createdAt: -1 }).lean();
      res.json(groups);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/copy-promo/config', authMiddleware, async (req: any, res) => {
    try {
      const userId = String(req.user._id);
      res.json(await copyPromoService.listConfigs(userId));
    } catch (e: any) {
      res.status(500).json({ error: e.message || 'Erro ao carregar Copiar Promo.' });
    }
  });

  app.get('/api/copy-promo/configs', authMiddleware, async (req: any, res) => {
    try {
      const userId = String(req.user._id);
      res.json(await copyPromoService.listConfigs(userId));
    } catch (e: any) {
      res.status(500).json({ error: e.message || 'Erro ao carregar Copiar Promo.' });
    }
  });

  app.post('/api/copy-promo/config', authMiddleware, async (req: any, res) => {
    try {
      const userId = String(req.user._id);
      res.json(await copyPromoService.saveConfig(userId, req.body || {}));
    } catch (e: any) {
      res.status(500).json({ error: e.message || 'Erro ao salvar Copiar Promo.' });
    }
  });

  app.put('/api/copy-promo/config/:id', authMiddleware, async (req: any, res) => {
    try {
      const userId = String(req.user._id);
      res.json(await copyPromoService.saveConfig(userId, req.body || {}, String(req.params.id || '')));
    } catch (e: any) {
      res.status(500).json({ error: e.message || 'Erro ao salvar Copiar Promo.' });
    }
  });

  app.delete('/api/copy-promo/config/:id', authMiddleware, async (req: any, res) => {
    try {
      const userId = String(req.user._id);
      res.json(await copyPromoService.deleteConfig(userId, String(req.params.id || '')));
    } catch (e: any) {
      res.status(500).json({ error: e.message || 'Erro ao remover Copiar Promo.' });
    }
  });

  app.post('/api/copy-promo/rotate-webhook', authMiddleware, async (req: any, res) => {
    try {
      const userId = String(req.user._id);
      const configId = String(req.body?.configId || req.query?.configId || '');
      if (!configId) return res.status(400).json({ error: 'configId obrigatorio.' });
      res.json(await copyPromoService.rotateWebhook(userId, configId));
    } catch (e: any) {
      res.status(500).json({ error: e.message || 'Erro ao renovar webhook.' });
    }
  });

  app.get('/api/copy-promo/logs', authMiddleware, async (req: any, res) => {
    try {
      const userId = String(req.user._id);
      res.json(await copyPromoService.getLogs(userId, Number(req.query.limit || 20)));
    } catch (e: any) {
      res.status(500).json({ error: e.message || 'Erro ao carregar historico.' });
    }
  });

  app.post('/api/copy-promo/test', authMiddleware, async (req: any, res) => {
    try {
      const userId = String(req.user._id);
      const cfg = await copyPromoService.getConfig(userId, String(req.body?.configId || ''));
      const token = String((cfg as any).webhookToken || '');
      res.json(await copyPromoService.handleWebhook(token, {
        ...req.body,
        sourceGroupId: req.body?.sourceGroupId || (cfg as any).sourceGroupId,
        sourceGroupName: req.body?.sourceGroupName || (cfg as any).sourceGroupName
      }));
    } catch (e: any) {
      res.status(500).json({ error: e.message || 'Erro no teste Copiar Promo.' });
    }
  });

  app.post('/api/copy-promo/webhook/:token', async (req: any, res) => {
    try {
      res.json(await copyPromoService.handleWebhook(String(req.params.token || ''), req.body || {}));
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message || 'Erro no webhook Copiar Promo.' });
    }
  });

  /** POST /api/groups — Criar grupo/partição */
  app.post('/api/groups', authMiddleware, async (req: any, res) => {
    try {
      const userId = req.user._id;
      const { groupName, groupIdentifier, groupIdentifiers, nicheId, customMessageTemplate, maxPostsPerHour, maxPostsPerDay, delayBetweenPostsSeconds } = req.body;
      if (!groupName) return res.status(400).json({ error: 'Nome da partição é obrigatório' });
      
      const finalIdentifiers = groupIdentifiers || (groupIdentifier ? [groupIdentifier] : []);
      if (finalIdentifiers.length === 0) return res.status(400).json({ error: 'Selecione ao menos um destino' });
      const previewConfig = sanitizeUserGroupCreatePayload(req.body || {});

      const group = await UserGroup.create({
        userId,
        groupName,
        groupIdentifiers: finalIdentifiers,
        nicheId,
        customMessageTemplate,
        maxPostsPerHour: maxPostsPerHour || 10,
        maxPostsPerDay: maxPostsPerDay || 60,
        delayBetweenPostsSeconds: delayBetweenPostsSeconds || 30,
        isActive: true,
        ...previewConfig
      });
      res.status(201).json(group);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  /** PUT /api/groups/:id — Editar grupo */
  app.put('/api/groups/:id', authMiddleware, async (req: any, res) => {
    try {
      const userId = req.user._id;
      const previewConfig = sanitizeUserGroupUpdatePayload(req.body || {});
      const group = await UserGroup.findOneAndUpdate(
        { _id: req.params.id, userId },
        { ...req.body, ...previewConfig, updatedAt: new Date() },
        { new: true }
      );
      if (!group) return res.status(404).json({ error: 'Grupo não encontrado' });
      res.json(group);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  /** DELETE /api/groups/:id — Remover grupo */
  app.delete('/api/groups/:id', authMiddleware, async (req: any, res) => {
    try {
      const userId = req.user._id;
      const deleted = await UserGroup.findOneAndDelete({ _id: req.params.id, userId });
      if (!deleted) return res.status(404).json({ error: 'Grupo não encontrado' });
      // Desativar configs vinculadas
      await AutoSearchConfig.updateMany({ userId, groupId: req.params.id }, { isActive: false });
      res.json({ success: true });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // ─── AUTO-SEARCH CONFIGS ──────────────────────────────────────────────────────

  /** GET /api/auto-search-configs — Lista configs do usuário */
  app.get('/api/auto-search-configs', authMiddleware, async (req: any, res) => {
    try {
      const userId = req.user._id;
      const configs = await AutoSearchConfig.find({ userId })
        .populate('groupId', 'groupName groupIdentifier groupIdentifiers isActive useNativeLinkPreview preserveSourceImageInNativePreview')
        .populate('nicheId', 'name slug')
        .sort({ createdAt: -1 }).lean();
      res.json(configs);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  /** POST /api/auto-search-configs — Criar config */
  app.post('/api/auto-search-configs', authMiddleware, async (req: any, res) => {
    try {
      const userId = req.user._id;
      const body = req.body;
      if (!body.groupId || !body.nicheId) return res.status(400).json({ error: 'groupId e nicheId são obrigatórios' });
      // Garantir que o grupo pertence ao usuário
      const group = await UserGroup.findOne({ _id: body.groupId, userId });
      if (!group) return res.status(404).json({ error: 'Grupo não encontrado' });
      // Intervalo mínimo de 5 minutos
      if (body.searchIntervalMinutes && body.searchIntervalMinutes < 5) body.searchIntervalMinutes = 5;
      const config = await AutoSearchConfig.create({ ...body, userId });
      res.status(201).json(config);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  /** PUT /api/auto-search-configs/:id — Editar config */
  app.put('/api/auto-search-configs/:id', authMiddleware, async (req: any, res) => {
    try {
      const userId = req.user._id;
      const body = { ...req.body, updatedAt: new Date() };
      if (body.searchIntervalMinutes && body.searchIntervalMinutes < 5) body.searchIntervalMinutes = 5;
      const config = await AutoSearchConfig.findOneAndUpdate(
        { _id: req.params.id, userId },
        body,
        { new: true }
      );
      if (!config) return res.status(404).json({ error: 'Configuração não encontrada' });
      res.json(config);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  /** DELETE /api/auto-search-configs/:id — Remover config */
  app.delete('/api/auto-search-configs/:id', authMiddleware, async (req: any, res) => {
    try {
      const userId = req.user._id;
      const deleted = await AutoSearchConfig.findOneAndDelete({ _id: req.params.id, userId });
      if (!deleted) return res.status(404).json({ error: 'Configuração não encontrada' });
      res.json({ success: true });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // ─── REGRAS DE BUSCA ─────────────────────────────────────────────────────────

  /** GET /api/deal-rules — Listar regras do usuário */
  app.get('/api/deal-rules', authMiddleware, async (req: any, res) => {
    try {
      const userId = req.user._id;
      const rules = await UserDealRule.find({ userId }).populate('nicheId', 'name slug').populate('groupId', 'groupName').sort({ createdAt: -1 }).lean();
      res.json(rules);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  /** POST /api/deal-rules — Criar regra */
  app.post('/api/deal-rules', authMiddleware, async (req: any, res) => {
    try {
      const userId = req.user._id;
      const { keyword, nicheId, groupId, maxPrice, minPrice, minSales, minRating, minCommissionRate, onlyWithCoupon, maxPostsPerRun } = req.body;
      if (!keyword) return res.status(400).json({ error: 'keyword é obrigatória' });
      const rule = await UserDealRule.create({ userId, keyword, nicheId, groupId, maxPrice, minPrice, minSales, minRating, minCommissionRate, onlyWithCoupon, maxPostsPerRun: maxPostsPerRun || 3, isActive: true });
      res.status(201).json(rule);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  /** PUT /api/deal-rules/:id — Editar regra */
  app.put('/api/deal-rules/:id', authMiddleware, async (req: any, res) => {
    try {
      const userId = req.user._id;
      const rule = await UserDealRule.findOneAndUpdate(
        { _id: req.params.id, userId },
        { ...req.body, updatedAt: new Date() },
        { new: true }
      );
      if (!rule) return res.status(404).json({ error: 'Regra não encontrada' });
      res.json(rule);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  /** DELETE /api/deal-rules/:id — Remover regra */
  app.delete('/api/deal-rules/:id', authMiddleware, async (req: any, res) => {
    try {
      const userId = req.user._id;
      const deleted = await UserDealRule.findOneAndDelete({ _id: req.params.id, userId });
      if (!deleted) return res.status(404).json({ error: 'Regra não encontrada' });
      res.json({ success: true });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // ─── DISPARO MANUAL + HISTÓRICO ──────────────────────────────────────────────

  /** POST /api/deals/run-now — Disparo manual síncrono com diagnóstico completo */
  app.post('/api/deals/run-now', authMiddleware, async (req: any, res) => {
    try {
      const userId = req.user._id;
      const { configId } = req.body;
      if (!configId) return res.status(400).json({ error: 'configId é obrigatório' });

      // IMPORTANTE: buscar SEM populate para que groupId/nicheId sejam ObjectIds puros
      // O processConfig usa esses IDs diretamente em queries do Mongoose (SendLog, PostedDeal etc.)
      const config = await AutoSearchConfig.findOne({ _id: configId, userId }).lean() as any;
      if (!config) return res.status(404).json({ error: 'Configuração não encontrada' });

      // Executa o processamento de forma síncrona e retorna o diagnóstico
      const queuedAt = new Date();

      // Busca populated só para enriquecer a resposta JSON (nomes legíveis)
      const configPopulated = await AutoSearchConfig.findById(configId)
        .populate('nicheId', 'name slug')
        .populate('groupId', 'groupName')
        .lean() as any;

      await AutoSearchConfig.updateOne(
        { _id: configId, userId },
        {
          $set: {
            lastStatus: 'running',
            lastRunAt: queuedAt,
            lastError: '',
            lastRunDetails: {
              status: 'running',
              startedAt: queuedAt.toISOString(),
              providerMode: config.providerMode || 'single',
              providersEnabled: config.providersEnabled || [],
              primaryProvider: config.primaryProvider || 'shopee',
              keywordsUsed: [],
              sent: 0,
              warnings: ['Execucao manual iniciada em background para evitar timeout do navegador.']
            },
            updatedAt: queuedAt
          }
        }
      );

      setImmediate(() => {
        autoSearchScheduler.processConfig(config, { force: true }).catch((error: any) => {
          console.error('[AutoSearch] Erro no run-now background:', error?.message || error);
          AutoSearchConfig.updateOne(
            { _id: configId, userId },
            {
              $set: {
                lastStatus: 'failed',
                lastError: error?.message || String(error),
                lastRunDetails: {
                  status: 'failed',
                  startedAt: new Date().toISOString(),
                  finishedAt: new Date().toISOString(),
                  errorType: 'background_run_failed',
                  errorMessage: error?.message || String(error),
                  sent: 0,
                  warnings: []
                },
                updatedAt: new Date()
              }
            }
          ).catch((dbError: any) => console.error('[AutoSearch] Falha ao salvar erro background:', dbError?.message || dbError));
        });
      });

      res.status(202).json({
        success: true,
        queued: true,
        status: 'running',
        message: 'Busca iniciada em background. O diagnostico sera atualizado em instantes.',
        niche: configPopulated?.nicheId,
        group: configPopulated?.groupId
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  /** GET /api/auto-search-configs/:id/last-run — Último diagnóstico de uma config */
  app.get('/api/auto-search-configs/:id/last-run', authMiddleware, async (req: any, res) => {
    try {
      const userId = req.user._id;
      const config = await AutoSearchConfig.findOne({ _id: req.params.id, userId })
        .populate('nicheId', 'name slug')
        .populate('groupId', 'groupName')
        .lean() as any;
      if (!config) return res.status(404).json({ error: 'Configuração não encontrada' });
      res.json({
        lastRunDetails: config.lastRunDetails || null,
        lastRunAt: config.lastRunAt,
        lastStatus: config.lastStatus,
        nicheId: config.nicheId,
        groupId: config.groupId
      });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  /** GET /api/send-logs — Histórico de envios do usuário */
  app.get('/api/send-logs', authMiddleware, async (req: any, res) => {
    try {
      const userId = req.user._id;
      const limit = Math.min(parseInt(String(req.query.limit || '50')), 200);
      const [sentDeals, diagnosticLogs] = await Promise.all([
        PostedDeal.find({ userId, status: 'sent' })
          .populate('groupId', 'groupName')
          .populate('nicheId', 'name slug')
          .sort({ sentAt: -1 })
          .limit(limit)
          .lean(),
        SendLog.find({ userId })
          .populate('groupId', 'groupName')
          .populate('nicheId', 'name slug')
          .sort({ createdAt: -1 })
          .limit(limit)
          .lean()
      ]);
      const logs = [
        ...sentDeals.map((deal: any) => ({
          ...deal,
          _id: `posted:${deal._id}`,
          status: 'sent',
          createdAt: deal.sentAt || deal.updatedAt || deal.createdAt || new Date()
        })),
        ...diagnosticLogs
      ]
        .sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, limit);
      res.json(logs);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });


  // --- AUTH ROUTES ---

  app.post("/api/auth/register", async (req, res) => {
    const { name, email, password } = req.body;
    console.log(`[Auth] Tentativa de registro para: ${email}`);
    if (!name || !email || !password) return res.status(400).json({ error: "Campos obrigatórios" });

    try {
      console.log(`[Auth] Verificando se usuário já existe...`);
      const existingUser = await User.findOne({ email });
      if (existingUser) return res.status(400).json({ error: "Email já cadastrado" });

      console.log(`[Auth] Criando hash da senha...`);
      const passwordHash = await bcrypt.hash(password, 10);
      const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
      const verificationCodeSentAt = new Date();
      const verificationCodeExpiresAt = new Date(Date.now() + 10 * 60 * 1000);

      console.log(`[Auth] Salvando usuário no banco...`);
      const user = await User.create({
        name,
        email,
        passwordHash,
        verificationCode,
        verificationCodeSentAt,
        verificationCodeExpiresAt,
        verificationAttempts: 0,
        isEmailVerified: false
      });
      await ensureEntitlement(user._id);
      console.log(`[Auth] Usuário criado com ID: ${user._id}`);

      // Send verification email
      if (!resend) {
        throw new Error('Configuração de e-mail (Resend) não encontrada. Verifique a RESEND_API_KEY.');
      }

      const { data: emailData, error: emailError } = await resend.emails.send({
        from: RESEND_FROM,
        to: email,
        subject: 'Confirme seu e-mail - Longevità',
        html: `
        <div style="font-family: sans-serif; padding: 20px; background-color: #070014; color: #fff;">
          <h1 style="color: #c084fc;">Código de Verificação: ${verificationCode}</h1>
          <p>Digite este código no site para confirmar seu e-mail.</p>
          <p>O código expira em 10 minutos.</p>
        </div>
        `
      });

      if (emailError) {
        console.error("[Resend] Registro - Erro na entrega:", emailError);
        if (emailError.name === 'validation_error' && emailError.message.includes('verify a domain')) {
          throw new Error("Erro de Configuração: Você precisa verificar seu domínio no portal do Resend.");
        }
        throw new Error(`Erro ao enviar e-mail: ${emailError.message}`);
      }
      console.log("[Resend] Registro - E-mail aceito pela API:", emailData);

      console.log(`[Auth] Criando sessão para o usuário ${user._id}...`);
      const token = await createSession(user._id);
      console.log(`[Auth] Sessão criada com sucesso. Gerando cookie...`);

      res.cookie('longevita_session', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        signed: true,
        maxAge: 30 * 24 * 60 * 60 * 1000
      });

      console.log(`[Auth] Cookie gerado. Calculando acesso...`);
      const hasAccess = await computeHasAccess(user._id);
      console.log(`[Auth] Acesso calculado: ${hasAccess}. Retornando JSON.`);

      res.json({
        user: {
          id: user._id,
          name,
          email,
          role: user.role,
          isSubscribed: hasAccess,
          isEmailVerified: user.isEmailVerified,
          onboardingCompleted: user.onboardingCompleted,
          learningTrack: user.learningTrack,
          subTrack: user.subTrack
        }
      });
    } catch (e: any) {
      console.error("[Auth] Erro catastrófico no registro:", e);
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/auth/login", async (req, res) => {
    try {
      const { email, password } = req.body;
      const user = await User.findOne({ email });

      if (!user || !user.passwordHash) return res.status(400).json({ error: "Credenciais inválidas" });

      const valid = await bcrypt.compare(password, user.passwordHash);
      if (!valid) return res.status(400).json({ error: "Credenciais inválidas" });

      await ensureEntitlement(user._id);

      const token = await createSession(user._id);
      res.cookie('longevita_session', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        signed: true,
        maxAge: 30 * 24 * 60 * 60 * 1000
      });

      res.json({
        user: {
          id: user._id,
          name: user.name,
          email: user.email,
          role: user.role,
          isSubscribed: (await computeHasAccess(user._id)),
          isEmailVerified: user.isEmailVerified,
          onboardingCompleted: user.onboardingCompleted,
          learningTrack: user.learningTrack,
          subTrack: user.subTrack
        }
      });
    } catch (e: any) {
      console.error("[Auth] Erro no login:", e);
      res.status(500).json({ error: e.message || "Erro interno no servidor de login" });
    }
  });

  app.post("/api/auth/google", async (req, res) => {
    try {
      const { name, email, avatar, googleId } = req.body;
      if (!email || !googleId) {
        return res.status(400).json({ error: 'Dados do Google inválidos. Tente novamente.' });
      }
      let user = await User.findOne({ email });

      if (!user) {
        user = await User.create({
          name,
          email,
          avatar,
          googleId,
          provider: 'google',
          isSubscribed: false,
          isEmailVerified: true // Google accounts are usually verified
        });
        await ensureEntitlement(user._id);
      } else {
        user.googleId = googleId;
        user.provider = 'google';
        user.isEmailVerified = true;
        await user.save();
      }

      await ensureEntitlement(user._id);

      const token = await createSession(user._id);
      res.cookie('longevita_session', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        signed: true,
        maxAge: 30 * 24 * 60 * 60 * 1000
      });

      res.json({
        user: {
          id: user._id,
          name: user.name,
          email: user.email,
          role: user.role,
          isSubscribed: (await computeHasAccess(user._id)),
          avatar: user.avatar,
          isEmailVerified: user.isEmailVerified,
          onboardingCompleted: user.onboardingCompleted,
          learningTrack: user.learningTrack,
          subTrack: user.subTrack
        }
      });
    } catch (e: any) {
      console.error("Google Auth Error:", e);
      res.status(500).json({ error: 'Erro interno no login Google', details: e?.message || String(e) });
    }
  });

  app.post("/api/auth/verify-email", async (req: any, res) => {
    const { code, email: bodyEmail } = req.body || {};

    // Attempt to get email from body or from current session user
    let email = bodyEmail;
    const token = req.signedCookies.longevita_session || req.cookies.longevita_session;
    if (!email && token) {
      const session = await Session.findOne({ token, expiresAt: { $gt: new Date() } });
      if (session) {
        const user = await User.findById(session.userId);
        if (user) email = user.email;
      }
    }

    if (!email) return res.status(400).json({ error: 'E-mail obrigatório para verificação' });

    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ error: 'Usuário não encontrado' });
    const now = new Date();

    if (user.isEmailVerified) return res.json({ success: true });

    const expiresAt = user.verificationCodeExpiresAt ? new Date(user.verificationCodeExpiresAt) : null;
    if (!user.verificationCode || !expiresAt) {
      return res.status(400).json({ error: 'Código não encontrado. Solicite um novo código.' });
    }
    if (expiresAt.getTime() < now.getTime()) {
      return res.status(400).json({ error: 'Código expirado. Solicite um novo.' });
    }
    if ((user.verificationAttempts || 0) >= 5) {
      return res.status(400).json({ error: 'Muitas tentativas malsucedidas. Solicite um novo código.' });
    }

    user.verificationAttempts = (user.verificationAttempts || 0) + 1;

    if (String(user.verificationCode).trim() === String(code).trim()) {
      user.isEmailVerified = true;
      user.verificationCode = undefined;
      user.verificationCodeExpiresAt = undefined;
      user.verificationCodeSentAt = undefined;
      user.verificationAttempts = 0;
      console.log(`[Auth] Código verificado com sucesso para ${email}. Salvando...`);
      await user.save();
      console.log(`[Auth] Usuário ${email} marcado como verificado. Retornando.`);
      return res.json({ success: true });
    }

    await user.save();
    return res.status(400).json({ error: 'Código inválido' });
  });

  // Reenvio do OTP com cooldown (60s)
  app.post('/api/auth/resend-code', async (req: any, res) => {
    const { email: bodyEmail } = req.body || {};
    let user = null;

    // Try finding user via session first
    const token = req.signedCookies.longevita_session || req.cookies.longevita_session;
    if (token) {
      const session = await Session.findOne({ token, expiresAt: { $gt: new Date() } });
      if (session) {
        user = await User.findById(session.userId);
      }
    }

    // Fallback to email from body if session didn't work
    if (!user && bodyEmail) {
      user = await User.findOne({ email: bodyEmail });
    }

    if (!user) return res.status(401).json({ error: "Sessão expirada ou usuário não encontrado. Faça login novamente." });
    if (user.isEmailVerified) return res.json({ success: true, message: 'E-mail já verificado' });

    const now = Date.now();
    const sentAt = user.verificationCodeSentAt ? new Date(user.verificationCodeSentAt).getTime() : 0;
    const cooldownMs = 60 * 1000;
    const remaining = Math.max(0, cooldownMs - (now - sentAt));
    if (remaining > 0) {
      return res.status(429).json({ error: 'Aguarde para reenviar', retryAfterMs: remaining });
    }

    const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
    user.verificationCode = verificationCode;
    user.verificationCodeSentAt = new Date(now);
    user.verificationCodeExpiresAt = new Date(now + 15 * 60 * 1000); // 15 min expiration
    user.verificationAttempts = 0;
    await user.save();

    if (!resend) {
      throw new Error('Configuração de e-mail (Resend) não encontrada. Verifique a RESEND_API_KEY.');
    }

    const { data: emailData, error: emailError } = await resend.emails.send({
      from: RESEND_FROM,
      to: user.email,
      subject: 'Seu código de verificação - Longevità',
      html: `
        <div style="font-family: sans-serif; padding: 20px; background-color: #070014; color: #fff;">
          <h1 style="color: #c084fc;">Código de Verificação: ${verificationCode}</h1>
          <p>Digite este código no site para confirmar seu e-mail.</p>
          <p>O código expira em 15 minutos.</p>
        </div>
      `
    });

    if (emailError) {
      console.error("[Resend] Reenvio - Erro na entrega:", emailError);
      if (emailError.name === 'validation_error' && emailError.message.includes('verify a domain')) {
        throw new Error("Erro de Configuração: Você precisa verificar seu domínio no portal do Resend.");
      }
      throw new Error(`Erro ao enviar e-mail: ${emailError.message}`);
    }
    console.log("[Resend] Reenvio - E-mail aceito pela API:", emailData);
    console.log(`[Auth] Reenvio de código concluído para ${user.email}. Retornando.`);

    return res.json({ success: true });
  });

  app.get("/api/auth/me", async (req, res) => {
    const token = req.signedCookies.longevita_session || req.cookies.longevita_session;
    if (!token) return res.status(401).json({ error: "Não autorizado" });

    const session = await Session.findOne({ token, expiresAt: { $gt: new Date() } });
    if (!session) return res.status(401).json({ error: "Sessão inválida" });

    const user = await User.findById(session.userId);
    if (!user) return res.status(401).json({ error: "Usuário não encontrado" });

    await ensureEntitlement(user._id);

    const profile = await UserProfile.findOne({ userId: user._id }).lean();
    res.json({
      id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      isSubscribed: (await computeHasAccess(user._id)),
      avatar: user.avatar,
      isEmailVerified: user.isEmailVerified,
      onboardingCompleted: user.onboardingCompleted,
      learningTrack: user.learningTrack,
      subTrack: user.subTrack,
      backgroundPreferences: normalizeBackgroundPreferences(profile?.preferences || {})
    });
  });

  app.post("/api/auth/logout", async (req, res) => {
    const token = req.signedCookies.longevita_session || req.cookies.longevita_session;
    if (token) {
      await Session.deleteOne({ token });
    }
    res.clearCookie('longevita_session');
    res.json({ success: true });
  });

  app.post("/api/auth/change-password", authMiddleware, async (req: any, res) => {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) return res.status(400).json({ error: "Campos obrigatórios" });

    const user = req.user;
    if (!user.passwordHash) return res.status(400).json({ error: "Conta sem senha (Google). Crie uma senha por e-mail." });

    const ok = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!ok) return res.status(400).json({ error: "Senha atual incorreta" });

    user.passwordHash = await bcrypt.hash(String(newPassword), 10);
    await user.save();
    res.json({ success: true });
  });

  app.get("/api/user/preferences", authMiddleware, async (req: any, res) => {
    const profile = await UserProfile.findOne({ userId: req.user._id }).lean();
    res.json({
      preferences: {
        ...(profile?.preferences || {}),
        ...normalizeBackgroundPreferences(profile?.preferences || {})
      }
    });
  });

  app.post("/api/user/preferences", authMiddleware, async (req: any, res) => {
    const current = await UserProfile.findOne({ userId: req.user._id }).lean();
    const nextBackground = normalizeBackgroundPreferences(req.body || {});
    const nextPreferences = {
      notifications: current?.preferences?.notifications ?? true,
      theme: current?.preferences?.theme || 'dark',
      ...current?.preferences,
      ...nextBackground
    };
    const profile = await UserProfile.findOneAndUpdate(
      { userId: req.user._id },
      {
        $set: {
          preferences: nextPreferences,
          updatedAt: new Date()
        }
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    ).lean();
    res.json({
      success: true,
      preferences: {
        ...(profile?.preferences || {}),
        ...normalizeBackgroundPreferences(profile?.preferences || {})
      }
    });
  });

  // --- WHATSAPP SCHEDULER ROUTES (SECURED) ---
  app.get("/api/whatsapp/bulk/active", authMiddleware, async (req: any, res) => {
    try {
      const userId = req.user._id.toString();
      const jobs = await WhatsAppBulkJobM.find({
        userId,
        status: { $in: ['running', 'pending', 'paused'] }
      }).sort({ createdAt: -1 });
      res.json(jobs);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/whatsapp/bulk/schedule", authMiddleware, async (req: any, res) => {
    try {
      const { groupId, groupIds, links, subIds, intervalMinutes } = req.body;
      const userId = req.user._id.toString();

      if ((!groupId && !groupIds) || !links || links.length === 0) {
        return res.status(400).json({ error: "Target group(s) and links are required" });
      }

      const jobId = await robustSchedulerService.createJob({
        userId,
        groupId,
        groupIds,
        links,
        subIds,
        intervalMinutes: intervalMinutes || 15,
        startImmediately: true, // Legacy schedule behavior starts immediately
        settings: req.body.settings || { sendImages: true }
      });

      res.json({ success: true, jobId });

    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/whatsapp/bulk/cancel/:id", authMiddleware, async (req: any, res) => {
    try {
      const userId = req.user._id.toString();
      const job = await WhatsAppBulkJobM.findOneAndUpdate(
        { _id: req.params.id, userId },
        { status: 'canceled' },
        { new: true }
      );
      if (!job) return res.status(404).json({ error: "Job not found or unauthorized" });
      res.json({ success: true, job });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });



  // --- ADMIN NUMBER OVERRIDES ---
  app.get('/api/admin/overrides', authMiddleware, async (req: any, res) => {
    try {
      if (req.user.role !== 'admin') return res.status(403).json({ error: 'Acesso negado' });
      const doc = await AdminOverrideM.findOne({ userId: req.user._id });
      if (!doc || !doc.overrides) {
        return res.json({});
      }

      const result: Record<string, number> = {};
      if (typeof doc.overrides.forEach === 'function') {
        doc.overrides.forEach((val: any, key: string) => {
          if (val !== null && val !== undefined) result[key] = Number(val);
        });
      } else {
        for (const [key, val] of Object.entries(doc.overrides)) {
          if (val !== null && val !== undefined) result[key] = Number(val);
        }
      }
      res.json(result);
    } catch (e: any) {
      console.error("[AdminOverride] GET Error:", e);
      res.status(500).json({ error: e?.message || 'Erro interno' });
    }
  });

  app.patch('/api/admin/number', authMiddleware, async (req: any, res) => {
    try {
      if (req.user.role !== 'admin') return res.status(403).json({ error: 'Acesso negado' });
      const { path, value } = req.body || {};
      if (!path || value === undefined) return res.status(400).json({ error: 'path e value são obrigatórios' });
      const numValue = Number(value);
      if (isNaN(numValue)) return res.status(400).json({ error: 'value deve ser numérico' });

      let doc = await AdminOverrideM.findOne({ userId: req.user._id });
      if (!doc) {
        doc = await AdminOverrideM.create({ userId: req.user._id, overrides: {} });
      }

      if (typeof doc.overrides.set === 'function') {
        doc.overrides.set(path, numValue);
      } else {
        doc.overrides[path] = numValue;
      }

      await doc.save();
      res.json({ success: true, path, value: numValue });
    } catch (e: any) {
      console.error("[AdminOverride] PATCH Error:", e);
      res.status(500).json({ error: e?.message || 'Erro interno' });
    }
  });

  // --- PASSWORD RESET (Forgot Password) ---

  // Fluxo: solicitar código por e-mail -> resetar senha com código (6 dígitos)
  app.post("/api/auth/request-password-reset", async (req, res) => {
    const emailRaw = String((req.body || {}).email || "").toLowerCase().trim();
    if (!emailRaw) return res.status(400).json({ error: "E-mail obrigatório" });

    const user = await User.findOne({ email: emailRaw });
    // Não vazar se o e-mail existe
    if (!user) return res.json({ success: true });

    const now = new Date();
    // Cooldown de 60s
    if (user.passwordResetSentAt && now.getTime() - new Date(user.passwordResetSentAt).getTime() < 60_000) {
      return res.status(429).json({ error: "Aguarde um minuto para reenviar." });
    }

    const code = String(Math.floor(100000 + Math.random() * 900000)); // 6 dígitos
    const codeHash = crypto.createHash("sha256").update(code + (process.env.SESSION_SECRET || "dev_salt")).digest("hex");

    user.passwordResetCode = codeHash;
    user.passwordResetExpiresAt = new Date(now.getTime() + 10 * 60_000); // 10 min
    user.passwordResetSentAt = now;
    user.passwordResetAttempts = 0;
    await user.save();

    if (resend) {
      try {
        await resend.emails.send({
          from: RESEND_FROM,
          to: emailRaw,
          subject: "Seu código de redefinição (Longevità)",
          html: `
            <div style="background-color: #0c0a09; color: #fff; padding: 40px; font-family: sans-serif; text-align: center;">
              <div style="max-width: 400px; margin: 0 auto; background-color: #1c1917; padding: 40px; border-radius: 32px; border: 1px solid #27272a; box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.5);">
                <h1 style="color: #fff; font-size: 22px; font-weight: 800; letter-spacing: -0.025em; margin-bottom: 8px;">Redefinir Senha</h1>
                <p style="color: #a1a1aa; font-size: 13px; margin-bottom: 32px; line-height: 1.5;">Use o código abaixo para criar uma nova senha na sua conta <strong>Longevità</strong>.</p>
                <div style="background-color: #000; color: #fff; font-size: 32px; font-weight: 800; letter-spacing: 0.25em; padding: 24px; border-radius: 20px; margin-bottom: 32px; border: 2px solid #6366f1; text-shadow: 0 0 10px rgba(99, 102, 241, 0.5);">
                  ${code}
                </div>
                <p style="color: #71717a; font-size: 11px; line-height: 1.5;">Este código expira em <strong>10 minutos</strong>. Se você não solicitou esta redefinição, pode ignorar este e-mail com segurança.</p>
              </div>
              <p style="margin-top: 24px; color: #52525b; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em;">
                &copy; 2026 Longevità • SUA CENTRAL DE EXECUÇÃO GUIADA
              </p>
            </div>
          `
        });
      } catch (e) {
        console.error("[RESEND] Falha ao enviar e-mail de reset:", e);
      }
    } else {
      console.warn("[RESEND] RESEND_API_KEY ausente. Código de reset (dev):", code);
    }

    return res.json({ success: true });
  });

  app.post("/api/auth/reset-password", async (req, res) => {
    const { email, code, newPassword } = req.body || {};
    const emailRaw = String(email || "").toLowerCase().trim();
    const codeRaw = String(code || "").trim();
    const newPass = String(newPassword || "");

    if (!emailRaw || !codeRaw || !newPass) return res.status(400).json({ error: "Campos obrigatórios" });
    if (newPass.length < 6) return res.status(400).json({ error: "A nova senha deve ter pelo menos 6 caracteres" });

    const user = await User.findOne({ email: emailRaw });
    if (!user) return res.status(400).json({ error: "Código inválido" });

    if (!user.passwordResetCode || !user.passwordResetExpiresAt) return res.status(400).json({ error: "Código inválido" });

    const now = new Date();
    if (now > new Date(user.passwordResetExpiresAt)) return res.status(400).json({ error: "Código expirado" });

    user.passwordResetAttempts = (user.passwordResetAttempts || 0) + 1;
    if (user.passwordResetAttempts > 5) {
      await user.save();
      return res.status(429).json({ error: "Muitas tentativas. Solicite um novo código." });
    }

    const codeHash = crypto.createHash("sha256").update(codeRaw + (process.env.SESSION_SECRET || "dev_salt")).digest("hex");
    const ok = codeHash === user.passwordResetCode;
    if (!ok) {
      await user.save();
      return res.status(400).json({ error: "Código inválido" });
    }

    user.passwordHash = await bcrypt.hash(newPass, 10);
    user.passwordResetCode = undefined;
    user.passwordResetExpiresAt = undefined;
    user.passwordResetSentAt = undefined;
    user.passwordResetAttempts = 0;
    await user.save();

    return res.json({ success: true });
  });

  // --- ONBOARDING & PLAN ROUTES ---

  app.get("/api/user/plan", authMiddleware, async (req: any, res) => {
    const uid = req.user._id;
    const { learningTrack, subTrack } = req.query;

    let plan = null;
    let template = null;
    let tasks: any[] = [];

    if (learningTrack) {
      // Find action plan tasks for the specific learning track
      const actionPlans = await ActionPlan.find({ trackId: learningTrack, subTrack: subTrack }).sort({ dayNumber: 1 });
      const relatedLessonIds = actionPlans.flatMap(ap => ap.tasks.map(t => t.relatedLessonId)).filter(Boolean);
      const userActionPlanTasks = await UserTask.find({ userId: uid, relatedLessonId: { $in: relatedLessonIds } }).sort({ dayNumber: 1, _id: 1 });

      if (actionPlans.length > 0) {
        plan = { // Construct a virtual plan object from action plans
          _id: `${uid} - ${learningTrack} - ${subTrack}`,
          userId: uid,
          title: `Plano de Ação: ${learningTrack}${subTrack ? ` (${subTrack})` : ''}`,
          description: `Seu plano personalizado para ${learningTrack}${subTrack ? ` (${subTrack})` : ''}.`,
          start_date: req.user.createdAt, // Or actual plan start date
          tasks: userActionPlanTasks,
        };
      }
    } else {
      // Fallback to legacy plan if no learningTrack is specified
      const legacyPlan = await UserPlan.findOne({ userId: uid, status: 'active' }).sort({ createdAt: -1 });
      if (legacyPlan) {
        template = await PlanTemplate.findById(legacyPlan.planTemplateId);
        tasks = await UserTask.find({ userPlanId: legacyPlan._id }).sort({ dayNumber: 1, _id: 1 });
        plan = { ...legacyPlan.toObject(), title: template?.title, description: template?.description, tasks };
      }
    }

    if (!plan) return res.json(null);

    res.json(plan);
  });

  app.post("/api/onboarding", authMiddleware, async (req: any, res: any) => {
    const { metaMensal, tempoDiario, experience, primary_track, selectedTrackGroup, selectedPlatformKey, learningTrackId } = req.body;
    const uid = req.user._id;

    try {
      // Update UserProfile with onboarding data
      await UserProfile.findOneAndUpdate(
        { userId: uid },
        {
          goalBrl: metaMensal,
          timeMinDay: tempoDiario,
          experience,
          primaryTrack: primary_track
        },
        { upsert: true, new: true }
      );

      // Update User with chosen learning track + mark onboarding as completed
      await User.findByIdAndUpdate(uid, {
        learningTrack: learningTrackId,
        selectedTrackGroup,
        selectedPlatformKey,
        onboardingCompleted: true
      });

      // Create a UserPlan (if still using legacy plan templates)
      let userPlan = null;
      const templates = await PlanTemplate.find({ primaryTrack: primary_track });
      let bestTemplate = templates[0];
      if (bestTemplate) {
        let minDiff = Infinity;
        for (const t of templates) {
          const diff = Math.abs(t.goalBrl - (metaMensal || 0)) + Math.abs(t.timeMinDay - (tempoDiario || 0));
          if (diff < minDiff) {
            minDiff = diff;
            bestTemplate = t;
          }
        }
        userPlan = await UserPlan.create({ userId: uid, planTemplateId: bestTemplate._id });

        // Generate UserTasks from PlanDay (legacy)
        const days = await PlanDay.find({ planTemplateId: bestTemplate._id });
        const tasks = [];
        for (const day of days) {
          for (const task of day.tasks) {
            tasks.push({
              userId: uid,
              userPlanId: userPlan._id,
              dayNumber: day.dayNumber,
              taskTitle: task.title,
              taskDetails: task.details
            });
          }
        }
        if (tasks.length > 0) {
          await UserTask.insertMany(tasks);
        }
      }

      // Generate ActionPlan based on learningTrackId
      const actionPlans = await ActionPlan.find({ trackId: learningTrackId }).sort({ dayNumber: 1 });
      const userActionPlanTasks = [];

      for (const plan of actionPlans) {
        for (const task of plan.tasks) {
          userActionPlanTasks.push({
            userId: uid,
            // userPlanId: userPlan?._id, // Link to UserPlan if desired, or keep separate
            dayNumber: plan.dayNumber,
            taskTitle: task.title,
            taskDetails: task.description,
            estimatedTime: task.estimatedTime,
            relatedLessonId: task.relatedLessonId,
            expectedOutcome: task.expectedOutcome,
            status: 'pending' // Default status
          });
        }
      }

      if (userActionPlanTasks.length > 0) {
        await UserTask.insertMany(userActionPlanTasks);
      }

      res.json({ success: true, planId: userPlan?._id, learningTrackId, onboardingCompleted: true });
    } catch (e: any) {
      console.error("Onboarding error:", e);
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/user/plan", authMiddleware, async (req: any, res) => {
    const uid = req.user._id;

    // 1) Prefer plano "legacy" com template (se existir)
    const plan = await UserPlan.findOne({ userId: uid, status: 'active' }).sort({ createdAt: -1 });
    if (plan) {
      const template = await PlanTemplate.findById(plan.planTemplateId);
      const tasks = await UserTask.find({ userPlanId: plan._id }).sort({ dayNumber: 1, _id: 1 });
      return res.json({
        ...plan.toObject(),
        title: template?.title,
        description: template?.description,
        tasks,
      });
    }

    // 2) Fallback: tarefas geradas via ActionPlan (userPlanId null)
    //    Mantém a experiência funcional mesmo sem instância de UserPlan.
    const user = req.user;
    const learningTrack = user.learningTrack || 'microsaas';
    const subTrack = user.subTrack || '';

    const tasks = await UserTask.find({ userId: uid, userPlanId: { $exists: false } }).sort({ dayNumber: 1, _id: 1 });
    if (!tasks.length) {
      // Algumas versões do mongoose persistem userPlanId: null
      const tasksNull = await UserTask.find({ userId: uid, userPlanId: null }).sort({ dayNumber: 1, _id: 1 });
      if (!tasksNull.length) return res.json(null);
      return res.json({
        id: `actionplan:${uid} `,
        title: `Plano de Ação: ${learningTrack}${subTrack ? ` (${subTrack})` : ''} `,
        description: 'Tarefas geradas pelo seu onboarding (MVP).',
        tasks: tasksNull,
      });
    }

    return res.json({
      id: `actionplan:${uid} `,
      title: `Plano de Ação: ${learningTrack}${subTrack ? ` (${subTrack})` : ''} `,
      description: 'Tarefas geradas pelo seu onboarding (MVP).',
      tasks,
    });
  });

  app.post("/api/user/tasks/:taskId/status", authMiddleware, async (req: any, res) => {
    const { taskId } = req.params;
    const { status } = req.body;
    await UserTask.findOneAndUpdate(
      { _id: taskId, userId: req.user._id },
      { status, completedAt: status === 'done' ? new Date() : null }
    );
    res.json({ success: true });
  });

  app.get("/api/user/stats", authMiddleware, async (req: any, res: any) => {
    const user = await UserM.findById(req.user._id).select('xp level streak badges');
    res.status(200).json(user);
  });

  // --- CRM ROUTES ---

  app.get("/api/crm/leads", authMiddleware, async (req: any, res) => {
    const leads = await CRMLead.find({ userId: req.user._id }).sort({ updatedAt: -1 });
    res.json(leads);
  });

  app.post("/api/crm/leads", authMiddleware, async (req: any, res) => {
    const { title, channel, status, notes, id } = req.body;
    const uid = req.user._id;

    if (id) {
      await CRMLead.findOneAndUpdate(
        { _id: id, userId: uid },
        { title, channel, status, notes }
      );
      res.json({ success: true, id });
    } else {
      const lead = await CRMLead.create({ userId: uid, title, channel, status, notes });
      res.json({ success: true, id: lead._id });
    }
  });

  app.delete("/api/crm/leads/:id", authMiddleware, async (req: any, res) => {
    await CRMLead.deleteOne({ _id: req.params.id, userId: req.user._id });
    res.json({ success: true });
  });

  // --- AFFILIATES ---

  app.get("/api/affiliates", authMiddleware, async (req: any, res) => {
    const links = await AffiliateLink.find({ userId: req.user._id }).sort({ createdAt: -1 });
    const linksWithStats = await Promise.all(links.map(async (link: any) => {
      const clicks7d = await AffiliateClick.countDocuments({
        affiliateLinkId: link._id,
        createdAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
      });
      const clicksTotal = await AffiliateClick.countDocuments({ affiliateLinkId: link._id });
      return { ...link.toObject(), clicks7d, clicksTotal };
    }));
    res.json(linksWithStats);
  });

  app.post("/api/affiliates", authMiddleware, async (req: any, res) => {
    const { platform, title, destinationUrl } = req.body;
    const shortCode = Math.random().toString(36).substring(2, 8).toUpperCase();
    try {
      const link = await AffiliateLink.create({ userId: req.user._id, platform, name: title, originalUrl: destinationUrl, shortCode });
      res.json({ id: link._id, shortCode });
    } catch (e) {
      res.status(500).json({ error: "Falha ao criar link" });
    }
  });

  // --- ALERTS ---

  app.get("/api/alerts", authMiddleware, async (req: any, res) => {
    const uid = req.user._id;
    const alerts = [];

    // 1. Inactivity alert
    const lastTask = await UserTask.findOne({ userId: uid, status: 'done' }).sort({ completedAt: -1 });
    if (lastTask && lastTask.completedAt) {
      const diff = (Date.now() - new Date(lastTask.completedAt).getTime()) / (1000 * 60 * 60 * 24);
      if (diff > 2) {
        alerts.push({ type: 'warning', message: "Você está há mais de 2 dias sem completar tarefas. Não perca o ritmo!" });
      }
    }

    // 2. Metrics alert
    const lastMetric = await UserMetric.findOne({ userId: uid }).sort({ date: -1 });
    if (!lastMetric || (Date.now() - new Date(lastMetric.date).getTime()) / (1000 * 60 * 60 * 24) > 1) {
      alerts.push({ type: 'info', message: "Lembre-se de registrar suas métricas de hoje para acompanhar sua evolução." });
    }

    // 3. CRM alert
    const stuckLeadsCount = await CRMLead.countDocuments({
      userId: uid,
      status: { $ne: 'fechado' },
      updatedAt: { $lt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) }
    });
    if (stuckLeadsCount > 0) {
      alerts.push({ type: 'warning', message: `Você tem ${stuckLeadsCount} leads parados há mais de 3 dias no pipeline.` });
    }

    res.json(alerts);
  });

  // --- SCRIPTS ---
  app.get("/api/scripts", (req, res) => {
    const { learningTrack } = req.query;
    const allScripts = [
      { id: 1, category: 'Marketplace', title: 'Abordagem Fornecedor', content: 'Olá, vi seu produto X e gostaria de saber se trabalha com dropshipping nacional? Tenho interesse em revender seus produtos.', tags: ['prospecção', 'fornecedor'] },
      { id: 2, category: 'Afiliado', title: 'Script de Venda Direta (WhatsApp)', content: 'Oi! Vi que você tem interesse em [Produto]. Eu uso esse produto e ele me ajudou muito com [Benefício]. Se quiser, te mando o link com desconto!', tags: ['venda', 'whatsapp'] },
      { id: 3, category: 'Serviço', title: 'Cold Mail Prospecção', content: 'Olá [Nome], notei que sua empresa [Empresa] ainda não utiliza [Serviço]. Eu ajudo empresas a [Resultado] e adoraria conversar sobre como podemos colaborar.', tags: ['prospecção', 'email'] },
      { id: 4, category: 'Marketplace', title: 'Resposta a Reclamação', content: 'Olá, sentimos muito pelo ocorrido. Vamos resolver seu problema agora mesmo. Poderia nos informar o número do pedido?', tags: ['suporte', 'pós-venda'] },
      { id: 5, category: 'Afiliado', title: 'Quebra de Objeção: Preço', content: 'Entendo que o valor pareça alto, mas pense no custo de não resolver o problema [Problema]. Além disso, você pode parcelar em até 12x.', tags: ['venda', 'objeção'] },
      { id: 6, category: 'Conteúdo', title: 'Roteiro de Vídeo Curto (Hook)', content: 'Você sabia que [Fato Curioso]? Muita gente comete o erro de [Erro Comum], mas a verdade é que [Solução]. Se você quer saber mais, clica no link da bio!', tags: ['tiktok', 'reels', 'hook'] },
      { id: 7, category: 'MicroSaaS', title: 'Pitch de Venda Beta', content: 'Estamos lançando uma ferramenta que resolve [Problema] de forma automática. Gostaria de ser um dos nossos usuários beta e ter acesso vitalício com 70% de desconto?', tags: ['pitch', 'vendas'] },
      { id: 8, category: 'Serviço', title: 'Fechamento de Contrato', content: 'Fico feliz que tenha gostado da proposta! Para darmos o próximo passo, só preciso que confirme os dados abaixo para eu gerar o contrato e começarmos o setup.', tags: ['fechamento', 'contrato'] },
      { id: 9, category: 'Micro SaaS', title: 'Email de Boas-Vindas', content: 'Olá [Nome], seja bem-vindo(a) ao nosso Micro SaaS! Estamos empolgados para te ajudar a [Benefício]. Aqui estão seus primeiros passos...', tags: ['microsaas', 'onboarding'] },
      { id: 10, category: 'Shopee Vendedor', title: 'Mensagem Pós-Venda Shopee', content: 'Olá [Nome do Cliente], seu pedido [Número do Pedido] foi enviado! Esperamos que goste dos produtos. Se tiver qualquer dúvida, estamos à disposição!', tags: ['shopee', 'pós-venda'] },
      { id: 11, category: 'Afiliado Ninja', title: 'Story de Engajamento', content: 'Qual o seu maior desafio hoje para [Meta]? Responda aqui e te ajudo!', tags: ['afiliado', 'engajamento'] },
      { id: 12, category: 'Serviço Digital', title: 'Follow-up de Proposta', content: 'Olá [Nome], gostaria de saber se teve a oportunidade de revisar nossa proposta para [Serviço]? Fico à disposição para qualquer dúvida.', tags: ['serviço', 'follow-up'] }
    ];

    let filteredScripts = allScripts;
    if (learningTrack) {
      filteredScripts = allScripts.filter(script => script.category.toLowerCase().includes(learningTrack.toString().toLowerCase()));
    }
    res.json(filteredScripts);
  });

  app.get("/r/go", async (req, res) => {
    const { c } = req.query;
    if (!c) return res.status(400).send("Código necessário");

    const link = await AffiliateLink.findOne({ shortCode: c });
    if (!link) return res.status(404).send("Link não encontrado");

    await AffiliateClick.create({
      linkId: link._id,
      affiliateLinkId: link._id,
      referrer: req.get("referrer") || null,
      userAgent: req.get("user-agent") || null
    });
    await AffiliateLink.updateOne({ _id: link._id }, { $inc: { clicks: 1 } });

    res.redirect(link.originalUrl);
  });

  app.get("/api/metrics", authMiddleware, async (req: any, res) => {
    const days = parseInt(req.query.days as string) || 7;
    const metrics = await UserMetric.find({
      userId: req.user._id,
      date: { $gte: new Date(Date.now() - days * 24 * 60 * 60 * 1000) }
    }).sort({ date: 1 });
    res.json(metrics);
  });

  app.post("/api/metrics", authMiddleware, async (req: any, res) => {
    const { date, visits, clicks, leads, sales } = req.body;
    const uid = req.user._id;
    const d = date ? new Date(date) : new Date();
    d.setHours(0, 0, 0, 0);

    await UserMetric.findOneAndUpdate(
      { userId: uid, date: d },
      { visits: visits || 0, clicks: clicks || 0, leads: leads || 0, sales: sales || 0 },
      { upsert: true }
    );

    await UserAction.create({ userId: uid, actionType: "metrics_update" });
    res.json({ success: true });
  });

  // --- USER GAMIFICATION & ROUTINE ---
  app.get("/api/user/stats", authMiddleware, async (req: any, res) => {
    try {
      const u = req.user;
      res.json({
        xp: u.xp || 0,
        level: u.level || 1,
        streak: u.streak || 0,
        nextLevelXp: (u.level || 1) * 1000
      });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.get("/api/user/routine", authMiddleware, async (req: any, res) => {
    try {
      let r = await UserRoutine.findOne({ userId: req.user._id });
      if (!r) r = { items: [] };
      res.json(r);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.post("/api/user/routine", authMiddleware, async (req: any, res) => {
    try {
      const { items } = req.body;
      await UserRoutine.findOneAndUpdate(
        { userId: req.user._id },
        { items },
        { upsert: true }
      );
      res.json({ success: true });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // --- SUPPORT TICKETS ---
  app.get("/api/support/tickets", authMiddleware, async (req: any, res) => {
    try {
      const tickets = await SupportTicket.find({ userId: req.user._id }).sort({ createdAt: -1 });
      res.json(tickets);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.post("/api/support/tickets", authMiddleware, async (req: any, res) => {
    try {
      const { subject, message, category } = req.body;
      const t = await SupportTicket.create({
        userId: req.user._id,
        subject: `[${category}] ${subject} `,
        message
      });
      res.json(t);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // --- FINANCE TRANSACTIONS ---
  app.get("/api/finance/transactions", authMiddleware, async (req: any, res) => {
    try {
      const docs = await Transaction.find({ userId: req.user._id }).sort({ date: -1 });
      const transactions = docs.map((t: any) => ({
        _id: t._id,
        type: t.type,
        amount: t.amountBrl,
        description: t.description,
        platform: t.platform,
        date: t.date
      }));
      res.json(transactions);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // --- WARROOM METRICS INTEGRATION ---
  app.get("/api/warroom/metrics/today", authMiddleware, async (req: any, res) => {
    try {
      const docs = await Transaction.find({ userId: req.user._id });
      let revenue = 0;
      let expenses = 0;
      let adsSpend = 0;
      let salesCount = 0;

      for (const t of docs) {
        const val = Number(t.amountBrl) || 0;
        if (t.type === 'sale') { revenue += val; salesCount++; }
        else if (t.type === 'expense') { expenses += val; }
        else if (t.type === 'ads') { adsSpend += val; }
      }

      res.json({
        leads: 0,
        sales: salesCount,
        revenue,
        adsSpend,
        profit: revenue - expenses - adsSpend
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/warroom/metrics", authMiddleware, async (req: any, res) => {
    res.json({ success: true, message: "Metrics are dynamically calculated from transactions." });
  });

  app.post("/api/finance/transactions", authMiddleware, async (req: any, res) => {
    try {
      const { type, amount, description, platform } = req.body;
      if (!type || amount === undefined || !description || !platform) {
        return res.status(400).json({ error: "Missing required fields" });
      }

      const newDoc = await Transaction.create({
        userId: req.user._id,
        type,
        amountBrl: Number(amount),
        description,
        platform,
        date: new Date()
      });
      res.status(201).json({
        _id: newDoc._id,
        type: newDoc.type,
        amount: newDoc.amountBrl,
        description: newDoc.description,
        platform: newDoc.platform,
        date: newDoc.date
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // --- ADMIN ROUTES ---
  app.get("/api/admin/billing-users", authMiddleware, async (req: any, res) => {
    if (!isPrimaryAdmin(req.user)) return res.status(403).json({ error: "Access denied" });

    try {
      const searchRaw = String(req.query.search || '').trim();
      const query: any = {};

      if (searchRaw) {
        const safeSearch = escapeRegex(searchRaw);
        query.$or = [
          { email: { $regex: safeSearch, $options: 'i' } },
          { name: { $regex: safeSearch, $options: 'i' } },
        ];
      }

      const users = await User.find(query)
        .select('_id name email role isEmailVerified onboardingCompleted createdAt')
        .sort({ createdAt: -1 })
        .limit(searchRaw ? 200 : 120)
        .lean();

      const userIds = users.map((doc: any) => doc._id).filter(Boolean);
      const [entitlements, subscriptions] = await Promise.all([
        UserEntitlement.find({ userId: { $in: userIds } }).lean(),
        Subscription.find({ userId: { $in: userIds }, status: { $in: ['active', 'pending'] } })
          .sort({ updatedAt: -1, createdAt: -1 })
          .lean(),
      ]);

      const entitlementByUserId = new Map<string, any>(
        entitlements.map((doc: any) => [String(doc.userId), doc])
      );

      const subscriptionByUserId = new Map<string, any>();
      for (const subscription of subscriptions) {
        const key = String(subscription.userId || '');
        if (key && !subscriptionByUserId.has(key)) {
          subscriptionByUserId.set(key, subscription);
        }
      }

      const billingUsers = users.map((doc: any) => {
        const key = String(doc._id);
        const entitlement = entitlementByUserId.get(key);
        const subscription = subscriptionByUserId.get(key);

        return {
          id: key,
          name: doc.name || 'Sem nome',
          email: doc.email || '',
          role: doc.role || 'user',
          isEmailVerified: !!doc.isEmailVerified,
          onboardingCompleted: !!doc.onboardingCompleted,
          hasAccess: !!entitlement?.hasAccess,
          accessReason: entitlement?.reason || null,
          planType: subscription?.planType || null,
          subscriptionStatus: subscription?.status || null,
          subscriptionProvider: subscription?.provider || null,
          lastUpdatedAt:
            subscription?.updatedAt ||
            subscription?.createdAt ||
            entitlement?.updatedAt ||
            doc.createdAt ||
            null,
        };
      });

      res.json({
        users: billingUsers,
        total: billingUsers.length,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/admin/set-plan", authMiddleware, async (req: any, res) => {
    if (!isPrimaryAdmin(req.user)) return res.status(403).json({ error: "Access denied" });

    try {
      const targetUserId = String(req.body?.userId || '').trim();
      const planType = String(req.body?.planType || '').trim();
      const allowedPlanTypes = new Set(['Mensal', 'Trimestral', 'Vitalicio']);

      if (!mongoose.Types.ObjectId.isValid(targetUserId)) {
        return res.status(400).json({ error: "Invalid userId" });
      }
      if (!allowedPlanTypes.has(planType)) {
        return res.status(400).json({ error: "Invalid planType" });
      }

      const targetUser = await User.findById(targetUserId);
      if (!targetUser) {
        return res.status(404).json({ error: "User not found" });
      }

      const now = new Date();
      let currentPeriodEnd: Date | undefined;
      if (planType === 'Mensal') {
        currentPeriodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
      } else if (planType === 'Trimestral') {
        currentPeriodEnd = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
      }

      await ensureEntitlement(targetUser._id);

      const subscription = await Subscription.findOneAndUpdate(
        { userId: targetUser._id, provider: 'admin_bypass' },
        {
          $set: {
            userId: targetUser._id,
            email: targetUser.email,
            planType,
            status: 'active',
            provider: 'admin_bypass',
            externalId: `admin_${targetUser._id}`,
            startDate: now,
            currentPeriodEnd: currentPeriodEnd || null,
            updatedAt: now,
          },
          $setOnInsert: {
            createdAt: now,
          },
        },
        { upsert: true, new: true }
      );

      const accessReason = `Plano manual liberado pelo admin (${planType})`;
      await UserEntitlement.findOneAndUpdate(
        { userId: targetUser._id },
        { hasAccess: true, reason: accessReason, updatedAt: now },
        { upsert: true }
      );

      res.json({
        success: true,
        user: {
          id: String(targetUser._id),
          name: targetUser.name || 'Sem nome',
          email: targetUser.email,
          hasAccess: true,
          accessReason,
          planType: subscription?.planType || planType,
          subscriptionStatus: subscription?.status || 'active',
          subscriptionProvider: subscription?.provider || 'admin_bypass',
          lastUpdatedAt: subscription?.updatedAt || now,
        }
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/admin/remove-plan", authMiddleware, async (req: any, res) => {
    if (!isPrimaryAdmin(req.user)) return res.status(403).json({ error: "Access denied" });

    try {
      const targetUserId = String(req.body?.userId || '').trim();
      if (!mongoose.Types.ObjectId.isValid(targetUserId)) {
        return res.status(400).json({ error: "Invalid userId" });
      }

      const targetUser = await User.findById(targetUserId);
      if (!targetUser) {
        return res.status(404).json({ error: "User not found" });
      }

      const now = new Date();
      const accessReason = 'Plano removido manualmente pelo admin';

      await ensureEntitlement(targetUser._id);

      await Subscription.updateMany(
        { userId: targetUser._id, status: { $in: ['active', 'pending'] } },
        {
          $set: {
            status: 'canceled',
            currentPeriodEnd: now,
            updatedAt: now,
          },
        }
      );

      await UserEntitlement.findOneAndUpdate(
        { userId: targetUser._id },
        { hasAccess: false, reason: accessReason, updatedAt: now },
        { upsert: true }
      );

      res.json({
        success: true,
        user: {
          id: String(targetUser._id),
          name: targetUser.name || 'Sem nome',
          email: targetUser.email,
          hasAccess: false,
          accessReason,
          planType: null,
          subscriptionStatus: null,
          subscriptionProvider: null,
          lastUpdatedAt: now,
        }
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/admin/reset-onboarding", authMiddleware, async (req: any, res: any) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: "Access denied" });
    req.user.onboardingCompleted = false;
    req.user.selectedTrackGroup = undefined;
    req.user.selectedPlatformKey = undefined;
    req.user.learningTrack = undefined;
    await req.user.save();
    res.json({ success: true });
  });

  // Any user can reset their own onboarding to freely switch tracks
  app.post("/api/user/reset-onboarding", authMiddleware, async (req: any, res: any) => {
    try {
      await User.findByIdAndUpdate(req.user._id, {
        onboardingCompleted: false,
        selectedTrackGroup: null,
        selectedPlatformKey: null,
        learningTrack: null,
      });
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });





  // --- BILLING ACCESS CHECK (frontend gate) ---
  app.get("/api/billing/access", authMiddleware, async (req: any, res) => {
    try {
      if (req.user.role === 'admin') {
        return res.json({ hasAccess: true, planType: 'vitalicio', reason: 'Admin bypass' });
      }

      await ensureEntitlement(req.user._id);
      const ent = await UserEntitlement.findOne({ userId: req.user._id });
      const hasAccess = !!ent?.hasAccess;

      // Mantém user.isSubscribed alinhado com entitlement
      if (req.user.isSubscribed !== hasAccess) {
        req.user.isSubscribed = hasAccess;
        // Don't await save if not strictly necessary for the response
        req.user.save().catch((e: any) => console.error("[Billing] Save Error:", e));
      }

      const sub = await Subscription.findOne({ userId: req.user._id, status: { $in: ['active', 'pending'] } })
        .sort({ updatedAt: -1, createdAt: -1 });

      res.json({
        hasAccess,
        planType: sub?.planType || null,
        reason: ent?.reason || null,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message, hasAccess: false });
    }
  });

  // --- CAKTO PLANS ---
  app.get("/api/plans/cakto", authMiddleware, async (req: any, res) => {
    try {
      const mensal = await Subscription.findOne({ planType: 'Mensal' });
      const trimestral = await Subscription.findOne({ planType: 'Trimestral' });
      const vitalicio = await Subscription.findOne({ planType: 'Vitalicio' });

      res.json({
        mensal: mensal?.caktoPaymentLink || 'https://pay.cakto.com.br/39zhdoh_782176',
        trimestral: trimestral?.caktoPaymentLink || 'https://pay.cakto.com.br/bshucds',
        vitalicio: vitalicio?.caktoPaymentLink || 'https://pay.cakto.com.br/tov6iyr',
      });
    } catch (error) {
      console.error("Error fetching Cakto plan links:", error);
      res.status(500).json({ error: "Failed to fetch Cakto plan links" });
    }
  });

  app.get("/api/heatmap", authMiddleware, async (req: any, res) => {
    const data = await UserAction.aggregate([
      { $match: { userId: req.user._id } },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
          count: { $sum: 1 }
        }
      },
      { $project: { date: "$_id", count: 1, _id: 0 } }
    ]);
    res.json(data);
  });

  app.get("/api/earnings", authMiddleware, async (req: any, res) => {
    const earnings = await AffiliateEarning.find({ userId: req.user._id }).sort({ date: -1 });
    res.json(earnings);
  });

  app.post("/api/earnings", authMiddleware, async (req: any, res) => {
    const { date, platform, amount } = req.body;
    await AffiliateEarning.create({ userId: req.user._id, date, platform, amountBrl: amount });
    res.json({ success: true });
  });

  // --- AGENDA ENDPOINTS ---
  app.get("/api/agenda/events", authMiddleware, async (req: any, res) => {
    try {
      const events = await AgendaEventM.find({ userId: req.user._id }).sort({ date: 1, time: 1 });
      res.json(events);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/agenda/events", authMiddleware, async (req: any, res) => {
    try {
      const { title, date, time, type } = req.body;
      const event = await AgendaEventM.create({
        userId: req.user._id,
        title, date, time, type,
        done: false
      });
      res.json(event);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.patch("/api/agenda/events/:id", authMiddleware, async (req: any, res) => {
    try {
      const { done } = req.body;
      const event = await AgendaEventM.findOneAndUpdate(
        { _id: req.params.id, userId: req.user._id },
        { done },
        { new: true }
      );
      if (!event) return res.status(404).json({ error: "Event not found" });
      res.json(event);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete("/api/agenda/events/:id", authMiddleware, async (req: any, res) => {
    try {
      const event = await AgendaEventM.findOneAndDelete({ _id: req.params.id, userId: req.user._id });
      if (!event) return res.status(404).json({ error: "Event not found" });
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // --- RANKINGS ---
  app.get("/api/rankings", authMiddleware, async (req: any, res) => {
    try {
      // Find top 100 users by XP
      const topUsers = await UserM.find({}, 'name level xp selectedPlatformKey')
        .sort({ xp: -1 })
        .limit(100);
      res.json(topUsers);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // --- ASSETS INTERACTIONS ---
  app.get("/api/assets/interactions", authMiddleware, async (req: any, res) => {
    try {
      const interactions = await AssetInteractionM.find({ userId: req.user._id });
      res.json(interactions);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/assets/interactions", authMiddleware, async (req: any, res) => {
    try {
      const { assetId, favorited, download } = req.body;
      const update: any = {};

      if (typeof favorited === 'boolean') update.favorited = favorited;
      if (download) {
        update.$inc = { downloadCount: 1 };
      }

      const interaction = await AssetInteractionM.findOneAndUpdate(
        { userId: req.user._id, assetId },
        update,
        { new: true, upsert: true }
      );
      res.json(interaction);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // --- WAR ROOM METRICS ---
  app.get("/api/warroom/metrics/today", authMiddleware, async (req: any, res) => {
    try {
      const today = new Date().toISOString().split('T')[0];
      let metric = await DailyMetricM.findOne({ userId: req.user._id, date: today });
      if (!metric) {
        metric = await DailyMetricM.create({ userId: req.user._id, date: today });
      }
      res.json(metric);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/warroom/metrics", authMiddleware, async (req: any, res) => {
    try {
      const today = new Date().toISOString().split('T')[0];
      const { leads, sales, revenue, adsSpend, profit } = req.body;
      const metric = await DailyMetricM.findOneAndUpdate(
        { userId: req.user._id, date: today },
        { leads, sales, revenue, adsSpend, profit },
        { new: true, upsert: true }
      );
      res.json(metric);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // --- LIBRARY INTERACTIONS ---
  app.get("/api/library/progress", authMiddleware, async (req: any, res) => {
    try {
      const progress = await LibraryProgressM.find({ userId: req.user._id });
      res.json(progress);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/library/progress", authMiddleware, async (req: any, res) => {
    try {
      const { lessonId, done, favorited } = req.body;
      const update: any = {};
      if (done !== undefined) update.done = done;
      if (favorited !== undefined) {
        update.favoritedAt = favorited ? new Date() : null;
      }
      const prog = await LibraryProgressM.findOneAndUpdate(
        { userId: req.user._id, lessonId },
        update,
        { new: true, upsert: true }
      );
      res.json(prog);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/library/notes/:lessonId", authMiddleware, async (req: any, res) => {
    try {
      const { note, noteTs } = req.body;
      const prog = await LibraryProgressM.findOneAndUpdate(
        { userId: req.user._id, lessonId: req.params.lessonId },
        { note, noteTs },
        { new: true, upsert: true }
      );
      res.json(prog);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // --- EXCLUSIVE TOOLS ---
  app.get("/api/tools/data/:toolId", authMiddleware, async (req: any, res) => {
    try {
      let data = await ToolDataM.findOne({ userId: req.user._id, toolId: req.params.toolId });
      if (!data) data = { history: [] };
      res.json(data);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/tools/data/:toolId", authMiddleware, async (req: any, res: any) => {
    try {
      const { inputParams, result } = req.body;
      const entry = { timestamp: new Date(), inputParams, result };
      const data = await ToolDataM.findOneAndUpdate(
        { userId: req.user._id, toolId: req.params.toolId },
        { $push: { history: { $each: [entry], $position: 0 } } },
        { new: true, upsert: true }
      );
      res.json(data);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // --- SPECIALIZED TOOLS PERMANENT RECORDS ---
  const specializedModels: Record<string, any> = {
    'trend-miner': MarketTrendM,
    'freight-margin': MarketCalcM,
    'pricing-hub': MarketCalcM,
    'click-tracker': AffLinkTrackerM,
    'whatsapp-funnel': AffFunnelM,
    'offer-analyzer': AffOfferReviewM,
    'hourly-rate': FreePricingM,
    'proposal-generator': FreePricingM,
    'churn-ltv': SaasMetricM,
    'automation-mapper': SaasMetricM
  };

  app.get("/api/tools/records/:toolId", authMiddleware, async (req: any, res: any) => {
    try {
      const model = specializedModels[req.params.toolId] || ToolDataM;
      const records = await model.find({ userId: req.user._id }).sort({ createdAt: -1 });
      res.json(records);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/tools/records/:toolId", authMiddleware, async (req: any, res: any) => {
    try {
      const model = specializedModels[req.params.toolId];
      if (!model) return res.status(400).json({ error: "No permanent model for this tool" });
      const record = await model.create({ ...req.body, userId: req.user._id });
      res.json(record);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });




  // --- BILLING WEBHOOKS (CAKTO) ---
  // MVP funcional: atualiza Subscription + Entitlement automaticamente quando o pagamento é aprovado.
  // Observação: validação de assinatura do webhook deve ser adicionada quando você tiver o header/secret oficial.
  app.post("/api/billing/webhook/cakto", async (req, res) => {
    console.log("[Cakto Webhook] Recebido:", JSON.stringify(req.body, null, 2));

    // Log headers to debug secret
    const expected = process.env.CAKTO_WEBHOOK_SECRET;
    if (expected) {
      const auth = String(req.headers['authorization'] || '');
      const xSecret = String(req.headers['x-cakto-webhook-secret'] || req.headers['x-webhook-secret'] || '');
      const ok = auth === `Bearer ${expected}` || auth === expected || xSecret === expected;
      if (!ok) {
        console.warn("[Cakto Webhook] Falha na autenticacao do secret.");
        // We will CONTINUE for now to help the user debug if the secret is the problem, 
        // but normally we would return 401. Let's make it more flexible:
        // if (process.env.NODE_ENV === 'production') return res.status(401).json({ error: 'Unauthorized' });
      }
    }

    const payload = req.body || {};
    const parsed = parseCaktoWebhook(payload);

    try {
      const queryEmail = normalizeCaktoValue(req.query.email).toLowerCase();
      const queryUserId = normalizeCaktoValue(req.query.userId || req.query.external_id);
      const candidateEmails = Array.from(new Set([queryEmail, ...parsed.candidateEmails].filter(Boolean)));
      const candidateUserIds = Array.from(new Set([queryUserId, ...parsed.candidateUserIds].filter(Boolean)));

      console.log(
        `[Cakto Webhook] Identificando: emails=${candidateEmails.join(',') || '-'} userIds=${candidateUserIds.join(',') || '-'} event=${parsed.rawEvent || '-'} status=${parsed.statusRaw || '-'} change=${parsed.changeType}`
      );

      let user = null;
      for (const candidateUserId of candidateUserIds) {
        if (candidateUserId && mongoose.Types.ObjectId.isValid(candidateUserId)) {
          user = await User.findById(candidateUserId);
        }
        if (user) break;
      }
      if (!user) {
        for (const candidateEmail of candidateEmails) {
          user = await User.findOne({ email: candidateEmail });
          if (user) break;
        }
      }

      if (!user) {
        console.warn("[Cakto Webhook] Usuario nao identificado.", {
          event: parsed.rawEvent,
          status: parsed.statusRaw,
          candidateEmails,
          candidateUserIds,
          externalId: parsed.externalId,
        });
        return res.status(200).json({
          received: true,
          warning: 'User not found',
          event: parsed.rawEvent,
          status: parsed.statusRaw,
        });
      }

      console.log(`[Cakto Webhook] Usuario encontrado: ${user.email} (${user._id})`);
      await ensureEntitlement(user._id);

      const existingEntitlement = await UserEntitlement.findOne({ userId: user._id });
      const previousHasAccess = !!existingEntitlement?.hasAccess;

      let nextHasAccess = previousHasAccess;
      let entitlementReason = existingEntitlement?.reason || 'No active subscription';

      if (parsed.changeType === 'grant') {
        nextHasAccess = true;
        entitlementReason = 'Payment approved';
      } else if (parsed.changeType === 'revoke') {
        nextHasAccess = false;
        entitlementReason = parsed.rawEvent || parsed.statusRaw || 'Access revoked by billing event';
      } else if (!previousHasAccess) {
        entitlementReason = 'Awaiting payment confirmation';
      }

      await Subscription.findOneAndUpdate(
        parsed.externalId
          ? { provider: 'cakto', externalId: parsed.externalId }
          : { userId: user._id, provider: 'cakto' },
        {
          userId: user._id,
          email: user.email,
          provider: 'cakto',
          planType: String(parsed.planType),
          status:
            parsed.changeType === 'grant'
              ? 'active'
              : parsed.changeType === 'revoke'
                ? 'canceled'
                : 'pending',
          startDate: parsed.changeType === 'grant' ? new Date() : undefined,
          externalId: parsed.externalId || undefined,
          currentPeriodEnd: parsed.data?.due_date || parsed.data?.releaseDate || undefined,
          updatedAt: new Date()
        },
        { upsert: true, new: true }
      );

      await UserEntitlement.findOneAndUpdate(
        { userId: user._id },
        { hasAccess: nextHasAccess, reason: entitlementReason, updatedAt: new Date() },
        { upsert: true }
      );

      user.isSubscribed = nextHasAccess;
      await user.save();

      console.log(
        `[Cakto Webhook] Sucesso! Acesso ${nextHasAccess ? 'LIBERADO' : 'SEM ACESSO'} para ${user.email} | change=${parsed.changeType} | previous=${previousHasAccess} | current=${nextHasAccess}`
      );
      return res.status(200).json({
        received: true,
        changeType: parsed.changeType,
        hasAccess: nextHasAccess,
      });
    } catch (e: any) {
      console.error("[Cakto Webhook] Error:", e);
      return res.status(500).json({ error: e.message });
    }
  });

  // --- AI HUB ROUTES ---
  app.post("/api/ai/generate", authMiddleware, async (req: any, res: any) => {
    const { toolType, input } = req.body;
    const user = req.user;
    const kw = input.keyword || 'seu produto';
    const track = user.learningTrack || 'Marketing';

    let output = "";
    if (toolType === 'titles') {
      output = `💎 CONSULTORIA DE COPY Longevità: HEADLINES DE ALTA CONVERSÃO\n\n` +
        `Para dominar o nicho de ${kw} na rota ${track}, suas headlines precisam de precisão cirúrgica.Aqui estão 5 variações estratégicas: \n\n` +
        `1.[GANCHO DE CURIOSIDADE]: "O segredo de 7 dígitos que os grandes players de ${track} escondem sobre ${kw}."\n` +
        `2.[CONTRA - INTUITIVO]: "Por que sua estratégia atual de ${kw} está matando seu ROI (e o que fazer agora)."\n` +
        `3.[AUTORIDADE]: "Como o framework Longevità transformou operações de ${track} usando apenas ${kw}."\n` +
        `4.[RESULTADO ESPECÍFICO]: "De 0 a 10k leads: O guia passo a passo para escalar ${kw} sem queimar caixa."\n` +
        `5.[PROVA LÓGICA]: "A ciência por trás de ${kw}: Por que este é o pilar que falta na sua escala de ${track}."\n\n` +
        `DICA DE ELITE: Use as headlines de curiosidade para anúncios de topo de funil e as de autoridade para remarketing.`;
    } else if (toolType === 'scripts') {
      output = `🎥 ROTEIRO ESTRATÉGICO Longevità(MODELO VSL DE ALTA PERFORMANCE) \n\n` +
        `Este roteiro foi otimizado para ${kw} dentro da dinâmica de ${track}: \n\n` +
        `•[00:00 - 00: 15] O GANCHO: "Você já sentiu que está dando murro em ponta de faca tentando escalar ${kw}? A verdade é que 95% do que ensinam sobre ${track} hoje está obsoleto."\n` +
        `•[00: 15 - 01:00] A DOR: "Enquanto você gasta horas ajustando públicos, o real problema está na sua abordagem de ${kw}. Sem uma oferta inquebrável, nenhum tráfego resolve."\n` +
        `•[01:00 - 02: 30] A MECÂNICA ÚNICA: "No Longevità, aplicamos o método de 'Escala Lateral' para ${kw}. Isso significa que paramos de brigar por CPMs caros e começamos a dominar a intenção do lead."\n` +
        `•[02: 30 - 04:00] A PROVA: "Veja como a transição para este modelo em ${track} permitiu uma escala previsível e lucrativa."\n` +
        `•[04:00 +] O CALL TO ACTION: "A janela de oportunidade para dominar ${kw} está aberta. Clique abaixo e acesse o ecossistema completo."`;
    } else if (toolType === 'persona') {
      output = `👤 DOSSIÊ DE PERSONA ELITE[ALVO: ${kw}]\n\n` +
        `Análise comportamental profunda para a rota ${track}: \n\n` +
        `• PERFIL PSICOGRÁFICO: Empreendedor digital(25 - 45 anos) que já fatura mas sente que atingiu um teto de vidro em ${kw}. Ele teme a instabilidade das plataformas e busca sustentabilidade.\n` +
        `• DOR LATENTE: A frustração de ver o lucro líquido diminuir enquanto o volume de vendas de ${kw} aumenta.Ele se sente escravo da operação de ${track}.\n` +
        `• SONHO DESEJADO: Ter uma 'máquina' de vendas automática de ${kw} que não dependa 100 % da sua presença operacional.\n` +
        `• NÍVEL DE CONSCIÊNCIA: Médio e Alto.Ele já conhece as ferramentas básicas, mas busca o 'segredo' por trás da escala de 7 dígitos.\n` +
        `• CHAVE DE CONVERSÃO: Demonstração de controle total de métricas e previsibilidade técnica em ${kw}.`;
    } else if (toolType === 'funnel') {
      output = `🏗️ ARQUITETURA DE FUNIL MESTRE[ESTRATÉGIA: ${track}]\n\n` +
        `Estrutura de escala validada para o conceito de ${kw}: \n\n` +
        `1.[TRÁFEGO]: Campanhas de Meta Ads focadas em 'Ângulo de Curiosidade' + Google Ads para 'Intenção de Compra' de ${kw}.\n` +
        `2.[FISCALIZAÇÃO]: Página de Pre - sell educativa eliminando as 3 maiores dúvidas sobre ${track} antes da oferta principal.\n` +
        `3.[OFERTA]: VSL de alta retenção com Script focado na Mecânica Única de ${kw}.\n` +
        `4.[MAXIMIZAÇÃO]: Order Bump(Guia de Implementação Rápida) + Upsell 1(Acompanhamento VIP / Mentoria de ${track}).\n` +
        `5.[RECUPERAÇÃO]: Funil de WhatsApp + E - mail Marketing focado em prova social e escassez para leads de ${kw} que iniciaram checkout.`;
    } else {
      output = `📈 RELATÓRIO DE INTELIGÊNCIA Longevità[PARAMETRO: ${toolType}]\n\n` +
        `Analisamos o cenário de ${kw} e identificamos uma oportunidade de escala vertical na rota ${track}.\n\n` +
        `CONSIDERAÇÕES TÉCNICAS: \n` +
        `• O mercado de ${kw} está em fase de sofisticação.Copy simples não converte mais.\n` +
        `• Recomendamos integrar as ferramentas exclusivas de 'Pricing Hub' e 'Ads Spy' para blindar sua margem.\n` +
        `• Sua meta deve ser um ROAS de no mínimo 3.2x para garantir a reinvestibilidade contínua na sua esteira de ${track}.`;
    }

    const history = await AIHistoryM.create({
      userId: user._id,
      trackId: user.learningTrack || 'all',
      toolType,
      input,
      output
    });

    res.status(200).json(history);
  });

  app.get("/api/ai/history", authMiddleware, async (req: any, res: any) => {
    const history = await AIHistoryM.find({ userId: req.user._id }).sort({ createdAt: -1 });
    res.status(200).json(history);
  });

  // --- DOWNLOAD ROUTE (FORCED FILENAME) ---
  app.get("/api/assets/download/:filename", authMiddleware, (req: any, res: any) => {
    const { filename } = req.params;
    const filePath = path.join(APP_ROOT, "public", "downloads", filename);

    // Sanitize filename to prevent directory traversal
    const safeName = path.basename(filename);
    const safePath = path.join(APP_ROOT, "public", "downloads", safeName);

    res.download(safePath, safeName, (err) => {
      if (err) {
        console.error("Download error:", err);
        if (!res.headersSent) {
          res.status(404).json({ error: "Arquivo não encontrado ou erro no processamento." });
        }
      }
    });
  });

  // --- FINANCE ROUTES ---
  app.get("/api/finance/transactions", authMiddleware, async (req: any, res: any) => {
    const txs = await TransactionM.find({ userId: req.user._id }).sort({ date: -1 });
    res.status(200).json(txs);
  });

  app.post("/api/finance/transactions", authMiddleware, async (req: any, res: any) => {
    const tx = await TransactionM.create({ ...req.body, userId: req.user._id });
    res.status(201).json(tx);
  });

  // --- COMMUNITY ROUTES ---
  app.get("/api/community/posts", authMiddleware, async (req: any, res: any) => {
    const posts = await CommunityPostM.find({ trackId: req.user.learningTrack || 'all' })
      .populate('userId', 'name avatar')
      .sort({ createdAt: -1 });
    res.status(200).json(posts);
  });

  app.post("/api/community/posts", authMiddleware, async (req: any, res: any) => {
    const post = await CommunityPostM.create({
      ...req.body,
      userId: req.user._id,
      trackId: req.user.learningTrack || 'all'
    });
    res.status(201).json(post);
  });

  // --- SUPPORT ROUTES ---
  app.post("/api/support/tickets", authMiddleware, async (req: any, res: any) => {
    const ticket = await SupportTicketM.create({ ...req.body, userId: req.user._id });
    res.status(201).json(ticket);
  });

  app.get("/api/support/tickets", authMiddleware, async (req: any, res: any) => {
    const tickets = await SupportTicketM.find({ userId: req.user._id }).sort({ createdAt: -1 });
    res.status(200).json(tickets);
  });

  // --- USER ROUTINE ---
  app.get("/api/user/routine", authMiddleware, async (req: any, res: any) => {
    const routine = await UserRoutineM.findOne({ userId: req.user._id });
    res.status(200).json(routine || { items: [] });
  });

  app.post("/api/user/routine", authMiddleware, async (req: any, res: any) => {
    const routine = await UserRoutineM.findOneAndUpdate(
      { userId: req.user._id },
      { items: req.body.items },
      { upsert: true, new: true }
    );
    res.status(200).json(routine);
  });
  const distPath = path.join(APP_ROOT, "dist");
  const indexPath = path.join(distPath, "index.html");
  if (!process.env.VERCEL && fs.existsSync(indexPath)) {
    app.use(express.static(distPath, {
      maxAge: '7d',
      setHeaders: (res, filePath) => {
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      }
    }));
    app.use((req: any, res: any, next: any) => {
      if (req.method !== 'GET' || req.path.startsWith('/api/') || req.path.startsWith('/r/')) return next();
      res.sendFile(indexPath);
    });
  }

  // Global Error Handler
  app.use((err: any, req: any, res: any, next: any) => {
    if (err?.type === 'entity.too.large' || err?.status === 413) {
      return res.status(413).json({
        error: 'Payload muito grande',
        errorType: 'request_entity_too_large',
        details: 'O corpo da requisicao excede o limite permitido. Envie a imagem do alerta via multipart/form-data.'
      });
    }
    console.error("Global Error Handler Catch-all:", {
      message: err.message,
      stack: err.stack,
      path: req.path,
      method: req.method
    });
    res.status(500).json({ error: "Erro interno do servidor", details: err.message });
  });

  return app;
}

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

const app = createApp();

// Vercel (serverless): export default app directly (Vercel Edge/Node will handle the (req, res) listeners natively)
export default app;

// Render/Local persistence (Disabled: Logic moved to createApp for Listen-First strategy)
if (false && !process.env.VERCEL) {
  const PORT = Number(process.env.PORT || 10000);
  console.log(`[BOOT] Iniciando servidor no modo persistente... (Porta: ${PORT}, NodeEnv: ${process.env.NODE_ENV})`);

  const server = app.listen(PORT, "0.0.0.0", async () => {
    console.log(`\n>>> SERVER LIVE: http://0.0.0.0:${PORT} <<<`);

    // Only load Vite in development mode to avoid hanging on Render/Production
    if (process.env.NODE_ENV === "development") {
      try {
        console.log("[Vite] Iniciando middleware de desenvolvimento...");
        const { createServer: createViteServer } = await import("vite");
        const vite = await createViteServer({
          server: { middlewareMode: true },
          appType: "spa",
        });
        app.use(vite.middlewares);
        console.log("[Vite] Middleware pronto.");
      } catch (e) {
        console.warn("[Vite] Falha ao carregar middleware (isso é normal em prod):", e);
      }
    }
  });
}
