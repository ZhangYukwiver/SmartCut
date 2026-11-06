"""Estimate a calibrated ground-plane pose from each displayed source frame."""

import json
import sys

import av
import cv2
import numpy as np


def frames_in_clip(file, start, duration):
    with av.open(file) as container:
        stream = container.streams.video[0]
        base = stream.time_base
        origin = float((stream.start_time or 0) * base)
        if start > 0:
            container.seek(int((origin + start) / float(base)), stream=stream, backward=True)
        previous = None
        for frame in container.decode(stream):
            if frame.pts is None:
                raise ValueError("缺少呈现时间戳，无法逐帧同步")
            t = float(frame.pts * frame.time_base) - origin
            if t >= start + duration - 1e-8:
                break
            if t > start and previous is not None:
                yield 0.0, previous
                previous = None
            if t <= start:
                previous = frame
            else:
                yield t - start, frame
        if previous is not None:
            yield 0.0, previous


def gray_frame(frame):
    scale = min(1, 1000 / max(frame.width, frame.height))
    g = frame.reformat(
        width=round(frame.width * scale), height=round(frame.height * scale), format="gray"
    ).to_ndarray()
    return np.ascontiguousarray(np.rot90(g, round(frame.rotation / 90) % 4))


def features(image, mask):
    # Grid quotas keep a single high-contrast road marking from dominating the pose.
    h, w = image.shape
    out = []
    for top in range(0, h, 92):
        for left in range(0, w, 120):
            ys, xs = slice(top, top + 92), slice(left, left + 120)
            if np.count_nonzero(mask[ys, xs]) < 30:
                continue
            corners = cv2.goodFeaturesToTrack(image[ys, xs], 18, 0.012, 5, mask=mask[ys, xs], blockSize=5)
            if corners is not None:
                out.extend(corners[:, 0] + [left, top])
    return np.asarray(out, np.float32).reshape(-1, 2)


def optical_flow(before, after, points, predictions=None):
    lk = dict(
        winSize=(21, 21), maxLevel=3, criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 24, 0.012)
    )
    new, ok, err = cv2.calcOpticalFlowPyrLK(
        before,
        after,
        points,
        predictions,
        **lk,
        flags=cv2.OPTFLOW_USE_INITIAL_FLOW if predictions is not None else 0,
    )
    back, ok2, _ = cv2.calcOpticalFlowPyrLK(
        after, before, new, points.copy(), **lk, flags=cv2.OPTFLOW_USE_INITIAL_FLOW
    )
    valid = (
        (ok.ravel() != 0)
        & (ok2.ravel() != 0)
        & (err.ravel() < 30)
        & (np.linalg.norm(back - points, axis=1) < 1.1)
    )
    h, w = after.shape
    valid &= (new[:, 0] >= 4) & (new[:, 1] >= 4) & (new[:, 0] < w - 4) & (new[:, 1] < h - 4)
    return new, valid


def long_segments(gray, detector, mask=None):
    lines = detector.detect(gray)[0]
    if lines is None:
        return np.empty((0, 2, 2))
    lines = lines.reshape(-1, 2, 2)
    if mask is not None:
        # A line which continues outside the floor can still contain a good floor segment.
        trimmed = []
        for line in lines:
            samples = np.linspace(*line, 26)
            indexes = np.rint(samples).astype(int)
            good = samples[mask[indexes[:, 1], indexes[:, 0]] != 0]
            if len(good) > 1:
                trimmed.append([good[0], good[-1]])
        lines = np.asarray(trimmed).reshape(-1, 2, 2)
    return lines[np.linalg.norm(lines[:, 0] - lines[:, 1], axis=1) > gray.shape[1] * 0.075]


def refine_direction(edges, prior, size):
    """Refine the supplied road direction only when differently oriented floor lines agree."""
    ends = np.concatenate([edges, np.ones((*edges.shape[:2], 1))], axis=2)
    lines = np.cross(ends[:, 0], ends[:, 1])
    lines /= np.linalg.norm(lines[:, :2], axis=1, keepdims=True)
    lines = lines[(np.abs(lines[:, 0]) > 0.22) & (np.abs(lines @ np.r_[prior * size, 1]) < 0.035 * size[0])]
    best = []
    for i, line in enumerate(lines):
        for other in lines[i + 1 :]:
            vp = np.cross(line, other)
            if abs(vp[2]) < 0.30:
                continue
            vp /= vp[2]
            if np.max(np.abs(vp[:2] / size - prior)) > 0.075:
                continue
            ids = np.flatnonzero(np.abs(lines @ vp) < 2.5)
            if len(ids) > len(best):
                best = ids
    if len(best) < 3:
        return prior
    return np.linalg.lstsq(lines[best, :2], -lines[best, 2], rcond=None)[0] / size


