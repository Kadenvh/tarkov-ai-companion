"""
Crosshair motion tracking via frame differencing and centroid analysis.

Instead of template matching a specific reticle, we track motion in the 
center region of the screen. The crosshair is the most stable point during
camera movement - everything else moves, but the crosshair stays relatively fixed.

For flick detection, we actually want the inverse: detect when the CENTER
of the screen moves rapidly (indicating mouse input).
"""

import cv2
import numpy as np
from dataclasses import dataclass
from typing import Optional, Tuple, List


@dataclass
class CrosshairState:
    """State of crosshair at a given frame."""
    frame_idx: int
    position: Tuple[int, int]  # (x, y) in pixels
    velocity: float            # pixels per frame
    is_moving: bool           # above velocity threshold


class CrosshairTracker:
    """
    Tracks crosshair motion using optical flow in the center region.
    
    The key insight: we don't need to find the exact crosshair pixel.
    We just need to detect MOTION in the center region, which indicates
    the player is moving their aim.
    """
    
    def __init__(
        self,
        frame_width: int,
        frame_height: int,
        roi_width_pct: float = 0.1,
        roi_height_pct: float = 0.1,
        velocity_threshold: float = 15.0
    ):
        """
        Args:
            frame_width: Video frame width in pixels
            frame_height: Video frame height in pixels  
            roi_width_pct: Width of center ROI as percentage of frame
            roi_height_pct: Height of center ROI as percentage of frame
            velocity_threshold: Pixels/frame above which = "moving"
        """
        self.frame_width = frame_width
        self.frame_height = frame_height
        self.velocity_threshold = velocity_threshold
        
        # Calculate ROI bounds (center of screen)
        roi_w = int(frame_width * roi_width_pct)
        roi_h = int(frame_height * roi_height_pct)
        
        self.roi_x1 = (frame_width - roi_w) // 2
        self.roi_y1 = (frame_height - roi_h) // 2
        self.roi_x2 = self.roi_x1 + roi_w
        self.roi_y2 = self.roi_y1 + roi_h
        
        # Previous frame for optical flow
        self.prev_gray: Optional[np.ndarray] = None
        self.frame_idx = 0
        
        # History for analysis
        self.history: List[CrosshairState] = []
        
        # Optical flow parameters (Lucas-Kanade)
        self.lk_params = dict(
            winSize=(21, 21),
            maxLevel=3,
            criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, 0.01)
        )
        
        # Feature detection parameters
        self.feature_params = dict(
            maxCorners=100,
            qualityLevel=0.3,
            minDistance=7,
            blockSize=7
        )
    
    def get_center(self) -> Tuple[int, int]:
        """Return screen center coordinates."""
        return (self.frame_width // 2, self.frame_height // 2)
    
    def extract_roi(self, frame: np.ndarray) -> np.ndarray:
        """Extract the center ROI from a frame."""
        return frame[self.roi_y1:self.roi_y2, self.roi_x1:self.roi_x2]
    
    def process_frame(self, frame: np.ndarray) -> CrosshairState:
        """
        Process a frame and return crosshair state.
        
        Uses dense optical flow on the center ROI to estimate
        how much the "aim point" moved between frames.
        """
        # Convert to grayscale
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        roi_gray = self.extract_roi(gray)
        
        center = self.get_center()
        velocity = 0.0
        
        if self.prev_gray is not None:
            prev_roi = self.extract_roi(self.prev_gray)
            
            # Calculate dense optical flow (Farneback)
            flow = cv2.calcOpticalFlowFarneback(
                prev_roi, roi_gray,
                None,
                pyr_scale=0.5,
                levels=3,
                winsize=15,
                iterations=3,
                poly_n=5,
                poly_sigma=1.2,
                flags=0
            )
            
            # Get mean flow vector in ROI
            # This represents average motion of pixels in center region
            mean_flow_x = np.mean(flow[..., 0])
            mean_flow_y = np.mean(flow[..., 1])
            
            # Velocity is magnitude of flow vector
            velocity = np.sqrt(mean_flow_x**2 + mean_flow_y**2)
        
        self.prev_gray = gray
        
        state = CrosshairState(
            frame_idx=self.frame_idx,
            position=center,  # We assume crosshair is at center for now
            velocity=velocity,
            is_moving=velocity > self.velocity_threshold
        )
        
        self.history.append(state)
        self.frame_idx += 1
        
        return state
    
    def reset(self):
        """Reset tracker state for a new video."""
        self.prev_gray = None
        self.frame_idx = 0
        self.history = []
    
    def get_velocity_series(self) -> np.ndarray:
        """Get velocity history as numpy array for analysis."""
        return np.array([s.velocity for s in self.history])
    
    def get_movement_mask(self) -> np.ndarray:
        """Get boolean mask of frames where crosshair was moving."""
        return np.array([s.is_moving for s in self.history])


def visualize_tracking(
    frame: np.ndarray,
    state: CrosshairState,
    tracker: CrosshairTracker
) -> np.ndarray:
    """
    Draw debug visualization on frame.
    
    Returns annotated frame copy.
    """
    vis = frame.copy()
    
    # Draw ROI rectangle
    color = (0, 0, 255) if state.is_moving else (0, 255, 0)  # Red if moving, green if still
    cv2.rectangle(
        vis,
        (tracker.roi_x1, tracker.roi_y1),
        (tracker.roi_x2, tracker.roi_y2),
        color,
        2
    )
    
    # Draw center crosshair
    cx, cy = tracker.get_center()
    cv2.drawMarker(vis, (cx, cy), color, cv2.MARKER_CROSS, 20, 2)
    
    # Draw velocity text
    text = f"Vel: {state.velocity:.1f} px/f"
    cv2.putText(vis, text, (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 1, color, 2)
    
    status = "MOVING" if state.is_moving else "STILL"
    cv2.putText(vis, status, (10, 70), cv2.FONT_HERSHEY_SIMPLEX, 1, color, 2)
    
    return vis


# Quick test
if __name__ == "__main__":
    # Test with a sample video
    import sys
    
    if len(sys.argv) < 2:
        print("Usage: python crosshair.py <video_path>")
        sys.exit(1)
    
    video_path = sys.argv[1]
    cap = cv2.VideoCapture(video_path)
    
    if not cap.isOpened():
        print(f"Failed to open video: {video_path}")
        sys.exit(1)
    
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = cap.get(cv2.CAP_PROP_FPS)
    
    print(f"Video: {width}x{height} @ {fps}fps")
    
    tracker = CrosshairTracker(width, height)
    
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        
        state = tracker.process_frame(frame)
        vis = visualize_tracking(frame, state, tracker)
        
        cv2.imshow("Crosshair Tracking", vis)
        
        key = cv2.waitKey(1) & 0xFF
        if key == ord('q'):
            break
        elif key == ord(' '):  # Pause
            cv2.waitKey(0)
    
    cap.release()
    cv2.destroyAllWindows()
    
    # Print summary
    velocities = tracker.get_velocity_series()
    print(f"\nProcessed {len(velocities)} frames")
    print(f"Mean velocity: {np.mean(velocities):.2f}")
    print(f"Max velocity: {np.max(velocities):.2f}")
    print(f"Frames moving: {np.sum(tracker.get_movement_mask())} / {len(velocities)}")
