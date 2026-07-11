"""
Enemy detection using YOLOv8.

Detects "person" class in frames and returns bounding boxes
with center coordinates for aim analysis.
"""

import cv2
import numpy as np
from dataclasses import dataclass
from typing import List, Optional, Tuple
from pathlib import Path


@dataclass
class Detection:
    """A single enemy detection."""
    bbox: Tuple[int, int, int, int]  # (x1, y1, x2, y2)
    confidence: float
    center: Tuple[int, int]          # (cx, cy)
    
    @property
    def width(self) -> int:
        return self.bbox[2] - self.bbox[0]
    
    @property
    def height(self) -> int:
        return self.bbox[3] - self.bbox[1]
    
    @property
    def area(self) -> int:
        return self.width * self.height
    
    @property
    def y_center(self) -> int:
        """Y coordinate of center - key metric for vertical aim analysis."""
        return self.center[1]


class EnemyDetector:
    """
    YOLO-based enemy detector.
    
    Uses ultralytics YOLOv8 to detect persons in frames.
    """
    
    # COCO class ID for "person"
    PERSON_CLASS = 0
    
    def __init__(
        self,
        model_path: str = "yolov8n.pt",
        confidence_threshold: float = 0.5,
        device: str = "cuda"  # or "cpu"
    ):
        """
        Args:
            model_path: Path to YOLO weights or model name to download
            confidence_threshold: Minimum confidence to accept detection
            device: 'cuda' for GPU, 'cpu' for CPU inference
        """
        self.confidence_threshold = confidence_threshold
        self.device = device
        
        # Lazy load - don't import ultralytics until needed
        self.model = None
        self.model_path = model_path
    
    def _load_model(self):
        """Lazy load the YOLO model."""
        if self.model is None:
            try:
                from ultralytics import YOLO
                print(f"Loading YOLO model: {self.model_path}")
                self.model = YOLO(self.model_path)
                self.model.to(self.device)
                print(f"Model loaded on {self.device}")
            except ImportError:
                raise ImportError(
                    "ultralytics not installed. Run: pip install ultralytics"
                )
    
    def detect(self, frame: np.ndarray) -> List[Detection]:
        """
        Detect enemies in a frame.
        
        Args:
            frame: BGR image as numpy array
            
        Returns:
            List of Detection objects for persons found
        """
        self._load_model()
        
        # Run inference
        results = self.model(frame, verbose=False)[0]
        
        detections = []
        
        for box in results.boxes:
            # Filter by class (person only)
            if int(box.cls) != self.PERSON_CLASS:
                continue
            
            # Filter by confidence
            conf = float(box.conf)
            if conf < self.confidence_threshold:
                continue
            
            # Extract bbox coordinates
            x1, y1, x2, y2 = map(int, box.xyxy[0].tolist())
            
            # Calculate center
            cx = (x1 + x2) // 2
            cy = (y1 + y2) // 2
            
            detections.append(Detection(
                bbox=(x1, y1, x2, y2),
                confidence=conf,
                center=(cx, cy)
            ))
        
        return detections
    
    def detect_batch(self, frames: List[np.ndarray]) -> List[List[Detection]]:
        """
        Detect enemies in multiple frames (batched for efficiency).
        
        Args:
            frames: List of BGR images
            
        Returns:
            List of detection lists, one per frame
        """
        self._load_model()
        
        # Batch inference
        results = self.model(frames, verbose=False)
        
        all_detections = []
        
        for result in results:
            frame_detections = []
            
            for box in result.boxes:
                if int(box.cls) != self.PERSON_CLASS:
                    continue
                
                conf = float(box.conf)
                if conf < self.confidence_threshold:
                    continue
                
                x1, y1, x2, y2 = map(int, box.xyxy[0].tolist())
                cx = (x1 + x2) // 2
                cy = (y1 + y2) // 2
                
                frame_detections.append(Detection(
                    bbox=(x1, y1, x2, y2),
                    confidence=conf,
                    center=(cx, cy)
                ))
            
            all_detections.append(frame_detections)
        
        return all_detections
    
    def find_closest_to_center(
        self,
        detections: List[Detection],
        screen_center: Tuple[int, int]
    ) -> Optional[Detection]:
        """
        Find the detection closest to screen center.
        
        This is likely the target the player is aiming at.
        
        Args:
            detections: List of detections in frame
            screen_center: (x, y) of screen center
            
        Returns:
            Closest Detection, or None if no detections
        """
        if not detections:
            return None
        
        cx, cy = screen_center
        
        def distance_to_center(d: Detection) -> float:
            dx = d.center[0] - cx
            dy = d.center[1] - cy
            return np.sqrt(dx*dx + dy*dy)
        
        return min(detections, key=distance_to_center)


