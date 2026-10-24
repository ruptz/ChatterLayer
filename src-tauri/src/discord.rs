//! The Discord side: signs the bot in, lists the servers and voice channels it
//! can see, joins one, and hands each switched-on speaker's audio to the speech
//! worker. Everything it reports goes out through `emit` as the same JSON
//! messages the Electron engine sent, so the window needs no changes.
//!
//! Nothing here knows which speech engine is loaded. It hands the model to the
//! worker and gets `{ userId, text, isFinal }` back.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use serde_json::{Value, json};
use serenity::all::{
    Cache, ChannelId, ChannelType, Context, EventHandler, GatewayIntents, Guild, GuildChannel, GuildId, Http,
    Message as DiscordMessage, PartialGuild, Permissions, Ready, ShardManager, UnavailableGuild, UserId, VoiceState,
};
use serenity::async_trait;
use songbird::driver::{Channels, DecodeConfig, DecodeMode, SampleRate};
use songbird::events::context_data::DisconnectReason;
use songbird::{CoreEvent, Event, EventContext, EventHandler as VoiceEventHandler, SerenityInit, Songbird};
use tokio::sync::oneshot;

use crate::mic::MicGate;
use crate::models::{self, Model};
use crate::stt::{self, Speech};

/// The local microphone's speaker id. Not a Discord snowflake, so it can never
/// collide with a real member.
pub const MIC_ID: &str = "mic";

/// Parakeet has 2.5 GB of weights to read off disk, so this is generous.
const MODEL_LOAD_TIMEOUT: Duration = Duration::from_secs(300);
const GATEWAY_READY_TIMEOUT: Duration = Duration::from_secs(30);
const JOIN_TIMEOUT: Duration = Duration::from_secs(30);

/// A speech worker that dies after it was ready is restarted in place this
/// many times before the user is told to reconnect.
const MAX_WORKER_RESTARTS: u32 = 5;

/// A voice connection that drops and does not come back is rejoined after
/// each of these waits, keeping the model loaded and everyone switched on.
const VOICE_REJOIN_DELAYS: [u64; 5] = [2, 5, 10, 20, 30];

/// Being added to a server delivers the guild and then each channel as
/// separate events. One re-published tree per burst is plenty.
const GUILD_REFRESH_DEBOUNCE: Duration = Duration::from_millis(400);

/// Consecutive 20 ms ticks without a packet before someone counts as having
/// stopped talking — Discord's own speaking-end delay is about the same.
const SPEAKING_END_TICKS: u32 = 5;

pub type Emit = Arc<dyn Fn(Value) + Send + Sync>;

struct Session {
    token: String,
    http: Arc<Http>,
    cache: Arc<Cache>,
    shards: Arc<ShardManager>,
    songbird: Arc<Songbird>,
    bot_id: UserId,
    app_id: String,
    tag: String,
}

/// Where audio goes. Read on every 20 ms voice tick, so it lives apart from
/// the rest of the state and is only ever locked briefly.
#[derive(Default)]
struct Route {
    ssrc_users: HashMap<u32, String>,
    /// Users whose audio reaches the speech worker right now.
    capturing: HashSet<String>,
    /// ssrc -> ticks since its last packet, while it counts as speaking.
    quiet_ticks: HashMap<u32, u32>,
    speech: Option<std::sync::mpsc::Sender<stt::In>>,
    /// Present while the mic is being captured.
    mic: Option<MicGate>,
}

#[derive(Default)]
struct State {
    session: Option<Arc<Session>>,
    guild_id: Option<GuildId>,
    channel_id: Option<ChannelId>,
    speech: Option<Speech>,
    speech_ready: bool,
    model: Option<Model>,
    worker_restarts: u32,
    max_speakers: Option<u64>,
    model_name: String,
    warned_speaker_limit: bool,
    selected: HashSet<String>,
    follow: Option<String>,
    me: Option<String>,
    mic_source: bool,
    /// Sensitivity and hang time for the mic gate.
    mic_gate: (f64, f64),
    stopping: bool,
    recovering: bool,
    /// Bumped on every guild-tree change, so only the last of a burst emits.
    guild_burst: u64,
}

pub struct Inner {
    emit: Emit,
    models_dir: PathBuf,
    resource_dir: Option<PathBuf>,
    state: Mutex<State>,
    route: Mutex<Route>,
    /// Serialises sign-ins: a second caller waits for the first login rather
    /// than building a second client.
    signing_in: tokio::sync::Mutex<()>,
}

#[derive(Clone)]
pub struct Engine(Arc<Inner>);

impl Engine {
    pub fn new(emit: Emit, models_dir: PathBuf, resource_dir: Option<PathBuf>) -> Self {
        Self(Arc::new(Inner {
            emit,
            models_dir,
            resource_dir,
            state: Mutex::new(State { mic_gate: (5.0, 700.0), ..State::default() }),
            route: Mutex::new(Route::default()),
            signing_in: tokio::sync::Mutex::new(()),
        }))
    }

    pub fn running(&self) -> bool {
        let st = self.0.state.lock().unwrap();
        st.speech.is_some() || st.channel_id.is_some()
    }

    fn emit(&self, msg: Value) {
        (self.0.emit)(msg)
    }

    fn log(&self, level: &str, message: impl Into<String>) {
        self.emit(json!({ "type": "log", "level": level, "message": message.into() }));
    }

    fn session(&self) -> Option<Arc<Session>> {
        self.0.state.lock().unwrap().session.clone()
    }

    // ------------------------------------------------------------ speech ---

