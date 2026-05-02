# Agent System — Developer Reference

This document covers how agents work in Marinara Engine, how existing agents are designed,
and how to build new ones. Written for AI-assisted development using mid-range models
(e.g. GLM 4.5, Mistral, Gemini Flash).

---

## 1. What Agents Are

Agents are small, single-purpose LLM sub-calls that run alongside the main chat generation.
Each agent receives the same conversation context (characters, lorebook, game state, recent
messages) and returns a typed result that the engine applies automatically — updating the
world state tracker, selecting a character sprite, appending a quest entry, rewriting prose,
and so on.

Agents are **not** the main generation. They are wired into the generation pipeline and run
before, during, or after the user sees the reply.

---

## 2. Execution Phases

Every agent declares exactly one phase:

| Phase | When it runs | Can modify main prompt? | Receives `mainResponse`? |
|---|---|---|---|
| `pre_generation` | Before the main LLM call | Yes (context injection) | No |
| `parallel` | Alongside main generation | No | No |
| `post_processing` | After main response is complete | No | Yes |

**Use `pre_generation`** when the agent needs to steer or constrain the upcoming reply
(e.g. Prose Guardian, Secret Plot Driver, Narrative Director).

**Use `post_processing`** for analysis or extraction after the reply already exists
(e.g. World State, Quest Tracker, Expression Engine, Lorebook Keeper).

**Use `parallel`** for side-effects that don't depend on the reply and don't need to
block anything (e.g. Echo Chamber, Combat tracker).

---

## 3. Core Files

| What | Path |
|---|---|
| Shared type definitions | `packages/shared/src/types/agent.ts` |
| Zod validation schemas | `packages/shared/src/schemas/agent.schema.ts` |
| Default prompt templates | `packages/shared/src/constants/agent-prompts.ts` |
| Database schema | `packages/server/src/db/schema/agents.ts` |
| Storage layer (CRUD + memory) | `packages/server/src/services/storage/agents.storage.ts` |
| REST API routes | `packages/server/src/routes/agents.routes.ts` |
| LLM execution (single + tool loop) | `packages/server/src/services/agents/agent-executor.ts` |
| Phase orchestration + batching | `packages/server/src/services/agents/agent-pipeline.ts` |
| Generation integration | `packages/server/src/routes/generate.routes.ts` (search `createAgentPipeline`) |
| React hooks | `packages/client/src/hooks/use-agents.ts` |
| Client UI state | `packages/client/src/stores/agent.store.ts` |

---

## 4. Key Types

### `AgentConfig` (`packages/shared/src/types/agent.ts:43`)

The persisted configuration for one agent instance:

```typescript
interface AgentConfig {
  id: string;                        // UUID assigned on creation
  type: string;                      // Matches BUILT_IN_AGENT_IDS key (e.g. "world-state")
  name: string;                      // Display name shown in UI
  description: string;
  phase: "pre_generation" | "parallel" | "post_processing";
  enabled: boolean;                  // Global on/off toggle
  connectionId: string | null;       // Override LLM connection; null = inherit from chat
  promptTemplate: string;            // Custom prompt; "" = use DEFAULT_AGENT_PROMPTS[type]
  settings: Record<string, unknown>; // contextSize, temperature, maxTokens, runInterval, …
  tools: ToolDefinition[];           // Function definitions the agent can call
  toolConfig: AgentToolConfig | null;
}
```

### `AgentResultType` (`packages/shared/src/types/agent.ts:14`)

Every agent produces exactly one result type. The full list:

```
game_state_update    text_rewrite         sprite_change
echo_message         quest_update         image_prompt
context_injection    continuity_check     director_event
lorebook_update      character_card_update prompt_review
background_change    character_tracker_update
persona_stats_update custom_tracker_update
chat_summary         spotify_control      haptic_command
cyoa_choices         secret_plot          game_master_narration
party_action         game_map_update      game_state_transition
```

### `AgentContext` (`packages/shared/src/types/agent.ts:84`)

Everything the agent sees at runtime. Passed to every agent, regardless of type:

