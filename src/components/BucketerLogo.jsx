// Copyright (C) 2026 HidayahTech, LLC
// Header logo component. Self-contained inline SVG with interactive
// state cycling triggered by repeated rapid taps on the logo.
import { useEffect, useRef, useState } from 'preact/hooks';

const TRIPLE_TAP_WINDOW_MS = 600;

// Phase cycle: full → leak → mop → bandage → refill → full
const PHASES = ['full', 'leak', 'mop', 'bandage', 'refill'];

// Total animation durations per phase (ms). Must match CSS timing.
const PHASE_DURATION_MS = {
  leak: 5400,
  mop: 2600,
  bandage: 1300,
  refill: 3100,
};

export function BucketerLogo(props) {
  const [phase, setPhase] = useState('full');
  const [patched, setPatched] = useState(false);
  const animatingRef = useRef(false);
  const tapsRef = useRef([]);
  const svgRef = useRef(null);

  function handleTap() {
    if (animatingRef.current) return;
    const now = performance.now();
    const recent = tapsRef.current.filter(t => now - t <= TRIPLE_TAP_WINDOW_MS);
    recent.push(now);
    tapsRef.current = recent;
    if (recent.length < 3) return;
    tapsRef.current = [];
    advancePhase();
  }

  function advancePhase() {
    const idx = PHASES.indexOf(phase);
    const next = PHASES[(idx + 1) % PHASES.length];
    if (next === 'full') {
      setPhase('full');
      return;
    }
    if (next === 'leak') setPatched(false);
    if (next === 'bandage') setPatched(true);
    animatingRef.current = true;
    setPhase(next);
    setTimeout(() => {
      animatingRef.current = false;
      if (next === 'refill') {
        setPhase('full');
      }
    }, PHASE_DURATION_MS[next]);
  }

  useEffect(() => {
    const link = document.querySelector('link[rel="icon"]');
    if (link && !link.href.endsWith('.svg')) {
      // favicon already set by App.jsx; nothing to do
    }
  }, []);

  return (
    <svg
      ref={svgRef}
      viewBox="0 0 100 130"
      xmlns="http://www.w3.org/2000/svg"
      class={`app-logo logo-phase-${phase}${patched ? ' bk-patched' : ''}`}
      onClick={handleTap}
      aria-label="Bucketer"
      {...props}
    >
      <defs>
        <clipPath id="bk-cc">
          <path d="M8,36 L22,104 L78,104 L92,36 Z" />
        </clipPath>
      </defs>

      <style>{`
        .bk-icon-inner { transform-box: fill-box; transform-origin: center; }

        /* Per-icon vectors pointing from each icon's center to the hole at (24, 87).
           Values are in the icon's local (rotated) coordinate space so the icon
           lands on the hole in world space despite its parent rotation. */
        .bk-icon-1 .bk-icon-inner { --tx: -11px; --ty: 31px; }
        .bk-icon-2 .bk-icon-inner { --tx: -34px; --ty: 42px; }
        .bk-icon-3 .bk-icon-inner { --tx: -20px; --ty: 17px; }
        .bk-icon-4 .bk-icon-inner { --tx:  -6px; --ty:  7px; }
        .bk-icon-5 .bk-icon-inner { --tx: -43px; --ty:  7px; }
        .bk-icon-6 .bk-icon-inner { --tx: -29px; --ty:  0px; }

        /* Hole — visible during leak, mop, bandage; hidden during refill + full */
        .bk-hole { opacity: 0; transition: opacity 0.3s; }
        .logo-phase-leak    .bk-hole,
        .logo-phase-mop     .bk-hole,
        .logo-phase-bandage .bk-hole { opacity: 1; }

        /* Drip animation — 6 staggered drips during leak */
        .bk-drip { opacity: 0; }
        .logo-phase-leak .bk-drip-1 { animation: bk-drip 0.6s ease-in 0.5s forwards; }
        .logo-phase-leak .bk-drip-2 { animation: bk-drip 0.6s ease-in 1.3s forwards; }
        .logo-phase-leak .bk-drip-3 { animation: bk-drip 0.6s ease-in 2.1s forwards; }
        .logo-phase-leak .bk-drip-4 { animation: bk-drip 0.6s ease-in 2.9s forwards; }
        .logo-phase-leak .bk-drip-5 { animation: bk-drip 0.6s ease-in 3.7s forwards; }
        .logo-phase-leak .bk-drip-6 { animation: bk-drip 0.6s ease-in 4.5s forwards; }

        @keyframes bk-drip {
          0%   { opacity: 1; transform: translateY(0); }
          85%  { opacity: 1; transform: translateY(28px); }
          100% { opacity: 0; transform: translateY(30px); }
        }

        /* Icons — drain (shrink + fade) sequentially during leak */
        .logo-phase-leak .bk-icon-1 .bk-icon-inner { animation: bk-drain 0.85s ease-in 0.2s forwards; }
        .logo-phase-leak .bk-icon-2 .bk-icon-inner { animation: bk-drain 0.85s ease-in 1.0s forwards; }
        .logo-phase-leak .bk-icon-3 .bk-icon-inner { animation: bk-drain 0.85s ease-in 1.8s forwards; }
        .logo-phase-leak .bk-icon-4 .bk-icon-inner { animation: bk-drain 0.85s ease-in 2.6s forwards; }
        .logo-phase-leak .bk-icon-5 .bk-icon-inner { animation: bk-drain 0.85s ease-in 3.4s forwards; }
        .logo-phase-leak .bk-icon-6 .bk-icon-inner { animation: bk-drain 0.85s ease-in 4.2s forwards; }

        /* During mop and bandage, icons stay hidden */
        .logo-phase-mop     .bk-icon-inner,
        .logo-phase-bandage .bk-icon-inner { opacity: 0; transform: scale(0); }

        @keyframes bk-drain {
          0%   { opacity: 1; transform: translate(0, 0) scale(1); }
          70%  { opacity: 1; transform: translate(calc(var(--tx) * 0.85), calc(var(--ty) * 0.85)) scale(0.65); }
          100% { opacity: 0; transform: translate(var(--tx), var(--ty)) scale(0.05); }
        }

        /* Puddle — 6 stacked ellipses, each fades in as a drip lands */
        .bk-puddle { opacity: 0; }
        .logo-phase-leak .bk-puddle-1 { animation: bk-puddle 0.3s ease-out 1.0s forwards; }
        .logo-phase-leak .bk-puddle-2 { animation: bk-puddle 0.3s ease-out 1.8s forwards; }
        .logo-phase-leak .bk-puddle-3 { animation: bk-puddle 0.3s ease-out 2.6s forwards; }
        .logo-phase-leak .bk-puddle-4 { animation: bk-puddle 0.3s ease-out 3.4s forwards; }
        .logo-phase-leak .bk-puddle-5 { animation: bk-puddle 0.3s ease-out 4.2s forwards; }
        .logo-phase-leak .bk-puddle-6 { animation: bk-puddle 0.3s ease-out 5.0s forwards; }

        /* During mop, each puddle ring fades out timed to a mop plunge */
        .logo-phase-mop .bk-puddle { opacity: 0.55; }
        .logo-phase-mop .bk-puddle-6 { animation: bk-puddle-fade 0.25s ease-out 0.55s forwards; }
        .logo-phase-mop .bk-puddle-5 { animation: bk-puddle-fade 0.25s ease-out 0.85s forwards; }
        .logo-phase-mop .bk-puddle-4 { animation: bk-puddle-fade 0.25s ease-out 1.25s forwards; }
        .logo-phase-mop .bk-puddle-3 { animation: bk-puddle-fade 0.25s ease-out 1.55s forwards; }
        .logo-phase-mop .bk-puddle-2 { animation: bk-puddle-fade 0.25s ease-out 1.85s forwards; }
        .logo-phase-mop .bk-puddle-1 { animation: bk-puddle-fade 0.25s ease-out 2.15s forwards; }

        @keyframes bk-puddle {
          0%   { opacity: 0; }
          100% { opacity: 0.55; }
        }

        @keyframes bk-puddle-fade {
          0%   { opacity: 0.55; }
          100% { opacity: 0; }
        }

        /* Mop — enters from right, attacks puddle at three spots with angled plunges */
        .bk-mop { opacity: 0; transform: translate(60px, 0) rotate(0deg); transform-box: fill-box; transform-origin: 50% 0%; }
        .logo-phase-mop .bk-mop { animation: bk-mop 2.4s ease-in-out 0.15s forwards; }

        @keyframes bk-mop {
          0%   { opacity: 0; transform: translate(60px, 0) rotate(0deg); }
          8%   { opacity: 1; transform: translate(28px, 0)  rotate(0deg); }

          /* Right attack: two angled plunges */
          16%  { opacity: 1; transform: translate(26px, 2px) rotate(-22deg); }
          22%  { opacity: 1; transform: translate(28px, 0)   rotate(14deg); }
          28%  { opacity: 1; transform: translate(26px, 2px) rotate(-18deg); }

          /* Travel to center */
          35%  { opacity: 1; transform: translate(6px, -1px) rotate(0deg); }

          /* Center attack: two angled plunges */
          43%  { opacity: 1; transform: translate(4px, 2px)  rotate(20deg); }
          50%  { opacity: 1; transform: translate(8px, 0)    rotate(-16deg); }
          57%  { opacity: 1; transform: translate(4px, 2px)  rotate(18deg); }

          /* Travel to left */
          65%  { opacity: 1; transform: translate(-16px, -1px) rotate(0deg); }

          /* Left attack: two angled plunges */
          73%  { opacity: 1; transform: translate(-18px, 2px) rotate(-20deg); }
          80%  { opacity: 1; transform: translate(-14px, 0)   rotate(16deg); }
          87%  { opacity: 1; transform: translate(-18px, 2px) rotate(-14deg); }

          /* Exit left */
          95%  { opacity: 1; transform: translate(-50px, 0)  rotate(0deg); }
          100% { opacity: 0; transform: translate(-70px, 0)  rotate(0deg); }
        }

        /* Refill — icons drop in from above the rim, sequentially */
        .logo-phase-refill .bk-icon-1 .bk-icon-inner { animation: bk-settle 0.9s cubic-bezier(.34,1.5,.64,1) 0.0s backwards; }
        .logo-phase-refill .bk-icon-2 .bk-icon-inner { animation: bk-settle 0.9s cubic-bezier(.34,1.5,.64,1) 0.4s backwards; }
        .logo-phase-refill .bk-icon-3 .bk-icon-inner { animation: bk-settle 0.9s cubic-bezier(.34,1.5,.64,1) 0.8s backwards; }
        .logo-phase-refill .bk-icon-4 .bk-icon-inner { animation: bk-settle 0.9s cubic-bezier(.34,1.5,.64,1) 1.2s backwards; }
        .logo-phase-refill .bk-icon-5 .bk-icon-inner { animation: bk-settle 0.9s cubic-bezier(.34,1.5,.64,1) 1.6s backwards; }
        .logo-phase-refill .bk-icon-6 .bk-icon-inner { animation: bk-settle 0.9s cubic-bezier(.34,1.5,.64,1) 2.0s backwards; }

        @keyframes bk-settle {
          0%   { opacity: 0; transform: translateY(-70px) scale(1); }
          70%  { opacity: 1; transform: translateY(2px) scale(1); }
          100% { opacity: 1; transform: translateY(0) scale(1); }
        }

        /* Bandages — slide in from the left during the bandage phase, form an X */
        .bk-bandaid { opacity: 0; transform-box: fill-box; transform-origin: center; }

        /* Final resting state, visible whenever patched */
        .bk-patched.logo-phase-full   .bk-bandaid-1,
        .bk-patched.logo-phase-refill .bk-bandaid-1 { opacity: 1; transform: translateX(0) rotate(45deg); }
        .bk-patched.logo-phase-full   .bk-bandaid-2,
        .bk-patched.logo-phase-refill .bk-bandaid-2 { opacity: 1; transform: translateX(0) rotate(-45deg); }

        /* Bandage phase: slide in sequentially from the left */
        .bk-patched.logo-phase-bandage .bk-bandaid-1 {
          animation: bk-bandaid-in-1 0.5s cubic-bezier(.34,1.3,.64,1) 0.15s forwards;
        }
        .bk-patched.logo-phase-bandage .bk-bandaid-2 {
          animation: bk-bandaid-in-2 0.5s cubic-bezier(.34,1.3,.64,1) 0.65s forwards;
        }

        @keyframes bk-bandaid-in-1 {
          0%   { opacity: 0; transform: translateX(-50px) rotate(45deg); }
          70%  { opacity: 1; transform: translateX(3px)   rotate(45deg); }
          100% { opacity: 1; transform: translateX(0)     rotate(45deg); }
        }
        @keyframes bk-bandaid-in-2 {
          0%   { opacity: 0; transform: translateX(-50px) rotate(-45deg); }
          70%  { opacity: 1; transform: translateX(3px)   rotate(-45deg); }
          100% { opacity: 1; transform: translateX(0)     rotate(-45deg); }
        }
      `}</style>

      {/* Handle */}
      <path d="M18,32 L50,10 L82,32" fill="none" stroke="#38BDF8" strokeWidth="5" strokeLinejoin="round" strokeLinecap="round"/>

      {/* Bucket body */}
      <path d="M8,36 L22,104 L78,104 L92,36 Z" fill="#111827" stroke="#2D3748" strokeWidth="0.5"/>

      {/* Objects (clipped to bucket body) */}
      <g clipPath="url(#bk-cc)">
        <g class="bk-icon bk-icon-1" transform="translate(24,47) rotate(-9 6 8)">
          <g class="bk-icon-inner">
            <rect width="12" height="16" rx="1.5" fill="#0F2033" stroke="#38BDF8" strokeWidth=".7"/>
            <line x1="1.5" y1="5"   x2="10.5" y2="5"   stroke="#38BDF8" strokeWidth="1.3" strokeLinecap="round" opacity=".9"/>
            <line x1="1.5" y1="8.5" x2="9"    y2="8.5" stroke="#38BDF8" strokeWidth="1.3" strokeLinecap="round" opacity=".9"/>
            <line x1="1.5" y1="12"  x2="10.5" y2="12"  stroke="#38BDF8" strokeWidth="1.3" strokeLinecap="round" opacity=".9"/>
          </g>
        </g>

        <g class="bk-icon bk-icon-2" transform="translate(54,43) rotate(7 9 6.5)">
          <g class="bk-icon-inner">
            <rect width="18" height="13" rx="1.5" fill="#0F2033" stroke="#38BDF8" strokeWidth=".7"/>
            <polygon points="2,11 9,3 16,11" fill="#38BDF8" opacity=".82"/>
            <circle cx="15.5" cy="3.5" r="1.8" fill="#38BDF8" opacity=".82"/>
          </g>
        </g>

        <g class="bk-icon bk-icon-3" transform="translate(32,62) rotate(-5 10 6.5)">
          <g class="bk-icon-inner">
            <rect width="20" height="13" rx="1.5" fill="#0F2033" stroke="#38BDF8" strokeWidth=".7"/>
            <polygon points="5,1.5 5,11.5 16.5,6.5" fill="#38BDF8" opacity=".88"/>
          </g>
        </g>

        <g class="bk-icon bk-icon-4" transform="translate(26,73) rotate(11 5 8)">
          <g class="bk-icon-inner">
            <rect width="10" height="16" rx="1.5" fill="#0F2033" stroke="#38BDF8" strokeWidth=".7"/>
            <rect x="1"   y="7"   width="2.2" height="7"    rx=".8" fill="#38BDF8" opacity=".75"/>
            <rect x="3.9" y="2.5" width="2.2" height="11.5" rx=".8" fill="#38BDF8" opacity=".92"/>
            <rect x="6.8" y="5"   width="2.2" height="9"    rx=".8" fill="#38BDF8" opacity=".82"/>
          </g>
        </g>

        <g class="bk-icon bk-icon-5" transform="translate(59,68) rotate(-7 7 7)">
          <g class="bk-icon-inner">
            <rect width="14" height="14" rx="1.5" fill="#0F2033" stroke="#38BDF8" strokeWidth=".7"/>
            <line x1="7"   y1="1.5" x2="7"    y2="12.5" stroke="#38BDF8" strokeWidth="1.1" opacity=".88"/>
            <line x1="1.5" y1="5"   x2="12.5" y2="5"    stroke="#38BDF8" strokeWidth="1.1" opacity=".88"/>
            <line x1="1.5" y1="9"   x2="12.5" y2="9"    stroke="#38BDF8" strokeWidth="1.1" opacity=".88"/>
          </g>
        </g>

        <g class="bk-icon bk-icon-6" transform="translate(47,82) rotate(5 6 8)">
          <g class="bk-icon-inner">
            <rect width="12" height="16" rx="1.5" fill="#0F2033" stroke="#38BDF8" strokeWidth=".7"/>
            <path d="M5,3.5 L2,8 L5,12.5"  fill="none" stroke="#38BDF8" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity=".88"/>
            <path d="M7,3.5 L10,8 L7,12.5" fill="none" stroke="#38BDF8" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity=".88"/>
          </g>
        </g>
      </g>

      {/* Rim (drawn last, on top of icons but below hole) */}
      <rect x="4" y="26" width="92" height="14" rx="7" fill="#1E293B"/>

      {/* Hole on lower-left bucket wall — jagged rim for "punched through" look */}
      <g class="bk-hole">
        <path
          d="M19.5,87 L22,84.5 L24.5,86 L27,84.8 L28,87.5 L27.2,90.2 L24.8,91.2 L22,90.8 L19.8,89.5 Z"
          fill="#000"
          opacity="0.92"
        />
        <path
          d="M19.5,87 L22,84.5 L24.5,86 L27,84.8 L28,87.5 L27.2,90.2 L24.8,91.2 L22,90.8 L19.8,89.5 Z"
          fill="none"
          stroke="#38BDF8"
          strokeWidth="0.6"
          opacity="0.85"
        />
      </g>

      {/* Bandages — slide in from the left during the bandage phase, form X over hole */}
      <g transform="translate(24 87.5)">
        <g class="bk-bandaid bk-bandaid-1">
          <rect x="-5" y="-1.5" width="10" height="3" rx="1.5" fill="#E5C9A6" stroke="#8B6B3D" strokeWidth="0.3"/>
          <rect x="-1.6" y="-1" width="3.2" height="2" fill="#F5E8D0" stroke="#8B6B3D" strokeWidth="0.2"/>
          <circle cx="-3.2" cy="-0.5" r="0.18" fill="#8B6B3D"/>
          <circle cx="-3.2" cy="0.5"  r="0.18" fill="#8B6B3D"/>
          <circle cx="3.2"  cy="-0.5" r="0.18" fill="#8B6B3D"/>
          <circle cx="3.2"  cy="0.5"  r="0.18" fill="#8B6B3D"/>
        </g>
        <g class="bk-bandaid bk-bandaid-2">
          <rect x="-5" y="-1.5" width="10" height="3" rx="1.5" fill="#E5C9A6" stroke="#8B6B3D" strokeWidth="0.3"/>
          <rect x="-1.6" y="-1" width="3.2" height="2" fill="#F5E8D0" stroke="#8B6B3D" strokeWidth="0.2"/>
          <circle cx="-3.2" cy="-0.5" r="0.18" fill="#8B6B3D"/>
          <circle cx="-3.2" cy="0.5"  r="0.18" fill="#8B6B3D"/>
          <circle cx="3.2"  cy="-0.5" r="0.18" fill="#8B6B3D"/>
          <circle cx="3.2"  cy="0.5"  r="0.18" fill="#8B6B3D"/>
        </g>
      </g>

      {/* Drips falling from hole */}
      <g>
        <circle class="bk-drip bk-drip-1" cx="24" cy="90" r="1.4" fill="#38BDF8"/>
        <circle class="bk-drip bk-drip-2" cx="24" cy="90" r="1.4" fill="#38BDF8"/>
        <circle class="bk-drip bk-drip-3" cx="24" cy="90" r="1.4" fill="#38BDF8"/>
        <circle class="bk-drip bk-drip-4" cx="24" cy="90" r="1.4" fill="#38BDF8"/>
        <circle class="bk-drip bk-drip-5" cx="24" cy="90" r="1.4" fill="#38BDF8"/>
        <circle class="bk-drip bk-drip-6" cx="24" cy="90" r="1.4" fill="#38BDF8"/>
      </g>

      {/* Puddle — concentric growth centered near drip landing zone */}
      <g class="bk-puddle-group">
        <ellipse class="bk-puddle bk-puddle-6" cx="32" cy="120" rx="30" ry="7"   fill="#38BDF8"/>
        <ellipse class="bk-puddle bk-puddle-5" cx="30" cy="120" rx="25" ry="6"   fill="#38BDF8"/>
        <ellipse class="bk-puddle bk-puddle-4" cx="28" cy="120" rx="20" ry="5.2" fill="#38BDF8"/>
        <ellipse class="bk-puddle bk-puddle-3" cx="26" cy="120" rx="15" ry="4.4" fill="#38BDF8"/>
        <ellipse class="bk-puddle bk-puddle-2" cx="23" cy="120" rx="10" ry="3.6" fill="#38BDF8"/>
        <ellipse class="bk-puddle bk-puddle-1" cx="20" cy="120" rx="5"  ry="2.8" fill="#38BDF8"/>
        {/* Highlight shine on top of puddle */}
        <ellipse class="bk-puddle bk-puddle-6" cx="34" cy="118" rx="14" ry="1.3" fill="#7DD3FC" opacity="0.5"/>
      </g>

      {/* Mop — wooden stick, collar, and hanging wet strands */}
      <g class="bk-mop">
        {/* Stick */}
        <line x1="50" y1="96" x2="50" y2="115" stroke="#38BDF8" strokeWidth="1.9" strokeLinecap="round"/>
        {/* Collar holding the strands */}
        <ellipse cx="50" cy="115.5" rx="4.2" ry="1.7" fill="#38BDF8"/>
        {/* Strands — slightly wavy, varied lengths, bunched */}
        <path d="M46.8,116.5 Q46.2,121 47,124.5"   stroke="#38BDF8" strokeWidth="1.3" strokeLinecap="round" fill="none"/>
        <path d="M48.4,116.8 Q48.1,122 48.6,125.5" stroke="#38BDF8" strokeWidth="1.3" strokeLinecap="round" fill="none"/>
        <path d="M50,117    Q49.8,123 50.2,126"    stroke="#38BDF8" strokeWidth="1.4" strokeLinecap="round" fill="none"/>
        <path d="M51.6,116.8 Q51.9,122 51.4,125.5" stroke="#38BDF8" strokeWidth="1.3" strokeLinecap="round" fill="none"/>
        <path d="M53.2,116.5 Q53.8,121 53,124.5"   stroke="#38BDF8" strokeWidth="1.3" strokeLinecap="round" fill="none"/>
      </g>
    </svg>
  );
}
