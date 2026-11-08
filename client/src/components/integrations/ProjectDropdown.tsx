import { Check, ChevronDown } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useDict } from "@/i18n";

interface ProjectDropdownProps {
  /** The project shown; `null` for every project. */
  value: string | null;
  projects: readonly string[];
  /** While the relay is unreachable: a choice it would never save. */
  disabled?: boolean;
  onChange: (project: string | null) => void;
}

/**
 * Which of the person's tickets the list shows: all of them, or one
 * project's. Not modal, like the rail's "+" menu: the pane stays live
 * behind it.
 */
export function ProjectDropdown({ value, projects, disabled = false, onChange }: ProjectDropdownProps) {
  const copy = useDict().integrations.tickets;
  const label = value ?? copy.allMine;
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={copy.chooseProject}
          data-testid="project-dropdown"
          className="flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-2 border border-border bg-bg-elevated px-2.5 text-left text-[13px] text-foreground transition-colors outline-none hover:border-text-faint focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-default disabled:opacity-60 disabled:hover:border-border"
        >
          <span className="min-w-0 flex-1 truncate">{label}</span>
          <ChevronDown className="size-3.5 shrink-0 text-text-faint" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-(--radix-dropdown-menu-trigger-width) min-w-56">
        <DropdownMenuItem onSelect={() => onChange(null)} className="justify-between gap-3">
          <span>{copy.allMine}</span>
          <span className="ml-auto flex items-center gap-2 font-mono text-[11px] text-text-faint">
            {copy.allProjects}
            <Check className={value === null ? "size-3.5 text-foreground" : "size-3.5 opacity-0"} aria-hidden />
          </span>
        </DropdownMenuItem>
        {projects.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="font-mono text-[10.5px] tracking-[0.08em] text-text-faint uppercase">{copy.projects}</DropdownMenuLabel>
            {projects.map((project) => (
              <DropdownMenuItem key={project} onSelect={() => onChange(project)} className="justify-between gap-3">
                <span className="font-mono text-[12.5px]">{project}</span>
                <Check className={value === project ? "size-3.5 text-foreground" : "size-3.5 opacity-0"} aria-hidden />
              </DropdownMenuItem>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
