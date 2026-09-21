/**
 * Every word on the site lives here.
 *
 * Facts, links and numbers come from the app's own README and source (the repo
 * root, one level up). If the app changes, change them here.
 *
 * House style: short sentences, contractions, plain verbs, second person. The
 * app is honest about what it can't do, and the copy has to match — if a line
 * reads like a brochure, it's wrong.
 */

export const site = {
  name: 'ChatterLayer',

  /**
   * Canonical origin, used for metadataBase, the canonical link, robots, the
   * sitemap and the absolute Open Graph image URL.
   *
   * The default is the live domain, so production needs no configuration.
   * NEXT_PUBLIC_SITE_URL overrides it — useful if the site ever moves, or to
   * stop a preview deploy advertising itself as the canonical copy.
   */
  url: process.env.NEXT_PUBLIC_SITE_URL ?? 'https://chatterlayer.com',

  tagline: 'Live captions for your Discord call, straight into OBS.',
  description:
    'ChatterLayer puts a bot in your Discord voice call, transcribes the people you choose on your own PC, and renders colour-coded captions into an OBS browser source. Free, offline, MIT licensed.',
  author: 'ruptz',

  repoUrl: 'https://github.com/ruptz/Chatterlayer',
  releasesUrl: 'https://github.com/ruptz/Chatterlayer/releases',
  issuesUrl: 'https://github.com/ruptz/Chatterlayer/issues',
  licenseUrl: 'https://github.com/ruptz/Chatterlayer/blob/master/LICENSE',
  kofiUrl: 'https://ko-fi.com/ruptz',
  kofiHandle: 'ko-fi.com/ruptz',
  discordDevPortalUrl: 'https://discord.com/developers/applications',
  cloudflaredUrl: 'https://github.com/cloudflare/cloudflared',

  /* The four speech engines, each pointing at what the app actually downloads. */
  voskUrl: 'https://alphacephei.com/vosk/',
  moonshineUrl: 'https://huggingface.co/onnx-community/moonshine-base-ONNX',
  whisperUrl: 'https://github.com/openai/whisper',
  parakeetUrl: 'https://huggingface.co/istupakov/parakeet-tdt-0.6b-v2-onnx',

  /** Shown in the app's Output panel and pasted into OBS. */
  overlayUrl: 'http://127.0.0.1:8777/overlay',

  /**
   * A share link, for shape only — the hostname is random per tunnel and the
   * key is minted fresh every time, so this one is dead and always will be.
   */
  shareUrlExample:
    'https://calm-river-quiet-1f4c.trycloudflare.com/overlay?k=Xk3pQ7rTvB2nL9wYzA4hMg',
} as const;

/**
 * The sections, numbered. The numbers aren't decoration — they're the page's
 * index, printed in each section's header band and again in the nav, so a
 * reader can place themselves on a page this long.
 */
export const nav = [
  { index: '01', label: 'The short version', href: '#short-version' },
  { index: '02', label: 'Why it exists', href: '#why' },
  { index: '03', label: 'How it works', href: '#how-it-works' },
  { index: '04', label: 'Setup', href: '#setup' },
  { index: '05', label: 'Sharing', href: '#sharing' },
  { index: '06', label: 'Models', href: '#models' },
  { index: '07', label: 'Get it', href: '#download' },
] as const;

/* -------------------------------------------------------------------------- */
/*  Speakers                                                                   */
/*                                                                             */
/*  Real entries from the app's 16-colour palette (src/shared/colors.js). In   */
/*  the app they're hashed from each person's Discord ID, so the same friend    */
/*  is the same colour every stream.                                           */
/*                                                                             */
/*  These four colours are the only colour on the site. That's the app's own   */
/*  rule — colour means a person talking, and nothing else gets to borrow it   */
/*  for decoration.                                                            */
/* -------------------------------------------------------------------------- */

export type Speaker = {
  id: string;
  /** The display name — in the app you can rename anyone. */
  name: string;
  /** Their actual Discord handle, shown underneath in the app. */
  handle: string;
  color: string;
};

export const speakers: Speaker[] = [
  { id: 'ruptz', name: 'Ruptz', handle: 'ruptz_45454', color: '#4ECDC4' },
  { id: 'maya', name: 'Maya', handle: 'mayahaze', color: '#FFD93D' },
  { id: 'dev', name: 'Dev', handle: 'devonthemic', color: '#4D96FF' },
  { id: 'sam', name: 'Sam', handle: 'sam.exe', color: '#FF6B6B' },
];

