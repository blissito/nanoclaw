# Orquestación de Agentes IA: Qué es, por qué importa, y cómo elegir tu camino

## El problema que todos están resolviendo

Imagina que tienes un equipo de desarrolladores. Cada uno puede escribir código, correr tests, y abrir pull requests. Ahora imagina que esos desarrolladores son agentes de IA — y que puedes tener 10 trabajando al mismo tiempo en tu repo.

Eso es la orquestación de agentes. Y en 2026, es el tema más caliente en tooling para developers.

Pero como todo lo caliente, viene con mucho humo. Así que vamos a separar lo real de lo marketero.

---

## Qué es un "swarm" de agentes

El patrón es simple. Tan simple que lo puedes dibujar en una servilleta:

```
Usuario manda tarea
       |
   Conductor
   /   |   \
  W1   W2   W3   ← Workers (agentes independientes)
   \   |   /
   Resultados
       |
   Respuesta final
```

1. Un **conductor** recibe una tarea grande
2. La descompone en subtareas independientes
3. Spawea **workers** — cada uno con su propio contexto aislado
4. Cada worker ejecuta su subtarea
5. El conductor recolecta resultados y sintetiza la respuesta

Eso es todo. No hay magia. La complejidad real está en *cómo* aislas a cada worker y *qué tan bien* diseñas los prompts.

---

## Agent Orchestrator (Composio): el enfoque "CI/CD para agentes"

