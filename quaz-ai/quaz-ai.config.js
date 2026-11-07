/**
 * ═══════════════════════════════════════════════════════════════════
 * Quaz AI - Configuration Module
 * ═══════════════════════════════════════════════════════════════════
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env'), override: true });
require('dotenv').config({ path: '/app/.env', override: true });

module.exports = {
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite',
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramAdminChatId: String(process.env.TELEGRAM_ADMIN_CHAT_ID || '1403727915'),
  telegramWebhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET || 'quaz_ai_sec_tg_2026',
  publicUrl: process.env.SELF_PUBLIC_URL || 'https://api.hg-alshour.online',
  enabled: process.env.QUAZ_AI_ENABLED !== 'false',
  systemName: 'House of Glass - معرض ومخازن آل عاشور عدس',
};
