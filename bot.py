import sys
import os
import time
import asyncio
import re
import discord
from discord.ext import commands, tasks

# Inject parent path dynamically to resolve both local Windows ("Music bot") and VPS ("gameoverbotmusic") directories
_parent_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_tg_bot_folder = "gameoverbotmusic" if os.path.exists(os.path.join(_parent_dir, "gameoverbotmusic")) else "Music bot"
sys.path.append(os.path.join(_parent_dir, _tg_bot_folder))
print(f"[Bot] Resolved and appended Music Bot core library path: {os.path.join(_parent_dir, _tg_bot_folder)}")

# Import configurations
import config

# Setup Intents
intents = discord.Intents.default()
intents.message_content = True
intents.voice_states = True

bot = commands.Bot(command_prefix=config.COMMAND_PREFIX, intents=intents)

# Active streams tracker: {guild_id: {"process": subprocess, "channel_id": channel_id, "movie_name": name}}
active_streams = {}

# ─── Shared Scraper & Downloader Imports ─────────────────────────────────────
try:
    from core.vod_scraper import Session, search_vod, resolve_stream_link, fetch_tv_details, SubjectType
    from core.downloader import download_song
    from core.queue_manager import SongInfo
except ImportError as imp_err:
    print(f"❌ Failed to load shared downloader/scraper components from Music bot folder: {imp_err}")
    sys.exit(1)

# ─── Local DB Resume Progress Imports ────────────────────────────────────────
from core.db import get_vod_progress, set_vod_progress, clear_vod_progress


async def kill_process_tree(proc):
    """Gracefully terminate a process and await exit."""
    if not proc:
        return
    try:
        proc.terminate() # SIGTERM
        await proc.wait()
    except Exception:
        try:
            proc.kill() # SIGKILL fallback
            await proc.wait()
        except Exception:
            pass

async def monitor_stream_process(guild_id: int, proc: asyncio.subprocess.Process, subject_id: int, title: str, season: int, episode: int, force_seek: int):
    """Monitors Node.js streamer process, updates database progress periodically, and cleans up on exit."""
    start_time = time.time()

    # Progress saving background loop (every 5 seconds)
    async def progress_tracker():
        try:
            while proc.returncode is None:
                await asyncio.sleep(5)
                elapsed = int(time.time() - start_time) + force_seek
                if elapsed > 0:
                    set_vod_progress(guild_id, subject_id, title, season, episode, elapsed)
        except asyncio.CancelledError:
            pass
        except Exception as e:
            print(f"[Bot] Progress tracking error for guild {guild_id}: {e}")

    tracker_task = asyncio.create_task(progress_tracker())

    # Process logs logging
    async def log_stream(stream, prefix):
        while True:
            line = await stream.readline()
            if not line:
                break
            print(f"{prefix}: {line.decode('utf-8').strip()}")

    stdout_task = asyncio.create_task(log_stream(proc.stdout, f"[NodeJS Guild {guild_id} Out]"))
    stderr_task = asyncio.create_task(log_stream(proc.stderr, f"[NodeJS Guild {guild_id} Err]"))

    await proc.wait()
    tracker_task.cancel()
    stdout_task.cancel()
    stderr_task.cancel()

    # Clean up active state
    if guild_id in active_streams and active_streams[guild_id]["process"] == proc:
        active_streams.pop(guild_id, None)
        print(f"[Bot] Subprocess streamer exited for guild {guild_id}.")


@bot.event
async def on_ready():
    print(f"=========================================")
    print(f"🎬 Discord Live Cinema Controller Active")
    print(f"Logged in as bot account: {bot.user}")
    print(f"Shared cache folder: {config.Config.DOWNLOADS_DIR}")
    print(f"Streamer process script: {config.STREAMER_JS_PATH}")
    print(f"=========================================")
    
    try:
        synced = await bot.tree.sync()
        print(f"Successfully synced {len(synced)} Slash command application triggers.")
    except Exception as e:
        print(f"Slash command synchronization failed: {e}")
        
    if not auto_disconnect_check.is_running():
        auto_disconnect_check.start()
    if not auto_cleanup_cache_files.is_running():
        auto_cleanup_cache_files.start()


