"""
Flick analysis - correlating crosshair motion with enemy positions.

This is where we calculate the actual over/undershoot metrics
by comparing where the crosshair landed vs where the enemy was.
"""

import numpy as np
from dataclasses import dataclass, field
from typing import List, Optional, Tuple, Dict
from enum import Enum


class AimError(Enum):
    """Classification of aim error type."""
    OVERSHOOT = "overshoot"     # Aimed too far (past target)
    UNDERSHOOT = "undershoot"   # Aimed short of target
    ON_TARGET = "on_target"     # Within acceptable margin


@dataclass
class FlickAnalysis:
    """Analysis results for a single flick."""
    
    # Frame indices
    reaction_frame: int
    termination_frame: int
    
    # Crosshair position at termination (where player aimed)
    crosshair_y: int
    
    # Enemy center Y at termination (where they should have aimed)
    enemy_y: int
    
    # Raw pixel error (positive = aimed too high, negative = aimed too low)
    pixel_error: int
    
    # Error as percentage of enemy height (normalized)
    normalized_error: float
    
    # Classification
    error_type: AimError
    
    # Confidence in the enemy detection
    detection_confidence: float
    
    @property
    def is_hit(self) -> bool:
        """Whether the flick would have hit the target (within bbox)."""
        return self.error_type == AimError.ON_TARGET


@dataclass
class SessionAnalysis:
    """Aggregated analysis across multiple flicks in a session."""
    
    flicks: List[FlickAnalysis] = field(default_factory=list)
    
    @property
    def count(self) -> int:
        return len(self.flicks)
    
    @property
    def hit_rate(self) -> float:
        """Percentage of flicks that would have hit."""
        if not self.flicks:
            return 0.0
        hits = sum(1 for f in self.flicks if f.is_hit)
        return hits / len(self.flicks)
    
    @property
    def mean_pixel_error(self) -> float:
        """Average pixel error (signed)."""
        if not self.flicks:
            return 0.0
        return np.mean([f.pixel_error for f in self.flicks])
    
    @property
    def mean_abs_pixel_error(self) -> float:
        """Average absolute pixel error."""
        if not self.flicks:
            return 0.0
        return np.mean([abs(f.pixel_error) for f in self.flicks])
    
    @property
    def overshoot_rate(self) -> float:
        """Percentage of flicks that overshot."""
        if not self.flicks:
            return 0.0
        overshoots = sum(1 for f in self.flicks if f.error_type == AimError.OVERSHOOT)
        return overshoots / len(self.flicks)
    
    @property
    def undershoot_rate(self) -> float:
        """Percentage of flicks that undershot."""
        if not self.flicks:
            return 0.0
        undershoots = sum(1 for f in self.flicks if f.error_type == AimError.UNDERSHOOT)
        return undershoots / len(self.flicks)
    
    @property  
    def error_bias(self) -> str:
        """Overall tendency: 'high', 'low', or 'neutral'."""
        mean_err = self.mean_pixel_error
        if mean_err > 10:  # Threshold in pixels, tune empirically
            return "high"  # Consistently aiming too high (overshoot)
        elif mean_err < -10:
            return "low"   # Consistently aiming too low (undershoot)
        return "neutral"
    
    def get_summary(self) -> Dict:
        """Get summary statistics as dict."""
        return {
            "total_flicks": self.count,
            "hit_rate": f"{self.hit_rate:.1%}",
            "mean_pixel_error": f"{self.mean_pixel_error:.1f}",
            "mean_abs_error": f"{self.mean_abs_pixel_error:.1f}",
            "overshoot_rate": f"{self.overshoot_rate:.1%}",
            "undershoot_rate": f"{self.undershoot_rate:.1%}",
            "bias": self.error_bias,
        }


