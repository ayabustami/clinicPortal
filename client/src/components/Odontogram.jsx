import React, { useId, useRef } from 'react';

/**
 * Interactive odontogram (FDI two-digit system) rendered as inline SVG.
 *
 * Anatomy: buccal-view tooth shapes generated per tooth type (incisor, canine,
 * premolar, molars). Upper jaw: roots up, crowns toward the midline; lower jaw
 * vertically mirrored. Badges and tooth numbers are drawn in screen space so
 * they are never upside down. Each crown is subdivided into the five charting
 * surfaces (M, D, O, B, L) — M always points toward the chart midline, so FDI
 * numbering/orientation stay anatomically correct in RTL locales (the page
 * renders the chart inside a dir="ltr" wrapper).
 *
 * Rendering rules:
 *  - white tooth                 = not assessed (never assumed healthy)
 *  - conditions get color + SVG pattern + letter badge (never color alone)
 *  - multiple findings coexist (e.g. crown + root canal); overlays stack
 *  - planned treatments  -> blue dashed ring + procedure tag   (layer B)
 *  - completed procedures -> green check badge                 (layer C)
 *
 * props: dentition ('permanent'|'primary'), findings (all rows; only 'active'
 * are drawn), treatments, layers {current,planned,completed}, selected,
 * onSelect(tooth), t (i18n).
 */

/* ---------------- FDI catalogs ---------------- */

export function toothTypeKey(tooth) {
  const q = Math.floor(tooth / 10);
  const p = tooth % 10;
  if (q >= 5) return p === 1 ? 'central' : p === 2 ? 'lateral' : p === 3 ? 'canine' : p === 4 ? 'pmolar1' : 'pmolar2';
  if (p === 1) return 'central';
  if (p === 2) return 'lateral';
  if (p === 3) return 'canine';
  if (p === 4) return 'premolar1';
  if (p === 5) return 'premolar2';
  if (p === 6) return 'molar1';
  if (p === 7) return 'molar2';
  return 'molar3';
}

export const TOOTH_NAME_KEY = {
  central: 'dental.tooth.centralIncisor', lateral: 'dental.tooth.lateralIncisor',
  canine: 'dental.tooth.canine', premolar1: 'dental.tooth.firstPremolar',
  premolar2: 'dental.tooth.secondPremolar', molar1: 'dental.tooth.firstMolar',
  molar2: 'dental.tooth.secondMolar', molar3: 'dental.tooth.thirdMolar',
  pmolar1: 'dental.tooth.primaryFirstMolar', pmolar2: 'dental.tooth.primarySecondMolar',
};

export function upperRowFor(dentition) {
  if (dentition === 'primary') {
    const row = [];
    for (let t = 55; t >= 51; t--) row.push(t);
    for (let t = 61; t <= 65; t++) row.push(t);
    return row;
  }
  const row = [];
  for (let t = 18; t >= 11; t--) row.push(t);   // upper right 18..11 (patient's right = chart left)
  for (let t = 21; t <= 28; t++) row.push(t);   // upper left  21..28
  return row;
}

/** FDI mirror: upper right 1x <-> lower right 4x (+30); upper left 2x <-> lower left 3x (+10). */
export function lowerRowFor(dentition) {
  return upperRowFor(dentition).map((tooth) => (Math.floor(tooth / 10) <= 2 ? (Math.floor(tooth / 10) === 1 ? tooth + 30 : tooth + 10) : tooth));
}

/* ---------------- condition visuals ---------------- */

/** Stack priority for the whole-crown base fill (first match wins). */
export const CONDITION_PRIORITY = [
  'missing', 'extracted', 'implant', 'crown', 'impacted', 'caries', 'fractured',
  'filled', 'bridge_pontic', 'bridge_abutment', 'other', 'healthy', 'root_canal',
];

export const CONDITIONS = [
  'healthy', 'caries', 'filled', 'crown', 'missing', 'extracted', 'root_canal',
  'fractured', 'implant', 'bridge_pontic', 'bridge_abutment', 'impacted', 'other',
];