    /// Load the model on a fresh worker, and wait until it says it's ready.
    async fn start_worker(&self, chosen: &str) -> Result<(), String> {
        let model = models::resolve(&self.0.models_dir, chosen)?;
        self.emit(json!({
            "type": "speech", "state": "loading",
            "modelPath": model.path.display().to_string(), "engine": model.engine, "label": model.label,
        }));

        let (ready_tx, ready_rx) = oneshot::channel::<Result<(), String>>();
        let ready_tx = Mutex::new(Some(ready_tx));
        let weak = Arc::downgrade(&self.0);
        let label = model.label.clone();
        let max_speakers = model.max_speakers;
        let speech = Speech::spawn(&model, self.0.resource_dir.as_deref(), move |out| {
            let Some(engine) = Weak::upgrade(&weak).map(Engine) else { return };
            match out {
                stt::Out::Ready { engine: name, engine_label, streaming, library_path, load_ms } => {
                    if let Some(tx) = ready_tx.lock().unwrap().take() {
                        let _ = tx.send(Ok(()));
                    }
                    engine.emit(json!({
                        "type": "speech", "state": "ready", "engine": name, "engineLabel": engine_label,
                        "streaming": streaming, "modelLabel": label, "maxSpeakers": max_speakers,
                        "libraryPath": library_path, "loadMs": load_ms as u64,
                    }));
                }
                stt::Out::Fatal(message) => match ready_tx.lock().unwrap().take() {
                    Some(tx) => {
                        let _ = tx.send(Err(message));
                    }
                    None => engine.worker_down(message),
                },
                stt::Out::Partial { user_id, text } => engine.emit_caption(&user_id, text, false),
                stt::Out::Final { user_id, text } => engine.emit_caption(&user_id, text, true),
                stt::Out::PartialCleared { user_id } => {
                    engine.emit(json!({ "type": "captionCleared", "userId": user_id }))
                }
                stt::Out::Error { user_id, message, fatal } => {
                    let who = user_id.as_deref().map(|u| engine.known_name(u).unwrap_or_else(|| u.to_string()));
                    let text = match who {
                        Some(w) => format!("[speech] {w}: {message}"),
                        None => format!("[speech] {message}"),
                    };
                    engine.log(if fatal { "error" } else { "warn" }, text);
                    if let (true, Some(u)) = (fatal, user_id) {
                        engine.0.route.lock().unwrap().capturing.remove(&u);
                        engine.emit(json!({ "type": "captionCleared", "userId": u }));
                    }
                }
                stt::Out::SpeakersChanged => {
                    let n = engine.live_count();
                    engine.emit(json!({ "type": "stats", "speakers": n }));
                }
            }
        });

        self.0.route.lock().unwrap().speech = Some(speech.sender());
        {
            let mut st = self.0.state.lock().unwrap();
            st.speech = Some(speech);
            st.speech_ready = false;
            st.model_name = model.label.split(" — ").next().unwrap_or("this model").to_string();
            st.max_speakers = max_speakers;
            st.warned_speaker_limit = false;
            st.model = Some(model.clone());
        }

        let outcome = match tokio::time::timeout(MODEL_LOAD_TIMEOUT, ready_rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("The speech engine stopped while loading.".to_string()),
            Err(_) => Err(format!(
                "The speech model at \"{}\" did not finish loading within {}s. It may be corrupt — \
                 remove it in the Speech model panel and download it again.",
                model.path.display(),
                MODEL_LOAD_TIMEOUT.as_secs()
            )),
        };
        match outcome {
            Ok(()) => {
                self.0.state.lock().unwrap().speech_ready = true;
                self.check_speaker_limit();
                Ok(())
            }
            Err(message) => {
                self.drop_worker();
                self.emit(json!({ "type": "speech", "state": "error", "message": message }));
                Err(message)
            }
        }
    }

    fn drop_worker(&self) {
        self.0.route.lock().unwrap().speech = None;
        let mut st = self.0.state.lock().unwrap();
        st.speech = None;
        st.speech_ready = false;
    }

    /// A worker that had been ready died mid-call. Restart it in place, with a
    /// budget — a silent blackout is the worst outcome, worse than a visible
    /// restart.
    fn worker_down(&self, reason: String) {
        let (attempt, model) = {
            let mut st = self.0.state.lock().unwrap();
            if st.stopping || st.speech.is_none() {
                return;
            }
            st.worker_restarts += 1;
            (st.worker_restarts, st.model.clone())
        };
        self.drop_worker();
        if attempt > MAX_WORKER_RESTARTS {
            self.emit(json!({ "type": "speech", "state": "error", "message": reason }));
            self.log(
                "error",
                format!(
                    "The speech engine has crashed {MAX_WORKER_RESTARTS} times ({reason}) — captions have stopped. \
                     Disconnect and connect again to restart it."
                ),
            );
            self.emit(json!({ "type": "status", "state": "error", "message": "Speech engine stopped — reconnect to restart captions." }));
            return;
        }
        self.log("warn", format!("Speech engine stopped ({reason}) — restarting (attempt {attempt}/{MAX_WORKER_RESTARTS})…"));
        let engine = self.clone();
        let path = model.map(|m| m.path.display().to_string()).unwrap_or_default();
        tokio::spawn(async move {
            match engine.start_worker(&path).await {
                Ok(()) => {
                    engine.log("info", "Speech engine restarted.");
                    // The fresh worker knows no speakers; add everyone back.
                    let route = engine.0.route.lock().unwrap();
                    if let Some(tx) = &route.speech {
                        for u in &route.capturing {
                            let _ = tx.send(stt::In::Add(u.clone()));
                        }
                    }
                }
                Err(e) => engine.worker_down(e),
            }
        });
    }

