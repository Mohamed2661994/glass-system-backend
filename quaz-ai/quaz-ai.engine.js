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

const SYSTEM_INSTRUCTION = `أنت «Quaz AI» (كواز)، المساعد والمدير التنفيذي والمحاسبي الذكي لنظام «House of Glass» (معرض ومخازن آل عاشور عدس للأدوات المنزلية والزجاجيات).
أنت تتحدث مباشرة مع المهندس خالد (صاحب ومؤسس الشركة والإدارة العليا).

قواعد شخصيتك وطريقة ردك:
1. تحدث دائماً باللهجة المصرية المهنية الذكية والراقية (مزيج من الودية والاحترام والاحترافية العالية).
2. استخدم الأرقام الدقيقة مع عملة (ج.م) ونسق الردود بنقاط واضحة وإيموجي معبرة.
3. عندما يسألك عن الخزينة أو المبيعات أو الأرباح أو البضاعة أو الديون أو الرواتب، استخدم فوراً الأدوات البرمجية المتاحة (Function Calling) للحصول على البيانات الحية اللحظية من النظام، ولا تخمن أبداً أرقاماً من عندك.
4. ركز على إبراز ما يهم صاحب العمل: (السيولة النقدية، صافي الأرباح، البضاعة المجمدة لتسييلها، والديون المستحقة).
5. إذا طلب المستخدم اقتراحاً تجارياً، قدم له نصائح تجارية ذكية بناءً على الأرقام الفعلية.`;

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
    description: 'استعلام حركة المبيعات وصافي الأرباح ونسبة هامش الربح وعدد الفواتير والمنتجات الأكثر مبيعاً لفترة محددة أو اليوم.',
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
    description: 'كشف رواتب وسلفيات العمال والموظفين النشطين في الفروع ومجموع ميزانية الرواتب.',
    parameters: {
      type: 'OBJECT',
      properties: {
        employeeName: { type: 'STRING', description: 'اسم الموظف للبحث عن سلفياته وراتبه (اختياري)' },
      },
    },
  },
  {
    name: 'getDebtsSummary',
    description: 'كشف المديونيات الخارجية ومستحقات الموردين والأقساط المتبقية.',
    parameters: {
      type: 'OBJECT',
      properties: {
        creditorName: { type: 'STRING', description: 'اسم الدائن أو المورد (اختياري)' },
      },
    },
  },
  {
    name: 'getExecutiveDailyOverview',
    description: 'نظرة تنفيذية شاملة ومختصرة لليوم تجمع الخزينة والمبيعات والديون والأصناف الراكدة بضغطة واحدة.',
    parameters: {
      type: 'OBJECT',
      properties: {},
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
 * Execute a recognized tool call
 */
async function executeTool(name, args) {
  console.log(`[Quaz AI] ⚡ Calling Tool: ${name} with args:`, args);

  switch (name) {
    case 'getCashAndTreasurySummary':
      return await tools.getCashAndTreasurySummary(args);
    case 'getSalesAndProfits':
      return await tools.getSalesAndProfits(args);
    case 'getStagnantStock':
      return await tools.getStagnantStock(args);
    case 'getLowStockAlerts':
      return await tools.getLowStockAlerts(args);
    case 'getPayrollSummary':
      return await tools.getPayrollSummary(args);
    case 'getDebtsSummary':
      return await tools.getDebtsSummary(args);
    case 'getExecutiveDailyOverview':
      return await tools.getExecutiveDailyOverview(args);
    default:
      return { error: `أداة غير معروفة: ${name}` };
  }
}

/**
 * Process a user message end-to-end with function calling support
 */
async function processUserPrompt(promptText, history = []) {
  if (!promptText || !promptText.trim()) {
    return 'أهلاً بك يا أستاذ خالد! كيف يمكنني مساعدتك في حسابات ومخازن House of Glass اليوم؟';
  }

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
      parts: [{ text: SYSTEM_INSTRUCTION }],
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
      return 'عذراً يا هندسة، لم أستطع استخراج إجابة في الوقت الحالي. برجاء المحاولة مرة أخرى.';
    }

    // Check if the model wants to call a function
    const functionCalls = candidate.content?.parts?.filter(p => p.functionCall);

    if (functionCalls && functionCalls.length > 0) {
      // Append model's functionCall turn
      contents.push(candidate.content);

      // Execute each function call
      for (const callPart of functionCalls) {
        const { name, args } = callPart.functionCall;
        const toolResult = await executeTool(name, args || {});

        // Send function response back to Gemini
        contents.push({
          role: 'user', // In Gemini 1.5/2.5/3.5, function responses are provided with role 'user' or functionResponse part
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
          parts: [{ text: SYSTEM_INSTRUCTION }],
        },
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 1500,
        },
      };

      const finalResponse = await postToGemini(finalPayload);
      const finalText = finalResponse.candidates?.[0]?.content?.parts?.[0]?.text;
      return finalText || 'تم تنفيذ العملية بنجاح.';
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
async function processVoicePrompt(audioBuffer, mimeType = 'audio/ogg', additionalContext = '') {
  const base64Audio = audioBuffer.toString('base64');

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
          text: `استمع بدقة لهذه الرسالة الصوتية من صاحب العمل (المهندس خالد)، وافهم سؤاله واستفساراته وأجب عليه بذكاء بالعامية المصرية الراقية كـ Quaz AI مستخدماً الأدوات البرمجية المتاحة (Function Calling) للاستعلام الحي من قاعدة بيانات House of Glass إن لزم الأمر.${additionalContext ? ' ' + additionalContext : ''}`,
        },
      ],
    }],
    systemInstruction: {
      parts: [{ text: SYSTEM_INSTRUCTION }],
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
        const toolResult = await executeTool(name, args || {});
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
        systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
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

