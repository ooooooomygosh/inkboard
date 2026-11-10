// Monochrome line icons drawn for e-ink: thick strokes, no fills except where meaningful.
const S = { fill: 'none', stroke: 'currentColor', 'stroke-width': 2.2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' } as const;

const sun = (cx = 12, cy = 12, r = 4.2) => (
  <g>
    <circle cx={cx} cy={cy} r={r} {...S} />
    {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => {
      const rad = (a * Math.PI) / 180;
      return <line {...S} x1={cx + Math.cos(rad) * (r + 2.4)} y1={cy + Math.sin(rad) * (r + 2.4)} x2={cx + Math.cos(rad) * (r + 4.6)} y2={cy + Math.sin(rad) * (r + 4.6)} />;
    })}
  </g>
);
const cloud = (dx = 0, dy = 0) => <path {...S} transform={`translate(${dx} ${dy})`} d="M7 18.5h10.2a4 4 0 0 0 .4-8 5.6 5.6 0 0 0-10.8 1.4A3.3 3.3 0 0 0 7 18.5z" />;
const drops = (n: number) => (
  <g>{Array.from({ length: n }, (_, i) => <line {...S} x1={8 + i * 4} y1={20.5} x2={7 + i * 4} y2={23} />)}</g>
);

export function WeatherIcon({ name, size = 48 }: { name: string; size?: number }) {
  let body;
  switch (name) {
    case 'sun': body = sun(); break;
    case 'sun-cloud': body = <g>{sun(9, 8.5, 3.2)}<path {...S} fill="#fff" d="M8.5 20h9.5a3.6 3.6 0 0 0 .4-7.2 5 5 0 0 0-9.6 1.2A3 3 0 0 0 8.5 20z" /></g>; break;
    case 'cloud': body = cloud(0, 1); break;
    case 'fog': body = <g>{cloud(0, -2)}<line {...S} x1="4" y1="20" x2="20" y2="20" /><line {...S} x1="6" y1="23" x2="18" y2="23" /></g>; break;
    case 'drizzle': body = <g>{cloud(0, -2.5)}{drops(2)}</g>; break;
    case 'rain': case 'shower': body = <g>{cloud(0, -2.5)}{drops(3)}</g>; break;
    case 'rain-heavy': body = <g>{cloud(0, -2.5)}{drops(4)}</g>; break;
    case 'snow': body = <g>{cloud(0, -2.5)}<text x="12" y="23.5" font-size="7" text-anchor="middle" fill="currentColor">✱ ✱</text></g>; break;
    case 'storm': body = <g>{cloud(0, -2.5)}<path d="M12.5 16.5l-2.5 4h3l-2 3.5" {...S} /></g>; break;
    default: body = cloud();
  }
  return <svg width={size} height={size} viewBox="0 0 24 25" class="ico">{body}</svg>;
}

export function Battery({ pct, charging }: { pct?: number; charging?: boolean }) {
  const p = Math.max(0, Math.min(100, pct ?? 0));
  return (
    <svg width="30" height="16" viewBox="0 0 30 16" class="ico">
      <rect x="1" y="2" width="25" height="12" rx="2.5" {...S} stroke-width="2" />
      <rect x="27" y="5.5" width="2.4" height="5" rx="1" fill="currentColor" />
      <rect x="3.5" y="4.5" width={(20 * p) / 100} height="7" fill="currentColor" />
      {charging ? <path d="M15 3.5l-4 5h3.4l-2 4.5 5-6h-3.4z" fill="#fff" stroke="#000" stroke-width="0.8" /> : null}
    </svg>
  );
}

export function Wifi({ level = 0 }: { level?: number }) {
  return (
    <svg width="20" height="16" viewBox="0 0 20 16" class="ico">
      {[0, 1, 2, 3].map((i) => <rect x={1 + i * 5} y={13 - i * 3.5} width="3.2" height={3 + i * 3.5} fill={i < level ? 'currentColor' : 'none'} stroke="currentColor" stroke-width="1.2" />)}
    </svg>
  );
}

export function Check({ on, size = 26 }: { on: boolean; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 26 26" class="ico chk">
      <rect x="2" y="2" width="22" height="22" rx="4" fill={on ? 'currentColor' : 'none'} stroke="currentColor" stroke-width="2.6" />
      {on ? <path d="M7 13.5l4 4 8-9" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" /> : null}
    </svg>
  );
}

export function Spark({ data, w = 90, h = 26 }: { data: number[]; w?: number; h?: number }) {
  if (!data || data.length < 2) return null;
  const min = Math.min(...data), max = Math.max(...data), span = max - min || 1;
  const pts = data.map((v, i) => `${((i / (data.length - 1)) * (w - 4) + 2).toFixed(1)},${(h - 2 - ((v - min) / span) * (h - 4)).toFixed(1)}`).join(' ');
  const last = pts.split(' ').pop()!.split(',');
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} class="ico spark">
      <polyline points={pts} fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" />
      <circle cx={last[0]} cy={last[1]} r="2.8" fill="currentColor" />
    </svg>
  );
}

export const AgentGlyph = ({ tool }: { tool: string }) => (
  <span class={`glyph glyph-${tool}`}>{tool === 'claude' ? 'C' : tool === 'codex' ? 'X' : tool === 'dsh' ? 'D' : '•'}</span>
);
