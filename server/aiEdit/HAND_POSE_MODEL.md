# Local hand pose model

SmartCut downloads the FP32 MediaPipe Handpose ONNX from [OpenCV Zoo](https://github.com/opencv/opencv_zoo/tree/48b10fa505aeb51fbd127fc60a5c660040e823b7/models/handpose_estimation_mediapipe).

- Pinned revision: `48b10fa505aeb51fbd127fc60a5c660040e823b7`.
- File: `handpose_estimation_mediapipe_2023feb.onnx`, 4,099,621 bytes.
- SHA-256: `db0898ae717b76b075d9bf563af315b29562e11f8df5027a1ef07b02bef6d81c`.
- License: Apache-2.0; [upstream license](https://github.com/opencv/opencv_zoo/blob/48b10fa505aeb51fbd127fc60a5c660040e823b7/models/handpose_estimation_mediapipe/LICENSE).
- Provenance: [MediaPipe Hands paper](https://arxiv.org/abs/2006.10214); the ONNX conversion and model are maintained in OpenCV Zoo. Source footage remains local during inference.

The network estimates a relative 3D hand shape, not sensor depth. SmartCut transforms the upright crop coordinates back into source-camera coordinates, fits a perspective pose with an explicit 60-degree FOV prior, checks reprojection and 2D identity agreement, and preserves rejected frames. Runtime temporal interpolation is limited to bracketed gaps of at most 0.1 seconds while the 2D hand remains observed. It is explicitly tagged `temporalBridge`.

Forearm depth is constrained by the estimated palm pose, model length/width, and visible silhouette or elbow. An offscreen elbow is not observed. Neither physical scale nor camera intrinsics are calibrated by this process. A caller must not report measured centimetres, automatic scene-depth occlusion, or true full-body 3D reconstruction from these outputs.
