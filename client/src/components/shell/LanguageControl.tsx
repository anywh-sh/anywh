import { ChevronDown, Languages } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { locales, localeNames, useLocale, type Locale } from "@/i18n";
import { cn } from "@/lib/utils";

/**
 * Device-local language switch, drawn as a footer pill: the tag itself
 * (`pt-BR`), not the language's own name — a reader who doesn't yet read the
 * current language still recognizes a locale tag as "language" faster than
 * prose they can't parse. The menu it opens still spells out each option in
 * its own language, since that's what someone scanning for "Português" is
 * looking for.
 */
export function LanguageControl({ className }: { className?: string }) {
  const { locale, setLocale } = useLocale();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          "flex cursor-pointer items-center gap-1.5 border border-transparent px-1.5 py-0.5 text-text-faint outline-hidden transition-colors hover:border-border hover:text-foreground",
          className,
        )}
      >
        <Languages className="size-3" strokeWidth={1.5} />
        <span>{locale}</span>
        <ChevronDown className="size-2.5 opacity-70" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top" className="min-w-44">
        <DropdownMenuRadioGroup value={locale} onValueChange={(value) => setLocale(value as Locale)}>
          {locales.map((option) => (
            <DropdownMenuRadioItem key={option} value={option}>
              {localeNames[option]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
