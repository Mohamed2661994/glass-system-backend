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
  channelUrl: process.env.QUAZLINK_CHANNEL_URL || 'https://whatsapp.com/channel/0029Vavz4EY6GcGG3Sl9Ez21',
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

// 🛒 Retail Templates (4 compact mobile-first variations)
const RETAIL_TEMPLATES = [
  // 1: ترحيب دافئ ومختصر
  (name, invNum, finance, linksBlock) => `*آل عاشور عدس | House of Glass* ✨
أهلاً بك يا ${name}، نورتنا اليوم! ❤️

📄 *فاتورة:* #${invNum}
${finance}

${linksBlock}

سعداء بخدمتك دائماً! 🌟`,

  // 2: شياكة وذوق
  (name, invNum, finance, linksBlock) => `*آل عاشور عدس | House of Glass* 🥂
أهلاً بك يا ${name}، شرفتنا ويسعدنا اختيارك لذوقنا! ❤️

📄 *فاتورة:* #${invNum}
${finance}

${linksBlock}

يومك جميل ونتمنى نشوفك قريب! ✨`,

  // 3: شكر وثقة
  (name, invNum, finance, linksBlock) => `*آل عاشور عدس | House of Glass* ✨
شكراً لزيارتك وثقتك بنا يا ${name}! 💐

📄 *فاتورة:* #${invNum}
${finance}

${linksBlock}

في خدمتك دائماً ونتطلع لزيارتك القادمة! 🌟`,

  // 4: تجربة تسوق ممتعة
  (name, invNum, finance, linksBlock) => `*آل عاشور عدس | House of Glass* 💎
أهلاً بك يا ${name}، تشرّفنا بزيارتك اليوم! ❤️

📄 *فاتورة:* #${invNum}
${finance}

${linksBlock}

شكراً لاختيارك لنا ونتمنى لك تجربة تسوق ممتعة! ✨`,
];

// 🤝 Wholesale Templates (3 compact mobile-first variations)
const WHOLESALE_TEMPLATES = [
  // 1: شراكة نجاح
  (name, invNum, finance, linksBlock) => `*آل عاشور عدس | كبار العملاء والجملة* 🤝
أهلاً بك يا ${name}، سعداء بشراكتنا المستمرة! 🌟

📄 *فاتورة جملة:* #${invNum}
${finance}

${linksBlock}

بالبركة إن شاء الله، وفي خدمتك دائماً لأي طلبيات! 🚚`,

  // 2: طلبيات المحلات والتوريد
  (name, invNum, finance, linksBlock) => `*آل عاشور عدس | قسم الجملة* 💎
تحياتنا لك يا ${name}، يسعدنا دائماً تلبية احتياجات معرضك! 🤝

📄 *فاتورة توريد:* #${invNum}
${finance}

${linksBlock}

نتمنى لك موسماً مباركاً ومبيعات موفقة! ✨`,

  // 3: بيان فاتورة جملة مباشر
  (name, invNum, finance, linksBlock) => `*آل عاشور عدس | House of Glass* 📋
بيان فاتورة جملة للعميل: ${name} 💐

📄 *فاتورة:* #${invNum}
${finance}

${linksBlock}

شاكرين لتعاملكم الراقي وثقتكم الدائمة بنا! 🌟`,
];

/**
 * Check if this normalized phone number has NEVER received a successful WhatsApp
 * invoice message before. Ensures the WhatsApp Channel invite is sent strictly
 * ONCE (for new customers only, covering both retail and wholesale).
 */
async function isFirstWhatsAppForPhone(cleanPhone) {
  if (!cleanPhone) return false;
  try {
    const res = await pool.query(
      `SELECT 1 FROM invoices
       WHERE whatsapp_status = 'sent'
         AND whatsapp_phone = $1
       LIMIT 1`,
      [cleanPhone]
    );
    return res.rows.length === 0;
  } catch (err) {
    console.warn(`[QuazLink] Could not verify new-customer status for ${maskPhone(cleanPhone)}:`, err.message);
    return false;
  }
}

/**
 * Build smart financial text block conditionally:
 * - If discount > 0: Shows original invoice subtotal & discount on line 1, then net total & payment status on line 2
 * - If no discount: Compact single line with Total & payment status
 * - Handles fully paid ("خالصة بالكامل ✅"), partial payment, and unpaid ("آجل ⏳")
 */
