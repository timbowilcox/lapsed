export function HeroChart() {
  return (
    <svg viewBox="0 0 280 80" preserveAspectRatio="none" className="h-full w-full overflow-visible">
      <defs>
        <linearGradient id="hero-grad-web" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#9C85EE" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#9C85EE" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path
        d="M0,60 L20,55 L40,58 L60,48 L80,52 L100,42 L120,45 L140,38 L160,40 L180,30 L200,33 L220,22 L240,25 L260,15 L280,18 L280,80 L0,80 Z"
        fill="url(#hero-grad-web)"
      />
      <path
        d="M0,60 L20,55 L40,58 L60,48 L80,52 L100,42 L120,45 L140,38 L160,40 L180,30 L200,33 L220,22 L240,25 L260,15 L280,18"
        fill="none"
        stroke="#6B52C9"
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