export const speakerById = (id: string) =>
  speakers.find((speaker) => speaker.id === id) ?? speakers[0];

/* -------------------------------------------------------------------------- */
/*  The looping conversation in the hero                                       */
/*                                                                             */
/*  Punctuated and capitalised, because that's what both recommended models    */
/*  (Parakeet, and Moonshine Base on lighter PCs) produce. `guess` is the      */
/*  in-progress guess the phrase engines emit when there's CPU spare — the     */
/*  overlay fades it, then rewrites the line in place once the real decode     */
/*  lands. Lines without one simply arrive finished, which is what a busy      */
/*  channel looks like.                                                        */
/*                                                                             */
/*  If the recommendations ever go back to a streaming engine, this has to go  */
/*  back to a lowercase, unpunctuated stream — showing tidy sentences for      */
/*  Vosk would be a lie.                                                       */
/* -------------------------------------------------------------------------- */

export type Line = { speaker: string; text: string; guess?: string };

export const transcript: Line[] = [
  {
    speaker: 'ruptz',
    guess: 'So if we push through',
    text: 'So if we push through the gate now?',
  },
  { speaker: 'maya', guess: 'No no no,', text: 'No no no, wait for the timer.' },
  { speaker: 'dev', text: 'I already went in.' },
  { speaker: 'maya', text: 'Dev, why?' },
  { speaker: 'dev', guess: 'I thought you', text: 'I thought you said go.' },
  { speaker: 'ruptz', text: 'Nobody said go.' },
  {
    speaker: 'maya',
    guess: 'I’m reviving him one more',
    text: 'I’m reviving him one more time and that’s it.',
  },
];

/** Shown in the small preview beside the speaker switches. */
export const pickerPreview: Line[] = [
  { speaker: 'maya', text: 'No no no, wait for the timer.' },
  { speaker: 'dev', text: 'I already went in.' },
  { speaker: 'sam', text: 'Can everyone hear me now?' },
  { speaker: 'ruptz', text: 'Nobody said go.' },
];

/* -------------------------------------------------------------------------- */
/*  The short version                                                          */
/* -------------------------------------------------------------------------- */

export const facts = [
  {
    label: 'Free',
    body: 'No tiers, no licence key, no account, no API key, nothing metered. It’s MIT licensed, so fork it and ship your own if you want to.',
  },
  {
    label: 'It runs on your PC',
    body: 'Your voices never leave the machine. ChatterLayer downloads a speech model once and does the listening itself, so after that it doesn’t need the internet to caption at all. The caption server answers on 127.0.0.1 and nowhere else, unless you deliberately switch sharing on. The app makes one request of its own accord, a version check at launch, and there’s a switch for that.',
  },
  {
    label: 'Sharing, if you want it',
    body: 'Co-streaming? One person runs the app and sends the others a link to paste into OBS, and everyone shows the same captions. It’s off until you turn it on, it never starts by itself, and it stops when you close the app. Only the finished text goes down the tunnel. The audio stays on your PC.',
  },
  {
    label: 'Nine speech models',
    body: 'Four engines, nine models, 40 MB to 2.5 GB. The small one keeps up with a seven-person call. The big one gets close to what you’d pay a cloud service for. Both of the recommended ones punctuate. Keep several installed and switch between them without downloading anything again.',
  },
  {
    label: 'Nobody by default',
    body: 'Everyone in the call starts switched off. You turn on the people who’ve said yes, and you can change that mid-call without reconnecting.',
  },
  {
    label: 'It’s just a browser source',
    body: 'The overlay is an ordinary OBS browser source with a transparent background. No plugin, no window capture, nothing to configure. It reconnects on its own, so you can add it before the app is even open.',
  },
] as const;

/* -------------------------------------------------------------------------- */
/*  Why it exists                                                              */
/*                                                                             */
/*  The origin, told as what happened rather than as a pitch. The              */
/*  accessibility case is the reason the app exists, so it leads — and the     */
/*  closing line stays blunt. Don't let this drift into marketing.             */
/* -------------------------------------------------------------------------- */

