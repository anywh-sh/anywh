import { Plug } from "lucide-react";
import { connectorMark } from "@/lib/sala/connectorMarks";

/** The mark of a connected service, or a plug for one this build does not know. */
export function ConnectorLogo({ server, className }: { server: string; className?: string }) {
  const mark = connectorMark(server);
  if (!mark) return <Plug className={className} aria-hidden="true" />;
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <path d={mark.path} />
    </svg>
  );
}
