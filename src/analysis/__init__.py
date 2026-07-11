"""Analysis modules for Tarkov Aim Lab."""

from .flick import (
    FlickAnalyzer,
    FlickAnalysis,
    SessionAnalysis,
    AimError,
    pixel_to_angle,
    calculate_sensitivity_adjustment
)

__all__ = [
    'FlickAnalyzer',
    'FlickAnalysis', 
    'SessionAnalysis',
    'AimError',
    'pixel_to_angle',
    'calculate_sensitivity_adjustment',
]
