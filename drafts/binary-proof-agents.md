# Cómo evitar que tu agente reviente el contexto al leer un PDF

*June 11, 2026 · [NanoClaw Blog](index.html)*

**Blissmo** — Building [Formmy](https://formmy.app) & Ghosty

---

Todos los agentes LLM que tocan archivos reales terminan haciendo lo mismo en algún momento: `Read("reporte-anual-103-paginas.pdf")`. La herramienta `Read` del Anthropic Agent SDK agarra el archivo entero y lo mete al prompt. Ocho megabytes de PDF binario se convierten en cientos de miles de tokens. La API responde *"Prompt is too long"* y el turno muere. El usuario se queda viendo un error crudo en WhatsApp.

Esto nos pasó en producción. Tres veces. Con tres clientes distintos. La primera vez era un ZIP de 113 MB con 47 archivos de catálogo. La segunda, un PDF de 103 páginas con estados financieros. La tercera, un Excel con 15 hojas de precios.

La solución que construimos es un patrón de tres capas que intercepta la `Read` *antes* de que toque el archivo y redirige al agente hacia herramientas de extracción acotada. Es un patrón generalizable a cualquier SDK de agentes, no solo Anthropic.

## El problema: Read mete binarios al contexto

El SDK de Anthropic expone `Read` como herramienta built-in. Lee cualquier archivo del filesystem y lo devuelve como contenido al modelo. Para archivos de texto es perfecto. Para binarios es una bomba:

- Un PDF de 8 MB → cientos de miles de tokens → *"Prompt is too long"*
- Un ZIP de 100 MB con 47 archivos adentro → si lo descomprimes a ciegas, el agente intenta leer todo
- Una imagen JPG de WhatsApp que YA vio como adjunto multimodal → la re-lee desde `attachments/` como base64 gigante (~40K tokens) y satura el contexto después de un compact

El síntoma es silencioso: el turno aborta, el usuario ve el error literal de la API Anthropic, y no hay recovery automático. El agente perdió todo el contexto de esa interacción.

## El intento naïve: solo prompt guidance

Nuestra primera reacción fue instruir al agente en su `CLAUDE.md`:

```
NUNCA uses Read en PDFs. Usa pdf-reader extract --layout > archivo.txt
y procesa con grep/sed.
```

Funcionó… a veces. El agente ignora instrucciones en lenguaje natural cuando está bajo presión de contexto o cuando la herramienta `Read` está simplemente ahí, disponible, y el path de menor resistencia es llamarla. Los incidentes se repitieron.

Misma historia con el skill `big-files` que documenta el protocolo de inspección-y-pregunta para archivos >5 MB. El agente lo leía, lo entendía, y aún así a veces disparaba `Read` contra un PDF de 100 páginas porque el skill no es una restricción — es una sugerencia.

## La solución: defensa en tres capas

### Capa 1 — Skill prompting (guía blanda)

Los skills `pdf-reader`, `office-reader` y `big-files` documentan el protocolo correcto. El agente *sabe* que no debe leer binarios crudos. Esta capa existe para que cuando la capa 2 lo bloquea, el agente entienda por qué y sepa qué hacer.

### Capa 2 — PreToolUse hook (bloqueo determinista)

Aquí está el núcleo del patrón. El SDK de Anthropic expone un hook `PreToolUse` que se ejecuta *antes* de cada llamada a herramienta. Lo usamos como circuit breaker:

```ts
const readAttachmentGuardHook: HookCallback = async (input) => {
  const pre = input as PreToolUseHookInput;
  if (pre.tool_name !== 'Read') return {};

  const filePath = pre.tool_input?.file_path;
  if (typeof filePath !== 'string') return {};

  let reason = null;
  if (/\.(jpe?g|png|gif|webp)$/i.test(filePath)) {
    reason = 'No leas imágenes con Read — ya las viste como adjunto multimodal. '
           + 'Releerlas mete ~40K tokens de base64 al contexto.';
  } else if (/\.pdf$/i.test(filePath)) {
    reason = 'No leas PDFs con Read. Usa pdf-reader extract --layout > archivo.txt '
           + 'y procesa por partes con grep/sed.';
  } else if (/\.(xlsx?|docx?|zip|tar|rar|7z)$/i.test(filePath)) {
    reason = 'Usa office-reader o el protocolo big-files: inspecciona metadata primero.';
  }

  if (!reason) return {}; // dejar pasar

  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
};
```

Esto es **código, no prompt**. El hook no negocia. Si el archivo es PDF, imagen, Office o comprimido, la `Read` se deniega con un mensaje que redirige a la herramienta correcta. El modelo no tiene forma de saltarse esta restricción — el hook corre en el runtime del container, no en el loop de razonamiento del LLM.

La `permissionDecisionReason` es clave: no solo bloquea, sino que instruye. El agente recibe el mensaje de denegación en su siguiente turno y pivotea a la CLI correcta. El usuario nunca ve el error.

### Capa 3 — CLIs de extracción acotada

En lugar de meter el archivo al contexto, el agente usa scripts pequeños que extraen texto delimitado:

**`pdf-reader`** — wrapper de 200 líneas en bash sobre `pdftotext` / `pdfinfo` (poppler-utils):

```bash
# Solo metadata, cero tokens
pdf-reader info balances-2025.pdf

# Extraer a archivo, no al contexto
pdf-reader extract balances-2025.pdf --layout --pages 1-20 > /workspace/group/balance.txt

# Procesar con herramientas de texto
grep "EBITDA" balance.txt
head -50 balance.txt
```

**`office-reader`** — wrapper sobre `xlsx` y `mammoth` (npm):

```bash
# Metadata sin leer celdas
office-reader info precios.xlsx

# Extraer una sola hoja como CSV
office-reader extract precios.xlsx --sheet "Mayo" > precios-mayo.csv
```

El patrón universal: **extraer a archivo → inspeccionar con herramientas de texto → procesar por partes**. El binario nunca entra al prompt. El contexto crece de forma controlada según lo que el agente decide leer, no según el tamaño del archivo.

## ¿Por qué tres capas y no solo el hook?

Podrías pensar que con la capa 2 basta. Pero necesitas las tres:

- **Sin capa 1**: el agente se bloquea con "deny" y no sabe qué hacer. Pivotea a leer el archivo de otra forma o se queda trabado.
- **Sin capa 2**: el prompt guidance se ignora bajo presión (confirmado en producción, tres incidentes).
- **Sin capa 3**: no hay alternativa real. Bloquear `Read` sin dar herramientas de extracción solo cambia el problema de lugar.

## Generalizable a cualquier SDK

Esto no es específico de Anthropic. Cualquier agente que tenga acceso al filesystem va a intentar leer un binario grande eventualmente. El patrón se traduce así:

| SDK | Equivalente de la capa 2 |
|-----|--------------------------|
| Anthropic Agent SDK | `PreToolUse` hook |
| OpenAI Agents SDK | `before_tool` hook en `FunctionTool` |
| LangChain / LangGraph | Middleware en el `ToolNode` o guard en `@tool` |
| CrewAI | Decorator wrapper en `@tool` con chequeo de extensión |
| Raw API calls | Middleware en tu orchestrator que intercepte `tool_call` |

La capa 3 (CLIs de extracción) es universal: `pdftotext` existe en cualquier distro Linux. `xlsx` y `mammoth` son paquetes npm ubicuos. Si tu agente corre en un contenedor, ya tienes todo lo necesario.

## Incidentes que este patrón evitó

Después de implementar las tres capas:

- **Caribe Ventures (2026-06-11)**: llegó un PDF de 103 páginas con estados financieros. El hook bloqueó `Read`, el agente usó `pdf-reader info` → 103 páginas, preguntó al usuario qué sección necesitaba → extrajo solo páginas 1-5. El turno duró 40 segundos en lugar de morir.
- **Jarcería (2026-05-14, pre-patrón)**: ZIP de 113 MB, el agente intentó procesarlo de un golpe, "Prompt is too long", el cliente vio el error. *Este incidente fue el que disparó la construcción del patrón.*

## Lo que NO resuelve

- **Archivos de texto genuinamente enormes** (logs de 500K líneas). Ahí el problema no es binario sino volumen — necesitas `grep` o `head`/`tail` con conciencia de contexto, otro patrón distinto.
- **Agentes que genuinamente necesitan el archivo completo** (ej. "búscame todas las menciones de X en este PDF"). Ahí toca chunking + map-reduce, que es más caro pero inevitable.

Pero para el 90% de los casos — "mira este PDF que me mandaron", "cotiza los productos de este Excel", "¿qué trae este ZIP?" — este patrón convierte una falla catastrófica en una interacción normal.

## El código

Todo está en el repo de [NanoClaw](https://github.com/qwibitai/nanoclaw):

- El hook: [`readAttachmentGuardHook` en `agent-runner/src/index.ts`](https://github.com/qwibitai/nanoclaw/blob/main/container/agent-runner/src/index.ts#L236)
- Las CLIs: [`container/skills/pdf-reader/`](https://github.com/qwibitai/nanoclaw/tree/main/container/skills/pdf-reader) y [`container/skills/office-reader/`](https://github.com/qwibitai/nanoclaw/tree/main/container/skills/office-reader)
- Los skills: [`big-files/SKILL.md`](https://github.com/qwibitai/nanoclaw/blob/main/container/skills/big-files/SKILL.md), [`pdf-reader/SKILL.md`](https://github.com/qwibitai/nanoclaw/blob/main/container/skills/pdf-reader/SKILL.md)