def register_ground(anchor, gray, current_map, search):
    """Match perspective-rectified ground patches back to an actual keyframe, across scale changes."""
    image, floor_mask, anchor_map = anchor
    H = current_map @ np.linalg.inv(anchor_map)
    h, w = gray.shape
    warped = cv2.warpPerspective(image, H, (w, h))
    mask = cv2.erode(cv2.warpPerspective(floor_mask, H, (w, h)), np.ones((19, 19), np.uint8))
    # The homography also maps the mathematical plane behind the camera; reject those pixels.
    inv = np.linalg.inv(current_map)
    yy, xx = np.ogrid[:h, :w]
    mask[inv[2, 0] * xx + inv[2, 1] * yy + inv[2, 2] <= 0] = 0
    corners = cv2.goodFeaturesToTrack(warped, 180, 0.009, 11, mask=mask)
    rectified, points = [], []
    for x, y in np.rint(corners[:, 0]).astype(int) if corners is not None else []:
        rad = 9
        if min(x, y, w - 1 - x, h - 1 - y) < rad + search:
            continue
        template = warped[y - rad : y + rad + 1, x - rad : x + rad + 1]
        area = gray[y - rad - search : y + rad + search + 1, x - rad - search : x + rad + search + 1]
        corr = cv2.matchTemplate(area, template, cv2.TM_CCOEFF_NORMED)
        _, peak, _, (u, v) = cv2.minMaxLoc(corr)
        if peak < 0.82:
            continue
        corr[max(0, v - 4) : v + 5, max(0, u - 4) : u + 5] = -1
        if corr.max() > peak - 0.055:
            continue
        rectified.append([x, y, 1])
        points.append([x + u - search, y + v - search])
    if not points:
        return np.empty((0, 3)), np.empty((0, 2), np.float32)
    ground = np.asarray(rectified) @ np.linalg.inv(current_map).T
    ground /= ground[:, 2:]
    return ground, np.asarray(points, np.float32)


def apply_map(matrix, points):
    projected = points @ matrix.T
    return projected[:, :2] / projected[:, 2:]


def ground_at(pixels, floor):
    world = np.c_[pixels, np.ones(len(pixels))] @ np.linalg.inv(floor).T
    return world / world[:, 2:]


def line_observations(floor, lines, segments):
    """Use the normal of a stripe, never its arbitrary visible endpoint as a fixed point."""
    if not len(lines) or not len(segments):
        return []
    ends = np.concatenate([segments, np.ones((*segments.shape[:2], 1))], axis=2)
    normals = np.cross(ends[:, 0], ends[:, 1])[:, :2]
    normals /= np.linalg.norm(normals, axis=1, keepdims=True)
    predicted = np.linalg.solve(floor.T, lines.T).T
    predicted /= np.linalg.norm(predicted[:, :2], axis=1, keepdims=True)
    candidates = []
    for i, ln in enumerate(predicted):
        distances = ends @ ln
        scores = np.max(abs(distances), axis=1)
        for j in np.flatnonzero((normals @ ln[:2] > 0.999) & (scores < 7)):
            candidates.append((scores[j], i, j))
    used_line, used_edge, matches = set(), set(), []
    for _, i, j in sorted(candidates):
        if i in used_line or j in used_edge:
            continue
        used_line.add(i)
        used_edge.add(j)
        ln = predicted[i]
        for target in segments[j]:
            delta = target @ ln[:2] + ln[2]
            matches.append((target - delta * ln[:2], target, ln[:2]))
    return matches


def refine_map(base, pairs, line_obs, size):
    """Small projective update in normalized screen coordinates with robust image residuals."""
    w, h = size
    N = np.array([[1 / w, 0, -0.5], [0, 1 / w, -0.5 * h / w], [0, 0, 1.0]])

    def rows(src, dst):
        x, y = (src - [w / 2, h / 2]) / w
        u, v = (dst - [w / 2, h / 2]) / w
        return [[x, y, 1, 0, 0, 0, -x * u, -y * u], [0, 0, 0, x, y, 1, -x * v, -y * v]]

    A, b, weights = [], [], []
    for points, targets, weight in pairs:
        for src, dst in zip(points, targets):
            A.extend(rows(src, dst))
            b.extend(dst - src)
            weights.extend([weight, weight])
    for src, dst, normal in line_obs:
        A.append(normal @ rows(src, dst))
        b.append(normal @ (dst - src))
        weights.append(8.0)
    A, b, weights = np.asarray(A), np.asarray(b), np.sqrt(weights)
    delta = np.zeros(8)
    for _ in range(3):
        robust = weights * np.minimum(1.0, np.sqrt(2.0 / np.maximum(0.001, abs(A @ delta - b))))
        delta = np.linalg.lstsq(
            np.vstack((A * robust[:, None], np.eye(8) * 0.27)), np.r_[b * robust, np.zeros(8)], rcond=None
        )[0]
    return np.linalg.inv(N) @ (np.eye(3) + np.r_[delta, 0].reshape(3, 3) / w) @ N @ base


