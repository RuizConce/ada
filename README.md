# ADA

Asistente personal de Cristian. Su propósito: **reducir la distancia entre lo que piensas, lo que quieres hacer y lo que logras.**

ADA registra decisiones, avances, pendientes, compromisos e ideas a partir de notas sueltas; sabe en qué estás trabajando; te cuestiona con criterio cuando lo urgente está en otra parte, y al final de la semana te entrega una revisión.

## Cómo funciona

- **Backend**: Node.js + Express + MySQL, con Claude (tool use) como cerebro.
- **Frontend**: PWA de chat en `/public`, instalable en iPad y celular.
- **Cuestionamiento**: lo decide el backend, no el modelo. En cada mensaje calcula el foco actual, los compromisos que vencen en 48 h y las advertencias usadas hoy, y solo entonces habilita a ADA para preguntar. Máximo 2 por día, separadas por al menos 90 minutos.

### Herramientas de ADA

| Herramienta | Para qué |
|---|---|
| `registrar_item` | Decisión, avance, pendiente, compromiso o idea |
| `actualizar_item` | Marcar hecho/descartado, cambiar fecha, proyecto, etc. |
| `listar_items` | "¿Qué me falta?", "¿qué le prometí a X?" |
| `iniciar_foco` / `cerrar_foco` | Registrar en qué estás trabajando |
| `registrar_alerta` | Dejar constancia de cada cuestionamiento (con tope diario) |
| `datos_informe` | Datos para la revisión semanal |
| `guardar_contacto` / `buscar_contactos` | Memoria de personas: rol, organización, teléfono, correo, notas |
| `crear_encargo` / `actualizar_encargo` / `listar_encargos` / `ver_encargo` | Cosas delegadas, con estado, siguiente paso, fecha de revisión y bitácora |
| `proponer_mensaje` | Prepara un WhatsApp, correo o guion de llamada. **No envía nada** |

### Encargos y autorización

ADA propone; el backend guarda; **solo un botón de Cristian ejecuta**. El modelo no tiene ninguna herramienta que envíe mensajes.

1. "Reagenda la reunión con Paola" → ADA crea el encargo y propone el mensaje.
2. En la app aparece una tarjeta **Por autorizar**: se puede editar el texto, enviarlo (abre WhatsApp o el correo con el texto listo), copiarlo o descartarlo.
3. Al enviarlo, el encargo pasa a *esperando respuesta* y se programa una revisión (24 h por defecto, `ADA_HORAS_SEGUIMIENTO`).
4. Cuando vence la revisión, ADA lo menciona y propone insistir, esperar o escalar.
5. Le cuentas la respuesta → ADA actualiza la bitácora y cierra el encargo cuando se cumple el objetivo.

Estados: `en_curso` → `esperando_autorizacion` → `esperando_respuesta` → `necesita_decision` → `resuelto` / `cancelado`.

**Próximas etapas**: Google Calendar y Gmail (leer disponibilidad, enviar con autorización), notificaciones push para el seguimiento, WhatsApp Business.

Las tablas (`proyectos`, `items`, `foco`, `alertas`, `mensajes`) se crean solas al arrancar, y se siembran los proyectos iniciales.

## Deploy en Railway

1. New Project → **Deploy from GitHub repo** → este repo.
2. En el mismo proyecto: **+ New → Database → MySQL**.
3. Variables del servicio ADA:

| Variable | Valor |
|---|---|
| `DATABASE_URL` | `${{MySQL.MYSQL_URL}}` |
| `ANTHROPIC_API_KEY` | tu clave de console.anthropic.com |
| `ADA_PASSWORD` | la contraseña para entrar |
| `TZ` | `America/Santiago` |
| `ADA_MODEL` | opcional, por defecto `claude-sonnet-5-5` |

4. Settings → Networking → **Generate Domain**.
5. Abre el dominio en Safari → Compartir → **Agregar a pantalla de inicio**.

### Ajustes opcionales

| Variable | Por defecto | Qué controla |
|---|---|---|
| `ADA_MAX_ALERTAS` | `2` | Cuestionamientos máximos por día |
| `ADA_MINUTOS_FOCO` | `60` | Minutos en un foco antes de poder cuestionar |
| `ADA_MINUTOS_ENTRE_ALERTAS` | `90` | Espera mínima entre cuestionamientos |

## Voz natural

Sin configuración, ADA usa la voz del teléfono (suena robótica). Con una de estas claves en Railway, usa una voz neuronal:

| Proveedor | Variables | Notas |
|---|---|---|
| Google Cloud TTS | `GOOGLE_TTS_API_KEY` · opcional `GOOGLE_TTS_VOZ` (por defecto `es-US-Chirp3-HD-Aoede`) | Mismo proyecto de Google Cloud que el calendario. Requiere facturación activa en el proyecto. |
| ElevenLabs | `ELEVENLABS_API_KEY` · `ELEVENLABS_VOICE_ID` · opcional `ELEVENLABS_MODELO` | La más humana. Elige una voz en español en su biblioteca. |
| OpenAI | `OPENAI_API_KEY` · opcional `OPENAI_VOZ`, `OPENAI_TTS_MODELO` | |

Si hay varias, `VOZ_PROVEEDOR` decide (`google`, `elevenlabs`, `openai` o `navegador`).

## Google Calendar

1. En [Google Cloud Console](https://console.cloud.google.com) crea un proyecto y habilita **Google Calendar API** (y **Cloud Text-to-Speech API** si usarás esa voz).
2. Configura la pantalla de consentimiento OAuth: tipo *Externo*, agrega tu Gmail como usuario de prueba. Para que la conexión no venza cada 7 días, publícala (*En producción*); el aviso de "app no verificada" es normal para uso personal.
3. Credenciales → **ID de cliente OAuth** → *Aplicación web* → URI de redirección autorizada:
   `https://TU-DOMINIO.up.railway.app/api/google/callback` (la app la muestra en Ajustes).
4. En Railway: `GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET`.
5. En ADA: ⚙ Ajustes → **Conectar Google Calendar**.

ADA puede ver la agenda libremente; para crear, mover o eliminar eventos siempre pide confirmación.

## Internet

ADA busca en internet con la herramienta de búsqueda de la API de Claude (10 USD por cada 1.000 búsquedas, máximo 3 por respuesta: `ADA_MAX_BUSQUEDAS`). Se desactiva con `ADA_INTERNET=no`.

## Uso diario

- **Al empezar**: escribe cualquier cosa; el primer mensaje del día trae tus 3 prioridades.
- **Durante el día**: notas cortas ("decidí…", "avancé…", "quedé con Paola de…"). Botón **Estoy con…** para marcar el foco.
- **Al cerrar la semana**: botón **Revisión semanal**.

## Local

```bash
npm install
DATABASE_URL=mysql://usuario:clave@localhost:3306/ada ANTHROPIC_API_KEY=... ADA_PASSWORD=... npm start
```