[Agent Orchestrator](https://github.com/ComposioHQ/agent-orchestrator) es una herramienta open source de Composio que implementa este patrón específicamente para **desarrollo de software en equipo**. Su modelo mental es:

> "Cada issue de GitHub es una tarea. Cada tarea le toca a un agente. Cada agente trabaja en su propio branch."

### Cómo funciona

```bash
npm install -g @composio/ao
ao start https://github.com/tu-org/tu-repo
```

Con eso:

- Clona tu repo
- Crea un **git worktree** por cada agente (un directorio aislado con su propio branch)
- Asigna issues abiertos a workers
- Cada worker lee código, escribe cambios, abre un PR
- Si el CI falla, el agente recibe el error y lo arregla solo
- Si un reviewer deja comentarios, el agente los procesa

Todo supervisado desde un dashboard en `localhost:3000`.

### Lo que hace bien

- **Aislamiento via git worktrees**: cada agente tiene su propio filesystem sin pisar al otro
- **Reactions**: CI falla → el agente se entera automáticamente y reintenta. Review con cambios pedidos → el agente los procesa. Es un feedback loop cerrado
- **Pluggable**: soporta Claude Code, Codex, Aider como agentes. tmux, Docker o Kubernetes como runtime. GitHub o Linear como tracker
- **Pensado para equipos**: múltiples devs supervisando múltiples agentes en un repo compartido

### Para quién es

Agent Orchestrator brilla si tu flujo es:

- Tienes un backlog de issues en GitHub
- Quieres que N agentes ataquen N issues en paralelo
- Tu código vive en un monorepo o repo compartido
- Necesitas que cada cambio pase por CI y code review

Es, esencialmente, un **junior developer infinitamente paciente** multiplicado por N.

---

## NanoClaw: el enfoque "asistente personal con canales"

NanoClaw resuelve un problema diferente. No es un CI/CD de agentes — es un **sistema nervioso personal** que conecta tu IA con el mundo real a través de canales de mensajería.

### El modelo mental

```
WhatsApp / Telegram / Slack / Discord / Gmail
              |
         Orquestador (Node.js)
              |
     Container aislado (Linux VM)
     - Claude Agent SDK
     - Herramientas MCP
     - Filesystem propio
     - Memoria persistente
              |
         Respuesta al canal
```

Cada mensaje que llega a cualquier canal se rutea al orquestador. El orquestador spawea un container con el Agent SDK de Claude adentro. Ese container tiene:

- **Aislamiento real**: no es un worktree, es una VM con su propio filesystem
- **Memoria persistente por grupo**: cada chat tiene su propio `CLAUDE.md` que acumula contexto
- **Herramientas MCP**: el agente puede navegar la web, manejar archivos, consultar APIs
- **Canales bidireccionales**: no solo recibe — responde por el mismo canal

### Por qué importa este enfoque

La mayoría de las herramientas de agentes asumen que el developer está sentado frente a la terminal. NanoClaw asume lo contrario: **que no estás ahí**.

Tu agente:
- Recibe un mensaje de WhatsApp a las 3am
- Procesa la petición en un container aislado
- Consulta tus datos, genera un reporte, o ejecuta una tarea
- Te responde por el mismo WhatsApp

No necesitas abrir la laptop. No necesitas un dashboard. El canal de comunicación ya existe — es el mismo que usas para hablar con humanos.

### Para quién es

NanoClaw brilla si:

- Quieres un asistente que viva en tus canales de comunicación existentes
- Necesitas aislamiento real (containers, no branches)
- Tu caso de uso es más amplio que "resolver issues de GitHub"
- Quieres automatizar tareas que no son solo código: CRM, dashboards, investigación
- Valoras la memoria persistente — que el agente recuerde quién eres y qué hiciste antes

---

## La comparación honesta

| Dimensión | Agent Orchestrator | NanoClaw |
|---|---|---|
| **Metáfora** | Equipo de juniors en tu repo | Asistente personal omnipresente |
| **Input** | Issues de GitHub | Mensajes de cualquier canal |
| **Output** | Pull requests | Respuestas + acciones en el canal |
| **Aislamiento** | Git worktrees (branches) | Containers (VMs completas) |
| **Paralelismo** | N agentes en N issues | 1 agente por grupo/chat |
| **Memoria** | No (stateless por tarea) | Sí (persistente por grupo) |
| **Runtime** | tmux / Docker / K8s | Docker / Apple Containers |
| **Canales** | GitHub | WhatsApp, Telegram, Slack, Discord, Gmail |
| **Caso ideal** | Backlog grande, equipo dev | Asistente personal/negocio |

No compiten. Son complementarios. Podrías usar Agent Orchestrator para atacar tu backlog y NanoClaw para que tu agente te avise por Telegram cuando los PRs están listos.

---

## Lo que importa de verdad (más allá de las herramientas)

Si estás empezando con agentes, estos son los principios que aplican sin importar qué herramienta uses:

### 1. Aislamiento no es opcional

Un agente sin aislamiento es un script con acceso root y sin supervisión. Ya sea con worktrees, containers, o procesos separados — cada agente necesita su sandbox.

### 2. El prompt es el 90% del trabajo

La infraestructura de orquestación es plomería. Lo que determina si tu swarm funciona o produce basura es la calidad de los prompts de cada worker. Un conductor que descompone mal las tareas produce N agentes haciendo N cosas inútiles en paralelo.

### 3. Feedback loops > más agentes

Tres agentes con buen feedback loop (CI falla → agente corrige → CI pasa) le ganan a diez agentes sin uno. Agent Orchestrator entiende esto con sus "reactions". NanoClaw lo implementa con IPC entre orquestador y containers.

### 4. No todo necesita un swarm

Si tu tarea se resuelve con un solo agente en 30 segundos, spawear un conductor + 3 workers es overengineering. El patrón swarm existe para tareas que son **genuinamente paralelizables e independientes**.

### 5. La memoria es el moat

Un agente que recuerda tu contexto, tus preferencias, y tu historial es exponencialmente más útil que uno que empieza de cero cada vez. Esta es probablemente la diferencia más subestimada entre los distintos enfoques.

---

## Por dónde empezar

**Si eres web developer y quieres probar orquestación de agentes:**

1. Empieza con un solo agente. Asegúrate de que hace bien UNA cosa
2. Cuando el cuello de botella sea "necesito que haga varias cosas al mismo tiempo", ahí sí piensa en swarm
3. Elige tu herramienta según tu caso de uso: ¿issues de GitHub → Agent Orchestrator? ¿asistente en tus canales → NanoClaw?
4. No te cases con frameworks. El patrón conductor/worker es tan viejo como la computación distribuida. Las herramientas van y vienen; los principios se quedan

**El stack mínimo para experimentar:**

```bash
# Opción A: orquestación de código
npm install -g @composio/ao
ao start https://github.com/tu-repo

# Opción B: asistente en canales
git clone https://github.com/qwibitai/nanoclaw
cd nanoclaw && npm install && npm run dev
```

---

## Conclusión

La orquestación de agentes no es el futuro — es el presente. Pero no es magia. Es coordinación, aislamiento, y buenos prompts.

Lo más importante no es cuántos agentes puedes correr en paralelo. Es cuánto valor produce cada uno. Un solo agente bien configurado, con memoria persistente y acceso a tus herramientas, le gana a un ejército de agentes genéricos ejecutando tareas sin contexto.

Elige la herramienta que se ajuste a tu problema real, no al hype del momento. Y empieza simple — siempre empieza simple.