@bot.event
async def on_voice_state_update(member, before, after):
    """Voice status update listener. Instantly closes streams in empty channels."""
    if member.bot:
        return
    
    guild_id = member.guild.id
    if guild_id in active_streams:
        stream = active_streams[guild_id]
        channel_id = stream["channel_id"]
        
        if before.channel and before.channel.id == channel_id:
            humans = [m for m in before.channel.members if not m.bot]
            if len(humans) == 0:
                print(f"[Bot] Voice Channel {channel_id} is empty. Auto-terminating stream.")
                proc = stream["process"]
                asyncio.create_task(kill_process_tree(proc))


@tasks.loop(seconds=15)
async def auto_disconnect_check():
    """Verify if streaming channels are empty and terminate streamer."""
    for guild_id, stream_info in list(active_streams.items()):
        guild = bot.get_guild(guild_id)
        if not guild:
            continue
            
        channel = guild.get_channel(stream_info["channel_id"])
        if not channel:
            print(f"[Bot] Target VC deleted in guild {guild_id}. Stopping stream.")
            await kill_process_tree(stream_info["process"])
            continue
            
        humans = [m for m in channel.members if not m.bot]
        if len(humans) == 0:
            print(f"[Bot] Periodic check: Channel {channel.id} is empty. Shutting stream down.")
            await kill_process_tree(stream_info["process"])


@tasks.loop(minutes=30)
async def auto_cleanup_cache_files():
    """Scans the shared downloads directory and deletes cached video files older than 24 hours."""
    downloads_dir = config.Config.DOWNLOADS_DIR
    if not downloads_dir or not os.path.exists(downloads_dir):
        return
        
    print(f"[Garbage Collector] Scanning cache directory: {downloads_dir}")
    now = time.time()
    deleted_count = 0
    
    try:
        for filename in os.listdir(downloads_dir):
            if filename.endswith(".mp4") or filename.endswith(".mkv"):
                filepath = os.path.join(downloads_dir, filename)
                mtime = os.path.getmtime(filepath)
                age_seconds = now - mtime
                if age_seconds > 86400:
                    try:
                        os.remove(filepath)
                        deleted_count += 1
                        print(f"[Garbage Collector] Deleted expired cache file: {filename} (Age: {age_seconds/3600:.1f} hours)")
                    except Exception as remove_err:
                        print(f"[Garbage Collector] Failed to delete {filename}: {remove_err}")
                        
        if deleted_count > 0:
            print(f"[Garbage Collector] Successfully cleaned up {deleted_count} expired video file(s).")
    except Exception as scan_err:
        print(f"[Garbage Collector] Error scanning directory: {scan_err}")


# ─── Resume Playback Interactive UI View ──────────────────────────────────────
class ResumePromptView(discord.ui.View):
    def __init__(self, author_id: int, on_resume, on_startover):
        super().__init__(timeout=60.0)
        self.author_id = author_id
        self.on_resume = on_resume
        self.on_startover = on_startover

    @discord.ui.button(label="▶️ RESUME PLAY", style=discord.ButtonStyle.green)
    async def resume(self, interaction: discord.Interaction, button: discord.ui.Button):
        if interaction.user.id != self.author_id:
            await interaction.response.send_message("⚠️ Only the requester can click this button!", ephemeral=True)
            return
        self.stop()
        await interaction.response.defer()
        await self.on_resume(interaction)

    @discord.ui.button(label="🔄 START OVER", style=discord.ButtonStyle.red)
    async def startover(self, interaction: discord.Interaction, button: discord.ui.Button):
        if interaction.user.id != self.author_id:
            await interaction.response.send_message("⚠️ Only the requester can click this button!", ephemeral=True)
            return
        self.stop()
        await interaction.response.defer()
        await self.on_startover(interaction)


# ─── Season Selection View ────────────────────────────────────────────────────
class SeasonSelectionView(discord.ui.View):
    def __init__(self, author_id: int, title: str, seasons: list, on_season_selected):
        super().__init__(timeout=120.0)
        self.author_id = author_id
        self.title = title
        self.seasons = seasons
        self.on_season_selected = on_season_selected

        for s in seasons[:25]:
            button = discord.ui.Button(
                label=f"Season {s.se}",
                style=discord.ButtonStyle.green,
                custom_id=f"season_{s.se}"
            )
            button.callback = self.make_callback(s.se)
            self.add_item(button)

    def make_callback(self, season_num: int):
        async def callback(interaction: discord.Interaction):
            if interaction.user.id != self.author_id:
                await interaction.response.send_message("⚠️ Only the requester can select seasons!", ephemeral=True)
                return
            self.stop()
            await interaction.response.defer()
            await self.on_season_selected(interaction, season_num)
        return callback


