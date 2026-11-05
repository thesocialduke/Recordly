import { useEffect, useRef, useState } from "react";

export interface AudioLevelMeterOptions {
	enabled: boolean;
	deviceId?: string;
	smoothingFactor?: number;
}

export function useAudioLevelMeter(options: AudioLevelMeterOptions) {
	const [level, setLevel] = useState(0);
	const [error, setError] = useState(false);
	const audioContextRef = useRef<AudioContext | null>(null);
	const analyserRef = useRef<AnalyserNode | null>(null);
	const streamRef = useRef<MediaStream | null>(null);
	const animationFrameRef = useRef<number | null>(null);

	useEffect(() => {
		const cleanup = () => {
			if (animationFrameRef.current) {
				cancelAnimationFrame(animationFrameRef.current);
				animationFrameRef.current = null;
			}
			if (streamRef.current) {
				streamRef.current.getTracks().forEach((track) => track.stop());
				streamRef.current = null;
			}
			if (audioContextRef.current) {
				audioContextRef.current.close().catch(() => undefined);
				audioContextRef.current = null;
			}
			analyserRef.current = null;
		};

		if (!options.enabled) {
			cleanup();
			setLevel(0);
			setError(false);
			return cleanup;
		}

		let mounted = true;

		const startMonitoring = async () => {
			setError(false);
			try {
				const constraints: MediaStreamConstraints = {
					audio: options.deviceId ? { deviceId: { exact: options.deviceId } } : true,
					video: false,
				};

				const stream = await navigator.mediaDevices.getUserMedia(constraints);
				if (!mounted) {
					stream.getTracks().forEach((track) => track.stop());
					return;
				}

				streamRef.current = stream;

				const audioContext = new AudioContext();
				if (audioContext.state === "suspended") {
					await audioContext.resume();
				}
				audioContextRef.current = audioContext;

				const analyser = audioContext.createAnalyser();
				analyser.fftSize = 256;
				analyser.smoothingTimeConstant = options.smoothingFactor ?? 0.8;
				analyserRef.current = analyser;

				const source = audioContext.createMediaStreamSource(stream);
				source.connect(analyser);

				const dataArray = new Uint8Array(analyser.frequencyBinCount);

				const updateLevel = () => {
					if (!mounted || !analyserRef.current) return;

					analyser.getByteFrequencyData(dataArray);

					let sum = 0;
					for (let index = 0; index < dataArray.length; index++) {
						sum += dataArray[index] * dataArray[index];
					}

					const rms = Math.sqrt(sum / dataArray.length);
					const normalizedLevel = Math.min(100, (rms / 255) * 100 * 2);
					setLevel(normalizedLevel);
					animationFrameRef.current = requestAnimationFrame(updateLevel);
				};

				updateLevel();
			} catch (meterError) {
				console.error("Error starting audio level monitoring:", meterError);
				if (mounted) {
					setLevel(0);
					setError(true);
				}
			}
		};

		void startMonitoring();

		return () => {
			mounted = false;
			cleanup();
		};
	}, [options.deviceId, options.enabled, options.smoothingFactor]);

	return { level, error };
}
