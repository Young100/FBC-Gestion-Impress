import React, { useMemo, useState } from 'react';
import { TrendingUp } from 'lucide-react';
import { formatFcfa } from '../lib/pricing';
import type { Order, Payment } from '../types/fbc';

interface DashboardChartsProps {
  orders: Order[];
  payments: Payment[];
  isAdmin: boolean;
}

type PeriodDays = 7 | 14 | 30;

interface DayBucket {
  key: string;
  shortLabel: string;
  fullLabel: string;
  ordersCount: number;
  deliveredCount: number;
  inProdOrReadyCount: number;
  revenueFcfa: number;
  validatedPaymentsCount: number;
}

function toLocalDayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseTimestamp(val: unknown): Date | null {
  if (!val) return null;
  if (val instanceof Date) return Number.isNaN(val.getTime()) ? null : val;
  if (typeof val === 'string' || typeof val === 'number') {
    const parsed = new Date(val);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  if (typeof val === 'object') {
    const obj = val as {
      toDate?: () => Date;
      seconds?: number;
      _seconds?: number;
    };
    if (typeof obj.toDate === 'function') {
      const d = obj.toDate();
      return Number.isNaN(d.getTime()) ? null : d;
    }
    const secs =
      typeof obj.seconds === 'number'
        ? obj.seconds
        : typeof obj._seconds === 'number'
          ? obj._seconds
          : null;
    if (secs !== null) {
      const d = new Date(secs * 1000);
      return Number.isNaN(d.getTime()) ? null : d;
    }
  }
  return null;
}

interface Point {
  x: number;
  y: number;
}

/**
 * Generates a smooth SVG Catmull-Rom cubic Bezier curve clamped within [minY, maxY]
 * so curves never overshoot below the baseline or above the chart ceiling.
 */
function buildSmoothCurvePath(points: Point[], minY: number, maxY: number): string {
  if (points.length === 0) return '';
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;

  const clampY = (y: number) => Math.max(minY, Math.min(maxY, y));
  let d = `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;

  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];

    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = clampY(p1.y + (p2.y - p0.y) / 6);
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = clampY(p2.y - (p3.y - p1.y) / 6);

    d += ` C ${cp1x.toFixed(2)} ${cp1y.toFixed(2)}, ${cp2x.toFixed(2)} ${cp2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
  }

  return d;
}

function buildAreaPath(
  linePath: string,
  points: Point[],
  baselineY: number
): string {
  if (!linePath || points.length === 0) return '';
  const first = points[0];
  const last = points[points.length - 1];
  return `${linePath} L ${last.x.toFixed(2)} ${baselineY.toFixed(2)} L ${first.x.toFixed(2)} ${baselineY.toFixed(2)} Z`;
}

function niceUpperBound(rawMax: number, minimum = 4): number {
  if (rawMax <= 0) return minimum;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawMax)));
  const fraction = rawMax / magnitude;
  let niceFraction = 1;
  if (fraction <= 1) niceFraction = 1;
  else if (fraction <= 2) niceFraction = 2;
  else if (fraction <= 4) niceFraction = 4;
  else if (fraction <= 5) niceFraction = 5;
  else if (fraction <= 8) niceFraction = 8;
  else niceFraction = 10;
  return Math.max(minimum, niceFraction * magnitude);
}

