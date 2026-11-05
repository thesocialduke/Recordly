import { describe, expect, it, vi } from "vitest";
import type { AudioRegion } from "@/components/video-editor/types";
import { OfflineAudioProcessor } from "./offlineAudioProcessor";

const buffer = { duration: 12, numberOfChannels: 2 } as AudioBuffer;
class TestAudioProcessor extends OfflineAudioProcessor {
	prepare = this.prepareOfflineRender.bind(this);
	schedule = this.scheduleBufferThroughTimeline.bind(this);
	scheduleOverlay = this.scheduleRegionForChunk.bind(this);
	protected decodeAudioFromUrl = vi.fn(async () => buffer);
	protected getMediaDurationSec = vi.fn(async () => 12);
	protected stretchAudioBuffer = vi.fn(() => buffer);
	get stretches() {
		return this.stretchAudioBuffer.mock.calls;
	}
}
const clips = [
	{ id: "a", startMs: 0, endMs: 1000, sourceStartMs: 0, speed: 3 },
	{ id: "b", startMs: 2000, endMs: 4000, sourceStartMs: 6000, speed: 3 },
];
function context() {
	const starts: ReturnType<typeof vi.fn>[] = [];
	return {
		starts,
		ctx: {
			destination: {},
			createGain: () => ({ gain: { value: 1 }, connect: vi.fn() }),
			createBufferSource: () => {
				const start = vi.fn();
				starts.push(start);
				return { playbackRate: { value: 1 }, connect: vi.fn(), start };
			},
		} as unknown as OfflineAudioContext,
	};
}

class SilentScreenProcessor extends TestAudioProcessor {
	protected decodeAudioFromUrl = vi.fn(async (url: string) =>
		url.includes("footage") ? ({ duration: 41.8, numberOfChannels: 2 } as AudioBuffer) : null,
	);
	protected getMediaDurationSec = vi.fn(async () => 30.7);
}

describe("webcam footage audio", () => {
	const track = { path: "/tmp/footage.mp4", offsetMs: 0, gain: 0.8, timeline: "source" as const };

	it("uses footage sound for a silent recording, bounded by the recording's length", async () => {
		const processor = new SilentScreenProcessor();
		processor.setWebcamAudioTrack(track);
		const prepared = await processor.prepare("file:///tmp/screen.mp4", [], [], [], []);

		expect(prepared.mainBufferEntry).toBeNull();
		expect(prepared.companionEntries).toEqual([
			expect.objectContaining({ gain: 0.8, startDelaySec: 0 }),
		]);
		expect(prepared.outputDurationMs).toBeCloseTo(30_700);
	});

	it("keeps embedded screen audio alongside the footage instead of replacing it", async () => {
		const processor = new TestAudioProcessor();
		processor.setWebcamAudioTrack(track);
		const prepared = await processor.prepare("file:///tmp/screen.mp4", [], [], [], []);

		expect(prepared.mainBufferEntry).not.toBeNull();
		expect(prepared.companionEntries).toHaveLength(1);
	});

	it("carries negative offsets so playback can begin partway into the footage", async () => {
		const processor = new SilentScreenProcessor();
		processor.setWebcamAudioTrack({ ...track, offsetMs: -5000 });
		const prepared = await processor.prepare("file:///tmp/screen.mp4", [], [], [], []);

		expect(prepared.companionEntries[0]?.startDelaySec).toBe(-5);
	});

	it("plays added footage from the start of the edit, even when the screen clip is muted", async () => {
		// Mirrors a real project: the first 34.5s of the recording is cut and its sound muted.
		const processor = new SilentScreenProcessor();
		processor.setWebcamAudioTrack({ ...track, timeline: "output", gain: 1 });
		const prepared = await processor.prepare(
			"file:///tmp/screen.mp4",
			[],
			[],
			[],
			[],
			undefined,
			undefined,
			[{ id: "c", startMs: 0, endMs: 20_000, sourceStartMs: 10_000, speed: 1, muted: true }],
		);

		expect(prepared.companionEntries).toHaveLength(0);
		expect(prepared.outputEntries[0]?.region).toMatchObject({ startMs: 0, endMs: 41_800 });

		const { starts, ctx } = context();
		const entry = prepared.outputEntries[0];
		if (!entry) throw new Error("missing footage entry");
		processor.scheduleOverlay(ctx, entry.buffer, entry.region, prepared.slices, 0, 30, true);
		expect(starts[0]?.mock.calls[0]).toEqual([0, 0, 30]);

		// A later chunk keeps reading from the right place in the footage.
		const later = context();
		processor.scheduleOverlay(later.ctx, entry.buffer, entry.region, prepared.slices, 30, 30, true);
		expect(later.starts[0]?.mock.calls[0]?.[1]).toBe(30);
	});

	it("plays only the kept pieces of split footage, from the right place in the file", async () => {
		const processor = new SilentScreenProcessor();
		processor.setWebcamAudioTrack({
			...track,
			timeline: "output",
			clips: [
				{ id: "a", startMs: 0, endMs: 5000, sourceStartMs: 0 },
				{ id: "b", startMs: 5000, endMs: 9000, sourceStartMs: 12_000 },
			],
		});
		const prepared = await processor.prepare("file:///tmp/screen.mp4", [], [], [], []);
		expect(prepared.outputEntries).toHaveLength(2);

		const { starts, ctx } = context();
		const second = prepared.outputEntries[1];
		if (!second) throw new Error("missing clip");
		processor.scheduleOverlay(ctx, second.buffer, second.region, prepared.slices, 0, 30, true);
		expect(starts[0]?.mock.calls[0]).toEqual([5, 12, 4]);
	});

	it("does not fail or add a track when no footage audio is configured", async () => {
		const processor = new TestAudioProcessor();
		const prepared = await processor.prepare("file:///tmp/screen.mp4", [], [], [], []);

		expect(prepared.companionEntries).toHaveLength(0);
	});
});

