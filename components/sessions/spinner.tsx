"use client";

import { useMemo } from "react";
import { cn } from "@/lib/utils";

interface SpinnerProps {
  className?: string;
}

const GRID = 4;
const CORNERS = new Set([0, 3, 12, 15]);

export function Spinner({ className }: SpinnerProps) {
  const cells = useMemo(() => {
    return Array.from({ length: GRID * GRID }, (_, i) => {
      if (CORNERS.has(i)) return null;
      const row = Math.floor(i / GRID);
      const col = i % GRID;
      const isOuter = row === 0 || row === 3 || col === 0 || col === 3;
      return {
        x: col * 5,
        y: row * 5,
        delay: `${(Math.random() * 1.5).toFixed(2)}s`,
        duration: `${(1 + Math.random()).toFixed(2)}s`,
        isOuter,
      };
    });
  }, []);

  return (
    <svg
      className={cn("h-[18px] w-[18px] shrink-0", className)}
      viewBox="0 0 18 18"
      fill="currentColor"
    >
      {cells.map((cell, i) =>
        cell ? (
          <rect
            key={i}
            x={cell.x + 0.5}
            y={cell.y + 0.5}
            width={3}
            height={3}
            rx={1}
            className={cell.isOuter ? "animate-pulse-dim" : "animate-pulse-bright"}
            style={{
              animationDelay: cell.delay,
              animationDuration: cell.duration,
            }}
          />
        ) : null,
      )}
    </svg>
  );
}
