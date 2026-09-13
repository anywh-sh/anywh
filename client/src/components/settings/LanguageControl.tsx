import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { locales, localeNames, useLocale, type Locale } from "@/i18n";
import { cn } from "@/lib/utils";

/**
 * The language picker. Device-local, like the rest of the appearance page
 * it started on — and reachable from the first-run screen too, since that
 * is the one place a reader may land in a language they don't read before
 * any other setting exists. Each option is written in its own language on
 * purpose: someone looking for Portuguese scans for "Português", not for
 * whatever the current language calls it.
 */
export function LanguageControl({ className, size = "sm" }: { className?: string; size?: "sm" | "default" }) {
  const { locale, setLocale } = useLocale();

  return (
    <Select value={locale} onValueChange={(value) => setLocale(value as Locale)}>
      <SelectTrigger size={size} className={cn("w-52", className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {locales.map((option) => (
          <SelectItem key={option} value={option}>
            {localeNames[option]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
