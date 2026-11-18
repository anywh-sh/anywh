import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { AgentModelEffortMenu } from "@/components/chat/AgentModelEffortButton";
import type { ModelCatalog, ModelChoice } from "@/lib/relay/relay-types";

// The three catalogs as each CLI's own probe returned them (Claude Code,
// Codex app-server, Kimi over ACP), trimmed only of fields the menu ignores.
const CLAUDE_EFFORTS = [{ id: "low" }, { id: "medium" }, { id: "high" }, { id: "xhigh" }, { id: "max" }];
export const claudeCatalog: ModelCatalog = {
  options: [
    { id: "opus", label: "Opus 5.5", description: "For complex work and everyday tasks", efforts: CLAUDE_EFFORTS },
    { id: "fable", label: "Fable 5.2", description: "For your toughest challenges", efforts: CLAUDE_EFFORTS },
    { id: "sonnet", label: "Sonnet 5.5", description: "Most efficient for simpler tasks", efforts: CLAUDE_EFFORTS },
    { id: "haiku", label: "Haiku 5.5", description: "Fastest for quick answers", efforts: CLAUDE_EFFORTS },
    { id: "claude-fable-5-1", label: "Fable 5.1", pinnedVersion: true, efforts: CLAUDE_EFFORTS },
    { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", pinnedVersion: true },
    { id: "claude-sonnet-5", label: "Sonnet 5", pinnedVersion: true, efforts: CLAUDE_EFFORTS },
    { id: "claude-opus-5", label: "Opus 5", pinnedVersion: true, efforts: CLAUDE_EFFORTS },
    { id: "claude-fable-5", label: "Fable 5", pinnedVersion: true, efforts: CLAUDE_EFFORTS },
    { id: "claude-opus-4-8", label: "Opus 4.8", pinnedVersion: true, efforts: CLAUDE_EFFORTS },
    { id: "claude-opus-4-7", label: "Opus 4.7", pinnedVersion: true, efforts: CLAUDE_EFFORTS },
    { id: "claude-opus-4-6", label: "Opus 4.6", pinnedVersion: true, efforts: [{ id: "low" }, { id: "medium" }, { id: "high" }, { id: "max" }] },
    { id: "claude-sonnet-4-6", label: "Sonnet 4.6", pinnedVersion: true, efforts: [{ id: "low" }, { id: "medium" }, { id: "high" }, { id: "max" }] },
  ],
  defaultId: "opus",
};

export const codexCatalog: ModelCatalog = {
  options: [
    {
      id: "gpt-5.6-terra",
      label: "GPT-5.6-Terra",
      description: "Legacy balanced model for agentic coding.",
      efforts: [
        { id: "low", description: "Fast responses with lighter reasoning" },
        { id: "medium", description: "Balances speed and reasoning depth for everyday tasks" },
        { id: "high", description: "Greater reasoning depth for complex problems" },
        { id: "xhigh", description: "Extra high reasoning depth for complex problems" },
        { id: "max", description: "Maximum reasoning depth for the hardest problems" },
        { id: "ultra", description: "Maximum reasoning with automatic task delegation" },
      ],
      defaultEffort: "medium",
    },
    { id: "gpt-5.6-luna", label: "GPT-5.6-Luna", description: "Legacy fast model for simpler tasks.", efforts: [{ id: "low" }, { id: "medium" }, { id: "high" }], defaultEffort: "medium" },
  ],
  defaultId: "gpt-5.6-terra",
};

const KIMI_EFFORTS = [{ id: "low" }, { id: "high" }, { id: "max" }];
export const kimiCatalog: ModelCatalog = {
  options: [
    { id: "kimi-code/kimi-for-coding", label: "K2.8 Preview", efforts: KIMI_EFFORTS, defaultEffort: "high" },
    { id: "kimi-code/kimi-for-coding-highspeed", label: "K2.7 Code Highspeed", efforts: [{ id: "on" }, { id: "high" }], defaultEffort: "high" },
    { id: "kimi-code/k3-256k", label: "K3-256k", efforts: KIMI_EFFORTS, defaultEffort: "high" },
    { id: "kimi-code/k3.1-pro-highspeed", label: "K3.1 Pro Highspeed 2x Usage Cost", efforts: KIMI_EFFORTS, defaultEffort: "high" },
    { id: "kimi-code/k3", label: "K3", efforts: KIMI_EFFORTS, defaultEffort: "high" },
    { id: "kimi-code/k3.1-pro", label: "K3.1 Pro", efforts: KIMI_EFFORTS, defaultEffort: "high" },
  ],
  defaultId: "kimi-code/kimi-for-coding",
};

const CATALOGS: Record<string, ModelCatalog> = { claude: claudeCatalog, codex: codexCatalog, kimi: kimiCatalog };
const AGENTS = ["claude", "codex", "kimi"];

interface DemoProps {
  agents?: string[];
  agentId?: string | null;
  model?: ModelChoice | null;
  effort?: string | null;
  /** Omit to use the agent's own catalog; `null` = not probed yet. */
  catalog?: ModelCatalog | null;
  disabled?: boolean;
  locked?: boolean;
  defaultOpen?: boolean;
  defaultSubmenu?: "effort" | "more" | "agent";
}

/** The menu with its own state, the way the composer wires it: switching
 * agent swaps the catalog and clears model and effort. */
export function Demo({ agents = AGENTS, agentId = "claude", model = null, effort = null, catalog, disabled = false, locked = false, defaultOpen = true, defaultSubmenu }: DemoProps) {
  const [agent, setAgent] = useState(agentId);
  const [pickedModel, setModel] = useState(model);
  const [pickedEffort, setEffort] = useState(effort);
  const shownCatalog = catalog !== undefined && agent === agentId ? catalog : agent !== null ? (CATALOGS[agent] ?? null) : null;
  return (
    // Room below and to the right, so the open menu and its submenu fit.
    <div className="h-[460px] w-[620px] bg-background p-4">
      <div className="flex w-fit items-center border border-border bg-surface px-2 py-1.5">
        <AgentModelEffortMenu
          agents={agents}
          agentId={agent}
          onChangeAgent={(next) => {
            setAgent(next);
            setModel(null);
            setEffort(null);
          }}
          model={pickedModel}
          catalog={shownCatalog}
          onChangeModel={setModel}
          effort={pickedEffort}
          onChangeEffort={setEffort}
          disabled={disabled}
          locked={locked}
          defaultOpen={defaultOpen}
          defaultSubmenu={defaultSubmenu}
        />
      </div>
    </div>
  );
}

const meta = {
  title: "Chat/AgentModelEffortMenu",
  component: Demo,
  excludeStories: /^[a-z]/,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof Demo>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Closed, as it sits in the composer toolbar. Click it and play: 1–9 pick a
 * model, the submenus open on hover. */
export const Playground: Story = { args: { defaultOpen: false } };

/** Claude's current line-up at the top level, each with its digit. */
export const Claude: Story = { args: {} };

/** Effort is a submenu: what it costs, then the levels. Claude reports no
 * default level of its own, so "Default" is a row. */
export const EffortSubmenu: Story = { args: { effort: "high", defaultSubmenu: "effort" } };

/** The exact versions Claude also lists, one hover away. A session on one of
 * them names it on the row. */
export const MoreModels: Story = { args: { model: "claude-opus-4-6", defaultSubmenu: "more" } };

/** The relay's other runtimes. Switching swaps the catalog in place. */
export const AgentSubmenu: Story = { args: { defaultSubmenu: "agent" } };

/** Codex: no pinned versions, so no "More models"; its own default level is
 * badged instead of a "Default" row. */
export const CodexEffort: Story = { args: { agentId: "codex", defaultSubmenu: "effort" } };

/** Kimi: six models, none pinned — all at the top level. */
export const Kimi: Story = { args: { agentId: "kimi" } };

/** After the first turn: model and agent fixed, effort still per turn. */
export const Locked: Story = { args: { locked: true, effort: "max" } };

/** A relay with one agent: no agent row at all. */
export const SingleAgent: Story = { args: { agents: ["claude"] } };

/** Before the first `model_state`: the trigger waits, disabled. */
export const Pending: Story = { args: { defaultOpen: false, disabled: true, catalog: null, agentId: null } };