    fn emit_caption(&self, user_id: &str, text: String, is_final: bool) {
        let username = self.display_name(user_id).unwrap_or_else(|| "Unknown".into());
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        self.emit(json!({
            "type": "caption", "userId": user_id, "username": username,
            "text": text, "isFinal": is_final, "timestamp": timestamp,
        }));
    }

    /// Their name in this server, else their account name.
    fn display_name(&self, user_id: &str) -> Option<String> {
        if user_id == MIC_ID {
            return Some("Mic".into());
        }
        let session = self.session()?;
        let id = UserId::new(user_id.parse().ok()?);
        if let Some(guild_id) = self.0.state.lock().unwrap().guild_id {
            if let Some(guild) = session.cache.guild(guild_id) {
                if let Some(m) = guild.members.get(&id).or_else(|| guild.voice_states.get(&id).and_then(|v| v.member.as_ref())) {
                    return Some(m.display_name().to_string());
                }
            }
        }
        self.known_name(user_id)
    }

    fn known_name(&self, user_id: &str) -> Option<String> {
        if user_id == MIC_ID {
            return Some("Mic".into());
        }
        let session = self.session()?;
        let id = UserId::new(user_id.parse().ok()?);
        session.cache.user(id).map(|u| u.name.clone())
    }

    /// People switched on who can actually be heard this session.
    fn live_count(&self) -> usize {
        let st = self.0.state.lock().unwrap();
        let mut n = st.selected.len();
        if st.selected.contains(MIC_ID) && !st.mic_source {
            n -= 1;
        }
        if let Some(me) = &st.me {
            if st.selected.contains(me) && covered_by_mic(&st, me) {
                n -= 1;
            }
        }
        n
    }

    /// Say so when more people are on than the model can keep up with. Memory
    /// is not the limit — the model is shared — CPU is, and it runs out as
    /// captions arriving seconds after the words.
    fn check_speaker_limit(&self) {
        let live = self.live_count();
        let mut st = self.0.state.lock().unwrap();
        let Some(limit) = st.max_speakers else { return };
        if live as u64 <= limit {
            st.warned_speaker_limit = false;
            return;
        }
        if st.warned_speaker_limit {
            return;
        }
        st.warned_speaker_limit = true;
        let name = st.model_name.clone();
        drop(st);
        self.log(
            "warn",
            format!(
                "{live} speakers are on, but {name} is only comfortable with about {limit} at once on a typical CPU. \
                 Captions may start arriving late — switch to a lighter model or caption fewer people."
            ),
        );
    }

    // ----------------------------------------------------------- Discord ---

    /// Log in and stay logged in, without loading a model or joining anything,
    /// so the pickers can list servers and channels before one is chosen.
    /// Already signed in on this token, it just re-publishes the tree, which
    /// makes it the Refresh action too.
    pub async fn sign_in(&self, token: &str) -> Result<(), String> {
        let _one_at_a_time = self.0.signing_in.lock().await;
        if let Some(s) = self.session() {
            if s.token == token {
                self.emit_guilds(false);
                return Ok(());
            }
        }
        if token.is_empty() {
            return Err("No bot token provided.".into());
        }

        // A different token: the old session belongs to a bot we're about to
        // stop being, voice connection included.
        if let Some(old) = self.session() {
            self.leave(true).await;
            old.shards.shutdown_all().await;
            self.0.state.lock().unwrap().session = None;
        }

        self.emit(json!({ "type": "auth", "state": "signing-in", "message": "Signing in to Discord…" }));

        let fail = |engine: &Engine, message: String| {
            engine.emit(json!({ "type": "auth", "state": "error", "message": message }));
            Err(message)
        };

        let songbird = Songbird::serenity_from_config(
            songbird::Config::default()
                // Discord's Opus decodes straight to what the recognisers
                // want, so there's no resampling step.
                .decode_mode(DecodeMode::Decode(DecodeConfig::new(Channels::Mono, SampleRate::Hz16000))),
        );
        let (ready_tx, ready_rx) = oneshot::channel::<(String, String, UserId)>();
        let handler = Handler { engine: Arc::downgrade(&self.0), ready: Mutex::new(Some(ready_tx)) };

        // Non-privileged intents only. Voice-state payloads carry the member
        // object, so nobody has to enable "Server Members" in the portal, and
        // Guilds delivers the full channel list at login.
        let built = serenity::Client::builder(token, GatewayIntents::GUILDS | GatewayIntents::GUILD_VOICE_STATES)
            .event_handler(handler)
            .register_songbird_with(songbird.clone())
            .await;
        let mut client = match built {
            Ok(c) => c,
            Err(e) => return fail(self, e.to_string()),
        };
        let http = client.http.clone();
        let cache = client.cache.clone();
        let shards = client.shard_manager.clone();
        let (ended_tx, ended_rx) = oneshot::channel::<String>();
        tokio::spawn(async move {
            let ended = match client.start().await {
                Ok(()) => "The Discord connection closed.".to_string(),
                Err(serenity::Error::Gateway(serenity::gateway::GatewayError::InvalidAuthentication)) => {
                    "Discord rejected that token. Copy it again from the Bot page of the Developer Portal.".to_string()
                }
                Err(e) => e.to_string(),
            };
            let _ = ended_tx.send(ended);
        });

        let ready = tokio::select! {
            r = ready_rx => r.map_err(|_| "The Discord connection closed.".to_string()),
            e = ended_rx => Err(e.unwrap_or_else(|_| "The Discord connection closed.".to_string())),
            _ = tokio::time::sleep(GATEWAY_READY_TIMEOUT) => {
                Err(format!("Discord gateway connection timed out after {}s.", GATEWAY_READY_TIMEOUT.as_secs()))
            }
        };
        let (tag, app_id, bot_id) = match ready {
            Ok(r) => r,
            Err(message) => {
                shards.shutdown_all().await;
                return fail(self, message);
            }
        };

        self.0.state.lock().unwrap().session = Some(Arc::new(Session {
            token: token.to_string(),
            http,
            cache,
            shards,
            songbird,
            bot_id,
            app_id: app_id.clone(),
            tag: tag.clone(),
        }));
        self.emit(json!({
            "type": "auth", "state": "signed-in", "message": format!("Signed in as {tag}"),
            "botTag": tag, "botId": app_id,
        }));
        self.emit_guilds(false);
        Ok(())
    }