def visualize_detections(
    frame: np.ndarray,
    detections: List[Detection],
    screen_center: Optional[Tuple[int, int]] = None,
    highlight_closest: bool = True
) -> np.ndarray:
    """
    Draw detection boxes and centers on frame.
    
    Returns annotated frame copy.
    """
    vis = frame.copy()
    
    closest = None
    if highlight_closest and detections and screen_center:
        detector = EnemyDetector.__new__(EnemyDetector)  # Hack to use method
        closest = EnemyDetector.find_closest_to_center(detector, detections, screen_center)
    
    for det in detections:
        # Box color: green for closest, yellow for others
        is_closest = closest and det is closest
        color = (0, 255, 0) if is_closest else (0, 255, 255)
        thickness = 3 if is_closest else 2
        
        # Draw bounding box
        x1, y1, x2, y2 = det.bbox
        cv2.rectangle(vis, (x1, y1), (x2, y2), color, thickness)
        
        # Draw center point
        cv2.circle(vis, det.center, 5, color, -1)
        
        # Draw horizontal line at Y-center (the key metric)
        cv2.line(vis, (x1, det.y_center), (x2, det.y_center), (255, 0, 255), 2)
        
        # Confidence label
        label = f"{det.confidence:.2f}"
        cv2.putText(vis, label, (x1, y1 - 10), 
                   cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 2)
    
    # Draw screen center crosshair if provided
    if screen_center:
        cx, cy = screen_center
        cv2.drawMarker(vis, (cx, cy), (0, 0, 255), cv2.MARKER_CROSS, 30, 2)
    
    return vis


# Test
if __name__ == "__main__":
    import sys
    
    if len(sys.argv) < 2:
        print("Usage: python enemy.py <video_path>")
        print("       python enemy.py <image_path>")
        sys.exit(1)
    
    path = sys.argv[1]
    
    detector = EnemyDetector(
        model_path="yolov8n.pt",
        confidence_threshold=0.5,
        device="cuda"
    )
    
    # Check if image or video
    if path.lower().endswith(('.png', '.jpg', '.jpeg')):
        # Single image
        frame = cv2.imread(path)
        if frame is None:
            print(f"Failed to load image: {path}")
            sys.exit(1)
        
        h, w = frame.shape[:2]
        center = (w // 2, h // 2)
        
        detections = detector.detect(frame)
        print(f"Found {len(detections)} persons")
        
        for i, det in enumerate(detections):
            print(f"  {i}: center={det.center}, conf={det.confidence:.2f}")
        
        vis = visualize_detections(frame, detections, center)
        cv2.imshow("Detections", vis)
        cv2.waitKey(0)
        cv2.destroyAllWindows()
    
    else:
        # Video
        cap = cv2.VideoCapture(path)
        if not cap.isOpened():
            print(f"Failed to open video: {path}")
            sys.exit(1)
        
        w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        center = (w // 2, h // 2)
        
        frame_count = 0
        total_detections = 0
        
        while True:
            ret, frame = cap.read()
            if not ret:
                break
            
            detections = detector.detect(frame)
            total_detections += len(detections)
            
            vis = visualize_detections(frame, detections, center)
            cv2.imshow("Detections", vis)
            
            key = cv2.waitKey(1) & 0xFF
            if key == ord('q'):
                break
            elif key == ord(' '):
                cv2.waitKey(0)
            
            frame_count += 1
        
        cap.release()
        cv2.destroyAllWindows()
        
        print(f"\nProcessed {frame_count} frames")
        print(f"Total detections: {total_detections}")
        print(f"Avg detections/frame: {total_detections/frame_count:.2f}")
