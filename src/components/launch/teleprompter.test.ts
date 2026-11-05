import { describe, expect, it } from "vitest";
import {
	DEFAULT_TELEPROMPTER_SETTINGS,
	getTeleprompterScrollDelta,
	INITIAL_VOICE_SCROLL_STATE,
	nextVoiceScrollState,
	parseTeleprompterSettings,
} from "./teleprompter";

describe("teleprompter settings", () => {
	it("falls back to defaults for missing or corrupt storage", () => {
		expect(parseTeleprompterSettings(null)).toEqual(DEFAULT_TELEPROMPTER_SETTINGS);
		expect(parseTeleprompterSettings("{not json")).toEqual(DEFAULT_TELEPROMPTER_SETTINGS);
	});

	it("keeps valid values and clamps out-of-range numbers", () => {
		expect(
			parseTeleprompterSettings(
				JSON.stringify({
					enabled: true,
					script: "Hi",
					speed: 99,
					fontSize: 2,
					mirrored: "x",
				}),
			),
		).toEqual({
			enabled: true,
			script: "Hi",
			speed: 10,
			fontSize: 16,
			mirrored: false,
			voiceActivated: false,
			voiceSensitivity: "medium",
		});
	});

	it("keeps voice settings and rejects unknown sensitivity", () => {
		expect(
			parseTeleprompterSettings(
				JSON.stringify({ voiceActivated: true, voiceSensitivity: "high" }),
			),
		).toMatchObject({ voiceActivated: true, voiceSensitivity: "high" });
		expect(
			parseTeleprompterSettings(JSON.stringify({ voiceSensitivity: "extreme" })),
		).toMatchObject({ voiceSensitivity: "medium" });
	});

	it("scrolls faster at higher speeds and never backwards", () => {
		expect(getTeleprompterScrollDelta(5, 1000)).toBeGreaterThan(
			getTeleprompterScrollDelta(1, 1000),
		);
		expect(getTeleprompterScrollDelta(5, -16)).toBe(0);
	});

	it("gates scrolling on mic level with a hold after speech", () => {
		const quiet = nextVoiceScrollState(INITIAL_VOICE_SCROLL_STATE, 0, 0, "medium");
		expect(quiet.speaking).toBe(false);

		const speech = nextVoiceScrollState(quiet, 60, 100, "medium");
		expect(speech.speaking).toBe(true);

		// Brief silence inside the hold window keeps scrolling.
		expect(nextVoiceScrollState(speech, 0, 400, "medium").speaking).toBe(true);
		// After the hold expires, scrolling stops.
		expect(nextVoiceScrollState(speech, 0, 600, "medium").speaking).toBe(false);
	});

	it("treats higher sensitivity as a lower speech bar", () => {
		const level = 20;
		expect(nextVoiceScrollState(INITIAL_VOICE_SCROLL_STATE, level, 0, "high").speaking).toBe(
			true,
		);
		expect(nextVoiceScrollState(INITIAL_VOICE_SCROLL_STATE, level, 0, "low").speaking).toBe(
			false,
		);
	});
});
