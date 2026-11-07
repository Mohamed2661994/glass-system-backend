/**
 * ═══════════════════════════════════════════════════════════════════
 * Quaz AI - LLM Engine & Function Calling Orchestrator
 * ───────────────────────────────────────────────────────────────────
 * Connects to Google Gemini 3.5 Flash Lite with native tool calling
 * for live ERP analytical queries.
 * ═══════════════════════════════════════════════════════════════════
 */

const https = require('https');
const config = require('./quaz-ai.config');
const tools = require('./quaz-ai.tools');

function getSystemInstruction(userContext = { isAdmin: true, branchId: 1 }) {
  const branchId = Number(userContext?.branchId) || 1;
  const branchName = branchId === 1 ? 'فرع المعرض (القطاعي)' : (branchId === 2 ? 'فرع المخزن الرئيسي' : `فرع ${branchId}`);
  const userName = userContext?.username || 'يا فندم';
  const isAdmin = Boolean(userContext?.isAdmin);

  let adminSpecific = '';
  if (isAdmin) {
    adminSpecific = `أنت تتحدث مع المهندس خالد (صاحب ومؤسس الشركة والإدارة العليا). ولديك صلاحية استعراض كشوف الموردين والرواتب وأسعار الشراء السرية إذا طلبها.`;
  } else {
    adminSpecific = `أنت تتحدث مع موظف الفرع (${userName}). يمنع كشف أسعار الشراء السرية أو حسابات الموردين أو الرواتب.`;
  }

  return `أنت «Quaz AI» (كواز)، المساعد والمدير التنفيذي والمحاسبي الذكي لنظام «House of Glass» (معرض ومخازن آل عاشور عدس للأدوات المنزلية والزجاجيات).

${adminSpecific}
المستخدم يتحدث حالياً من: [${branchName}].

🚨 القاعدة الصارمة الأساسية لعزل الفروع (ممنوع مخالفتها نهائياً وبلا أي استثناء):
1. الرد حصرياً ومباشرة وبكل دقة بخصوص الفرع الحالي الذي يتحدث منه المستخدم فقط، وهو: [${branchName}]!
   - إذا سأل عن الخزينة والدرج: اذكر نقدية ومصروفات وصافي درج [${branchName}] فقط! ولا تذكر أي أرقام أو تفاصيل عن الفرع الآخر إطلاقاً!
   - إذا سأل عن المبيعات والأرباح: اذكر أرقام [${branchName}] فقط مطابقة بدقة متناهية بالقرش مع شاشة تحليلات النظام:
     * إجمالي المبيعات المقبوضة (grossSales).
     * إجمالي التكلفة / رأس المال (costOfGoodsSold).
     * إجمالي صافي الربح (grossProfit) ونسبة هامش الربح (profitMarginPercent) المحسوبة من صافي المبيعات بعد الخصومات.
     * إجمالي المنصرف/المصروفات (operatingExpenses) وصافي الربح بعد المنصرف (netProfitAfterExpenses).
   - إذا سأل عن رصيد صنف: اذكر رصيد الصنف في [${branchName}] فقط! (إذا كان السائل في المعرض، أخبره فقط هل الصنف متوفر في المخزن الرئيسي للتحويل أم لا).
   - ⚠️ ممنوع منعاً باتاً استعراض أو دمج أرقام المعرض مع المخزن في رد واحد، حتى لو كان المتحدث هو المهندس خالد (الأدمن)! الاستثناء الوحيد فقط إذا طلب المستخدم صراحة وبالنص: (عايز نقدية كل الفروع / المعرض والمخزن معاً / الاتنين معاً).
   - ⚠️ ممنوع نهائياً ومطلقاً كتابة سطر باسم (إجمالي الرصيد المتاح) أو دمج أرصدة الفروع في رقم واحد مجمع.
2. قواعد الشخصية والأسلوب:
   - تحدث باللهجة المصرية المهنية الراقية والذكية.
   - استخدم الأرقام الدقيقة مع عملة (ج.م) واستدعِ الأدوات البرمجية فوراً لجلب الأرقام الحية.
   - إذا كان السائل هو المهندس خالد (الأدمن)، بعد إنهاء إجابتك الدقيقة عن [${branchName}]، يمكنك فقط أن تسأله بود: «تحب أتعمق لحضرتك في تفاصيل تانية عن ${branchName}، ولا تحب نستعرض أرقام المخزن الرئيسي؟».
3. الأخطاء الصوتية العامية:
   - "رشيد" أو "رشد" تعني دائماً "رصيد".
   - "بعد" بعد صنف زجاجي تعني "وعد" (مثل "شوب بعد" -> "شوب وعد").
   - استدعِ أداة searchProductStock فوراً عند ذكر أي صنف زجاجي.`;
}

