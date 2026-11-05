export const TELEPROMPTER_VOICE_SENSITIVITIES = ["low", "medium", "high"] as const;
export type TeleprompterVoiceSensitivity = (typeof TELEPROMPTER_VOICE_SENSITIVITIES)[number];

export interface TeleprompterSettings {
	enabled: boolean;
	script: string;
	/** 1 (slowest) to 10 (fastest). */
	speed: number;
	fontSize: number;
	mirrored: boolean;
	/** Scroll only while the mic hears speech. */
	voiceActivated: boolean;
	voiceSensitivity: TeleprompterVoiceSensitivity;
}

export const TELEPROMPTER_STORAGE_KEY = "recordly.teleprompter";
export const TELEPROMPTER_SPEED_RANGE = { min: 1, max: 10 } as const;
export const TELEPROMPTER_FONT_SIZE_RANGE = { min: 16, max: 56 } as const;
export const DEFAULT_TELEPROMPTER_SETTINGS: TeleprompterSettings = {
	enabled: false,
	script: "",
	speed: 3,
	fontSize: 28,
	mirrored: false,
	voiceActivated: false,
	voiceSensitivity: "medium",
};

const PIXELS_PER_SECOND_PER_SPEED_STEP = 12;

/** Mic meter level (0-100) that counts as speech. Higher sensitivity means a lower bar. Placeholder values; tune by hand. */
const VOICE_THRESHOLD_BY_SENSITIVITY: Record<TeleprompterVoiceSensitivity, number> = {
	low: 35,
	medium: 25,
	high: 15,
};
/** Keep scrolling this long after the last speech, so pauses between words don't stutter. */
const VOICE_HOLD_MS = 400;

function clampNumber(value: unknown, range: { min: number; max: number }, fallback: number) {
	return typeof value === "number" && Number.isFinite(value)
		? Math.min(Math.max(value, range.min), range.max)
		: fallback;
}

export function parseTeleprompterSettings(stored: string | null): TeleprompterSettings {
	try {
		const parsed = JSON.parse(stored ?? "") as Partial<
			Record<keyof TeleprompterSettings, unknown>
		>;
		const defaults = DEFAULT_TELEPROMPTER_SETTINGS;
		return {
			enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : defaults.enabled,
			script: typeof parsed.script === "string" ? parsed.script : defaults.script,
			speed: clampNumber(parsed.speed, TELEPROMPTER_SPEED_RANGE, defaults.speed),
			fontSize: clampNumber(parsed.fontSize, TELEPROMPTER_FONT_SIZE_RANGE, defaults.fontSize),
			mirrored: typeof parsed.mirrored === "boolean" ? parsed.mirrored : defaults.mirrored,
			voiceActivated:
				typeof parsed.voiceActivated === "boolean"
					? parsed.voiceActivated
					: defaults.voiceActivated,
			voiceSensitivity: TELEPROMPTER_VOICE_SENSITIVITIES.includes(
				parsed.voiceSensitivity as TeleprompterVoiceSensitivity,
			)
				? (parsed.voiceSensitivity as TeleprompterVoiceSensitivity)
				: defaults.voiceSensitivity,
		};
	} catch {
		return DEFAULT_TELEPROMPTER_SETTINGS;
	}
}

/** Scroll distance in pixels for a frame of `elapsedMs` at the given speed. */
export function getTeleprompterScrollDelta(speed: number, elapsedMs: number): number {
	return (speed * PIXELS_PER_SECOND_PER_SPEED_STEP * Math.max(0, elapsedMs)) / 1000;
}

export interface VoiceScrollState {
	speaking: boolean;
	/** Timestamp (ms) of the last frame that met the threshold. */
	lastSpeechAt: number;
}

export const INITIAL_VOICE_SCROLL_STATE: VoiceScrollState = {
	speaking: false,
	lastSpeechAt: Number.NEGATIVE_INFINITY,
};

/** Advance the speech gate by one frame. `levelNow` is the mic meter level (0-100). */
export function nextVoiceScrollState(
	prev: VoiceScrollState,
	levelNow: number,
	nowMs: number,
	sensitivity: TeleprompterVoiceSensitivity,
): VoiceScrollState {
	const heardSpeech = levelNow >= VOICE_THRESHOLD_BY_SENSITIVITY[sensitivity];
	const holding = prev.speaking && nowMs - prev.lastSpeechAt < VOICE_HOLD_MS;
	return {
		speaking: heardSpeech || holding,
		lastSpeechAt: heardSpeech ? nowMs : prev.lastSpeechAt,
	};
}