export const CONDITION_STYLE = {
  healthy:         { fill: '#dcfce7', stroke: '#16a34a', badge: '✓', badgeBg: '#16a34a' },
  caries:          { fill: '#fecaca', stroke: '#dc2626', badge: 'C', badgeBg: '#dc2626', pattern: 'stipple' },
  filled:          { fill: '#bfdbfe', stroke: '#2563eb', badge: 'F', badgeBg: '#2563eb', pattern: 'hatch' },
  crown:           { fill: '#fde68a', stroke: '#d97706', badge: 'Cr', badgeBg: '#d97706', pattern: 'cross' },
  missing:         { fill: '#f1f5f9', stroke: '#94a3b8', badge: 'Ms', badgeBg: '#64748b', ghost: true },
  extracted:       { fill: '#f8fafc', stroke: '#94a3b8', badge: 'Ex', badgeBg: '#475569', ghost: true, dashed: true },
  root_canal:      { fill: 'none', stroke: '#7c3aed', badge: 'RC', badgeBg: '#7c3aed', root: true },
  fractured:       { fill: '#ffedd5', stroke: '#ea580c', badge: 'Fx', badgeBg: '#ea580c', crack: true },
  implant:         { fill: '#ccfbf1', stroke: '#0d9488', badge: 'Im', badgeBg: '#0d9488', screw: true },
  bridge_pontic:   { fill: '#e2e8f0', stroke: '#64748b', badge: 'BP', badgeBg: '#64748b', pontic: true },
  bridge_abutment: { fill: 'none', stroke: '#b45309', badge: 'BA', badgeBg: '#b45309', band: true },
  impacted:        { fill: '#ede9fe', stroke: '#7c3aed', badge: 'Ip', badgeBg: '#6d28d9', tilt: true },
  other:           { fill: '#f3f4f6', stroke: '#6b7280', badge: '?', badgeBg: '#6b7280' },
};

export const PROCEDURE_TAG = {
  filling: 'F', crown: 'Cr', extraction: 'Ex', root_canal: 'RC', implant: 'Im',
  bridge: 'Br', cleaning: 'Cl', fluoride: 'Fl', other: 'Tx',
};

/* ---------------- tooth shape paths (local cell 40 x 80, drawn as an UPPER tooth) ---------------- */
/* cervical (gum) line at y=30, occlusal edge near y=76, roots extend up to y≈2. */

function crownShape(kind) {
  switch (kind) {
    case 'central':
      return { hw: 10, d: 'M 11,31 C 11,29 29,29 29,31 L 30,66 Q 30,75 25,75 L 15,75 Q 10,75 10,66 Z' };
    case 'lateral':
      return { hw: 8.5, d: 'M 12.5,31 C 12.5,29 27.5,29 27.5,31 L 28,65 Q 28,74 23.5,74.5 L 16,74.5 Q 12,74 12,65 Z' };
    case 'canine':
      return { hw: 9.5, d: 'M 11.5,32 C 11.5,29 28.5,29 28.5,32 L 28.5,60 C 28.5,66 22,77 20,77 C 18,77 11.5,66 11.5,60 Z' };
    case 'premolar1':
      return { hw: 11, d: 'M 9.5,32 C 9.5,29 30.5,29 30.5,32 L 31,62 Q 31,69 26,71 Q 22.5,72 20.5,66.5 Q 18,72 14,71 Q 9,69 9,62 Z' };
    case 'premolar2':
      return { hw: 11, d: 'M 9.5,32 C 9.5,29 30.5,29 30.5,32 L 31,63 Q 31,70 25.5,71.5 Q 22,72.5 20,67 Q 18,72.5 14.5,71.5 Q 9,70 9,63 Z' };
    case 'molar1':
      return { hw: 15.5, d: 'M 5,34 C 5,29 35,29 35,34 L 36,58 Q 36.5,67 30,69 Q 26,70 24,64.5 Q 21,70.5 17,64.5 Q 14.5,70 10,69 Q 3.5,67 4,58 Z' };
    case 'molar2':
      return { hw: 13.5, d: 'M 7,33 C 7,29 33,29 33,33 L 33.5,60 Q 34,68 28,69.5 Q 24.5,70.5 22,65 Q 20,70 16.5,69.5 Q 12,69 10,66 Q 6.5,64 6.5,58 Z' };
    case 'molar3':
      return { hw: 11.5, d: 'M 9,33 C 9,29 31,29 31,33 L 31,61 Q 31,69 25,70 Q 21.5,70.5 20,66 Q 18.5,70.5 15,70 Q 9,69 9,61 Z' };
    case 'pmolar1':
      return { hw: 12, d: 'M 8,33 C 6,29 34,29 32,33 L 32.5,60 Q 33,68.5 26.5,70 Q 23,71 20.5,66 Q 18,71 13.5,70 Q 7,68.5 7.5,60 Z' };
    case 'pmolar2':
      return { hw: 12.5, d: 'M 7.5,33 C 5.5,29 34.5,29 32.5,33 L 33,60 Q 33.5,68.5 27,70 Q 23.5,71 21,66 Q 18.5,71 14,70 Q 7,68.5 7,60 Z' };
    default:
      return { hw: 10, d: 'M 10,31 L 30,31 L 30,70 Q 30,75 20,75 Q 10,75 10,70 Z' };
  }
}