describe("clip audio timeline", () => {
	it("keeps the silent middle interval and schedules retained source at its timeline position", async () => {
		const processor = new TestAudioProcessor();
		const prepared = await processor.prepare(
			"file:///tmp/source.mp4",
			[],
			[],
			[],
			[],
			undefined,
			undefined,
			clips,
		);
		expect(prepared.outputDurationMs).toBe(4000);
		expect(prepared.slices).toEqual([
			{ sourceStartMs: 0, sourceEndMs: 3000, speed: 3, outputStartMs: 0 },
			{ sourceStartMs: 6000, sourceEndMs: 12000, speed: 3, outputStartMs: 2000 },
		]);
		const { starts, ctx } = context();
		processor.schedule(ctx, buffer, prepared.slices, 0);
		expect(starts.map((start) => start.mock.calls[0][0])).toEqual([0, 2]);
	});
	it("keeps independently placed music at 1x across the video gap", () => {
		const processor = new TestAudioProcessor();
		const { starts, ctx } = context();
		processor.scheduleOverlay(
			ctx,
			buffer,
			{ startMs: 500, endMs: 3500, volume: 1 } as AudioRegion,
			[],
			0,
			4,
			true,
		);
		expect(starts[0]).toHaveBeenCalledWith(0.5, 0, 3);
	});
	it("schedules a clip correctly when its audio straddles an offline chunk boundary", async () => {
		const processor = new TestAudioProcessor();
		const prepared = await processor.prepare(
			"file:///tmp/source.mp4",
			[],
			[],
			[],
			[],
			undefined,
			undefined,
			clips,
		);
		const { starts, ctx } = context();
		processor.schedule(ctx, buffer, prepared.slices, 0, 1, 2.5, 1);
		expect(starts).toHaveLength(1);
		expect(starts[0]).toHaveBeenCalledWith(0);
	});
	it("an explicitly empty clip list schedules no source audio", async () => {
		const processor = new TestAudioProcessor();
		const prepared = await processor.prepare(
			"file:///tmp/source.mp4",
			[],
			[],
			[],
			[],
			undefined,
			undefined,
			[],
		);
		expect(prepared.slices).toEqual([]);
		expect(prepared.outputDurationMs).toBe(12000);
	});
});
