"""
Main analysis pipeline for Tarkov Aim Lab.

Processes Outplayed clips and generates flick analysis reports.

Usage:
    # List available clips
    python analyze.py --list
    
    # Analyze the most recent clip
    python analyze.py --latest
    
    # Analyze a specific clip
    python analyze.py --clip "X:/Overwolf/Outplayed/.../clip.mp4"
    
    # Quick test (limit frames)
    python analyze.py --latest --max-frames 500
"""

import cv2
import numpy as np
import yaml
import argparse
from pathlib import Path
from typing import Optional, List, Tuple
from dataclasses import dataclass

from src.detection import CrosshairTracker, FlickDetector, EnemyDetector
from src.analysis import FlickAnalyzer, calculate_sensitivity_adjustment
from src.utils import discover_clips, list_sessions, get_latest_clip, VideoClip


@dataclass
class FrameData:
    """Data extracted from a single frame."""
    frame_idx: int
    crosshair_velocity: float
    crosshair_moving: bool
    enemy_detections: list
    closest_enemy: Optional[object]


def load_config(config_path: str = "config.yaml") -> dict:
    """Load configuration from YAML file."""
    with open(config_path, 'r') as f:
        return yaml.safe_load(f)


def process_video(
    video_path: str,
    config: dict,
    debug_output: bool = False,
    max_frames: Optional[int] = None,
    show_progress: bool = True
) -> Tuple[List[FrameData], 'FlickDetector', 'FlickAnalyzer']:
    """
    Process a video file through the full pipeline.
    
    Args:
        video_path: Path to video file
        config: Configuration dict
        debug_output: Whether to save debug frames
        max_frames: Optional limit on frames to process
        show_progress: Print progress updates
        
    Returns:
        Tuple of (frame_data_list, flick_detector, flick_analyzer)
    """
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise ValueError(f"Could not open video: {video_path}")
    
    # Get video properties
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = cap.get(cv2.CAP_PROP_FPS)
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    
    if show_progress:
        duration = total_frames / fps
        print(f"Video: {width}x{height} @ {fps:.1f}fps")
        print(f"Duration: {duration:.1f}s ({total_frames} frames)")
    
    # Initialize components
    crosshair_tracker = CrosshairTracker(
        frame_width=width,
        frame_height=height,
        roi_width_pct=config['analysis']['crosshair_roi']['width_pct'],
        roi_height_pct=config['analysis']['crosshair_roi']['height_pct'],
        velocity_threshold=config['analysis']['flick_velocity_threshold']
    )
    
    flick_detector = FlickDetector()
    
    enemy_detector = EnemyDetector(
        model_path=config['detection']['yolo_model'],
        confidence_threshold=config['detection']['confidence_threshold'],
        device="cuda"
    )
    
    flick_analyzer = FlickAnalyzer(
        screen_height=height,
        hit_margin_pct=0.15
    )
    
    screen_center = (width // 2, height // 2)
    
    # Process frames
    frame_data = []
    frame_idx = 0
    
    process_total = min(total_frames, max_frames) if max_frames else total_frames
    
    if show_progress:
        print(f"Processing {process_total} frames...")
    
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        
        if max_frames and frame_idx >= max_frames:
            break
        
        # Track crosshair motion
        ch_state = crosshair_tracker.process_frame(frame)
        
        # Detect flick events
        flick_event = flick_detector.process_velocity(ch_state.velocity)
        
        # Detect enemies
        detections = enemy_detector.detect(frame)
        closest = enemy_detector.find_closest_to_center(detections, screen_center)
        
        # If a flick just completed and we have an enemy, analyze it
        if flick_event and closest:
            flick_analyzer.analyze_flick(
                reaction_frame=flick_event.reaction_frame,
                termination_frame=flick_event.termination_frame,
                crosshair_y=screen_center[1],
                enemy_y=closest.y_center,
                enemy_height=closest.height,
                detection_confidence=closest.confidence
            )
        
        # Store frame data
        frame_data.append(FrameData(
            frame_idx=frame_idx,
            crosshair_velocity=ch_state.velocity,
            crosshair_moving=ch_state.is_moving,
            enemy_detections=detections,
            closest_enemy=closest
        ))
        
        # Progress
        if show_progress and frame_idx % 300 == 0:
            pct = 100 * frame_idx / process_total
            print(f"  Frame {frame_idx}/{process_total} ({pct:.0f}%)")
        
        frame_idx += 1
    
    cap.release()
    
    if show_progress:
        print(f"Done. Found {len(flick_detector.detected_flicks)} flicks, "
              f"analyzed {len(flick_analyzer.session.flicks)} with enemies.")
    
    return frame_data, flick_detector, flick_analyzer


def generate_report(
    flick_analyzer: 'FlickAnalyzer',
    config: dict,
    clip_info: Optional[VideoClip] = None,
    output_path: Optional[str] = None
) -> str:
    """Generate a text report of the analysis."""
    summary = flick_analyzer.get_session_summary()
    
    lines = [
        "=" * 60,
        "  TARKOV AIM LAB - ANALYSIS REPORT",
        "=" * 60,
        "",
    ]
    
    if clip_info:
        lines.extend([
            f"Clip: {clip_info.filename}",
            f"Duration: {clip_info.duration_str}",
            f"Session: {clip_info.session_folder}",
            "",
        ])
    
    lines.extend([
        "SESSION STATISTICS",
        "-" * 40,
        f"  Total Flicks Analyzed:  {summary['total_flicks']}",
        f"  Hit Rate:               {summary['hit_rate']}",
        f"  Mean Pixel Error:       {summary['mean_pixel_error']} px",
        f"  Mean Absolute Error:    {summary['mean_abs_error']} px",
        f"  Overshoot Rate:         {summary['overshoot_rate']}",
        f"  Undershoot Rate:        {summary['undershoot_rate']}",
        f"  Overall Bias:           {summary['bias']}",
        "",
    ])
    
    # Sensitivity recommendation
    if flick_analyzer.session.count >= 5:
        new_sens, explanation = calculate_sensitivity_adjustment(
            session=flick_analyzer.session,
            current_sensitivity=config['player']['sensitivity'],
            fov_degrees=config['player']['fov']['ads'],
            screen_height=config['player']['resolution']['height']
        )
        
        lines.extend([
            "SENSITIVITY RECOMMENDATION",
            "-" * 40,
            explanation,
            "",
        ])
    else:
        lines.extend([
            "SENSITIVITY RECOMMENDATION",
            "-" * 40,
            f"  Need more data ({summary['total_flicks']}/5 flicks minimum)",
            "",
        ])
    
    lines.extend([
        "=" * 60,
    ])
    
    report = "\n".join(lines)
    
    if output_path:
        with open(output_path, 'w') as f:
            f.write(report)
        print(f"\nReport saved to: {output_path}")
    
    return report


def cmd_list(config: dict):
    """List available clips and sessions."""
    root = config['video']['recordings_path']
    
    print(f"\nScanning: {root}\n")
    
    # List sessions
    sessions = list_sessions(root)
    
    if not sessions:
        print("No recording sessions found.")
        print(f"Check that the path exists and contains Outplayed recordings.")
        return
    
    print(f"Found {len(sessions)} sessions:\n")
    print(f"{'Date':<20} {'Clips':<8} Folder")
    print("-" * 70)
    
    for s in sessions[:15]:
        print(f"{s['date_str']:<20} {s['clip_count']:<8} {s['folder'][:40]}")
    
    if len(sessions) > 15:
        print(f"  ... and {len(sessions) - 15} more")
    
    # Recent clips
    print("\n" + "=" * 70)
    print("Recent clips (>60s):\n")
    
    clips = discover_clips(root, min_duration_seconds=60)
    
    if clips:
        print(f"{'Duration':<10} {'Size':<10} Filename")
        print("-" * 70)
        
        for c in clips[:10]:
            print(f"{c.duration_str:<10} {c.size_mb:.0f} MB{'':<5} {c.filename[:50]}")
        
        if len(clips) > 10:
            print(f"  ... and {len(clips) - 10} more")
    else:
        print("No clips found >60s duration.")


def main():
    parser = argparse.ArgumentParser(
        description="Tarkov Aim Lab - Flick Analysis",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python analyze.py --list                    List available clips
  python analyze.py --latest                  Analyze most recent clip
  python analyze.py --clip path/to/video.mp4  Analyze specific clip
  python analyze.py --latest --max-frames 500 Quick test (first 500 frames)
        """
    )
    
    parser.add_argument("--list", action="store_true", 
                        help="List available clips and sessions")
    parser.add_argument("--latest", action="store_true",
                        help="Analyze the most recent clip")
    parser.add_argument("--clip", type=str, 
                        help="Path to specific video clip")
    parser.add_argument("--config", type=str, default="config.yaml",
                        help="Config file path")
    parser.add_argument("--max-frames", type=int,
                        help="Limit frames to process (for testing)")
    parser.add_argument("--debug", action="store_true",
                        help="Save debug output")
    parser.add_argument("--save-report", type=str,
                        help="Save report to file")
    
    args = parser.parse_args()
    
    # Load config
    config = load_config(args.config)
    
    # List mode
    if args.list:
        cmd_list(config)
        return
    
    # Get clip to analyze
    clip_info = None
    video_path = None
    
    if args.clip:
        video_path = args.clip
    elif args.latest:
        root = config['video']['recordings_path']
        clip_info = get_latest_clip(root)
        if clip_info:
            video_path = str(clip_info.path)
            print(f"\nLatest clip: {clip_info.filename}")
            print(f"  Duration: {clip_info.duration_str}")
            print(f"  Session: {clip_info.session_folder}")
        else:
            print("No clips found. Use --list to see available recordings.")
            return
    else:
        print("No clip specified. Use --clip <path>, --latest, or --list")
        parser.print_help()
        return
    
    # Analyze
    print(f"\nAnalyzing: {video_path}")
    print("-" * 60)
    
    try:
        frame_data, flick_detector, flick_analyzer = process_video(
            video_path,
            config,
            debug_output=args.debug,
            max_frames=args.max_frames
        )
        
        # Generate report
        report = generate_report(
            flick_analyzer, 
            config, 
            clip_info,
            output_path=args.save_report
        )
        print("\n" + report)
        
    except Exception as e:
        print(f"\nError: {e}")
        raise


if __name__ == "__main__":
    main()