function rootShapes(kind) {
  switch (kind) {
    case 'central':
    case 'lateral':
      return [{ d: 'M 15.5,33 C 15,19 17,7 20,3 C 23,7 25,19 24.5,33 Z', apex: [20, 3] }];
    case 'canine':
      return [{ d: 'M 15,34 C 14,17 16.5,5 20,1.5 C 23.5,5 26,17 25,34 Z', apex: [20, 2] }];
    case 'premolar1':
    case 'premolar2':
      return [{ d: 'M 14.5,34 C 13.5,18 16.5,6 20,2.5 C 23.5,6 26.5,18 25.5,34 Z', apex: [20, 3] }];
    case 'molar1':
    case 'molar2':
    case 'pmolar1':
    case 'pmolar2':
      return [
        { d: 'M 9.5,36 C 8,22 9,10 12,4 C 14.5,10 15.5,22 15.5,36 Z', apex: [12, 4] },   // mesial root
        { d: 'M 24.5,36 C 24.5,22 25.5,10 28,4 C 31,10 32,22 30.5,36 Z', apex: [28, 4] },  // distal root
      ];
    case 'molar3':
      return [{ d: 'M 13,36 C 12,20 15,8 20,4 C 25,8 28,20 27,36 Z', apex: [20, 4] }];
    default:
      return [{ d: 'M 15,33 C 14,18 17,6 20,3 C 23,6 26,18 25,33 Z', apex: [20, 3] }];
  }
}

/** Surface regions inside the crown; mesial points toward the chart midline. */
function surfaceRegions(hw, mesialOnRight) {
  const x0 = 20 - hw; const w = hw * 2;
  const mw = w * 0.3; const ow = w * 0.4; const dw = w * 0.3;
  const mx = mesialOnRight ? x0 + w - mw : x0;
  const dx = mesialOnRight ? x0 : x0 + w - dw;
  return {
    L: { x: x0, y: 31, w, h: 13 },
    B: { x: x0, y: 44, w, h: 13 },
    M: { x: mx, y: 57, w: mw, h: 19 },
    O: { x: x0 + mw, y: 57, w: ow, h: 19 },
    D: { x: dx, y: 57, w: dw, h: 19 },
  };
}

/* ---------------- single tooth ---------------- */

const CELL_H = 80;