```typescript
interface AgentContext {
  chatId: string;
  chatMode: string;                      // "roleplay" | "conversation" | "game"
  recentMessages: Array<{
    role: string;
    content: string;
    characterId?: string;
    gameState?: GameState | null;        // Committed tracker state for that turn
  }>;
  mainResponse: string | null;           // Only set for post_processing agents
  gameState: GameState | null;           // Current running game state
  characters: Array<{
    id: string; name: string; description: string;
    personality?: string; scenario?: string; backstory?: string;
    // … other card fields
  }>;
  persona: {
    name: string; description: string;
    personaStats?: { enabled: boolean; bars: … };
    rpgStats?: { enabled: boolean; … };
  } | null;
  memory: Record<string, unknown>;       // This agent's own persistent KV store
  activatedLorebookEntries: Array<{
    id: string; name: string; content: string; tag: string;
  }> | null;
  writableLorebookIds: string[] | null;
  chatSummary: string | null;
}
```

---

## 5. How the Prompt Is Built

The engine builds the prompt in `buildAgentMessages()` (`agent-executor.ts:586`).
Understanding this structure is essential for writing good prompt templates.

### System message layout

```
<role>
You are a specialized agent. Fulfill your task and return the requested output.
</role>

<lore>
  <lorebook_entries>
    [tag] EntryName: content...
  </lorebook_entries>
  <characters>
    - CharName: description (up to 2 000 chars)
  </characters>
  <user_persona>
    Name: …
    Description: …
    Personality: …
    Backstory: …
    Appearance: …
    Scenario: …
    Configured persona stat bars: Name: value/max
    RPG Stats: …
  </user_persona>
</lore>

<agents>
Fulfill the requested task here and return the output in the format specified:
[YOUR PROMPT TEMPLATE IS INSERTED HERE]
</agents>

<!-- Optional extras added by the engine for specific agent types: -->
<available_sprites>
  CharName (charId): expression1, expression2, …
</available_sprites>

<current_game_state>
  { "date": "…", "time": "…", … }
</current_game_state>

<source_material>
  [full character card fields for card-evolution-auditor]
</source_material>

<secret_plot_state>
  { … }
</secret_plot_state>
```

### Message thread

After the system message, the engine appends recent chat history (up to `contextSize`
messages) as proper `user`/`assistant` turns, then closes with a final user message:

```
<assistant_response>
[main LLM response — post_processing agents only]
</assistant_response>

Now return the requested format(s).
```

Committed tracker state is embedded in the last 3 assistant messages as
`<committed_tracker_state>{ … }</committed_tracker_state>` to save tokens.

---

## 6. Response Parsing

Agents fall into two categories (`agent-executor.ts:924`):

**JSON agents** — The engine extracts JSON from the response (stripping markdown fences,
auto-repairing common issues). If parsing fails the result is stored with `parseError: true`.
These must return a valid JSON object or array matching their documented schema.

**Text agents** — The raw response text is stored as `{ text: responseText }`.
Currently: `prose-guardian`, `director`, `knowledge-retrieval`.

The mapping from agent type to result type lives in `AGENT_RESULT_TYPE_MAP`
(`agent-executor.ts:897`). Every built-in type must appear there.

---

## 7. Agent Settings Reference

Settings are stored as a free-form JSON object in `AgentConfig.settings`. Recognized keys:

| Key | Type | Default | Meaning |
|---|---|---|---|
| `contextSize` | number | `5` | How many recent messages to include |
| `temperature` | number | `0.3` | Lower = more predictable JSON output |
| `maxTokens` | number | `4096` | Hard cap on response length |
| `runInterval` | number | `1` | Run every N turns (1 = every turn) |
| `injectAsSection` | boolean | `false` | For pre-gen agents: inject as a named prompt section |
| `enabledTools` | string[] | per-type | Tool names this instance may call |

---

## 8. Tool Calling

If an agent has tools configured, execution goes through a loop
(`executeAgentWithTools`, `agent-executor.ts:186`):

1. Call LLM with `tools` defined.
2. If the model returns `tool_calls`, execute each via the `executeToolCall` callback.
3. Append tool results back to the message thread.
4. Repeat up to `MAX_TOOL_ROUNDS = 5`.
5. On the final call (or when no more tool calls), parse the text response normally.

