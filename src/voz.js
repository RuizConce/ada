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

// Voz elegida por Cristian desde la app (se guarda en la base); si no hay, la de Railway o la por defecto.
const vocesElegidas = new Map(); // por persona
const uidActual = () => require('./db').usuario().id;
async function vozGuardada() {
  const uid = uidActual();
  if (vocesElegidas.has(uid)) return vocesElegidas.get(uid);
  let voz = null;
  try {
    const { q } = require('./db');
    const [r] = await q("SELECT datos FROM integraciones WHERE nombre = 'voz'");
    voz = r ? JSON.parse(r.datos).google : null;
  } catch (_) { return null; }
  vocesElegidas.set(uid, voz);
  return voz;
}

async function elegirVoz(nombre) {
  const { q } = require('./db');
  await q(
    `INSERT INTO integraciones (nombre, datos, actualizado_en) VALUES ('voz', ?, ?)
     ON DUPLICATE KEY UPDATE datos = VALUES(datos), actualizado_en = VALUES(actualizado_en)`,
    [JSON.stringify({ google: nombre }), new Date()]
  );
  vocesElegidas.set(uidActual(), nombre);
  return { ok: true, voz: nombre };
}

async function vozActual() {
  return (await vozGuardada()) || process.env.GOOGLE_TTS_VOZ || 'es-US-Chirp3-HD-Aoede';
}

// Lista las voces naturales de Google en español (latinoamericano primero).
let cacheVoces = null;
async function listarVoces() {
  if (proveedor() !== 'google') return { proveedor: proveedor(), voces: [], actual: null };
  if (!cacheVoces) {
    const res = await fetch(`https://texttospeech.googleapis.com/v1/voices?key=${encodeURIComponent(process.env.GOOGLE_TTS_API_KEY)}`);
    if (!res.ok) throw await falla(res, 'Google TTS');
    const { voices = [] } = await res.json();
    const calidad = (n) => (n.includes('Chirp3-HD') ? 0 : n.includes('Chirp-HD') ? 1 : n.includes('Studio') ? 2 : n.includes('Neural2') ? 3 : 9);
    cacheVoces = voices
      .filter((v) => v.languageCodes.some((l) => ['es-US', 'es-ES'].includes(l)) && calidad(v.name) < 9)
      .map((v) => ({
        nombre: v.name,
        etiqueta: v.name.split('-').pop(),
        idioma: v.languageCodes[0] === 'es-US' ? 'Latinoamérica' : 'España',
        genero: v.ssmlGender === 'FEMALE' ? 'Femenina' : v.ssmlGender === 'MALE' ? 'Masculina' : '',
        linea: v.name.includes('Chirp3-HD') ? 'Chirp 3 HD' : v.name.includes('Chirp-HD') ? 'Chirp HD' : v.name.includes('Studio') ? 'Studio' : 'Neural2',
        orden: (v.languageCodes[0] === 'es-US' ? 0 : 10) + calidad(v.name),
      }))
      .sort((a, b) => a.orden - b.orden || a.genero.localeCompare(b.genero) || a.etiqueta.localeCompare(b.etiqueta));
  }
  return { proveedor: 'google', voces: cacheVoces, actual: await vozActual() };
}

async function google(texto, vozForzada) {
  const voz = vozForzada || (await vozActual());
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

// Deepgram Aura-2 (laboratorio de voz): voces en español, muy rápidas en empezar a sonar.
async function deepgram(texto, vozForzada) {
  const modelo = vozForzada && /^aura-/.test(vozForzada) ? vozForzada : process.env.DEEPGRAM_VOZ || 'aura-2-carina-es';
  const res = await fetch(`https://api.deepgram.com/v1/speak?model=${encodeURIComponent(modelo)}&encoding=mp3`, {
    method: 'POST',
    headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: texto }),
  });
  if (!res.ok) throw await falla(res, 'Deepgram');
  return Buffer.from(await res.arrayBuffer());
}

const PROVEEDORES = { google, elevenlabs, openai, deepgram };

// proveedorForzado: solo para el laboratorio de voz (comparar voces sin cambiar la de ADA).
async function sintetizar(texto, vozForzada, proveedorForzado) {
  let p = proveedor();
  if (proveedorForzado === 'deepgram' && process.env.DEEPGRAM_API_KEY) p = 'deepgram';
  if (p === 'navegador') return null;
  return PROVEEDORES[p](texto.slice(0, 800), p === 'google' || p === 'deepgram' ? vozForzada : undefined);
}

module.exports = { sintetizar, proveedor, listarVoces, elegirVoz, vozActual };