function Tooth({ tooth, x, flipY, mesialOnRight, findings, treatments, layers, selected, onSelect, uid, t, primary, focusRef, onKeyDown, onTip, onTipEnd }) {
  const kind = toothTypeKey(tooth);
  const crown = crownShape(kind);
  const roots = rootShapes(kind);
  const regions = surfaceRegions(crown.hw, mesialOnRight);
  const active = findings.filter((f) => f.tooth_number === tooth && f.status === 'active');
  const planned = layers.planned ? treatments.filter((tr) => tr.tooth_number === tooth && tr.status === 'planned') : [];
  const completed = layers.completed ? treatments.filter((tr) => tr.tooth_number === tooth && tr.status === 'completed') : [];

  const whole = layers.current ? active.filter((f) => !f.surfaces || f.surfaces.length === 0) : [];
  const surfaceFindings = layers.current ? active.filter((f) => f.surfaces && f.surfaces.length > 0) : [];
  const ranked = [...whole].sort((a, b) => CONDITION_PRIORITY.indexOf(a.condition) - CONDITION_PRIORITY.indexOf(b.condition));
  const base = ranked[0] || null;
  const baseStyle = base ? CONDITION_STYLE[base.condition] : null;
  const hasRootCanal = layers.current && active.some((f) => f.condition === 'root_canal');
  const hasFracture = layers.current && active.some((f) => f.condition === 'fractured');
  const hasBand = layers.current && active.some((f) => f.condition === 'bridge_abutment');
  const hasPontic = layers.current && active.some((f) => f.condition === 'bridge_pontic');
  const ghost = !!baseStyle?.ghost;
  const clipId = `${uid}-clip-${tooth}`;
  const badges = [...active]
    .sort((a, b) => CONDITION_PRIORITY.indexOf(a.condition) - CONDITION_PRIORITY.indexOf(b.condition))
    .slice(0, 2);

  const condLabels = active.map((f) => t(`dental.cond.${f.condition}`)).join(', ');
  const ariaLabel = [
    `${t('dental.toothLabel')} ${tooth} — ${t(TOOTH_NAME_KEY[kind])}`,
    primary ? t('dental.dentitionPrimary') : t('dental.dentitionPermanent'),
    active.length ? `${t('dental.findings')}: ${condLabels}` : t('dental.notAssessed'),
    planned.length ? `${planned.length} ${t('dental.planned')}` : null,
    completed.length ? `${completed.length} ${t('dental.completed')}` : null,
  ].filter(Boolean).join(' · ');

  // badge anchors sit next to the CROWN: upper teeth crowns are at the cell
  // bottom, flipped lower teeth crowns are at the cell top.
  const crownY = flipY ? 2 : CELL_H - 14;

  function handleKey(e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(tooth); return; }
    onKeyDown?.(e, tooth);
  }

  return (
    <g transform={`translate(${x},0)`} ref={focusRef} role="button" tabIndex={0}
      aria-label={ariaLabel} aria-pressed={selected === tooth}
      className={`odont-tooth${selected === tooth ? ' selected' : ''}`}
      onKeyDown={handleKey} onClick={() => onSelect(tooth)}
      onMouseEnter={(e) => onTip?.(tooth, e.currentTarget)}
      onFocus={(e) => onTip?.(tooth, e.currentTarget)}
      onMouseLeave={() => onTipEnd?.()}
      onBlur={() => onTipEnd?.()}
      style={{ cursor: 'pointer', outline: 'none' }}
    >
      {/* selection ring + hit area (screen space) */}
      <rect x="0.5" y="0.5" width="39" height={CELL_H - 1} rx="9" fill="transparent"
        stroke={selected === tooth ? 'var(--accent)' : 'transparent'} strokeWidth="2.2" />

      {/* tooth geometry (flipped for the lower jaw) */}
      <g transform={flipY ? `translate(0,${CELL_H}) scale(1,-1)` : undefined}>
        <g transform={primary ? 'translate(20,40) scale(0.84) translate(-20,-40)' : undefined}>
          <g transform={baseStyle?.tilt ? 'rotate(-8 20 40)' : undefined}>
            {/* roots behind the crown */}
            {!ghost && !baseStyle?.screw && roots.map((r, i) => (
              <path key={i} d={r.d}
                fill={hasRootCanal ? '#7c3aed' : '#fdfdfc'}
                stroke={hasRootCanal ? '#5b21b6' : '#94a3b8'} strokeWidth="1.2" />
            ))}
            {hasRootCanal && roots.map((r, i) => (
              <circle key={`ap${i}`} cx={r.apex[0]} cy={r.apex[1] + 1} r="2.3" fill="#ddd6fe" stroke="#5b21b6" strokeWidth="0.8" />
            ))}
            {/* implant screw replaces the roots */}
            {baseStyle?.screw && (
              <g stroke="#475569" strokeWidth="1.3" fill="#e2e8f0">
                <path d="M 16,34 L 24,34 L 22.5,8 L 20,4 L 17.5,8 Z" />
                <path d="M 16.6,28 L 23.4,28 M 17,22 L 23,22 M 17.4,16 L 22.6,16 M 18,10.5 L 22,10.5" fill="none" />
              </g>
            )}

            {/* crown */}
            <clipPath id={clipId}><path d={crown.d} /></clipPath>
            <path d={crown.d}
              fill={baseStyle && baseStyle.fill !== 'none' ? baseStyle.fill : '#fdfdfc'}
              stroke={baseStyle?.stroke || '#94a3b8'}
              strokeWidth={base?.condition === 'crown' ? 2.2 : 1.3}
              strokeDasharray={baseStyle?.dashed ? '3 2.5' : undefined}
              opacity={ghost ? 0.55 : 1}
            />
            {baseStyle?.pattern && (
              <path d={crown.d} fill={`url(#${uid}-pat-${baseStyle.pattern})`} clipPath={`url(#${clipId})`} opacity={ghost ? 0.5 : 1} />
            )}
            {/* surface-level findings */}
            {surfaceFindings.map((f) => f.surfaces.map((s) => {
              const r = regions[s]; if (!r) return null;
              const st = CONDITION_STYLE[f.condition] || CONDITION_STYLE.other;
              return (
                <g key={`${f.id}-${s}`} clipPath={`url(#${clipId})`}>
                  <rect x={r.x} y={r.y} width={r.w} height={r.h}
                    fill={st.fill === 'none' ? '#f8fafc' : st.fill} stroke={st.stroke} strokeWidth="0.9" />
                  {st.pattern && <rect x={r.x} y={r.y} width={r.w} height={r.h} fill={`url(#${uid}-pat-${st.pattern})`} />}
                  <text x={r.x + r.w / 2} y={r.y + r.h / 2 + 3} textAnchor="middle" fontSize="7.5" fontWeight="700" fill="#1f2937" opacity="0.8">{s}</text>
                </g>
              );
            }))}
            {/* ghost X for missing / extracted */}
            {ghost && (
              <g stroke={baseStyle.stroke} strokeWidth="2.4" strokeLinecap="round" opacity="0.8">
                <line x1="8" y1="34" x2="32" y2="74" />
                <line x1="32" y1="34" x2="8" y2="74" />
              </g>
            )}
            {/* fracture crack */}
            {hasFracture && !ghost && (
              <path d="M 13,34 L 18,46 L 14,54 L 21,64 L 17,74" fill="none" stroke="#ea580c" strokeWidth="1.8" strokeLinecap="round" clipPath={`url(#${clipId})`} />
            )}
            {/* abutment band + pontic connector */}
            {hasBand && <rect x={20 - crown.hw} y="31" width={crown.hw * 2} height="6" fill="#b45309" opacity="0.85" clipPath={`url(#${clipId})`} />}
            {hasPontic && <rect x="-3.5" y="40" width="47" height="4.5" rx="2" fill="#94a3b8" opacity="0.7" />}
          </g>
        </g>
      </g>

      {/* planned ring + tag (screen space) */}
      {planned.length > 0 && (
        <g>
          <rect x="2.5" y="2.5" width="35" height={CELL_H - 5} rx="9" fill="none" stroke="#2563eb" strokeWidth="1.6" strokeDasharray="4 3" />
          <g transform={`translate(25,${crownY - 2})`}>
            <circle r="7" cx="7" cy="7" fill="#2563eb" />
            <text x="7" y="9.8" textAnchor="middle" fontSize={String(PROCEDURE_TAG[planned[0].procedure] || 'Tx').length > 1 ? 6.4 : 8.5} fontWeight="700" fill="#fff">
              {PROCEDURE_TAG[planned[0].procedure] || 'Tx'}
            </text>
          </g>
        </g>
      )}
      {/* completed badge */}
      {completed.length > 0 && (
        <g transform={`translate(${planned.length ? 11 : 25},${crownY - 2})`}>
          <circle r="7" cx="7" cy="7" fill="#16a34a" />
          <path d="M 3.8,7.2 L 6.3,9.8 L 10.6,4.8" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </g>
      )}
      {/* condition badges (never color alone) */}
      {badges.map((f, i) => {
        const st = CONDITION_STYLE[f.condition] || CONDITION_STYLE.other;
        return (
          <g key={`b${f.id}-${i}`} transform={`translate(${1 + i * 12.5},${crownY - 2})`}>
            <circle r="6.2" cx="6.2" cy="6.2" fill={st.badgeBg} />
            <text x="6.2" y="8.8" textAnchor="middle" fontSize={st.badge.length > 1 ? 6 : 8} fontWeight="700" fill="#fff">{st.badge}</text>
          </g>
        );
      })}
    </g>
  );
}

