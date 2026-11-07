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
const tts = require('./quaz-ai.tts');

/**
 * POST /api/quaz-ai/chat
 * Web Dashboard AI Copilot endpoint
 */
router.post('/chat', async (req, res) => {
  try {
    const { message, history, branchId } = req.body;
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'الرسالة مطلوبة' });
    }

    // Extract authenticated user context & branch role
    const effectiveBranchId = Number(branchId) || Number(req.user?.branch_id) || 1;
    const userContext = {
      id: req.user?.id,
      username: req.user?.username || req.user?.full_name,
      role: req.user?.role || 'user',
      branchId: effectiveBranchId,
      isAdmin: req.user?.role === 'admin',
    };

    const reply = await engine.processUserPrompt(message, history || [], userContext);

    // Generate natural Egyptian Neural Voice audio in parallel
    let audioBase64 = null;
    try {
      const audioBuffer = await tts.synthesizeEgyptianSpeech(reply);
      if (audioBuffer) {
        audioBase64 = audioBuffer.toString('base64');
      }
    } catch (ttsErr) {
      console.warn('[Quaz AI Web API] TTS generation skipped:', ttsErr.message);
    }

    res.json({
      success: true,
      reply,
      audioBase64,
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

    const userContext = {
      id: req.user?.id,
      username: req.user?.username || req.user?.full_name,
      role: req.user?.role || 'user',
      branchId: req.user?.branch_id,
      isAdmin: req.user?.role === 'admin',
    };

    const audioBuffer = Buffer.from(audio, 'base64');
    const reply = await engine.processVoicePrompt(audioBuffer, mimeType || 'audio/webm', '', userContext);

    // Generate natural Egyptian Neural Voice audio
    let audioBase64 = null;
    try {
      const replyAudioBuffer = await tts.synthesizeEgyptianSpeech(reply);
      if (replyAudioBuffer) {
        audioBase64 = replyAudioBuffer.toString('base64');
      }
    } catch (ttsErr) {
      console.warn('[Quaz AI Voice API] TTS generation skipped:', ttsErr.message);
    }

    res.json({
      success: true,
      reply,
      audioBase64,
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
 * POST /api/quaz-ai/tts
 * On-demand Egyptian Neural Speech synthesis
 */
router.post('/tts', async (req, res) => {
  try {
    const { text, voice } = req.body;
    if (!text) {
      return res.status(400).json({ error: 'النص مطلوب' });
    }
    const audioBuffer = await tts.synthesizeEgyptianSpeech(text, voice || 'ar-EG-ShakirNeural');
    if (!audioBuffer) {
      return res.status(500).json({ error: 'فشل إنشاء الصوت' });
    }
    res.json({
      success: true,
      audioBase64: audioBuffer.toString('base64'),
    });
  } catch (error) {
    console.error('[Quaz AI TTS Route] Error:', error);
    res.status(500).json({ error: error.message });
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