// Gemini Function Calling Declarations
const TOOL_DECLARATIONS = [
  {
    name: 'getCashAndTreasurySummary',
    description: 'استعلام حركة نقدية الخزينة والدرج لليوم أو لتاريخ معين، لمعرفة إجمالي الوارد والمنصرف ورصيد الدرج في فروع المعرض والمخزن الرئيسي وفرع 3.',
    parameters: {
      type: 'OBJECT',
      properties: {
        date: { type: 'STRING', description: 'تاريخ اليوم بصيغة YYYY-MM-DD (اختياري، الافتراضي هو اليوم)' },
        branchId: { type: 'INTEGER', description: 'معرف الفرع (1=المعرض، 2=المخزن، 3=فرع3، اختياري)' },
      },
    },
  },
  {
    name: 'getSalesAndProfits',
    description: 'استعلام حركة المبيعات وصافي الأرباح ونسبة هامش الربح والتكلفة (رأس المال) والمصروفات وعدد الفواتير والمنتجات الأكثر مبيعاً لفترة محددة أو اليوم متطابقة بالقرش مع شاشة تحليلات النظام.',
    parameters: {
      type: 'OBJECT',
      properties: {
        date: { type: 'STRING', description: 'تاريخ محدد بصيغة YYYY-MM-DD' },
        startDate: { type: 'STRING', description: 'تاريخ البداية' },
        endDate: { type: 'STRING', description: 'تاريخ النهاية' },
        branchId: { type: 'INTEGER', description: 'معرف الفرع (اختياري)' },
      },
    },
  },
  {
    name: 'getStagnantStock',
    description: 'حصر الأصناف الراكدة المتوفرة برصيد فعلي إيجابي على الأرفف بالمخزن (التي مبيعاتها صفر) لعمل عروض وتصفيات وتسييل رأس المال المجمد.',
    parameters: {
      type: 'OBJECT',
      properties: {
        limit: { type: 'INTEGER', description: 'أقصى عدد أصناف للاستعراض (افتراضي 10)' },
      },
    },
  },
  {
    name: 'getLowStockAlerts',
    description: 'حصر نواقص المخزن والأصناف التي نفذت (0) أو رصيدها حرج (أقل من 5 قطع) لتجهيز أوامر الشراء وإعادة الطلب.',
    parameters: {
      type: 'OBJECT',
      properties: {
        threshold: { type: 'INTEGER', description: 'الحد الأقصى للرصيد الحرج (افتراضي 5)' },
        limit: { type: 'INTEGER', description: 'عدد الأصناف المسترجعة (افتراضي 15)' },
      },
    },
  },
  {
    name: 'getPayrollSummary',
    description: 'كشف رواتب وسلفيات العمال والموظفين النشطين في الفروع ومجموع ميزانية الرواتب للإدارة العليا.',
    parameters: {
      type: 'OBJECT',
      properties: {
        employeeName: { type: 'STRING', description: 'اسم الموظف للبحث عن سلفياته وراتبه (اختياري)' },
      },
    },
  },
  {
    name: 'getDebtsSummary',
    description: 'كشف المديونيات الخارجية ومستحقات الموردين والأقساط المتبقية للإدارة العليا.',
    parameters: {
      type: 'OBJECT',
      properties: {
        creditorName: { type: 'STRING', description: 'اسم الدائن أو المورد (اختياري)' },
      },
    },
  },
  {
    name: 'getExecutiveDailyOverview',
    description: 'نظرة تنفيذية شاملة ومختصرة لليوم تجمع الخزينة والمبيعات والديون والأصناف الراكدة بضغطة واحدة للإدارة العليا.',
    parameters: {
      type: 'OBJECT',
      properties: {},
    },
  },
  {
    name: 'searchProductStock',
    description: 'استعلام وبحث عن رصيد أي صنف بالاسم أو جزء من الاسم أو الباركود في الفروع (المعرض والمخزن الرئيسي) مع أسعار البيع والشراء والشركة المصنعة ونوع العبوة. استدعِ هذه الأداة فوراً عند السؤال عن أي صنف أو رصيد أو بضاعة حتى لو وردت بأخطاء صوتية عامية (مثل رشيد شوب بعد -> ابحث عن شوب وعد).',
    parameters: {
      type: 'OBJECT',
      properties: {
        query: { type: 'STRING', description: 'اسم الصنف أو جزء من الاسم أو الباركود للبحث عنه' },
        branchId: { type: 'INTEGER', description: 'معرف الفرع للفلترة (اختياري: 1=المعرض، 2=المخزن الرئيسي)' },
      },
      required: ['query'],
    },
  },
];