/* ---------------- chart (one dentition, both jaws) ---------------- */

export default function Odontogram({ dentition = 'permanent', findings = [], treatments = [], layers = { current: true, planned: true, completed: true }, selected, onSelect, t = (k) => k }) {
  const wrapRef = React.useRef(null);
  const [tip, setTip] = React.useState(null);

  /** Compact tooth summary for hover/focus — never the only access path. */
  function showTip(tooth, el) {
    const wrap = wrapRef.current;
    if (!wrap || !el) return;
    const wr = wrap.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    const active = findings.filter((f) => f.tooth_number === tooth && f.status === 'active');
    const resolved = findings.filter((f) => f.tooth_number === tooth && f.status === 'resolved');
    const planned = treatments.filter((x) => x.tooth_number === tooth && x.status === 'planned');
    const done = treatments.filter((x) => x.tooth_number === tooth && x.status === 'completed');
    const lines = [];
    if (active.length) lines.push(`${t('dental.tooltip.current')}: ${active.map((f) => `${t(`dental.cond.${f.condition}`)}${f.surfaces ? ` (${f.surfaces})` : ''}`).join(', ')}`);
    if (planned.length) lines.push(`${t('dental.tooltip.planned')}: ${planned.map((x) => t(`dental.proc.${x.procedure}`)).join(', ')}`);
    if (done.length) lines.push(`${t('dental.tooltip.completed')}: ${done.map((x) => t(`dental.proc.${x.procedure}`)).join(', ')}`);
    if (resolved.length) lines.push(`${t('dental.tooltip.resolved')}: ${resolved.map((f) => t(`dental.cond.${f.condition}`)).join(', ')}`);
    if (!lines.length) lines.push(t('dental.tooltip.none'));
    setTip({
      tooth, lines,
      left: Math.min(Math.max(er.left - wr.left + er.width / 2, 90), wr.width - 90),
      top: er.top - wr.top,
    });
  }
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const upper = upperRowFor(dentition);
  const lower = lowerRowFor(dentition);
  const step = 43;
  const n = upper.length;
  const width = n * step + 14;
  const midlineX = width / 2;
  const UPPER_Y = 26;   // upper jaw group offset (numbers at ~18)
  const LOWER_Y = 152;  // lower jaw group offset (numbers at ~244)

  const toothRefs = useRef({});

  function onKeyDown(e, tooth) {
    const uIdx = upper.indexOf(tooth);
    const lIdx = lower.indexOf(tooth);
    let next = null;
    if (e.key === 'ArrowRight') next = uIdx >= 0 ? upper[uIdx + 1] : lower[lIdx + 1];
    else if (e.key === 'ArrowLeft') next = uIdx >= 0 ? upper[uIdx - 1] : lower[lIdx - 1];
    else if (e.key === 'ArrowDown' && uIdx >= 0) next = lower[uIdx];
    else if (e.key === 'ArrowUp' && lIdx >= 0) next = upper[lIdx];
    if (next && toothRefs.current[next]) { e.preventDefault(); toothRefs.current[next].focus(); }
  }

  const qLabel = (pos) => (dentition === 'primary' ? pos + 4 : pos);

  return (
    <div className="odont-wrap" ref={wrapRef} style={{ position: 'relative' }}>
    {tip && (
      <div className="odont-tip" role="tooltip" style={{ left: tip.left, top: tip.top - 6 }}>
        <b>{t('dental.tooth')} {tip.tooth}</b>
        {tip.lines.map((l, i) => <div key={i}>{l}</div>)}
        <div className="muted">{t('dental.tooltip.tapHint')}</div>
      </div>
    )}
    <svg viewBox={`0 0 ${width} 252`} className={`odontogram odont-${dentition}`} role="group"
      aria-label={dentition === 'primary' ? t('dental.chartPrimary') : t('dental.chartPermanent')}
      style={{ width: '100%', height: 'auto', display: 'block' }}
    >
      <defs>
        <pattern id={`${uid}-pat-stipple`} width="6" height="6" patternUnits="userSpaceOnUse">
          <circle cx="1.6" cy="1.6" r="1.15" fill="#dc2626" opacity="0.65" />
          <circle cx="4.4" cy="4.2" r="1.15" fill="#dc2626" opacity="0.65" />
        </pattern>
        <pattern id={`${uid}-pat-hatch`} width="6" height="6" patternUnits="userSpaceOnUse">
          <path d="M -1,7 L 7,-1 M 2,8 L 8,2" stroke="#1d4ed8" strokeWidth="1.1" opacity="0.55" />
        </pattern>
        <pattern id={`${uid}-pat-cross`} width="6" height="6" patternUnits="userSpaceOnUse">
          <path d="M -1,7 L 7,-1 M 7,7 L -1,-1" stroke="#b45309" strokeWidth="1" opacity="0.5" />
        </pattern>
      </defs>

      {/* quadrant labels */}
      <text x={midlineX / 2} y="11" textAnchor="middle" fontSize="10.5" fill="var(--muted)" fontWeight="600">
        {qLabel(1)} · {t('dental.quadrant.ur')}
      </text>
      <text x={midlineX + midlineX / 2} y="11" textAnchor="middle" fontSize="10.5" fill="var(--muted)" fontWeight="600">
        {qLabel(2)} · {t('dental.quadrant.ul')}
      </text>

      {/* midline */}
      <line x1={midlineX} y1="16" x2={midlineX} y2="238" stroke="var(--line)" strokeWidth="1" strokeDasharray="4 4" />

      {/* upper tooth numbers */}
      {upper.map((tooth, i) => (
        <text key={`un${tooth}`} x={7 + i * step + 20} y={UPPER_Y - 7} textAnchor="middle" fontSize="11" fontWeight="700"
          fill={selected === tooth ? 'var(--accent)' : 'var(--ink-2)'}>{tooth}</text>
      ))}

      {/* upper jaw (roots up) */}
      <g transform={`translate(7,${UPPER_Y})`}>
        {upper.map((tooth, i) => (
          <Tooth key={tooth} tooth={tooth} x={i * step} flipY={false}
            mesialOnRight={Math.floor(tooth / 10) === 1 || Math.floor(tooth / 10) === 5}
            findings={findings} treatments={treatments} layers={layers}
            selected={selected} onSelect={onSelect} uid={uid} t={t} primary={dentition === 'primary'}
            focusRef={(el) => { toothRefs.current[tooth] = el; }} onKeyDown={onKeyDown}
              onTip={showTip} onTipEnd={() => setTip(null)} />
        ))}
      </g>

      {/* lower jaw (roots down) */}
      <g transform={`translate(7,${LOWER_Y})`}>
        {lower.map((tooth, i) => (
          <Tooth key={tooth} tooth={tooth} x={i * step} flipY
            mesialOnRight={Math.floor(tooth / 10) === 4 || Math.floor(tooth / 10) === 8}
            findings={findings} treatments={treatments} layers={layers}
            selected={selected} onSelect={onSelect} uid={uid} t={t} primary={dentition === 'primary'}
            focusRef={(el) => { toothRefs.current[tooth] = el; }} onKeyDown={onKeyDown}
              onTip={showTip} onTipEnd={() => setTip(null)} />
        ))}
      </g>

      {/* lower tooth numbers */}
      {lower.map((tooth, i) => (
        <text key={`ln${tooth}`} x={7 + i * step + 20} y={LOWER_Y + CELL_H + 13} textAnchor="middle" fontSize="11" fontWeight="700"
          fill={selected === tooth ? 'var(--accent)' : 'var(--ink-2)'}>{tooth}</text>
      ))}

      {/* lower quadrant labels */}
      <text x={midlineX / 2} y="250" textAnchor="middle" fontSize="10.5" fill="var(--muted)" fontWeight="600">
        {qLabel(4)} · {t('dental.quadrant.lr')}
      </text>
      <text x={midlineX + midlineX / 2} y="250" textAnchor="middle" fontSize="10.5" fill="var(--muted)" fontWeight="600">
        {qLabel(3)} · {t('dental.quadrant.ll')}
      </text>
    </svg>
    </div>
  );
}

