"use client";

import { useCallback, useEffect, useRef, type PointerEvent } from "react";
import { Eraser } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { SIGNATURE_HEIGHT, SIGNATURE_WIDTH, strokesToPath } from "@/modules/quotes/constants";

type Point = { x: number; y: number };

/** Enough for a long signature; the stored path stays well under its limit. */
const MAX_POINTS = 2_500;

/**
 * A pad to sign on with a finger, a pen or the mouse. What is drawn is kept
 * in the pad's own 600 × 200 space, whatever its size on screen, and handed
 * up as an SVG path ("" once cleared). The page does not scroll while a
 * finger is drawing on it.
 */
export function SignaturePad({
  id,
  label,
  hint,
  clearLabel,
  invalid,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  clearLabel: string;
  invalid?: boolean;
  onChange: (path: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const strokes = useRef<Point[][]>([]);
  const drawing = useRef(false);

  const context = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return null;
    ctx.lineWidth = 4;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = getComputedStyle(canvas).color;
    return ctx;
  }, []);

  /** Size the bitmap to the pad on screen (sharp on any screen) and draw every stroke again. */
  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(rect.width * ratio));
    canvas.height = Math.max(1, Math.round(rect.height * ratio));
    const ctx = context();
    if (!ctx) return;
    ctx.setTransform(canvas.width / SIGNATURE_WIDTH, 0, 0, canvas.height / SIGNATURE_HEIGHT, 0, 0);
    ctx.clearRect(0, 0, SIGNATURE_WIDTH, SIGNATURE_HEIGHT);
    for (const stroke of strokes.current) {
      ctx.beginPath();
      stroke.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      if (stroke.length === 1) ctx.lineTo(stroke[0]!.x + 0.5, stroke[0]!.y);
      ctx.stroke();
    }
  }, [context]);

  useEffect(() => {
    redraw();
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => redraw());
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [redraw]);

  const pointOf = (e: PointerEvent<HTMLCanvasElement>): Point => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: ((e.clientX - rect.left) * SIGNATURE_WIDTH) / rect.width, y: ((e.clientY - rect.top) * SIGNATURE_HEIGHT) / rect.height };
  };
  const points = () => strokes.current.reduce((n, s) => n + s.length, 0);

  function down(e: PointerEvent<HTMLCanvasElement>) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (points() >= MAX_POINTS) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = true;
    strokes.current.push([pointOf(e)]);
    redraw();
  }

  function move(e: PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    const stroke = strokes.current[strokes.current.length - 1];
    const last = stroke?.[stroke.length - 1];
    if (!stroke || !last) return;
    const p = pointOf(e);
    // Every couple of units: a smooth line, and a short path.
    if (Math.hypot(p.x - last.x, p.y - last.y) < 2 || points() >= MAX_POINTS) return;
    stroke.push(p);
    const ctx = context();
    if (!ctx) return;
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  }

  function up() {
    if (!drawing.current) return;
    drawing.current = false;
    onChange(strokesToPath(strokes.current));
  }

  function clear() {
    strokes.current = [];
    redraw();
    onChange("");
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-end justify-between gap-2">
        <label htmlFor={id} className="data-label block">
          {label}
        </label>
        <Button type="button" variant="ghost" size="sm" onClick={clear}>
          <Eraser className="h-3.5 w-3.5" aria-hidden="true" />
          {clearLabel}
        </Button>
      </div>
      <canvas
        id={id}
        ref={canvasRef}
        aria-label={label}
        aria-describedby={`${id}-hint`}
        aria-invalid={invalid ? true : undefined}
        data-testid="signature-pad"
        className={cn(
          "block aspect-[3/1] w-full cursor-crosshair touch-none rounded-lg border bg-background text-foreground",
          invalid ? "border-danger" : "border-input",
        )}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onLostPointerCapture={up}
      />
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">
        {hint}
      </p>
    </div>
  );
}
