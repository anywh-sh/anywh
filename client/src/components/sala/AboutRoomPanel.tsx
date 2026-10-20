import { useEffect, useMemo, useState } from "react";
import { FileText, Folder, GitBranch } from "lucide-react";
import { SalaSidePanel } from "@/components/sala/SalaSidePanel";
import { ConnectorLogo } from "@/components/sala/ConnectorLogo";
import { AreaIcon, RoomGlyph } from "@/components/sala/SalaIcons";
import { useRoomWorktrees } from "@/hooks/sala/useRoomWorktrees";
import { useDict } from "@/i18n";
import { fetchRoomContext, fetchRoomMembers, type RoomAgent, type RoomCanvas, type RoomContextItem, type RoomMemberInfo } from "@/lib/relay/roomClient";
import { connectorLabel } from "@/lib/sala/connectorMarks";
import { ageUnits, formatBytes, formatTokens, retainedWorktrees, roomCounts, usageRows } from "@/lib/sala/roomFigures";
import { isRoomCompleted } from "@/lib/sala/roomStatus";
import { cardStatus } from "@/lib/sala/agentCard";
import { profileColorVar, type Profile } from "@/lib/profiles/profiles";

interface AboutRoomPanelProps {
  profile: Profile;
  roomId: string;
  title: string;
  agents: readonly RoomAgent[];
  canvas: RoomCanvas;
  /** Changes whenever something an agent reports could have changed what the panel shows. */
  refreshKey: string;
  onClose: () => void;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="sala-side-sec">
      <h3 className="sala-side-h">{title}</h3>
      {children}
    </section>
  );
}

/**
 * "About this room": the headline numbers, where it runs, its areas, what
 * each agent has used, the connectors the agents called, the shared context
 * and the worktrees they made. Read from the relay when it opens and again
 * when the room's agents report something new.
 */
