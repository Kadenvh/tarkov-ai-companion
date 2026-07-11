"""
Flick event detection from crosshair motion data.

A "flick" is defined as:
1. Crosshair is stationary (velocity < threshold) - REACTION FRAME
2. Crosshair velocity spikes above threshold - FLICK IN PROGRESS  
3. Crosshair returns to stationary - TERMINATION FRAME

We extract these three-point events for sensitivity analysis.
"""

import numpy as np
from dataclasses import dataclass
from typing import List, Optional, Tuple
from enum import Enum


class FlickPhase(Enum):
    IDLE = "idle"           # Waiting for flick to start
    FLICKING = "flicking"   # Flick in progress
    SETTLING = "settling"   # Waiting for settle confirmation


@dataclass 
class FlickEvent:
    """A detected flick event with the three key frames."""
    
    # Frame indices
    reaction_frame: int      # Last frame before movement started
    termination_frame: int   # Frame where movement stopped
    
    # Duration
    duration_frames: int     # termination - reaction
    
    # Peak velocity during flick
    peak_velocity: float
    
    # Average velocity during flick
    mean_velocity: float
    
    # Direction estimate (positive = moved right/down, negative = left/up)
    # This is rough - we'd need actual flow vectors for precise direction
    
    def __post_init__(self):
        self.duration_frames = self.termination_frame - self.reaction_frame


@dataclass
class FlickDetectorConfig:
    """Configuration for flick detection."""
    
    # Velocity threshold to consider "moving"
    velocity_threshold: float = 15.0
    
    # Minimum consecutive still frames to confirm flick end
    settle_frames: int = 3
    
    # Minimum flick duration to count as intentional (filter micro-movements)
    min_flick_frames: int = 2
    
    # Maximum flick duration (filter long tracking movements, not flicks)
    max_flick_frames: int = 30  # ~0.5s at 60fps


class FlickDetector:
    """
    State machine for detecting flick events from velocity data.
    
    Operates on a stream of velocity values, outputting FlickEvents
    when complete flicks are detected.
    """
    
    def __init__(self, config: Optional[FlickDetectorConfig] = None):
        self.config = config or FlickDetectorConfig()
        self.reset()
    
    def reset(self):
        """Reset detector state."""
        self.phase = FlickPhase.IDLE
        self.current_flick_start: Optional[int] = None
        self.settle_count = 0
        self.velocities_buffer: List[float] = []
        self.frame_idx = 0
        self.detected_flicks: List[FlickEvent] = []
    
    def process_velocity(self, velocity: float) -> Optional[FlickEvent]:
        """
        Process a single velocity value.
        
        Returns a FlickEvent if a complete flick was just detected,
        otherwise None.
        """
        is_moving = velocity > self.config.velocity_threshold
        event = None
        
        if self.phase == FlickPhase.IDLE:
            if is_moving:
                # Flick started! Record the previous frame as reaction frame
                self.phase = FlickPhase.FLICKING
                self.current_flick_start = max(0, self.frame_idx - 1)
                self.velocities_buffer = [velocity]
        
        elif self.phase == FlickPhase.FLICKING:
            self.velocities_buffer.append(velocity)
            
            if not is_moving:
                # Movement stopped, start settling
                self.phase = FlickPhase.SETTLING
                self.settle_count = 1
        
        elif self.phase == FlickPhase.SETTLING:
            self.velocities_buffer.append(velocity)
            
            if is_moving:
                # Movement resumed, back to flicking
                self.phase = FlickPhase.FLICKING
                self.settle_count = 0
            else:
                self.settle_count += 1
                
                if self.settle_count >= self.config.settle_frames:
                    # Flick complete! Create event
                    termination = self.frame_idx - self.config.settle_frames + 1
                    duration = termination - self.current_flick_start
                    
                    # Filter by duration
                    if (self.config.min_flick_frames <= duration <= 
                        self.config.max_flick_frames):
                        
                        # Calculate metrics from buffered velocities
                        # Trim the settle frames from the buffer
                        flick_velocities = self.velocities_buffer[:-self.config.settle_frames]
                        
                        if flick_velocities:
                            event = FlickEvent(
                                reaction_frame=self.current_flick_start,
                                termination_frame=termination,
                                duration_frames=duration,
                                peak_velocity=max(flick_velocities),
                                mean_velocity=np.mean(flick_velocities)
                            )
                            self.detected_flicks.append(event)
                    
                    # Reset to idle
                    self.phase = FlickPhase.IDLE
                    self.current_flick_start = None
                    self.settle_count = 0
                    self.velocities_buffer = []
        
        self.frame_idx += 1
        return event
    
    def process_velocity_series(self, velocities: np.ndarray) -> List[FlickEvent]:
        """
        Process an entire velocity series at once.
        
        Args:
            velocities: Array of velocity values, one per frame
            
        Returns:
            List of all detected FlickEvents
        """
        self.reset()
        
        for v in velocities:
            self.process_velocity(v)
        
        return self.detected_flicks
    
    def get_flick_frames(self) -> List[Tuple[int, int]]:
        """Get list of (start, end) frame tuples for all detected flicks."""
        return [(f.reaction_frame, f.termination_frame) for f in self.detected_flicks]


def analyze_flick_distribution(flicks: List[FlickEvent]) -> dict:
    """
    Compute statistics over a set of detected flicks.
    
    Returns dict with analysis results.
    """
    if not flicks:
        return {"count": 0}
    
    durations = [f.duration_frames for f in flicks]
    peaks = [f.peak_velocity for f in flicks]
    means = [f.mean_velocity for f in flicks]
    
    return {
        "count": len(flicks),
        "duration": {
            "mean": np.mean(durations),
            "std": np.std(durations),
            "min": min(durations),
            "max": max(durations),
        },
        "peak_velocity": {
            "mean": np.mean(peaks),
            "std": np.std(peaks),
            "min": min(peaks),
            "max": max(peaks),
        },
        "mean_velocity": {
            "mean": np.mean(means),
            "std": np.std(means),
        }
    }


# Test
if __name__ == "__main__":
    # Simulate a velocity series with some flicks
    np.random.seed(42)
    
    # Generate synthetic data:
    # - Mostly low velocity (idle)
    # - Occasional spikes (flicks)
    
    n_frames = 300
    velocities = np.random.uniform(0, 5, n_frames)  # Base noise
    
    # Add some flicks
    flick_starts = [30, 80, 150, 220]
    flick_durations = [8, 12, 6, 15]
    
    for start, dur in zip(flick_starts, flick_durations):
        # Ramp up, sustain, ramp down
        for i in range(dur):
            if i < dur // 3:
                velocities[start + i] = 20 + i * 5  # Ramp up
            elif i > 2 * dur // 3:
                velocities[start + i] = 30 - (i - 2*dur//3) * 5  # Ramp down
            else:
                velocities[start + i] = 30 + np.random.uniform(-5, 5)  # Sustain
    
    print("Synthetic velocity series generated")
    print(f"Injected flicks at frames: {flick_starts}")
    print()
    
    # Detect flicks
    detector = FlickDetector()
    detected = detector.process_velocity_series(velocities)
    
    print(f"Detected {len(detected)} flicks:")
    for f in detected:
        print(f"  Frame {f.reaction_frame} -> {f.termination_frame} "
              f"(dur={f.duration_frames}, peak={f.peak_velocity:.1f})")
    
    print()
    stats = analyze_flick_distribution(detected)
    print("Statistics:")
    for key, value in stats.items():
        print(f"  {key}: {value}")