function formatCompactAxisFcfa(value: number): string {
  if (value === 0) return '0';
  if (value >= 1_000_000) {
    const m = value / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  if (value >= 1000) {
    const k = value / 1000;
    return `${Number.isInteger(k) ? k : k.toFixed(1)}k`;
  }
  return String(Math.round(value));
}

export const DashboardCharts: React.FC<DashboardChartsProps> = ({
  orders,
  payments,
  isAdmin,
}) => {
  const [period, setPeriod] = useState<PeriodDays>(14);
  const [hoveredOrdersIdx, setHoveredOrdersIdx] = useState<number | null>(null);
  const [hoveredSecondaryIdx, setHoveredSecondaryIdx] = useState<number | null>(null);

  const buckets = useMemo<DayBucket[]>(() => {
    const now = new Date();
    const list: DayBucket[] = [];
    const indexByKey = new Map<string, number>();

    for (let offset = period - 1; offset >= 0; offset--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
      const key = toLocalDayKey(d);
      indexByKey.set(key, list.length);
      list.push({
        key,
        shortLabel: d.toLocaleDateString('fr-FR', {
          day: '2-digit',
          month: '2-digit',
        }),
        fullLabel: d.toLocaleDateString('fr-FR', {
          weekday: 'short',
          day: 'numeric',
          month: 'short',
        }),
        ordersCount: 0,
        deliveredCount: 0,
        inProdOrReadyCount: 0,
        revenueFcfa: 0,
        validatedPaymentsCount: 0,
      });
    }

    for (const order of Array.isArray(orders) ? orders : []) {
      const createdDt =
        parseTimestamp(order.createdAtIso) ||
        parseTimestamp(order.createdAt) ||
        (order.statusHistory?.[0]?.timestamp
          ? parseTimestamp(order.statusHistory[0].timestamp)
          : null);
      if (createdDt) {
        const idx = indexByKey.get(toLocalDayKey(createdDt));
        if (idx !== undefined) {
          list[idx].ordersCount += 1;
        }
      }

      if (order.status === 'livree') {
        const deliveredEntry = [...(order.statusHistory || [])]
          .reverse()
          .find((h) => h.status === 'livree');
        const deliveredDt =
          (deliveredEntry ? parseTimestamp(deliveredEntry.timestamp) : null) ||
          parseTimestamp(order.updatedAt) ||
          createdDt;
        if (deliveredDt) {
          const idx = indexByKey.get(toLocalDayKey(deliveredDt));
          if (idx !== undefined) {
            list[idx].deliveredCount += 1;
          }
        }
      }

      if (
        order.status === 'en_production' ||
        order.status === 'prete' ||
        order.status === 'livree'
      ) {
        const prodEntry = (order.statusHistory || []).find(
          (h) => h.status === 'en_production' || h.status === 'prete'
        );
        const prodDt =
          (prodEntry ? parseTimestamp(prodEntry.timestamp) : null) ||
          parseTimestamp(order.updatedAt) ||
          createdDt;
        if (prodDt) {
          const idx = indexByKey.get(toLocalDayKey(prodDt));
          if (idx !== undefined) {
            list[idx].inProdOrReadyCount += 1;
          }
        }
      }
    }

    for (const payment of Array.isArray(payments) ? payments : []) {
      if (payment.status !== 'valide') continue;
      const dt =
        parseTimestamp(payment.validatedAt) || parseTimestamp(payment.createdAt);
      if (!dt) continue;
      const idx = indexByKey.get(toLocalDayKey(dt));
      if (idx !== undefined) {
        list[idx].revenueFcfa += Number(payment.declaredAmount) || 0;
        list[idx].validatedPaymentsCount += 1;
      }
    }

    return list;
  }, [orders, payments, period]);

  // SVG Layout geometry
  const W = 620;
  const H = 220;
  const PAD_LEFT = 46;
  const PAD_RIGHT = 16;
  const PAD_TOP = 18;
  const PAD_BOTTOM = 32;
  const plotW = W - PAD_LEFT - PAD_RIGHT;
  const plotH = H - PAD_TOP - PAD_BOTTOM;
  const baselineY = PAD_TOP + plotH;

  const getX = (idx: number, count: number) =>
    count <= 1 ? PAD_LEFT + plotW / 2 : PAD_LEFT + (idx / (count - 1)) * plotW;

  // Chart 1 calculations (Orders received vs Delivered)
  const ordersStats = useMemo(() => {
    const totalReceived = buckets.reduce((s, b) => s + b.ordersCount, 0);
    const totalDelivered = buckets.reduce((s, b) => s + b.deliveredCount, 0);
    const rawMax = Math.max(
      ...buckets.map((b) => Math.max(b.ordersCount, b.deliveredCount)),
      0
    );
    const maxVal = niceUpperBound(rawMax, 4);
    const toY = (v: number) => baselineY - (v / maxVal) * plotH;

    const receivedPts: Point[] = buckets.map((b, i) => ({
      x: getX(i, buckets.length),
      y: toY(b.ordersCount),
    }));
    const deliveredPts: Point[] = buckets.map((b, i) => ({
      x: getX(i, buckets.length),
      y: toY(b.deliveredCount),
    }));

    const receivedLine = buildSmoothCurvePath(receivedPts, PAD_TOP, baselineY);
    const receivedArea = buildAreaPath(receivedLine, receivedPts, baselineY);
    const deliveredLine = buildSmoothCurvePath(deliveredPts, PAD_TOP, baselineY);

    const ticks = [0, 0.25, 0.5, 0.75, 1].map((ratio) => ({
      value: Math.round(maxVal * ratio),
      y: baselineY - ratio * plotH,
    }));

    return {
      totalReceived,
      totalDelivered,
      maxVal,
      receivedPts,
      deliveredPts,
      receivedLine,
      receivedArea,
      deliveredLine,
      ticks,
    };
  }, [buckets, baselineY, plotH]);

  // Chart 2 calculations (Admin: Revenue FCFA | Operator: Production throughput)
  const secondaryStats = useMemo(() => {
    const values = buckets.map((b) =>
      isAdmin ? b.revenueFcfa : b.inProdOrReadyCount
    );
    const total = values.reduce((s, v) => s + v, 0);
    const rawMax = Math.max(...values, 0);
    const maxVal = isAdmin
      ? niceUpperBound(rawMax, 10_000)
      : niceUpperBound(rawMax, 4);
    const toY = (v: number) => baselineY - (v / maxVal) * plotH;

    const pts: Point[] = values.map((v, i) => ({
      x: getX(i, buckets.length),
      y: toY(v),
    }));

    const line = buildSmoothCurvePath(pts, PAD_TOP, baselineY);
    const area = buildAreaPath(line, pts, baselineY);

    const ticks = [0, 0.25, 0.5, 0.75, 1].map((ratio) => ({
      value: Math.round(maxVal * ratio),
      y: baselineY - ratio * plotH,
    }));

    return {
      total,
      maxVal,
      pts,
      line,
      area,
      ticks,
      hasData: rawMax > 0,
    };
  }, [buckets, isAdmin, baselineY, plotH]);

  const xLabelStride = period === 7 ? 1 : period === 14 ? 2 : 5;
  const activeOrdersBucket =
    hoveredOrdersIdx !== null ? buckets[hoveredOrdersIdx] : null;
  const activeSecondaryBucket =
    hoveredSecondaryIdx !== null ? buckets[hoveredSecondaryIdx] : null;

  return (
    <section className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-xl bg-[#26547C]/10 text-[#26547C] flex items-center justify-center shrink-0">
            <TrendingUp className="w-4 h-4" />
          </div>
          <div>
            <h2 className="font-display text-lg sm:text-xl text-[#26547C]">
              Tendances et activité de l’atelier
            </h2>
            <p className="text-xs text-slate-500">
              Évolution journalière basée sur les commandes et validations enregistrées
            </p>
          </div>
        </div>

        <div
          role="group"
          aria-label="Période des courbes"
          className="inline-flex items-center gap-1 p-1 rounded-xl bg-white border border-slate-200 self-start sm:self-auto"
        >
          {([7, 14, 30] as PeriodDays[]).map((days) => {
            const active = period === days;
            return (
              <button
                key={days}
                type="button"
                onClick={() => {
                  setPeriod(days);
                  setHoveredOrdersIdx(null);
                  setHoveredSecondaryIdx(null);
                }}
                className={`px-3.5 py-2 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap shrink-0 min-h-[36px] ${
                  active
                    ? 'bg-[#26547C] text-white'
                    : 'text-slate-600 hover:text-[#26547C] hover:bg-[#EDF2F4]/70'
                }`}
              >
                {days} jours
              </button>
            );
          })}
        </div>
      </div>

      <div className="grid lg:grid-cols-2 gap-6">
        {/* Curve Chart 1: Orders Volume & Deliveries */}
        <div className="bg-white rounded-3xl p-5 sm:p-6 border border-slate-200 space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="text-xs font-medium text-slate-500">
                Volume de commandes ({period} derniers jours)
              </div>
              <div className="flex items-baseline gap-3 mt-1">
                <span className="text-2xl font-bold text-[#26547C] tabular-nums">
                  {ordersStats.totalReceived} reçue{ordersStats.totalReceived > 1 ? 's' : ''}
                </span>
                <span className="text-xs font-semibold text-[#119DA4] tabular-nums">
                  {ordersStats.totalDelivered} livrée{ordersStats.totalDelivered > 1 ? 's' : ''}
                </span>
              </div>
            </div>

            <div className="flex items-center gap-4 text-xs text-slate-600">
              <span className="inline-flex items-center gap-1.5">
                <span className="w-3 h-0.5 bg-[#26547C] rounded-full inline-block" />
                Reçues
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="w-3 h-0.5 bg-[#119DA4] rounded-full inline-block" />
                Livrées
              </span>
            </div>
          </div>

          <div className="relative">
            {activeOrdersBucket && hoveredOrdersIdx !== null && (
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2 px-3.5 py-2 rounded-xl bg-[#EDF2F4] text-xs">
                <span className="font-semibold text-[#26547C] capitalize">
                  {activeOrdersBucket.fullLabel}
                </span>
                <div className="flex items-center gap-3 tabular-nums">
                  <span className="font-bold text-[#26547C]">
                    {activeOrdersBucket.ordersCount} reçue
                    {activeOrdersBucket.ordersCount > 1 ? 's' : ''}
                  </span>
                  <span className="text-slate-400">·</span>
                  <span className="font-bold text-[#119DA4]">
                    {activeOrdersBucket.deliveredCount} livrée
                    {activeOrdersBucket.deliveredCount > 1 ? 's' : ''}
                  </span>
                </div>
              </div>
            )}

            <svg
              viewBox={`0 0 ${W} ${H}`}
              className="w-full h-auto overflow-visible select-none"
              role="img"
              aria-label={`Courbe des commandes reçues et livrées sur ${period} jours`}
              onMouseLeave={() => setHoveredOrdersIdx(null)}
            >
              <defs>
                <linearGradient id="fbcOrdersGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#26547C" stopOpacity="0.22" />
                  <stop offset="100%" stopColor="#26547C" stopOpacity="0.01" />
                </linearGradient>
              </defs>

              {/* Horizontal Gridlines & Y Labels */}
              {ordersStats.ticks.map((t, idx) => (
                <g key={idx}>
                  <line
                    x1={PAD_LEFT}
                    x2={W - PAD_RIGHT}
                    y1={t.y}
                    y2={t.y}
                    stroke={idx === 0 ? '#CBD5E1' : '#E2E8F0'}
                    strokeWidth={1}
                    strokeDasharray={idx === 0 ? undefined : '4 4'}
                  />
                  <text
                    x={PAD_LEFT - 8}
                    y={t.y + 4}
                    textAnchor="end"
                    className="fill-slate-400 text-[10px] font-mono tabular-nums"
                  >
                    {t.value}
                  </text>
                </g>
              ))}

              {/* Area & Curves */}
              <path d={ordersStats.receivedArea} fill="url(#fbcOrdersGrad)" />
              <path
                d={ordersStats.deliveredLine}
                fill="none"
                stroke="#119DA4"
                strokeWidth={2.25}
                strokeDasharray="5 4"
                strokeLinecap="round"
              />
              <path
                d={ordersStats.receivedLine}
                fill="none"
                stroke="#26547C"
                strokeWidth={2.75}
                strokeLinecap="round"
              />

              {/* X Axis Labels */}
              {buckets.map((b, i) => {
                const show = i % xLabelStride === 0 || i === buckets.length - 1;
                if (!show) return null;
                const x = getX(i, buckets.length);
                return (
                  <text
                    key={b.key}
                    x={x}
                    y={H - 8}
                    textAnchor="middle"
                    className="fill-slate-500 text-[10px] font-mono tabular-nums"
                  >
                    {b.shortLabel}
                  </text>
                );
              })}

              {/* Hover Guide & Points */}
              {hoveredOrdersIdx !== null && (
                <g>
                  <line
                    x1={ordersStats.receivedPts[hoveredOrdersIdx].x}
                    x2={ordersStats.receivedPts[hoveredOrdersIdx].x}
                    y1={PAD_TOP}
                    y2={baselineY}
                    stroke="#94A3B8"
                    strokeWidth={1}
                    strokeDasharray="3 3"
                  />
                  <circle
                    cx={ordersStats.deliveredPts[hoveredOrdersIdx].x}
                    cy={ordersStats.deliveredPts[hoveredOrdersIdx].y}
                    r={4.5}
                    fill="#FFFFFF"
                    stroke="#119DA4"
                    strokeWidth={2.5}
                  />
                  <circle
                    cx={ordersStats.receivedPts[hoveredOrdersIdx].x}
                    cy={ordersStats.receivedPts[hoveredOrdersIdx].y}
                    r={5}
                    fill="#FFFFFF"
                    stroke="#26547C"
                    strokeWidth={2.5}
                  />
                </g>
              )}

              {/* Subtle Data Vertices on 7-day & 14-day views */}
              {period <= 14 &&
                ordersStats.receivedPts.map((pt, i) => (
                  <circle
                    key={buckets[i].key}
                    cx={pt.x}
                    cy={pt.y}
                    r={hoveredOrdersIdx === i ? 5 : 2.75}
                    fill={hoveredOrdersIdx === i ? '#FFFFFF' : '#26547C'}
                    stroke="#26547C"
                    strokeWidth={hoveredOrdersIdx === i ? 2.5 : 0}
                    className="pointer-events-none"
                  />
                ))}

              {/* Interactive Hit Zones */}
              {buckets.map((b, i) => {
                const x = getX(i, buckets.length);
                const stepW = buckets.length > 1 ? plotW / (buckets.length - 1) : plotW;
                return (
                  <rect
                    key={b.key}
                    x={Math.max(PAD_LEFT, x - stepW / 2)}
                    y={PAD_TOP}
                    width={stepW}
                    height={plotH + PAD_BOTTOM}
                    fill="transparent"
                    className="cursor-pointer"
                    onMouseEnter={() => setHoveredOrdersIdx(i)}
                    onClick={() =>
                      setHoveredOrdersIdx((prev) => (prev === i ? null : i))
                    }
                  />
                );
              })}
            </svg>
          </div>
        </div>

        {/* Curve Chart 2: Revenue (Admin) or Production Cadence (Operator) */}
        <div className="bg-white rounded-3xl p-5 sm:p-6 border border-slate-200 space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="text-xs font-medium text-slate-500">
                {isAdmin
                  ? `Encaissements validés (${period} derniers jours)`
                  : `Cadence de production (${period} derniers jours)`}
              </div>
              <div className="text-2xl font-bold text-[#26547C] mt-1 tabular-nums">
                {isAdmin
                  ? formatFcfa(secondaryStats.total)
                  : `${secondaryStats.total} lancée${secondaryStats.total > 1 ? 's' : ''}`}
              </div>
            </div>

            <div className="flex items-center gap-2 text-xs text-slate-600">
              <span
                className={`w-3 h-0.5 rounded-full inline-block ${
                  isAdmin ? 'bg-[#2E9E6B]' : 'bg-[#119DA4]'
                }`}
              />
              <span>{isAdmin ? 'Recettes journalières' : 'Production / Prêtes'}</span>
            </div>
          </div>

          <div className="relative">
            {activeSecondaryBucket && hoveredSecondaryIdx !== null && (
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2 px-3.5 py-2 rounded-xl bg-[#EDF2F4] text-xs">
                <span className="font-semibold text-[#26547C] capitalize">
                  {activeSecondaryBucket.fullLabel}
                </span>
                <span
                  className={`font-bold tabular-nums ${
                    isAdmin ? 'text-[#237A52]' : 'text-[#0E7F85]'
                  }`}
                >
                  {isAdmin
                    ? `${formatFcfa(activeSecondaryBucket.revenueFcfa)} · ${activeSecondaryBucket.validatedPaymentsCount} paiement${activeSecondaryBucket.validatedPaymentsCount > 1 ? 's' : ''}`
                    : `${activeSecondaryBucket.inProdOrReadyCount} commande${activeSecondaryBucket.inProdOrReadyCount > 1 ? 's' : ''} traitée${activeSecondaryBucket.inProdOrReadyCount > 1 ? 's' : ''}`}
                </span>
              </div>
            )}

            <svg
              viewBox={`0 0 ${W} ${H}`}
              className="w-full h-auto overflow-visible select-none"
              role="img"
              aria-label={
                isAdmin
                  ? `Courbe des encaissements validés sur ${period} jours`
                  : `Courbe de production sur ${period} jours`
              }
              onMouseLeave={() => setHoveredSecondaryIdx(null)}
            >
              <defs>
                <linearGradient id="fbcSecondaryGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop
                    offset="0%"
                    stopColor={isAdmin ? '#2E9E6B' : '#119DA4'}
                    stopOpacity="0.24"
                  />
                  <stop
                    offset="100%"
                    stopColor={isAdmin ? '#2E9E6B' : '#119DA4'}
                    stopOpacity="0.01"
                  />
                </linearGradient>
              </defs>

              {/* Horizontal Gridlines & Y Labels */}
              {secondaryStats.ticks.map((t, idx) => (
                <g key={idx}>
                  <line
                    x1={PAD_LEFT}
                    x2={W - PAD_RIGHT}
                    y1={t.y}
                    y2={t.y}
                    stroke={idx === 0 ? '#CBD5E1' : '#E2E8F0'}
                    strokeWidth={1}
                    strokeDasharray={idx === 0 ? undefined : '4 4'}
                  />
                  <text
                    x={PAD_LEFT - 8}
                    y={t.y + 4}
                    textAnchor="end"
                    className="fill-slate-400 text-[10px] font-mono tabular-nums"
                  >
                    {isAdmin ? formatCompactAxisFcfa(t.value) : t.value}
                  </text>
                </g>
              ))}

              <path d={secondaryStats.area} fill="url(#fbcSecondaryGrad)" />
              <path
                d={secondaryStats.line}
                fill="none"
                stroke={isAdmin ? '#2E9E6B' : '#119DA4'}
                strokeWidth={2.75}
                strokeLinecap="round"
              />

              {/* X Axis Labels */}
              {buckets.map((b, i) => {
                const show = i % xLabelStride === 0 || i === buckets.length - 1;
                if (!show) return null;
                const x = getX(i, buckets.length);
                return (
                  <text
                    key={b.key}
                    x={x}
                    y={H - 8}
                    textAnchor="middle"
                    className="fill-slate-500 text-[10px] font-mono tabular-nums"
                  >
                    {b.shortLabel}
                  </text>
                );
              })}

              {/* Hover Guide & Point */}
              {hoveredSecondaryIdx !== null && (
                <g>
                  <line
                    x1={secondaryStats.pts[hoveredSecondaryIdx].x}
                    x2={secondaryStats.pts[hoveredSecondaryIdx].x}
                    y1={PAD_TOP}
                    y2={baselineY}
                    stroke="#94A3B8"
                    strokeWidth={1}
                    strokeDasharray="3 3"
                  />
                  <circle
                    cx={secondaryStats.pts[hoveredSecondaryIdx].x}
                    cy={secondaryStats.pts[hoveredSecondaryIdx].y}
                    r={5}
                    fill="#FFFFFF"
                    stroke={isAdmin ? '#2E9E6B' : '#119DA4'}
                    strokeWidth={2.5}
                  />
                </g>
              )}

              {period <= 14 &&
                secondaryStats.pts.map((pt, i) => (
                  <circle
                    key={buckets[i].key}
                    cx={pt.x}
                    cy={pt.y}
                    r={hoveredSecondaryIdx === i ? 5 : 2.75}
                    fill={
                      hoveredSecondaryIdx === i
                        ? '#FFFFFF'
                        : isAdmin
                          ? '#2E9E6B'
                          : '#119DA4'
                    }
                    stroke={isAdmin ? '#2E9E6B' : '#119DA4'}
                    strokeWidth={hoveredSecondaryIdx === i ? 2.5 : 0}
                    className="pointer-events-none"
                  />
                ))}

              {buckets.map((b, i) => {
                const x = getX(i, buckets.length);
                const stepW = buckets.length > 1 ? plotW / (buckets.length - 1) : plotW;
                return (
                  <rect
                    key={b.key}
                    x={Math.max(PAD_LEFT, x - stepW / 2)}
                    y={PAD_TOP}
                    width={stepW}
                    height={plotH + PAD_BOTTOM}
                    fill="transparent"
                    className="cursor-pointer"
                    onMouseEnter={() => setHoveredSecondaryIdx(i)}
                    onClick={() =>
                      setHoveredSecondaryIdx((prev) => (prev === i ? null : i))
                    }
                  />
                );
              })}
            </svg>

            {!secondaryStats.hasData && (
              <p className="text-[11px] text-slate-400 text-center mt-1">
                {isAdmin
                  ? 'Aucun encaissement validé sur cette période.'
                  : 'Aucune mise en production enregistrée sur cette période.'}
              </p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
};