    /// Re-publish the tree after Discord says it changed, once per burst.
    fn guilds_changed(&self) {
        let burst = {
            let mut st = self.0.state.lock().unwrap();
            st.guild_burst += 1;
            st.guild_burst
        };
        let engine = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(GUILD_REFRESH_DEBOUNCE).await;
            if engine.0.state.lock().unwrap().guild_burst == burst {
                engine.emit_guilds(true);
            }
        });
    }

    /// Every voice channel the bot can see, grouped by server, with whether it
    /// could actually join each one. `auto` marks a refresh Discord caused
    /// rather than one somebody asked for, so the window can stay quiet.
    fn emit_guilds(&self, auto: bool) {
        let Some(s) = self.session() else { return };
        let mut guilds: Vec<Value> = s
            .cache
            .guilds()
            .into_iter()
            .filter_map(|id| {
                let guild = s.cache.guild(id)?;
                let mut channels: Vec<&GuildChannel> =
                    guild.channels.values().filter(|c| is_voice(c.kind)).collect();
                if channels.is_empty() {
                    return None;
                }
                channels.sort_by_key(|c| (c.position, c.id));
                Some(json!({
                    "id": id.to_string(),
                    "name": guild.name,
                    "channels": channels.iter().map(|c| describe_channel(&guild, c, s.bot_id)).collect::<Vec<_>>(),
                }))
            })
            .collect();
        guilds.sort_by(|a, b| {
            a["name"].as_str().unwrap_or("").to_lowercase().cmp(&b["name"].as_str().unwrap_or("").to_lowercase())
        });
        self.emit(json!({ "type": "guilds", "guilds": guilds, "botTag": s.tag, "botId": s.app_id, "auto": auto }));
    }

    /// Connect: sign in, load the model, join the channel. A failure anywhere
    /// after the model has loaded must not leave it in memory, or the next
    /// Connect loads a second copy beside it.
    pub async fn start(&self, token: Option<&str>, channel_id: &str, model_path: &str, source: &str) -> Result<(), String> {
        let result = self.start_inner(token, channel_id, model_path, source).await;
        if result.is_err() {
            self.leave(false).await;
        }
        result
    }

    async fn start_inner(&self, token: Option<&str>, channel_id: &str, model_path: &str, source: &str) -> Result<(), String> {
        {
            let mut st = self.0.state.lock().unwrap();
            st.mic_source = source == "mic" || source == "both";
            st.worker_restarts = 0;
        }
        // The mic on its own: no sign-in, no gateway, no network — nothing
        // here leaves the machine.
        if source == "mic" {
            self.start_worker(model_path).await?;
            self.emit(json!({ "type": "status", "state": "joined", "source": "mic", "message": "Listening to your mic" }));
            self.emit_members();
            self.sync_streams();
            return Ok(());
        }
        let channel: ChannelId = channel_id
            .parse::<u64>()
            .ok()
            .filter(|&n| n != 0)
            .map(ChannelId::new)
            .ok_or("No voice channel selected.")?;

        // Sign in before loading the model: a bad token then fails in a couple
        // of seconds instead of after a long model load. Usually a no-op.
        self.sign_in(token.unwrap_or_default()).await?;
        self.start_worker(model_path).await?;

        self.emit(json!({ "type": "status", "state": "connecting", "message": format!("Looking up channel {channel_id}…") }));
        let session = self.session().ok_or("Signed out while connecting.")?;
        let found = session
            .cache
            .guilds()
            .into_iter()
            .find_map(|g| session.cache.guild(g).and_then(|g| g.channels.get(&channel).cloned()));
        let found = match found {
            Some(c) => c,
            None => {
                let fetched = channel.to_channel(&session.http).await.ok().and_then(|c| c.guild());
                fetched.ok_or_else(|| {
                    format!("Could not find channel {channel_id}. Check the ID and that the bot is in that server.")
                })?
            }
        };
        if !is_voice(found.kind) {
            return Err(format!("Channel {channel_id} is not a voice channel."));
        }

        self.emit(json!({ "type": "status", "state": "connecting", "message": format!("Joining voice channel #{}…", found.name) }));
        let call = session.songbird.get_or_insert(found.guild_id);
        {
            let mut call = call.lock().await;
            // A deafened bot receives no audio at all; muted, it says nothing.
            let _ = call.deafen(false).await;
            let _ = call.mute(true).await;
            call.remove_all_global_events();
            let rx = Receiver(Arc::downgrade(&self.0));
            for ev in [CoreEvent::SpeakingStateUpdate, CoreEvent::VoiceTick, CoreEvent::DriverDisconnect] {
                call.add_global_event(ev.into(), rx.clone());
            }
        }
        {
            let mut st = self.0.state.lock().unwrap();
            st.guild_id = Some(found.guild_id);
            st.channel_id = Some(found.id);
        }
        let joined = tokio::time::timeout(JOIN_TIMEOUT, session.songbird.join(found.guild_id, found.id)).await;
        if !matches!(joined, Ok(Ok(_))) {
            return Err(format!(
                "Could not join #{} within {}s. Check the bot has \"View Channel\" and \"Connect\" on that channel, \
                 and that the channel isn't full.",
                found.name,
                JOIN_TIMEOUT.as_secs()
            ));
        }

        self.emit_joined();
        self.emit_members();
        // Anyone switched on before we joined starts capturing now.
        self.sync_streams();
        Ok(())
    }

    fn emit_joined(&self) {
        let Some(s) = self.session() else { return };
        let (guild_id, channel_id) = {
            let st = self.0.state.lock().unwrap();
            (st.guild_id, st.channel_id)
        };
        let (Some(guild_id), Some(channel_id)) = (guild_id, channel_id) else { return };
        let (guild_name, channel_name) = match s.cache.guild(guild_id) {
            Some(g) => (g.name.clone(), g.channels.get(&channel_id).map(|c| c.name.clone()).unwrap_or_default()),
            None => (String::new(), String::new()),
        };
        self.emit(json!({
            "type": "status", "state": "joined", "message": format!("Listening in #{channel_name}"),
            "channelId": channel_id.to_string(), "channelName": channel_name, "guildName": guild_name,
        }));
    }

    // ------------------------------------------------------- voice state ---

    /// Keep the member list live as people join, leave and move — the bot too.
    fn on_voice_state_update(&self, old: Option<VoiceState>, new: VoiceState) {
        let Some(s) = self.session() else { return };
        let (here, follow) = {
            let st = self.0.state.lock().unwrap();
            (st.channel_id, st.follow.clone())
        };
        let Some(here) = here else { return };
        if new.user_id == s.bot_id {
            return self.on_bot_moved(new);
        }
        let user = new.user_id.to_string();
        if follow.as_deref() == Some(user.as_str()) {
            self.follow(&s, &new);
        }
        let was_here = old.as_ref().and_then(|o| o.channel_id) == Some(here);
        let is_here = new.channel_id == Some(here);
        if !was_here && !is_here {
            return;
        }
        if was_here && !is_here {
            // Someone who left should stop consuming a recogniser.
            self.teardown_stream(&user);
        } else if is_here {
            // Someone switched on who left and came back picks up again.
            self.sync_streams();
        }
        self.emit_members();
    }

    /// A moderator can drag the bot to another channel or disconnect it; the
    /// call is wherever Discord says the bot is now, not where Connect put it.
    /// Songbird moves the voice connection itself.
    fn on_bot_moved(&self, state: VoiceState) {
        let Some(to) = state.channel_id else {
            let removed = {
                let st = self.0.state.lock().unwrap();
                !st.stopping && st.channel_id.is_some()
            };
            // Someone removed it on purpose: it must not rejoin against
            // their wishes.
            if removed {
                self.log("warn", "Someone in the server disconnected the bot from voice — not rejoining.");
                let engine = self.clone();
                tokio::spawn(async move { engine.end_call("The bot was disconnected from voice.").await });
            }
            return;
        };
        let from = {
            let mut st = self.0.state.lock().unwrap();
            if st.channel_id == Some(to) || st.channel_id.is_none() {
                return;
            }
            st.channel_id.replace(to)
        };
        let name = |c: Option<ChannelId>| {
            let s = self.session()?;
            let g = s.cache.guild(state.guild_id?)?;
            g.channels.get(&c?).map(|c| c.name.clone())
        };
        self.log("info", format!("Moved from #{} to #{}.", name(from).unwrap_or_default(), name(Some(to)).unwrap_or_default()));
        self.emit_joined();
        self.sync_streams();
        self.emit_members();
    }

    /// Follow mode: the followed person changed channel in this server, so
    /// the bot goes too. Never somewhere it can't hear — a stage puts it in
    /// the audience, which is silence.
    fn follow(&self, s: &Arc<Session>, state: &VoiceState) {
        let (Some(target), Some(guild_id)) = (state.channel_id, state.guild_id) else { return };
        {
            let st = self.0.state.lock().unwrap();
            if st.channel_id == Some(target) || st.guild_id != Some(guild_id) {
                return;
            }
        }
        let who = state.member.as_ref().map(|m| m.display_name().to_string()).unwrap_or_else(|| "them".into());
        let verdict = {
            let Some(guild) = s.cache.guild(guild_id) else { return };
            let Some(channel) = guild.channels.get(&target) else { return };
            describe_channel(&guild, channel, s.bot_id)
        };
        let name = verdict["name"].as_str().unwrap_or("").to_string();
        if verdict["stage"] == true || verdict["canJoin"] == false {
            self.log(
                "warn",
                format!(
                    "{who} went to #{name}, but the bot {} — staying put.",
                    if verdict["stage"] == true { "would only be audience on a stage" } else { "isn’t allowed in there" }
                ),
            );
            return;
        }
        self.log("info", format!("Following {who} to #{name}…"));
        let songbird = s.songbird.clone();
        tokio::spawn(async move {
            let _ = songbird.join(guild_id, target).await;
        });
    }

    pub fn set_follow(&self, user_id: Option<String>) {
        self.0.state.lock().unwrap().follow = user_id;
        self.emit_members();
    }

    /// The voice connection dropped and Songbird could not bring it back.
    /// Rejoin a few times before giving up — a silent blackout mid-stream is
    /// the worst outcome there is.
    fn on_driver_disconnect(&self, reason: Option<DisconnectReason>) {
        // None is a disconnect we asked for: leaving, or moving channel.
        if reason.is_none() || matches!(reason, Some(DisconnectReason::Requested)) {
            return;
        }
        {
            let mut st = self.0.state.lock().unwrap();
            if st.stopping || st.recovering || st.channel_id.is_none() {
                return;
            }
            st.recovering = true;
        }
        let engine = self.clone();
        tokio::spawn(async move {
            engine.log("warn", "Voice connection dropped — rejoining…");
            let back = engine.rejoin_voice().await;
            engine.0.state.lock().unwrap().recovering = false;
            if back {
                engine.log("info", "Back in voice.");
                engine.emit_joined();
                engine.emit_members();
            } else if engine.0.state.lock().unwrap().channel_id.is_some() {
                engine.log("error", "Could not get back into voice — captions have stopped.");
                engine.end_call("Voice disconnected.").await;
            }
        });
    }

    async fn rejoin_voice(&self) -> bool {
        for (i, wait) in VOICE_REJOIN_DELAYS.iter().enumerate() {
            self.emit(json!({
                "type": "status", "state": "connecting",
                "message": format!("Voice dropped — rejoining (attempt {}/{})…", i + 1, VOICE_REJOIN_DELAYS.len()),
            }));
            tokio::time::sleep(Duration::from_secs(*wait)).await;
            let (Some(s), Some(g), Some(c)) = (self.session(), self.0.state.lock().unwrap().guild_id, self.0.state.lock().unwrap().channel_id) else {
                return false;
            };
            if self.0.state.lock().unwrap().stopping {
                return false;
            }
            if let Ok(Ok(_)) = tokio::time::timeout(JOIN_TIMEOUT, s.songbird.join(g, c)).await {
                return true;
            }
        }
        false
    }

    /// Give up on the call: free the model, and say why.
    async fn end_call(&self, message: &str) {
        self.leave(false).await;
        self.emit(json!({ "type": "status", "state": "disconnected", "message": message }));
    }

    /// Everyone who can be captioned: the mic first when it's a source, then
    /// everyone in the voice channel except the bot itself.
    pub fn emit_members(&self) {
        let (in_call, mic_source, mic_selected) = {
            let st = self.0.state.lock().unwrap();
            (st.channel_id.is_some(), st.mic_source, st.selected.contains(MIC_ID))
        };
        if !in_call && !mic_source {
            return;
        }
        let mut members = self.call_members();
        if mic_source {
            members.insert(
                0,
                json!({
                    "id": MIC_ID, "username": "mic", "displayName": "Mic", "bot": false,
                    "local": true, "selected": mic_selected, "followed": false,
                }),
            );
        }
        self.emit(json!({ "type": "members", "members": members }));
    }

    fn call_members(&self) -> Vec<Value> {
        let Some(s) = self.session() else { return Vec::new() };
        let (guild_id, channel_id, selected, follow, me) = {
            let st = self.0.state.lock().unwrap();
            (st.guild_id, st.channel_id, st.selected.clone(), st.follow.clone(), st.me.clone())
        };
        let (Some(guild_id), Some(channel_id)) = (guild_id, channel_id) else { return Vec::new() };
        let mut members: Vec<Value> = {
            let st = self.0.state.lock().unwrap();
            let Some(guild) = s.cache.guild(guild_id) else { return Vec::new() };
            guild
                .voice_states
                .values()
                .filter(|v| v.channel_id == Some(channel_id) && v.user_id != s.bot_id)
                .map(|v| {
                    let id = v.user_id.to_string();
                    let member = guild.members.get(&v.user_id).or(v.member.as_ref());
                    let user = member.map(|m| m.user.clone()).or_else(|| s.cache.user(v.user_id).map(|u| u.clone()));
                    let username = user.as_ref().map(|u| u.name.clone()).unwrap_or_else(|| id.clone());
                    let display = member.map(|m| m.display_name().to_string()).unwrap_or_else(|| username.clone());
                    json!({
                        "id": id,
                        "username": username,
                        "displayName": display,
                        "bot": user.as_ref().is_some_and(|u| u.bot),
                        "selected": selected.contains(&id),
                        "followed": follow.as_deref() == Some(id.as_str()),
                        "me": me.as_deref() == Some(id.as_str()),
                        "coveredByMic": covered_by_mic(&st, &id),
                    })
                })
                .collect()
        };
        members.sort_by(|a, b| {
            a["displayName"].as_str().unwrap_or("").to_lowercase().cmp(&b["displayName"].as_str().unwrap_or("").to_lowercase())
        });
        members
    }

    // ------------------------------------------------ per-speaker capture ---

    /// Capture exactly who should be captured: switched on, in the channel,
    /// and not the streamer while their mic covers them.
    fn sync_streams(&self) {
        let session = self.session();
        let (want, ready, gate) = {
            let st = self.0.state.lock().unwrap();
            let in_channel: HashSet<String> = match (&session, st.guild_id, st.channel_id) {
                (Some(s), Some(g), Some(c)) => s
                    .cache
                    .guild(g)
                    .map(|g| g.voice_states.values().filter(|v| v.channel_id == Some(c)).map(|v| v.user_id.to_string()).collect())
                    .unwrap_or_default(),
                _ => HashSet::new(),
            };
            let want: HashSet<String> = st
                .selected
                .iter()
                .filter(|u| if *u == MIC_ID { st.mic_source } else { in_channel.contains(*u) && !covered_by_mic(&st, u) })
                .cloned()
                .collect();
            (want, st.speech_ready, st.mic_gate)
        };
        if !ready {
            return;
        }
        let mut route = self.0.route.lock().unwrap();
        let Some(tx) = route.speech.clone() else { return };
        let stale: Vec<String> = route.capturing.difference(&want).cloned().collect();
        for u in stale {
            route.capturing.remove(&u);
            if u == MIC_ID {
                route.mic = None;
            }
            let _ = tx.send(stt::In::Remove(u));
        }
        for u in want {
            if route.capturing.insert(u.clone()) {
                // The window captures the mic and sends it in; the gate is
                // what lets that audio through.
                if u == MIC_ID {
                    route.mic = Some(MicGate::new(gate.0, gate.1));
                }
                let _ = tx.send(stt::In::Add(u.clone()));
                drop(route);
                let who = if u == MIC_ID { "your mic".to_string() } else { self.known_name(&u).unwrap_or_else(|| u.clone()) };
                self.log("info", format!("Capturing audio for {who}"));
                route = self.0.route.lock().unwrap();
            }
        }
    }

    /// The mic gate's sliders: sensitivity 1–10, and the pause that ends a
    /// caption.
    pub fn set_mic_gate(&self, sensitivity: f64, hang_ms: f64) {
        self.0.state.lock().unwrap().mic_gate = (sensitivity, hang_ms);
        if let Some(gate) = self.0.route.lock().unwrap().mic.as_mut() {
            gate.configure(sensitivity, hang_ms);
        }
    }

    /// 16 kHz mono PCM from the window's microphone. Only the parts with
    /// someone talking reach the model, and a pause ends the utterance, as
    /// Discord's speaking end does for everyone else.
    pub fn mic_audio(&self, bytes: &[u8]) {
        let pcm: Vec<i16> = bytes.chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]])).collect();
        let mut route = self.0.route.lock().unwrap();
        let Some(tx) = route.speech.clone() else { return };
        let Some(gate) = route.mic.as_mut() else { return };
        let gated = gate.push(&pcm);
        for frame in gated.voiced {
            let _ = tx.send(stt::In::Audio(MIC_ID.into(), frame));
        }
        if gated.ended {
            let _ = tx.send(stt::In::Flush(MIC_ID.into()));
        }
    }

    fn teardown_stream(&self, user_id: &str) {
        let mut route = self.0.route.lock().unwrap();
        if route.capturing.remove(user_id) {
            if let Some(tx) = &route.speech {
                let _ = tx.send(stt::In::Remove(user_id.to_string()));
            }
        }
    }

    /// Live toggle. Safe to call at any time, including mid-call.
    pub fn set_selected(&self, user_ids: Vec<String>) {
        self.0.state.lock().unwrap().selected = user_ids.into_iter().collect();
        self.sync_streams();
        self.emit_members();
        self.check_speaker_limit();
        let n = self.live_count();
        self.emit(json!({ "type": "stats", "speakers": n }));
    }

    /// Mark which Discord member is the streamer, or nobody.
    pub fn set_me(&self, user_id: Option<String>) {
        self.0.state.lock().unwrap().me = user_id;
        self.sync_streams();
        self.emit_members();
        let n = self.live_count();
        self.emit(json!({ "type": "stats", "speakers": n }));
    }

    // ---------------------------------------------------------- teardown ---

    /// Leave the voice channel and free the model, but stay signed in: the
    /// pickers are built from the signed-in session, and emptying them on
    /// every Disconnect would make the app look broken.
    pub async fn leave(&self, announce: bool) {
        let (session, guild) = {
            let mut st = self.0.state.lock().unwrap();
            st.stopping = true;
            (st.session.clone(), st.guild_id.take())
        };
        {
            let mut route = self.0.route.lock().unwrap();
            route.capturing.clear();
            route.quiet_ticks.clear();
            route.speech = None;
            route.mic = None;
        }
        if let (Some(s), Some(g)) = (session, guild) {
            let _ = s.songbird.remove(g).await;
        }
        {
            let mut st = self.0.state.lock().unwrap();
            st.speech = None;
            st.speech_ready = false;
            st.model = None;
            st.worker_restarts = 0;
            st.channel_id = None;
            st.warned_speaker_limit = false;
            st.mic_source = false;
            st.stopping = false;
        }
        if announce {
            self.emit(json!({ "type": "status", "state": "stopped", "message": "Stopped." }));
        }
    }

    /// Full teardown including the Discord session — for quitting.
    pub async fn shutdown(&self) {
        self.leave(false).await;
        let session = self.0.state.lock().unwrap().session.take();
        if let Some(s) = session {
            s.shards.shutdown_all().await;
        }
    }
}