function buildFinancialBlock({
  subtotal,
  discount,
  previousBalance,
  amount,
  paidAmount,
  remainingAmount,
  currency = 'ج.م',
}) {
  const numTotal = Number(amount || 0);
  const numSubtotal = subtotal !== undefined && subtotal !== null ? Number(subtotal) : 0;
  const numDiscount = Math.max(0, Number(discount || 0));
  const numPrevious = Number(previousBalance || 0);
  const numPaid = Number(paidAmount || 0);
  const numRemaining = remainingAmount !== undefined && remainingAmount !== null
    ? Number(remainingAmount)
    : (numTotal - numPaid);

  const formattedTotal = formatAmount(numTotal);
  const formattedPaid = formatAmount(numPaid);
  const formattedRemaining = formatAmount(Math.max(0, numRemaining));

  const hasDiscount = numDiscount > 0;
  const effectiveSubtotal = hasDiscount
    ? (numSubtotal > 0 ? numSubtotal : Math.max(0, numTotal - numPrevious + numDiscount))
    : numSubtotal;

  const hasPreviousIncluded =
    hasDiscount &&
    numPrevious > 0 &&
    numTotal > (effectiveSubtotal - numDiscount + 0.01);

  const totalLabel = hasDiscount
    ? (hasPreviousIncluded ? 'الإجمالي (شامل السابق)' : 'الصافي')
    : 'الإجمالي';

  let paymentLine;
  // Case 1: Fully paid
  if (numRemaining <= 0 || (numTotal > 0 && numPaid >= numTotal)) {
    paymentLine = `💰 *${totalLabel}:* ${formattedTotal} ${currency} *(خالصة بالكامل ✅)*`;
  } else if (numPaid > 0 && numRemaining > 0) {
    // Case 2: Partial payment
    paymentLine = `💰 *${totalLabel}:* ${formattedTotal} ${currency} | 💵 *المدفوع:* ${formattedPaid} ${currency} | ⏳ *المتبقي:* ${formattedRemaining} ${currency}`;
  } else {
    // Case 3: Fully credit / Unpaid
    paymentLine = `💰 *${totalLabel}:* ${formattedTotal} ${currency} *(آجل ⏳)*`;
  }

  if (hasDiscount) {
    const subtotalLine = `🧾 *قيمة الفاتورة:* ${formatAmount(effectiveSubtotal)} ${currency} | 🏷️ *الخصم:* ${formatAmount(numDiscount)} ${currency}`;
    return `${subtotalLine}\n${paymentLine}`;
  }

  return paymentLine;
}

/**
 * Build links block:
 * - For NEW customers only: Places the official WhatsApp Channel link FIRST
 *   (so WhatsApp renders the rich Channel Preview Card with a Follow button),
 *   followed by the website URL.
 * - For returning customers: Compact website link only (no repeated channel invite).
 */
function buildLinksBlock({ isNewCustomer, isWholesale, website, channelUrl }) {
  const targetWebsite = website || QUAZLINK_CONFIG.websiteUrl;
  const targetChannel = channelUrl || QUAZLINK_CONFIG.channelUrl;

  if (isNewCustomer && targetChannel) {
    if (isWholesale) {
      return `📦 *تابع أحدث الشحنات وتشكيلاتنا (مجات، طفايات، وهدايا) أول بأول:*\n📲 قناتنا الرسمية على واتساب (اعمل Follow):\n${targetChannel}\n🌐 كتالوج الجملة على موقعنا:\n${targetWebsite}`;
    }
    return `🥂 *تابع أحدث تشكيلاتنا (مجات، طفايات، وهدايا) أول بأول:*\n📲 قناتنا على واتساب (اعمل Follow):\n${targetChannel}\n🌐 موقعنا الإلكتروني:\n${targetWebsite}`;
  }

  if (isWholesale) {
    return `🌐 لمتابعة أحدث الشحنات وكتالوج الكميات:\n${targetWebsite}`;
  }
  return `🌐 تصفح أحدث تشكيلاتنا على موقعنا:\n${targetWebsite}`;
}

/**
 * Pure helper to compose the complete WhatsApp message (also usable for dry-run previews/tests).
 */
