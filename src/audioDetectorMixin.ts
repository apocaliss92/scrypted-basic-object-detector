import sdk, { AudioVolumeControl, AudioVolumes, FFmpegInput, ScryptedMimeTypes, Setting, Settings, SettingValue, VideoCamera } from "@scrypted/sdk";
import { SettingsMixinDeviceBase, SettingsMixinDeviceOptions } from "@scrypted/sdk/settings-mixin";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import { logLevelSetting } from "../../scrypted-apocaliss-base/src/basePlugin";
import { RtpPacket } from "../../scrypted/external/werift/packages/rtp/src/rtp/rtp";
import { startRtpForwarderProcess } from '../../scrypted/plugins/webrtc/src/rtp-forwarders';
import BasicAudioDetector from "./audioDetector";
import { getDecibelsFromRtp_PCMU8, logMean, stddev } from "./util";

export class BasicAudioDetectorMixin extends SettingsMixinDeviceBase<any> implements Settings, AudioVolumeControl {
    storageSettings = new StorageSettings(this, {
        updateSeconds: {
            title: 'Sample period',
            description: 'Amount of seconds to wait until sampling happens',
            type: 'number',
            defaultValue: 2,
        },
        logLevel: {
            ...logLevelSetting
        }
    });

    logger: Console;
    lastSet: number;
    killed: boolean;
    audioForwarder: ReturnType<typeof startRtpForwarderProcess>;
    lastAudioConnection: number;
    cameraDevice: VideoCamera;
    samples: number[] = [];
    samplingStart: number;

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
                        const { updateSeconds } = this.storageSettings.values;
                        const now = Date.now();
                        const canProcess = this.samplingStart && (now - this.samplingStart) > (updateSeconds * 1000);

                        if (!canProcess) {
                            if (!this.samplingStart) {
                                this.samplingStart = now;
                                this.samples = [];
                            }

                            const packet = RtpPacket.deSerialize(rtp);
                            const { db, rms } = getDecibelsFromRtp_PCMU8(packet.payload);
                            logger.debug(`Detected: ${JSON.stringify({ db, rms })}`);

                            this.samples.push(db);
                        } else {
                            if (!!this.samples.length) {
                                const mean = logMean(this.samples);
                                const deviation = stddev(this.samples);

                                logger.info(`Mean: ${mean.toFixed(1)} dB, Stddev: ${deviation.toFixed(1)}`);
                                this.samples = [];
                                this.samplingStart = now;

                                this.setAudioVolumes({
                                    'dBFS': mean,
                                    'dbStdDev': deviation
                                });
                            }
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
        this.samples = [];
        this.samplingStart = undefined;
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