fn covered_by_mic(st: &State, user_id: &str) -> bool {
    st.me.as_deref() == Some(user_id) && st.mic_source && st.selected.contains(MIC_ID)
}

fn is_voice(kind: ChannelType) -> bool {
    matches!(kind, ChannelType::Voice | ChannelType::Stage)
}

fn describe_channel(guild: &Guild, channel: &GuildChannel, bot_id: UserId) -> Value {
    let stage = channel.kind == ChannelType::Stage;
    // Without the bot's own member cached the verdict is "unknown", never
    // "can't join" — greying out a channel that works would be worse than no
    // verdict at all.
    let perms = guild.members.get(&bot_id).map(|me| guild.user_permissions_in(channel, me));
    let (can_join, reason) = match perms {
        None => (Value::Null, String::new()),
        Some(p) => {
            let mut missing = Vec::new();
            if !p.contains(Permissions::VIEW_CHANNEL) {
                missing.push("View Channel");
            }
            if !p.contains(Permissions::CONNECT) {
                missing.push("Connect");
            }
            let reason =
                if missing.is_empty() { String::new() } else { format!("Bot is missing {} here", missing.join(" and ")) };
            (json!(missing.is_empty()), reason)
        }
    };
    let occupants = guild.voice_states.values().filter(|v| v.channel_id == Some(channel.id)).count() as u32;
    let limit = channel.user_limit.unwrap_or(0);
    // Bots are subject to the user limit unless they can move members.
    let full = !stage && limit > 0 && occupants >= limit && !perms.is_some_and(|p| p.contains(Permissions::MOVE_MEMBERS));
    json!({
        "id": channel.id.to_string(), "name": channel.name, "stage": stage,
        "canJoin": can_join, "reason": reason, "full": full,
    })
}

