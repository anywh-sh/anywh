import { test } from "node:test";
import assert from "node:assert/strict";
import { capitalizePlanValue, claudePlanLabel, codexPlanLabel } from "./planLabel.js";

test("claude: Max variant from the user tier, else the organization's", () => {
  assert.deepEqual(claudePlanLabel({ subscriptionType: "max", organizationRateLimitTier: "default_claude_max_5x" }), {
    family: "max",
    label: "Max 5x",
    variantSource: "claude_json_tier",
  });
  assert.equal(claudePlanLabel({ subscriptionType: "max", organizationRateLimitTier: "default_claude_max_20x" })?.label, "Max 20x");
  assert.equal(
    claudePlanLabel({ subscriptionType: "max", userRateLimitTier: "default_claude_max_20x", organizationRateLimitTier: "default_claude_max_5x" })?.label,
    "Max 20x",
  );
});

test("claude: Max without a recognized tier is plain Max, with no variant source", () => {
  assert.deepEqual(claudePlanLabel({ subscriptionType: "max" }), { family: "max", label: "Max" });
  assert.deepEqual(claudePlanLabel({ subscriptionType: "max", organizationRateLimitTier: "default_raven", userRateLimitTier: null }), {
    family: "max",
    label: "Max",
  });
});

test("claude: the base table, with no tier suffix outside Max", () => {
  assert.equal(claudePlanLabel({ subscriptionType: "pro" })?.label, "Pro");
  assert.equal(claudePlanLabel({ subscriptionType: "enterprise" })?.label, "Enterprise");
  // Team with a Max-looking user tier stays Team in the first cut (D9c).
  assert.deepEqual(
    claudePlanLabel({ subscriptionType: "team", authMethod: "claude.ai", userRateLimitTier: "default_claude_max_5x", organizationRateLimitTier: "default_raven" }),
    { family: "team", label: "Team" },
  );
});

test("claude: an unknown value is shown capitalized, normalized", () => {
  assert.deepEqual(claudePlanLabel({ subscriptionType: " Ultra_Plus " }), { family: "ultra_plus", label: "Ultra Plus" });
});

test("claude: no plan without a subscription or with a non-claude.ai login", () => {
  assert.equal(claudePlanLabel({}), undefined);
  assert.equal(claudePlanLabel({ subscriptionType: "" }), undefined);
  assert.equal(claudePlanLabel({ subscriptionType: null }), undefined);
  assert.equal(claudePlanLabel({ subscriptionType: "max", authMethod: "api_key" }), undefined);
  assert.equal(claudePlanLabel({ subscriptionType: "max", authMethod: "claude.ai" })?.label, "Max");
});

test("codex: the whole planType table", () => {
  const expected: Record<string, string> = {
    free: "Free",
    go: "Go",
    plus: "Plus",
    pro: "Pro",
    prolite: "Pro Lite",
    team: "Team",
    business: "Business",
    self_serve_business_prolite: "Business",
    self_serve_business_usage_based: "Business",
    enterprise: "Enterprise",
    enterprise_cbp_automation: "Enterprise",
    enterprise_cbp_usage_based: "Enterprise",
    ent26: "Enterprise",
    edu: "Edu",
    edu_plus: "Edu Plus",
    edu_pro: "Edu Pro",
  };
  for (const [planType, label] of Object.entries(expected)) {
    assert.deepEqual(codexPlanLabel(planType), { family: planType, label }, planType);
  }
});

test("codex: unknown or missing is no chip; a value outside the enum is shown capitalized", () => {
  assert.equal(codexPlanLabel("unknown"), undefined);
  assert.equal(codexPlanLabel(null), undefined);
  assert.equal(codexPlanLabel(undefined), undefined);
  assert.deepEqual(codexPlanLabel("plus_max"), { family: "plus_max", label: "Plus Max" });
});

test("capitalizePlanValue splits on underscores, dashes and spaces", () => {
  assert.equal(capitalizePlanValue("a_b-c d"), "A B C D");
  assert.equal(capitalizePlanValue("solo"), "Solo");
});