function executeSingleGeminiCall(payload, targetModel) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(payload);
    const model = targetModel || config.geminiModel || 'gemini-3.5-flash-lite';
    const apiKey = config.geminiApiKey;

    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      port: 443,
      path: `/v1beta/models/${model}:generateContent?key=${apiKey}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
      },
      timeout: 20000,
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            const errMsg = parsed.error?.message || `Gemini Error HTTP ${res.statusCode}: ${body}`;
            const err = new Error(errMsg);
            err.statusCode = res.statusCode;
            reject(err);
          }
        } catch (e) {
          reject(new Error(`Failed to parse Gemini response: ${e.message}`));
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Gemini API request timed out after 20s'));
    });

    req.on('error', (err) => reject(err));
    req.write(postData);
    req.end();
  });
}

async function postToGemini(payload) {
  const modelsToTry = [config.geminiModel || 'gemini-3.5-flash-lite', 'gemini-flash-lite-latest'];
  let lastError = null;

  for (const model of modelsToTry) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        return await executeSingleGeminiCall(payload, model);
      } catch (err) {
        lastError = err;
        const isTemporary = err.statusCode === 503 || 
                            err.statusCode === 429 || 
                            /high demand|rate limit|resource exhausted|temporary/i.test(err.message);
        
        if (isTemporary && attempt < 2) {
          // Wait 800ms before retry
          await new Promise(r => setTimeout(r, 800));
          continue;
        }
        break; // try fallback model
      }
    }
  }

  throw lastError;
}

/**
 * Execute a recognized tool call with user branch context
 */
async function executeTool(name, args, userContext) {
  console.log(`[Quaz AI] ⚡ Calling Tool: ${name} with args:`, args, 'branch:', userContext?.branchId, 'isAdmin:', userContext?.isAdmin);

  const opts = { ...args, userContext };

  switch (name) {
    case 'getCashAndTreasurySummary':
      return await tools.getCashAndTreasurySummary(opts);
    case 'getSalesAndProfits':
      return await tools.getSalesAndProfits(opts);
    case 'getStagnantStock':
      return await tools.getStagnantStock(opts);
    case 'getLowStockAlerts':
      return await tools.getLowStockAlerts(opts);
    case 'getPayrollSummary':
      return await tools.getPayrollSummary(opts);
    case 'getDebtsSummary':
      return await tools.getDebtsSummary(opts);
    case 'getExecutiveDailyOverview':
      return await tools.getExecutiveDailyOverview(opts);
    case 'searchProductStock':
      return await tools.searchProductStock(opts);
    default:
      return { error: `أداة غير معروفة: ${name}` };
  }
}

/**
 * Process a user message end-to-end with function calling support & branch RBAC
 */
async function processUserPrompt(promptText, history = [], userContext = { isAdmin: true }) {
  if (!promptText || !promptText.trim()) {
    return userContext.isAdmin 
      ? 'أهلاً بك يا أستاذ خالد! كيف يمكنني مساعدتك في حسابات ومخازن House of Glass اليوم؟'
      : 'أهلاً بك! كيف يمكنني مساعدتك في استعلامات وبيانات فرعك اليوم؟';
  }

  const systemInstructionText = getSystemInstruction(userContext);

  // Format message history for Gemini
  const contents = [];

  // Add previous history if provided
  if (Array.isArray(history) && history.length > 0) {
    history.slice(-6).forEach(h => {
      if (h.role && h.text) {
        contents.push({
          role: h.role === 'user' ? 'user' : 'model',
          parts: [{ text: h.text }],
        });
      }
    });
  }

  // Add the current user prompt
  contents.push({
    role: 'user',
    parts: [{ text: promptText.trim() }],
  });

  const payload = {
    contents,
    systemInstruction: {
      parts: [{ text: systemInstructionText }],
    },
    tools: [
      { functionDeclarations: TOOL_DECLARATIONS },
    ],
    generationConfig: {
      temperature: 0.2, // Low temperature for high factual accuracy
      maxOutputTokens: 1200,
    },
  };

  try {
    let response = await postToGemini(payload);
    let candidate = response.candidates?.[0];
    if (!candidate) {
      return 'عذراً، لم أستطع استخراج إجابة في الوقت الحالي. برجاء المحاولة مرة أخرى.';
    }

    // Check if the model wants to call a function
    const functionCalls = candidate.content?.parts?.filter(p => p.functionCall);

    if (functionCalls && functionCalls.length > 0) {
      // Append model's functionCall turn
      contents.push(candidate.content);

      // Execute each function call
      for (const callPart of functionCalls) {
        const { name, args } = callPart.functionCall;
        const toolResult = await executeTool(name, args || {}, userContext);

        // Send function response back to Gemini
        contents.push({
          role: 'user',
          parts: [{
            functionResponse: {
              name,
              response: { result: toolResult },
            },
          }],
        });
      }

      // Final completion request with the tools result
      const finalPayload = {
        contents,
        systemInstruction: {
          parts: [{ text: systemInstructionText }],
        },
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 1500,
        },
      };

      const finalResponse = await postToGemini(finalPayload);
      const finalText = finalResponse.candidates?.[0]?.content?.parts?.[0]?.text;
      return finalText || 'تم استخراج البيانات بنجاح.';
    }

    // Standard text response (no tool was called)
    const replyText = candidate.content?.parts?.[0]?.text;
    return replyText || 'أنا جاهز لخدمتك يا فندم!';
  } catch (error) {
    console.error('[Quaz AI Engine Error]:', error);
    return `⚠️ حدث خطأ أثناء معالجة الطلب: ${error.message}`;
  }
}

/**
 * Multimodal Voice Prompt Handler
 * Accepts audio buffer (base64) from Telegram voice note or Web app and processes in 1 step!
 */
async function processVoicePrompt(audioBuffer, mimeType = 'audio/ogg', additionalContext = '', userContext = { isAdmin: true }) {
  const base64Audio = audioBuffer.toString('base64');
  const systemInstructionText = getSystemInstruction(userContext);

  const payload = {
    contents: [{
      role: 'user',
      parts: [
        {
          inlineData: {
            mimeType,
            data: base64Audio,
          },
        },
        {
          text: `استمع بدقة لهذه الرسالة الصوتية من ${userContext.isAdmin ? 'صاحب العمل (المهندس خالد)' : 'الموظف'}، وافهم سؤاله واستفساراته وأجب عليه بذكاء بالعامية المصرية الراقية كـ Quaz AI مستخدماً الأدوات البرمجية المتاحة (Function Calling) للاستعلام الحي من قاعدة بيانات House of Glass إن لزم الأمر.${additionalContext ? ' ' + additionalContext : ''}`,
        },
      ],
    }],
    systemInstruction: {
      parts: [{ text: systemInstructionText }],
    },
    tools: [
      { functionDeclarations: TOOL_DECLARATIONS },
    ],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 1200,
    },
  };

  try {
    let response = await postToGemini(payload);
    let candidate = response.candidates?.[0];
    const functionCalls = candidate?.content?.parts?.filter(p => p.functionCall);

    if (functionCalls && functionCalls.length > 0) {
      const contents = [
        payload.contents[0],
        candidate.content,
      ];

      for (const callPart of functionCalls) {
        const { name, args } = callPart.functionCall;
        const toolResult = await executeTool(name, args || {}, userContext);
        contents.push({
          role: 'user',
          parts: [{
            functionResponse: {
              name,
              response: { result: toolResult },
            },
          }],
        });
      }

      const finalPayload = {
        contents,
        systemInstruction: { parts: [{ text: systemInstructionText }] },
        generationConfig: { temperature: 0.3, maxOutputTokens: 1500 },
      };

      const finalResponse = await postToGemini(finalPayload);
      return finalResponse.candidates?.[0]?.content?.parts?.[0]?.text || 'تم معالجة التسجيل الصوتي بنجاح.';
    }

    return candidate?.content?.parts?.[0]?.text || 'تم الاستماع للرسالة الصوتية بنجاح.';
  } catch (error) {
    console.error('[Quaz AI Voice Error]:', error);
    return `⚠️ فشل معالجة التسجيل الصوتي: ${error.message}`;
  }
}

module.exports = {
  processUserPrompt,
  processVoicePrompt,
  executeTool,
};

