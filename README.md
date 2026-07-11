# Tarkov Aim Lab

Research toolkit for analyzing aim mechanics in Escape from Tarkov Arena footage.

## Goal

Extract three data points per flick:
1. **Reaction Frame**: Last frame before crosshair starts moving
2. **Termination Frame**: Frame where crosshair settles after flick
3. **Enemy Centroid**: Y-center of enemy at termination

Calculate sensitivity adjustment recommendations based on over/undershoot patterns.

## Project Structure

```
tarkov-aim-lab/
├── src/
│   ├── detection/
│   │   ├── crosshair.py     # Crosshair tracking via motion analysis
│   │   ├── enemy.py         # YOLO-based enemy detection
│   │   └── events.py        # Flick event detection (start/stop)
│   ├── analysis/
│   │   ├── flick.py         # Flick metrics calculation
│   │   └── sensitivity.py   # Sensitivity recommendations
│   └── utils/
│       ├── video.py         # Video loading/frame extraction
│       └── config.py        # Config loader
├── notebooks/               # Jupyter notebooks for exploration
├── data/                    # Sample clips, debug frames
├── models/                  # YOLO weights
├── config.yaml              # User settings
└── analyze.py               # CLI entry point
```

## Setup

```bash
pip install opencv-python ultralytics numpy pyyaml
```

## Usage (planned)

```bash
# Analyze a single clip
python analyze.py --clip "path/to/arena_match.mp4"

# Batch analyze all clips in Outplayed folder
python analyze.py --batch
```

## Current Phase: Exploration

Building and testing individual components:
- [ ] Crosshair motion tracking
- [ ] Flick start/end detection
- [ ] YOLO enemy detection
- [ ] Match window extraction via kill screen
- [ ] Integration pipeline

## Settings

Edit `config.yaml` with your:
- Sensitivity: 0.192
- ADS multiplier: 1.42
- FOV: 69 (hip) / 53 (ADS)
- DPI: ???
- Resolution: ???
