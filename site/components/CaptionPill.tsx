import { speakerById } from '@/lib/content';

/**
 * One caption, drawn the way the overlay actually draws it
 * (web/overlay.html): a translucent slab with the speaker's colour down the
 * left edge, the name in that colour, and a double text-shadow so it survives
 * any footage behind it.
 *
 * The rounded corner and the blur belong to the product, not to the page.
 * Everything else here is square on purpose; this isn't.
 */
export function CaptionPill({
  speaker,
  text,
  partial = false,
  className = '',
}: {
  speaker: string;
  text: string;
  /** An in-progress guess, before the decode settles and rewrites the line. */
  partial?: boolean;
  className?: string;
}) {
  const person = speakerById(speaker);

  return (
    <div
      className={[
        'caption-line max-w-[92%] rounded-[10px] bg-[rgba(8,10,14,0.72)] px-5 py-3',
        'text-[1.0625rem] backdrop-blur-[6px] sm:text-[1.25rem]',
        partial ? 'opacity-75' : '',
        className,
      ].join(' ')}
      style={{ borderLeft: `6px solid ${person.color}`, lineHeight: 1.32 }}
    >
      <span className="caption-name mr-3" style={{ color: person.color }}>
        {person.name}
      </span>
      <span className="text-white">{text}</span>
    </div>
  );
}