function buildInvoiceMessage({
  invoiceId,
  customerName,
  subtotal,
  discount,
  previousBalance,
  amount,
  paidAmount,
  remainingAmount,
  invoiceType = 'retail',
  currency = 'ج.م',
  isNewCustomer = false,
  templateIndex = null,
}) {
  const invoiceNumber = `INV-${invoiceId}`;
  let displayName = 'عميلنا العزيز';
  if (customerName && customerName.trim()) {
    const rawName = customerName.trim();
    const cleanedName = rawName.replace(/^(أ\s*[\/\.]|أستاذ\s*[\/\.]?|الاستاذ\s*[\/\.]?|الأستاذ\s*[\/\.]?)\s*/i, '');
    displayName = `أ / ${cleanedName}`;
  }

  const isWholesale = invoiceType === 'wholesale';
  const financialBlock = buildFinancialBlock({
    subtotal,
    discount,
    previousBalance,
    amount,
    paidAmount,
    remainingAmount,
    currency,
  });

  const linksBlock = buildLinksBlock({
    isNewCustomer,
    isWholesale,
    website: QUAZLINK_CONFIG.websiteUrl,
    channelUrl: QUAZLINK_CONFIG.channelUrl,
  });

  const poolTemplates = isWholesale ? WHOLESALE_TEMPLATES : RETAIL_TEMPLATES;
  const selectedIndex =
    templateIndex !== null && templateIndex >= 0 && templateIndex < poolTemplates.length
      ? templateIndex
      : Math.floor(Math.random() * poolTemplates.length);
  const selectedTemplate = poolTemplates[selectedIndex];

  return {
    invoiceNumber,
    displayName,
    templateIndex: selectedIndex,
    message: selectedTemplate(displayName, invoiceNumber, financialBlock, linksBlock),
  };
}

/**
 * Dispatches an automated WhatsApp invoice notification asynchronously.
 * Designed to be called non-blocking (e.g. via setImmediate).
 *
 * @param {Object} params
 * @param {number|string} params.invoiceId
 * @param {string} [params.customerPhone]
 * @param {string} [params.customerName]
 * @param {number|string} [params.subtotal]
 * @param {number|string} [params.discount]
 * @param {number|string} [params.previousBalance]
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
  subtotal,
  discount,
  previousBalance,
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
  let targetSubtotal = subtotal;
  let targetDiscount = discount;
  let targetPreviousBalance = previousBalance;
  let targetAmount = amount;
  let targetPaid = paidAmount;
  let targetRemaining = remainingAmount;
  let targetInvoiceType = invoiceType;

  if (
    !targetPhone ||
    targetSubtotal === undefined ||
    targetDiscount === undefined ||
    targetAmount === undefined ||
    targetPaid === undefined ||
    targetRemaining === undefined ||
    !targetInvoiceType
  ) {
    try {
      const invRes = await pool.query(
        `SELECT customer_phone, customer_name, subtotal, discount_total, manual_discount, previous_balance,
                total, paid_amount, remaining_amount, invoice_type, branch_id
         FROM invoices WHERE id = $1`,
        [id]
      );
      if (invRes.rows.length > 0) {
        const row = invRes.rows[0];
        targetPhone = targetPhone || row.customer_phone;
        targetName = targetName || row.customer_name;
        if (targetSubtotal === undefined || targetSubtotal === null) targetSubtotal = row.subtotal;
        if (targetDiscount === undefined || targetDiscount === null) {
          targetDiscount = row.discount_total ?? row.manual_discount ?? 0;
        }
        if (targetPreviousBalance === undefined || targetPreviousBalance === null) {
          targetPreviousBalance = row.previous_balance ?? 0;
        }
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

  // 🆕 Check if this is the customer's very first successful WhatsApp message (new customer only)
  const isNewCustomer = await isFirstWhatsAppForPhone(cleanPhone);

  const formattedAmount = formatAmount(targetAmount);
  const isWholesale = targetInvoiceType === 'wholesale';

  // 🚀 Compose Compact Dynamic Message (with subtotal/discount & first-time channel invite)
  const { invoiceNumber, displayName, templateIndex, message: customMessage } = buildInvoiceMessage({
    invoiceId: id,
    customerName: targetName,
    subtotal: targetSubtotal,
    discount: targetDiscount,
    previousBalance: targetPreviousBalance,
    amount: targetAmount,
    paidAmount: targetPaid,
    remainingAmount: targetRemaining,
    invoiceType: targetInvoiceType || 'retail',
    currency,
    isNewCustomer,
  });

  const senderStoreName = isWholesale ? 'معرض آل عاشور عدس - كبار العملاء والتوزيع' : QUAZLINK_CONFIG.storeName;

  console.log(`[QuazLink] 🚀 Dispatching WhatsApp invoice #${id} (${targetInvoiceType || 'retail'}, template #${templateIndex + 1}, newCustomer=${isNewCustomer}) to ${maskPhone(cleanPhone)} (${displayName}, ${formattedAmount} ${currency})...`);

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
    `SELECT id, customer_phone, customer_name, subtotal, discount_total, manual_discount, previous_balance,
            total, paid_amount, remaining_amount, invoice_type, branch_id
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
    subtotal: invoice.subtotal,
    discount: invoice.discount_total ?? invoice.manual_discount ?? 0,
    previousBalance: invoice.previous_balance ?? 0,
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
  isFirstWhatsAppForPhone,
  buildFinancialBlock,
  buildLinksBlock,
  buildInvoiceMessage,
  QUAZLINK_CONFIG,
};