# ─── Episode Selection View ───────────────────────────────────────────────────
class EpisodeSelectionView(discord.ui.View):
    def __init__(self, author_id: int, title: str, season_num: int, max_episodes: int, on_episode_selected, on_back):
        super().__init__(timeout=120.0)
        self.author_id = author_id
        self.title = title
        self.season_num = season_num
        self.max_episodes = max_episodes
        self.on_episode_selected = on_episode_selected
        self.on_back = on_back

        if max_episodes > 0:
            select = discord.ui.Select(
                placeholder=f"Select Episode (1-{min(max_episodes, 25)})...",
                options=[
                    discord.SelectOption(label=f"Episode {ep}", value=str(ep), description=f"Play Season {season_num} Episode {ep}")
                    for ep in range(1, min(max_episodes, 25) + 1)
                ]
            )
            select.callback = self.select_callback
            self.add_item(select)

        back_btn = discord.ui.Button(label="◀️ Back to Seasons", style=discord.ButtonStyle.red, row=1 if max_episodes > 0 else 0)
        back_btn.callback = self.back_callback
        self.add_item(back_btn)

    async def select_callback(self, interaction: discord.Interaction):
        if interaction.user.id != self.author_id:
            await interaction.response.send_message("⚠️ Only the requester can select episodes!", ephemeral=True)
            return
        self.stop()
        await interaction.response.defer()
        selected_ep = int(interaction.data["values"][0])
        await self.on_episode_selected(interaction, selected_ep)

    async def back_callback(self, interaction: discord.Interaction):
        if interaction.user.id != self.author_id:
            await interaction.response.send_message("⚠️ Only the requester can navigate!", ephemeral=True)
            return
        self.stop()
        await interaction.response.defer()
        await self.on_back(interaction)


# ─── Bot Commands ─────────────────────────────────────────────────────────────

