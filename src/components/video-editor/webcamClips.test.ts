import { describe, expect, it } from "vitest";
import { resolveWebcamMediaTime } from "./videoPlayback/webcamSync";
import {
	applyWebcamClipSpan,
	getAudioRegionSpanPatch,
	getSeparatedWebcamAudioRegions,
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

describe("recorded webcam clips", () => {
	const recorded = { sourcePath: "/tmp/recording-1-webcam.webm", timeOffsetMs: 500 };
	const screen = (overrides = {}) => ({
		id: "clip-1",
		startMs: 0,
		endMs: 10_000,
		sourceStartMs: 34_000,
		speed: 1,
		...overrides,
	});

	it("follows the screen clips so a trimmed recording keeps its webcam in sync", () => {
		expect(resolveWebcamClips(recorded, 60_000, [screen()])).toEqual([
			{ id: "webcam-clip-1", startMs: 0, endMs: 10_000, sourceStartMs: 33_500 },
		]);
	});

	it("starts late when the webcam began after the screen", () => {
		expect(
			resolveWebcamClips({ ...recorded, timeOffsetMs: 2000 }, 60_000, [
				screen({ sourceStartMs: 0 }),
			])[0],
		).toMatchObject({ startMs: 2000, endMs: 10_000, sourceStartMs: 0 });
	});

	it("gives each screen clip its own webcam clip, scaled by speed", () => {
		const clips = resolveWebcamClips(recorded, 60_000, [
			screen({ sourceStartMs: 1000, endMs: 4000 }),
			screen({ id: "clip-2", startMs: 4000, endMs: 6000, sourceStartMs: 20_000, speed: 2 }),
		]);
		expect(clips).toHaveLength(2);
		expect(clips[1]).toMatchObject({ startMs: 4000, endMs: 6000, sourceStartMs: 19_500 });
		expect(clips[0]?.id).not.toBe(clips[1]?.id);
	});

	it("skips the empty parts of an imported sequence", () => {
		const clips = resolveWebcamClips(
			{
				sourcePath: "/tmp/sequence.mp4",
				timeOffsetMs: 0,
				visibleRanges: [{ startMs: 2000, endMs: 3000 }],
			},
			60_000,
			[screen({ sourceStartMs: 0 })],
		);
		expect(clips).toEqual([
			{ id: "webcam-clip-1", startMs: 2000, endMs: 3000, sourceStartMs: 2000 },
		]);
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

describe("separated webcam audio", () => {
	it("keeps each piece of sound where the footage was and at its place in the file", () => {
		let id = 7;
		const regions = getSeparatedWebcamAudioRegions(
			[{ id: "webcam-clip-2", startMs: 8000, endMs: 12_000, sourceStartMs: 20_000 }],
			"/tmp/a.mp4",
			0.5,
			2,
			() => `audio-${id++}`,
		);
		expect(regions).toEqual([
			{
				id: "audio-7",
				startMs: 8000,
				endMs: 12_000,
				audioPath: "/tmp/a.mp4",
				volume: 0.5,
				trackIndex: 2,
				sourceOffsetMs: 20_000,
			},
		]);
	});

	it("skips into the file on a left trim but keeps its place when moved", () => {
		const region = { startMs: 8000, endMs: 12_000, sourceOffsetMs: 20_000 };
		expect(getAudioRegionSpanPatch(region, { start: 9000, end: 12_000 })).toEqual({
			startMs: 9000,
			endMs: 12_000,
			sourceOffsetMs: 21_000,
		});
		expect(getAudioRegionSpanPatch(region, { start: 9000, end: 13_000 })).toEqual({
			startMs: 9000,
			endMs: 13_000,
			sourceOffsetMs: 20_000,
		});
	});

	it("leaves ordinary audio clips behaving as before", () => {
		expect(
			getAudioRegionSpanPatch({ startMs: 1000, endMs: 5000 }, { start: 2000, end: 5000 }),
		).toEqual({ startMs: 2000, endMs: 5000, sourceOffsetMs: undefined });
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
