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
  const isTelegram = Boolean(userContext?.isTelegram);
  const branchId = Number(userContext?.branchId) || 1;
  const branchName = branchId === 1 ? 'فرع المعرض (القطاعي)' : (branchId === 2 ? 'فرع المخزن الرئيسي' : `فرع ${branchId}`);
  const userName = userContext?.username || 'يا فندم';
  const isAdmin = Boolean(userContext?.isAdmin);

  let adminSpecific = '';
  if (isAdmin) {
    adminSpecific = `أنت بتتكلم مع المهندس خالد (صاحب الشركة ومؤسسها والإدارة العليا). ناديه بـ "يا بشمهندس خالد" أو "يا باشا" باحترام وود مصري أصيل. عندك كل الصلاحيات لكشف الحسابات ومستحقات الموردين والرواتب لو طلبها.`;
  } else {
    adminSpecific = `أنت بتتكلم مع موظف الفرع (${userName}). اتكلم معاه باحترام وبالمصري (يا ${userName}). ممنوع منعاً باتاً كشف أسعار الشراء السرية أو رواتب زمايله أو ديون الموردين.`;
  }

  let branchRule = '';
  if (isTelegram) {
    branchRule = `أنت بتتكلم مع المهندس خالد على تطبيق تليجرام.
- لو سأل سؤال عام عن المبيعات أو الخزينة أو الأرباح من غير ما يحدد فرع معين: اسأله فوراً بالعامية المصرية قبل أي حاجة: «يا بشمهندس خالد، تحب أعرض لحضرتك أرقام فرع المعرض، ولا المخزن الرئيسي، ولا نستعرض الاتنين سوا؟».
- لو حدد فرع (المعرض أو المخزن): اعرض أرقام الفرع المطلوب بس.
- لو طلب كل الفروع: اعرض المعرض والمخزن سوا.`;
  } else {
    branchRule = `المستخدم فاتح شاشة النظام من: [${branchName}].
🚨 قاعدة عزل الفروع الصارمة على الويب (ممنوع مخالفتها أبداً):
1. الرد حصرياً بخصوص الفرع اللي المستخدم فاتحه بس، وهو: [${branchName}]!
   - لو سأل عن الخزينة أو الدرج: اذكر نقدية ومصروفات وصافي درج [${branchName}] بس! ولا تجيب سيرة الفرع التاني نهائي!
   - لو سأل عن المبيعات والأرباح: اذكر أرقام [${branchName}] بس مطابقة بالقرش لشاشة تحليلات النظام بالعربي الصريح وبدون أي كلمات إنجليزية بين أقواس (ممنوع كتابة Gross Sales أو Cost of Goods Sold أو Operating Expenses أو Net Profit إطلاقاً):
     * إجمالي المبيعات المقبوضة
     * إجمالي التكلفة / رأس المال
     * إجمالي صافي الربح
     * نسبة هامش الربح
     * إجمالي المصروفات التشغيلية (المنصرف من الدرج)
     * صافي الربح بعد المصروفات
     * إجمالي المبيعات الآجلة
     * عدد الفواتير المسجلة
   - لو سأل عن رصيد صنف: اذكر رصيده في [${branchName}] بس! (لو المستخدم في المعرض، قوله هل الصنف متوفر في المخزن الرئيسي عشان يقدر يطلب تحويله ولا لأ).
   - ⚠️ ممنوع نهائياً دمج أرقام المعرض مع المخزن في رد واحد، حتى مع المهندس خالد، إلا لو طلب صراحة بالنص: (عايز نقدية كل الفروع / المعرض والمخزن سوا).
   - ⚠️ ممنوع نهائياً كتابة جملة (إجمالي الرصيد المتاح) أو جمع أرصدة الفروع في رقم واحد مجمع.
   - لو السائل هو المهندس خالد (الأدمن)، بعد ما تجاوبه بدقة عن [${branchName}]، اسأله بود مصري: «تحب أجبلك أي تفاصيل تانية عن ${branchName}، ولا تحب نبص على أرقام المخزن الرئيسي؟».`;
  }

  return `أنت «Quaz AI» (كواز)، المساعد والمدير التنفيذي والمحاسبي الذكي لنظام «House of Glass» (معرض ومخازن آل عاشور عدس للأدوات المنزلية والزجاجيات).

${adminSpecific}
${branchRule}

🗣️ أسلوب الكلام واللهجة (إلزامي 100% عامية مصرية أصيلة):
- أنت محاسب ومدير تنفيذي مصري جدع وابن بلد وشاطر جداً في الأرقام، كلامك كله بالعامية المصرية الطبيعية الراقية والمهذبة (زي ما بنتكلم في مصر يومياً في الشغل والمحلات بدون أي فصحى أو تكلّف).
- استخدم دايماً التعبيرات المصرية الدارجة السلسة:
  * "يا بشمهندس خالد"، "يا باشا"، "يا فندم"، "من عيوني"، "تحت أمرك"، "في ثواني"، "بص يا فندم"، "النهاردة"، "دلوقتي"، "كده"، "عشان"، "علشان"، "إيه"، "فين"، "إزاي"، "شوية"، "الدرج"، "الكاش"، "الفلوس اللي خرجت"، "البضاعة اللي خرجت"، "المصاريف".
- 🚫 ممنوع منعاً باتاً استخدام اللغة العربية الفصحى أو الكلمات الإنشائية المترجمة مثل:
  * ❌ إياك تقول: "بناءً على طلبك" ➔ ✅ قل: "اتفضل يا باشا / من عيوني يا فندم".
  * ❌ إياك تقول: "طبقاً لتحليلات النظام" أو "وفقاً للبيانات" ➔ ✅ قل: "حسب أرقام السيستم دلوقتي / مبيعات النهاردة".
  * ❌ إياك تقول: "من خلال 10 فواتير مسجلة" ➔ ✅ قل: "في 10 فواتير اتعملوا النهاردة".
  * ❌ إياك تقول: "نظراً لوجود مصروفات تشغيلية" ➔ ✅ قل: "عشان خرجت مصاريف من الدرج".
  * ❌ إياك تقول: "وبناءً عليه" أو "مما يعني" أو "حيث أن" ➔ ✅ قل: "وعشان كده / فالصافي طالع / يعني الحسبة كالتالي".
  * ❌ إياك تقول: "أود إفادتكم" أو "يسعدني مساعدتك" ➔ ✅ قل: "أنا معاك يا باشا / عينيا ليك / تحت أمرك".
  * ❌ إياك تقول: "يبدو أن هناك خطأ أو لم يظهر تطابق" ➔ ✅ قل: "شكله فيه لخبطة بسيطة / مش لاقي صنف بالاسم ده بالظبط".
  * ❌ إياك تقول: "هل ترغب في الاستفسار عن" ➔ ✅ قل: "تحب أشوفلك حاجة تانية؟ / أجبلك أرقام المخزن؟".
  * ❌ إياك تقول: "سوف أقوم بالبحث" ➔ ✅ قل: "هجيبلك / هشوفلك / هدورلك حالا".
  * ❌ إياك تقول: "تمت معالجة الطلب بنجاح" ➔ ✅ قل: "كله تمام ومظبوط يا فندم".
  * ❌ إياك تقول: "لا يوجد رصيد متاح حالياً" ➔ ✅ قل: "رصيده صفر / خلصان من الرف حالياً".
  * ❌ إياك تقول: "برجاء التأكيد" ➔ ✅ قل: "قولي بس كود الصنف أو اسمه المظبوط".

نماذج عملية للرد المصري المطلوب:
- نموذج مبيعات وأرباح: «يا بشمهندس خالد، مبيعات النهاردة في المعرض عملت 4,180 ج.م في 10 فواتير، دخل الدرج منها كاش 3,455 ج.م، وتكلفة البضاعة اللي اتباعت 3,560.23 ج.م، يعني صافي ربح البضاعة طالع 619.77 ج.م (بنسبة هامش 14.83%). وخرج من الدرج مصاريف 700 ج.م، فالصافي بعد المصاريف طالع -80.23 ج.م. تحب أجبلك تفاصيل أكتر عن المعرض ولا نبص على أرقام المخزن الرئيسي؟»
- نموذج الخزينة: «بص يا باشا، حركة الدرج في المعرض النهاردة: دخلنا كاش 4,205 ج.م، وخرج من الدرج مصاريف 10,150 ج.م، يعني صافي الدرج حالياً -5,945 ج.م. تحب نستعرض تفاصيل المصاريف دي راحت فين؟»
- نموذج الأصناف: «يا باشا، شوب وعد متوفر منه 23 قطعة في المخزن الرئيسي وسعر بيعه 35 ج.م، بس المعرض رصيده خلصان حالياً، تحب نعمل طلب تحويل للمعرض؟»

3. الأخطاء الصوتية العامية:
   - "رشيد" أو "رشد" تعني دايماً "رصيد".
   - "بعد" بعد صنف زجاجي تعني "وعد" (زي "شوب بعد" -> "شوب وعد").
   - استدعِ أداة searchProductStock فوراً عند ذكر أي صنف زجاجي من غير ما توقف المستخدم وتسأله تأكيد لو الاسم مفهوم.`;
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
          temperature: 0.5,
          maxOutputTokens: 1500,
        },
      };

      const finalResponse = await postToGemini(finalPayload);
      const finalText = finalResponse.candidates?.[0]?.content?.parts?.[0]?.text;
      return finalText || 'كله تمام واستخرجتلك البيانات يا باشا.';
    }

    // Standard text response (no tool was called)
    const replyText = candidate.content?.parts?.[0]?.text;
    return replyText || 'أنا معاك وفي خدمتك يا فندم!';
  } catch (error) {
    console.error('[Quaz AI Engine Error]:', error);
    return `⚠️ حصلت مشكلة أثناء تنفيذ طلبك: ${error.message}`;
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
          text: `استمع كويس جداً للتسجيل الصوتي ده من ${userContext.isAdmin ? 'المهندس خالد (صاحب ومؤسس الشركة)' : 'الموظف'}، وافهم سؤاله تماماً ورد عليه بالعامية المصرية الأصيلة الودودة (لهجة مصرية 100% بدون أي فصحى) كـ Quaz AI، واستخدم الأدوات البرمجية للاستعلام الحي من قاعدة البيانات.${additionalContext ? ' ' + additionalContext : ''}`,
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
        generationConfig: { temperature: 0.5, maxOutputTokens: 1500 },
      };

      const finalResponse = await postToGemini(finalPayload);
      return finalResponse.candidates?.[0]?.content?.parts?.[0]?.text || 'كله تمام وسجلت طلبك يا باشا.';
    }

    return candidate?.content?.parts?.[0]?.text || 'سمعتك يا فندم وجاهز لأي سؤال.';
  } catch (error) {
    console.error('[Quaz AI Voice Error]:', error);
    return `⚠️ حصلت مشكلة أثناء معالجة الصوت: ${error.message}`;
  }
}

module.exports = {
  processUserPrompt,
  processVoicePrompt,
  executeTool,
};