# 1. PLAY COMMAND
@bot.hybrid_command(name="play", description="Search and stream a VOD movie or TV show episode.")
async def play_cinema(ctx: commands.Context, query: str):
    # Ensure user is in VC
    if not ctx.author.voice or not ctx.author.voice.channel:
        await ctx.send("❌ **You must join a Voice Channel first to stream cinema!**")
        return
        
    guild_id = ctx.guild.id
    channel = ctx.author.voice.channel
    
    # ── Parse Season & Episode from Query ──
    match = re.search(r'S(\d+)\s*E(\d+)', query, re.IGNORECASE)
    if match:
        season = int(match.group(1))
        episode = int(match.group(2))
        search_query = re.sub(r'S\d+\s*E\d+', '', query, flags=re.IGNORECASE).strip()
    else:
        season = 0
        episode = 0
        search_query = query.strip()

    status_msg = await ctx.send(f"🔍 **Searching MovieBox VOD Database for:** `{search_query}`...")
    
    try:
        # Search VOD
        items = await search_vod(search_query, language="hi") # Default to Hindi first
        if not items:
            await status_msg.edit(content=f"❌ **No results found for:** `{search_query}`")
            return
            
        current_item = items[0]
        subject_id = int(current_item.subjectId)
        clean_title = current_item.title.replace("[Hindi]", "").replace("[English]", "").strip()
        
        # Check if TV Series
        is_series = current_item.subjectType == SubjectType.TV_SERIES or int(getattr(current_item, "subjectType", 1)) == 2
        
        # Check if saved progress exists in database
        saved_progress = get_vod_progress(guild_id, subject_id, season, episode)
        
        # Playback logic execution wrapped as functions for the resume prompt view
        async def start_playback(interaction_or_ctx, force_seek_secs: int = -1):
            target_msg = status_msg
            if isinstance(interaction_or_ctx, discord.Interaction):
                # Update message to fetching status
                await target_msg.edit(content=f"🎬 **Fetching Stream Link...**\n⏳ *Server connection is being established...*", view=None)
            else:
                await target_msg.edit(content=f"🎬 **Fetching Stream Link...**\n⏳ *Server connection is being established...*")

            try:
                # Resolve link
                session = Session()
                result = await resolve_stream_link(session, current_item, season=season, episode=episode)
                
                title_suffix = f" S{season}E{episode}" if season > 0 else ""
                display_title = f"{clean_title}{title_suffix}"
                
                # Setup SongInfo structure compatible with downloader
                song = SongInfo(
                    title=display_title,
                    video_url=result["url"],
                    audio_url=result["url"],
                    thumbnail="",
                    duration="VOD",
                    duration_secs=0,
                    webpage_url=result["url"],
                    uploader="MOVIES Engine",
                    requested_by=ctx.author.name,
                    quality="720",
                    requester_id=ctx.author.id
                )
                
                # Check if file is already cached, or show download progress
                last_edit = [0.0]
                async def download_progress(pct, downloaded, total_size):
                    now = time.time()
                    if now - last_edit[0] >= 3.5 or pct == 100:
                        last_edit[0] = now
                        down_mb = downloaded / (1024 * 1024)
                        if total_size > 0:
                            tot_mb = total_size / (1024 * 1024)
                            filled = int(pct / 10)
                            bar = "■" * filled + "□" * (10 - filled)
                            await target_msg.edit(content=f"📥 **Downloading Movie Cache to VPS:**\n🎬 `{display_title}`\n`[{bar}] {pct}%` ({down_mb:.1f} MB / {tot_mb:.1f} MB)")
                        else:
                            await target_msg.edit(content=f"📥 **Downloading Movie Cache to VPS:**\n🎬 `{display_title}`\n`[📥 DOWNLOADING...]` ({down_mb:.1f} MB)")

                # Execute cache download
                local_file = await download_song(song, mode="video", progress_callback=download_progress)
                if not local_file or not os.path.exists(local_file):
                    await target_msg.edit(content="❌ **Error:** Downloader engine failed to cache VOD track.")
                    return
                
                # Stop existing stream if playing
                if guild_id in active_streams:
                    await kill_process_tree(active_streams[guild_id]["process"])
                
                # Launch WebRTC streamer worker process
                env = os.environ.copy()
                env["DISCORD_STREAMER_TOKEN"] = config.STREAMER_TOKEN
                
                proc = await asyncio.create_subprocess_exec(
                    "node",
                    config.STREAMER_JS_PATH,
                    str(guild_id),
                    str(channel.id),
                    local_file,
                    env=env,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE
                )
                
                # Track seeking position
                seek_offset = force_seek_secs if force_seek_secs >= 0 else 0
                
                active_streams[guild_id] = {
                    "process": proc,
                    "channel_id": channel.id,
                    "movie_name": display_title
                }
                
                # Start monitor loop
                asyncio.create_task(monitor_stream_process(guild_id, proc, subject_id, clean_title, season, episode, seek_offset))
                
                seek_notice = f" (Starting from `{seek_offset}s` position)" if seek_offset > 0 else ""
                await target_msg.edit(content=f"🎥 **Go Live Cinema Stream is Active!**\n🍿 **Now playing:** `{display_title}`{seek_notice} inside Voice Channel **{channel.name}**.")

            except Exception as play_err:
                print(f"[Bot Play] Playback setup crashed: {play_err}")
                await target_msg.edit(content=f"❌ **Error playing movie:** {play_err}")

        # If TV Show, present Seasons and Episodes Selection View
        if is_series and season == 0 and episode == 0:
            session = Session()
            details = await fetch_tv_details(session, current_item)
            if not details or not details.resource or not details.resource.seasons:
                await status_msg.edit(content=f"❌ **Failed to fetch TV details for:** `{clean_title}`")
                return
            
            seasons = details.resource.seasons
            
            async def on_season_selected(interaction: discord.Interaction, chosen_season: int):
                max_ep = 1
                for s in seasons:
                    if s.se == chosen_season:
                        max_ep = s.maxEp
                        break
                
                async def on_episode_selected(ep_interaction: discord.Interaction, chosen_episode: int):
                    nonlocal season, episode
                    season = chosen_season
                    episode = chosen_episode
                    
                    ep_saved_progress = get_vod_progress(guild_id, subject_id, chosen_season, chosen_episode)
                    if ep_saved_progress and ep_saved_progress > 10:
                        from plugins.controls import format_seconds
                        pos_str = format_seconds(ep_saved_progress)
                        display_title = f"{clean_title} S{chosen_season}E{chosen_episode}"
                        
                        async def on_resume(resume_interaction):
                            await start_playback(resume_interaction, force_seek_secs=ep_saved_progress)
                            
                        async def on_startover(startover_interaction):
                            clear_vod_progress(guild_id, subject_id, chosen_season, chosen_episode)
                            await start_playback(startover_interaction, force_seek_secs=0)
                            
                        view = ResumePromptView(ctx.author.id, on_resume, on_startover)
                        await status_msg.edit(
                            content=f"⚠️ **SAVED PROGRESS FOUND!**\n\n🎬 **Title:** `{display_title}`\n⏱ **Saved Position:** `{pos_str}`\n\nKya aap is position se **Resume** karna chahte hain ya shuru se **Start Over**?",
                            view=view
                        )
                    else:
                        await start_playback(ep_interaction, force_seek_secs=0)
                
                async def on_back(back_interaction):
                    seasons_view = SeasonSelectionView(ctx.author.id, clean_title, seasons, on_season_selected)
                    await status_msg.edit(
                        content=f"📺 **{clean_title}** ke kul `{len(seasons)} seasons` hain.\n\nNeeche se watch karne ke liye **Season** select karein:",
                        view=seasons_view
                    )
                
                episodes_view = EpisodeSelectionView(ctx.author.id, clean_title, chosen_season, max_ep, on_episode_selected, on_back)
                await status_msg.edit(
                    content=f"📺 **{clean_title} — Season {chosen_season}**\n\nWatch karne ke liye **Episode** select karein:",
                    view=episodes_view
                )
            
            seasons_view = SeasonSelectionView(ctx.author.id, clean_title, seasons, on_season_selected)
            await status_msg.edit(
                content=f"📺 **{clean_title}** ke kul `{len(seasons)} seasons` hain.\n\nNeeche se watch karne ke liye **Season** select karein:",
                view=seasons_view
            )
            return

        # Check if saved progress exists and prompt
        if saved_progress and saved_progress > 10:
            from plugins.controls import format_seconds
            pos_str = format_seconds(saved_progress)
            
            title_suffix = f" S{season}E{episode}" if season > 0 else ""
            display_title = f"{clean_title}{title_suffix}"
            
            # Setup callback functions
            async def on_resume(interaction):
                await start_playback(interaction, force_seek_secs=saved_progress)
                
            async def on_startover(interaction):
                clear_vod_progress(guild_id, subject_id, season, episode)
                await start_playback(interaction, force_seek_secs=0)
                
            view = ResumePromptView(ctx.author.id, on_resume, on_startover)
            await status_msg.edit(
                content=f"⚠️ **SAVED PROGRESS FOUND!**\n\n🎬 **Title:** `{display_title}`\n⏱ **Saved Position:** `{pos_str}`\n\nKya aap is position se **Resume** karna chahte hain ya shuru se **Start Over**?",
                view=view
            )
        else:
            # Start fresh playback directly
            await start_playback(ctx, force_seek_secs=0)
            
    except Exception as search_err:
        print(f"[Bot Search] Search failed: {search_err}")
        await status_msg.edit(content=f"❌ **Error executing command:** {search_err}")