class FlickAnalyzer:
    """
    Analyzes flicks by correlating crosshair position with enemy positions.
    
    Takes flick events (from FlickDetector) and detection data (from EnemyDetector)
    and produces aim error analysis.
    """
    
    def __init__(
        self,
        screen_height: int,
        hit_margin_pct: float = 0.15  # 15% of enemy height = "on target"
    ):
        """
        Args:
            screen_height: Frame height in pixels
            hit_margin_pct: Percentage of enemy height to consider "on target"
        """
        self.screen_height = screen_height
        self.hit_margin_pct = hit_margin_pct
        self.session = SessionAnalysis()
    
    def analyze_flick(
        self,
        reaction_frame: int,
        termination_frame: int,
        crosshair_y: int,
        enemy_y: int,
        enemy_height: int,
        detection_confidence: float
    ) -> FlickAnalysis:
        """
        Analyze a single flick.
        
        Args:
            reaction_frame: Frame index of flick start
            termination_frame: Frame index of flick end
            crosshair_y: Y position of crosshair at termination
            enemy_y: Y position of enemy center at termination
            enemy_height: Height of enemy bounding box
            detection_confidence: YOLO confidence of enemy detection
            
        Returns:
            FlickAnalysis with computed metrics
        """
        # Calculate pixel error
        # Positive = crosshair above enemy (aimed too high / overshoot)
        # Negative = crosshair below enemy (aimed too low / undershoot)
        pixel_error = enemy_y - crosshair_y  # If enemy is below crosshair, positive
        
        # Wait, let's think about this more carefully:
        # - Screen Y increases downward (0 at top)
        # - If crosshair_y < enemy_y, crosshair is ABOVE enemy = overshoot (aimed too high)
        # - If crosshair_y > enemy_y, crosshair is BELOW enemy = undershoot (aimed too low)
        
        # So: error = crosshair_y - enemy_y
        # Positive error = undershoot (aimed too low)
        # Negative error = overshoot (aimed too high)
        
        # Actually let's flip it for intuition:
        # error = enemy_y - crosshair_y
        # Positive = enemy below crosshair = overshoot
        # Negative = enemy above crosshair = undershoot
        
        pixel_error = enemy_y - crosshair_y
        
        # Normalize by enemy height
        normalized_error = pixel_error / enemy_height if enemy_height > 0 else 0
        
        # Classify
        hit_margin = enemy_height * self.hit_margin_pct
        if abs(pixel_error) <= hit_margin:
            error_type = AimError.ON_TARGET
        elif pixel_error > 0:
            error_type = AimError.OVERSHOOT  # Enemy below crosshair = aimed too high
        else:
            error_type = AimError.UNDERSHOOT  # Enemy above crosshair = aimed too low
        
        analysis = FlickAnalysis(
            reaction_frame=reaction_frame,
            termination_frame=termination_frame,
            crosshair_y=crosshair_y,
            enemy_y=enemy_y,
            pixel_error=pixel_error,
            normalized_error=normalized_error,
            error_type=error_type,
            detection_confidence=detection_confidence
        )
        
        self.session.flicks.append(analysis)
        return analysis
    
    def reset_session(self):
        """Clear session data for new analysis."""
        self.session = SessionAnalysis()
    
    def get_session_summary(self) -> Dict:
        """Get session statistics."""
        return self.session.get_summary()


def pixel_to_angle(pixel_error: float, fov_degrees: float, screen_height: int) -> float:
    """
    Convert pixel error to angular error in degrees.
    
    Uses pinhole camera model to convert screen-space pixels
    to angular displacement.
    
    Args:
        pixel_error: Error in pixels
        fov_degrees: Vertical field of view in degrees
        screen_height: Screen height in pixels
        
    Returns:
        Angular error in degrees
    """
    # Focal length in pixels (from pinhole model)
    fov_rad = np.radians(fov_degrees)
    focal_length = (screen_height / 2) / np.tan(fov_rad / 2)
    
    # Angular error
    angle_rad = np.arctan(pixel_error / focal_length)
    return np.degrees(angle_rad)


