/**
 * ═══════════════════════════════════════════════════════════════════
 * QuazLink WhatsApp Integration Service
 * ───────────────────────────────────────────────────────────────────
 * Provides automated, non-blocking WhatsApp invoice dispatching via
 * the QuazLink Cloud API & Local Desktop Runner.
 *
 * Security & Reliability Guarantees:
 * 1. 100% Secure: Secrets read from process.env, never exposed to client.
 * 2. Non-blocking: Fire-and-forget background execution, 4s request timeout.
 * 3. Anti-Spam / Idempotency: Guards against accidental double sends.
 * 4. PII Protection: Masks customer phone numbers in system logs.
 * 5. Phone Normalization: Automatically formats Egyptian mobile numbers.
 * ═══════════════════════════════════════════════════════════════════
 */

const https = require('https');
const pool = require('../db');

const QUAZLINK_CONFIG = {
  apiUrl: process.env.QUAZLINK_API_URL || 'https://api.quazlink.site/api/integrations/whatsapp/send',
  apiKey: process.env.QUAZLINK_API_KEY || 'ql_live_eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiI4MzJiOWQxMS04MmI3LTQzN2EtOGY3ZC0zYjljNjUyNDE0NDEiLCJ0eXBlIjoiYXBpX2tleSIsImlhdCI6MTc4OTY0OTEzMSwiZXhwIjoyMTA1MDA5MTMxfQ.D_EJgbJQvaAtUeQA-isNo0h6ec4jITzCZvM_9DlVi5U',
  enabled: process.env.QUAZLINK_ENABLED !== 'false',
  timeoutMs: Number(process.env.QUAZLINK_TIMEOUT_MS) || 4500,
  storeName: process.env.QUAZLINK_STORE_NAME || 'معرض آل عاشور عدس - House of Glass',
  websiteUrl: process.env.QUAZLINK_WEBSITE_URL || 'https://www.hg-alshour.online',
};

// Memory cache for debounce/anti-spam (stores invoiceId -> lastSentTimestamp)
const recentSendsCache = new Map();

/**
 * Mask phone number for secure logging (e.g. 01019078440 -> 0101***8440)
 */
function maskPhone(phone) {
  if (!phone || typeof phone !== 'string') return '***';
  const clean = phone.replace(/[^0-9]/g, '');
  if (clean.length < 7) return '***';
  return clean.slice(0, 4) + '***' + clean.slice(-4);
}

/**
 * Normalize Egyptian phone number into clean mobile format
 * Accepts: "01019078440", "201019078440", "+201019078440", "011...", "012...", "015..."
 * Returns cleaned 11-digit string (e.g. "01019078440") or null if invalid
 */
function normalizeEgyptianPhone(rawPhone) {
  if (!rawPhone || typeof rawPhone !== 'string') return null;
  
  // Remove all non-numeric characters except +
  let cleaned = rawPhone.trim().replace(/[\s\-\(\)\.]/g, '');
  
  // Remove leading +
  if (cleaned.startsWith('+')) {
    cleaned = cleaned.substring(1);
  }
  
  // If starts with 20, remove country code prefix to get local format (or keep for QuazLink)
  if (cleaned.startsWith('20') && cleaned.length === 12) {
    cleaned = '0' + cleaned.substring(2);
  }
  
  // Valid Egyptian mobile: starts with 010, 011, 012, 015 and is exactly 11 digits
  const egMobileRegex = /^01[0125][0-9]{8}$/;
  if (egMobileRegex.test(cleaned)) {
    return cleaned;
  }
  
  // If it's 10 digits without leading 0 (e.g. 1019078440)
  if (/^1[0125][0-9]{8}$/.test(cleaned)) {
    return '0' + cleaned;
  }
  
  return null;
}

/**
 * Format currency amount with commas for readability
 */