export const why = {
  heading: 'It started with one viewer.',
  body: [
    'A streamer I watch has a regular in chat who’s deaf. When it’s just the streamer talking, they can follow along fine. When the Discord call fills up and four people talk over each other, they can’t. On a lot of streams, that’s most of the stream.',
    'There isn’t much you can do about that from where they’re sitting. Twitch doesn’t caption anything by itself, and the tools that do usually only hear the streamer’s own mic, not the four friends they’re playing with. So the conversation everyone else is listening to just isn’t there.',
    'ChatterLayer fixes that one thing. It turns out to be handy for other people as well, anyone watching on mute at work, or on a connection that’s mangling the audio, or trying to keep up with a call that has gone completely off the rails. But that isn’t why I built it.',
  ],
  /** Set apart and kept blunt. The whole page is answerable to this line. */
  closer:
    'It won’t make a stream accessible on its own, and it won’t catch every word. A rough caption with the right name on it still beats silence.',
  aside: {
    heading: 'What to expect',
    body: 'This runs offline on your own PC, so it won’t match a paid cloud service. There are nine models to choose from, both of the recommended ones punctuate, and the best one gets close.',
    linkLabel: 'The real numbers are further down',
    linkHref: '#models',
  },
} as const;

/* -------------------------------------------------------------------------- */
/*  How it works — the signal path                                             */
/* -------------------------------------------------------------------------- */

export const pipeline = [
  {
    id: 'join',
    kicker: 'Discord',
    title: 'A bot sits in your call',
    body: 'ChatterLayer brings a bot into your voice channel, and Discord hands it every person’s audio as a separate stream. Everyone gets transcribed on their own, so two people talking at once never get spliced into one sentence.',
  },
  {
    id: 'transcribe',
    kicker: 'Your PC',
    title: 'Your PC does the listening',
    body: 'The audio is decoded, resampled and handed to the speech engine on its own thread. You choose the model, nine of them across four engines. It loads once and serves the whole call, so a seventh person doesn’t mean a seventh copy of it sitting in memory.',
  },
  {
    id: 'render',
    kicker: 'OBS',
    title: 'Captions land on stream',
    body: 'Every line goes out over a local WebSocket in that person’s colour. The phrase models show a faded guess first and rewrite the line once it settles. Vosk writes it word by word as they speak.',
  },
] as const;

/** Speech to pixels, from the app's own measurements. */
export const latency = [
  { stage: 'Caption delay on the recommended models', value: '150–290 ms' },
  { stage: 'Word by word, on Vosk Medium', value: '250–500 ms' },
] as const;

/* -------------------------------------------------------------------------- */
/*  Setup — the one genuinely sequential part of the page, hence the numbers   */
/* -------------------------------------------------------------------------- */

export type SetupStep = {
  title: string;
  body: string;
  bullets?: string[];
  copyValue?: string;
  link?: { label: string; href: string };
  note?: string;
};

export const setupSteps: SetupStep[] = [
  {
    title: 'Install it',
    body: 'There’s a normal installer, and a portable build if you’d rather not install anything. The whole setup runs about ten minutes, and most of that is watching a download bar.',
    link: { label: 'Downloads on GitHub', href: site.releasesUrl },
    note: 'None of the builds are code-signed, so Windows SmartScreen throws up a blue box the first time you run it: click More info, then Run anyway. On macOS the app offers to clear Gatekeeper’s quarantine flag in one click, so you never have to open Terminal.',
  },
  {
    title: 'Pick a speech model',
    body: 'First launch asks which model to download. There are nine, across four engines, and they run from 40 MB to 2.5 GB. You only need one, which is why none of them ship with the app. ChatterLayer checks your RAM and CPU and marks the one that suits your machine: Parakeet TDT 0.6B if you have 16 GB or more, which most streaming PCs do, and Moonshine Base on lighter ones.',
    note: 'Install as many as you like and switch between them in the dropdown without downloading anything again. They live in your user data folder and survive app updates, and Remove gives you the disk space back. Switching to a different engine needs a reconnect.',
  },
  {
    title: 'Make a Discord bot',
    body: 'The bot is the thing that sits in your voice channel and listens. Making one is free and takes about two minutes.',
    bullets: [
      'New Application, name it whatever you like, then the Bot tab and Add Bot.',
      'Reset Token, then Copy. Treat it like a password.',
      'Leave every Privileged Gateway Intent switched off. ChatterLayer doesn’t need them.',
      'OAuth2, then URL Generator: scope bot, permissions View Channel and Connect. It never talks, so it doesn’t need Speak.',
      'Open the URL it builds and invite the bot to your server.',
    ],
    link: { label: 'Discord Developer Portal', href: site.discordDevPortalUrl },
  },
  {
    title: 'Paste the token, pick a channel',
    // Describes v0.2.0, which is what the Download button actually gets you.
    // The app signs in on paste from v0.3.0 -- when that ships, this becomes
    // 'Drop the bot token into the Source panel. It signs in on its own, and
    // the Server and Voice channel dropdowns fill up ...'.
    body: 'Drop the bot token into the Source panel and press Refresh. The Server and Voice channel dropdowns fill up with everywhere your bot can reach. Choose one and hit Connect. There’s no channel ID to copy and no Developer Mode to turn on, and channels your bot can’t join are greyed out with the missing permission named.',
    note: 'The token goes into your operating system’s own keystore, DPAPI on Windows, Keychain on macOS, libsecret on Linux, so you paste it once and never think about it again.',
  },
  {
    title: 'Add the overlay to OBS',
    body: 'Sources, then +, then Browser. Set the width and height to match your canvas, usually 1920 × 1080, and paste the URL from ChatterLayer’s Output panel:',
    copyValue: site.overlayUrl,
    bullets: [
      'Tick Shutdown source when not visible and Refresh browser when scene becomes active.',
      'Captions sit bottom-left with a small margin, so a full-canvas source at 0,0 usually just works.',
    ],
    note: 'The overlay reconnects by itself. You can add the source before ChatterLayer is running, and it will survive you restarting the app mid-stream.',
  },
];

