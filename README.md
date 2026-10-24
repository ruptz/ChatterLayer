# ChatterLayer

Live, colour-coded captions for your Discord voice call, rendered straight into
OBS. It can caption your own mic too, with or without the call.

**[chatterlayer.com](https://chatterlayer.com)** — what it does, in one page.

Built for streamers who hang out in Discord calls and want viewers to know
**who said what** — including viewers who are deaf or hard of hearing, watching
muted at work, or on a connection that's chewing up your audio.

**Free, forever, for everyone.** No paid tiers, no licence keys, no accounts, no
API keys, no per-minute billing. The speech recognition runs on your own PC. After
the one-time model download, ChatterLayer never sends anyone's audio anywhere —
it doesn't even need an internet connection to caption.

---

## Contents

**Getting started**

- [What it looks like](#what-it-looks-like)
- [Set it up](#set-it-up) — install, bot, channel, OBS
- [Which speech model should I pick?](#which-speech-model-should-i-pick)

**Using it**

- [On stream](#on-stream) — call or mic, who gets captioned, names, colours,
  caption style, pause, follow mode
- [Leaving it running](#leaving-it-running) — recovery, the tray, hotkeys
- [Sharing captions with your co-streamers](#sharing-captions-with-your-co-streamers)
- [Consent — read this one](#consent--read-this-one)
- [The word filter](#the-word-filter)
- [How good are the captions, really?](#how-good-are-the-captions-really)
- [Troubleshooting](#troubleshooting)
- [Support the project](#support-the-project)

**[For developers](#for-developers)** — running from source, architecture,
performance numbers, releases

---

## What it looks like

Each person in your call gets their own colour and their own caption line:

```
▌ Ruptz    so if we push through the gate now
▌ Maya     no no no wait for the timer
▌ Dev      i already went in
```

- Everyone's audio is transcribed **separately**, so speakers never get mixed up
  mid-sentence.
- Colours are automatic and stable — the same friend is the same colour every
  stream, on every machine.
- You choose **exactly who gets captioned**, and can flip people in and out
  mid-call without reconnecting anything.
- The overlay background is transparent, so OBS just composites it over your
  scene.

### What you need

| | |
|---|---|
| **OS** | Windows 10 or 11 (tested); macOS 11+ or Linux (built from the same code, untested — [report issues](https://github.com/ruptz/ChatterLayer/issues/new/choose)) |
| **Disk** | ~95 MB for the app, plus the speech model you choose (40 MB–2.5 GB) |
| **RAM** | ~2.6 GB on Parakeet, the pick for PCs with 16 GB; ~570 MB for a 7-person call on Moonshine Base, the pick for lighter machines |
| **A Discord bot** | Only to caption a call — not for your mic alone. Free, takes two minutes — [instructions below](#3-create-your-discord-bot) |
| **OBS** | Any recent version |

You do **not** need Node.js, a compiler, Visual Studio, Python, a paid speech
API, or an account with anyone.

---

## Set it up

About ten minutes, most of which is waiting for a download.

### 1. Install ChatterLayer

Grab the latest build from the
[Releases page](https://github.com/ruptz/ChatterLayer/releases). On Windows there's an
installer, and a zip if you'd rather not install anything: unzip it anywhere and
run `ChatterLayer.exe`. macOS gets a `.dmg` (Apple Silicon or Intel), Linux an
AppImage or a `.deb`. Installing over 0.4 or earlier removes the old version
first, and your settings, token and models carry over.

> **Your system will warn you on first launch.** The builds aren't code-signed —
> certificates cost money this project isn't spending — so:
>
> - **Windows:** SmartScreen shows a blue box. Click *More info* → *Run anyway*.
>   It stops once a release has enough downloads.
> - **macOS:** Gatekeeper may say the app is "damaged". It isn't; run
>   `xattr -dr com.apple.quarantine /Applications/ChatterLayer.app` once.
> - **Linux:** `chmod +x` the AppImage first.
>
> Every release includes a Sigstore-signed `SHA256SUMS` and per-file build
> provenance if you want to verify the download — see
> [Code signing](#code-signing).

### 2. Pick a speech model

On first launch ChatterLayer asks which speech model to download. Models aren't
bundled with the app because they range from 40 MB to 2.5 GB and you only need
one.

There are nine, across four speech engines — all of them running entirely on your
own machine. The app checks your RAM and CPU and marks the one that suits your PC:

- **Parakeet TDT 0.6B** if it has 16 GB of RAM or more — most streaming PCs do.
  It's the most accurate model here by a distance.
- **Moonshine Base** on lighter machines, like an 8 GB laptop. Fast, punctuated,
  and a 251 MB download.

The one other reason to choose differently: Vosk Medium puts words on screen as
they're spoken rather than a phrase at a time. See
[Which speech model should I pick?](#which-speech-model-should-i-pick) for the
details and the measured numbers.

### 3. Create your Discord bot

ChatterLayer needs a bot account to sit in your voice channel and listen. This is
free and takes about two minutes.

> **Only captioning your own mic?** Skip this step and the next. Pick **My mic**
> under **Listen to** in the Source panel, choose your microphone, and go
> straight to [step 5](#5-add-the-overlay-to-obs).

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
   and click **New Application**. Name it whatever you like.
2. Open the **Bot** tab → **Add Bot**.
3. Click **Reset Token**, then **Copy**. This is what you paste into
   ChatterLayer. **Treat it like a password** — anyone who has it controls your
   bot.
4. **Leave all the Privileged Gateway Intents switched off.** ChatterLayer
   doesn't need them. If "Server Members" or "Message Content" are on, turn them
   off.

Inviting the bot to your server happens from inside ChatterLayer, in the next
step — no URL Generator needed.

### 4. Paste your token and pick a channel

Open ChatterLayer and paste your **bot token** into the **Source** panel. It
signs in by itself. Press **Invite the bot to a server**, pick your server on
the Discord page that opens, and it appears in the **Server** dropdown on its
own — View Channel and Connect are already ticked, and nothing else is asked
for (it never talks, so it doesn't need Speak). Pick a **Voice channel** and hit
**Connect**.

There's no channel ID to copy and no Developer Mode to turn on. ChatterLayer
also checks permissions while it's listing, so:

- Channels your bot **can't join** are greyed out, with the missing permission
  named when you hover. That's the single most common setup mistake, caught
  before you waste 30 seconds on a failed connect.
- **Stage channels** are marked `stage`. A bot joining a stage lands in the
  *audience* and hears nothing at all until someone invites it to speak — worth
  knowing before you wonder why captions never appear.
- A channel at its user limit is marked `full`.

The **Channels** panel then fills with everyone currently in the call. Nobody is
captioned until you switch them on.

Your token is kept in your system's keystore (Credential Manager on Windows,
Keychain on macOS, GNOME Keyring or KWallet on Linux), never in a plain file, so
you only paste it once —
after that ChatterLayer signs in by itself at launch and the dropdowns are ready
when you open it. Your bot therefore shows as **online in Discord whenever
ChatterLayer is open**, not only while you're captioning.

> The dropdowns keep themselves up to date as the bot joins servers and channels
> change. **Refresh** is still there if you ever doubt them, and so is an
> **Enter a channel ID manually** fallback under the picker.
>
> Inviting by hand works too: swap your client ID into
> `https://discord.com/api/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=1049600&scope=bot`

### 5. Add the overlay to OBS

1. In OBS: **Sources → + → Browser**.
2. **URL:** copy it from ChatterLayer's **Output** panel — normally
   `http://127.0.0.1:8777/overlay`.
3. **Width / Height:** match your canvas, e.g. `1920` × `1080`.
4. Tick **Shutdown source when not visible** and **Refresh browser when scene
   becomes active**.
5. Drag it where you want it. Captions render in the bottom-left with a small
   margin, so leaving the source at full canvas size and positioning it at 0,0
   usually just works.

The **OBS connected** light in the Output panel comes on once the source is
talking to ChatterLayer. Press **Send test caption** to put a line on the
overlay, so you can size and place it without being in a call.

The overlay reconnects on its own, so you can add the source before ChatterLayer
is even running, and it survives you restarting the app mid-stream.

Until everything is green, a short **setup checklist** at the top of the app
tracks model → bot signed in → bot in a server → voice channel → OBS connected
(on **My mic**, just model and OBS). It hides itself for good once it's done, or
when you press **Hide**. People updating from an earlier version never see it.

**Nothing is exposed to the internet.** The caption server only listens on
`127.0.0.1`, which means your own machine and nothing else.

---

## Which speech model should I pick?

Nine models across four engines. Everything runs **fully offline** — no API keys,
no cloud calls, whichever one you pick.

| Model | Download | RAM | Caption delay | Speakers | Punctuation |
|---|---|---|---|---|---|
| Vosk Small | 40 MB | 170 MB + 12/speaker | live | 7 | — |
| Vosk Medium | 128 MB | 420 MB + 51/speaker | live | 7 | — |
| Vosk Large | 1.8 GB | ~5 GB | live | 4 | — |
| Vosk Gigaspeech | 2.3 GB | 6.8 GB | live | 3 | — |
| **Moonshine Base** ⭐ | **251 MB** | **550 MB** | **~150 ms** | **6** | **yes** |
| Whisper Tiny | 43 MB | 420 MB | ~650 ms | 2 | yes |
| Whisper Base | 79 MB | 700 MB | ~1 s | 1 | yes |
| Whisper Small | 251 MB | 1.8 GB | ~2.2 s | 1 | yes |
| **Parakeet TDT 0.6B** ⭐ | **2.5 GB** | **2.6 GB** | **~290 ms** | **4** | **yes** |

⭐ Recommended — Parakeet on PCs with 16 GB of RAM or more, Moonshine Base on
lighter machines. The app works out which one suits yours.

Measured on a Ryzen 5 5600X against real speech, on 0.4's engines; 0.5's are
faster. See
[Performance](#performance-and-limits) for the method and what the numbers mean.

**Two kinds of engine, and the difference matters.**

Vosk is a *streaming* recogniser: it updates the caption word by word as someone
talks, so text appears with essentially no delay. The trade is that it outputs a
lowercase stream of words with no punctuation, and each speaker needs their own
recogniser, so memory grows with the number of people.

Moonshine, Whisper and Parakeet transcribe a *phrase at a time*. They wait for
you to finish a thought, then produce a properly punctuated and capitalised
sentence. The caption arrives a fraction of a second later, but it reads like
writing rather than a transcript. One copy of the model serves everyone, so a
seventh speaker costs an audio buffer rather than another copy of the weights.

**Recommendations** — the app checks your RAM and CPU and marks which of the
first two suits your PC:

- **Parakeet TDT 0.6B, if your PC has 16 GB of RAM or more.** That is most
  streaming PCs; it doesn't take a high-end machine. It is the most accurate
  model here by a distance, and still quick: ~290 ms per caption on a mid-range
  Ryzen 5 5600X, because it transcribes only the phrase rather than a padded
  window. The cost is a 2.5 GB download and ~2.6 GB of RAM, loaded once and
  shared by everyone in the call.
- **Moonshine Base on lighter machines**, like an 8 GB laptop or an older CPU.
  It beats Vosk Medium on every measured axis except immediacy: more accurate,
  adds punctuation and casing, produces a caption in ~150 ms, uses a tenth of the
  CPU per second of speech, and — because it loads one shared model — actually
  uses *less* memory than Vosk Medium once more than three people are on.
- **Vosk Medium** is the choice if you want text appearing as the words are
  spoken rather than at the end of each phrase. That immediacy is a real
  difference on stream, and it is the only thing it still wins on.
- **The Whisper models are hard to recommend over Moonshine.** Every Whisper
  caption pays for a padded 30-second window whatever the phrase length, so Tiny
  is slower than its size suggests and Base takes about a second per caption
  while being less accurate than Moonshine. They are here because Whisper is
  what people ask for by name, and Small is genuinely accurate if you are
  captioning one person and don't mind waiting two seconds.

You can install several models and switch between them in the **Speech model**
dropdown without re-downloading anything. They live in your user data folder,
survive app updates, and **Remove** frees the disk space when you're done with
one. Switching engines needs a reconnect — the model is loaded once, at connect.

---

## On stream

### Your call, your mic, or both

**Listen to** at the top of the Source panel picks what gets captioned:

| | |
|---|---|
| **Discord call** | Everyone in the voice channel you switch on, through the bot. |
| **My mic** | Just you, straight from your microphone. No bot, no Discord sign-in, nothing leaves your PC. |
| **Both** | The call and your mic together. |

**Both** exists for one moment that happens constantly on stream: you mute in
Discord, or let go of push-to-talk, and read chat out. Discord hears nothing, so
the call alone would miss it. Your mic still hears it. Press **This is me** on
your own row in the Channels panel and your mic captions you from then on, so
you never appear twice.

With a mic in play, two sliders tune it live: **Sensitivity** (lower it if
keyboard or game audio sets captions off; raise it if quiet words go missing)
and **Pause ends line**, how long a silence finishes a caption.

### Choosing who gets captioned

The **Channels** panel lists everyone in the voice call with a toggle each.

Flip someone **on** and ChatterLayer starts transcribing them immediately. Flip
them **off** and it stops and frees the memory. You can do this live, mid-call,
as often as you like — nothing reconnects and nothing drops.

Nobody is captioned by default. That's deliberate; see
[Consent](#consent--read-this-one).

### Pause captions

**Pause captions** (next to the status light while connected) keeps the bot in
the call but sends nothing to the stream, and clears the overlay at once. It's
the privacy panic button — for a phone call, a private conversation, or anything
that shouldn't be on screen. It's also on the tray menu and, if you turn them
on, a hotkey. **Resume captions** picks up where you left off.

### Follow mode

Press **Follow** on someone's row and the bot moves with them when they hop
between voice channels in that server. Handy when you *are* that someone. It's
off until you press it, it stays within the one server, and it skips stage
channels and any channel the bot can't join, saying so in the Log. Following
someone doesn't switch anyone on — who gets captioned is still up to you.

If a moderator drags the bot to a different channel, ChatterLayer follows the
move and the Channels panel updates to match.

### Names and colours

**Click a name to change how it appears on captions.** Discord handles are rarely
what you want burned into your stream — `ruptz_45454` can show up as `Ruptz`. The
real handle stays visible underneath in the app so you can still tell who's who.
Clear the field to go back to their Discord name.

**Click the colour swatch** next to anyone to pick a different colour for them.

Both apply to the very next caption. No restart, no OBS refresh.

Colours are assigned automatically from each person's Discord ID, so the same
friend gets the same colour every time — and ChatterLayer guarantees **no two
people in the same call share a colour** (up to 16 people, which is where the
palette runs out).

### How the captions look

Everything in the **Output** panel applies to the live overlay instantly — no
OBS refresh needed:

| Control | What it does |
|---|---|
| **Text size** | 14–64 px |
| **Hold** | How long a caption stays on screen before fading (2–20 s) |
| **Max lines** | How many captions are visible at once (1–8) |
| **Live partial text** | Words appear as they're spoken, then get corrected when the sentence settles. Turn it off if you only want finished lines. |
| **Speaker names** | Show or hide the name in front of each caption |
| **Port** | Change it if `8777` clashes with something. Applies when you press Enter or click away — remember to update the OBS URL |
| **Clear captions** | Wipes the overlay immediately. |
| **Send test caption** | Puts a sample line on the overlay, for sizing it in OBS without a call |

### Watch it before your viewers do

The **Monitor** panel shows every caption as it goes out, in the same colours as
the overlay. Keep an eye on it — it's the fastest way to spot that someone's mic
is producing gibberish, or that the model is mishearing a name badly.

The **Log** panel underneath shows connection state and any errors. That's the
first place to look if something's not working.

---

## Leaving it running

ChatterLayer is built to sit in the tray for a whole stream and look after
itself.

**It recovers on its own.** If the speech engine crashes, it restarts, signs
back in, rejoins the call and switches the same people back on — up to five
tries, backing off from 1 second to a minute. If the voice connection drops, it
rejoins (five tries) without unloading the model. The one exception: if a
moderator disconnects the bot, it stays out. **Disconnect** and **Quit** always
win over a retry in progress.

**It tells you when it can't.** If captions stop while ChatterLayer isn't the
window you're looking at, you get a system notification — and another saying
"Captions are back" once it's recovered.

**Start with the computer, in the tray** (under the cog) launches it at login,
signed in to Discord and waiting. Nobody is captioned and nothing is shared
until you press Connect. It re-points itself on every launch, so it always starts
the copy you're running.

**Global hotkeys** (also under the cog, off by default) work while a game has
focus: **Ctrl+Alt+P** pauses and resumes captions, **Ctrl+Alt+K** clears the
overlay. On a Mac it's Cmd instead of Ctrl. While they're on, those key
combinations belong to ChatterLayer in every app.

**Light or dark:** the cog also has **Match system**, **Light** and **Dark**.

---

## Sharing captions with your co-streamers

When four people in the same call are all live, you don't need four copies of
ChatterLayer. One person runs it; everyone else points OBS at a link.

That saves the others a bot, a speech model and the CPU to run it — and it means
every stream shows the *same* captions instead of four slightly different
transcriptions of the same conversation.

**This is off by default and never starts on its own.** ChatterLayer is offline
software and stays that way unless you deliberately do this, every time:

1. Open **Remote overlay** and tick *Let other streamers use these captions*.
   Nothing has opened yet — this only reveals the controls.
2. Press **Start tunnel**. The first time, ChatterLayer downloads
   [cloudflared](https://github.com/cloudflare/cloudflared) (~35 MB, kept for
   next time). If you already have `cloudflared` on your PATH, that one is used.
3. Copy the link it gives you and send it to your co-streamers. They paste it
   into a **Browser** source in OBS, exactly like the local one.

Press **Stop tunnel**, or just close ChatterLayer, and the link dies. The tunnel
is always closed again the next time the app starts, however you left the tick
box.

### The access key

The link looks like this — the `?k=` part is an access key:

```
https://calm-river-quiet-1f4c.trycloudflare.com/overlay?k=Xk3pQ7rTvB2nL9wYzA4hMg
```

Without a valid key the page returns **401** and the caption feed refuses the
connection. A wrong key is refused exactly as firmly as no key — a truncated
one, one with characters appended, or the right value under a different
parameter name all get 401. Treat the link like a password: anyone you send it
to can watch your voice channel's captions for as long as the tunnel is up.

**One link, one session.** The key is generated fresh every time you press Start
and only ever exists in memory — it is never written to your config file. Stop
the tunnel, or close ChatterLayer, and it's gone for good. There is nothing to
clean up later and no old key sitting on disk; last week's link is dead twice
over, since the tunnel hostname was random too.

**New access key** mints a replacement mid-stream and immediately disconnects
anyone using the old link. That's the case it's for — cutting someone off while
you're still live. (It's only available while the tunnel is up; stopping already
throws the key away.)

Your own local OBS source is never affected by any of this:
`http://127.0.0.1:8777/overlay` keeps working with no key.

### What else guards the link

| | |
|---|---|
| **Key strength** | 128 bits from `crypto.randomBytes` — a CSPRNG, never `Math.random()` — as 22 URL-safe characters |
| **Comparison** | SHA-256 then `timingSafeEqual`, so a near-miss leaks nothing through timing |
| **Rate limiting** | 20 failed attempts per caller per minute, then `429` for a minute. A correct key resets the count. Keyed on Cloudflare's `cf-connecting-ip`, which the caller cannot forge |
| **Connection cap** | 16 simultaneous remote viewers. Your own OBS is never counted and never refused, so flooding the tunnel can't cost you your own overlay |
| **Transport** | The overlay refuses to open the caption feed if the page arrived over plain HTTP from anywhere but this machine, so the key is never put on the wire in clear text |
| **Read-only** | The caption feed is one-directional. The server registers no handler for inbound messages, and frames over 1 KB close the socket. A link grants watching, never controlling |
| **Logging** | The Log panel records the bare tunnel hostname, never the keyed link — safe to screenshot into a bug report |

Rate limiting is there to stop a scanner wasting your CPU mid-stream, not to
stop key guessing: at 128 bits, guessing was never the realistic attack.

### Each streamer can size it for their own scene

The host's sliders are the default for everyone, which is rarely what you want
when one person has a full-screen gameplay scene and another has a big face cam.
Anyone can override the styling for **their** browser source by adding
parameters to the end of their copy of the link:

| Add | Does |
|---|---|
| `&size=42` | Text size in px (8–200) |
| `&hold=5` | Seconds a caption stays up (0.5–120) |
| `&lines=2` | How many captions are visible at once (1–20) |
| `&partials=0` | Finished lines only — no live in-progress text |
| `&names=0` | Hide speaker names |

For example:

```
https://calm-river-quiet-1f4c.trycloudflare.com/overlay?k=Xk3pQ7rTvB2nL9wYzA4hMg&size=44&lines=2
```

These stick even when the host moves their own sliders mid-stream, and they
affect nobody else.

### What to know before you rely on it

- **The link changes every time you start the tunnel.** Quick Tunnels get a
  random hostname, so your co-streamers re-paste after you restart ChatterLayer.
  Sort it out before you go live, not during.
- **Cloudflare makes no uptime promise** for Quick Tunnels. They're free and
  need no Cloudflare account or domain, and that's the trade.
- **Audio still never leaves your machine.** What goes through the tunnel is the
  finished caption text — the same words already on your stream — and nothing
  else. Recognition is still entirely local.
- **Changing the port stops the tunnel**, since the old link would point at
  nothing. Start it again for a new one.

---

## Consent — read this one

Everyone in that call is being transcribed onto your stream, permanently, in
front of your audience.

**Tell them.** Use the per-person toggles to caption only the people who've
actually agreed. In some countries and US states, recording or transcribing
someone without their consent is illegal. ChatterLayer ships with everyone
switched **off** by default specifically so that the safe option is the default
one.

---

## The word filter

Captions hit your stream the instant they're recognised — there's no chance for
you to review them first. So **racial and ethnic slurs are masked by default**,
in both speech and speaker names:

```
he called me a *****        <- speech
*****                       <- a slur in someone's Discord name
```

The masking happens before captions reach OBS *or* the in-app Monitor, so the
unmasked text never leaves the app.

**Whole words only.** Substring matching would censor perfectly ordinary
speech — and a filter that mangles normal sentences is a filter you'll switch
off, which protects nobody. Plurals are handled automatically, and multi-word
slurs are caught across adjacent words.

**Adding your own.** The **Word filter** panel takes one word or phrase per line
and saves as you type. The built-in list covers racial and ethnic slurs only —
other categories vary a lot by platform and community, so those are yours to
set.

Words that are also ordinary words in common use are deliberately left out of the
defaults, because a false positive mid-sentence is worse than useless. Add them
yourself if your community needs them.

> **This is a safety net, not a guarantee.** Speech recognition mishears things.
> It can miss a slur by transcribing it as something else, and it can invent one
> nobody said. Treat the filter as one layer of protection, not as permission to
> leave captions running unattended.

---

## How good are the captions, really?

Honest expectations, because it's better to know now than to find out on stream.

Everything here runs offline on your own PC. That rules out the very best
cloud models, but it no longer means what it used to — Moonshine, Whisper and
Parakeet all land meaningfully closer to a paid service than Vosk does.

**What to expect:**

- **Vosk**: roughly **85–92%** of words correct for a clear speaker on a decent
  mic in a quiet room, as a lowercase stream with no punctuation.
- **Moonshine / Whisper / Parakeet**: better than that, with punctuation and
  capitalisation, and much better on proper nouns. Parakeet on clear speech gets
  close to what a paid service returns.
- Paid cloud services get 93–97% on the same audio, so there is still a gap at
  the top.
- Every engine degrades with background noise, music, strong accents, people
  talking over each other, and cheap microphones — the offline ones faster than
  the paid ones.
- Game jargon, usernames and memes are hard for all of them; the vocabulary is
  fixed and can't be nudged toward your community's slang.
- **Mic quality matters more than model size.** A friend on a bad headset will be
  the weak link no matter which model you run.

Here is the same eleven-second clip through every engine, so the difference is
concrete rather than adjectival:

```
Parakeet TDT 0.6B  And so, my fellow Americans. Ask not. What your country can do
                   for you. Ask what you can do for your country.
Whisper Small      And so, my fellow Americans, Ask not! What your country can do
                   for you, ask what you can do for your country.
Moonshine Base     And so my fellow Americans. Ask not. What your country can do
                   for you ask what you can do for your country
Whisper Base       and so my fellow Americans. Ask not! What your country can do
                   for you, ask what you can do for your country.
Whisper Tiny       And so am I fellow Americans. Ask, not! What your country can
                   do for you, ask what you can do for your country.
Vosk Medium        and so my fellow american ask not what your country can do for
                   you ask what you can do for your country
Vosk Small         and so my fellow americans as not what your country can do for
                   you ask what you can do for your country
```

Note where the small models slip: Whisper Tiny hears "am I" for "my", Vosk Small
hears "as not" for "ask not", and Vosk Medium drops the plural on "Americans".

**Why it's still the right call here:**

- **Free and unmetered.** Cloud speech-to-text runs about $0.02–0.06 per streamed
  hour *per person*. Seven people across a five-hour stream is real money, every
  single stream. ChatterLayer costs nothing to run, ever.
- **Private.** Your friends' voices never leave your machine. No provider terms
  to read, no data retention questions, no third party in the loop.
- **Nothing to break mid-stream.** No API key to expire, no quota to hit, no
  billing failure at 2am.
- **Fast**, because there's no round-trip to a server.
- **Works offline**, including when your connection wobbles.

**Want better accuracy?** Install **Parakeet TDT 0.6B** from the model picker. It
closes most of the gap on clear speech, and unlike the old advice here — which
pointed at Vosk Gigaspeech — it is not slow: a caption takes about 290 ms, and it
still manages four speakers. The cost is a 2.5 GB download and ~2.6 GB of RAM,
loaded once and shared however many people are on.

---

## Troubleshooting

Stuck? **Report a problem** in the app opens a GitHub bug report with your
version, OS, build and the end of the Log already filled in — never your token.
You read it before anything is sent.

---

**"Model: NOT FOUND"**
Open the model picker (**Get models**) and download one.

---

**The Server dropdown is empty, or says "Sign-in failed"**
The sign-in line under the dropdown says which it is.

- *Sign-in failed* — the token is wrong, or you reset it in the Developer Portal
  and ChatterLayer still has the old one. Paste the current token over the old
  one — it signs in again by itself.
- *Signed in, but no servers* — the bot isn't in a server yet, or the only ones
  it's in have no voice channels. Press **Invite the bot to a server** in the
  Source panel.

---

**The channel I want is greyed out**
The bot is missing **View Channel** or **Connect** on that specific channel —
hover it and the dropdown says which. Channel-level permission overrides beat
server-level ones, so fix it in that channel's own permission settings, not just
on the role. Press **Refresh** afterwards.

---

**Stuck on "Linking" and never connects**
Check the **Log** panel — it reports each stage (signing in → loading model →
looking up channel → joining voice), so you can see where it stopped. Usually
it's a big model still loading: Gigaspeech takes ~33 seconds on first connect,
and the log says which model it's on.

---

**Bot joins but no captions appear**

- Have you switched at least one person **on** in the Channels panel? Nobody is
  captioned by default.
- Is that person actually transmitting? Discord shows a green ring around their
  avatar when they are.
- Is it a **stage** channel? The bot sits in the audience and receives no audio
  until you invite it to speak.
- Check the **Log** panel — recogniser errors show up there.

---

**"Used disallowed intents"**
You turned on a privileged intent the bot doesn't need. Go back to the Discord
Developer Portal and switch **Server Members** and **Message Content** off.

---

**Port 8777 already in use**
Change the port in the **Output** panel — the server rebinds straight away. Then
update the URL in your OBS browser source to match.

---

**Overlay is blank in OBS**

- Check the URL matches the one shown in the **Output** panel (the port may have
  changed).
- Make sure ChatterLayer is actually running.
- Open the same URL in a normal browser: if the overlay can't reach the app,
  you'll see a "connecting" badge, which tells you it's a connection problem
  rather than an OBS problem.

---

**Captions fall further and further behind**
You're CPU-bound. Caption fewer people, or switch to a smaller model.

---

**Someone's audio dies mid-call, and the log mentions "Failed to decrypt"**
This is a Discord end-to-end-encryption quirk, not a ChatterLayer bug.
ChatterLayer already works around it and rebuilds broken audio streams
automatically (5 attempts). If someone's captions stop for good, toggle them off
and back on. Full explanation in the
[developer section](#the-dave-encryption-problem).

---

**Audio receive stops working after a Discord update**
Receiving voice as a bot isn't an officially supported part of Discord's API,
though the library ChatterLayer uses has supported it for years. If Discord
changes something, this can break until the library catches up. Worth knowing
before you build your whole stream layout around it.

---

## Support the project

ChatterLayer is free and always will be — no tiers, no upsell, no "pro" version
holding the good features hostage.

If it's earned you a coffee, there's a **Buy me a coffee** button in the bottom
corner of the app, or [ko-fi.com/ruptz](https://ko-fi.com/ruptz). Entirely
optional, and nothing in the app changes either way.

Bug reports and feature ideas are just as welcome — open an
[issue](https://github.com/ruptz/ChatterLayer/issues).

---

## Licence

MIT — see [LICENSE](LICENSE). Use it, fork it, ship it, stream with it, no
restrictions.

The bundled Vosk runtime is Apache 2.0, as is ONNX Runtime. Speech models are
downloaded by you at runtime and aren't redistributed here — Vosk's are Apache 2.0,
Whisper's are MIT, Moonshine's are MIT, and Parakeet TDT is CC-BY-4.0. Discord bot
usage is subject to Discord's Terms of Service.

---
---

# For developers

Everything below this line is for people building, modifying or packaging
ChatterLayer. You don't need any of it to use the app.

**Contents**

- [Running from source](#running-from-source)
- [Testing](#testing)
- [How it works](#how-it-works)
- [Speaker colours](#speaker-colours)
- [DAVE encryption](#dave-encryption)
- [Performance: RAM, CPU, latency](#performance-ram-cpu-latency)
- [Project layout](#project-layout)
- [Shipping a release](#shipping-a-release)

## Running from source

ChatterLayer is a [Tauri](https://tauri.app) app: Rust underneath, the window in
plain HTML, CSS and JS (`public/`), drawn by the system's own web view (WebView2 on
Windows, WebKit on macOS and Linux).
You need **Node.js 22**, **Rust** (stable), a C compiler and **CMake** (the Opus
decoder builds from source): on Windows the Visual Studio C++ build tools, on
macOS the Xcode command-line tools, and on Linux the packages listed in
`.github/workflows/ci.yml`.

```bash
git clone https://github.com/ruptz/ChatterLayer.git
cd ChatterLayer
npm install                       # the Tauri command-line tools, ESLint
node scripts/fetch-runtimes.js    # libvosk and ONNX Runtime for this OS into vendor/runtime/
npm start                         # tauri dev
```

A source checkout keeps speech models in `models/` beside the code; an installed
build keeps them in `%APPDATA%\ChatterLayer\models`. Download one from the app's
Speech model panel.

## Testing

```bash
cd src-tauri
cargo test --lib                  # colours, word filter, config, server gate,
                                  # segmenter, tokenisers, mic gate, tunnel, versions
# Transcribe a 16 kHz mono WAV with every installed ONNX model:
CHATTERLAYER_TEST_WAV=some.wav cargo test --release --lib transcribes -- --ignored --nocapture
# Real downloads of a model of each shape, and of the pinned cloudflared:
CHATTERLAYER_TEST_DIR=some/empty/dir cargo test --lib installs -- --ignored
npm run lint                      # the window's scripts
```

The model catalogue — URLs, pinned revisions, sizes and checksums — is
`src-tauri/models.json`. A model's revision, byte sizes and hashes have to move
together, or every download fails its checksum for reasons that look like
corruption and aren't.

Config lives in `%APPDATA%\ChatterLayer\chatterlayer-config.json` (**Show config
file** in the app reveals it). The bot token is never in it: it's in Windows
Credential Manager.

## How it works

```
Discord voice channel
   │  per-user Opus, DAVE end-to-end encrypted
   ▼
serenity + songbird   (src-tauri/src/discord.rs)
   │  decrypts, and decodes Opus straight to 16 kHz mono — no resampling step
   ▼
speech thread         (src-tauri/src/stt/)
   │  one shared model, whichever engine — Vosk streams and keeps a recogniser
   │  per speaker; the ONNX engines buffer each phrase and decode it once
   ▼
app                   (src-tauri/src/lib.rs) ── colour, name, word filter ──▶ WebSocket :8777
                                                                    └─▶ /overlay  (OBS browser source)
```

**Why sign-in and join are separate.** The server and channel pickers are built
from the signed-in session's cache, so the app signs in at launch and joins a
voice channel later. Signing in must not load a speech model, so a bad token fails
in seconds instead of after a long model load, and Disconnect leaves the call but
keeps the session, so the pickers don't empty every time. Signing in again with
the same token just re-publishes the tree, which makes it the Refresh button. The
per-channel permission verdict is tri-state: without the bot's own member cached
it's "unknown", never "can't join".

**Why the runtimes load at runtime.** libvosk and ONNX Runtime are opened from
the app's own folder when a model needs them, not linked in. Someone on Vosk never
loads ONNX Runtime, and the build doesn't depend on which Visual C++ standard
library the machine compiling it happens to have. Release builds only ever look
in the app's own folder.

**Why speaking ends after 100 ms of quiet.** Discord sends nothing while someone is
silent, so the end of an utterance is packets stopping. Five quiet 20 ms ticks
flush the speaker's recogniser, which makes the last words appear without waiting
for a packet that may never come.

## Speaker colours

Colours are hashed from the Discord user ID so the same person looks the same
across sessions and machines, with zero configuration. But hashing alone isn't
enough: with a 16-colour palette, **seven random users collide about 78% of the
time** (the birthday bound — measured, not theoretical), and two speakers sharing
a colour defeats the entire point.

So ChatterLayer assigns colours across the *whole call* at once. Each person
prefers their hashed colour; when two want the same one, the assignment probes
forward through the palette. Iterating in sorted ID order keeps it deterministic —
the same group always gets the same colours. Manual overrides are reserved first
and always win.

Result: **0% duplicate colours** for calls up to 16 people, while 81% of speakers
still keep their preferred colour. Past 16 concurrent speakers the palette is
exhausted and duplicates become unavoidable.

## DAVE encryption

Discord's DAVE end-to-end encryption covers voice. songbird handles it through the
[`davey`](https://crates.io/crates/davey) crate — the same DAVE implementation
`@discordjs/voice` used in 0.4 — so there's no protocol code here.

What to expect: when the bot joins, or someone joins mid-call, there's a key
change, and for about half a second packets can arrive before the bot has the new
key. Those are dropped and that speaker's caption skips a fraction of a second;
nothing else happens. songbird logs each one through `tracing`, which the app
doesn't subscribe to, so they don't flood anything.

## Performance and limits

### 0.5 against 0.4

The same machine (Ryzen 5 5600X, 6 cores / 12 threads), the packaged 0.4 app
against a release build of 0.5, each captioning the same looping recording through
the same Parakeet model, measured across every process each app runs:

| | 0.4 (Electron) | 0.5 (Rust) |
|---|---|---|
| Idle CPU | 0.04% | 0.06% |
| Idle memory | 103 MB | 96 MB |
| Captioning CPU | 22.5% | 19.4% |
| Captioning memory | 2,355 MB | 2,291 MB |
| Start to first caption | 11.4 s | 7.3 s |
| Download / installed | 172 MB / 452 MB | 30 MB / ~94 MB |

And one 7.2-second clip through each ONNX model, decode only:

| Model | 0.4 | 0.5 |
|---|---|---|
| Parakeet TDT 0.6B | 1096 ms | 721 ms |
| Moonshine Base | 958 ms | 282 ms |
| Whisper Tiny | 2070 ms | 1000 ms |
| Whisper Base | 3399 ms | 1619 ms |
| Whisper Small | 7680 ms | 3010 ms |

Memory is the model's either way: the app around it is about 100 MB in both.

### The detailed tables (measured on 0.4)

Everything below was measured on 0.4's JavaScript engines against real speech.
The memory figures carry over; the timings are upper bounds for 0.5, whose
engines decode the same audio 1.5–3× faster.

### The whole table

| Model | Peak RAM | Load | CPU per second of speech | One caption | Speakers |
|---|---|---|---|---|---|
| Vosk Small | 170 MB + 12/speaker | 0.3 s | 0.095× continuous | live | 7 |
| Vosk Medium | 420 MB + 51/speaker | 0.8 s | 0.34× continuous | live | 7 |
| Moonshine Base | 507 MB | 1.3 s | 0.032× | 146–163 ms | 6–7 |
| Whisper Tiny | 413 MB | 0.5 s | 0.090× | 601–667 ms | 2 |
| Whisper Base | 695 MB | 0.7 s | 0.129× | 945–1112 ms | 1 |
| Whisper Small | 1822 MB | 1.3 s | 0.280× | ~2225 ms | 1 |
| Parakeet TDT 0.6B | 2568 MB | 2.8 s | 0.062× | ~290 ms | 4 |

The three models near the decision boundary were run three times each, because a
single run moved the suggested speaker count by one. Whisper Tiny came out at 2
every time and Whisper Base at 1 every time, which is what the catalogue now says.

Vosk Large and Gigaspeech are not in this run (1.8 GB and 2.3 GB downloads); their
catalogue figures are extrapolated from model size.

### Memory when several people are captioned at once

**No engine here loads the model more than once.** This is the single most
important thing to know about running many speakers, and it is worth stating
plainly because the arithmetic people expect does not apply: Parakeet is **not**
2.5 GB per speaker. It is 2.5 GB, once, shared by everyone.

What each additional speaker actually costs:

| Engine | Per additional speaker | Why |
|---|---|---|
| Vosk | 12–51 MB | Its own recogniser and decoding lattice |
| Moonshine / Whisper / Parakeet | ~3 MB | An audio buffer, and nothing else |

So on the ONNX engines memory is essentially flat in the number of speakers —
seven people on Moonshine Base is about 570 MB, not 3.8 GB. Vosk is the one where
memory grows, and how fast depends on the model: Medium's decoding lattice is
51 MB per speaker against Small's 12 MB.

Two measured caveats:

- **Whisper's memory is mostly not its weights.** Whisper Small is a 380 MB model
  that peaks at 1.8 GB, because its encoder input is a fixed 30-second window and
  the activations are large. ChatterLayer therefore runs the Whisper sessions
  with ONNX Runtime's memory arena **disabled** — with it on, Whisper Small peaks
  at 3.6 GB instead, in exchange for about a third off the decode time. Set
  `CHATTERLAYER_STT_ARENA=1` to take that trade the other way. Moonshine and
  Parakeet keep the arena, where it costs 100 MB and 400 MB respectively.
- **Vosk Medium's per-speaker cost is 51 MB, not the 12 MB earlier versions of
  this README claimed.** The old figure came from benchmarking against synthetic
  noise, which keeps the decoding lattice far smaller than real speech does.

### CPU, and where the speaker limits come from

The two engine families run out of CPU in completely different ways.

**Vosk draws continuously.** It does a fixed amount of work per 20 ms of audio,
so cost is `0.34× of a core per talking speaker` on Medium. Seven people all
talking at once is ~2.4 cores. That peak is rare — Discord transmits no packets
while someone is silent, so idle speakers cost nothing.

**The others draw in bursts.** They do no work at all until a phrase ends, then
spend one decode on it. Cost per second of *speech* is far lower than Vosk's
(0.032× for Moonshine), and silence is trimmed before decoding, so a quiet channel
is nearly free.

What limits them instead is **latency**, because decodes are queued one at a time.
If four people stop talking at the same instant, the fourth caption waits for
three decodes ahead of it. The speaker limits in the table are the point where
that worst case stays under 1.5 seconds:

```
Moonshine Base, 4-second utterances, worst case all finishing together:
   1 speaker    96 ms      5 speakers   464 ms
   2 speakers  187 ms      6 speakers   568 ms
   3 speakers  284 ms      7 speakers   750 ms
```

Everyone finishing simultaneously is the worst case, not the common one — in real
conversation people mostly take turns, so the practical ceiling is higher than the
table says. Runs also vary by about one speaker either way. The app **warns rather
than refuses** when you go over: the model note turns amber and the log says so.

Decodes are deliberately **serialised** rather than run in parallel. Seven
simultaneous decodes would contend for the same cores and every one of them would
miss its deadline; one at a time, the first six are early and only the last is
late. Within that, **finals always run and partials are dropped** whenever a real
decode is waiting — a speculative in-progress guess is never allowed to delay a
finished sentence.

Tuning knobs, all environment variables:

| Variable | Default | Effect |
|---|---|---|
| `CHATTERLAYER_STT_THREADS` | half the cores, max 8 | Threads per decode |
| `CHATTERLAYER_STT_CONCURRENCY` | 1 | Decodes allowed at once |
| `CHATTERLAYER_STT_PARTIALS` | on | `0` disables in-progress guesses |
| `CHATTERLAYER_STT_ARENA` | per engine | `0`/`1` overrides the memory arena |
| `CHATTERLAYER_STT_MAX_UTTERANCE` | 20 | Seconds before a turn is force-closed |

### Memory (Vosk, in detail)

The acoustic model is loaded **once** and shared by every recognizer, so adding a
speaker costs only a recognizer — not another copy of the model.

| Selected speakers | Engine process RSS |
|---|---|
| model only (0 speakers) | 152 MB |
| 1 | 168 MB |
| 2 | 181 MB |
| 3 | 192 MB |
| 4 | 204 MB |
| 5 | 216 MB |
| 6 | 228 MB |
| 7 | **240 MB** |

- **Shared model:** ~116 MB, paid once.
- **Per additional speaker:** **~12 MB** (the first is ~16 MB).
- **Plus the app and its window:** about 100 MB.
- **Realistic total for a 7-person call:** **~400–450 MB**.

Switching a speaker off frees their recognizer immediately.

**The model choice dominates everything else.** Per-speaker cost barely moves
between models — it's the shared model that changes:

| Model | Model RAM | Per speaker | 4 speakers total |
|---|---|---|---|
| `small-en-us-0.15` | 116 MB | ~12 MB | **204 MB** |
| `en-us-0.42-gigaspeech` | 6842 MB | ~15 MB | **6939 MB** |

So adding speakers is cheap; adding accuracy is not.

### CPU

The benchmark reports ~0.025× realtime per stream, but **that number is
optimistic** — it uses synthetic noise, which Vosk's silence detection prunes far
more aggressively than real speech. For planning, budget **0.1–0.3× of one core
per actively-talking speaker** on a modern desktop CPU. Seven people all talking
at once is therefore roughly **1–2 cores**, and that peak is rare: Discord
transmits no packets while someone is silent, so idle speakers cost essentially
nothing.

Decoding runs on a **dedicated thread**, deliberately: blocking the async runtime
would stall the Discord voice socket and drop inbound audio packets.

### Latency

End-to-end, speech → pixels on stream:

**Vosk** (streaming — text appears as the words are said):

| Stage | Typical |
|---|---|
| Discord network + 20 ms Opus framing | ~60–100 ms |
| Decode + queue to the speech thread | <5 ms |
| Partial decode + 120 ms update throttle | ~120–250 ms |
| Local WebSocket + browser paint | <20 ms |
| **Live partial text appears** | **~250–500 ms** |
| **Finalised line** (after the speaker pauses) | **~0.5–1.5 s** |

**Moonshine / Whisper / Parakeet** (a phrase at a time):

| Stage | Typical |
|---|---|
| Discord network + 20 ms Opus framing | ~60–100 ms |
| Waiting for the phrase to end | Discord's `speaking end`, or 800 ms of silence |
| One decode | 120 ms (Moonshine) → 2.2 s (Whisper Small) |
| Local WebSocket + browser paint | <20 ms |
| **Finalised line** | **~0.3 s (Moonshine) → ~3 s (Whisper Small)** |

The wait for the phrase to end is usually shorter than 800 ms, because Discord's
own `speaking end` event arrives first and closes the utterance immediately. The
800 ms silence detector is the fallback for someone talking straight through.

These engines can also produce in-progress guesses by re-running on the audio so
far, and do when there is CPU to spare — but they are speculative: at most one
outstanding per speaker, skipped whenever a real decode is waiting, and discarded
if the phrase has already ended. On a busy channel they mostly stop happening,
which is the intended behaviour.

### Adding another engine

Four engines share one interface, and everything above `src-tauri/src/stt/` deals
in `{ userId, text, isFinal }` without knowing which produced it. A fifth needs:

1. A module in `src-tauri/src/stt/` with a `load(dir)` and either streaming
   sessions (like `vosk.rs`) or `transcribe(&[f32]) -> String`, which gets
   utterance buffering, silence detection and decode scheduling for free.
2. An arm in `run` and `ClipEngine` in `src-tauri/src/stt/mod.rs`.
3. A catalogue entry in `src-tauri/models.json`.

Nothing else changes — not the Discord side, not the caption server, not the
overlay. The picker, the downloader and the manifest on disk all come from the
catalogue entry.

## Project layout

```
src-tauri/
  src/
    lib.rs        The app: window, tray, commands, caption relay, sharing
    discord.rs    Sign-in, the server/channel tree, voice, per-speaker audio
    stt/          The four speech engines and everything they share
    server.rs     The overlay page and its WebSocket feed, with the access gate
    tunnel.rs     Optional Cloudflare Quick Tunnel (opt-in, pinned cloudflared)
    config.rs     Settings, and the token in Credential Manager
    install.rs    Model downloads, checked against models.json
    mic.rs        Voice gate for the local mic
    meta.rs       Update check, bug-report link, What's new
    colors.rs, wordfilter.rs, models.rs
  icons/app-icon.png  The app icon's source: the logo with rounded corners.
                      After changing it: npx tauri icon src-tauri/icons/app-icon.png -o src-tauri/icons
  models.json     The model catalogue
  whats-new.json  Release notes: the in-app card and the GitHub release
public/           The window: index.html, styles.css, renderer.js, bridge.js
web/overlay.html  OBS browser source (built into the app)
scripts/
  fetch-runtimes.js  libvosk and ONNX Runtime into vendor/, checksummed
```

## Shipping a release

**CI builds releases, not your machine.** Bump the version in `package.json`,
`src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`, give it an entry in
`src-tauri/whats-new.json`, then:

```bash
git tag v0.5.1
git push origin v0.5.1
```

`release.yml` checks the tag matches all three versions, fetches the runtimes,
runs the tests, builds the installer and the WidgetCake zip, attests both, and
opens a **draft** release with a Sigstore-signed `SHA256SUMS` and that version's
What's new notes. Review it, then publish.

| Artifact | |
|---|---|
| `ChatterLayer-<version>-Setup.exe` | Windows installer. Removes 0.4 or earlier first. |
| `ChatterLayer-<version>-macos-arm64.dmg`, `-macos-x64.dmg` | macOS |
| `ChatterLayer-<version>-linux-x64.AppImage`, `.deb` (and `linux-arm64`) | Linux |
| `ChatterLayer-<version>-<platform>.zip` | The app on its own, for each of those. What WidgetCake installs; Windows's is `-win.zip`. |

Windows is tested. macOS and Linux are built from the same code but not tested
by us, so the release notes ask people to report issues.

### Smoke-test before you publish

CI never runs the installer, so do it on a machine that isn't your dev box:
install from the draft, download the recommended model, connect with two people
switched on, start and stop the tunnel, close to tray and quit from the tray.
Then check the checksums you're asking other people to trust:

```bash
sha256sum -c SHA256SUMS
cosign verify-blob --bundle SHA256SUMS.cosign.bundle \
  --certificate-identity-regexp 'https://github.com/ruptz/ChatterLayer/.+' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  SHA256SUMS
gh attestation verify ChatterLayer-*-Setup.exe --repo ruptz/ChatterLayer
```

### How users find out

The version sits in the title bar. Once per launch the app asks GitHub for the
newest *published* release (drafts don't count) and lights the stamp amber if
there is one. Nothing downloads or installs itself, and it's a visible switch:
**Output → Check for updates**.
