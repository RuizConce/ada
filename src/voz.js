// Voz de ADA generada en el servidor (mucho más natural que la del navegador).
// Proveedores: Google Cloud Text-to-Speech, ElevenLabs u OpenAI. Se elige según la clave configurada,
// o explícitamente con VOZ_PROVEEDOR. Sin ninguna clave, la app usa la voz del teléfono.

function proveedor() {
  const p = (process.env.VOZ_PROVEEDOR || '').toLowerCase();
  if (p === 'navegador') return 'navegador';
  if (p && claves()[p]) return p;
  if (process.env.ELEVENLABS_API_KEY) return 'elevenlabs';
  if (process.env.GOOGLE_TTS_API_KEY) return 'google';
  if (process.env.OPENAI_API_KEY) return 'openai';
  return 'navegador';
}

function claves() {
  return {
    elevenlabs: !!process.env.ELEVENLABS_API_KEY,
    google: !!process.env.GOOGLE_TTS_API_KEY,
    openai: !!process.env.OPENAI_API_KEY,
  };
}

async function falla(res, quien) {
  const cuerpo = await res.text().catch(() => '');
  const e = new Error(`${quien} respondió ${res.status}: ${cuerpo.slice(0, 300)}`);
  e.status = res.status;
  return e;
}

async function google(texto) {
  const voz = process.env.GOOGLE_TTS_VOZ || 'es-US-Chirp3-HD-Aoede';
  const idioma = voz.split('-').slice(0, 2).join('-');
  const pedir = (nombre) => fetch(
    `https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(process.env.GOOGLE_TTS_API_KEY)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: { text: texto },
        voice: { languageCode: idioma, name: nombre },
        audioConfig: { audioEncoding: 'MP3' },
      }),
    }
  );
  let res = await pedir(voz);
  // Si la voz elegida no existe, usa una neuronal estándar.
  if (res.status === 400 && !process.env.GOOGLE_TTS_VOZ_ESTRICTA) res = await pedir('es-US-Neural2-A');
  if (!res.ok) throw await falla(res, 'Google TTS');
  const { audioContent } = await res.json();
  return Buffer.from(audioContent, 'base64');
}

async function elevenlabs(texto) {
  const voz = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voz}?output_format=mp3_44100_64`, {
    method: 'POST',
    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify({
      text: texto,
      model_id: process.env.ELEVENLABS_MODELO || 'eleven_flash_v2_5',
      voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.2, use_speaker_boost: true },
    }),
  });
  if (!res.ok) throw await falla(res, 'ElevenLabs');
  return Buffer.from(await res.arrayBuffer());
}

async function openai(texto) {
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.OPENAI_TTS_MODELO || 'gpt-4o-mini-tts',
      voice: process.env.OPENAI_VOZ || 'coral',
      input: texto,
      instructions: 'Habla en español latinoamericano con un acento chileno suave. Tono cálido, cercano y natural, como una asistente de confianza. Ritmo ágil.',
      response_format: 'mp3',
    }),
  });
  if (!res.ok) throw await falla(res, 'OpenAI TTS');
  return Buffer.from(await res.arrayBuffer());
}

const PROVEEDORES = { google, elevenlabs, openai };

async function sintetizar(texto) {
  const p = proveedor();
  if (p === 'navegador') return null;
  return PROVEEDORES[p](texto.slice(0, 800));
}

module.exports = { sintetizar, proveedor };
