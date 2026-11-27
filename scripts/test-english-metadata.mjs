import assert from "node:assert/strict";
import { test } from "node:test";
import { englishToolMetadata } from "../src/tool-english.mjs";

process.env.NO_LISTEN = "1";
const { TOOL_DEFINITIONS, TOOLS } = await import("../src/server.mjs");

function omitDescriptions(value) {
  if (Array.isArray(value)) return value.map(omitDescriptions);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== "description")
    .map(([key, entry]) => [key, omitDescriptions(entry)]));
}

function collectDescriptions(value, result = []) {
  if (Array.isArray(value)) {
    for (const entry of value) collectDescriptions(entry, result);
  } else if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (key === "description" && typeof entry === "string") result.push(entry);
      else collectDescriptions(entry, result);
    }
  }
  return result;
}

test("all 42 MCP tool declarations expose English descriptions", () => {
  assert.equal(TOOLS.length, 42);
  assert.equal(new Set(TOOLS.map(tool => tool.name)).size, 42);
  for (const tool of TOOLS) {
    assert.match(tool.description, /^[A-Z]/, tool.name);
    const descriptions = collectDescriptions(tool.inputSchema);
    for (const description of descriptions) {
      assert.equal(typeof description, "string", tool.name);
      assert.ok(description.length > 8, `${tool.name}: incomplete description`);
      assert.doesNotMatch(description, /[àâçéèêëîïôùûüÿœ]|(?:Défaut|Scène|Jeton|Compendium du monde)/iu,
        `${tool.name}: untranslated description`);
    }
  }
});

test("English metadata preserves every input key, enum, default and other schema property", () => {
  assert.deepEqual(omitDescriptions(TOOLS), omitDescriptions(TOOL_DEFINITIONS));
  assert.notStrictEqual(TOOLS[0], TOOL_DEFINITIONS[0]);
  assert.notStrictEqual(TOOLS[0].inputSchema, TOOL_DEFINITIONS[0].inputSchema);
});

test("new described schema fields must have an explicit English translation", () => {
  assert.throws(() => englishToolMetadata({
    name: "gm_token",
    inputSchema: { type: "object", properties: {
      untranslated_future_field: { type: "string", description: "Future description" }
    } }
  }), /Missing English schema description for gm_token\.untranslated_future_field/);
});
