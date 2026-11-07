const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');

/**
 * Clean & prepare text for spoken Egyptian narration
 */
function prepareSpeechNarrative(text) {
  if (!text || typeof text !== 'string') return '';

  let clean = text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/\bhttps?:\/\/\S+/g, '')
    .replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '');

  const lines = clean.split('\n').map(l => l.trim()).filter(Boolean);
  const narrativeLines = [];
  const bulletLines = [];

  for (const line of lines) {
    if (line.startsWith('*') || line.startsWith('-') || line.startsWith('•') || line.includes(':')) {
      bulletLines.push(line);
    } else {
      narrativeLines.push(line);
    }
  }

  let speech = '';
  if (
    narrativeLines.length > 0 &&
    narrativeLines.some(l =>
      l.includes('فاتورة') ||
      l.includes('مبيعات') ||
      l.includes('الدرج') ||
      l.includes('رصيد') ||
      l.includes('ربح') ||
      l.includes('خالد') ||
      l.includes('باشا') ||
      l.includes('مصاريف')
    )
  ) {
    speech = narrativeLines.join('، ');
  } else {
    speech = lines.map(l => l.replace(/^[\*\-•]\s*/, '').replace(':', ' ')).join('، ');
  }

  // Phonetic Arabic transformations for Egyptian accent
  speech = speech
    .replace(/(\d+[\d,]*(\.\d+)?)\s*(?:ج\.م|جم|جـم)/g, '$1 جنيه')
    .replace(/(\d+[\d,]*(\.\d+)?)\s*%/g, '$1 في المية')
    .replace(/-\s*(\d+)/g, 'سالب $1')
    .replace(/[\(\)\[\]\{\}\<\>]/g, ' ')
    .replace(/[*#_~`>/\\:•\-]/g, ' ')
    .replace(/[a-zA-Z]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return speech;
}

/**
 * Synthesize text into MP3 Buffer using Microsoft Edge Egyptian Neural Voice
 */
async function synthesizeEgyptianSpeech(text, voice = 'ar-EG-ShakirNeural') {
  const speechText = prepareSpeechNarrative(text);
  if (!speechText) return null;

  try {
    const tts = new MsEdgeTTS();
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(speechText);

    return new Promise((resolve, reject) => {
      const chunks = [];
      audioStream.on('data', chunk => chunks.push(chunk));
      audioStream.on('end', () => resolve(Buffer.concat(chunks)));
      audioStream.on('error', err => reject(err));
    });
  } catch (error) {
    console.error('[Quaz AI TTS Error]:', error.message);
    return null;
  }
}

module.exports = {
  prepareSpeechNarrative,
  synthesizeEgyptianSpeech,
};
