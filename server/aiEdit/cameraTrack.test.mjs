import { expect, it } from "vitest";
import { cameraForFrames, trackCamera } from "./cameraTrack.mjs";

it("holds the actual source pose between irregular PTS and projects ground and elevated points", () => {
  const rows = [[0, 0, 1.5, 0, 1, 0, .5, 0, 0, -1, .5, 1.5, 0, 0, 1, 0],
    [.042, .2, 1.5, 1, 1, 0, .5, -.7, 0, -1, .5, 1, 0, 0, 1, -1]];
  const track = cameraForFrames(rows);
  expect(track.at(.040).project(0, 0, 10, 100, 100)).toEqual([50, 65]);
  expect(track.at(.042).project(.2, 1.5, 11, 100, 100)).toEqual([50, 50]);
  expect(track.at(.0415).x).toBe(.2);
  expect(cameraForFrames(rows, 4).at(.0415).x).toBe(0);
  expect(track.at(1).project(0, 0, .5, 100, 100)).toBeNull();
});

it("rejects an invalid calibration before reading the video", async () => {
  const ctx = { store: { getSegment: async () => ({ kind: "video" }) } };
  await expect(trackCamera(ctx, { clip_id: "clip", vanishing_point: [1.2, .5] })).rejects.toMatchObject({ code: "arguments_invalid" });
});
