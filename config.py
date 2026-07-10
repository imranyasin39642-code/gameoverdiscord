import os
from dotenv import load_dotenv

# Load variables from a local environment file
load_dotenv()

class Config:
    # Discord Application Bot Token (Controls commands /play, /list, etc.)
    BOT_TOKEN: str = os.getenv("DISCORD_BOT_TOKEN", "YOUR_BOT_TOKEN_HERE")

    # Discord Dummy User Account Token (Used for Go Live / Screensharing)
    STREAMER_TOKEN: str = os.getenv("DISCORD_STREAMER_TOKEN", "YOUR_STREAMER_TOKEN_HERE")

    # Shared downloads cache folder pointing to the Telegram bot downloads folder
    _parent_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    _tg_bot_folder = "gameoverbotmusic" if os.path.exists(os.path.join(_parent_dir, "gameoverbotmusic")) else "Music bot"
    DOWNLOADS_DIR: str = os.path.abspath(
        os.path.join(
            _parent_dir,
            _tg_bot_folder,
            "downloads"
        )
    )

    # Command prefix for the control bot
    COMMAND_PREFIX: str = os.getenv("COMMAND_PREFIX", "!")

    # Absolute path to the streamer.js Node script
    STREAMER_JS_PATH: str = os.path.join(
        os.path.dirname(os.path.abspath(__file__)),
        "streamer.js"
    )

# Expose fields for direct importing compatibility
BOT_TOKEN = Config.BOT_TOKEN
STREAMER_TOKEN = Config.STREAMER_TOKEN
COMMAND_PREFIX = Config.COMMAND_PREFIX
STREAMER_JS_PATH = Config.STREAMER_JS_PATH
