import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as d3 from 'd3';
import { Candle, Order, Position } from '../types';
import { formatCurrency } from '../utils/cryptoMath';
import {
  buildSymbolPnlSeries,
  computeRealizedPnlForSymbol,
  computeUnrealizedPnlForSymbol,
  type PnlDataPoint,
} from '../utils/symbolPnlSeries';

interface SymbolPnlChartProps {
  symbol: string;
  positions: Position[];
  orders: Order[];
  candles?: Candle[];
}

export const SymbolPnlChart: React.FC<SymbolPnlChartProps> = ({
  symbol,
  positions,
  orders,
  candles,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [chartWidth, setChartWidth] = useState<number>(720);
  const [hoverPoint, setHoverPoint] = useState<PnlDataPoint | null>(null);

  // Rolling live snapshots keyed by symbol so switching symbols preserves recent unrealized/realized history
  const [snapshotsBySymbol, setSnapshotsBySymbol] = useState<Record<string, PnlDataPoint[]>>({});

  const currentRealized = useMemo(
    () => computeRealizedPnlForSymbol(orders, symbol),
    [orders, symbol]
  );
  const currentUnrealized = useMemo(
    () => computeUnrealizedPnlForSymbol(positions, symbol),
    [positions, symbol]
  );

  // Track container width responsively
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const updateWidth = () => {
      const next = Math.max(320, Math.floor(el.clientWidth));
      setChartWidth(next);
    };
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Append real-time snapshots whenever realized or unrealized PnL changes for selected symbol
  useEffect(() => {
    const now = Date.now();
    setSnapshotsBySymbol((prev) => {
      const existing = prev[symbol] ?? [];
      const last = existing[existing.length - 1];
      const elapsed = last ? now - last.timestamp : Infinity;
      const realizedDelta = last ? Math.abs(last.realizedPnl - currentRealized) : Infinity;
      const unrealizedDelta = last ? Math.abs(last.unrealizedPnl - currentUnrealized) : Infinity;

      if (last && elapsed < 1500 && realizedDelta < 0.005 && unrealizedDelta < 0.005) {
        return prev;
      }

      const nextList = [
        ...existing,
        {
          timestamp: now,
          realizedPnl: currentRealized,
          unrealizedPnl: currentUnrealized,
        },
      ].slice(-240);

      return {
        ...prev,
        [symbol]: nextList,
      };
    });
  }, [symbol, currentRealized, currentUnrealized]);

  const series = useMemo(() => {
    const liveSnapshots = snapshotsBySymbol[symbol] ?? [];
    return buildSymbolPnlSeries({
      symbol,
      positions,
      orders,
      candles,
      liveSnapshots,
    });
  }, [symbol, positions, orders, candles, snapshotsBySymbol]);

  const hasSymbolActivity = useMemo(() => {
    const hasOpen = positions.some((p) => p.symbol === symbol);
    const hasClosedOrder = orders.some((o) => o.symbol === symbol && typeof o.pnl === 'number');
    return hasOpen || hasClosedOrder;
  }, [positions, orders, symbol]);

  // Render & update D3 line chart cleanly whenever series or container dimensions change
  useEffect(() => {
    const svgEl = svgRef.current;
    if (!svgEl || series.length === 0) return;

    const height = 176;
    const margin = { top: 14, right: 16, bottom: 24, left: 60 };
    const innerWidth = Math.max(180, chartWidth - margin.left - margin.right);
    const innerHeight = height - margin.top - margin.bottom;

    const svg = d3.select(svgEl);
    svg.selectAll('*').remove();

    svg.attr('viewBox', `0 0 ${chartWidth} ${height}`).attr('width', chartWidth).attr('height', height);

    const defs = svg.append('defs');

    const realizedGrad = defs
      .append('linearGradient')
      .attr('id', 'realized-pnl-grad')
      .attr('x1', '0%')
      .attr('y1', '0%')
      .attr('x2', '0%')
      .attr('y2', '100%');
    realizedGrad.append('stop').attr('offset', '0%').attr('stop-color', '#10b981').attr('stop-opacity', 0.22);
    realizedGrad.append('stop').attr('offset', '100%').attr('stop-color', '#10b981').attr('stop-opacity', 0.0);

    const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

    const xExtent = d3.extent(series, (d) => new Date(d.timestamp)) as [Date, Date];
    const xScale = d3.scaleTime().domain(xExtent).range([0, innerWidth]);

    const allValues = series.flatMap((d) => [d.realizedPnl, d.unrealizedPnl, 0]);
    const rawMin = d3.min(allValues) ?? -1;
    const rawMax = d3.max(allValues) ?? 1;
    const span = rawMax - rawMin;
    const pad = span > 0 ? span * 0.16 : 1;
    const yScale = d3
      .scaleLinear()
      .domain([rawMin - pad, rawMax + pad])
      .nice(4)
      .range([innerHeight, 0]);

    // Horizontal gridlines
    const yAxisGrid = d3
      .axisLeft(yScale)
      .ticks(4)
      .tickSize(-innerWidth)
      .tickFormat(() => '');

    g.append('g')
      .attr('class', 'pnl-grid')
      .call(yAxisGrid)
      .call((grid) => {
        grid.select('.domain').remove();
        grid
          .selectAll('line')
          .attr('stroke', '#1e293b')
          .attr('stroke-opacity', 0.85)
          .attr('stroke-width', 1);
      });

    // Zero PnL reference line
    const zeroY = yScale(0);
    g.append('line')
      .attr('x1', 0)
      .attr('x2', innerWidth)
      .attr('y1', zeroY)
      .attr('y2', zeroY)
      .attr('stroke', '#475569')
      .attr('stroke-width', 1)
      .attr('stroke-dasharray', '4,3');

    // Subtle area under Realized PnL to zero baseline
    const realizedArea = d3
      .area<PnlDataPoint>()
      .x((d) => xScale(new Date(d.timestamp)))
      .y0(zeroY)
      .y1((d) => yScale(d.realizedPnl))
      .curve(d3.curveMonotoneX);

    g.append('path')
      .datum(series)
      .attr('fill', 'url(#realized-pnl-grad)')
      .attr('d', realizedArea);

    // Line generators
    const realizedLine = d3
      .line<PnlDataPoint>()
      .x((d) => xScale(new Date(d.timestamp)))
      .y((d) => yScale(d.realizedPnl))
      .curve(d3.curveMonotoneX);

    const unrealizedLine = d3
      .line<PnlDataPoint>()
      .x((d) => xScale(new Date(d.timestamp)))
      .y((d) => yScale(d.unrealizedPnl))
      .curve(d3.curveMonotoneX);

    // Realized PnL line (solid emerald)
    g.append('path')
      .datum(series)
      .attr('fill', 'none')
      .attr('stroke', '#10b981')
      .attr('stroke-width', 2)
      .attr('d', realizedLine);

    // Unrealized PnL line (crisp sky/cyan)
    g.append('path')
      .datum(series)
      .attr('fill', 'none')
      .attr('stroke', '#38bdf8')
      .attr('stroke-width', 2)
      .attr('stroke-dasharray', '5,3')
      .attr('d', unrealizedLine);

    // Latest endpoints
    const lastPt = series[series.length - 1];
    g.append('circle')
      .attr('cx', xScale(new Date(lastPt.timestamp)))
      .attr('cy', yScale(lastPt.realizedPnl))
      .attr('r', 3.5)
      .attr('fill', '#10b981')
      .attr('stroke', '#0f172a')
      .attr('stroke-width', 1.5);

    g.append('circle')
      .attr('cx', xScale(new Date(lastPt.timestamp)))
      .attr('cy', yScale(lastPt.unrealizedPnl))
      .attr('r', 3.5)
      .attr('fill', '#38bdf8')
      .attr('stroke', '#0f172a')
      .attr('stroke-width', 1.5);

    // Axes
    const xTickCount = Math.max(3, Math.min(6, Math.floor(innerWidth / 120)));
    const xAxis = d3
      .axisBottom<Date>(xScale)
      .ticks(xTickCount)
      .tickFormat((d) => d3.timeFormat('%H:%M')(d));

    g.append('g')
      .attr('transform', `translate(0,${innerHeight})`)
      .call(xAxis)
      .call((ax) => {
        ax.select('.domain').attr('stroke', '#334155');
        ax.selectAll('line').attr('stroke', '#334155');
        ax.selectAll('text')
          .attr('fill', '#94a3b8')
          .attr('font-size', '10px')
          .attr('font-family', 'ui-monospace, SFMono-Regular, Menlo, monospace');
      });

    const yAxis = d3
      .axisLeft(yScale)
      .ticks(4)
      .tickFormat((d) => {
        const num = Number(d);
        const abs = Math.abs(num);
        const prefix = num < 0 ? '-$' : '$';
        if (abs >= 1000) return `${prefix}${(abs / 1000).toFixed(1)}k`;
        return `${prefix}${abs.toFixed(abs < 10 ? 2 : 0)}`;
      });

    g.append('g')
      .call(yAxis)
      .call((ax) => {
        ax.select('.domain').remove();
        ax.selectAll('line').remove();
        ax.selectAll('text')
          .attr('fill', '#94a3b8')
          .attr('font-size', '10px')
          .attr('font-family', 'ui-monospace, SFMono-Regular, Menlo, monospace');
      });

    // Interactive Hover Crosshair Overlay
    const focusGroup = g.append('g').style('display', 'none');

    const crosshairLine = focusGroup
      .append('line')
      .attr('y1', 0)
      .attr('y2', innerHeight)
      .attr('stroke', '#64748b')
      .attr('stroke-width', 1)
      .attr('stroke-dasharray', '2,2');

    const focusRealizedDot = focusGroup
      .append('circle')
      .attr('r', 4.5)
      .attr('fill', '#10b981')
      .attr('stroke', '#ffffff')
      .attr('stroke-width', 1.5);

    const focusUnrealizedDot = focusGroup
      .append('circle')
      .attr('r', 4.5)
      .attr('fill', '#38bdf8')
      .attr('stroke', '#ffffff')
      .attr('stroke-width', 1.5);

    const bisectDate = d3.bisector<PnlDataPoint, number>((d) => d.timestamp).center;

    g.append('rect')
      .attr('width', innerWidth)
      .attr('height', innerHeight)
      .attr('fill', 'transparent')
      .style('cursor', 'crosshair')
      .on('mouseenter', () => {
        focusGroup.style('display', null);
      })
      .on('mouseleave', () => {
        focusGroup.style('display', 'none');
        setHoverPoint(null);
      })
      .on('mousemove', (event: MouseEvent) => {
        const [mx] = d3.pointer(event);
        const hoveredTs = xScale.invert(mx).getTime();
        const idx = Math.max(0, Math.min(series.length - 1, bisectDate(series, hoveredTs)));
        const pt = series[idx];
        if (!pt) return;

        const cx = xScale(new Date(pt.timestamp));
        crosshairLine.attr('x1', cx).attr('x2', cx);
        focusRealizedDot.attr('cx', cx).attr('cy', yScale(pt.realizedPnl));
        focusUnrealizedDot.attr('cx', cx).attr('cy', yScale(pt.unrealizedPnl));
        setHoverPoint(pt);
      });
  }, [series, chartWidth]);

  const activePoint = hoverPoint ?? series[series.length - 1];
  const netSymbolPnl = activePoint.realizedPnl + activePoint.unrealizedPnl;

  return (
    <div className="border-b border-slate-800/80 bg-slate-950/35 px-4 py-3">
      {/* Unboxed Header Metadata & Live Series Readout */}
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2 text-xs">
        <div className="flex flex-wrap items-center gap-2 text-slate-300">
          <span className="font-semibold text-white">{symbol} PnL Timeline</span>
          <span className="text-slate-600" aria-hidden="true">·</span>
          <span className="inline-flex items-center gap-1.5 text-slate-300">
            <span className="inline-block w-3 h-0.5 bg-emerald-400" aria-hidden="true" />
            <span>Realized:</span>
            <span
              className={`font-mono tabular-nums font-semibold ${
                activePoint.realizedPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'
              }`}
            >
              {activePoint.realizedPnl >= 0 ? '+' : ''}
              {formatCurrency(activePoint.realizedPnl)}
            </span>
          </span>
          <span className="text-slate-600" aria-hidden="true">·</span>
          <span className="inline-flex items-center gap-1.5 text-slate-300">
            <span
              className="inline-block w-3 border-t-2 border-dashed border-sky-400"
              aria-hidden="true"
            />
            <span>Unrealized:</span>
            <span
              className={`font-mono tabular-nums font-semibold ${
                activePoint.unrealizedPnl >= 0 ? 'text-sky-400' : 'text-rose-400'
              }`}
            >
              {activePoint.unrealizedPnl >= 0 ? '+' : ''}
              {formatCurrency(activePoint.unrealizedPnl)}
            </span>
          </span>
          <span className="text-slate-600" aria-hidden="true">·</span>
          <span className="text-slate-400">
            Net:{' '}
            <span
              className={`font-mono tabular-nums font-semibold ${
                netSymbolPnl >= 0 ? 'text-white' : 'text-rose-400'
              }`}
            >
              {netSymbolPnl >= 0 ? '+' : ''}
              {formatCurrency(netSymbolPnl)}
            </span>
          </span>
        </div>

        <div className="text-[11px] font-mono tabular-nums text-slate-400">
          {hoverPoint
            ? `Sample ${new Date(hoverPoint.timestamp).toLocaleTimeString()}`
            : hasSymbolActivity
            ? `${series.length} samples`
            : `No open positions or closes for ${symbol} yet`}
        </div>
      </div>

      {/* Responsive D3 SVG Container */}
      <div ref={containerRef} className="w-full overflow-hidden">
        <svg ref={svgRef} className="block w-full select-none" role="img" aria-label={`${symbol} realized versus unrealized PnL line chart`} />
      </div>
    </div>
  );
};
