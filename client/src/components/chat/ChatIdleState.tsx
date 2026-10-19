import { IdleScreen } from "@/components/shell/IdleScreen";
import { useDict } from "@/i18n";
import { isIOS } from "@/lib/platform/platform";

/** Shown in place of the log while the tab is a new conversation with no
 * messages yet — avoids the "loading history" skeleton (which makes no
 * sense here, there's no history at all to load) and the blank-screen
 * feeling while the connection to the relay hasn't confirmed yet.
 *
 * On desktop it is just a heading: `ChatPanel` centres it together with the
 * composer, so the first thing on a new session is the question and the box
 * to answer it in. iOS keeps the full idle screen above its native composer. */
export function ChatIdleState() {
  const dict = useDict();
  if (isIOS()) return <IdleScreen heading={dict.common.untitledSession} subtitle={dict.chat.log.idleSubtitle} />;
  return (
    <h2 className="shrink-0 px-6 pb-8 text-center font-display text-[34px] leading-tight font-bold tracking-[-0.03em] text-foreground">
      {dict.chat.log.idleTitle}
    </h2>
  );
}
