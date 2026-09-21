import type { ReactNode } from 'react';

/**
 * The four speaker hues, in the order the app hands them out as people join a
 * call. Section numbers walk the same rotation, so the colour on the page is
 * still the app's colour doing the app's job.
 */
const BLOCK = ['bg-s1', 'bg-s2', 'bg-s3', 'bg-s4'] as const;

/**
 * The page's only layout primitive.
 *
 * A filled number block, the section name set large and heavy, and a 3px rule
 * under both. Swiss keeps the grid and the flush-left setting; the weight and
 * the outline are not Swiss at all, and that's the point.
 */
export function Section({
  index,
  id,
  name,
  lede,
  children,
}: {
  /** Printed in the number block. The nav carries the same numbers. */
  index: string;
  id: string;
  name: string;
  /** The one line per section allowed to outgrow body copy. */
  lede?: string;
  children: ReactNode;
}) {
  const block = BLOCK[(Number(index) - 1) % BLOCK.length];

  return (
    <section id={id} className="scroll-mt-20">
      <div className="page">
        <div className="flex items-center gap-4 border-b-[3px] border-ink pb-4 sm:gap-6">
          <span className={`band-num ${block}`}>{index}</span>
          <h2 className="band-name">{name}</h2>
        </div>

        <div className="pt-10 pb-24 sm:pt-12 sm:pb-28">
          {lede ? <p className="lede mb-10">{lede}</p> : null}
          {children}
        </div>
      </div>
    </section>
  );
}
