import { describe, expect, it } from "vitest";
import { resolveWebcamMediaTime } from "./videoPlayback/webcamSync";
import {
	applyWebcamClipSpan,
	getWebcamClipTimelineRegions,
	isWebcamClipId,
	resolveWebcamClips,
	splitWebcamClip,
} from "./webcamClips";

const clip = { id: "webcam-clip-1", startMs: 0, endMs: 38_000, sourceStartMs: 0 };

describe("resolveWebcamClips", () => {
	it("shows untouched footage as one clip placed by its offset", () => {
		expect(resolveWebcamClips({ timeOffsetMs: 2000 }, 38_000)[0]).toMatchObject({
			startMs: 2000,
			endMs: 40_000,
			sourceStartMs: 0,
		});
		expect(resolveWebcamClips({ timeOffsetMs: -5000 }, 38_000)[0]).toMatchObject({
			startMs: 0,
			endMs: 33_000,
			sourceStartMs: 5000,
		});
	});

	it("waits for the footage length and prefers stored clips", () => {
		expect(resolveWebcamClips({ timeOffsetMs: 0 }, null)).toEqual([]);
		expect(resolveWebcamClips({ timeOffsetMs: 0, clips: [] }, 38_000)).toEqual([]);
	});
});

describe("applyWebcamClipSpan", () => {
	it("moves a clip without changing which footage it shows", () => {
		expect(
			applyWebcamClipSpan([clip], clip.id, { start: 3000, end: 41_000 }, 38_000)[0],
		).toMatchObject({ startMs: 3000, endMs: 41_000, sourceStartMs: 0 });
	});

	it("trims the left edge by skipping into the footage", () => {
		expect(
			applyWebcamClipSpan([clip], clip.id, { start: 4000, end: 38_000 }, 38_000)[0],
		).toMatchObject({ startMs: 4000, endMs: 38_000, sourceStartMs: 4000 });
	});

	it("cannot extend past either end of the footage", () => {
		const trimmed = { ...clip, startMs: 10_000, sourceStartMs: 4000 };
		expect(
			applyWebcamClipSpan([trimmed], clip.id, { start: 1000, end: 38_000 }, 38_000)[0],
		).toMatchObject({ startMs: 6000, sourceStartMs: 0 });
		expect(
			applyWebcamClipSpan([trimmed], clip.id, { start: 10_000, end: 60_000 }, 38_000)[0]?.endMs,
		).toBe(44_000);
	});
});

describe("splitWebcamClip", () => {
	it("splits at the playhead and continues the footage in the second piece", () => {
		const parts = splitWebcamClip([clip], 10_000);
		expect(parts).toHaveLength(2);
		expect(parts[0]).toMatchObject({ endMs: 10_000 });
		expect(parts[1]).toMatchObject({ startMs: 10_000, endMs: 38_000, sourceStartMs: 10_000 });
		expect(parts[1]?.id).not.toBe(parts[0]?.id);
		expect(isWebcamClipId(parts[1]?.id)).toBe(true);
	});

	it("ignores a playhead outside every clip", () => {
		expect(splitWebcamClip([clip], 50_000)).toEqual([clip]);
	});
});

describe("resolveWebcamMediaTime with edited clips", () => {
	const webcam = {
		sourcePath: "/tmp/New project.mp4",
		clips: [
			{ id: "webcam-clip-1", startMs: 0, endMs: 5000, sourceStartMs: 0 },
			{ id: "webcam-clip-2", startMs: 8000, endMs: 12_000, sourceStartMs: 20_000 },
		],
	};

	it("maps each clip to its piece of the footage", () => {
		expect(resolveWebcamMediaTime({ webcam, clockTime: 2 })).toMatchObject({
			mediaTime: 2,
			active: true,
			clipId: "webcam-clip-1",
		});
		expect(resolveWebcamMediaTime({ webcam, clockTime: 9 })).toMatchObject({
			mediaTime: 21,
			active: true,
			clipId: "webcam-clip-2",
		});
	});

	it("hides between clips and holds position instead of rewinding", () => {
		expect(resolveWebcamMediaTime({ webcam, clockTime: 6 })).toMatchObject({
			mediaTime: 5,
			active: false,
			clipId: null,
		});
	});

	it("shows nothing once every clip is deleted", () => {
		expect(
			resolveWebcamMediaTime({ webcam: { ...webcam, clips: [] }, clockTime: 2 }).active,
		).toBe(false);
	});
});

describe("getWebcamClipTimelineRegions", () => {
	it("places clips on their own track below real audio", () => {
		expect(getWebcamClipTimelineRegions([clip], "/tmp/a.mp4", 0.5)[0]).toMatchObject({
			id: clip.id,
			audioPath: "/tmp/a.mp4",
			volume: 0.5,
			trackIndex: 1000,
		});
	});
});
