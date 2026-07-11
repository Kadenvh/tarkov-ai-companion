"""Detection modules for Tarkov Aim Lab."""

from .crosshair import CrosshairTracker, CrosshairState, visualize_tracking
from .events import FlickDetector, FlickEvent, FlickDetectorConfig, analyze_flick_distribution
from .enemy import EnemyDetector, Detection, visualize_detections

__all__ = [
    'CrosshairTracker',
    'CrosshairState', 
    'visualize_tracking',
    'FlickDetector',
    'FlickEvent',
    'FlickDetectorConfig',
    'analyze_flick_distribution',
    'EnemyDetector',
    'Detection',
    'visualize_detections',
]
