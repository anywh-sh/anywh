/**
 * Title and lede of a first-run screen. The one place in the app the
 * display face is set this large: there is no shell around it to compete
 * with, and the screen has exactly one thing to say.
 */
export function FirstRunHeading({ title, body }: { title: string; body: string }) {
  return (
    <section className="flex flex-col gap-3.5">
      <h1 className="font-display text-[31px] leading-[1.18] font-bold tracking-[-0.03em] text-pretty text-foreground">
        {title}
      </h1>
      <p className="max-w-[52ch] text-[14.5px] leading-[1.7] text-pretty text-muted-foreground">{body}</p>
    </section>
  );
}