# 2. STOP COMMAND
@bot.hybrid_command(name="stop", description="Stop streaming and disconnect the projector client.")
async def stop_stream(ctx: commands.Context):
    guild_id = ctx.guild.id
    if guild_id not in active_streams:
        await ctx.send("⚠️ **There is no active cinema stream in this server!**")
        return
        
    stream_info = active_streams[guild_id]
    await ctx.send(f"⏹ **Stopping stream and disconnecting:** `{stream_info['movie_name']}`...")
    await kill_process_tree(stream_info["process"])

# 3. STATUS COMMAND
@bot.hybrid_command(name="status", description="Get status details of the active stream.")
async def stream_status(ctx: commands.Context):
    guild_id = ctx.guild.id
    if guild_id not in active_streams:
        await ctx.send("🍿 No active cinema stream is currently running on this server.")
        return
        
    stream = active_streams[guild_id]
    await ctx.send(f"🎥 **Active Cinema Stream:** `{stream['movie_name']}` inside VC Channel ID: `{stream['channel_id']}`.")

# Run Bot Client
if __name__ == "__main__":
    if config.BOT_TOKEN == "YOUR_BOT_TOKEN_HERE" or config.STREAMER_TOKEN == "YOUR_STREAMER_TOKEN_HERE":
        print("❌ Please configure valid DISCORD_BOT_TOKEN and DISCORD_STREAMER_TOKEN inside config.py or env!")
    else:
        bot.run(config.BOT_TOKEN)
