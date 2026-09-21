import { nav, site } from '@/lib/content';

/**
 * A heavy black rule and the name. The nav is the page's index and carries
 * the same numbers as the section blocks.
 */
export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b-[3px] border-ink bg-paper">
      <div className="page">
        <div className="flex h-[4.5rem] items-center justify-between gap-6">
          <a href="#top" className="flex items-center gap-3">
            {/* The SVG, not the PNG: it's drawn on a 16-unit grid so every
                edge lands on a whole pixel at exactly this size, and it stays
                crisp on a 200% display. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo.svg" alt="" width={32} height={32} className="block" />
            <span className="text-[1.25rem] font-extrabold tracking-[-0.03em]">{site.name}</span>
          </a>

          <nav aria-label="Sections" className="hidden xl:block">
            <ul className="flex items-baseline gap-6">
              {nav.map((item) => (
                <li key={item.href}>
                  <a
                    href={item.href}
                    className="group flex items-baseline gap-1.5 text-[0.9375rem] font-medium"
                  >
                    <span className="tnum font-extrabold text-ink-3 group-hover:text-ink">
                      {item.index}
                    </span>
                    <span className="text-ink-2 group-hover:text-ink">{item.label}</span>
                  </a>
                </li>
              ))}
            </ul>
          </nav>

          <div className="flex items-center gap-5">
            {/* A link, not a second button: the page has one filled button and
                it's Download. The tip jar asks quietly or it doesn't ask. */}
            <a
              href={site.kofiUrl}
              className="link-underline text-[0.9375rem] font-semibold text-ink-2 transition-colors hover:text-ink"
            >
              Ko-fi
            </a>

            <a
              href={site.releasesUrl}
              className="btn bg-s2 px-5 py-2.5 text-[0.9375rem] text-ink"
            >
              Download
            </a>
          </div>
        </div>
      </div>
    </header>
  );
}
