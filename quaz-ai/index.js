/**
 * ═══════════════════════════════════════════════════════════════════
 * Quaz AI - Main Module Entry & Web Router
 * ───────────────────────────────────────────────────────────────────
 * Provides Express API endpoints for Web Copilot and handles the
 * Telegram Webhook receiver.
 * ═══════════════════════════════════════════════════════════════════
 */

const express = require('express');
const router = express.Router();
const config = require('./quaz-ai.config');
const engine = require('./quaz-ai.engine');
const telegram = require('./quaz-ai.telegram');

/**
 * POST /api/quaz-ai/chat
 * Web Dashboard AI Copilot endpoint
 */
router.post('/chat', async (req, res) => {
  try {
    const { message, history } = req.body;
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'الرسالة مطلوبة' });
    }

    const reply = await engine.processUserPrompt(message, history || []);
    res.json({
      success: true,
      reply,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[Quaz AI Web API] Error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'حدث خطأ في معالجة طلب المساعد الذكي',
    });
  }
});

/**
 * POST /api/quaz-ai/voice
 * Multimodal Web Voice Endpoint (Audio Base64)
 */
router.post('/voice', express.json({ limit: '25mb' }), async (req, res) => {
  try {
    const { audio, mimeType } = req.body;
    if (!audio) {
      return res.status(400).json({ error: 'ملف الصوت مطلوب' });
    }

    const audioBuffer = Buffer.from(audio, 'base64');
    const reply = await engine.processVoicePrompt(audioBuffer, mimeType || 'audio/webm');
    res.json({
      success: true,
      reply,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[Quaz AI Voice API] Error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'حدث خطأ أثناء معالجة التسجيل الصوتي',
    });
  }
});

/**
 * POST /api/quaz-ai/telegram/webhook
 * Instant Telegram Webhook receiver
 */
router.post('/telegram/webhook', (req, res) => {
  const secretHeader = req.headers['x-telegram-bot-api-secret-token'];
  if (config.telegramWebhookSecret && secretHeader && secretHeader !== config.telegramWebhookSecret) {
    console.warn('[Quaz AI Webhook] ⚠️ Rejected webhook with invalid secret token');
    return res.status(403).json({ error: 'Invalid secret token' });
  }

  // Acknowledge immediately to Telegram within 200ms
  res.sendStatus(200);

  // Process message asynchronously
  if (req.body && req.body.message) {
    telegram.handleTelegramMessage(req.body.message).catch(err => {
      console.error('[Quaz AI Webhook] Error in message handler:', err);
    });
  }
});

/**
 * GET /api/quaz-ai/status
 * Diagnostic status endpoint
 */
router.get('/status', (req, res) => {
  res.json({
    status: 'online',
    system: config.systemName,
    model: config.geminiModel,
    telegramConfigured: Boolean(config.telegramBotToken),
    adminChatId: config.telegramAdminChatId,
  });
});

/**
 * Initialize Quaz AI services
 */
function initQuazAi(app) {
  if (!config.enabled) {
    console.log('[Quaz AI] ⚠️ Quaz AI is disabled via QUAZ_AI_ENABLED=false');
    return;
  }

  // Mount API router
  app.use('/api/quaz-ai', router);

  // Setup Telegram Webhook (non-blocking)
  telegram.setupTelegramWebhook().catch(err => {
    console.error('[Quaz AI] Webhook setup failed:', err.message);
  });

  console.log(`[Quaz AI] ✨ Quaz AI module loaded successfully! (Model: ${config.geminiModel})`);
}

module.exports = {
  initQuazAi,
  router,
  engine,
  telegram,
  tools: require('./quaz-ai.tools'),
};