/* -------------------------------------------------------------------------- */
/*  Once it's running                                                          */
/*                                                                             */
/*  Two behaviours people meet on day one and would otherwise file as bugs:    */
/*  the window that won't close, and the version stamp that changes colour.    */
/* -------------------------------------------------------------------------- */

export const appBehaviour = [
  {
    label: 'Closing hides it',
    body: 'The × drops ChatterLayer to the system tray instead of ending the call, so a stray click can’t cut your captions mid-stream. Minimising behaves normally, Quit on the tray icon always means quit, and you can switch the whole behaviour off in App settings.',
  },
  {
    label: 'It tells you about new versions',
    body: 'The version you’re running sits in the top right of the control panel. Once per launch the app asks GitHub whether there’s a newer release, and that stamp turns amber if there is. Click it and the release page opens. Nothing downloads and nothing installs itself. It’s the only request the app makes on its own, which is why it gets a visible switch: Output, then Check for updates.',
  },
] as const;

/* -------------------------------------------------------------------------- */
/*  Sharing captions with co-streamers                                         */
/*                                                                             */
/*  The one feature that puts anything on the internet, so the copy leads      */
/*  with it being off and stays specific about what actually leaves the        */
/*  machine. Don't soften this into a marketing feature; the honesty is the    */
/*  point.                                                                     */
/* -------------------------------------------------------------------------- */

export const sharingSteps = [
  {
    title: 'Tick the box',
    body: 'Open Remote overlay and tick “Let other streamers use these captions”. Nothing has opened yet. That only reveals the controls.',
  },
  {
    title: 'Start the tunnel',
    body: 'The first time, ChatterLayer fetches cloudflared, about 35 MB, and keeps it for next time. If you already have it on your PATH, it uses that copy instead.',
  },
  {
    title: 'Send the link',
    body: 'Your co-streamers paste it into a browser source, exactly like the local one. Press Stop tunnel, or just close ChatterLayer, and the link stops working.',
  },
] as const;

/** What stands between the link and someone who wasn't sent it. */
export const sharingGuards = [
  {
    label: 'Key strength',
    body: '128 bits from a cryptographic random source, written as 22 URL-safe characters.',
  },
  {
    label: 'Comparison',
    body: 'Hashed, then compared in constant time, so a near miss gives nothing away through timing.',
  },
  {
    label: 'Rate limiting',
    body: '20 failed attempts per caller per minute, then a minute of 429s, keyed on an address the caller can’t forge.',
  },
  {
    label: 'Connection cap',
    body: '16 remote viewers at once. Your own OBS is never counted and never refused, so flooding the tunnel can’t cost you your own overlay.',
  },
  {
    label: 'Transport',
    body: 'The overlay refuses to open the caption feed if the page arrived over plain HTTP from anywhere but your machine, so the key is never on the wire in clear text.',
  },
  {
    label: 'Read-only',
    body: 'The feed only goes one way. There’s no handler for inbound messages at all, so a link lets someone watch and never control.',
  },
  {
    label: 'Logging',
    body: 'The Log panel records the bare tunnel hostname and never the keyed link, so it’s safe to screenshot into a bug report.',
  },
] as const;