Built-in tools per agent type are declared in `DEFAULT_AGENT_TOOLS`
(`packages/shared/src/types/agent.ts:491`). Common tools:

| Tool | Used by |
|---|---|
| `update_game_state` | World State, Combat |
| `search_lorebook` | Lorebook Keeper |
| `spotify_get_playlists`, `spotify_search`, `spotify_play` | Spotify |

---

## 9. Agent Batching

Agents that share the same LLM connection and model are batched into a single API call
(`agent-pipeline.ts:48`). The engine wraps each agent's task in:

```xml
<agent_task id="world-state" name="World State">
  [prompt template]
</agent_task>
```

And expects the model to respond with:

```xml
<result agent="world-state">
  { … }
</result>
```

**Agents that use tools are always run individually** — they cannot be batched.

---

## 10. Persistent Agent Memory

Each agent has its own key-value store scoped to a specific chat
(`agents.storage.ts:215`). Values survive across turns, swipes, and regenerations.

Access in the prompt template via `context.memory` at runtime.
The engine injects special memory keys as XML extras (e.g. `<secret_plot_state>`,
`<previous_cyoa_choices>`).

To write memory from within an agent, the agent must emit a result that the server-side
handler persists. The `secret-plot-driver` stores its arc in memory automatically after
each run. Custom tracker and persona-stats agents persist to the game state, not memory.

---

## 11. Existing Agents — Patterns and Templates

### Prose Guardian (`pre_generation` → `context_injection`)

- **Purpose:** Analyze recent messages for overused words/devices; emit writing directives.
- **Output format:** Plain text (not JSON). Six labeled sections.
- **Key design choice:** Works entirely from chat history — no game state needed.
- **`contextSize`:** Higher than default (8–10) to catch patterns across more messages.
- **Prompt pattern:** Numbered checklist analysis → structured text output.
- See default prompt: `DEFAULT_AGENT_PROMPTS["prose-guardian"]` (`agent-prompts.ts:25`).

### World State (`post_processing` → `game_state_update`)

- **Purpose:** Extract date, time, location, weather, temperature from the narrative.
- **Output format:** JSON with 5 nullable string fields.
- **Key design choice:** Infer sensible defaults rather than returning null; preserve
  continuity across turns.
- **Tool:** `update_game_state` — the agent reads current state and writes updates.
- **`contextSize`:** 5 (only recent messages needed).
- **Prompt pattern:** Schema + numbered instructions → JSON output.
- See: `DEFAULT_AGENT_PROMPTS["world-state"]` (`agent-prompts.ts:10`).

### Lorebook Keeper (`post_processing` → `lorebook_update`)

- **Purpose:** Create or update lorebook entries based on new facts revealed in the story.
- **Output format:** JSON: `{ action: "create"|"update"|"delete", entryName, content, keys, tag }`.
- **Tool:** `search_lorebook` — always search before creating to avoid duplicates.
- **Key design choice:** Uses tool calling to check existing entries; this agent always
  runs individually (no batching).
- See: `DEFAULT_AGENT_PROMPTS["lorebook-keeper"]` (`agent-prompts.ts:220`).

### Expression Engine (`post_processing` → `sprite_change`)

- **Purpose:** Pick a sprite expression for each character based on their current emotion.
- **Output format:** JSON array of `{ characterId, characterName, expression, transition }`.
- **Key design choice:** `characterId` must be the exact ID from `<available_sprites>` —
  strict extraction, not inference.
- **Context injected by engine:** `<available_sprites>` block listing valid expression names.
- See: `DEFAULT_AGENT_PROMPTS["expression"]` (`agent-prompts.ts:88`).

### Secret Plot Driver (`pre_generation` → `secret_plot`)

- **Purpose:** Maintain an overarching narrative arc and inject scene directions to keep
  the story from stagnating.
- **Output format:** JSON: `{ overarchingArc, sceneDirections, pacing, staleDetected }`.
- **Key design choice:** Arc is written to `agent.memory["overarchingArc"]` and persists
  across turns. Scene directions are ephemeral (per-turn only).
