import { StepList, type StepStatus } from "@/components/shell/StepList";
import { useDict } from "@/i18n";
import type { SetupMode, SetupState } from "@/lib/profiles/profileSetup";

type StepKey = "claim" | "connect" | "verify";

const TAILNET_STEPS: StepKey[] = ["claim", "connect", "verify"];
const STEP_INDEX: Record<StepKey, number> = { claim: 0, connect: 1, verify: 2 };

/** A direct (`host`+`port`) profile has nothing to claim or join — both are
 * synchronous no-ops (`profileSetup.ts`'s `connectStep`) — so the step list
 * for that mode is just the one step that actually does anything. */
function stepsForMode(mode: SetupMode): StepKey[] {
  return mode === "direct" ? ["verify"] : TAILNET_STEPS;
}

function statusFor(step: StepKey, state: SetupState): StepStatus {
  if (state.status === "ready") return "done";
  if (state.mode === "direct") {
    // Only "verify" is ever rendered in this mode — claiming/connecting are
    // folded into the same row since nothing in the UI distinguishes them.
    return state.status === "failed" ? "failed" : "running";
  }
  if (state.status === "failed") {
    const failedIndex = STEP_INDEX[state.stage];
    const stepIndex = STEP_INDEX[step];
    if (stepIndex < failedIndex) return "done";
    return stepIndex === failedIndex ? "failed" : "pending";
  }
  const currentIndex = STEP_INDEX[state.status === "claiming" ? "claim" : state.status === "connecting" ? "connect" : "verify"];
  const stepIndex = STEP_INDEX[step];
  if (stepIndex < currentIndex) return "done";
  return stepIndex === currentIndex ? "running" : "pending";
}

/** Renders as many rows as `state.mode` actually has steps for — the list
 * itself is derived, not fixed, so a direct-mode profile never shows a
 * "claim" or "connect" row it never meaningfully passes through. */
export function ProfileSetupStepList({ state }: { state: SetupState }) {
  const copy = useDict().shell.profiles.setup;
  const steps = stepsForMode(state.mode).map((step) => ({ key: step, label: copy.steps[step], status: statusFor(step, state) }));
  return <StepList steps={steps} label={copy.progress} />;
}
