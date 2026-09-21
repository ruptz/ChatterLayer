import { Section } from '@/components/Section';
import { why } from '@/lib/content';

/**
 * The origin, told as what happened rather than as a pitch. Kept as the
 * section it has always been, because it's the reason the app exists.
 *
 * One column of prose — this is the only part of the page anyone reads
 * straight through. The closer goes into a filled slab: it's the line the
 * whole page is answerable to, and here that's said with a block of colour
 * and an outline instead of with size.
 */
export function WhyItExists() {
  return (
    <Section index="02" id="why" name="Why it exists" lede={why.heading}>
      <div className="max-w-[38rem] space-y-6 text-[1.125rem] leading-[1.6] text-ink-2">
        {why.body.map((paragraph) => (
          <p key={paragraph.slice(0, 32)}>{paragraph}</p>
        ))}
      </div>

      <div className="mt-12 grid gap-x-10 gap-y-10 lg:grid-cols-2">
        <p className="slab bg-s2 px-7 py-7 text-[1.375rem] font-bold leading-[1.25] tracking-[-0.025em] text-ink sm:text-[1.5rem]">
          {why.closer}
        </p>

        <div className="slab-sm self-start">
          <h3 className="label border-b-[3px] border-ink bg-paper px-5 py-3">
            {why.aside.heading}
          </h3>
          <p className="px-5 py-5 text-[1.0625rem] leading-[1.55] text-ink-2">
            {why.aside.body}{' '}
            <a href={why.aside.linkHref} className="link-underline font-semibold text-ink">
              {why.aside.linkLabel}
            </a>
            .
          </p>
        </div>
      </div>
    </Section>
  );
}
