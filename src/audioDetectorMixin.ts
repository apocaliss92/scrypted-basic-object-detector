import sdk, { AudioVolumeControl, AudioVolumes, FFmpegInput, MotionSensor, ScryptedMimeTypes, Setting, Settings, SettingValue, VideoCamera } from "@scrypted/sdk";
import { SettingsMixinDeviceBase, SettingsMixinDeviceOptions } from "@scrypted/sdk/settings-mixin";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import BasicAudioDetector from "./audioDetector";
import { RtpPacket } from "../../scrypted/external/werift/packages/rtp/src/rtp/rtp";
import { startRtpForwarderProcess } from '../../scrypted/plugins/webrtc/src/rtp-forwarders';
import { logLevelSetting } from "../../scrypted-apocaliss-base/src/basePlugin";

export class BasicAudioDetectorMixin extends SettingsMixinDeviceBase<any> implements Settings, AudioVolumeControl {
    storageSettings = new StorageSettings(this, {
        updateSeconds: {
            title: 'Minimum update delay',
            description: 'Amount of seconds to wait within updates',
            type: 'number',
            defaultValue: 5,
        },
        logLevel: {
            ...logLevelSetting
        }
    });

    logger: Console;
    lastSet: number;
    killed: boolean;
    audioForwarder: ReturnType<typeof startRtpForwarderProcess>;
    lastAudioDetected: number;
    lastAudioConnection: number;
    cameraDevice: VideoCamera;

    constructor(
        options: SettingsMixinDeviceOptions<any>,
        public plugin: BasicAudioDetector
    ) {
        super(options);

        this.plugin.currentMixinsMap[this.id] = this;

        const logger = this.getLogger();
        this.cameraDevice = sdk.systemManager.getDeviceById<VideoCamera>(this.id);

        setTimeout(async () => {
            if (!this.killed) {
                this.init().catch(logger.error);
            }
        }, 1000 * 5);
    }

    async setAudioVolumes(audioVolumes: AudioVolumes): Promise<void> {
        this.audioVolumes = {
            ...this.audioVolumes,
            ...audioVolumes
        };
    }

    getDecibelsFromRtp_PCMU8(rtpPacket: Buffer) {
        const logger = this.getLogger();
        const RTP_HEADER_SIZE = 12;
        if (rtpPacket.length <= RTP_HEADER_SIZE) return null;

        const payload = rtpPacket.slice(RTP_HEADER_SIZE);
        const sampleCount = payload.length;
        if (sampleCount === 0) return null;

        let sumSquares = 0;
        for (let i = 0; i < payload.length; i++) {
            const sample = payload[i];
            const centered = sample - 128;
            const normalized = centered / 128;
            sumSquares += normalized * normalized;
        }

        const rms = Math.sqrt(sumSquares / sampleCount);
        const db = 20 * Math.log10(rms || 0.00001);

        logger.info(`Audio detections: ${JSON.stringify({ sumSquares, rms, db })}`);

        return db;
    }

    async init() {
        const logger = this.getLogger();
        setInterval(async () => {
            logger.log(`Restarting Audio server`);
            await this.stopAudioServer();
            await this.startAudioServer();
        }, 1000 * 60 * 60);

        logger.log(`Starting Audio server`);
        await this.startAudioServer();
    }

    async startAudioServer() {
        const logger = this.getLogger(true);
        try {
            const loggerForFfmpeg = {
                ...logger,
                warn: logger.debug,
                error: logger.debug,
                log: logger.debug,
            };
            if (this.audioForwarder) {
                this.stopAudioServer();
            }

            const mo = await this.cameraDevice.getVideoStream({
                video: null,
                audio: {},
            });
            const ffmpegInput = await sdk.mediaManager.convertMediaObjectToJSON<FFmpegInput>(mo, ScryptedMimeTypes.FFmpegInput);

            const fp = startRtpForwarderProcess(loggerForFfmpeg, ffmpegInput, {
                video: null,
                audio: {
                    codecCopy: 'pcm_u8',
                    encoderArguments: [
                        '-acodec', 'pcm_u8',
                        '-ac', '1',
                        '-ar', '8000',
                    ],
                    onRtp: rtp => {
                        const now = Date.now();
                        if (this.lastAudioDetected && now - this.lastAudioDetected < 1000)
                            return;
                        this.lastAudioDetected = now;

                        const packet = RtpPacket.deSerialize(rtp);
                        const decibels = this.getDecibelsFromRtp_PCMU8(packet.payload);

                        const { updateSeconds } = this.storageSettings.values;

                        if (!this.lastSet || now - this.lastSet > 1000 * updateSeconds) {
                            this.lastSet = now;
                            this.setAudioVolumes({
                                'dBFS': decibels
                            });
                        }

                    },
                }
            });

            this.audioForwarder = fp;

            fp.catch(() => {
                if (this.audioForwarder === fp)
                    this.audioForwarder = undefined;
            });

            this.audioForwarder.then(f => {
                f.killPromise.then(() => {
                    if (this.audioForwarder === fp)
                        this.audioForwarder = undefined;
                });
            }).catch(e => {
                logger.log(`Error in audio forwarder`, e?.message);
            });
            this.lastAudioConnection = Date.now();
        } catch (e) {
            logger.log('Error in startAudioDetection', e.message);
        }
    }

    async stopAudioServer() {
        this.audioForwarder?.then(f => f.kill());
        this.audioForwarder = undefined;

        this.lastAudioConnection = undefined;
    }

    async getMixinSettings(): Promise<Setting[]> {
        const logger = this.getLogger();
        try {
            return this.storageSettings.getSettings();
        } catch (e) {
            logger.log('Error in getMixinSettings', e);
            return [];
        }
    }

    async putSetting(key: string, value: SettingValue): Promise<void> {
        const [group, ...rest] = key.split(':');
        if (group === this.settingsGroupKey) {
            this.storageSettings.putSetting(rest.join(':'), value);
        } else {
            super.putSetting(key, value);
        }
    }

    async putMixinSetting(key: string, value: string) {
        this.storageSettings.putSetting(key, value);
    }

    async release() {
        const logger = this.getLogger();
        await this.stopAudioServer();
        this.killed = true;
    }

    public getLogger(forceNew?: boolean) {
        if (!this.logger || forceNew) {
            const newLogger = this.plugin.getLogger({
                console: this.console,
                storage: this.storageSettings,
            });

            if (forceNew) {
                return newLogger;
            } else {
                this.logger = newLogger;
            }
        }

        return this.logger;
    }
}
