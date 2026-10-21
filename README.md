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

## Uso diario

- **Al empezar**: escribe cualquier cosa; el primer mensaje del día trae tus 3 prioridades.
- **Durante el día**: notas cortas ("decidí…", "avancé…", "quedé con Paola de…"). Botón **Estoy con…** para marcar el foco.
- **Al cerrar la semana**: botón **Revisión semanal**.

## Local

```bash
npm install
DATABASE_URL=mysql://usuario:clave@localhost:3306/ada ANTHROPIC_API_KEY=... ADA_PASSWORD=... npm start
```