/** Each streamer can size the captions for their own scene. */
export const overlayParams = [
  { param: '&size=42', body: 'Text size in px (8–200)' },
  { param: '&hold=5', body: 'Seconds a caption stays up (0.5–120)' },
  { param: '&lines=2', body: 'How many captions show at once (1–20)' },
  { param: '&partials=0', body: 'Finished lines only, no live guesses' },
  { param: '&names=0', body: 'Hide speaker names' },
] as const;

export const sharingCaveats = [
  'The link changes every time you start the tunnel, because the hostname is random, so your co-streamers have to re-paste it after you restart ChatterLayer. Sort that out before you go live, not during.',
  'Cloudflare makes no uptime promise for these free quick tunnels. They need no account and no domain, and that’s the trade.',
  'The audio still never leaves your machine. What goes through the tunnel is the finished caption text, the same words already on your stream, and nothing else.',
  'Changing the overlay port stops the tunnel, since the old link would point at nothing. Start it again for a new one.',
] as const;

/* -------------------------------------------------------------------------- */
/*  Speech models                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The two kinds of engine, which is what actually decides the choice for most
 * people — not the model sizes.
 */
export const engineFamilies = [
  {
    kind: 'Word by word',
    models: 'Vosk',
    body: 'Vosk updates the caption as each word is spoken, so text appears with almost no delay. The trade is a lowercase stream with no punctuation, and every person needs their own recogniser, so memory grows with the size of the call.',
  },
  {
    kind: 'A phrase at a time',
    models: 'Moonshine, Whisper, Parakeet',
    body: 'These wait for someone to finish a thought, then hand back a punctuated, capitalised sentence a fraction of a second later. It reads like writing rather than a transcript, and one copy of the model serves everybody in the call.',
  },
] as const;

export type Model = {
  name: string;
  /** Which of the four engines it runs on. Carried in the name, so no column. */
  engine: 'Vosk' | 'Moonshine' | 'Whisper' | 'Parakeet';
  download: string;
  /** Peak resident memory with one speaker, plus what each extra one costs. */
  ram: string;
  /** Speech to caption on screen. 'live' for the streaming engine. */
  delay: string;
  /** How many people before captions start arriving late — a latency limit. */
  speakers: string;
  punctuation: boolean;
  /** Set on the two recommended models: the short note shown under the name. */
  recommended?: string;
};

/**
 * Nine models, four engines. Figures are the app's own measurements on a
 * Ryzen 5 5600X against real speech (`npm run bench -- --all`); Vosk Large and
 * Gigaspeech are extrapolated from model size, as the app's README says.
 */
export const models: Model[] = [
  {
    name: 'Vosk Small',
    engine: 'Vosk',
    download: '40 MB',
    ram: '170 MB + 12/speaker',
    delay: 'live',
    speakers: '7',
    punctuation: false,
  },
  {
    name: 'Vosk Medium',
    engine: 'Vosk',
    download: '128 MB',
    ram: '420 MB + 51/speaker',
    delay: 'live',
    speakers: '7',
    punctuation: false,
  },
  {
    name: 'Vosk Large',
    engine: 'Vosk',
    download: '1.8 GB',
    ram: '~5 GB',
    delay: 'live',
    speakers: '4',
    punctuation: false,
  },
  {
    name: 'Vosk Gigaspeech',
    engine: 'Vosk',
    download: '2.3 GB',
    ram: '6.8 GB',
    delay: 'live',
    speakers: '3',
    punctuation: false,
  },
  {
    name: 'Moonshine Base',
    engine: 'Moonshine',
    download: '251 MB',
    ram: '550 MB',
    delay: '~150 ms',
    speakers: '6',
    punctuation: true,
    recommended: 'Best pick under 16 GB of RAM',
  },
  {
    name: 'Whisper Tiny',
    engine: 'Whisper',
    download: '43 MB',
    ram: '420 MB',
    delay: '~650 ms',
    speakers: '2',
    punctuation: true,
  },
  {
    name: 'Whisper Base',
    engine: 'Whisper',
    download: '79 MB',
    ram: '700 MB',
    delay: '~1 s',
    speakers: '1',
    punctuation: true,
  },
  {
    name: 'Whisper Small',
    engine: 'Whisper',
    download: '251 MB',
    ram: '1.8 GB',
    delay: '~2.2 s',
    speakers: '1',
    punctuation: true,
  },
  {
    name: 'Parakeet TDT 0.6B',
    engine: 'Parakeet',
    download: '2.5 GB',
    ram: '2.6 GB',
    delay: '~290 ms',
    speakers: '4',
    punctuation: true,
    recommended: 'Best pick on 16 GB and up',
  },
];

