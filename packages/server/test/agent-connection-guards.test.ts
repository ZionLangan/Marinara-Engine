import test from "node:test";
import assert from "node:assert/strict";
import { LOCAL_SIDECAR_CONNECTION_ID } from "@marinara-engine/shared";
import {
  buildDefaultAgentConnectionWarning,
  buildLocalSidecarUnavailableWarning,
  isLocalSidecarConnectionId,
  resolveAgentConnectionId,
} from "../src/routes/generate/agent-connection-guards.js";

test("detects explicit Local Model connection ids", () => {
  assert.equal(LOCAL_SIDECAR_CONNECTION_ID, "__local_sidecar__");
  assert.equal(isLocalSidecarConnectionId(LOCAL_SIDECAR_CONNECTION_ID), true);
  assert.equal(isLocalSidecarConnectionId("regular-connection"), false);
  assert.equal(isLocalSidecarConnectionId(null), false);
});

test("falls back to the default agent connection when Local Model is unavailable", () => {
  assert.equal(
    resolveAgentConnectionId({
      requestedConnectionId: LOCAL_SIDECAR_CONNECTION_ID,
      defaultAgentConnectionId: "paid-agent-default",
      localSidecarAvailable: false,
    }),
    "paid-agent-default",
  );
});

test("skips Local Model agents only when no default agent fallback is configured", () => {
  assert.equal(
    resolveAgentConnectionId({
      requestedConnectionId: LOCAL_SIDECAR_CONNECTION_ID,
      defaultAgentConnectionId: null,
      localSidecarAvailable: false,
    }),
    "skip-local-sidecar",
  );
});

test("keeps Local Model when the sidecar is available", () => {
  assert.equal(
    resolveAgentConnectionId({
      requestedConnectionId: LOCAL_SIDECAR_CONNECTION_ID,
      defaultAgentConnectionId: "paid-agent-default",
      localSidecarAvailable: true,
    }),
    LOCAL_SIDECAR_CONNECTION_ID,
  );
});

test("builds a user-visible warning for skipped local-only agents", () => {
  const warning = buildLocalSidecarUnavailableWarning(["Memory Tracker", "Scene Tracker"]);

  assert.equal(warning.code, "local_sidecar_unavailable");
  assert.equal(warning.fallbackPrevented, true);
  assert.deepEqual(warning.agentNames, ["Memory Tracker", "Scene Tracker"]);
  assert.match(warning.message, /Local Model/);
  assert.match(warning.message, /skipped these agents/);
  assert.match(warning.message, /paid API connection/);
});

test("builds a billing warning for default agent connections", () => {
  const warning = buildDefaultAgentConnectionWarning({
    agentNames: ["Scene Tracker"],
    connectionName: "Opus",
    model: "claude-opus-4.7",
  });

  assert.equal(warning.code, "default_agent_connection_active");
  assert.equal(warning.connectionName, "Opus");
  assert.equal(warning.model, "claude-opus-4.7");
  assert.match(warning.message, /default agent connection "Opus"/);
  assert.match(warning.message, /paid API model/);
});
