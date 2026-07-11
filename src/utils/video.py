"""Utility functions for video file discovery and loading."""

import cv2
from pathlib import Path
from datetime import datetime
from dataclasses import dataclass
from typing import List, Optional, Generator
import re


@dataclass
class VideoClip:
    """Metadata for a discovered video clip."""
    path: Path
    filename: str
    session_folder: str
    timestamp: Optional[datetime]
    size_mb: float
    duration_seconds: Optional[float] = None
    resolution: Optional[tuple] = None
    fps: Optional[float] = None
    
    def __post_init__(self):
        # Lazy load video properties
        if self.duration_seconds is None:
            self._load_video_info()
    
    def _load_video_info(self):
        """Load video properties from file."""
        try:
            cap = cv2.VideoCapture(str(self.path))
            if cap.isOpened():
                self.fps = cap.get(cv2.CAP_PROP_FPS)
                frame_count = cap.get(cv2.CAP_PROP_FRAME_COUNT)
                self.duration_seconds = frame_count / self.fps if self.fps > 0 else 0
                self.resolution = (
                    int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)),
                    int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
                )
                cap.release()
        except Exception:
            pass

    @property
    def duration_str(self) -> str:
        """Human-readable duration."""
        if self.duration_seconds is None:
            return "??:??"
        mins = int(self.duration_seconds // 60)
        secs = int(self.duration_seconds % 60)
        return f"{mins}:{secs:02d}"


def parse_outplayed_timestamp(folder_name: str) -> Optional[datetime]:
    """
    Parse timestamp from Outplayed folder name.
    
    Format: "Game Name_MM-DD-YYYY_HH-MM-SS-mmm"
    Example: "Escape from Tarkov Arena_01-25-2026_11-15-26-519"
    """
    # Extract the date/time part after the game name
    pattern = r'(\d{2})-(\d{2})-(\d{4})_(\d{2})-(\d{2})-(\d{2})'
    match = re.search(pattern, folder_name)
    
    if match:
        month, day, year, hour, minute, second = map(int, match.groups())
        try:
            return datetime(year, month, day, hour, minute, second)
        except ValueError:
            return None
    return None


def discover_clips(
    root_path: str,
    extensions: tuple = ('.mp4', '.mkv', '.avi'),
    min_duration_seconds: float = 30.0,
    max_age_days: Optional[int] = None
) -> List[VideoClip]:
    """
    Discover video clips in Outplayed folder structure.
    
    Outplayed creates subfolders per session:
    root/
      Game Name_01-25-2026_11-15-26-519/
        clip1.mp4
        clip2.mp4
      Game Name_01-25-2026_14-30-00-123/
        clip3.mp4
    
    Args:
        root_path: Root recordings folder
        extensions: Video file extensions to find
        min_duration_seconds: Skip clips shorter than this
        max_age_days: Only return clips from last N days
        
    Returns:
        List of VideoClip objects, sorted by timestamp (newest first)
    """
    root = Path(root_path)
    if not root.exists():
        raise FileNotFoundError(f"Recordings path not found: {root_path}")
    
    clips = []
    
    # Find all video files recursively
    for ext in extensions:
        for video_path in root.rglob(f"*{ext}"):
            # Get session folder name (parent of the video)
            session_folder = video_path.parent.name
            
            # Parse timestamp from folder name
            timestamp = parse_outplayed_timestamp(session_folder)
            
            # Get file size
            size_mb = video_path.stat().st_size / (1024 * 1024)
            
            clip = VideoClip(
                path=video_path,
                filename=video_path.name,
                session_folder=session_folder,
                timestamp=timestamp,
                size_mb=size_mb
            )
            
            # Filter by duration
            if clip.duration_seconds and clip.duration_seconds < min_duration_seconds:
                continue
            
            # Filter by age
            if max_age_days and timestamp:
                age = (datetime.now() - timestamp).days
                if age > max_age_days:
                    continue
            
            clips.append(clip)
    
    # Sort by timestamp (newest first)
    clips.sort(key=lambda c: c.timestamp or datetime.min, reverse=True)
    
    return clips


def list_sessions(root_path: str) -> List[dict]:
    """
    List all recording sessions with clip counts.
    
    Returns:
        List of dicts with session info
    """
    root = Path(root_path)
    if not root.exists():
        return []
    
    sessions = []
    
    for folder in root.iterdir():
        if not folder.is_dir():
            continue
        
        # Count video files
        clip_count = sum(1 for _ in folder.glob("*.mp4"))
        if clip_count == 0:
            continue
        
        timestamp = parse_outplayed_timestamp(folder.name)
        
        sessions.append({
            "folder": folder.name,
            "path": str(folder),
            "timestamp": timestamp,
            "clip_count": clip_count,
            "date_str": timestamp.strftime("%Y-%m-%d %H:%M") if timestamp else "Unknown"
        })
    
    # Sort by timestamp
    sessions.sort(key=lambda s: s["timestamp"] or datetime.min, reverse=True)
    
    return sessions


def get_latest_clip(root_path: str) -> Optional[VideoClip]:
    """Get the most recent clip."""
    clips = discover_clips(root_path)
    return clips[0] if clips else None


def get_session_clips(root_path: str, session_folder: str) -> List[VideoClip]:
    """Get all clips from a specific session folder."""
    session_path = Path(root_path) / session_folder
    if not session_path.exists():
        return []
    
    clips = []
    for video_path in session_path.glob("*.mp4"):
        timestamp = parse_outplayed_timestamp(session_folder)
        size_mb = video_path.stat().st_size / (1024 * 1024)
        
        clips.append(VideoClip(
            path=video_path,
            filename=video_path.name,
            session_folder=session_folder,
            timestamp=timestamp,
            size_mb=size_mb
        ))
    
    return clips


# CLI helper
if __name__ == "__main__":
    import sys
    import yaml
    
    # Load config
    config_path = Path(__file__).parent.parent.parent / "config.yaml"
    with open(config_path) as f:
        config = yaml.safe_load(f)
    
    root = config['video']['recordings_path']
    
    print(f"Scanning: {root}\n")
    
    # List sessions
    sessions = list_sessions(root)
    print(f"Found {len(sessions)} sessions:\n")
    
    for s in sessions[:10]:  # Show first 10
        print(f"  [{s['date_str']}] {s['clip_count']} clips - {s['folder']}")
    
    print()
    
    # Show recent clips
    clips = discover_clips(root, min_duration_seconds=60)
    print(f"Found {len(clips)} clips (>60s):\n")
    
    for c in clips[:10]:
        print(f"  {c.duration_str} | {c.size_mb:.0f}MB | {c.filename}")