- **Critical agent:** If this fails, the entire generation is aborted (`generate.routes.ts:3974`).
- **Context injected by engine:** `<secret_plot_state>` from previous memory.
- See: `DEFAULT_AGENT_PROMPTS["secret-plot-driver"]` (`agent-prompts.ts:592`).

### Continuity Checker (`post_processing` → `continuity_check`)

- **Purpose:** Flag contradictions against established facts.
- **Output format:** JSON: `{ issues: [{ severity, description, suggestion }], verdict }`.
- **Key design choice:** False positives are acceptable — under-flagging is worse than
  over-flagging. Instructs the model to default to flagging when in doubt.
- See: `DEFAULT_AGENT_PROMPTS["continuity"]` (`agent-prompts.ts:65`).

---

## 12. Creating a New Agent — Step-by-Step

### Step 1 — Add the agent ID and metadata

In `packages/shared/src/types/agent.ts`:

```typescript
// 1a. Add to BUILT_IN_AGENT_IDS
export const BUILT_IN_AGENT_IDS = {
  // … existing entries …
  MY_AGENT: "my-agent",
} as const;

// 1b. Add to BUILT_IN_AGENTS array
export const BUILT_IN_AGENTS: BuiltInAgentMeta[] = [
  // … existing entries …
  {
    id: "my-agent",
    name: "My Agent",
    description: "One-sentence description shown in the UI.",
    phase: "post_processing",         // or pre_generation, parallel
    enabledByDefault: false,
    category: "tracker",              // writer | tracker | misc
    defaultInjectAsSection: false,    // omit if false
  },
];
```

### Step 2 — Register the result type mapping

In `packages/server/src/services/agents/agent-executor.ts`:

```typescript
// Add to AGENT_RESULT_TYPE_MAP (~line 897)
const AGENT_RESULT_TYPE_MAP: Record<string, AgentResultType> = {
  // … existing entries …
  "my-agent": "game_state_update",   // use the appropriate AgentResultType
};

// If your agent returns JSON, add it to JSON_AGENTS (~line 924)
const JSON_AGENTS = new Set([
  // … existing entries …
  "my-agent",
]);
```

### Step 3 — Write the default prompt template

In `packages/shared/src/constants/agent-prompts.ts`:

```typescript
export const DEFAULT_AGENT_PROMPTS: Record<string, string> = {
  // … existing entries …
  "my-agent": `[Your prompt here — see guidelines below]`,
};
```

### Step 4 — Add default tools (if needed)

In `packages/shared/src/types/agent.ts`, find `DEFAULT_AGENT_TOOLS` (~line 491):

```typescript
DEFAULT_AGENT_TOOLS: {
  // … existing entries …
  "my-agent": ["update_game_state"],  // or [] if no tools needed
}
```

### Step 5 — Add default settings (if non-standard)

In the same file, find `getDefaultBuiltInAgentSettings` (~line 474):

```typescript
function getDefaultBuiltInAgentSettings(agentType: string) {
  if (agentType === "my-agent") {
    return { runInterval: 3 };   // e.g. only run every 3 turns
  }
  // …
}
```

### Step 6 — Handle the result on the server (if it persists state)

If your agent mutates game state, a lorebook, or agent memory, the handler is in
`packages/server/src/routes/generate.routes.ts` in the `onResult` callback.
Follow the pattern of existing result handlers there (search for `case "game_state_update"`).

### Step 7 — Handle the result on the client (if it updates UI)

State is managed in `packages/client/src/stores/agent.store.ts`. For new UI behavior
(new panel, new indicator, etc.), add a field there and update the relevant component
under `packages/client/src/components/agents/`.

---

## 13. Prompt Writing Guidelines for Mid-Range Models

Mid-range models (GLM 4.5, Mistral 7B/8x7B, Gemini Flash, etc.) follow explicit
instructions well but struggle with ambiguity, schema drift, and hallucinated keys.
These guidelines apply specifically to agent prompt templates.

### Always specify the exact output format

Do not say "return a JSON object." Say:

```
Respond ONLY with valid JSON matching this exact schema:
{
  "field1": "string|null",
  "field2": "string[]",
  "field3": { "nested": "string" }
}
No commentary, no markdown fences, no extra keys.
```