export function AboutRoomPanel({ profile, roomId, title, agents, canvas, refreshKey, onClose }: AboutRoomPanelProps) {
  const dict = useDict().sala.panel.aboutRoom;
  const [now] = useState(() => Date.now());
  const [members, setMembers] = useState<RoomMemberInfo[]>([]);
  const [context, setContext] = useState<RoomContextItem[] | null>(null);
  const worktrees = useRoomWorktrees(profile, roomId, refreshKey);

  useEffect(() => {
    let cancelled = false;
    fetchRoomMembers(profile, roomId).then(
      (next) => {
        if (!cancelled) setMembers(next);
      },
      (error: unknown) => console.error("[anywh] failed to read the room's usage", error),
    );
    fetchRoomContext(profile, roomId).then(
      (next) => {
        if (!cancelled) setContext(next.items);
      },
      (error: unknown) => console.error("[anywh] failed to read the room's context", error),
    );
    return () => {
      cancelled = true;
    };
    // The profile object is rebuilt on edits that do not change where it connects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.id, roomId, refreshKey]);

  const counts = useMemo(() => roomCounts(agents), [agents]);
  const principal = agents.find((a) => a.role === "principal");
  const principalMember = members.find((m) => m.id === roomId);
  const startedAt = principal?.startedAt;
  const age = ageUnits(startedAt === undefined ? 0 : now - startedAt);
  const ageText = age.unit === "now" ? dict.ageNow : (age.unit === "min" ? dict.ageMin : age.unit === "hour" ? dict.ageHour : dict.ageDay).replace("{count}", String(age.value));
  const usage = useMemo(() => usageRows(members), [members]);
  const titleOf = (id: string): string => agents.find((a) => a.agentId === id)?.title ?? members.find((m) => m.id === id)?.title ?? id;
  const connectors = useMemo(() => {
    const byServer = new Map<string, number>();
    for (const agent of agents) for (const server of agent.connectors) byServer.set(server, (byServer.get(server) ?? 0) + 1);
    return [...byServer.entries()];
  }, [agents]);
  const areas = useMemo(
    () =>
      canvas.areas.map((area) => {
        const inside = (area.members ?? []).flatMap((id) => agents.filter((a) => a.agentId === id));
        const waiting = inside.filter((a) => cardStatus(a).tone === "wait").length;
        return { area, count: inside.length, waiting };
      }),
    [canvas.areas, agents],
  );
  const retained = retainedWorktrees(worktrees.data.worktrees);
  const completed = isRoomCompleted(agents);

  return (
    <SalaSidePanel mark={<RoomGlyph size={16} />} title={title} subtitle={dict.subtitle.replace("{age}", ageText)} kind="about" onClose={onClose}>
      <div className="sala-side-body">
        <div className="sala-stats">
          <div>
            <b>{counts.agents}</b>
            <span>{dict.statAgents}</span>
          </div>
          <div>
            <b>{counts.running}</b>
            <span>{dict.statRunning}</span>
          </div>
          <div className={counts.waiting > 0 ? "warn" : undefined}>
            <b>{counts.waiting}</b>
            <span>{dict.statWaiting}</span>
          </div>
          <div>
            <b>{counts.done}</b>
            <span>{dict.statDone}</span>
          </div>
        </div>

        {completed && (
          <div className="sala-side-note done" role="status">
            <b>{dict.completedTitle}</b>
            <span>{retained.length === 1 ? dict.completedKeptOne : retained.length > 0 ? dict.completedKept.replace("{count}", String(retained.length)) : dict.completedClean}</span>
          </div>
        )}

        <Section title={dict.where}>
          <div className="sala-side-row">
            <Folder size={14} aria-hidden="true" />
            <span className="grow">{dict.folder}</span>
            <span className="mono" title={principalMember?.cwd}>
              {principalMember?.cwd ?? "—"}
            </span>
          </div>
          <div className="sala-side-row">
            <span className="sala-dot" aria-hidden="true" style={{ background: profileColorVar(profile.id) }} />
            <span className="grow">{dict.profile}</span>
            <span className="mono">{profile.label}</span>
          </div>
        </Section>

        <Section title={dict.areas}>
          {areas.length === 0 && <p className="sala-side-empty">{dict.noAreas}</p>}
          {areas.map(({ area, count, waiting }) => (
            <div key={area.id} className="sala-side-row">
              <AreaIcon size={14} />
              <span className="grow">{area.label || "—"}</span>
              <span className={waiting > 0 ? "mono warn" : "mono"}>
                {count}
                {waiting > 0 ? ` · ${String(waiting)}` : ""}
              </span>
            </div>
          ))}
        </Section>

        <Section title={dict.usage}>
          {usage.rows.length === 0 && <p className="sala-side-empty">{dict.usageEmpty}</p>}
          {usage.rows.map((row) => (
            <div key={row.agentId} className="sala-usage">
              <div className="sala-side-row">
                <span className="grow trunc">{titleOf(row.agentId)}</span>
                <span className="mono">{dict.tokens.replace("{count}", formatTokens(row.tokens))}</span>
                <span className="mono dim">{row.share}%</span>
              </div>
              <span className="sala-usage-bar" aria-hidden="true">
                <span style={{ width: `${String(row.share)}%` }} />
              </span>
            </div>
          ))}
          {usage.rows.length > 0 && <p className="sala-side-fine">{dict.usageNote}</p>}
        </Section>

        <Section title={dict.connectors}>
          {connectors.length === 0 && <p className="sala-side-empty">{dict.connectorsEmpty}</p>}
          {connectors.map(([server, used]) => (
            <div key={server} className="sala-side-row">
              <ConnectorLogo server={server} className="size-3.5" />
              <span className="grow">{connectorLabel(server)}</span>
              <span className="mono dim">{used}</span>
            </div>
          ))}
        </Section>

        <Section title={dict.context}>
          <p className="sala-side-fine first">{dict.contextBody}</p>
          {context !== null && context.length === 0 && <p className="sala-side-empty">{dict.contextEmpty}</p>}
          {(context ?? []).map((item) => (
            <div key={item.name} className="sala-ctx-item">
              <span className="sala-ctx-kind" aria-hidden="true">
                <FileText size={12} />
              </span>
              <div>
                <b>{item.name}</b>
                <span>{item.summary || `${item.author} · ${formatBytes(item.bytes)}`}</span>
              </div>
            </div>
          ))}
        </Section>

        <Section title={dict.worktrees}>
          {worktrees.loaded && worktrees.data.worktrees.length === 0 && <p className="sala-side-empty">{dict.worktreesEmpty}</p>}
          {worktrees.data.worktrees.map((w) => (
            <div key={w.id} className="sala-side-row wt">
              <GitBranch size={14} aria-hidden="true" />
              <span className="grow trunc mono" title={w.path}>
                {w.branch}
              </span>
              <span className={w.integrated ? "mono dim" : "mono warn"}>{formatBytes(w.sizeBytes ?? 0)}</span>
            </div>
          ))}
          {worktrees.data.worktrees.length > 0 && <p className="sala-side-fine">{dict.worktreesTotal.replace("{size}", formatBytes(worktrees.data.totalSizeBytes))}</p>}
        </Section>
      </div>
    </SalaSidePanel>
  );
}
