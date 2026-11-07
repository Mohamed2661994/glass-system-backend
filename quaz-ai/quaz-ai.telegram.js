/**
 * ═══════════════════════════════════════════════════════════════════
 * Quaz AI - Telegram Bot Gateway (Webhook & Long-Polling Engine)
 * ───────────────────────────────────────────────────────────────────
 * Provides secure Telegram communication with instant Webhook delivery,
 * audio voice note understanding, and strict admin whitelisting.
 * ═══════════════════════════════════════════════════════════════════
 */

const https = require('https');
const config = require('./quaz-ai.config');
const engine = require('./quaz-ai.engine');

const TELEGRAM_KEYBOARD = {
  keyboard: [
    [{ text: '💰 نقدية الخزينة اليوم' }, { text: '📊 مبيعات وأرباح اليوم' }],
    [{ text: '🔥 راكد المخزن للعروض' }, { text: '⚠️ نواقص المخزن الحرجة' }],
    [{ text: '👥 سلفيات ورواتب العمال' }, { text: '📋 كشف ديون الموردين' }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};

/**
 * Make low-level HTTPS request to Telegram Bot API
 */
function telegramApi(endpoint, payload = null) {
  return new Promise((resolve, reject) => {
    const postData = payload ? JSON.stringify(payload) : null;
    const token = config.telegramBotToken;

    const req = https.request({
      hostname: 'api.telegram.org',
      port: 443,
      path: `/bot${token}/${endpoint}`,
      method: payload ? 'POST' : 'GET',
      headers: postData ? {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
      } : {},
      timeout: 30000,
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (parsed.ok) {
            resolve(parsed.result);
          } else {
            reject(new Error(parsed.description || `Telegram Error ${parsed.error_code}`));
          }
        } catch (e) {
          reject(new Error(`Failed to parse Telegram response: ${e.message}`));
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Telegram request timed out'));
    });

    req.on('error', err => reject(err));
    if (postData) req.write(postData);
    req.end();
  });
}

/**
 * Send text message with Markdown formatting and reply keyboard
 */
async function sendTelegramMessage(chatId, text, options = {}) {
  try {
    return await telegramApi('sendMessage', {
      chat_id: chatId,
      text: text,
      parse_mode: options.parseMode || 'Markdown',
      reply_markup: options.replyMarkup || TELEGRAM_KEYBOARD,
    });
  } catch (err) {
    if (err.message && err.message.includes('can\'t parse entities')) {
      return await telegramApi('sendMessage', {
        chat_id: chatId,
        text: text,
        reply_markup: options.replyMarkup || TELEGRAM_KEYBOARD,
      });
    }
    console.error('[Quaz AI Telegram] SendMessage error:', err.message);
  }
}

/**
 * Send chat action (e.g. typing)
 */
async function sendChatAction(chatId, action = 'typing') {
  try {
    await telegramApi('sendChatAction', { chat_id: chatId, action });
  } catch (e) {
    // ignore
  }
}

/**
 * Download file buffer from Telegram
 */
function downloadTelegramFile(filePath) {
  return new Promise((resolve, reject) => {
    const token = config.telegramBotToken;
    const url = `https://api.telegram.org/file/bot${token}/${filePath}`;

    https.get(url, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', err => reject(err));
    }).on('error', err => reject(err));
  });
}

/**
 * Handle incoming Telegram message from either Webhook or Polling
 */
async function handleTelegramMessage(message) {
  if (!message || !message.chat) return;

  const chatId = String(message.chat.id);
  const adminChatId = String(config.telegramAdminChatId);

  // 🛡️ Strict Whitelisting: ONLY the authorized admin can use this bot
  if (chatId !== adminChatId) {
    console.warn(`[Quaz AI Telegram] ⛔ Unauthorized access attempt from Chat ID: ${chatId} (${message.from?.username || message.from?.first_name})`);
    await sendTelegramMessage(chatId, '⛔ عذراً! هذا البوت خاص بالإدارة العليا لنظام House of Glass فقط.\nالوصول غير مصرح.');
    return;
  }

  // Handle /start or /help
  const text = message.text ? message.text.trim() : '';
  if (text === '/start' || text === '/help') {
    const welcome = `👋 *أهلاً بك يا أستاذ خالد في Quaz AI!*

أنا مساعدك الذكي المباشر المربوط بنظام *House of Glass*.
تقدر تسألني بالكتابة أو تبعتلي *رسالة صوتية* في أي وقت، أو تستخدم الأزرار السريعة أدناه:

💰 *نقدية الخزينة اليوم*
📊 *مبيعات وأرباح اليوم*
🔥 *راكد المخزن للعروض*
⚠️ *نواقص المخزن الحرجة*
👥 *سلفيات ورواتب العمال*
📋 *كشف ديون الموردين*

أنا في خدمتك لحظة بلحظة! 🚀`;

    await sendTelegramMessage(chatId, welcome);
    return;
  }

  // Show "typing..." status while processing
  await sendChatAction(chatId, 'typing');

  // Case 1: Voice Note or Audio Message
  const audioMsg = message.voice || message.audio;
  if (audioMsg) {
    try {
      await sendChatAction(chatId, 'record_voice');
      const fileInfo = await telegramApi('getFile', { file_id: audioMsg.file_id });
      if (fileInfo && fileInfo.file_path) {
        const audioBuffer = await downloadTelegramFile(fileInfo.file_path);
        const mimeType = audioMsg.mime_type || (message.voice ? 'audio/ogg' : 'audio/mp3');
        const caption = message.caption ? `ملاحظة إضافية مع الصوت: ${message.caption}` : '';
        const reply = await engine.processVoicePrompt(audioBuffer, mimeType, caption);
        await sendTelegramMessage(chatId, reply);
        return;
      }
    } catch (voiceErr) {
      console.error('[Quaz AI Telegram] Voice error:', voiceErr);
      await sendTelegramMessage(chatId, `⚠️ حدث خطأ في معالجة الرسالة الصوتية: ${voiceErr.message}`);
      return;
    }
  }

  // Case 2: Text Message or Quick Button
  if (text) {
    let promptToProcess = text;

    // Map Quick Buttons to natural prompts
    if (text === '💰 نقدية الخزينة اليوم') {
      promptToProcess = 'اعرض لي ملخص حركة نقدية الخزينة والدرج لليوم في المعرض والمخزن';
    } else if (text === '📊 مبيعات وأرباح اليوم') {
      promptToProcess = 'اعرض لي ملخص مبيعات اليوم وعدد الفواتير وصافي الأرباح التقديرية ونسبة الهامش';
    } else if (text === '🔥 راكد المخزن للعروض') {
      promptToProcess = 'اعرض لي عينة من الأصناف الراكدة التي لها رصيد فعلي بالمخزن ورأس المال المجمد واقترح لي عروض عليها';
    } else if (text === '⚠️ نواقص المخزن الحرجة') {
      promptToProcess = 'اعرض لي الأصناف التي نفذت من المخزن أو رصيدها حرج أقل من 5 قطع';
    } else if (text === '👥 سلفيات ورواتب العمال') {
      promptToProcess = 'اعرض لي كشف رواتب وسلفيات العمال النشطين في الفروع';
    } else if (text === '📋 كشف ديون الموردين') {
      promptToProcess = 'اعرض لي كشف المديونيات المستحقة للموردين والمبالغ المتبقية';
    }

    try {
      const responseText = await engine.processUserPrompt(promptToProcess);
      await sendTelegramMessage(chatId, responseText);
    } catch (err) {
      console.error('[Quaz AI Telegram] Processing error:', err);
      await sendTelegramMessage(chatId, `⚠️ حدث خطأ أثناء إعداد الإجابة: ${err.message}`);
    }
  }
}

/**
 * Configure Telegram Webhook (Enterprise Instant Delivery)
 */
async function setupTelegramWebhook() {
  if (!config.telegramBotToken) return;

  const webhookUrl = `${config.publicUrl.replace(/\/$/, '')}/api/quaz-ai/telegram/webhook`;
  console.log(`[Quaz AI Telegram] 🔗 Registering Webhook at: ${webhookUrl}...`);

  try {
    const result = await telegramApi('setWebhook', {
      url: webhookUrl,
      secret_token: config.telegramWebhookSecret,
      allowed_updates: ['message'],
      drop_pending_updates: true,
    });
    console.log('[Quaz AI Telegram] ✅ Webhook registered successfully with Telegram!', result);
  } catch (err) {
    console.error('[Quaz AI Telegram] ⚠️ Failed to set Webhook:', err.message);
  }
}

module.exports = {
  setupTelegramWebhook,
  handleTelegramMessage,
  sendTelegramMessage,
  sendChatAction,
};
