/** Home hero suggestion cards — original 24×24 stroke glyphs. */

export function HeroSuggestionIcon({ kind }: { kind: "explore" | "build" | "review" | "fix" }) {
  if (kind === "explore") {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M6 14.5c0-2.5 2.2-4.5 5-4.5s5 2 5 4.5M8 10V7.5a4 4 0 018 0V10"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
        <path
          d="M7.5 14.5h9l.8 4.2a1.2 1.2 0 01-1.2 1.4H7.9a1.2 1.2 0 01-1.2-1.4L7.5 14.5z"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
        <path
          d="M10 6.2l1.2-2.4h1.6L14 6.2"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (kind === "build") {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M14.5 5.5l4 4M8 18l-2.2.6c-.5.1-.9-.3-.8-.8L5.6 15.6 13.2 8a2.2 2.2 0 013.1 0l.1.1a2.2 2.2 0 010 3.1L8 18z"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (kind === "review") {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M7.5 9.5A4.5 4.5 0 0116 8.2M16.5 14.5A4.5 4.5 0 018 15.8"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
        <path
          d="M16 5.5v3h3M8 18.5v-3H5"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="13" r="4.2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M12 8.8V6.2M10.2 6.8h3.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path
        d="M9.2 16.8c-1.4.9-2.7 1.5-3.4 1.3-.4-.1-.6-.6-.4-1 1.1-2.2 2.6-3.4 3.8-4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path
        d="M14.8 16.8c1.4.9 2.7 1.5 3.4 1.3.4-.1.6-.6.4-1-1.1-2.2-2.6-3.4-3.8-4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