/* ---------------- legend ---------------- */

export function DentalLegend({ t }) {
  return (
    <div className="dental-legend" role="list" aria-label={t('dental.legend')}>
      {CONDITIONS.map((c) => {
        const st = CONDITION_STYLE[c];
        return (
          <span className="legend-item" role="listitem" key={c}>
            <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
              <path d="M 4,4 L 18,4 L 18,15 Q 18,19 11,19 Q 4,19 4,15 Z"
                fill={st.fill === 'none' ? '#fdfdfc' : st.fill}
                stroke={st.stroke} strokeWidth="1.4"
                strokeDasharray={st.dashed ? '3 2' : undefined} opacity={st.ghost ? 0.6 : 1} />
              {st.ghost && <g stroke={st.stroke} strokeWidth="1.8"><line x1="6" y1="6" x2="16" y2="17" /><line x1="16" y1="6" x2="6" y2="17" /></g>}
              {st.root && <path d="M 9,4 C 9,1 13,1 13,4" fill="none" stroke="#7c3aed" strokeWidth="2.4" />}
              {st.crack && <path d="M 7,5 L 10,10 L 8,13 L 12,17" fill="none" stroke="#ea580c" strokeWidth="1.4" />}
              {st.screw && <path d="M 9,4 L 13,4 L 12,16 L 11,18 L 10,16 Z" fill="#e2e8f0" stroke="#475569" strokeWidth="1" />}
              {st.band && <rect x="4" y="4" width="14" height="3.5" fill="#b45309" opacity="0.85" />}
              {st.pontic && <rect x="2" y="10" width="18" height="2.5" rx="1" fill="#94a3b8" />}
            </svg>
            <span className="legend-badge" style={{ background: st.badgeBg }} aria-hidden="true">{st.badge}</span>
            {t(`dental.cond.${c}`)}
          </span>
        );
      })}
      <span className="legend-item" role="listitem">
        <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
          <rect x="3" y="3" width="16" height="16" rx="5" fill="none" stroke="#2563eb" strokeWidth="1.5" strokeDasharray="4 3" />
        </svg>
        {t('dental.planned')}
      </span>
      <span className="legend-item" role="listitem">
        <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
          <circle cx="11" cy="11" r="8" fill="#16a34a" />
          <path d="M 7,11.2 L 9.8,14 L 15,8.4" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {t('dental.completed')}
      </span>
      <span className="legend-item" role="listitem">
        <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
          <path d="M 4,4 L 18,4 L 18,15 Q 18,19 11,19 Q 4,19 4,15 Z" fill="#fdfdfc" stroke="#94a3b8" strokeWidth="1.3" />
        </svg>
        {t('dental.notAssessed')}
      </span>
    </div>
  );
}
