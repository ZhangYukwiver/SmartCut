import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import { openTab } from "./browser.mjs";
import { encodeMp4 } from "./encoder.mjs";
import { createFilmStudio } from "./studio.mjs";

vi.mock("./browser.mjs", () => ({ openTab: vi.fn() }));
vi.mock("./encoder.mjs", () => ({ encodeMp4: vi.fn(), writePngMov: vi.fn(), QUALITY_BITS: { standard: 0.08 } }));
const roots = [];
afterEach(async () => { vi.resetAllMocks(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

it("mixes volume keyframes (with the fade) by the preview's volume curve and keeps the track's role on a page clip's sound", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "film-studio-"));
  roots.push(root);
  const library = { idForPath: () => "a", get: () => ({ id: "a", name: "a.mp4", width: 960, height: 1280, source: { type: "local" } }) };
  const segment = {
    id: "v", kind: "video", path: path.join(root, "media", "a.mp4"), timeline: { start_us: 0, duration_us: 2e6 }, source: { start_us: 0, duration_us: 2e6 }, volume: 1,
    mask: { mask_type: "圆形" }, fade: { in_duration_us: 0, out_duration_us: 5e5 },
    keyframes: [{ property: "volume", offset_us: 0, value: 0 }, { property: "volume", offset_us: 1e6, value: 2 }],
  };
  const project = { name: "混音", canvas: { width: 108, height: 192, fps: 10 }, tracks: [{ id: "t", track_type: "video", duck: true, segments: [segment] }] };
  const tab = { meta: { sounds: [{ clip: "v-audio", src: "/a.mp4", at: 0, from: 0, to: 2, volume: 2, fade: [0, 0.5] }] }, seek: vi.fn(), capture: vi.fn(), close: vi.fn() };
  openTab.mockResolvedValue(tab);
  encodeMp4.mockImplementation(async ({ file }) => { await writeFile(file, "mp4"); return { silent: false }; });
  const studio = createFilmStudio({ root, library, provider: {}, getOrigin: () => "" });
  const result = await studio.renderMp4("s", project);
  expect(result.dropped).toBe("");
  expect(await readFile(path.join(root, "renders", "s", "film.html"), "utf8")).toContain('<audio id="v-audio"');
  const [sound] = encodeMp4.mock.calls[0][0].sounds;
  expect(sound.role).toBe("duck");
  // 每 10 毫秒一个点：0 → 1 秒音量 0 → 2，最后半秒淡出到 0
  expect(sound.gain).toHaveLength(201);
  expect(sound.gain[0]).toBe(0);
  expect(sound.gain[50]).toBe(1);
  expect(sound.gain[100]).toBe(2);
  expect(sound.gain[175]).toBe(1);
  expect(sound.gain[200]).toBe(0);
});
