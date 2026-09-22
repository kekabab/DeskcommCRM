"use client";

import { Gauge, Lightning } from "@phosphor-icons/react";

export type TenantQuotaBarProps = {
  tokens: number;
  capacity: number;
  refillRatePerMinute: number;
  className?: string;
};

export function TenantQuotaBar({
  tokens,
  capacity,
  refillRatePerMinute,
  className = "",
}: TenantQuotaBarProps) {
  const safeCapacity = Math.max(1, capacity);
  const percentage = Math.min(100, Math.max(0, Math.round((tokens / safeCapacity) * 100)));

  const isLow = percentage <= 20;
  const isModerate = percentage > 20 && percentage <= 50;

  const barColor = isLow ? "bg-error" : isModerate ? "bg-warning" : "bg-accent";

  return (
    <div
      className={`flex flex-col gap-1.5 rounded-xl border border-border bg-surface p-4 text-xs ${className}`}
      data-testid="tenant-quota-bar"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 font-medium text-text">
          <Gauge size={16} className="text-accent" aria-hidden />
          <span>Cota de Descoberta do Tenant</span>
        </div>
        <div className="flex items-center gap-1 font-mono text-xs font-semibold text-text">
          <span>{Math.round(tokens)}</span>
          <span className="text-text-muted">/</span>
          <span className="text-text-muted">{capacity}</span>
          <span className="ml-1 text-text-muted">({percentage}%)</span>
        </div>
      </div>

      {/* Barra de Progresso */}
      <div className="relative h-2 w-full overflow-hidden rounded-full bg-border">
        <div
          className={`h-full transition-all duration-300 ${barColor}`}
          style={{ width: `${percentage}%` }}
          role="progressbar"
          aria-valuenow={tokens}
          aria-valuemin={0}
          aria-valuemax={capacity}
        />
      </div>

      <div className="flex items-center justify-between text-[11px] text-text-muted">
        <span className="flex items-center gap-1">
          <Lightning size={13} className="text-accent" aria-hidden />
          Recarga contínua: +{refillRatePerMinute} créditos/min
        </span>
        {isLow ? (
          <span className="font-semibold text-error">Cota reduzida</span>
        ) : (
          <span>Operação normal</span>
        )}
      </div>
    </div>
  );
}