def calculate_sensitivity_adjustment(
    session: SessionAnalysis,
    current_sensitivity: float,
    fov_degrees: float,
    screen_height: int,
    adjustment_strength: float = 0.5
) -> Tuple[float, str]:
    """
    Calculate recommended sensitivity adjustment based on session analysis.
    
    Uses a simple proportional controller to suggest sensitivity changes
    based on systematic over/undershoot bias.
    
    Args:
        session: SessionAnalysis with flick data
        current_sensitivity: Current in-game sensitivity setting
        fov_degrees: Vertical FOV in degrees
        screen_height: Screen height in pixels
        adjustment_strength: How aggressive to make adjustments (0-1)
        
    Returns:
        Tuple of (recommended_sensitivity, explanation_string)
    """
    if session.count < 5:
        return current_sensitivity, "Not enough data (need 5+ flicks)"
    
    mean_error = session.mean_pixel_error
    abs_error = session.mean_abs_pixel_error
    
    # Convert to angular error
    angular_error = pixel_to_angle(mean_error, fov_degrees, screen_height)
    
    # If error is small, no adjustment needed
    if abs(angular_error) < 0.5:  # Less than 0.5 degrees
        return current_sensitivity, f"Sensitivity looks good! (avg error: {angular_error:.2f}°)"
    
    # Calculate adjustment factor
    # Overshoot (positive error) = sensitivity too high = reduce
    # Undershoot (negative error) = sensitivity too low = increase
    
    # Error ratio: how much we're off by relative to typical flick distance
    # This is a heuristic - tune based on real data
    error_ratio = angular_error / 10.0  # Assume ~10 degrees is a typical flick
    
    # Apply damped adjustment
    adjustment = 1.0 - (error_ratio * adjustment_strength)
    adjustment = np.clip(adjustment, 0.8, 1.2)  # Max 20% change
    
    new_sens = current_sensitivity * adjustment
    
    # Generate explanation
    if angular_error > 0:
        direction = "overshooting (aiming past targets)"
        action = "reducing"
    else:
        direction = "undershooting (stopping short of targets)"
        action = "increasing"
    
    explanation = (
        f"You're {direction} by ~{abs(angular_error):.1f}° on average.\n"
        f"Recommend {action} sensitivity from {current_sensitivity:.3f} to {new_sens:.3f} "
        f"({(adjustment-1)*100:+.1f}%)"
    )
    
    return new_sens, explanation


# Test
if __name__ == "__main__":
    # Simulate some flick data
    analyzer = FlickAnalyzer(screen_height=1440)
    
    # Simulated flicks with various errors
    test_flicks = [
        # (crosshair_y, enemy_y, enemy_height) 
        (720, 750, 200),   # Slight overshoot (enemy below crosshair)
        (720, 680, 180),   # Undershoot (enemy above crosshair)
        (720, 725, 190),   # On target
        (720, 790, 210),   # Overshoot
        (720, 760, 195),   # Overshoot
        (720, 710, 200),   # Slight undershoot
        (720, 740, 185),   # On target
        (720, 780, 200),   # Overshoot
    ]
    
    for i, (ch_y, en_y, en_h) in enumerate(test_flicks):
        analysis = analyzer.analyze_flick(
            reaction_frame=i*60,
            termination_frame=i*60 + 10,
            crosshair_y=ch_y,
            enemy_y=en_y,
            enemy_height=en_h,
            detection_confidence=0.85
        )
        print(f"Flick {i}: error={analysis.pixel_error:+d}px, type={analysis.error_type.value}")
    
    print("\n--- Session Summary ---")
    summary = analyzer.get_session_summary()
    for key, value in summary.items():
        print(f"  {key}: {value}")
    
    print("\n--- Sensitivity Recommendation ---")
    new_sens, explanation = calculate_sensitivity_adjustment(
        session=analyzer.session,
        current_sensitivity=0.192,
        fov_degrees=53,  # ADS FOV
        screen_height=1440
    )
    print(explanation)