### Use numbered instructions for multi-step reasoning

Mid-range models respect numbered lists. Break complex logic into steps:

```
1. Identify X from the latest assistant message.
2. Compare against Y in <committed_tracker_state>.
3. Only update Z if the narrative explicitly changed it.
4. If ambiguous, preserve the previous value — do not invent new values.
```

### Restrict null to genuine unknowns

Left unconstrained, models return null for anything uncertain.
Tell them to infer:

```
Set a field to null ONLY when there is genuinely no way to infer a value,
not simply because the text didn't state it explicitly.
(Example: a medieval tavern at dusk → time: "evening", weather: "clear" are safe inferences.)
```

### Forbid prose commentary in JSON agents

Models will add explanatory text before or after JSON unless told not to:

```
Return ONLY the JSON object. Do not include any explanation, commentary, or markdown fences.
```

### Give explicit "when in doubt" rules

Models stall or hallucinate when instructions are ambiguous.
Write a fallback for every case:

```
If no quest is active, return: { "quests": [], "verdict": "none_active" }
If the verdict is ambiguous, default to "minor_issues".
```

### Keep context references concrete

Reference the XML tags the engine injects so the model knows where to look:

```
Use the character ID from <available_sprites>, not the character name.
Refer to <committed_tracker_state> for current location — do not rely on your own memory.
```

### Token budget for mid-range models

| Agent role | Recommended `maxTokens` | Recommended `contextSize` |
|---|---|---|
| Tracker (world state, quests, expressions) | 512–1024 | 5–8 |
| Writer (prose guardian, director) | 512–768 | 8–12 |
| Lorebook / card auditor | 1024–2048 | 6–10 |
| Secret plot driver | 1024–2048 | 10–15 |
| Misc (echo chamber, cyoa) | 512 | 3–5 |

Lower `contextSize` reduces both latency and hallucination from stale context.
Use `runInterval` to skip turns where the agent's output wouldn't change
(e.g. World State doesn't need to run if no messages occurred).

---

## 14. Common Mistakes

**Returning text instead of JSON.**
JSON agents must return a parseable JSON object. The engine retries with repair, but
if the model returns a sentence like "Here is the state:" before the JSON, it may fail.
Solution: start the prompt with `Respond ONLY with valid JSON.`

**Using character names instead of IDs.**
The Expression Engine must use the exact `characterId` from `<available_sprites>`.
Prompt must say: "characterId MUST be the exact ID string from the parentheses."

**Modifying unrelated fields in game state.**
Tracker agents should only update fields explicitly changed by the narrative.
Prompt must say: "Only change what the narrative explicitly changed. Preserve all other fields."

**Forgetting to add to `AGENT_RESULT_TYPE_MAP`.**
If your agent type is missing from this map, the engine falls back to `context_injection`
and the result won't be applied correctly.

**Forgetting to add to `JSON_AGENTS`.**
If your agent returns JSON but isn't listed there, the raw text is stored unprocessed.

**Relying on model memory between turns.**
Agent prompts do not accumulate context automatically. Use `agent.memory` or
`<committed_tracker_state>` for persistence. Never write prompts that say
"remember what you said last turn" — the model has no access to prior outputs.

---

## 15. Quick Checklist for a New Agent

- [ ] `BUILT_IN_AGENT_IDS` entry in `agent.ts`
- [ ] `BUILT_IN_AGENTS` metadata entry in `agent.ts`
- [ ] `AGENT_RESULT_TYPE_MAP` entry in `agent-executor.ts`
- [ ] `JSON_AGENTS` entry in `agent-executor.ts` (if JSON output)
- [ ] Default prompt in `DEFAULT_AGENT_PROMPTS` in `agent-prompts.ts`
- [ ] `DEFAULT_AGENT_TOOLS` entry in `agent.ts` (even if empty `[]`)
- [ ] Server result handler in `generate.routes.ts` (if it changes persistent state)
- [ ] Client store field in `agent.store.ts` (if it has UI)
- [ ] `runInterval` / `injectAsSection` defaults if non-standard behavior needed
