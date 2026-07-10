import os
import sqlite3
import time

_parent_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_tg_bot_folder = "gameoverbotmusic" if os.path.exists(os.path.join(_parent_dir, "gameoverbotmusic")) else "Music bot"
DB_FILE = os.path.abspath(os.path.join(_parent_dir, _tg_bot_folder, "gameover_db.sqlite3"))
print(f"[DB] Using unified database file at: {DB_FILE}")

def get_db():
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = get_db()
    cursor = conn.cursor()
    
    # Table for VOD playback resume history
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS vod_history (
            chat_id INTEGER,
            subject_id INTEGER,
            title TEXT,
            season INTEGER,
            episode INTEGER,
            progress_seconds INTEGER,
            last_played REAL,
            PRIMARY KEY (chat_id, subject_id, season, episode)
        )
    """)
    
    conn.commit()
    conn.close()

# Initialize tables
init_db()

def get_vod_progress(chat_id: int, subject_id: int, season: int, episode: int) -> int:
    """Return the saved progress in seconds for the given VOD item."""
    conn = get_db()
    cursor = conn.cursor()
    try:
        cursor.execute(
            "SELECT progress_seconds FROM vod_history WHERE chat_id = ? AND subject_id = ? AND season = ? AND episode = ?",
            (chat_id, subject_id, season, episode)
        )
        row = cursor.fetchone()
        return row["progress_seconds"] if row else 0
    except Exception as e:
        print(f"[DB] Error get_vod_progress: {e}")
        return 0
    finally:
        conn.close()

def set_vod_progress(chat_id: int, subject_id: int, title: str, season: int, episode: int, progress: int):
    """Save the current VOD progress to the database."""
    conn = get_db()
    cursor = conn.cursor()
    try:
        cursor.execute(
            "INSERT OR REPLACE INTO vod_history (chat_id, subject_id, title, season, episode, progress_seconds, last_played) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (chat_id, subject_id, title, season, episode, progress, time.time())
        )
        conn.commit()
    except Exception as e:
        print(f"[DB] Error set_vod_progress: {e}")
    finally:
        conn.close()

def clear_vod_progress(chat_id: int, subject_id: int, season: int, episode: int):
    """Delete progress history for the given VOD item."""
    conn = get_db()
    cursor = conn.cursor()
    try:
        cursor.execute(
            "DELETE FROM vod_history WHERE chat_id = ? AND subject_id = ? AND season = ? AND episode = ?",
            (chat_id, subject_id, season, episode)
        )
        conn.commit()
    except Exception as e:
        print(f"[DB] Error clear_vod_progress: {e}")
    finally:
        conn.close()
