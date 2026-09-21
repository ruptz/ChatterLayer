'use client';

import { useEffect, useState } from 'react';
import { CaptionPill } from '@/components/CaptionPill';
import { transcript } from '@/lib/content';

/**
 * The hero, and the only moving thing on the page.
 *
 * A static screenshot of a caption is a poor description of a caption — the
 * whole point is that it arrives, faded, while someone is still talking, and
 * then rewrites itself. So the page shows that happening rather than claiming
 * it, on the app's own colours over the app's own background.
 *
 * With prefers-reduced-motion the reel stops and three finished lines stand
 * still, which says the same thing without the movement.
 */

/** How many captions stay on screen. The overlay's own default is 3. */
const VISIBLE = 3;
/** How long the faded guess holds before the real decode lands. */
const GUESS_MS = 460;
/** The pause before the next person talks. */
const HOLD_MS = 1600;

type Shown = { id: number; speaker: string; body: string; partial: boolean };

export function CaptionStage() {
  const [lines, setLines] = useState<Shown[]>([]);
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setReduced(query.matches);
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);

  useEffect(() => {
    if (reduced) {
      setLines(
        transcript.slice(0, VISIBLE).map((line, index) => ({
          id: index,
          speaker: line.speaker,
          body: line.text,
          partial: false,
        })),
      );
      return;
    }

    // Start from an empty stage. Strict Mode mounts effects twice in
    // development, and without this the first run's opening line is still on
    // screen when the second run pushes its own.
    setLines([]);

    let cursor = 0;
    let nextId = 0;
    let timer: ReturnType<typeof setTimeout>;

    const speak = () => {
      const line = transcript[cursor % transcript.length];
      const id = nextId++;

      setLines((prev) =>
        [
          ...prev,
          {
            id,
            speaker: line.speaker,
            body: line.guess ?? line.text,
            partial: Boolean(line.guess),
          },
        ].slice(-VISIBLE),
      );

      const advance = () => {
        cursor += 1;
        timer = setTimeout(speak, HOLD_MS);
      };

      if (line.guess) {
        timer = setTimeout(() => {
          setLines((prev) =>
            prev.map((shown) =>
              shown.id === id ? { ...shown, body: line.text, partial: false } : shown,
            ),
          );
          advance();
        }, GUESS_MS);
      } else {
        advance();
      }
    };

    speak();
    return () => clearTimeout(timer);
  }, [reduced]);

  return (
    <figure className="m-0">
      {/* A specimen band, not a fake monitor. The overlay's background is
          transparent, so a 16:9 black rectangle draws a screen that doesn't
          exist and leaves two thirds of itself empty. This is the caption
          zone at the overlay's own margin and nothing else. */}
      <div className="stage slab relative flex min-h-[14rem] flex-col justify-end gap-3 p-6 sm:min-h-[16rem] sm:p-8">
        {/* The app's tally lamp: on air, captioning to stream. Red here means
            the same thing it means in the app, and nothing else. */}
        <div className="absolute right-6 top-6 flex items-center gap-2.5 sm:right-8 sm:top-8">
          <span className="tally block h-3 w-3 rounded-full bg-[#ff5a52]" aria-hidden="true" />
          <span className="label text-white/70">On air</span>
        </div>

        <div className="flex flex-col gap-3" aria-live="off">
          {lines.map((line) => (
            <CaptionPill
              key={line.id}
              speaker={line.speaker}
              text={line.body}
              partial={line.partial}
              className="caption-enter"
            />
          ))}
        </div>
      </div>

      <figcaption className="note mt-6 max-w-[46rem]">
        A browser source in OBS, 1920 × 1080, transparent background. Faded text is the guess the
        model makes while someone is still talking.
      </figcaption>
    </figure>
  );
}
