import { ChoiceCard } from "@/components/chat/ChoiceCard";
import { useRelayClient } from "@/hooks/relay/useRelayClient";
import { useDict } from "@/i18n";
import type { RoomAgent } from "@/lib/relay/roomClient";
import type { Profile } from "@/lib/profiles/profiles";

interface AgentAnswerProps {
  profile: Profile;
  agent: RoomAgent;
  onOpenConversation: () => void;
  onClose: () => void;
}

/**
 * What an agent asked, answerable in place: anchored under its card, the same
 * question card a conversation shows, and a way into the whole conversation.
 * It holds the agent's session socket only while it is open.
 */
export function AgentAnswer({ profile, agent, onOpenConversation, onClose }: AgentAnswerProps) {
  const text = useDict().sala.answer;
  const session = useRelayClient(profile, agent.agentId);
  const prompt = session.choicePrompt;
  return (
    <div
      className="sala-answer"
      data-nodrag
      role="dialog"
      aria-label={text.label}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      {prompt ? (
        <ChoiceCard
          key={prompt.promptId}
          promptId={prompt.promptId}
          questions={prompt.questions}
          kind={prompt.kind}
          onAnswer={(answers) => {
            session.answerChoice(answers);
            onClose();
          }}
        />
      ) : (
        <p className="sala-answer-wait">{text.connecting}</p>
      )}
      <div className="sala-answer-foot">
        <button type="button" onClick={onOpenConversation}>
          {text.openConversation}
        </button>
      </div>
    </div>
  );
}
