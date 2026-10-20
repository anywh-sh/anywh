import type { SVGProps } from "react";

// Stroke icons on a 16x16 grid, `currentColor` (the design's icon language).
// One file because each is a few path commands; none carries meaning a
// reader needs spelled out, and each caller names what it is for.

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 16, strokeWidth = 1.4, children, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={strokeWidth} aria-hidden={rest["aria-label"] ? undefined : true} {...rest}>
      {children}
    </svg>
  );
}

/** Two boxes joined by a line: a room (the design's glyph for the session type). */
export function RoomGlyph(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="2" y="2.5" width="5" height="4" />
      <rect x="9" y="9.5" width="5" height="4" />
      <path d="M4.5 6.5v5.5H9" />
    </Icon>
  );
}

export function ConversationGlyph(props: IconProps) {
  return (
    <Icon strokeWidth={1.5} {...props}>
      <path d="M2.5 4h11M2.5 8h11M2.5 12h7" />
    </Icon>
  );
}

export function SelectIcon(props: IconProps) {
  return (
    <Icon strokeLinejoin="round" {...props}>
      <path d="M3.5 2.5 12.5 8l-4 .9-2 3.9z" />
    </Icon>
  );
}

export function HandIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 1.75v12.5M1.75 8h12.5M8 1.75 6.25 3.5M8 1.75 9.75 3.5M8 14.25 6.25 12.5M8 14.25l1.75-1.75M1.75 8 3.5 6.25M1.75 8 3.5 9.75M14.25 8 12.5 6.25M14.25 8 12.5 9.75" />
    </Icon>
  );
}

export function NewAgentIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="2.5" y="2.5" width="11" height="11" />
      <path d="M8 5.25v5.5M5.25 8h5.5" />
    </Icon>
  );
}

export function AttachIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.5 1.75h6l3 3v9.5h-9z" />
      <path d="M9.5 1.75v3h3M8 7.25v4.5M5.75 9.5h4.5" />
    </Icon>
  );
}

export function TextIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 3.5h10M8 3.5v9.5M6 13h4" />
    </Icon>
  );
}

export function AreaIcon(props: IconProps) {
  return (
    <Icon strokeDasharray="2.2 1.6" {...props}>
      <rect x="2" y="3.5" width="12" height="10" />
    </Icon>
  );
}

export function MinusIcon(props: IconProps) {
  return (
    <Icon strokeWidth={1.5} {...props}>
      <path d="M3.5 8h9" />
    </Icon>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <Icon strokeWidth={1.5} {...props}>
      <path d="M8 3.5v9M3.5 8h9" />
    </Icon>
  );
}

export function FitIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" />
    </Icon>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <Icon strokeWidth={1.6} {...props}>
      <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
    </Icon>
  );
}

export function LayersIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 2.5 13.5 5 8 7.5 2.5 5z" />
      <path d="M2.5 8 8 10.5 13.5 8M2.5 11 8 13.5 13.5 11" />
    </Icon>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <Icon strokeWidth={2} {...props}>
      <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />
    </Icon>
  );
}

export function TrashIcon(props: IconProps) {
  return (
    <Icon strokeWidth={1.5} {...props}>
      <path d="M3 4.5h10M6.5 4.5V2.75h3V4.5M4.5 4.5l.75 9h5.5l.75-9" />
    </Icon>
  );
}