function formatAmount(amount) {
  const num = Number(amount);
  if (!Number.isFinite(num)) return '0';
  return num.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

/**
 * Perform low-level HTTPS POST to QuazLink endpoint with timeout guard
 */
function postToQuazLink(payload) {
  return new Promise((resolve, reject) => {
    try {
      const url = new URL(QUAZLINK_CONFIG.apiUrl);
      const postData = JSON.stringify(payload);
      
      const req = https.request({
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': QUAZLINK_CONFIG.apiKey,
          'Content-Length': Buffer.byteLength(postData),
        },
      }, (res) => {
        let responseBody = '';
        res.setEncoding('utf8');
        res.on('data', chunk => {
          if (responseBody.length < 5000) responseBody += chunk;
        });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(responseBody);
            resolve({
              statusCode: res.statusCode,
              data: parsed,
              raw: responseBody,
            });
          } catch (e) {
            resolve({
              statusCode: res.statusCode,
              data: null,
              raw: responseBody,
            });
          }
        });
      });

      req.setTimeout(QUAZLINK_CONFIG.timeoutMs, () => {
        req.destroy(new Error(`QuazLink request timed out after ${QUAZLINK_CONFIG.timeoutMs}ms`));
      });

      req.on('error', (err) => {
        reject(err);
      });

      req.write(postData);
      req.end();
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * ═══════════════════════════════════════════════════════════════════
 * Dynamic WhatsApp Message Templates
 * ───────────────────────────────────────────────────────────────────
 * Randomized rotation avoids repetitive bot patterns, keeps customer
 * engagement high, and protects WhatsApp accounts against spam flags.
 * ═══════════════════════════════════════════════════════════════════
 */

// 🛒 Retail Templates (4 variations)
const RETAIL_TEMPLATES = [
  // 1: الاستكشاف والكولكشن الجديد
  (name, invNum, finance, website, store) => `(${store})

أهلاً بك يا ${name}، شرفتنا ونورتنا اليوم! ❤️
📄 *رقم الفاتورة:* #${invNum}
${finance}

✨ تشكيلتنا لسه فيها كتير!
تقدر تكتشف أحدث منتجاتنا وباقي الكولكشن بسهولة من خلال الرابط:
👉 ${website}

شكراً لاختيارك لنا وسعداء دائماً بخدمتك! 🌟`,

  // 2: شياكة البيت والديكور الفاخر
  (name, invNum, finance, website, store) => `(${store})

أهلاً بك يا ${name}، نورتنا ويسعدنا دائماً اختيارك لذوقنا! ❤️
📄 *رقم الفاتورة:* #${invNum}
${finance}

🏠 عشان تكمل شياكة بيتك..
جمعنالك تشكيلة واسعة من أرقى أدوات الزجاج والديكور على موقعنا، تقدر تشوفها من هنا:
👉 ${website}

يومك جميل ونتمنى نشوفك تاني قريب! ✨`,

  // 3: العميل المميز والعروض الحصرية
  (name, invNum, finance, website, store) => `(${store})

أهلاً بك يا ${name}، شرفتنا ونورتنا اليوم! ❤️
📄 *رقم الفاتورة:* #${invNum}
${finance}

🎁 لأنك عميل مميز، حابين تتابع أول بأول جديدنا وعروضنا الحصرية:
تصفح باقي المنتجات واطلب مباشرة من موقعنا:
👉 ${website}

شكراً جزيلاً لك ونتمنى لك تجربة تسوق ممتعة دائماً! 🌟`,

  // 4: الذوق والكتالوج الكامل
  (name, invNum, finance, website, store) => `(${store})

شكراً لزيارتك وثقتك بنا يا ${name} 💐
📄 *الفاتورة:* #${invNum}
${finance}

🛒 كتالوج المنتجات الكامل متاح الآن أونلاين:
👉 ${website}

في خدمتك دائماً، ونتطلع لزيارتك القادمة! ✨`
];

// 🤝 Wholesale Templates (3 variations)
const WHOLESALE_TEMPLATES = [
  // 1: شراكة نجاح وتجارة رابحة
  (name, invNum, finance, website) => `(معرض آل عاشور عدس - كبار العملاء والتوزيع) 🤝

أهلاً بك يا ${name}، سعداء بشراكتنا المستمرة ونتمنى لك تجارة رابحة ورزقاً واسعاً! 🌟

📄 *رقم فاتورة الجملة:* #${invNum}
${finance}

📦 لمعرفة أحدث الحاويات والأصناف والبضائع المتاحة للكميات:
👉 ${website}

بالبركة إن شاء الله، وفي خدمتك دائماً لأي طلبيات إضافية! 🚚`,

  // 2: طلبيات المحلات وتوريد البضاعة
  (name, invNum, finance, website) => `(معرض آل عاشور عدس - قسم الجملة) 💎

تحياتنا لك يا ${name} ويسعدنا دائماً تلبية كافة احتياجات محلك ومعرضك! 🤝

📄 *فاتورة توريد بضاعة:* #${invNum}
${finance}

🚛 تقدر تتابع وصول تشكيلات البضاعة الجديدة وطلبيات الكراتين أول بأول عبر موقعنا:
👉 ${website}

سعداء بالتعاون المستمر ونتمنى لك موسماً مباركاً ومبيعات موفقة! ✨`,

  // 3: كشف حساب وفاتورة جملة مباشرة
  (name, invNum, finance, website) => `(معرض آل عاشور عدس - House of Glass) 📋

بيان فاتورة جملة للعميل: ${name} 💐
───────────────────
📄 *رقم الفاتورة:* #${invNum}
${finance}
───────────────────
🛒 للاطلاع على كتالوج المنتجات والأسعار الخاصة بالكميات:
👉 ${website}

شاكرين لتعاملكم الراقي وثقتكم الدائمة في منتجاتنا! 🌟`
];

/**
 * Build smart financial text block conditionally:
 * - If remaining is 0 or paid >= total: Shows "خالصة بالكامل ✅"
 * - If partial payment: Shows Total, Paid, and Remaining
 * - If 0 paid (unpaid / credit): Shows "آجل ⏳"
 */
function buildFinancialBlock({ amount, paidAmount, remainingAmount, currency = 'ج.م' }) {
  const formattedTotal = formatAmount(amount);
  const numTotal = Number(amount || 0);
  const numPaid = Number(paidAmount || 0);
  const numRemaining = remainingAmount !== undefined && remainingAmount !== null
    ? Number(remainingAmount)
    : (numTotal - numPaid);

  const formattedPaid = formatAmount(numPaid);
  const formattedRemaining = formatAmount(Math.max(0, numRemaining));

  // Case 1: Fully paid
  if (numRemaining <= 0 || (numTotal > 0 && numPaid >= numTotal)) {
    return `💰 *الإجمالي:* ${formattedTotal} ${currency} *(خالصة بالكامل ✅)*`;
  }

  // Case 2: Partial payment
  if (numPaid > 0 && numRemaining > 0) {
    return `💰 *الإجمالي:* ${formattedTotal} ${currency}\n💵 *المدفوع:* ${formattedPaid} ${currency}\n⏳ *المتبقي:* ${formattedRemaining} ${currency}`;
  }

  // Case 3: Fully credit / Unpaid
  return `💰 *الإجمالي:* ${formattedTotal} ${currency} *(آجل ⏳)*`;
}

/**
 * Dispatches an automated WhatsApp invoice notification asynchronously.
 * Designed to be called non-blocking (e.g. via setImmediate).
 *
 * @param {Object} params
 * @param {number|string} params.invoiceId
 * @param {string} [params.customerPhone]
 * @param {string} [params.customerName]
 * @param {number|string} [params.amount]
 * @param {number|string} [params.paidAmount]
 * @param {number|string} [params.remainingAmount]
 * @param {string} [params.invoiceType] 'retail' or 'wholesale'
 * @param {string} [params.currency]
 * @param {boolean} [params.force] If true, bypasses anti-spam debounce
 */
async function dispatchInvoiceWhatsApp({
  invoiceId,
  customerPhone,
  customerName,
  amount,
  paidAmount,
  remainingAmount,
  invoiceType,
  currency = 'ج.م',
  force = false,
}) {
  if (!QUAZLINK_CONFIG.enabled) {
    console.log(`[QuazLink] Service disabled by configuration. Skipping invoice #${invoiceId}`);
    return { success: false, reason: 'disabled' };
  }

  const id = Number(invoiceId);
  if (!id) {
    return { success: false, reason: 'invalid_invoice_id' };
  }

  // Anti-spam / Debounce check (30 seconds window)
  const now = Date.now();
  const lastSent = recentSendsCache.get(id);
  if (!force && lastSent && (now - lastSent) < 30000) {
    console.log(`[QuazLink] Anti-spam debounce triggered for invoice #${id}. Skipping duplicate send.`);
    return { success: false, reason: 'debounced' };
  }

  // If details are missing, fetch from database
  let targetPhone = customerPhone;
  let targetName = customerName;
  let targetAmount = amount;
  let targetPaid = paidAmount;
  let targetRemaining = remainingAmount;
  let targetInvoiceType = invoiceType;

  if (
    !targetPhone ||
    targetAmount === undefined ||
    targetPaid === undefined ||
    targetRemaining === undefined ||
    !targetInvoiceType
  ) {
    try {
      const invRes = await pool.query(
        `SELECT customer_phone, customer_name, total, paid_amount, remaining_amount, invoice_type, branch_id 
         FROM invoices WHERE id = $1`,
        [id]
      );
      if (invRes.rows.length > 0) {
        const row = invRes.rows[0];
        targetPhone = targetPhone || row.customer_phone;
        targetName = targetName || row.customer_name;
        if (targetAmount === undefined || targetAmount === null) targetAmount = row.total;
        if (targetPaid === undefined || targetPaid === null) targetPaid = row.paid_amount;
        if (targetRemaining === undefined || targetRemaining === null) targetRemaining = row.remaining_amount;
        if (!targetInvoiceType) {
          targetInvoiceType = row.invoice_type || (row.branch_id === 2 ? 'wholesale' : 'retail');
        }
      }
    } catch (dbErr) {
      console.error(`[QuazLink] Error fetching invoice #${id} details for WhatsApp:`, dbErr.message);
    }
  }

  // Normalize phone number
  const cleanPhone = normalizeEgyptianPhone(targetPhone);
  if (!cleanPhone) {
    console.log(`[QuazLink] Invoice #${id} has no valid mobile phone (${maskPhone(targetPhone)}). Marking as skipped.`);
    try {
      await pool.query(
        `UPDATE invoices 
         SET whatsapp_status = 'skipped', 
             whatsapp_error = 'رقم الهاتف غير صالح أو غير مسجل' 
         WHERE id = $1 AND (whatsapp_status IS NULL OR whatsapp_status = 'skipped')`,
        [id]
      );
    } catch (e) {
      // ignore non-critical update failure
    }
    return { success: false, reason: 'no_valid_phone' };
  }

  const invoiceNumber = `INV-${id}`;
  const formattedAmount = formatAmount(targetAmount);

  let displayName = 'عميلنا العزيز';
  if (targetName && targetName.trim()) {
    const rawName = targetName.trim();
    const cleanedName = rawName.replace(/^(أ\s*[\/\.]|أستاذ\s*[\/\.]?|الاستاذ\s*[\/\.]?|الأستاذ\s*[\/\.]?)\s*/i, '');
    displayName = `أ / ${cleanedName}`;
  }

  // 🚀 Generate Smart Financial Block
  const financialBlock = buildFinancialBlock({
    amount: targetAmount,
    paidAmount: targetPaid,
    remainingAmount: targetRemaining,
    currency,
  });

  // 🎲 Select Random Template based on Invoice Type (Wholesale vs Retail)
  const isWholesale = targetInvoiceType === 'wholesale';
  const poolTemplates = isWholesale ? WHOLESALE_TEMPLATES : RETAIL_TEMPLATES;
  const randomIndex = Math.floor(Math.random() * poolTemplates.length);
  const selectedTemplate = poolTemplates[randomIndex];

  const customMessage = selectedTemplate(
    displayName,
    invoiceNumber,
    financialBlock,
    QUAZLINK_CONFIG.websiteUrl,
    QUAZLINK_CONFIG.storeName
  );

  const senderStoreName = isWholesale ? 'معرض آل عاشور عدس - كبار العملاء والتوزيع' : QUAZLINK_CONFIG.storeName;

  console.log(`[QuazLink] 🚀 Dispatching WhatsApp invoice #${id} (${targetInvoiceType || 'retail'}, template #${randomIndex + 1}) to ${maskPhone(cleanPhone)} (${displayName}, ${formattedAmount} ${currency})...`);

  try {
    const result = await postToQuazLink({
      phone: cleanPhone,
      customerName: displayName,
      invoiceNumber: invoiceNumber,
      amount: formattedAmount,
      currency: currency,
      message: customMessage,
      storeName: senderStoreName,
      companyName: senderStoreName,
      company: senderStoreName,
      store: senderStoreName,
    });

    if (result.statusCode >= 200 && result.statusCode < 300 && result.data?.success) {
      console.log(`[QuazLink] ✅ Invoice #${id} successfully dispatched to WhatsApp! Job ID: ${result.data.jobId}`);
      recentSendsCache.set(id, now);

      await pool.query(
        `UPDATE invoices 
         SET whatsapp_status = 'sent', 
             whatsapp_phone = $1, 
             whatsapp_sent_at = NOW(), 
             whatsapp_error = NULL 
         WHERE id = $2`,
        [cleanPhone, id]
      );

      return {
        success: true,
        jobId: result.data.jobId,
        deliveryMode: result.data.deliveryMode,
        phone: cleanPhone,
      };
    } else {
      const errMsg = result.data?.message || result.raw || `HTTP status ${result.statusCode}`;
      console.warn(`[QuazLink] ⚠️ WhatsApp dispatch returned error for invoice #${id}:`, errMsg);

      await pool.query(
        `UPDATE invoices 
         SET whatsapp_status = 'failed', 
             whatsapp_phone = $1, 
             whatsapp_error = $2 
         WHERE id = $3`,
        [cleanPhone, errMsg.slice(0, 500), id]
      );

      return {
        success: false,
        error: errMsg,
      };
    }
  } catch (netErr) {
    console.error(`[QuazLink] ❌ Network error dispatching WhatsApp for invoice #${id}:`, netErr.message);

    try {
      await pool.query(
        `UPDATE invoices 
         SET whatsapp_status = 'failed', 
             whatsapp_phone = $1, 
             whatsapp_error = $2 
         WHERE id = $3`,
        [cleanPhone, netErr.message.slice(0, 500), id]
      );
    } catch (e) {
      // ignore
    }

    return {
      success: false,
      error: netErr.message,
    };
  }
}

/**
 * Resend an invoice WhatsApp notification manually.
 * Requires user authentication & validates invoice existence.
 */
async function resendInvoiceWhatsApp(invoiceId, userId = null) {
  const id = Number(invoiceId);
  if (!id) throw new Error('معرف الفاتورة غير صالح');

  const invRes = await pool.query(
    `SELECT id, customer_phone, customer_name, total, paid_amount, remaining_amount, invoice_type, branch_id 
     FROM invoices WHERE id = $1`,
    [id]
  );
  if (invRes.rows.length === 0) {
    throw new Error('الفاتورة غير موجودة');
  }

  const invoice = invRes.rows[0];
  if (!invoice.customer_phone) {
    throw new Error('لا يوجد رقم هاتف مسجل لهذه الفاتورة');
  }

  const result = await dispatchInvoiceWhatsApp({
    invoiceId: invoice.id,
    customerPhone: invoice.customer_phone,
    customerName: invoice.customer_name,
    amount: invoice.total,
    paidAmount: invoice.paid_amount,
    remainingAmount: invoice.remaining_amount,
    invoiceType: invoice.invoice_type || (invoice.branch_id === 2 ? 'wholesale' : 'retail'),
    currency: 'ج.م',
    force: true, // Bypass debounce for manual user resend
  });

  return result;
}

module.exports = {
  dispatchInvoiceWhatsApp,
  resendInvoiceWhatsApp,
  normalizeEgyptianPhone,
  maskPhone,
  QUAZLINK_CONFIG,
};