// ------------------------------------------------------------- gateway ---

struct Handler {
    engine: Weak<Inner>,
    ready: Mutex<Option<oneshot::Sender<(String, String, UserId)>>>,
}

impl Handler {
    fn engine(&self) -> Option<Engine> {
        self.engine.upgrade().map(Engine)
    }
}

#[async_trait]
impl EventHandler for Handler {
    async fn ready(&self, _ctx: Context, ready: Ready) {
        if let Some(tx) = self.ready.lock().unwrap().take() {
            // The invite link wants the application's id. For any bot made in
            // recent years that's the bot user's own id, but the oldest differ.
            let _ = tx.send((ready.user.tag(), ready.application.id.to_string(), ready.user.id));
        }
    }

    async fn guild_create(&self, _: Context, _: Guild, _: Option<bool>) {
        if let Some(e) = self.engine() {
            e.guilds_changed();
        }
    }

    async fn guild_delete(&self, _: Context, _: UnavailableGuild, _: Option<Guild>) {
        if let Some(e) = self.engine() {
            e.guilds_changed();
        }
    }

    async fn guild_update(&self, _: Context, _: Option<Guild>, _: PartialGuild) {
        if let Some(e) = self.engine() {
            e.guilds_changed();
        }
    }

    async fn channel_create(&self, _: Context, _: GuildChannel) {
        if let Some(e) = self.engine() {
            e.guilds_changed();
        }
    }

