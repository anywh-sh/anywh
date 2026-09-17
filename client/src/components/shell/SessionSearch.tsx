import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { useMergedSessions } from "@/hooks/tabs/useMergedSessions";
import { useProfiles } from "@/hooks/profiles/useProfiles";
import { useDict } from "@/i18n";
import { profileColorClass } from "@/lib/profiles/profiles";
import { cn } from "@/lib/utils";
import { useMemo } from "react";

interface SessionSearchProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectSession: (profileId: string, sessionId: string, title: string) => void;
}

/**
 * Search across every profile — which is now just a different view of the
 * same cached list the sidebar renders, instead of its own fan-out. It used
 * to refetch every profile from scratch on each opening; the rows are always
 * there now, so opening this is instant and reaches no relay at all.
 */
export function SessionSearch({ open, onOpenChange, onSelectSession }: SessionSearchProps) {
  const dict = useDict();
  const profiles = useProfiles();
  const allProfileIds = useMemo(() => new Set(profiles.map((profile) => profile.id)), [profiles]);
  // Unfiltered on purpose: the sidebar's profile filter is about what the
  // list shows, and someone reaching for search is looking for a session
  // they cannot see.
  const sessions = useMergedSessions(allProfileIds);
  const labels = useMemo(() => new Map(profiles.map((profile) => [profile.id, profile.label])), [profiles]);

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title={dict.shell.search.title}
      description={dict.shell.search.description}
    >
      <CommandInput placeholder={dict.shell.search.placeholder} />
      <CommandList>
        <CommandEmpty>{dict.shell.search.noResults}</CommandEmpty>
        <CommandGroup>
          {sessions.map((session) => {
            const label = labels.get(session.profileId) ?? session.profileId;
            return (
              <CommandItem
                key={`${session.profileId}:${session.id}`}
                // The profile name is part of the searchable value, so typing
                // it narrows to that profile without a separate filter.
                value={`${label} ${session.title}`}
                onSelect={() => {
                  onSelectSession(session.profileId, session.id, session.title);
                  onOpenChange(false);
                }}
              >
                <span className={cn("size-2 shrink-0", profileColorClass(session.profileId))} />
                <span className="min-w-0 flex-1 truncate font-mono">{session.title}</span>
                <span className="shrink-0 font-mono text-[10.5px] text-text-faint">{label}</span>
              </CommandItem>
            );
          })}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
