# chatterlayer.com

The website, living in the same repo as the app it describes so a user-facing
change is one commit instead of two.

Next.js 16, static export, deployed on Vercel with Root Directory `site`.

```bash
npm install
npm run dev        # http://localhost:3000
npm run typecheck
npm run build      # static export into out/
npm run serve      # serve the export
```

## Where the words are

Everything writable is in `lib/content.ts`. Components lay it out and own no
copy of their own, so a wording change is one file and one diff.

House style: short sentences, contractions, plain verbs, second person. The
app is honest about what it can't do and the copy has to match. If a line
reads like a brochure, it's wrong.

## The design, in one paragraph

Swiss bones, brutalist weight, neobrutalist blocks. The twelve-column grid,
the single grotesque (Archivo) and the flush-left ragged-right setting are
International Typographic Style. The scale, the 3px black outlines, the hard
un-blurred offset shadows and the flat colour fills are not, and that tension
is the design.

**Everything is bigger than feels comfortable, on purpose.** Body copy is
17px, small structural labels are 15px, sub-headings clamp up to 26px, section
names to 52px and the hero to 136px. Earlier passes ran 13–15px body and read
as timid; if something looks too small here, it is.

**One structural device: the slab.** `.slab`, `.slab-sm` and `.slab-flat` are
a 3px black outline with a hard offset shadow and no blur, so every block
reads as a card sitting on the paper. `.btn` is a slab you can push — it
travels into its own shadow on press, and that motion is the whole
interaction. Nothing has a border radius except a caption, which borrows the
overlay's own 10px.

**Colour fills blocks; it never tints text.** The four speaker hues from
`src/shared/colors.js` are still the entire palette and still mean a person
talking — section numbers walk the same rotation the app uses when it hands
colours to people joining a call. Black text on all four clears 7:1, so a
filled block is always readable. The tally lamp is the one other exception and
means connection state, exactly as it does in the app.

One more rule, borrowed from the app's own CSS:

- **A dark block is always a caption.** Every dark area is a preview of the
  overlay, drawn the way `web/overlay.html` actually draws it, and sized to
  the captions rather than to a 16:9 frame. The real overlay background is
  transparent, so a black rectangle standing in for a monitor draws a screen
  that doesn't exist and leaves most of itself empty.

There's one moving thing — the caption reel in the hero — because captions
arriving is the product. It stops under `prefers-reduced-motion`.

## It mirrors the app on purpose

These are duplicated from the app and will drift if nobody looks. All of them
live in `lib/content.ts`.

| On the site | Comes from |
| --- | --- |
| `models` table | `src/shared/models.js` (`MODEL_CATALOG`) |
| `speakers` colours | `src/shared/colors.js` |
| `latency`, `expectations`, `sampleClip` | `npm run bench` and `npm run test:stt` in the app |
| `setupSteps` | the app's README and the Source, Output and Remote overlay panels |
| `sharingGuards`, `overlayParams` | `src/main/` and `web/overlay.html` |
| `requirements` | the app's README |
| `site.overlayUrl` | the app's default overlay port |
| `public/logo.svg`, `public/logo.png` | `build/icon.svg` and `build/icon.png` — straight copies |

Nothing here is generated yet. `scripts/sync-from-app.mjs` is the plan —
see the repo's website checklist — and it needs `MODEL_CATALOG` moved into a
dependency-free module first, because a Vercel build of `site/` only installs
this folder's own packages.

## Deploying

Vercel project, Root Directory `site`, production branch `master`. The build
needs "include files outside the root directory" once the sync script exists.
No environment variables: `NEXT_PUBLIC_SITE_URL` is optional and only needed
if the site ever moves, or to stop a preview deploy calling itself canonical.