def projection(floor, K, size):
    # The floor keeps its measured homography exactly. Extend it to elevated points
    # with the perpendicular calibrated from the two in-plane axes.
    axes = np.linalg.solve(K, floor[:, :2])
    up = np.cross(axes[:, 0], axes[:, 1])
    up *= np.mean(np.linalg.norm(axes, axis=0)) / np.linalg.norm(up)
    P = np.column_stack([floor[:, 0], K @ up, floor[:, 1], floor[:, 2]])
    centre = np.linalg.solve(P[:, :3], -P[:, 3])
    P /= np.mean(np.linalg.norm(axes, axis=0))
    P[:2] /= size[:, None]
    return centre, P


def track(file, opts):
    cv2.setNumThreads(2)
    cv2.setRNGSeed(112)
    iterator = iter(frames_in_clip(file, opts["from"], opts["length"]))
    first = next(iterator, None)
    if first is None:
        raise ValueError("片段无可解码帧")
    reference = gray_frame(first[1])
    h, w = reference.shape
    size = np.array([w, h])
    vp = np.asarray(opts["vp"])
    top = min(0.94, vp[1] + 0.065)
    region = np.asarray(
        opts.get(
            "ground",
            [
                [max(0, vp[0] - 0.042), top],
                [min(1, vp[0] + 0.042), top],
                [min(0.995, vp[0] + 0.60), 0.99],
                [max(0.005, vp[0] - 0.45), 0.99],
            ],
        )
    )
    mask = np.zeros_like(reference)
    cv2.fillPoly(mask, [np.int32(region * size)], 255)
    detector = cv2.createLineSegmentDetector(cv2.LSD_REFINE_STD)
    edges = long_segments(reference, detector, mask)
    vp = refine_direction(edges, vp, size)
    focal = 0.5 * w / np.tan(np.deg2rad(opts["fov"]) * 0.5)
    K = np.array([[focal, 0, w / 2], [0, focal, h / 2], [0, 0, 1.0]])
    forward = np.linalg.solve(K, np.r_[vp * size, 1])
    forward /= np.linalg.norm(forward)
    right = np.cross([0, 1.0, 0], forward)
    right /= np.linalg.norm(right)
    down = np.cross(forward, right)
    floor = K @ np.column_stack([right, forward, opts["height"] * down])
    polygon = ground_at(region * size, floor)
    if (polygon[:, 1] <= 0).any() or np.any(region[:, 1] <= vp[1] + 0.01):
        raise ValueError("请将地面选区置于首帧地平线以下")
    footprint = np.ascontiguousarray(polygon[:, :2], dtype=np.float32)
    if cv2.contourArea(footprint) < 0.01:
        raise ValueError("地面选区面积不足")
    ends = np.concatenate([edges, np.ones((*edges.shape[:2], 1))], axis=2)
    lines = np.cross(ends[:, 0], ends[:, 1]) @ floor
    first_anchor = (reference, mask, floor.copy())
    anchors = [first_anchor]
    xy = features(reference, mask)
    if len(xy) < 18:
        raise ValueError("首帧地面特征不足，请扩大静态地面选区")
    world = ground_at(xy, floor)
    held = np.arange(len(xy)) % 5 == 0
    prev = reference
    frames, flow_errors, patch_errors, counts, line_counts = [], [], [], [], []

    def save(t):
        centre, P = projection(floor, K, size)
        if not np.isfinite(P).all() or not 0 < centre[1] < 5 * opts["height"]:
            raise ValueError(f"{t:.3f} 秒：地面位姿不可靠")
        frames.append(np.round(np.r_[t / opts["speed"], centre, P.ravel()], 8).tolist())

    save(first[0])
    for idx, (t, frame) in enumerate(iterator, 1):
        gray = gray_frame(frame)
        if gray.shape != reference.shape or t / opts["speed"] <= frames[-1][0] or idx >= 3600:
            raise ValueError("分辨率或呈现时钟变化，或单次超过 3600 帧")
        current, valid = optical_flow(prev, gray, xy)
        world, xy, held = world[valid], current[valid], held[valid]
        fit = np.flatnonzero(~held)
        if len(fit) < 12:
            raise ValueError(f"{t:.3f} 秒：路面特征不足")
        predicted = apply_map(floor, world[fit])
        H, inliers = cv2.findHomography(predicted, xy[fit], cv2.RANSAC, 1.65)
        support = fit[inliers.ravel() != 0] if H is not None else []
        if len(support) < max(12, min(80, len(fit) * 0.4)) or np.ptp(xy[support], axis=0).min() < 14:
            raise ValueError(f"{t:.3f} 秒：地面共同特征不足，检查切镜、遮挡与选区")
        base = H @ floor
        # Fix the homogeneous scale without changing depths' signs.
        base /= np.linalg.norm(np.linalg.solve(K, base[:, 0]))
        observed = long_segments(gray, detector)
        line_obs = line_observations(base, lines, observed)
        pairs = [(apply_map(base, world[support]), xy[support], 0.65)]
        checks = []
        if idx % 4 == 0:
            for rank, anchor in enumerate(anchors):
                xyz, obs = register_ground(anchor, gray, base, 34 if rank == 0 else 15)
                if len(obs) < 3:
                    continue
                valid = np.ones(len(obs), bool)
                if len(obs) >= 8:
                    valid[::5] = False
                    checks.append((xyz[~valid], obs[~valid]))
                weight = max(2.0, min(16.0, 60 / len(obs))) if rank == 0 else 1.5
                pairs.append((apply_map(base, xyz[valid]), obs[valid], weight))
        floor = refine_map(base, pairs, line_obs, size)
        if cv2.determinant(floor) * cv2.determinant(first_anchor[2]) <= 0:
            raise ValueError(f"{t:.3f} 秒：平面投影退化，无法建立稳定空间坐标")
        err = np.linalg.norm(apply_map(floor, world) - xy, axis=1)
        if held.any():
            flow_errors.append(float(np.median(err[held])))
        for xyz, obs in checks:
            patch_errors.extend(np.linalg.norm(apply_map(floor, xyz) - obs, axis=1))
        counts.append(len(support))
        line_counts.append(len(line_obs) // 2)
        keep = err < 2.25
        xy, world, held = xy[keep], world[keep], held[keep]
        if idx % 32 == 0:
            key_mask = cv2.warpPerspective(mask, floor @ np.linalg.inv(first_anchor[2]), (w, h))
            anchors = [first_anchor, *anchors[1:][-2:], (gray, key_mask, floor.copy())]
        if idx % 6 == 0 or len(xy) < 50:
            open_mask = np.full_like(gray, 255)
            for pt in xy:
                cv2.circle(open_mask, tuple(np.int32(pt)), 7, 0, -1)
            new = features(gray, open_mask)
            xyz = ground_at(new, floor)
            ids = [
                j
                for j in range(len(new))
                if xyz[j, 1] > 0
                and cv2.pointPolygonTest(footprint, tuple(xyz[j, :2]), False) >= 0
                and (floor @ xyz[j])[2] > 0.12
            ]
            if ids:
                xy = np.vstack((xy, new[ids]))
                world = np.vstack((world, xyz[ids]))
                held = np.r_[held, np.arange(len(ids)) % 5 == 0]
        save(t)
        prev = gray
    if len(frames) < 2 or not flow_errors:
        raise ValueError("没有足够帧和留出地面点验证轨迹")
    summary = dict(
        frames=len(frames),
        analysis_size=size.tolist(),
        checked_frames=len(flow_errors),
        min_inliers=min(counts),
        min_ground_lines=min(line_counts),
        flow_holdout_median_px=round(float(np.median(flow_errors)), 3),
        flow_holdout_frame_median_p95_px=round(float(np.percentile(flow_errors, 95)), 3),
        patch_holdouts=len(patch_errors),
        patch_holdout_p95_px=round(float(np.percentile(patch_errors, 95)), 3) if patch_errors else None,
        first_vp=vp.round(5).tolist(),
        camera_height=opts["height"],
        last_camera_xyz=frames[-1][1:4],
    )
    if (
        len(flow_errors) < 0.8 * (len(frames) - 1)
        or summary["flow_holdout_frame_median_p95_px"] > 4.5
        or (len(patch_errors) >= 20 and summary["patch_holdout_p95_px"] > 6)
    ):
        raise ValueError(
            f"留出点检验不足：覆盖 {len(flow_errors)}/{len(frames)-1}，光流 P95 {summary['flow_holdout_frame_median_p95_px']} px，关键帧 P95 {summary['patch_holdout_p95_px']} px；请选择更宽的平坦地面"
        )
    return dict(frames=frames, summary=summary)


if __name__ == "__main__":
    print(json.dumps(track(sys.argv[1], json.loads(sys.argv[2])), separators=(",", ":"), allow_nan=False))
