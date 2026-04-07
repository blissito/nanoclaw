# Ghosty se vuelve más inteligente, más seguro y más resistente

**Por Héctor Bliss** | Abril 2026

---

Tu asistente de WhatsApp no debería ser frágil. No debería olvidar de qué estaban hablando a mitad de una conversación larga. No debería colapsar cuando la API tiene un mal día. Y definitivamente no debería ser vulnerable a inyecciones de comandos.

Esta semana desplegamos una actualización mayor a **Ghosty** — nuestro agente de IA que vive en tus grupos de WhatsApp — con mejoras que tocan las tres áreas más críticas de un sistema de producción: **seguridad, resiliencia y contexto**.

## El problema con los agentes "demo"

La mayoría de los bots de WhatsApp que ves en demos de Twitter funcionan exactamente una vez. Le mandas un mensaje, te contesta algo bonito, y el video se corta. Lo que no te muestran es qué pasa cuando:

- El grupo tiene 200 mensajes pendientes y el bot intenta procesarlos todos
- La API de Claude devuelve un error 429 porque estás en hora pico
- Un usuario malintencionado inyecta un nombre de contenedor con `; rm -rf /`
- La sesión del agente se corrompe y entra en un loop infinito de reintentos

Ghosty resuelve estos problemas **en producción, no en slides**.

## Qué cambió

### 1. Protección contra inyección de comandos

Cada agente de Ghosty corre en un contenedor Docker aislado. Cuando un contenedor termina su trabajo, el sistema ejecuta `docker stop` con el nombre del contenedor. El problema: ese nombre venía del exterior sin validación.

Un atacante creativo podría haber inyectado algo como `foo; rm -rf /` como nombre de contenedor, ejecutando comandos arbitrarios en el servidor. Ahora validamos con regex estricto (`^[a-zA-Z0-9][a-zA-Z0-9_.-]*$`) y ejecutamos directamente con `execSync` en vez de construir strings de shell.

También bloqueamos inyección de paths en los montajes Docker — no más `../../../etc/passwd` como ruta de volumen.

**Resultado:** superficie de ataque reducida a cero en las dos interfaces más expuestas del sistema.

### 2. Contexto que no se pierde (1M tokens + auto-compresión)

Antes, el agente trabajaba con ventanas de contexto estándar. En conversaciones largas — como cuando le pides que investigue algo complejo y luego le haces seguimiento — eventualmente "olvidaba" el inicio de la conversación.

Actualizamos al SDK 0.2.92 de Claude que soporta **1 millón de tokens de contexto** con **auto-compresión inteligente a 165K tokens**. En la práctica esto significa que Ghosty puede mantener una conversación de ~500 mensajes sin perder el hilo. Y cuando el contexto se acerca al límite, comprime automáticamente preservando lo más relevante.

### 3. Recuperación automática de sesiones corruptas

Los contenedores Docker son efímeros — cuando se reinician, su filesystem desaparece. Si el agente tenía una sesión activa, al intentar reanudarla encuentra que el archivo de transcripción (.jsonl) ya no existe. Antes, esto causaba un loop infinito de reintentos.

Ahora el sistema detecta específicamente el error `ENOENT` en archivos `.jsonl`, limpia la sesión corrupta, y reintenta con una sesión fresca. Un retry inteligente, no un retry ciego.

### 4. Límite de mensajes por prompt

¿Qué pasa si te vas de vacaciones y tu grupo de WhatsApp acumula 500 mensajes para el bot? Antes, Ghosty intentaba procesar todos de golpe — saturando el contexto y generando respuestas incoherentes.

Ahora limitamos a los **10 mensajes más recientes** por invocación (configurable vía `MAX_MESSAGES_PER_PROMPT`). El agente procesa lo relevante, no el ruido.

### 5. Mensajes citados con contexto

Cuando alguien responde a un mensaje específico en WhatsApp (la función de "reply"), Ghosty ahora recibe ese contexto: quién dijo qué, y a qué mensaje se está respondiendo. Esto le permite entender conversaciones con hilos cruzados — algo que los bots típicos ignoran completamente.

### 6. Limpieza automática de artifacts

Los archivos de sesión, logs de debug, y transcripciones se acumulan con el tiempo. Ahora un proceso de limpieza corre al iniciar y cada 24 horas, eliminando artifacts de más de 3-7 días sin tocar sesiones activas.

## Fallback inteligente cuando la API falla

Una de las piezas más críticas de Ghosty es su proxy de credenciales. Cada contenedor se conecta al proxy en vez de directamente a la API de Anthropic — así los secretos nunca entran al contenedor.

Cuando la API devuelve un error 429 (rate limit), el proxy automáticamente reintenta con una API key de respaldo y un modelo alternativo. Esto significa que tu agente sigue respondiendo incluso cuando el plan principal está saturado.

Esta semana descubrimos que el modelo de fallback (`claude-sonnet-4-5-20241022`) había dejado de existir en la API. Lo actualizamos a `claude-sonnet-4-20250514` — y documentamos una regla importante: **los IDs de modelos de Anthropic no incluyen el número de versión menor**. Es `claude-sonnet-4-`, no `claude-sonnet-4-6-`.

## Por qué esto importa

Si estás evaluando agentes de IA para tu negocio, no preguntes "¿qué tan bonita es la demo?". Pregunta:

- ¿Qué pasa cuando la API falla?
- ¿Cómo maneja conversaciones largas?
- ¿Qué aislamiento de seguridad tiene?
- ¿Se recupera solo o necesita intervención manual?

Ghosty no es el agente más vistoso del mercado. Es el que sigue funcionando a las 3am cuando nadie está mirando.

---

*Ghosty es un agente de IA para WhatsApp construido sobre NanoClaw. Si quieres un asistente inteligente para tu equipo de trabajo, [escríbenos](https://fixtergeek.com).*

<!-- author-signature -->
