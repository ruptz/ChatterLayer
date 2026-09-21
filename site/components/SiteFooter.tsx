import { site } from '@/lib/content';

const links = [
  { label: 'GitHub', href: site.repoUrl },
  { label: 'Releases', href: site.releasesUrl },
  { label: 'Issues', href: site.issuesUrl },
  { label: 'MIT licence', href: site.licenseUrl },
  { label: 'Ko-fi', href: site.kofiUrl },
];

export function SiteFooter() {
  return (
    <footer className="border-t-[3px] border-ink bg-ink text-paper">
      <div className="page">
        <div className="flex flex-col gap-6 py-10 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[1rem] font-medium">
            {site.name}, by {site.author}. Free and MIT licensed.
          </p>

          <ul className="flex flex-wrap gap-x-7 gap-y-3">
            {links.map((link) => (
              <li key={link.href}>
                <a
                  href={link.href}
                  className="text-[1rem] font-bold underline decoration-[3px] decoration-s2 underline-offset-[0.2em] transition-colors hover:decoration-paper"
                >
                  {link.label}
                </a>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </footer>
  );
}
