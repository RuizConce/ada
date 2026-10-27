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

## Google (Calendar, Drive y Gmail)

1. En [Google Cloud Console](https://console.cloud.google.com) crea un proyecto y habilita **Google Calendar API**, **Google Drive API**, **Google Sheets API**, **Google Docs API**, **Gmail API** y **People API** (contactos) (y **Cloud Text-to-Speech API** si usarás esa voz).
2. Configura la pantalla de consentimiento OAuth: tipo *Externo*, agrega tu Gmail como usuario de prueba. Para que la conexión no venza cada 7 días, publícala (*En producción*); el aviso de "app no verificada" es normal para uso personal.
3. Credenciales → **ID de cliente OAuth** → *Aplicación web* → URI de redirección autorizada:
   `https://TU-DOMINIO.up.railway.app/api/google/callback` (la app la muestra en Ajustes).
4. En Railway: `GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET`.
5. En ADA: ⚙ Ajustes → **Conectar Google**. Si ya estaba conectado antes de Gmail, aparece **Reconectar para dar acceso a Gmail**.

ADA puede ver la agenda libremente; para crear, mover o eliminar eventos siempre pide confirmación.

Con Drive conectado, ADA puede **buscar, leer y analizar** (Docs, Sheets, Slides, Word, Excel, PDF, CSV), **ordenar** (crear carpetas, mover, renombrar, enviar a la papelera) y **editar** (agregar filas o actualizar celdas en Sheets, agregar o reemplazar texto en Docs). Todo lo que modifica requiere confirmación.

Con Gmail, ADA **busca, lee y resume** correos, ve los no leídos recientes, deja **borradores**, **archiva** (con confirmación) y propone **respuestas en el mismo hilo**. Nunca envía sola: la tarjeta muestra **Enviar desde Gmail** y el correo sale solo cuando tocas el botón (puedes editar asunto y texto antes).

Con Contactos, ADA encuentra a las personas aunque se digan distinto: apodos, relaciones ("mi señora"), nombres sin tildes o mal reconocidos por la voz, o nombre + organización. Busca en sus propios contactos (con alias aprendidos) y en Google (libreta y personas a las que les has escrito). Si hay dudas, pregunta; nunca inventa un correo o teléfono.

## Voz: lo hablado corto, el detalle en pantalla

En modo voz, ADA habla en una o dos frases y deja el detalle (listas, cifras, varios correos) en un recuadro en pantalla que no se lee en voz. Si dejas una frase a medias ("el correo de…"), espera unos segundos más antes de responder. En ⚙ Ajustes → Inteligencia aparecen los tiempos de los últimos turnos (cuánto tarda en empezar a hablar y en qué se va la demora); en los logs de Railway, cada turno muestra `ADA tiempos`.

## Modelos: rápido y a fondo

ADA elige el modelo en cada turno, sin llamadas extra: **Haiku** (`ADA_MODEL`, o `ADA_MODEL_RAPIDO`) para lo simple —anotar, agendar, confirmar— y **Sonnet** (`ADA_MODEL_PROFUNDO`, por defecto `claude-sonnet-5-5`) cuando conversan a fondo, piden opinión, analizan o deciden; una respuesta corta dentro de esa conversación sigue en Sonnet. En ⚙ Ajustes → Inteligencia se puede fijar *Automático*, *Siempre rápido* o *Siempre a fondo*, y se ven los tiempos por etapa (mediana y peor 5%) y el costo aproximado por turno de cada modo. Los precios se pueden ajustar con `ADA_PRECIOS` (JSON por modelo o familia, en dólares por millón de tokens).

## Laboratorio de voz (comparar prototipos)

⚙ Ajustes → Inteligencia → **Laboratorio de voz** (solo administrador) abre `/lab.html` para comparar, con la misma ADA detrás:

- **A · Tiempo real + Claude:** el micrófono se transcribe en vivo con Deepgram Nova-3 (por WebSocket en `/ws/oido`, con contactos y proyectos como palabras clave), tolera pausas, se interrumpe hablándole y habla con voz Aura-2. Requiere `DEEPGRAM_API_KEY` (opcional: `DEEPGRAM_VOZ`, por defecto `aura-2-carina-es`; `DEEPGRAM_IDIOMA`, por defecto `es`).
- **B · Voz a voz + ADA:** con `GEMINI_API_KEY` (Google AI Studio) usa Gemini Live por WebSocket con token temporal de un solo uso (opcional: `GEMINI_LIVE_MODEL`, por defecto `gemini-3.8-live`; `GEMINI_VOZ`, por defecto `Aoede`). Sin esa clave, usa OpenAI Realtime por WebRTC (token temporal emitido por el servidor) con la personalidad y el contexto de ADA; para datos y acciones llama a la herramienta `ada`, que usa el mismo `/api/chat/stream`. Requiere `OPENAI_API_KEY` (opcional: `OPENAI_REALTIME_MODEL`, por defecto `gpt-realtime-2.1`; `OPENAI_REALTIME_VOZ`, por defecto `marin`).
- **Actual:** para calificar la conversación normal con los mismos criterios.

Cada sesión mide la demora (fin de tu frase → primer audio) y se califica en naturalidad, comprensión y utilidad; la tabla compara los modos.

## Avisos y agenda

**Avisos al teléfono** (⚙ Ajustes → Avisos → *Activar avisos en este teléfono*): despertar (7:30), resumen del día (7:45, armado solo con datos reales), seguimiento de encargos cuando toca revisar, respuestas por correo de personas con encargos abiertos y lo que quedó de hoy (18:30). Silencio desde las 22:00 hasta el despertar y máximo 3 avisos al día además del despertar y el resumen. Al tocar un aviso, ADA se abre con una tarjeta para escucharlo. Las claves VAPID se crean solas y quedan en la base (o define `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`). En iPhone, solo con ADA instalada en la pantalla de inicio.

**Agenda** (ícono de calendario): la semana con las tareas por día —hechas tachadas, pendientes para marcar—, las atrasadas arriba y tus reuniones de Google Calendar en azul.

## WhatsApp: Compartir con ADA

WhatsApp personal no permite que otra app lea tus chats. En Android, con ADA instalada como app (menú del navegador → *Instalar app*), aparece en el menú **Compartir**:
- Un mensaje: mantén presionado → Compartir → ADA.
- Un chat completo: en el chat → ⋮ → Más → **Exportar chat → Sin archivos** → ADA.

ADA muestra lo recibido y ofrece *Resúmelo*, *Propón una respuesta* o *Anota lo importante*. Las respuestas se envían con el botón **Enviar por WhatsApp**, que abre WhatsApp con el texto listo. (En iPhone las web apps no aparecen en Compartir; copia y pega.)

## Archivos Word y Excel

ADA crea `.docx` (desde markdown: títulos, listas, negritas, tablas) y `.xlsx` (varias hojas, fórmulas y formatos de pesos/porcentaje). Aparecen en pantalla para descargar y, con Google conectado, se guardan además en la carpeta **ADA** de Drive como Google Docs / Sheets.

## Internet

ADA busca en internet con la herramienta de búsqueda de la API de Claude (10 USD por cada 1.000 búsquedas, máximo 3 por respuesta: `ADA_MAX_BUSQUEDAS`). Se desactiva con `ADA_INTERNET=no`.

## Personas de la prueba

Cristian entra con su nombre y la clave `ADA_PASSWORD` (administrador). En ⚙ Ajustes → **Personas de la prueba** crea una clave para cada invitado y se la envía por WhatsApp. Cada persona entra con **su nombre y su clave**; ADA la llama por ese nombre.

Cada persona tiene su **propia base de datos** (`<base>_u2`, `<base>_u3`…), así que no ve los proyectos, conversaciones, agenda ni correo de nadie más, y puede conectar su propio Google. *Quitar acceso* o *Nueva clave* cierra de inmediato sus sesiones. El usuario de MySQL debe poder crear bases (en Railway lo hace, porque usa `root`).

## Uso diario

- **Al empezar**: escribe cualquier cosa; el primer mensaje del día trae tus 3 prioridades.
- **Durante el día**: notas cortas ("decidí…", "avancé…", "quedé con Paola de…"). Botón **Estoy con…** para marcar el foco.
- **Al cerrar la semana**: botón **Revisión semanal**.

## Local

```bash
npm install
DATABASE_URL=mysql://usuario:clave@localhost:3306/ada ANTHROPIC_API_KEY=... ADA_PASSWORD=... npm start
```
