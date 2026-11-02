import { useCallback, useEffect, useRef, useState } from 'react';

export const MIN_SPEED = 0.25;
export const MAX_SPEED = 4;
export const SPEED_STEP = 0.25;
const BASE_STEP_MS = 1400;

export interface PlayerControls {
  index: number;
  playing: boolean;
  speed: number;
  atStart: boolean;
  atEnd: boolean;
  togglePlay: () => void;
  stepForward: () => void;
  stepBack: () => void;
  seek: (index: number) => void;
  setSpeed: (speed: number) => void;
}

/**
 * Steps through a trace. `speedFactor` is the student's animation speed from Settings, which
 * multiplies this player's own speed. `onInteract` fires on any control, so the app knows the
 * student actually used the visualizer.
 */
export function usePlayer(
  length: number,
  { speedFactor = 1, onInteract }: { speedFactor?: number; onInteract?: () => void } = {},
): PlayerControls {
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeedState] = useState(1);
  const last = Math.max(0, length - 1);

  // Kept in a ref so a new callback from the parent never restarts the timer.
  const interact = useRef(onInteract);
  interact.current = onInteract;

  useEffect(() => {
    if (!playing) return;
    if (index >= last) {
      setPlaying(false);
      return;
    }
    const timer = setTimeout(
      () => setIndex((current) => Math.min(current + 1, last)),
      BASE_STEP_MS / (speed * speedFactor),
    );
    return () => clearTimeout(timer);
  }, [playing, index, last, speed, speedFactor]);

  const seek = useCallback(
    (next: number) => {
      interact.current?.();
      setPlaying(false);
      setIndex(Math.min(Math.max(0, next), last));
    },
    [last],
  );

  const togglePlay = useCallback(() => {
    interact.current?.();
    setPlaying((current) => {
      if (current) return false;
      // Pressing play at the end starts over.
      setIndex((position) => (position >= last ? 0 : position));
      return true;
    });
  }, [last]);

  const stepForward = useCallback(() => {
    interact.current?.();
    setPlaying(false);
    setIndex((current) => Math.min(current + 1, last));
  }, [last]);

  const stepBack = useCallback(() => {
    interact.current?.();
    setPlaying(false);
    setIndex((current) => Math.max(current - 1, 0));
  }, []);

  const setSpeed = useCallback((next: number) => {
    setSpeedState(Math.min(MAX_SPEED, Math.max(MIN_SPEED, next)));
  }, []);

  return {
    index: Math.min(index, last),
    playing,
    speed,
    atStart: index <= 0,
    atEnd: index >= last,
    togglePlay,
    stepForward,
    stepBack,
    seek,
    setSpeed,
  };
}