    /// Covers permission overwrites, which is how a greyed-out "no access"
    /// channel becomes joinable.
    async fn channel_update(&self, _: Context, _: Option<GuildChannel>, _: GuildChannel) {
        if let Some(e) = self.engine() {
            e.guilds_changed();
        }
    }

    async fn channel_delete(&self, _: Context, _: GuildChannel, _: Option<Vec<DiscordMessage>>) {
        if let Some(e) = self.engine() {
            e.guilds_changed();
        }
    }

    async fn voice_state_update(&self, _: Context, old: Option<VoiceState>, new: VoiceState) {
        if let Some(e) = self.engine() {
            e.on_voice_state_update(old, new);
        }
    }
}

// --------------------------------------------------------------- voice ---

#[derive(Clone)]
struct Receiver(Weak<Inner>);

#[async_trait]
impl VoiceEventHandler for Receiver {
    async fn act(&self, ctx: &EventContext<'_>) -> Option<Event> {
        let inner = self.0.upgrade()?;
        match ctx {
            EventContext::SpeakingStateUpdate(s) => {
                if let Some(user) = s.user_id {
                    inner.route.lock().unwrap().ssrc_users.insert(s.ssrc, user.0.to_string());
                }
            }
            EventContext::VoiceTick(tick) => {
                let mut route = inner.route.lock().unwrap();
                let Some(tx) = route.speech.clone() else { return None };
                for (ssrc, data) in &tick.speaking {
                    route.quiet_ticks.insert(*ssrc, 0);
                    let Some(user) = route.ssrc_users.get(ssrc) else { continue };
                    if !route.capturing.contains(user) {
                        continue;
                    }
                    if let Some(pcm) = data.decoded_voice.as_ref().filter(|p| !p.is_empty()) {
                        let _ = tx.send(stt::In::Audio(user.clone(), pcm.clone()));
                    }
                }
                // Discord sends nothing while someone is quiet, so the end of
                // an utterance is packets stopping. That's the best evidence of
                // where one ends, and it makes the last words appear without
                // waiting for a packet that may never come.
                let mut ended = Vec::new();
                for ssrc in &tick.silent {
                    if let Some(n) = route.quiet_ticks.get_mut(ssrc) {
                        *n += 1;
                        if *n >= SPEAKING_END_TICKS {
                            route.quiet_ticks.remove(ssrc);
                            ended.push(*ssrc);
                        }
                    }
                }
                for ssrc in ended {
                    if let Some(user) = route.ssrc_users.get(&ssrc).filter(|u| route.capturing.contains(*u)) {
                        let _ = tx.send(stt::In::Flush(user.clone()));
                    }
                }
            }
            EventContext::DriverDisconnect(d) => Engine(inner).on_driver_disconnect(d.reason),
            _ => {}
        }
        None
    }
}