/** The four calls worth making out loud, under the table. */
export const modelNotes = [
  {
    model: 'Parakeet TDT 0.6B',
    body: 'The one to pick if your PC has 16 GB of RAM or more, which covers most streaming machines and not just the expensive ones. It’s the most accurate model here by a distance and still quick, about 290 ms a caption, because it transcribes the phrase itself rather than a padded window. The cost is a 2.5 GB download and around 2.6 GB of RAM, loaded once no matter how many people are on.',
  },
  {
    model: 'Moonshine Base',
    body: 'The one to pick on lighter machines, like an 8 GB laptop. It beats Vosk Medium everywhere except immediacy: more accurate, punctuated, capitalised, a caption in about 150 ms and a tenth of the CPU per second of speech. And because one shared model serves the whole call, it uses less memory than Vosk Medium once more than three people are talking.',
  },
  {
    model: 'Vosk Medium',
    body: 'Pick this if you want text appearing as the words are spoken instead of at the end of each phrase. That immediacy reads very differently on stream, and it’s the one thing Vosk still wins on.',
  },
  {
    model: 'The Whisper models',
    body: 'Hard to recommend over Moonshine. Every Whisper caption pays for a padded 30-second window whatever the phrase length, so Tiny is slower than its size suggests and Base takes about a second while being less accurate than Moonshine. They’re here because Whisper is the name people ask for, and because Small is genuinely accurate for one person if you don’t mind waiting two seconds.',
  },
] as const;

/* -------------------------------------------------------------------------- */
/*  What to expect                                                             */
/* -------------------------------------------------------------------------- */

export const expectations = [
  'Vosk gets roughly 85–92% of words right for a clear speaker on a decent mic in a quiet room, as a lowercase stream with no punctuation. Moonshine, Whisper and Parakeet all do better than that, and they’re much better on names.',
  'Paid cloud services get 93–97% on the same audio, so there’s still a gap at the top. Parakeet on clear speech gets close to closing it.',
  'Every engine gets worse with background noise, music, strong accents and people talking over each other. The offline ones get worse faster.',
  'Game jargon, usernames and memes are hard for all of them. The vocabulary is fixed and there’s no way to nudge it towards your community’s slang.',
  'Mic quality matters more than model size. A friend on a bad headset is the weak link whichever model you run.',
] as const;

/**
 * The same clip through five of the nine models, from the app's own
 * `npm run test:stt -- --all`. Adjectives about accuracy are cheap; this isn't.
 */
export const sampleClip = {
  caption: 'The same eleven seconds of speech, through five of the nine models.',
  lines: [
    {
      model: 'Parakeet TDT 0.6B',
      text: 'And so, my fellow Americans. Ask not. What your country can do for you. Ask what you can do for your country.',
    },
    {
      model: 'Moonshine Base',
      text: 'And so my fellow Americans. Ask not. What your country can do for you ask what you can do for your country',
    },
    {
      model: 'Whisper Tiny',
      text: 'And so am I fellow Americans. Ask, not! What your country can do for you, ask what you can do for your country.',
    },
    {
      model: 'Vosk Medium',
      text: 'and so my fellow american ask not what your country can do for you ask what you can do for your country',
    },
    {
      model: 'Vosk Small',
      text: 'and so my fellow americans as not what your country can do for you ask what you can do for your country',
    },
  ],
  note: 'Where the small models slip: Whisper Tiny hears “am I” for “my”, Vosk Small hears “as not” for “ask not”, and Vosk Medium drops the plural on “Americans”.',
} as const;

/* -------------------------------------------------------------------------- */
/*  What you need                                                              */
/* -------------------------------------------------------------------------- */

export const requirements = [
  { label: 'OS', value: 'Windows, macOS (Intel or Apple Silicon), or Linux' },
  {
    label: 'Disk',
    value:
      '~350 MB for the app, plus the model you pick (40 MB to 2.5 GB), plus ~35 MB for cloudflared if you ever share captions',
  },
  {
    label: 'RAM',
    value: '~2.6 GB on Parakeet, or ~570 MB for a seven-person call on Moonshine Base',
  },
  { label: 'Also', value: 'A free Discord bot, and any recent OBS' },
] as const;
